# Hath

Agent runtime for dadi. It owns agent identity, transcripts, the dual-lane loop, inter-agent messaging, and the audit log. Every model call goes to Dwar. Hath never talks to a provider. Unauthenticated; private mesh only.

## Dependencies

- Postgres (`DATABASE_URL`)
- Dwar at `http://dwar.dadi` for chat and image describe
- Yaad at `http://yaad.dadi` for memory tools
- Ghar at `http://ghar.dadi` for home device tools
- Nas at `http://nas.dadi` for helper tasks (browsers and terminals), the host filesystem, and its event stream (also mesh DNS / logging)

## Layout

```
hath/
  src/
    app.ts, config.ts, logging.ts, errors.ts, constants.ts
    db/           Drizzle, migrate, messages, attachments, agent logs
    dwar/         Dwar axios client
    yaad/         Yaad axios client
    ghar/         Ghar axios client
    nas/          Nas axios client (helper tasks + event stream, filesystem, terminals)
    runtime/      dual-lane engine, outbox and send, status block, transcript cache, attachments, events, locks
    tools/        the tool registry (a code file: `hath_spawn_agent` and the Ghar tools) and the embedded tools
    routers/      HTTP routes + schemas
    types/        domain types
  test/
  drizzle/
  prompts/
  config.toml
```

## Config vs env

`config.toml` (checked in): lane queue timeout, transcript window size and step, wake tool-result clearing budget and supersede window, Dwar/Yaad/Ghar/Nas timeout and retry, and `[files]`: `dir`, the box folder Hath keeps files in, and `cache_retention_days`, how long the sweep keeps a cache file (see Files on the box).

Topology is hardcoded in `src/constants.ts`.

`DATABASE_URL` is required at startup (no empty default). Nas injects it in compose and on the appliance (`postgres://hath:hath@hath-postgres:5432/hath`). There is no Hath `.env` — Postgres is not Preferences-editable; `.env.example` documents the variables. `TZ` is required too and must be an IANA zone: it is the box's time zone, which Nas writes to `/var/lib/dadi/timezone.env` from `/etc/localtime` on every boot and the container loads with `EnvironmentFile=`; compose requires it in the shell.

## Local run

```sh
cd ../nas
docker compose up hath hath-postgres
docker compose run --rm hath npm run db:migrate
docker compose run --rm hath npm test
```

Migrations run schema SQL. The tool registry is a code file, so there is nothing to sync and nothing to grant. The router is `POST /router`, not an agents row.

## CI / CD

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` → `ci` | PR + push to `main` | Postgres service, migrate, `npm test`, build images |
| `ci.yml` → `publish` | `main` after `ci` | Push `ghcr.io/<owner>/hath:{latest,sha}` |

## Logging / error codes

Logs follow the nas JSON contract (`service=hath`, request summary, `code` on errors). Default Fastify access logging is off.

HTTP errors: `{ "error": { "type": "<code>", "message": "..." } }`. Shared codes include `invalid_request`, `not_found`, `upstream_unreachable`, `internal_error`. Domain codes include `dwar`, `yaad`, `ghar`, `nas`, `conflict`, `stale_ref`, `retired`. See nas README for the shared catalog (`busy`, `forbidden`, `binary_file`, …).

## Agents

Every `agents` row is an agent. The router is not a row — it is `POST /router`. Agent primary keys are immutable lowercase kebab-case ids (`browser-manager`); there is no separate name column. API responses still expose `name` as an alias of `id` for desktop/roster compat. Root agents have `parent_agent_id` null: they are the router's children. Nested workers point at a real parent. `GET /agents` includes ephemeral `running` (lane locks) and `sessions` (Nas browsers and terminals the agent recently drove). Spawn/list do not attach; worker tools that take `browser_id` or `terminal_id` do. Both maps die with the process.

## Router

`POST /router` is Dadi's translator: Ankur says what he wants, and the router picks the owner, writes the message he would send, and sends it as him; his app opens that thread when the agent answers. It is not an agent and not a conversation. The router is the null identity — the same as the user — so every message it sends lands in an agent's thread as `from_agent_id` null, written as Ankur. The router is ephemeral: it has no transcript and carries nothing between runs. Each request:

1. Stages its attachments unbound and appends an `[Attachment …]` stub per file to the utterance, then writes an audit row (`agent_logs`, router lane, `message` / `receive`) holding it. The utterance is not stored as a message; staged files the router did not forward are deleted when the run ends.
2. Runs the router lane: the same step loop as agent lanes, calling Dwar `POST /chat/complete` (context-free on Dwar's side). System is `prompts/system.md` + `prompts/router.md` + identity + the active root agents; messages are exactly one turn, this utterance (headed `[From: Ankur]`) — no earlier run, nothing sent as Ankur, no reply to him, and nothing that arrives mid-run. What is underway it finds with its tools. Nothing in code caps the loop; it ends when the model calls `yield`.
3. Returns `201 { messages: [{ to_agent_id, content, attachments, seq, created_at }] }` — every message it sent or forwarded, in order (may be empty).

Router tools (hardcoded, not grants): `send_message` (deliver as Ankur; a retired recipient is a `retired` error), `forward_attachment` (deliver attachment ids from the message's `Path:` blocks as Ankur), `read_file`, `list_agents`, `recall_memory`, `hath_spawn_agent` (creates a root), and the embedded agent-management tools `get_agent` and `get_logs` on any agent. It cannot modify agents: agents reshape themselves. Its model turns and tool results log to `agent_logs` with a null `agent_id` on the `router` lane. The router's `get_logs` must name an agent; nobody reads the null identity's rows through a tool: they hold the router's turns and every message sent by or to Ankur. Runs are serialized.

SSE: `router_started` / `router_finished` / `router_failed`. After a route, each thread's `lane_*` and `message` events take over.

## The user is null

No user table. Human messages use `from_agent_id = null` / `to_agent_id = null`; the router shares that identity.

## Dual lanes

Every agent has both lanes. **Work** is the executor: every registry tool plus embedded `message` / `list_agents` / `wait` / `recall_memory` / `ingest_memory` / `manage_agent` / `modify_agent_prompt` / `steer_browser` / `steer_terminal` / `list_browsers` / `list_terminals` / `read_file` / `find` / `write_file` / `edit_file` / `get_agent` / `get_logs` / `yield`. **Process** is the front desk and the agent's only voice, with a fixed list, no async tools, no `wait` and no `list_*` helper tools: `send`, `steer_work`, `read_file`, `find`, `get_logs`, `recall_memory`, `web_search`, `web_fetch`, `list_agents`, `yield`. Speech is only via `send` (the work lane's `message` gives the process lane something to say) — model text is thought, never speech. Both lanes call Dwar with `tool_choice: "auto"`, so the model can think and write before, alongside, or instead of a tool call; a turn with no tool call continues the lane (a `[continue]` user turn follows it, saying the text reached no one), and a turn ends only on `yield`. `list_agents` looks up kebab-case ids (or lists the roster). Assembled transcripts stamp each turn `[From: …]` / `[To: …]` (Ankur or an agent id) so multi-party threads stay attributable.

The process lane wakes on any inbound message except a reply the work lane awaits, and on a work-lane `message`. The work lane wakes on a `steer_work`, on helper, async and wait results, and on the reply to a message it marked `expects_reply` (from an agent or from Ankur), which bypasses the process lane. `steer_work` queues instructions for the next work-lane step.

**One voice.** The process lane is the only lane that messages anyone: Ankur, a requester, a peer, an agent the work lane spawned. The work lane never does. It calls `message({to, content, attachments?, expects_reply?})` (`to`: `"ankur"`, `"requester"` or an agent id; `attachments`: absolute file paths, copied when `message` is called, or attachment ids), which writes a row to the outbox (the `handoffs` table, kept under its old name so older rows stay) and wakes the process lane. The process lane sees the pending rows in a `[Messages from work]` turn and sends with `send({to, content, attachments?, status?})`. A `send` to a recipient marks every row waiting for that recipient `sent` and carries those rows' files, so several messages to one person become one message, consistent with what was already said; the process lane may reword one to Ankur, but a row is never dropped: it cannot yield while one waits (three reminders, then the lane fails, the rows become `failed`, and a steer tells the work lane each was not sent). A `path` in `attachments` is copied into the attachments store at the moment of the call (`resolveAttachments` in `src/runtime/attachments.ts`). A row left pending by a restart wakes the process lane at boot, and a retired agent's process lane still runs while one waits. A row marked `expects_reply` keeps the recipient's next message from waking the process lane: it wakes the work lane and ends the wait (`awaitingReply` in `src/db/outbox.ts`). The only refusals on a `send` are race checks: the recipient wrote to this agent after the process lane composed it, or this agent already sent the recipient a message since (the refusal quotes it). There is no brought-in status, no required job status, no progress-update limit and no wrong-recipient refusal; `status` on `send` is optional and only records the job.

Both lanes share one **wake** per agent (`src/runtime/wake.ts`), but each lane's view is its own. It starts from the system and each lane's transcript window, frozen together at the wake's first call (so `modify_agent_prompt` and new children reach an agent's system at its next wake), then records every step either lane takes, whole and in order: the model turn (thinking, text and tool calls, tagged with the provider and lane that produced it) followed by its tool results, each private to the lane that took it, plus messages that arrive mid-wake as one `[Arrived during this wake]` turn for both lanes. The work lane also gets what its process lane sent as a `[Sent by your process lane]` turn. There is no step limit. Old tool results go first: once the results still shown in full pass `[runtime].wake_tool_results_max_chars`, every result older than the newest `wake_tool_results_kept_chars` reads as a short `[cleared]` note for the rest of the wake. Old turns go only when a lane's prompt would pass `[runtime].prompt_ceiling_tokens` (96000, under the 100k-token step where Haiku's price rises 5x): before each call the lane's last measured prompt (Dwar's `usage`) plus the estimated turns since is checked, and if it is over, the oldest steps leave that lane's view behind one `[trimmed]` turn until it sits `prompt_trim_tokens` (16000) under the ceiling — the turn says it is from hath (Dwar folds it into the next user turn, where unlabelled it read as that sender's) and lists the actions the dropped steps took (`src/runtime/record.ts`: writes, edits, steers of a browser or terminal task, schedules, agent changes and the like, each with its clipped input and result, never reads), so a trimmed lane does not redo a send it can no longer see; when the newest step alone passes the ceiling (several large results from one turn), its largest results read as a `[too large]` note, only as many as it takes to fit, and the lane fails only if that is still not enough. Each lane trims its own view, and a trimmed note lists only that lane's own actions. A read of state reads as a short `[superseded]` note once a newer read of the same state lands within `[runtime].wake_supersede_window_turns` turns of it: a tab's accessibility tree or screenshot (keyed by tab, or the whole display), a page's text (keyed by URL, so another page's text is never hidden) and a terminal's screen from `terminal_read`. The window keeps the cache rewrite inside the provider's lookback; a read further back stays until the size cut clears it. The process lane does not see the work lane's thinking, tool calls or results (about 62k tokens a call before the overhaul), and the work lane does not see the process lane's turns. The process lane's view is its system, a small window of the thread (`[runtime].process_context_tokens`, 30000 tokens counting the system and its tools), its own turns, what arrived, the `[Messages from work]` turn, and the **status block** as the last user turn of every call, so everything before it stays byte-stable and cached. Steers are private to the work lane. A wake lasts while any lane run for the agent is queued or running; when the last one finishes it is dropped, and the next wake starts from the transcript alone. Before it is dropped, a wake whose work lane took an action writes those actions (the same list) into the agent's transcript as a `[runtime] Wake record` message to itself, which wakes no one: the next wake then sees what ran, not only what the agent said about it, since without it a fresh wake reading its own reports with nothing behind them retracted true ones. A process-lane run that finds nothing new it can see since that lane last yielded in this wake ends without a model call, so wake-ups queued behind a run that already handled them cost nothing. Apart from those one-way cuts, which move in jumps, earlier turns never change mid-wake — Dwar caches the history prefix, so a byte-stable history is what keeps long wakes cheap. The transcript's last turn is sent with `cache_breakpoint`, so the next wake reads the shared transcript from cache instead of rewriting it. A lane run that throws (either lane) is reported to the agent's parent (Ankur for a root agent) as a `[runtime]` message, which also wakes the parent; the same failure on every wake during an outage (request ids aside) is reported once, until one of the agent's runs finishes cleanly; tool errors never fail a lane, they come back to the model as tool results. A queued lane run waits for its lane without a deadline. Lane state is in memory, so a restart ends every running wake: at boot Hath reads `agent_logs` since each active agent's last runtime report (the `runtime_report` payload key), wakes an agent that had only a message waiting (runtime reports never count as one), and has an agent caught mid-wake report to its requester with its last step instead of replaying it. The report does not wake the requester, and it is sent only when the wake's last step is within `[runtime].recovery_window_minutes` (10) of boot; older interrupted wakes are stale and dropped.

`manage_agent` with `retired: true` retires an agent (`active` false): it does not run, and `POST /messages`, `message`, `send`, `schedule_message` and the router's send to it fail with `409 retired`. Only its parent can change it again, and only by reactivating it with `retired: false`, which brings it back with its prompt, tools and history. `list_agents` leaves retired agents out unless `show_retired` is true.

Every Dwar call sends `X-Dadi-Caller` (`hath/<agent id>`, `hath/router`, `hath/attachments`) so Dwar's inference log attributes tokens; `response` logs carry the full usage including cache reads and writes.

Every system prompt starts with the shared system doctrine (`prompts/system.md`), then the charter (the agent's stored prompt), its identity, and its active children. Assembled context always includes a lane block (the process lane is the front desk and steers the work lane via `steer_work`, including `terminate` to halt the next tool call) and an identity/routing block: agent id, parent (or root), and point-of-contact messaging for the job. This is prompt guidance only — `send` and `message` do not enforce it.

## Attachments

An attachment is a file on the box with a row of metadata in `attachments` (filename, media type, size, an image's Dwar `/image/describe` description, and `path`); the row is bound to the message that carries it (`message_id`) or unbound until one does. The file is the contents: it is written through Nas under `<files.dir>/attachments/<id>/<name>` when it arrives (`POST /messages`, `POST /router`, an oversized agent message, a file path given to `send` or `message`, a helper's report) and never rewritten, and no bytes are kept in Postgres. Older rows that still hold their bytes in `text_content` or `data` are moved to files at boot (`moveLegacyAttachments`); once none is left a migration can drop those columns and make `path` required. One file is at most 10 MB, one message carries at most 8. A message delivers once, however many files it carries.

An agent-to-agent message (a `schedule_message` body) is refused past 4,000 characters (`AGENT_MESSAGE_MAX_CHARS` in `src/tools/shared.ts`) with an error telling the sender to report findings in a few lines and attach raw output; a `send` to an agent past it arrives as its opening with the whole text attached as `message.md`; messages to Ankur are not capped.

Transcripts never hold file contents. Each file renders under its message as an `[Attachment <id> · name · type · size]` block with its `Path:` and, for an image, its description; agents open it with `read_file`. Files are passed on by id or by path in `attachments` of `send` or `message`. Sending an unbound file binds it; sending a bound one copies the row (and shares the one file, which is never edited), so every message owns its row and deleting it deletes the row, not the file. A path is copied as the file is at that moment (a snapshot) into an attachment owned by the agent, read whole through Nas `/fs/read_bytes`. `GET /attachments/:id` returns the original file. Files are not garbage collected.

## Tools

The registry (`src/tools/registry.ts`) is a hard-coded file: `hath_spawn_agent` and the four Ghar tools. Every agent's work lane holds every registry tool plus the embedded tools below; there are no grants, no usage text and no tool tables (the old `tools` and `agent_tools` tables are kept, renamed `*_retired_20261029`, for Ankur to drop). Hath has no tools for Nas host ops, device surveys, the vault or Yaad's correction history: the vault belongs to the helpers, and a history tool comes back if one is needed.

### Yaad (memory)

Every work lane holds the two memory tools, so each agent reads and writes memory itself; there is no memory agent to hand facts to.

| embedded tool | Yaad route | when to use |
| --- | --- | --- |
| `recall_memory` | `POST /recall` | anchor on a `query` (by meaning), `from` node ids, or exact filters (`kind`, `name`, date window, `status`), then walk `hops` links out; `{ from: [id], hops: 1 }` is a node with its neighbors |
| `ingest_memory` | `POST /ingest` | store a fact, event, or scheduled meeting about Ankur's world, and every calendar write: scheduling time, moving or cancelling one session, its outcome, and its notes |

`ingest_memory` sends `source: "agent"`, `agent_id` = the calling agent, and `occurred_at` stamped from the clock, so Yaad records which agent wrote every node. A worker agent is not offered it: it reports to the agent that owns the domain, which stores what matters. Lessons about how sites, accounts, and repos behave stay in agents' transcripts, not memory.

There are no planner tools: Ankur's timeline is Yaad's plans, so agents schedule, reschedule, record outcomes and add session notes through `ingest_memory`, and read the schedule with `recall_memory` date filters.

### Helpers (browser and terminal)

Browser and terminal work is done by helpers in Nas (`nas/service/helpers`), not by agents and not by Hath: a helper is a charter and a loop on Dwar `/chat/complete` that drives one Chromium or one shell, and its tasks live in Nas as `task/browser/<id>` and `task/terminal/<id>`. Nothing in Hath drives a browser or a terminal, and no tool takes a browser or terminal id. Agents reach helpers through four embedded tools (work lane), thin calls to Nas's Tasks API (`src/tools/helper/tasks.ts`, `src/nas/client.ts`):

| tool | Nas route | notes |
| --- | --- | --- |
| `steer_browser({id?, message})` | `POST /tasks/browser` or `POST /tasks/browser/{id}/steer` | no id starts a task; an id steers it, waking it if asleep; returns `{ id }` at once |
| `steer_terminal({id?, message, workdir?})` | `POST /tasks/terminal` or `.../{id}/steer` | the same; `workdir` is the new task's starting directory |
| `list_browsers` / `list_terminals` | `GET /tasks` | id, status, owner, purpose, current page or directory, minutes idle; the process lane gets them in the lane overhaul |

A helper's report (`done`, `needs_input`, `failed`) reaches the agent that steered it as a notice (a message from the agent to itself) that wakes its work lane, with the files it names as attachments (`src/runtime/helper-reports.ts`). Hath follows Nas's `GET /events` stream and reconciles from `GET /tasks` (`last_report`) on boot and after every reconnect, because the stream has no replay. A report is delivered once: the table `delivered_reports` holds, per task, the time of the newest report delivered, and a report no newer than that is skipped. Reports are compared by the time they carry, not their number, which Nas restarts from 1. A crash between a message and its mark delivers that report again. `GET /agents` reads each agent's `sessions` (the tasks it owns or last steered) from `GET /tasks` on every call.

### Files

Embedded, instant tools through Nas's `/fs` API (`src/tools/files/files.ts`); there is no terminal in the path.

| tool | lanes | notes |
| --- | --- | --- |
| `read_file({path, offset?, limit?, pattern?})` | both | text, a PDF as text, an image as its Dwar description; pages by characters with `total_chars` and `next_offset`, or `pattern` for matching lines with numbers. Files over 10 MB and other binaries are refused |
| `find({name?, text?, path?})` | both | `name` globs file names at any depth, `text` greps contents (filtered by `name` when both are given); matching lines carry line numbers and long lines are clipped |
| `write_file({path, content})` | work | creates or replaces a file |
| `edit_file({path, old, new})` | work | exact replacement; fails and changes nothing unless `old` occurs exactly once |

A PDF is turned into text once by the box's `pdftotext -layout`, run in a terminal Nas opens for the call and closes after, into `<files.dir>/pdf/<sha1 of the PDF>.txt`; later reads use that file.

### Waiting, async tools and wake reasons

`wait({on, timeout_minutes})` (work lane) ends the run like `yield`, with no model call, after recording a watch in `watches` (one row per agent: the task ids and agent ids it waits on, since, due). The awaited helper report or message wakes the work lane by itself and drops the watch; on timeout the scheduler's tick wakes it with facts (a task's status and minutes since it last did anything; an agent's minutes since its last logged activity and whether it has run since it was messaged). The lane's next real run drops any watch left. `GET /agents` shows `running.waiting_on` (`targets`, `since`, `wakes_by`).

A tool is async when its definition says so (`async: true` on a registry or embedded definition; `ingest_memory` sets `INGEST_MEMORY_ASYNC` in `src/runtime/memory.ts`). In the work lane such a call returns `{ pending: <call id> }` at once and runs in the background; its result, or its failure, arrives as a notice that wakes the work lane through the same path as a helper report (`src/runtime/rewake.ts`). Results over 4,000 characters arrive as their opening and the path of a file holding them whole. Each running call is a row in `pending_async`; a Hath restart loses the call itself (the Yaad ingest may or may not have finished), and at boot every leftover row is reported to its agent as lost so it can check and run it again.

The first line of every wake is `Woken by: <reasons>` (message from X, helper result from task/..., async tool result, scheduled message, wait timeout). A work-lane yield that leaves the requester's latest message unanswered, with nothing pending that would wake the agent (a working Nas task, a wait, a one-shot scheduled message, a running async call, a work-lane message waiting to be sent), is answered once with `[continue] <who> asked "<what>" at <time> and nothing you started will wake you. ...` (`src/runtime/yield-reminder.ts`).

### Files on the box

Everything Hath keeps as a file lives under `[files].dir` (`/var/home/dadi/.dadi`) and is written through Nas: `attachments/<id>/<name>` (see Attachments), `results/<tool_use_id>.txt` (a tool result over 400 characters, saved whole; the wake's `[cleared]` and `[too large]` receipts name the path, and `read_file` reopens it; `read_file`, `find`, `yield` and `wait` results are not saved) and `pdf/` (above). `results/` and `pdf/` are caches: a daily sweep (`src/runtime/retention.ts`, run from the scheduler tick) deletes the files in them older than `[files].cache_retention_days`. `attachments/` is never swept. Nas's filesystem API has no stat or delete, so the sweep lists and removes through a Nas terminal.

### Ghar (house)

Registry tools over Ghar's HTTP API (`src/tools/ghar/`):

| tool | notes |
| --- | --- |
| `ghar_list_devices` | the house's devices, filtered by room, tag, capability or kind |
| `ghar_get_state` | every device's current attribute state |
| `ghar_control_device` | send a command to one device; the cause is recorded as the calling agent |
| `ghar_get_device_events` | a device's event history |

### Devices (desktop and phone apps)

Hath keeps the reverse-RPC gateway for the apps (`DeviceGateway`): presence heartbeats at `POST /devices/presence`, commands over SSE `device_command`, results at `POST /devices/commands/:id/result`, and the router's `device_open_chat`. No agent tool reads a device now; the `device_get_*` surveys were removed and can be rebuilt on the gateway.

### Hath (meta)

Registry tool:

| tool | notes |
| --- | --- |
| `hath_spawn_agent` | create a child (a root when the router calls it); makes an agent a manager |

Embedded in every work lane (not in the registry):

| tool | notes |
| --- | --- |
| `message` | give the process lane something to say to Ankur, a requester or any agent, with optional files and `expects_reply`; the process lane's `send` is the other half (see Dual lanes) |
| `manage_agent` | retire yourself or a direct child, or reactivate a retired direct child (immutable ids) |
| `modify_agent_prompt` | exact-match `old_string` → `new_string` edits to your own or a direct child's prompt; all apply or none |
| `get_agent` | id, system prompt, parent, active flag, and the registry's tool names for self or a direct child (any agent for the router) |
| `get_logs` | audit (`response` / `tool_result` / `message`) for self or a direct child (any named agent for the router, which never reads its own) |
| `schedule_message` / `list_schedules` / `cancel_schedule` | durable schedules sent from and owned by the caller, so every agent automates its own work; not the router's |

## Persistence

`agents`, `agent_logs`, `messages`, `attachments`, `scheduled_messages`, `jobs`, `handoffs`, `thread_reads` (how far Ankur has read each agent's thread), `delivered_reports`, `pending_async` and `watches` survive restart. A `jobs` row is the open work on one line: a requester (null for Ankur) that messaged the agent before the agent ever messaged it. A message back on that line may carry a `status` (`running`, `needs_input`, `blocked`, `done`) that records the job's progress; nothing refuses a send for its status or its absence (`src/runtime/jobs.ts`). Scheduled triggers and hath's notices open no job. When an agent's wake ends, every job it touched and left open, while it has no job of its own out with another agent, closes as `noop` when the wake did nothing on it; one the wake did work on stays open. Every inbound message wakes the recipient's process lane, except a reply to a message the recipient's work lane marked `expects_reply`, which wakes the work lane. An agent's own messages are never folded back into its wake as arrivals, and a work-lane run with nothing new since it last yielded makes no model call. The `handoffs` table is the work lane's outbox (older rows are kept as they were). `messages` is the source of truth for human↔agent chat and the rolling lane transcripts: the newest messages of the agent's thread that fit `[runtime].process_context_tokens` (15000 tokens with the system and the process lane's tools) for the process lane, and up to `work_transcript_window_chars` (100000, about 42k tokens) for the work lane, which keeps about 40k of its prompt for the wake. Each window's start advances in jumps of `transcript_window_step_chars` so the cached prefix survives new messages; nothing is summarized, and what falls out of the window is gone from context. The transcript is the agent's scratchpad: how it did a task lives there and fades; facts about Ankur live in Yaad; the prompt holds only the agent's purpose. Older turns remain in `agent_logs` / `hath_get_logs`. Each `agent_logs` row is one of: `response` — one model call's full output (`provider`, `stop_reason`, `usage`, and `content` blocks in provider order: `thinking` / `redacted_thinking`, `text`, `tool_use`), written before its tools run; `tool_result` — one tool's outcome (`tool_use_id`, `name`, `content`, `is_error`, plus audit fields such as `browser_id`); `message` — a delivered message. Wakes, locks, steer/intent queues and the event stream do not survive. Single-process only — do not run replicas sharing the DB and expecting lane serialization.

Schedule tools (`schedule_message`, `list_schedules`, `cancel_schedule`) persist one-shot and recurring deliveries; the in-process scheduler ticks from `[schedule].tick_seconds` in `config.toml` (wall clock is the box's zone from the required `TZ`, which Nas writes from `/etc/localtime`).

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok", "started_at": "<iso>" }` — process identity only; not a chat epoch |
| `POST` | `/router` | Ankur → router: runs the router lane until it yields; returns the messages it sent |
| `POST` | `/messages` | user → agent; `attachments` stored as rows (images described via Dwar); returns them as summaries |
| `GET` | `/attachments/:id` | the original file, with its media type |
| `GET` | `/threads` | human↔agent conversation summaries (active agents only), each with `unread` (the agent's messages to Ankur after `read_seq`, notices left out) and `read_seq` (null until read) |
| `GET` | `/agents/:id/messages` | durable human-thread messages with attachment summaries (`since_seq`, `limit`) |
| `POST` | `/agents/:id/read` | `{ seq }`: Ankur has read the thread through `seq`; the mark only moves forward, `seq` past the newest message is `422`; returns `{ agent_id, read_seq, unread }` and emits SSE `thread_read` so every device clears it |
| `GET` | `/events` | SSE live events; no replay. `schedules_changed` fires when a scheduled message is created, edited, cancelled, delivered or advanced, and names no schedule: clients refetch the lists they show; `sessions_changed` fires when a helper task is steered, reports, or Nas says its task list changed (the `sessions` on `GET /agents`) |
| `GET` | `/agents` | all agents + `running` (lane locks, `waiting_on`, and `status`, the status block's data while a lane runs or the work lane waits: `job`, `work` state and since, `step`, the last five `recent` tool calls, in-flight `tasks`, `pending` work-lane messages) + `sessions` (Nas helper tasks) |
| `GET` | `/agents/:id` | agent, children, and the registry's tools (`tools: [{ name, description }]`, the same for every agent) |
| `GET` | `/agents/:id/logs` | per-agent audit trail |
| `GET` | `/agents/:id/schedules` | every schedule the agent sends or receives, next run first |
| `PATCH` | `/schedules/:id` | hand edit as Ankur: any of `run_at` (future, with offset), `interval_minutes` (null for one-shot), `content` |
| `DELETE` | `/schedules/:id` | cancel a schedule as Ankur |
| `GET` | `/logs` | cross-agent audit trail |

Unknown request fields are a 422. No CORS — clients use Tauri HTTP (or equivalent) outside the browser sandbox.
