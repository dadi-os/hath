import { describe, expect, it } from "vitest";
import {
  conversationBucket,
  formatRelative,
  groupConversations,
  truncateOneLine,
} from "./chrome/chatSidebar/format";
import {
  messageKey,
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
  resetChatStore,
  seedConversations,
  threadAgentId,
  upsertConversation,
} from "./store/chat";
import type { ChatMessage } from "./store/chat";
import { monogram } from "./chrome/chatSidebar/thread/ThreadEmpty";
import type { DurableMessage, LogRecord } from "./shared/api/types";
import {
  buildTree,
  isLiveVisual,
  labelPlacement,
  layoutForest3d,
  linkPath,
  projectForest2d,
  statusLabel,
  visualState,
} from "./features/agents/tree";
import { layoutMemoryPlane3d } from "./features/memory/graph";
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

  it("monogram takes up to two initials", () => {
    expect(monogram("research-bot")).toBe("RB");
    expect(monogram("Planner")).toBe("P");
    expect(monogram("  ")).toBe("·");
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

  it("builds a forest of null-parent threads", () => {
    const child: AgentRecord = {
      ...planner,
      id: "child",
      name: "Worker",
      parent_agent_id: "planner",
    };
    const other: AgentRecord = {
      ...planner,
      id: "home",
      name: "Home",
    };
    const forest = buildTree([planner, child, other]);
    expect(forest.map((n) => n.id).sort()).toEqual(["home", "planner"]);
    const plannerNode = forest.find((n) => n.id === "planner");
    expect(plannerNode?.children?.[0]?.id).toBe("child");
  });

  it("treats a dangling parent as its own root", () => {
    const orphan: AgentRecord = {
      ...planner,
      id: "orphan",
      name: "Orphan",
      parent_agent_id: "missing",
    };
    const forest = buildTree([planner, orphan]);
    expect(forest.map((n) => n.id).sort()).toEqual(["orphan", "planner"]);
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

  it("returns an empty forest when there are no agents", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("draws straight links and keeps names off those segments", () => {
    const child: AgentRecord = {
      ...planner,
      id: "child",
      name: "Worker",
      parent_agent_id: "planner",
    };
    const grand: AgentRecord = {
      ...planner,
      id: "grand",
      name: "Scout",
      parent_agent_id: "child",
    };
    const { links } = projectForest2d(
      layoutForest3d(buildTree([planner, child, grand]), 28, 42),
    );
    expect(links).toHaveLength(2);
    for (const link of links) {
      const path = linkPath(link);
      expect(path).toContain("L");
      expect(path).not.toContain("Q");
      for (const node of [link.source, link.target]) {
        const place = labelPlacement(node, links, 20);
        expect(
          distanceToSegment(
            node.x + place.x,
            node.y + place.y,
            link.source,
            link.target,
          ),
        ).toBeGreaterThan(14);
      }
    }
  });

  it("places root plots apart in Z on the canopy ridge", () => {
    const a: AgentRecord = { ...planner, id: "a", name: "A" };
    const b: AgentRecord = { ...planner, id: "b", name: "B" };
    const c: AgentRecord = { ...planner, id: "c", name: "C" };
    const { nodes } = layoutForest3d(buildTree([a, b, c]), 28, 42);
    const roots = nodes.filter((n) => n.depth === 0);
    expect(roots).toHaveLength(3);
    const zs = roots.map((n) => n.z);
    expect(new Set(zs.map((z) => z.toFixed(2))).size).toBeGreaterThan(1);
  });
});

describe("memory plane layout", () => {
  it("spreads hubs on XZ and lifts memories on Y", () => {
    const now = "2026-01-01T00:00:00Z";
    const person = {
      id: "p1",
      kind: "person" as const,
      title: "Ada",
      body: null,
      occurred_at: null,
      expires_at: null,
      access_count: 1,
      last_accessed_at: null,
      source: "manual" as const,
      created_at: now,
      updated_at: now,
      detail: { birthday: null, aliases: [] },
    };
    const place = {
      ...person,
      id: "pl1",
      kind: "place" as const,
      title: "Kitchen",
      detail: { address: null, latitude: null, longitude: null },
    };
    const memory = {
      ...person,
      id: "m1",
      kind: "memory" as const,
      title: "Dinner",
      detail: null,
    };
    const laid = layoutMemoryPlane3d(
      {
        nodes: [person, place, memory],
        edges: [
          {
            id: "e1",
            source: "p1",
            target: "m1",
            type: "ABOUT",
            confidence: 0.9,
          },
        ],
      },
      36,
      10,
    );
    const hubs = laid.filter((n) => n.kind === "person" || n.kind === "place");
    expect(hubs).toHaveLength(2);
    expect(Math.abs(hubs[0].z - hubs[1].z) + Math.abs(hubs[0].x - hubs[1].x)).toBeGreaterThan(
      10,
    );
    const mem = laid.find((n) => n.id === "m1");
    expect(mem).toBeTruthy();
    expect(mem!.y).toBeGreaterThan(hubs[0].y);
  });
});

/** Distance from a point to a finite segment. */
function distanceToSegment(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    return Math.hypot(px - a.x, py - a.y);
  }
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

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
