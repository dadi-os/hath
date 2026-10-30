import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEvents } from "../src/nas/client.js";

const report = {
  type: "helper_report",
  seq: 3,
  task: "task/browser/2",
  kind: "browser",
  id: "2",
  agent_id: "career-manager",
  state: "done",
  text: "Applied.",
  files: ["/var/home/dadi/Downloads/receipt.pdf"],
  at: "2026-10-29T14:00:00.123456789Z",
};

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    yield new TextEncoder().encode(part);
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<{ events: unknown[]; error: unknown }> {
  const events: unknown[] = [];
  try {
    for await (const event of stream) {
      events.push(event);
    }
  } catch (error) {
    return { events, error };
  }
  return { events, error: null };
}

test("the event stream yields reports and changes, whole frames split across chunks, and ignores the rest", async () => {
  const frame = `data: ${JSON.stringify(report)}\n\n`;
  const { events, error } = await collect(
    parseEvents(chunks(frame.slice(0, 20), frame.slice(20), 'data: {"type":"changed","at":"x"}\n\n', ": keepalive\n\n", 'data: {"type":"other"}\n\n')),
  );
  assert.deepEqual(events, [{ type: "helper_report", report }, { type: "changed" }]);
  assert.match(String(error), /Nas event stream ended/, "a stream that ends is an error, so the caller reconnects");
});

test("a report that does not match its schema stops the stream loudly", async () => {
  const { events, error } = await collect(parseEvents(chunks(`data: ${JSON.stringify({ ...report, state: "mystery" })}\n\n`)));
  assert.deepEqual(events, []);
  assert.match(String(error), /Nas response is malformed/);
});
