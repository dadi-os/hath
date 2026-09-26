import { describe, expect, it } from "vitest";
import {
  conversationBucket,
  formatRelative,
  groupConversations,
  truncateOneLine,
} from "./chrome/chatSidebar/format";
import {
  partitionByQueued,
  trackIncoming,
} from "./chrome/chatSidebar/lanes";
import {
  findActiveTool,
  formatToolSignature,
  laneChipLabel,
} from "./chrome/chatSidebar/toolStatus";
import {
  addOptimistic,
  clearLiveChat,
  formatOutboundContent,
  getChatState,
  hydrateThreadMessages,
  ingestLiveMessage,
  isUserThreadMessage,
  messageKey,
  resetChatStore,
  seedConversations,
  threadAgentId,
  upsertConversation,
} from "./store/chat";
import type { ChatMessage } from "./store/chat";
import type { DurableMessage, LogRecord } from "./shared/api/types";
import {
  agentGraph,
  createAgentSimulation,
  isLiveVisual,
  shellRadius,
  statusLabel,
  visualState,
} from "./features/agents/tree";
import { createMemorySimulation, mergeGraph, type GraphData } from "./features/memory/graph";
import { syncForceSimulation } from "./shared/components/ForceGraph";
import { revealSchedule } from "./shared/components/ForceGraph/reveal";
import {
  hasRememberedSessions,
  pickLiveBrowser,
  pickLiveTerminal,
} from "./features/agents/sessions";
import {
  addDays,
  isSameDay,
  startOfWeek,
  toIsoBounds,
} from "./features/timeline/dates";
import { consumeSseBuffer, joinUrl } from "./shared/api/sse";
import { createChaaviClient } from "./shared/api/chaavi";
import { createNasClient } from "./shared/api/nas";
import { YAAD, DIMAAG, NAS, CHAAVI, CHAAVI_VAULT, GHAR } from "./shared/api/constants";
import type { Transport } from "./shared/api/transport";
import type { AgentRecord } from "./shared/api/types";

describe("truncateOneLine", () => {
  it("collapses whitespace and truncates", () => {
    expect(truncateOneLine("  hello   world  ", 20)).toBe("hello world");
    expect(truncateOneLine("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("formatRelative", () => {
  it("formats minutes ago", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const iso = new Date(now - 5 * 60_000).toISOString();
    expect(formatRelative(iso, now)).toMatch(/minute/);
  });
});

describe("formatOutboundContent", () => {
  it("joins text and image placeholders", () => {
    expect(
      formatOutboundContent("hi", [
        { media_type: "image/png", data: "abc", filename: "shot.png" },
      ]),
    ).toBe("hi\n[Image: shot.png]");
  });
});

describe("chatSidebar lanes", () => {
  it("partitions queued vs settled", () => {
    const messages: ChatMessage[] = [
      {
        seq: 1,
        from_user: true,
        content: "a",
        at: "2026-01-01T00:00:00Z",
      },
      {
        seq: -2,
        from_user: true,
        content: "b",
        at: "2026-01-01T00:00:01Z",
        queued: true,
      },
    ];
    const { settled, queued } = partitionByQueued(messages);
    expect(settled.map((m) => m.seq)).toEqual([1]);
    expect(queued.map((m) => m.seq)).toEqual([-2]);
  });

  it("treats only post-open non-historical rows as live", () => {
    const existing: ChatMessage = {
      seq: 1,
      from_user: true,
      content: "hi",
      at: "2026-01-01T00:00:00Z",
    };
    const known = new Set<string>();
    const live = new Set<string>();
    trackIncoming(known, live, [existing], true);
    expect(live.size).toBe(0);

    const incoming: ChatMessage = {
      seq: 2,
      from_user: false,
      content: "hello",
      at: "2026-01-01T00:00:01Z",
    };
    const historical: ChatMessage = {
      seq: 3,
      from_user: false,
      content: "old",
      at: "2026-01-01T00:00:02Z",
      historical: true,
    };
    trackIncoming(known, live, [existing, incoming, historical], false);
    expect(live.has(messageKey(incoming))).toBe(true);
    expect(live.has(messageKey(historical))).toBe(false);
    expect(live.has(messageKey(existing))).toBe(false);
  });
});

describe("toolStatus", () => {
  const baseLog = {
    agent_id: "a1",
    lane: "conversation" as const,
    created_at: "2026-01-01T00:00:00Z",
  };

  it("maps lane occupancy to chip labels", () => {
    expect(laneChipLabel(false, false)).toBeNull();
    expect(laneChipLabel(true, false)).toBe("thinking");
    expect(laneChipLabel(false, true)).toBe("working");
    expect(laneChipLabel(true, true)).toBe("thinking + working");
  });

  it("formats a compact tool signature", () => {
    expect(
      formatToolSignature("browser_navigate", { url: "https://x.test/path" }),
    ).toBe('browser_navigate(url: "https://x.test/path")');
    expect(formatToolSignature("noop", {})).toBe("noop()");
  });

  it("picks the first unfinished tool_use from thoughts", () => {
    const logs: LogRecord[] = [
      {
        ...baseLog,
        id: "r1",
        event: "tool_result",
        payload: { tool_use_id: "t1", content: "ok", is_error: false },
        created_at: "2026-01-01T00:00:02Z",
      },
      {
        ...baseLog,
        id: "c1",
        event: "tool_call",
        payload: { id: "t1", name: "read_file", input: { path: "a.ts" } },
        created_at: "2026-01-01T00:00:02Z",
      },
      {
        ...baseLog,
        id: "th1",
        event: "thought",
        payload: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "read_file",
              input: { path: "a.ts" },
            },
            {
              type: "tool_use",
              id: "t2",
              name: "write_file",
              input: { path: "b.ts" },
            },
          ],
        },
        created_at: "2026-01-01T00:00:01Z",
      },
    ];
    expect(findActiveTool(logs)).toEqual({
      id: "t2",
      name: "write_file",
      input: { path: "b.ts" },
    });
  });

  it("skips yield and returns null when every tool has a result", () => {
    const logs: LogRecord[] = [
      {
        ...baseLog,
        id: "r1",
        event: "tool_result",
        payload: { tool_use_id: "t1", content: "{}", is_error: false },
        created_at: "2026-01-01T00:00:02Z",
      },
      {
        ...baseLog,
        id: "th1",
        event: "thought",
        payload: {
          content: [{ type: "tool_use", id: "t1", name: "yield", input: {} }],
        },
        created_at: "2026-01-01T00:00:01Z",
      },
    ];
    expect(findActiveTool(logs)).toBeNull();
  });
});

describe("conversationBucket", () => {
  const now = new Date(2026, 2, 10, 15, 0, 0).getTime();
  const today = new Date(2026, 2, 10, 10, 0, 0).toISOString();
  const todayEarlier = new Date(2026, 2, 10, 8, 0, 0).toISOString();
  const yesterday = new Date(2026, 2, 9, 20, 0, 0).toISOString();
  const previous = new Date(2026, 2, 1, 0, 0, 0).toISOString();

  it("groups today, yesterday, and previous", () => {
    expect(conversationBucket(today, now)).toBe("Today");
    expect(conversationBucket(yesterday, now)).toBe("Yesterday");
    expect(conversationBucket(previous, now)).toBe("Previous");
  });

  it("preserves newest-first order inside groups", () => {
    const grouped = groupConversations(
      [
        { last_at: today, id: "a" },
        { last_at: todayEarlier, id: "b" },
        { last_at: previous, id: "c" },
      ],
      now,
    );
    expect(grouped.map((g) => g.bucket)).toEqual(["Today", "Previous"]);
    expect(grouped[0]!.items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

function durableMessage(partial: {
  id?: string;
  seq: number;
  from: string | null;
  to: string | null;
  content: string;
  at: string;
}): DurableMessage {
  return {
    id: partial.id ?? `msg-${partial.seq}`,
    seq: partial.seq,
    from_agent_id: partial.from,
    to_agent_id: partial.to,
    content: partial.content,
    created_at: partial.at,
  };
}

describe("user-thread history", () => {
  it("keys a user message on the recipient and an agent reply on the sender", () => {
    expect(isUserThreadMessage(null, "agent")).toBe(true);
    expect(isUserThreadMessage("agent", null)).toBe(true);
    expect(isUserThreadMessage("a", "b")).toBe(false);
    expect(threadAgentId(null, "agent")).toBe("agent");
    expect(threadAgentId("agent", null)).toBe("agent");
    expect(threadAgentId("a", "b")).toBeNull();
  });

  it("seeds conversations from GET /threads summaries", () => {
    resetChatStore();
    seedConversations([
      {
        agent_id: "planner",
        agent_name: "Planner",
        last_message: "on it",
        last_at: "2026-03-10T11:00:03Z",
        from_user: false,
      },
    ]);
    const snap = getChatState();
    expect(snap.conversations.map((c) => c.agent_id)).toEqual(["planner"]);
    expect(snap.conversations[0]!.last_message).toBe("on it");
    resetChatStore();
  });

  it("hydrates durable messages onto an agent thread", () => {
    resetChatStore();
    hydrateThreadMessages("planner", [
      durableMessage({
        from: null,
        to: "planner",
        content: "plan the week",
        seq: 2,
        at: "2026-03-10T11:00:02Z",
      }),
      durableMessage({
        from: "planner",
        to: null,
        content: "on it",
        seq: 3,
        at: "2026-03-10T11:00:03Z",
      }),
    ]);
    const snap = getChatState();
    expect(snap.threads.planner?.map((m) => m.content)).toEqual([
      "plan the week",
      "on it",
    ]);
    expect(snap.threads.planner?.every((m) => m.historical === true)).toBe(true);
    resetChatStore();
  });

  it("refresh keeps on-screen row keys and animates only missed rows", () => {
    resetChatStore();
    ingestLiveMessage("planner", {
      seq: 3,
      from_user: false,
      content: "on it",
      at: "2026-03-10T11:00:03Z",
    });
    const liveKey = messageKey(getChatState().threads.planner![0]!);
    hydrateThreadMessages(
      "planner",
      [
        durableMessage({ from: "planner", to: null, content: "on it", seq: 3, at: "2026-03-10T11:00:03Z" }),
        durableMessage({ from: "planner", to: null, content: "done", seq: 4, at: "2026-03-10T11:00:04Z" }),
      ],
      { live: true },
    );
    const thread = getChatState().threads.planner!;
    expect(thread.map((m) => m.content)).toEqual(["on it", "done"]);
    expect(messageKey(thread[0]!)).toBe(liveKey);
    expect(thread[1]!.historical).toBeUndefined();
    resetChatStore();
  });

  it("refresh adopts an in-flight send instead of duplicating it", () => {
    resetChatStore();
    addOptimistic("planner", "ship it");
    const pendingKey = messageKey(getChatState().threads.planner![0]!);
    hydrateThreadMessages(
      "planner",
      [durableMessage({ from: null, to: "planner", content: "ship it", seq: 7, at: "2026-03-10T11:00:07Z" })],
      { live: true },
    );
    const thread = getChatState().threads.planner!;
    expect(thread).toHaveLength(1);
    expect(thread[0]!.seq).toBe(7);
    expect(messageKey(thread[0]!)).toBe(pendingKey);
    resetChatStore();
  });

  it("clearLiveChat drops optimistic rows but keeps durable history", () => {
    resetChatStore();
    hydrateThreadMessages("planner", [
      durableMessage({
        from: null,
        to: "planner",
        content: "kept",
        seq: 1,
        at: "2026-03-10T11:00:00Z",
      }),
    ]);
    upsertConversation({
      agent_id: "planner",
      agent_name: "Planner",
      last_message: "kept",
      last_at: "2026-03-10T11:00:00Z",
      from_user: true,
    });
    addOptimistic("planner", "pending send");
    expect(getChatState().threads.planner?.some((m) => m.pending)).toBe(true);
    clearLiveChat();
    expect(getChatState().threads.planner?.map((m) => m.content)).toEqual(["kept"]);
    expect(getChatState().conversations).toHaveLength(1);
    resetChatStore();
  });

  it("merges durable hydrate with a live seq already present", () => {
    resetChatStore();
    ingestLiveMessage("planner", {
      seq: 2,
      from_user: true,
      content: "live first",
      at: "2026-03-10T15:00:00Z",
    });
    hydrateThreadMessages("planner", [
      durableMessage({
        from: null,
        to: "planner",
        content: "live first",
        seq: 2,
        at: "2026-03-10T15:00:00Z",
      }),
      durableMessage({
        from: "planner",
        to: null,
        content: "older durable",
        seq: 1,
        at: "2026-03-10T14:00:00Z",
      }),
    ]);
    const contents = getChatState().threads.planner?.map((m) => m.content);
    expect(contents).toEqual(["older durable", "live first"]);
    resetChatStore();
  });

  it("keeps a resolved agent name when a later upsert only has the id", () => {
    resetChatStore();
    upsertConversation({
      agent_id: "planner",
      agent_name: "Planner",
      last_message: "hi",
      last_at: "2026-03-10T11:00:00Z",
      from_user: true,
    });
    upsertConversation({
      agent_id: "planner",
      agent_name: "planner",
      last_message: "later",
      last_at: "2026-03-10T12:00:00Z",
      from_user: false,
    });
    expect(getChatState().conversations[0]!.agent_name).toBe("Planner");
    expect(getChatState().conversations[0]!.last_message).toBe("later");
    resetChatStore();
  });
});

describe("agent tree", () => {
  const planner: AgentRecord = {
    id: "planner",
    name: "Planner",
    system_prompt: "sys",
    parent_agent_id: null,
    active: true,
    running: { reasoning: false, conversation: false },
    sessions: { browsers: [], terminals: [] },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("roots null and dangling parents and links children to parents", () => {
    const child: AgentRecord = { ...planner, id: "child", parent_agent_id: "planner" };
    const grand: AgentRecord = { ...planner, id: "grand", parent_agent_id: "child" };
    const orphan: AgentRecord = { ...planner, id: "orphan", parent_agent_id: "missing" };
    const { nodes, edges } = agentGraph([grand, planner, child, orphan]);
    const depth = Object.fromEntries(nodes.map((n) => [n.id, n.depth]));
    expect(depth).toEqual({ planner: 0, child: 1, grand: 2, orphan: 0 });
    expect(edges.map((e) => [e.source, e.target])).toEqual([
      ["child", "grand"],
      ["planner", "child"],
    ]);
    expect(agentGraph([])).toEqual({ nodes: [], edges: [] });
  });

  it("rejects a parent cycle instead of drawing it", () => {
    const a: AgentRecord = { ...planner, id: "a", parent_agent_id: "b" };
    const b: AgentRecord = { ...planner, id: "b", parent_agent_id: "a" };
    expect(() => agentGraph([a, b])).toThrow(/cycle/);
  });

  it("marks running lanes by fill key", () => {
    expect(visualState(planner, { reasoning: true, conversation: false })).toBe(
      "reasoning",
    );
    expect(visualState(planner, { reasoning: false, conversation: true })).toBe(
      "conversation",
    );
    expect(visualState(planner, { reasoning: true, conversation: true })).toBe(
      "both",
    );
    expect(visualState({ ...planner, active: false }, undefined)).toBe("dormant");
  });

  it("labels live fills and treats them as in-flight", () => {
    expect(isLiveVisual("reasoning")).toBe(true);
    expect(isLiveVisual("conversation")).toBe(true);
    expect(isLiveVisual("both")).toBe(true);
    expect(isLiveVisual("idle")).toBe(false);
    expect(isLiveVisual("dormant")).toBe(false);
    expect(
      statusLabel("reasoning", { reasoning: true, conversation: false }),
    ).toMatch(/working/);
    expect(
      statusLabel("both", { reasoning: true, conversation: true }),
    ).toMatch(/thinking \+ working/);
    expect(
      statusLabel("idle", { reasoning: false, conversation: false }),
    ).toBe("Idle");
  });

  /** Nine top-level threads; one manager with six workers, like the live forest. */
  const forest = (): AgentRecord[] => {
    const roots = Array.from({ length: 9 }, (_, i) => ({ ...planner, id: `r${i}` }));
    const workers = Array.from({ length: 6 }, (_, i) => ({
      ...planner,
      id: `w${i}`,
      parent_agent_id: "r0",
    }));
    return [...roots, ...workers];
  };

  const settle = (sim: ReturnType<typeof createAgentSimulation>) => {
    for (let i = 0; i < 400; i++) {
      sim.tick();
    }
  };

  it("spreads roots over a sphere and puts workers on an outer shell", () => {
    const sim = createAgentSimulation();
    const { nodes: records, edges } = agentGraph(forest());
    const { nodes } = syncForceSimulation(sim, records, edges);
    settle(sim);
    const dist = (n: { x: number; y: number; z: number }) => Math.hypot(n.x, n.y, n.z);
    const roots = nodes.filter((n) => n.depth === 0);
    const workers = nodes.filter((n) => n.depth === 1);
    for (const r of roots) {
      expect(dist(r)).toBeGreaterThan(shellRadius(0) * 0.6);
      expect(dist(r)).toBeLessThan(shellRadius(1));
    }
    const meanRoot = roots.reduce((a, r) => a + dist(r), 0) / roots.length;
    for (const w of workers) {
      expect(dist(w)).toBeGreaterThan(meanRoot);
    }
    for (const axis of ["x", "y", "z"] as const) {
      const values = roots.map((r) => r[axis]);
      expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(shellRadius(0) * 0.5);
    }
    const manager = nodes.find((n) => n.id === "r0")!;
    const nearest = (w: (typeof nodes)[number]) =>
      roots.reduce((best, r) =>
        Math.hypot(w.x - r.x, w.y - r.y, w.z - r.z) <
        Math.hypot(w.x - best.x, w.y - best.y, w.z - best.z)
          ? r
          : best,
      );
    const underManager = workers.filter((w) => nearest(w) === manager).length;
    expect(underManager).toBeGreaterThanOrEqual(4);
  });

  it("grows a newly spawned worker out of its parent", () => {
    const sim = createAgentSimulation();
    const agents = forest();
    const first = agentGraph(agents);
    syncForceSimulation(sim, first.nodes, first.edges);
    settle(sim);
    const grown = agentGraph([...agents, { ...planner, id: "fresh", parent_agent_id: "r3" }]);
    const { nodes } = syncForceSimulation(sim, grown.nodes, grown.edges);
    const parent = nodes.find((n) => n.id === "r3")!;
    const fresh = nodes.find((n) => n.id === "fresh")!;
    expect(Math.hypot(fresh.x - parent.x, fresh.y - parent.y, fresh.z - parent.z)).toBeLessThan(7);
  });
});

describe("graph reveal schedule", () => {
  const node = (id: string, degree: number) => ({ id, degree });
  const link = (a: string, b: string) => ({ source: { id: a }, target: { id: b } });
  const nodes = [
    node("hub", 3),
    node("seed", 1),
    node("a", 2),
    node("b", 1),
    node("c", 2),
    node("leaf", 1),
    node("island", 0),
  ];
  const links = [
    link("hub", "a"),
    link("hub", "b"),
    link("hub", "c"),
    link("seed", "c"),
    link("a", "leaf"),
  ];

  it("opens with the seeds in place, most-connected first", () => {
    const schedule = revealSchedule(nodes, links, new Set(["seed", "hub"]));
    const order = [...schedule.keys()];
    expect(order.slice(0, 2)).toEqual(["hub", "seed"]);
    expect(schedule.get("hub")).toEqual({ delay: 0, anchor: null });
    expect(schedule.get("seed")!.anchor).toBeNull();
  });

  it("sprouts every other node from an earlier neighbor, after it", () => {
    const schedule = revealSchedule(nodes, links, new Set(["seed", "hub"]));
    const order = [...schedule.keys()];
    const adjacent = (x: string, y: string) =>
      links.some(
        (l) => (l.source.id === x && l.target.id === y) || (l.source.id === y && l.target.id === x),
      );
    for (const [id, step] of schedule) {
      if (step.anchor === null) {
        continue;
      }
      expect(adjacent(id, step.anchor)).toBe(true);
      expect(order.indexOf(step.anchor)).toBeLessThan(order.indexOf(id));
      expect(step.delay).toBeGreaterThan(schedule.get(step.anchor)!.delay);
    }
    expect(schedule.get("leaf")!.anchor).toBe("a");
  });

  it("still reveals disconnected nodes, in place, and keeps the bloom short", () => {
    const schedule = revealSchedule(nodes, links, new Set(["seed", "hub"]));
    expect(schedule.size).toBe(nodes.length);
    expect(schedule.get("island")!.anchor).toBeNull();
    expect(Math.max(...[...schedule.values()].map((s) => s.delay))).toBeLessThan(2);
  });
});

describe("memory network simulation", () => {
  const now = "2026-01-01T00:00:00Z";
  const record = (id: string, kind: "person" | "memory" | "place" | "plan") => ({
    id,
    kind,
    title: id,
    body: null,
    occurred_at: null,
    expires_at: null,
    access_count: 0,
    last_accessed_at: null,
    source: "manual" as const,
    created_at: now,
    updated_at: now,
  });
  const edge = (id: string, source: string, target: string) => ({
    id,
    source,
    target,
    type: "about",
    confidence: 1,
  });

  /** Five people, each with six memories, some memories shared between people. */
  const community = (): GraphData => {
    const nodes = [];
    const edges = [];
    for (let p = 0; p < 5; p++) {
      nodes.push(record(`p${p}`, "person"));
      for (let m = 0; m < 6; m++) {
        nodes.push(record(`m${p}-${m}`, "memory"));
        edges.push(edge(`e${p}-${m}`, `p${p}`, `m${p}-${m}`));
      }
      edges.push(edge(`share${p}`, `p${p}`, `m${(p + 1) % 5}-0`));
    }
    return { nodes, edges };
  };

  const settle = (sim: ReturnType<typeof createMemorySimulation>) => {
    for (let i = 0; i < 300; i++) {
      sim.tick();
    }
  };

  it("spreads the network through all three axes, not a plane", () => {
    const sim = createMemorySimulation();
    const { nodes } = syncForceSimulation(sim, community().nodes, community().edges);
    settle(sim);
    const spread = (axis: "x" | "y" | "z") => {
      const values = nodes.map((n) => n[axis]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
    };
    const spreads = [spread("x"), spread("y"), spread("z")];
    for (const s of spreads) {
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThan(Math.max(...spreads) * 0.4);
    }
  });

  it("grows new nodes out of the node they attach to without moving the rest", () => {
    const sim = createMemorySimulation();
    const data = community();
    const { nodes: before } = syncForceSimulation(sim, data.nodes, data.edges);
    settle(sim);
    const snapshot = new Map(before.map((n) => [n.id, [n.x, n.y, n.z]]));
    const anchor = before.find((n) => n.id === "p2")!;

    const grown = mergeGraph(data, {
      nodes: [record("fresh", "memory")],
      edges: [
        {
          id: "e-fresh",
          src_id: "p2",
          dst_id: "fresh",
          type: "about",
          properties: {},
          confidence: 1,
          created_at: now,
          valid_from: now,
          valid_to: null,
        },
      ],
    });
    const { nodes: after } = syncForceSimulation(sim, grown.nodes, grown.edges);

    const fresh = after.find((n) => n.id === "fresh")!;
    expect(Math.hypot(fresh.x - anchor.x, fresh.y - anchor.y, fresh.z - anchor.z)).toBeLessThan(
      7,
    );
    for (const n of after) {
      if (n.id !== "fresh") {
        expect([n.x, n.y, n.z]).toEqual(snapshot.get(n.id));
      }
    }
    expect(sim.alpha()).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps node identity across polls and drops edges to pruned nodes", () => {
    const sim = createMemorySimulation();
    const data = community();
    const { nodes: first } = syncForceSimulation(sim, data.nodes, data.edges);
    settle(sim);
    const alphaSettled = sim.alpha();

    const { nodes: again } = syncForceSimulation(sim, data.nodes, data.edges);
    expect(again.find((n) => n.id === "p0")).toBe(first.find((n) => n.id === "p0"));
    expect(sim.alpha()).toBe(alphaSettled);

    const pruned = mergeGraph(
      { nodes: data.nodes.filter((n) => n.id !== "m0-1"), edges: data.edges },
      { nodes: [], edges: [] },
    );
    expect(pruned.edges.some((e) => e.target === "m0-1")).toBe(false);
  });
});

describe("agent host sessions", () => {
  it("picks the newest live browser and terminal", () => {
    expect(pickLiveBrowser([10, 12, 11], [{ id: 10 }, { id: 11 }])).toBe(11);
    expect(pickLiveBrowser([10], [{ id: 12 }])).toBeNull();
    expect(
      pickLiveTerminal(
        [
          { id: "t1", last_command: "ls" },
          { id: "t2", last_command: "pwd" },
        ],
        [{ id: "t2" }],
      ),
    ).toEqual({ id: "t2", last_command: "pwd" });
    expect(
      hasRememberedSessions({ browsers: [], terminals: [] }),
    ).toBe(false);
    expect(
      hasRememberedSessions({
        browsers: [10],
        terminals: [],
      }),
    ).toBe(true);
  });
});

describe("timeline dates", () => {
  it("weeks start Monday", () => {
    const wednesday = new Date(2026, 0, 7);
    const monday = startOfWeek(wednesday);
    expect(monday.getDay()).toBe(1);
    expect(isSameDay(addDays(monday, 2), wednesday)).toBe(true);
  });

  it("iso bounds are UTC strings", () => {
    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 2);
    const bounds = toIsoBounds(from, to);
    expect(bounds.occurred_from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(bounds.occurred_to).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("sse helpers", () => {
  it("parses data events and keeps remainder", () => {
    const events: unknown[] = [];
    const rest = consumeSseBuffer(
      'data: {"type":"message"}\n\ndata: {"type":"x"',
      (data: unknown) => events.push(data),
    );
    expect(events).toEqual([{ type: "message" }]);
    expect(rest).toBe('data: {"type":"x"');
  });

  it("skips malformed JSON without breaking the stream", () => {
    const events: unknown[] = [];
    const rest = consumeSseBuffer(
      'data: not-json\n\ndata: {"ok":true}\n\n',
      (data: unknown) => events.push(data),
    );
    expect(events).toEqual([{ ok: true }]);
    expect(rest).toBe("");
  });

  it("joins urls", () => {
    expect(joinUrl("http://dimaag.dadi/", "/events")).toBe(
      "http://dimaag.dadi/events",
    );
  });
});

describe("mesh constants", () => {
  it("are fixed .dadi names without env fallbacks", () => {
    expect(YAAD).toBe("http://yaad.dadi");
    expect(DIMAAG).toBe("http://dimaag.dadi");
    expect(NAS).toBe("http://nas.dadi");
    expect(CHAAVI).toBe("http://chaavi.dadi");
    expect(CHAAVI_VAULT).toBe("https://chaavi.dadi");
    expect(GHAR).toBe("http://ghar.dadi");
  });
});

describe("nas log services", () => {
  it("calls GET /logs/services", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const transport = {
      request: async (opts: { path: string; method: string }) => {
        calls.push({ path: opts.path, method: opts.method });
        return { services: ["chaavi", "nas"] };
      },
    } as unknown as Transport;
    const client = createNasClient(transport, NAS);
    const got = await client.listLogServices();
    expect(got.services).toEqual(["chaavi", "nas"]);
    expect(calls).toEqual([{ path: "/logs/services", method: "GET" }]);
  });
});

describe("chaavi client", () => {
  it("calls health, catalog, CRUD, and reveal routes", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const transport = {
      request: async (opts: {
        path: string;
        method: string;
        body?: unknown;
      }) => {
        calls.push({
          path: opts.path,
          method: opts.method,
          body: opts.body,
        });
        if (opts.path === "/health") {
          return { status: "ok", vault: "ready" };
        }
        if (opts.path.endsWith("/login")) {
          return { username: "ada", password: "secret" };
        }
        if (opts.method === "DELETE") {
          return undefined;
        }
        return {
          id: "11111111-1111-1111-1111-111111111111",
          name: "GitHub",
          kind: "login",
          username: "octocat",
          uris: ["https://github.com"],
          hasPasskey: false,
        };
      },
    } as unknown as Transport;
    const client = createChaaviClient(transport, CHAAVI);
    await client.getHealth();
    await client.listItems({ q: "bank", uri: "https://ex.test", kind: "login" });
    await client.listItems();
    await client.getItem("11111111-1111-1111-1111-111111111111");
    await client.createLogin({
      name: "X",
      username: "u",
      password: "p",
    });
    await client.updateLogin("11111111-1111-1111-1111-111111111111", {
      name: "Y",
    });
    await client.revealLogin("11111111-1111-1111-1111-111111111111");
    await client.deleteItem("11111111-1111-1111-1111-111111111111");
    expect(calls).toEqual([
      { path: "/health", method: "GET", body: undefined },
      {
        path: "/v1/items?q=bank&uri=https%3A%2F%2Fex.test&kind=login",
        method: "GET",
        body: undefined,
      },
      { path: "/v1/items", method: "GET", body: undefined },
      {
        path: "/v1/items/11111111-1111-1111-1111-111111111111",
        method: "GET",
        body: undefined,
      },
      {
        path: "/v1/logins",
        method: "POST",
        body: { name: "X", username: "u", password: "p" },
      },
      {
        path: "/v1/items/11111111-1111-1111-1111-111111111111",
        method: "PATCH",
        body: { name: "Y" },
      },
      {
        path: "/v1/items/11111111-1111-1111-1111-111111111111/login",
        method: "POST",
        body: undefined,
      },
      {
        path: "/v1/items/11111111-1111-1111-1111-111111111111",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });
});

describe("ghar client", () => {
  it("lists devices and posts switch toggles", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const transport = {
      request: async (opts: {
        path: string;
        method: string;
        body?: unknown;
      }) => {
        calls.push({
          path: opts.path,
          method: opts.method,
          body: opts.body,
        });
        if (opts.path === "/devices") {
          return { devices: [] };
        }
        return undefined;
      },
    } as unknown as Transport;
    const { createGharClient } = await import("./shared/api/ghar");
    const client = createGharClient(transport, GHAR);
    await client.listDevices();
    await client.toggleSwitch("dev-1");
    expect(calls).toEqual([
      { path: "/devices", method: "GET", body: undefined },
      {
        path: "/devices/dev-1/command",
        method: "POST",
        body: {
          capability: "switchable",
          params: { state: "toggle" },
          cause: "user",
        },
      },
    ]);
  });

  it("lists rooms, moves a device, and starts commissioning", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const transport = {
      request: async (opts: {
        path: string;
        method: string;
        body?: unknown;
      }) => {
        calls.push({
          path: opts.path,
          method: opts.method,
          body: opts.body,
        });
        if (opts.path === "/rooms" && opts.method === "GET") {
          return { rooms: [] };
        }
        if (opts.path === "/rooms") {
          return { id: "room-1", name: "kitchen" };
        }
        if (opts.path === "/commission") {
          return { job_id: "job-1" };
        }
        if (opts.path.startsWith("/commission/")) {
          return {
            id: "job-1",
            status: "pending",
            node_id: null,
            device_ids: null,
            error: null,
            started_at: "2026-01-01T00:00:00.000Z",
            finished_at: null,
          };
        }
        return { id: "dev-1" };
      },
    } as unknown as Transport;
    const { createGharClient } = await import("./shared/api/ghar");
    const client = createGharClient(transport, GHAR);
    await client.listRooms();
    await client.createRoom("kitchen");
    await client.moveDevice("dev-1", "room-1");
    await client.renameDevice("dev-1", "Desk lamp");
    await client.startCommission({
      code: "34970112332",
      room_id: "room-1",
      radio: "network",
    });
    await client.getCommission("job-1");
    await client.setBrightness("dev-1", 40);
    await client.setHue("dev-1", 20, 200);
    await client.setColorTemp("dev-1", 250);
    await client.identify("dev-1");
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["GET", "/rooms", undefined],
      ["POST", "/rooms", { name: "kitchen" }],
      ["PATCH", "/devices/dev-1", { room: "room-1" }],
      ["PATCH", "/devices/dev-1", { name: "Desk lamp" }],
      [
        "POST",
        "/commission",
        { code: "34970112332", room_id: "room-1", radio: "network" },
      ],
      ["GET", "/commission/job-1", undefined],
      [
        "POST",
        "/devices/dev-1/command",
        { capability: "dimmable", params: { level: 40 }, cause: "user" },
      ],
      [
        "POST",
        "/devices/dev-1/command",
        {
          capability: "colorable",
          params: { hue: 20, saturation: 200 },
          cause: "user",
        },
      ],
      [
        "POST",
        "/devices/dev-1/command",
        {
          capability: "colorable",
          params: { color_temp: 250 },
          cause: "user",
        },
      ],
      ["POST", "/devices/dev-1/identify", undefined],
    ]);
  });
});

describe("runtime outside Tauri", () => {
  it("selects browser transport", async () => {
    const { isTauriRuntime, selectTransportKind } = await import(
      "./shared/api/runtime"
    );
    expect(isTauriRuntime()).toBe(false);
    expect(selectTransportKind()).toBe("browser");
  });

  it("detectTarget returns desktop", async () => {
    const { detectTarget } = await import("./target");
    expect(detectTarget()).toBe("desktop");
  });

  it("detectDesktopOs is null outside Tauri", async () => {
    const { detectDesktopOs } = await import("./target");
    expect(detectDesktopOs()).toBeNull();
  });
});

describe("transport selection", () => {
  it("initApi wires BrowserTransport outside Tauri", async () => {
    const api = await import("./shared/api");
    await api.initApi();
    expect(api.usingTsnet).toBe(false);
    expect(api.selectTransportKind()).toBe("browser");
    expect(api.transport.connectionState()).toBe("disconnected");
    expect(typeof api.chaavi.getHealth).toBe("function");
    expect(typeof api.ghar.listDevices).toBe("function");
  });

  it("selects tsnet when Tauri globals are present", async () => {
    const g = globalThis as typeof globalThis & { isTauri?: boolean };
    g.isTauri = true;
    try {
      const { selectTransportKind, isTauriRuntime } = await import(
        "./shared/api/runtime"
      );
      expect(isTauriRuntime()).toBe(true);
      expect(selectTransportKind()).toBe("tsnet");
    } finally {
      delete g.isTauri;
    }
  });
});

describe("countNoun", () => {
  it("uses singular only when count is 1", async () => {
    const { countNoun } = await import("./shared/lib/ux/plural");
    expect(countNoun(1, "PASSWORD")).toBe("PASSWORD");
    expect(countNoun(0, "PASSWORD")).toBe("PASSWORDS");
    expect(countNoun(2, "PASSWORD")).toBe("PASSWORDS");
    expect(countNoun(1, "MEMORY", "MEMORIES")).toBe("MEMORY");
    expect(countNoun(3, "MEMORY", "MEMORIES")).toBe("MEMORIES");
    expect(countNoun(1, "PERSON", "PEOPLE")).toBe("PERSON");
    expect(countNoun(0, "PERSON", "PEOPLE")).toBe("PEOPLE");
  });
});
