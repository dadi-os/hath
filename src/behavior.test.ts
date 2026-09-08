import { describe, expect, it } from "vitest";
import { formatRelative, truncateOneLine } from "./chrome/chatSidebar/format";
import { formatOutboundContent } from "./store/chat";
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
