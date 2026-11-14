import assert from "node:assert/strict";
import { test } from "node:test";
import { arrivalsSince } from "../src/runtime/context.js";
import { renderStatus, shortArg, STATUS_LABEL } from "../src/runtime/status.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { Wake } from "../src/runtime/wake.js";
import type { AgentStatus } from "../src/types/domain.js";
import { roomyWakeLimits } from "./helpers.js";

const status: AgentStatus = {
  job: { from: null, at: "2026-10-29T10:00:00-04:00", content: "find my exam times" },
  work: { state: "running", since: "2026-10-29T10:05:00-04:00", waiting_on: [] },
  step: "web_fetch https://registrar.example/exams",
  recent: [
    { name: "recall_memory", arg: "exam times", ok: true },
    { name: "web_fetch", arg: "https://registrar.example/exams", ok: null },
  ],
  tasks: [{ id: "task/browser/3", status: "working", current: "on the registrar page" }],
  tasks_unreadable: null,
  ledger: null,
};

test("the status block names the job, the work lane, its step and recent calls, tasks and ledger", () => {
  const text = renderStatus(status);
  assert.ok(text.startsWith(STATUS_LABEL));
  assert.match(text, /Current job: from Ankur at 2026-10-29T10:00:00-04:00: find my exam times/);
  assert.match(text, /Work lane: running \(last step 2026-10-29T10:05:00-04:00\)/);
  assert.match(text, /Current step: web_fetch https:\/\/registrar\.example\/exams/);
  assert.match(text, /- recall_memory exam times · ok/);
  assert.match(text, /- web_fetch https:\/\/registrar\.example\/exams · running/);
  assert.match(text, /- task\/browser\/3 · working · on the registrar page/);
});

test("the status block says plainly when nothing is running, waiting, in flight or unreadable", () => {
  const idle = renderStatus({
    ...status,
    job: null,
    work: { state: "waiting", since: "2026-10-29T10:07:00-04:00", waiting_on: ["task/browser/3"] },
    step: null,
    recent: [],
    tasks: [],
    tasks_unreadable: null,
  });
  assert.match(idle, /Current job: none open/);
  assert.match(idle, /Work lane: waiting on task\/browser\/3 since 2026-10-29T10:07:00-04:00/);
  assert.match(idle, /Current step: none/);
  assert.match(idle, /Helper tasks in flight: none/);
  assert.match(renderStatus({ ...status, tasks_unreadable: "nas down" }), /Helper tasks: could not be read \(nas down\)/);
});

test("a short argument is the path, URL, query or command of a call, clipped", () => {
  assert.equal(shortArg({ path: "/a/b.md", offset: 3 }), "/a/b.md");
  assert.equal(shortArg({ urls: ["x"] }), '{"urls":["x"]}');
  assert.equal(shortArg({}), "");
  assert.ok(shortArg({ query: "q".repeat(500) }).length <= 81);
});

test("the wake lists the work lane's last calls with their outcome and leaves the process lane's out", () => {
  const wake = new Wake(roomyWakeLimits);
  wake.begin("sys", { work: [], process: [] }, 0);
  const use = (id: string, name: string, lane: "work" | "process") => ({
    message: { role: "assistant" as const, lane, provider: "anthropic" as const, content: [{ type: "tool_use" as const, id, name, input: { path: `/${id}` } }] },
    only: lane,
  });
  const result = (id: string, isError: boolean, lane: "work" | "process") => ({
    message: { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: id, content: "x", is_error: isError }] },
    only: lane,
  });
  wake.push(use("a", "read_file", "work"), result("a", false, "work"));
  wake.push(use("b", "send_message", "process"), result("b", false, "process"));
  wake.push(use("c", "find_files", "work"), result("c", true, "work"));
  wake.push(use("d", "web_fetch", "work"));
  assert.deepEqual(wake.workCalls(5), [
    { name: "read_file", input: { path: "/a" }, failed: false },
    { name: "find_files", input: { path: "/c" }, failed: true },
    { name: "web_fetch", input: { path: "/d" }, failed: null },
  ]);
  assert.deepEqual(wake.workCalls(2).map((call) => call.name), ["find_files", "web_fetch"]);
});

test("the status block is the process view's last turn and the work view never carries it", () => {
  const wake = new Wake(roomyWakeLimits);
  wake.begin("sys", { work: [{ role: "user", content: "ask" }], process: [{ role: "user", content: "ask" }] }, 1);
  wake.setStatus("[Status] block");
  assert.deepEqual(wake.view("process").at(-1), { role: "user", content: "[Status] block" });
  assert.equal(wake.view("process", false).at(-1)?.content, "ask");
  assert.equal(JSON.stringify(wake.view("work")).includes("[Status]"), false);
});

test("what the process lane sent reaches the work lane as its own turn, and arrivals stay shared", () => {
  const transcript = new TranscriptStore();
  transcript.append({ fromAgentId: null, toAgentId: "agent-1", content: "any update?" });
  transcript.append({ fromAgentId: "agent-1", toAgentId: null, content: "Wed 1 PM" });
  const arrived = arrivalsSince(transcript, "agent-1", 0);
  assert.match(String(arrived.turn?.content), /^\[Arrived during this wake\]/);
  assert.match(String(arrived.turn?.content), /any update\?/);
  assert.doesNotMatch(String(arrived.turn?.content), /Wed 1 PM/);
  assert.match(String(arrived.sent?.content), /^\[Sent by your process lane\]/);
  assert.match(String(arrived.sent?.content), /Wed 1 PM/);
});

test("a message the work lane sent directly reaches only the process lane, and hath's pickup reaches both", () => {
  const transcript = new TranscriptStore();
  const ask = transcript.append({ fromAgentId: "agent-1", toAgentId: "cse-335-specialist", content: "what is due tonight?" });
  ask.sentBy = "work";
  const pickup = transcript.append({ fromAgentId: "agent-1", toAgentId: null, content: "Working on it." });
  pickup.sentBy = "hath";
  const arrived = arrivalsSince(transcript, "agent-1", 0);
  assert.equal(arrived.sent, null, "the work lane is not told it sent its own message");
  assert.match(String(arrived.sentByWork?.content), /what is due tonight\?/);
  assert.doesNotMatch(String(arrived.sentByWork?.content), /Working on it/);
  assert.match(String(arrived.turn?.content), /Working on it\./);
});

test("the status block renders the job ledger: each ask with who answered, and what the requester was told", () => {
  const block = renderStatus({
    ...status,
    ledger: {
      job: 812,
      requester: null,
      opened: { seq: 812, at: "2026-10-29T10:00:00-04:00", content: "what is due tonight?" },
      answer_by: "2026-10-29T10:05:00-04:00",
      asks: [
        { to: "cse-300", seq: 813, answered_seq: 815 },
        { to: "cse-335", seq: 814, answered_seq: null },
      ],
      helpers: [],
      stored: [],
      told: [{ seq: 816, preview: "CSE 300: Module 8 quiz" }],
      reminders: [],
      stopped: null,
    },
  });
  assert.match(block, /This job \(#812\), opened by Ankur/);
  assert.match(block, /cse-300 \(#813\): answered in #815/);
  assert.match(block, /cse-335 \(#814\): no answer yet/);
  assert.match(block, /Already told Ankur:\n {2}- #816: CSE 300: Module 8 quiz/);
});
