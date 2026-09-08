import { describe, expect, it } from "vitest";
import { formatRelative, truncateOneLine } from "./chrome/chatSidebar/format";
import {
  pendingToChatMessages,
  partitionByQueued,
} from "./chrome/chatSidebar/lanes";
import { formatOutboundContent } from "./store/chat";
import type { ChatMessage } from "./store/chat";
import { buildTree, visualState } from "./features/agents/tree";
import {
  addDays,
  isSameDay,
  startOfWeek,
  toIsoBounds,
} from "./features/timeline/dates";
import { consumeSseBuffer, joinUrl } from "./shared/api/sse";
import { YAAD, DIMAAG, NAS } from "./shared/api/constants";
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
  it("maps pending rows to chat messages", () => {
    const mapped = pendingToChatMessages([
      {
        seq: -1,
        content: "hello",
        at: "2026-01-01T00:00:00Z",
        pending: true,
        queued: true,
      },
    ]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.from_user).toBe(true);
    expect(mapped[0]!.queued).toBe(true);
  });

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
});

describe("agent tree", () => {
  const root: AgentRecord = {
    id: "root",
    name: "Dadi",
    system_prompt: "sys",
    parent_agent_id: null,
    active: true,
    running: { reasoning: false, conversation: false },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("builds hierarchy from parent_agent_id", () => {
    const child: AgentRecord = {
      ...root,
      id: "child",
      name: "Worker",
      parent_agent_id: "root",
    };
    const tree = buildTree([root, child]);
    expect(tree.id).toBe("root");
    expect(tree.children?.[0]?.id).toBe("child");
  });

  it("marks running lanes", () => {
    expect(visualState(root, { reasoning: true, conversation: false })).toBe(
      "running",
    );
    expect(visualState({ ...root, active: false }, undefined)).toBe("dormant");
  });

  it("fails loudly when agents list is empty", () => {
    expect(() => buildTree([])).toThrow(/no agents/);
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
});

describe("transport selection", () => {
  it("initApi wires BrowserTransport outside Tauri", async () => {
    const api = await import("./shared/api");
    await api.initApi();
    expect(api.usingTsnet).toBe(false);
    expect(api.selectTransportKind()).toBe("browser");
    expect(api.transport.connectionState()).toBe("disconnected");
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
