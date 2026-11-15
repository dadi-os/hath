# Hath

Agent runtime for dadi. It owns agent identity, the threads, each agent's loop, jobs and routines, inter-agent messaging, and the audit log. Every model call goes to Dwar. Hath never talks to a provider. Unauthenticated; private mesh only.

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
    runtime/      the engine (`engine.ts`), one agent's loop (`loop.ts`, `step.ts`, `interrupts.ts`), the wake (`wake.ts`), what an agent reads (`context.ts`, `header.ts`, `continuation.ts`, `ledger.ts`), jobs (`jobs.ts`, `job-of.ts`, `pending.ts`, `stop.ts`), the clock (`scheduler.ts`, `answer-by.ts`, `pickups.ts`, `watches.ts`, `routines.ts`), messaging (`deliver.ts`, `send.ts`), `tool-set.ts` (the tools an agent and the router hold), transcript cache, attachments, events, locks
    tools/        every tool defined by a zod schema and a handler, in one registry (a code file)
    routers/      HTTP routes + schemas
    types/        domain types
  test/
  drizzle/
  prompts/
  config.toml
```

## Config vs env

`config.toml` (checked in): router queue timeout, the thread window's share of the prompt ceiling and its step, wake tool-result clearing budget and supersede window, Dwar/Yaad/Ghar/Nas timeout and retry, and `[files]`: `dir`, the box folder Hath keeps files in, and `cache_retention_days`, how long the sweep keeps a cache file (see Files on the box).

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

Every `agents` row is an agent. The router is not a row — it is `POST /router`. Agent primary keys are immutable lowercase kebab-case ids (`browser-manager`); there is no separate name column. API responses still expose `name` as an alias of `id` for desktop/roster compat. Root agents have `parent_agent_id` null: they are the router's children. Nested workers point at a real parent. `GET /agents` includes ephemeral `running` (whether the agent runs, what it waits on, the job its wake is on) and `sessions` (Nas browsers and terminals the agent recently drove). Spawn/list do not attach; worker tools that take `browser_id` or `terminal_id` do. Both maps die with the process.

## Router

`POST /router` is Dadi's translator: Ankur says what he wants, and the router picks the owner, writes the message he would send, and sends it as him; his app opens that thread when the agent answers. It is not an agent and not a conversation. The router is the null identity — the same as the user — so every message it sends lands in an agent's thread as `from_agent_id` null, written as Ankur. The router is ephemeral: it has no transcript and carries nothing between runs. Each request:

1. Stages its attachments unbound and appends an `[Attachment …]` stub per file to the utterance, then stores it as a `messages` row of kind `utterance` (from and to null), which belongs to no conversation: it is never in a thread, a transcript or a job. staged files the router did not forward are deleted when the run ends.
2. Runs the router: the same step machinery as an agent, calling Dwar `POST /chat/complete` (context-free on Dwar's side). System is `prompts/system.md` + `prompts/router.md` + identity + the active root agents; messages are exactly one turn, this utterance (headed `[From: Ankur]`) — no earlier run, nothing sent as Ankur, no reply to him, and nothing that arrives mid-run. What is underway it finds with its tools. Nothing in code caps the loop; it ends when the model calls `yield`.
3. Returns `201 { messages: [{ to_agent_id, content, attachments, seq, created_at }] }` — every message it sent or forwarded, in order (may be empty).

Router tools (declared in `src/runtime/tool-set.ts`): `send_message` (deliver as Ankur; a retired recipient is a `retired` error), `forward_attachment` (deliver attachment ids from the message's `Path:` blocks as Ankur), `read_file`, `list_agents`, `recall_memory`, `spawn_agent` (creates a root), and `get_agent`, `get_logs` and `get_messages` on any agent. It cannot modify agents: agents reshape themselves. Its model turns and tool results log to `agent_logs` with a null `agent_id`: that is what marks the router's rows. The router's `get_logs` must name an agent; nobody reads the null identity's rows through a tool: they hold the router's turns. One run at a time: a `POST /router` while one is in flight is refused with `409` and `{error: {type: "router_busy", message, run_id, at}}` naming the run in flight, and the client keeps its draft.

SSE: `router_started` / `router_finished` / `router_failed`, each with the `run_id` of its run, and a client keeps the run id it has seen start until the matching finish or failure; `GET /router` lists the runs in flight for a device that connects mid-run. After a route, each thread's `run_*` and `message` events take over.

## The user is null

No user table. Human messages use `from_agent_id = null` / `to_agent_id = null`; the router shares that identity.

## The agent loop

Every agent is one loop. It holds every tool in the registry plus `send_message`, `list_agents`, `wait`, `recall_memory`, `ingest_memory` (not a worker), `manage_agent`, `modify_agent_prompt` and `yield` (`src/runtime/tool-set.ts`). A run (`src/runtime/loop.ts`) is a series of steps: fold in what arrived, make one Dwar `POST /chat/agent` call with `tool_choice: "auto"` (the model can think and write before, alongside or instead of a tool call), run the tools it asked for, record the turn whole. There is no step limit. Runs are serialized per agent by a lock (`src/runtime/locks.ts`); a run queued behind one that already read everything ends without a model call.

**Concurrency inside the loop.** Messages that arrive between steps join the next step as one `[Arrived during this wake]` turn, each marked with its job (`job #N`). A message from the requester of the job the agent's wake is on also cancels the model call in flight (`Interrupts.preempt`, called from `deliver.ts`): the aborted call is logged with `aborted: true`, and the step runs again with the arrival in view. An arrival from another job does not cancel anything. `POST /agents/:id/stop` (for Ankur's apps) is the hard stop: it cancels the call, lets no further tool call run, halts the helper tasks steered in the current job, marks the job `stopped` (`stopped_at`, `stopped_by`) and records an activity row (`src/runtime/stop.ts`). `stop_task({id})` halts one helper task; a later steer revives it.

**Ending a run.** A turn ends the run when it calls `yield`, or `wait`, or consists only of `send_message`, `steer_browser`, `steer_terminal`, `ingest_memory` and saves (`write_file`, `edit_file`, `set_routine`, `end_routine`, `remind_me`, `stop_task`) with at least one of the first four, none failed: what it started (an ask, a helper task) is waited on for 30 minutes. A turn of text and no tool call is the agent's answer when its job still owes the requester one: it is sent as `send_message({to: "requester", status: "done"})` and the run ends; it ends a routine's wake silently; otherwise it is only thought, and a `[continue]` turn follows. A yield that leaves an open job with a requester unanswered, with nothing pending that would wake the agent (an ask no one answered, a working helper task, a wait, a reminder of its own, a running background call), is answered once with a reminder (`src/runtime/yield-reminder.ts`).

**One send path.** `send_message({to, content, attachments?, status?})` (`src/runtime/send.ts`): delivered when the call returns, stamped with the sender's job, and never refused for what it says. `to` is `"ankur"`, `"requester"` (the requester of the wake's job: an error in a job nobody asked) or an agent id; a message to oneself or a retired agent is an error. A date in a message to Ankur gets its weekday written beside it, computed in the box's zone for the year nearest today (a wrong weekday is corrected, text in quotes is left alone; `src/runtime/weekdays.ts`). An agent message over 4,000 characters goes as its opening with the whole text attached as `message.md`. `status` on a message to the job's requester closes (`done`, `blocked`) or parks (`needs_input`) the job; `running` does not exist.

**Clock facts hath sends.**
- Answer-by (`src/runtime/answer-by.ts`): a job Ankur opens is due `[runtime].answer_by_minutes` (5) after his message (`jobs.answer_by`, shown in the wake header). When it passes with the job still open, the scheduler tick wakes the agent once with a notice (a message from the agent to itself, `sent_by = 'hath'`, in the job) listing what has come in and what has not. Jobs another agent asks have no answer-by time.
- Pickups (`src/runtime/pickups.ts`): when an open Ankur job's opening message is `pickup_delay_s` (180) old, the agent has taken a step in it, is running or waiting on something pending, and has sent him nothing in the job, hath sends him "Working on it." for the agent, once per job (`sent_by = 'hath'`, no status).
- `wait({timeout_minutes})` watches the job's pending items: asks no one answered and helper tasks still working (`src/runtime/pending.ts`); with none it is a plain sleep. The awaited reply or report wakes the agent by itself; on timeout the tick wakes it with the facts.

**Wake, window and continuation.** An agent's request is: the shared prefix (tools, `prompts/system.md`, Dwar's agent block), the agent's part (charter, lineage, directory), then the thread window, the wake header and the live scratchpad. The thread window (`src/runtime/context.ts`) is every message of the agent's open jobs, whole, then the newest other messages up to `[runtime].thread_window_share` (a quarter) of `prompt_ceiling_tokens`, never more than the room the ceiling leaves after the system and tools. A wake that continues a job (its reason did not open it) starts with the job's earlier steps rebuilt from `agent_logs` by `job_id` (`src/runtime/continuation.ts`, thinking left out): they are the wake's own steps, so old results read as receipts and steps past the ceiling leave behind the `[trimmed]` note.

The wake (`src/runtime/wake.ts`) is one agent's history for the current wake. It starts from the system and the thread frozen at the wake's first call (so `modify_agent_prompt` and new children reach an agent's system at its next wake), then records every step, whole and in order: the model turn (thinking, text and tool calls, tagged with its provider) followed by its tool results, plus messages that arrive mid-wake. Old tool results go first: once the results still shown in full pass `[runtime].wake_tool_results_max_chars`, every result older than the newest `wake_tool_results_kept_chars` reads as a short `[cleared]` receipt for the rest of the wake. Old turns go only when the prompt would pass `[runtime].prompt_ceiling_tokens` (96000, under the 100k-token step where Haiku's price rises 5x): before each call the last measured prompt (Dwar's `usage`) plus the estimated turns since is checked, and if it is over, the oldest steps leave the view behind one `[trimmed]` turn until it sits `prompt_trim_tokens` (16000) under the ceiling; the note lists the actions the dropped steps took (`src/runtime/record.ts`), so a trimmed agent does not redo a send it can no longer see. When the newest step alone passes the ceiling, its largest results read as a `[too large]` note, and the run fails only if that is still not enough. A read of state reads as a short `[superseded]` note once a newer read of the same state lands within `[runtime].wake_supersede_window_turns` turns of it. Earlier turns never change mid-wake apart from those one-way cuts, which move in jumps: Dwar caches the history prefix, and the thread's last turn is sent with `cache_breakpoint` so the next wake reads it from cache. A wake lasts while any run for the agent is queued or running; when the last finishes it is dropped, and the next wake starts from the thread and the job's earlier steps.

The wake is a row in `wakes` (`src/db/wakes.ts`): written when the wake is created with a structured reason (`message` with the sender agent id, `schedule` with the schedule id, `recovery`, or `manual`) and the message that opened it, closed (`ended_at`) when the last run releases, with `error` set when a run died or a restart cut it. A message is stamped with `wake_id`, the wake it opened or joined. A run that throws is reported to the agent's current requester (never Ankur) as a notice; the same failure on every wake during an outage (request ids aside) is reported once, until one of the agent's runs finishes cleanly; tool errors never fail a run, they come back to the model as tool results. Run state is in memory, so a restart ends every running wake: at boot Hath closes every wake row still open (`error`: interrupted by a hath restart), then reads `agent_logs` and `messages` since each active agent's last runtime report, wakes an agent that had only a message waiting under a `recovery` wake, and has an agent caught mid-wake report to its requester with its last step instead of replaying it. The report does not wake the requester, and it is sent only when the wake's last step is within `[runtime].recovery_window_minutes` (10) of boot.

`manage_agent` with `retired: true` retires an agent (`active` false): it does not run, and `POST /messages`, `send_message` and the router's send to it fail with `409 retired`. Only its parent can change it again, and only by reactivating it with `retired: false`, which brings it back with its prompt, tools and history. `list_agents` leaves retired agents out unless `show_retired` is true.

Every Dwar call sends `X-Dadi-Caller` (`hath/<agent id>`, `hath/router`, `hath/attachments`) so Dwar's inference log attributes tokens; `response` logs carry the full usage including cache reads and writes.

Every system prompt starts with the shared system doctrine (`prompts/system.md`), then the charter (the agent's stored prompt), its identity, and its active children. Dwar prepends its agent block (the shared rules of the loop), and the system carries an identity block: agent id, parent (or root). This is prompt guidance only; nothing enforces it.

## Attachments

An attachment is a file on the box with a row of metadata in `attachments` (filename, media type, size, an image's Dwar `/image/describe` description, and `path`); the row is bound to the message that carries it (`message_id`) or unbound until one does. The file is the contents: it is written through Nas under `<files.dir>/attachments/<id>/<name>` when it arrives (`POST /messages`, `POST /router`, an oversized agent message, a file path given to `send_message`, a helper's report) and never rewritten, and no bytes are kept in Postgres. Older rows that still hold their bytes in `text_content` or `data` are moved to files at boot (`moveLegacyAttachments`); once none is left a migration can drop those columns and make `path` required. One file is at most 10 MB, one message carries at most 8. A message delivers once, however many files it carries.

An agent-to-agent message past 4,000 characters (`AGENT_MESSAGE_MAX_CHARS` in `src/tools/shared.ts`) arrives as its opening with the whole text attached as `message.md`; messages to Ankur are not capped.

Transcripts never hold file contents. Each file renders under its message as an `[Attachment <id> · name · type · size]` block with its `Path:` and, for an image, its description; agents open it with `read_file`. Files are passed on by id or by path in `attachments` of `send_message`. Sending an unbound file binds it; sending a bound one copies the row (and shares the one file, which is never edited), so every message owns its row and deleting it deletes the row, not the file. A path is copied as the file is at that moment (a snapshot) into an attachment owned by the agent, read whole through Nas `/fs/read_bytes`. `GET /attachments/:id` returns the original file. Files are not garbage collected.

## Tools

Tools are code. `src/tools/registry.ts` lists every tool defined by a zod schema and a handler, and `src/runtime/tool-set.ts` declares the whole tool set of an agent and of the router. Every agent has the same tools; there are no grants, no usage text and no tool tables (the old `tools` and `agent_tools` tables are kept, renamed `*_retired_20261029`, for Ankur to drop). Hath has no tools for Nas host ops, device surveys, the vault or Yaad's correction history: the vault belongs to the helpers, and a history tool comes back if one is needed.

### Yaad (memory)

Every agent holds the two memory tools, so each agent reads and writes memory itself; there is no memory agent to hand facts to.

| tool | Yaad route | when to use |
| --- | --- | --- |
| `recall_memory` | `POST /recall` | anchor on a `query` (by meaning), `from` node ids, or exact filters (`kind`, `name`, `hub`, `occurred_*`, `closes_from`/`closes_to`, `relevant_on`), then walk `hops` links out; the result's `courses` says which courses were checked against their source today |
| `ingest_memory` | `POST /ingest` | store a fact, event, or scheduled meeting about Ankur's world, and every calendar write: scheduling time, moving or cancelling one session, its outcome, and its notes |

`ingest_memory` sends `source: "agent"`, `agent_id` = the calling agent, `occurred_at` stamped from the clock and `source_text`, every message Ankur wrote in the current job joined by blank lines (none in a routine), so Yaad records which agent wrote every node. A worker agent is not offered it: it reports to the agent that owns the domain, which stores what matters. Lessons about how sites, accounts, and repos behave stay in agents' transcripts, not memory.

There are no planner tools: Ankur's timeline is Yaad's plans, so agents schedule, reschedule, record outcomes and add session notes through `ingest_memory`, and read the schedule with `recall_memory` date filters.

### Helpers (browser and terminal)

Browser and terminal work is done by helpers in Nas (`nas/service/helpers`), not by agents and not by Hath: a helper is a charter and a loop on Dwar `/chat/complete` that drives one Chromium or one shell, and its tasks live in Nas as `task/browser/<id>` and `task/terminal/<id>`. Nothing in Hath drives a browser or a terminal, and no tool takes a browser or terminal id. Agents reach helpers through these tools, thin calls to Nas's Tasks API (`src/tools/helper/tasks.ts`, `src/nas/client.ts`):

| tool | Nas route | notes |
| --- | --- | --- |
| `steer_browser({id?, message})` | `POST /tasks/browser` or `POST /tasks/browser/{id}/steer` | no id starts a task; an id steers it, waking it if asleep; returns `{ id }` at once |
| `steer_terminal({id?, message, workdir?})` | `POST /tasks/terminal` or `.../{id}/steer` | the same; `workdir` is the new task's starting directory |
| `stop_task({id})` | `POST /tasks/{kind}/{id}/halt` | halts one task; a later steer revives it with its history; recorded as a `stop` activity row |
| `list_browsers` / `list_terminals` | `GET /tasks` | id, status (stopped included), owner, purpose, current page or directory, minutes idle |

A helper's report (`done`, `needs_input`, `failed`, `stopped`; a stopped one reads "Helper stopped", with "(by X)" only when Nas's report carries `stopped_by`) reaches the agent that steered it as a notice (a message from the agent to itself) that wakes it, with the answer, a `Not read: <source>: <symptom>` line for each source the helper could not read (never cut or refused), its `detail` file (any length) and the files it names as attachments (`src/runtime/helper-reports.ts`). Hath follows Nas's `GET /events` stream and reconciles from `GET /tasks` (`last_report`) on boot and after every reconnect, because the stream has no replay. A report is delivered once: the table `delivered_reports` holds, per task, the time of the newest report delivered, and a report no newer than that is skipped. Reports are compared by the time they carry, not their number, which Nas restarts from 1. A crash between a message and its mark delivers that report again. `GET /agents` reads each agent's `sessions` (the tasks it owns or last steered) from `GET /tasks` on every call.

### Files

Instant tools through Nas's `/fs` API (`src/tools/files/files.ts`); there is no terminal in the path.

| tool | notes |
| --- | --- |
| `read_file({path, offset?, limit?, pattern?})` | text, a PDF as text, an image as its Dwar description; pages by characters with `total_chars` and `next_offset`, or `pattern` for matching lines with numbers. Files over 10 MB and other binaries are refused |
| `find({name?, text?, path?})` | `name` globs file names at any depth, `text` greps contents (filtered by `name` when both are given); matching lines carry line numbers and long lines are clipped |
| `write_file({path, content})` | creates or replaces a file |
| `edit_file({path, old, new})` | exact replacement; fails and changes nothing unless `old` occurs exactly once |

A PDF is turned into text once by the box's `pdftotext -layout`, run in a terminal Nas opens for the call and closes after, into `<files.dir>/pdf/<sha1 of the PDF>.txt`; later reads use that file.

### Waiting, async tools and wake reasons

`wait({timeout_minutes})` ends the run like `yield`, with no model call, after recording a watch in `watches` (one row per agent: the agents it asked that have not replied and the helper tasks still working in its job, since, due; none is a plain sleep). The awaited helper report or message wakes the agent by itself and drops the watch; on timeout the scheduler's tick wakes it with facts (a task's status and minutes since it last did anything; an agent's minutes since its last logged activity and whether it has run since it was messaged). The agent's next real run drops any watch left. `GET /agents` shows `running.waiting_on` (`targets`, `since`, `wakes_by`).

A call whose service decides a request is too slow to wait for (`control_device`) returns `{ pending: <call id> }` at once and runs in the background; its result, or its failure, arrives as a notice that wakes the agent through the same path as a helper report (`src/runtime/rewake.ts`). Results over 4,000 characters arrive as their opening and the path of a file holding them whole. Each running call is a row in `pending_async`; a Hath restart loses the call itself, and at boot every leftover row is reported to its agent as lost so it can check and run it again. `ingest_memory` runs in the call and returns what Yaad stored (a result over 4,000 characters shows its opening and the file holding it whole); several `ingest_memory` calls in one turn go to Yaad as one request with their texts joined by blank lines, the first call carrying the result and the others pointing at it.

Every wake starts with the **wake header** (`src/runtime/header.ts`), rendered by hath with no model call: `[Wake] <reasons> · job #<n> (new | continues | routine, no requester | no requester)` or `· no job`; then `[Job #n] opened by <requester>, <time>: "<opening words>" · answer by <time>` with the job's ledger (agents asked and the seq of each answer, helper tasks steered, what was stored, what the requester was told, reminders; `src/runtime/ledger.ts`), or for a routine `[Routine "<title>"] yours · <cadence> · last run <time> (stored n, sent m)` and its procedure; then `[Your recent activity, last 24 h]`, newest first, within `activity_ceiling_share` of the prompt ceiling.

### Files on the box

Everything Hath keeps as a file lives under `[files].dir` (`/var/home/dadi/.dadi`) and is written through Nas: `attachments/<id>/<name>` (see Attachments), `results/<tool_use_id>.txt` (a tool result over 400 characters, saved whole; the wake's `[cleared]` and `[too large]` receipts name the path, and `read_file` reopens it; `read_file`, `find_files`, `yield` and `wait` results are not saved) and `pdf/` (above). `results/` and `pdf/` are caches: a daily sweep (`src/runtime/retention.ts`, run from the scheduler tick) deletes the files in them older than `[files].cache_retention_days`. `attachments/` is never swept. Nas's filesystem API has no stat or delete, so the sweep lists and removes through a Nas terminal.

### Ghar (house)

Tools over Ghar's HTTP API (`src/tools/ghar/`). 

| tool | notes |
| --- | --- |
| `get_device` | the house's devices with capabilities and state (each value with `changed_at`): all of them, or the `device_ids` given |
| `control_device` | a request in plain words; Ghar's own model loop finds the devices and runs the commands, attributed to the calling agent. Answers in the call when Ghar settles within 8 seconds, otherwise `{pending}` and the answer wakes the agent that asked |

### Devices (desktop and phone apps)

Hath keeps the reverse-RPC gateway for the apps (`DeviceGateway`): presence heartbeats at `POST /devices/presence`, commands over SSE `device_command`, results at `POST /devices/commands/:id/result`, and the router's `device_open_chat`. No agent tool reads a device now; the `device_get_*` surveys were removed and can be rebuilt on the gateway.

### Hath (meta)

| tool | notes |
| --- | --- |
| `spawn_agent` | create a child (a root when the router calls it); makes an agent a manager |
| `send_message` | `{to, content, attachments?, status?}`; `to` is `"ankur"`, `"requester"` or an agent id; `status` is `done`, `blocked` or `needs_input` (see One send path) |
| `manage_agent` | retire yourself or a direct child, or reactivate a retired direct child (immutable ids) |
| `modify_agent_prompt` | exact-match `old_string` → `new_string` edits to your own or a direct child's prompt; all apply or none (times live in routines, not prompts, by convention only) |
| `get_agent` | id, system prompt, parent and active flag for self or a direct child (any agent for the router) |
| `get_logs` | activity (`response` / `tool_result`) for self or a direct child (any named agent for the router, which never reads its own) |
| `get_messages` | message history for self or a direct child, newest first: `with` (an agent id or `ankur`), `search`, `since`, `before`, `limit` (max 100), `next_before`; the router names the agent and alone may add utterances (`include_utterances`) |
| `set_routine` | `{title, procedure, at: "HH:MM", days?: ["mon".."sun"]}`: set or change one of your own standing duties (upserts by title); no recipient field |
| `end_routine` | `{title}`: end one of your own routines |
| `list_routines` | `{agent_id?}`: an agent's routines (yours by default; reading another's is free) |
| `remind_me` | `{at, note}`: a one-shot later step of the current job; `at` is ISO 8601 with offset, in the future; fires into that same job |
| `my_activity` | `{kind?, host?, since?, agent_id?}`: what an agent did, newest first, from hath's activity record |

## Persistence

Migration `0031` made every agent one loop: `agent_logs` and `pending_async` lost their lane column (the router's log rows are the ones with a null `agent_id`), the rows the old front desk wrote moved to `agent_logs_process_backup_20261114`, and `jobs.answer_noticed_at` records that an agent was told its answer time passed.

`agents`, `agent_logs`, `wakes`, `messages`, `attachments`, `routines`, `reminders`, `jobs`, `agent_activity`, `helper_steers`, `thread_reads` (how far Ankur has read each agent's thread), `delivered_reports`, `pending_async` and `watches` survive restart. A `jobs` row is the work an agent does for one requester (null is Ankur) or for itself (`requester_id` = the agent: a routine run, or a reminder whose job is gone). hath resolves which job every message belongs to with no model call (`src/runtime/job-of.ts`): a message from the requester of an open job joins it; a reply from an agent the recipient asked in job J joins J (the ask's `messages.job_id`); a helper report joins the job its task was last steered in (`helper_steers`); a reminder, wait timeout or async result joins its job; a routine firing opens a routine job; anything else opens a job whose requester is the sender. Replies to messages sent before they carried jobs belong to none. `messages.job_id` is the recipient's job on a message from Ankur or a notice, and the sender's job on a message from an agent; `messages.sent_by` is `hath` on hath's own pickups. `agent_logs.job_id` is the wake's job. A job Ankur opens has `answer_by` (`answer_by_minutes` after his message); `stopped_at` and `stopped_by` are for a stop by Ankur (state `stopped`). `agent_activity` is what an agent did, written by hath from tool results: `site_read` (a browser helper's report: hosts, task, outcome, the start of its answer), `store` (nodes an ingest created or changed, with local closes), `recall_digest` (a recall by `relevant_on`: the tasks due that day and later), `send`, `routine` and `reminder` (set, ended, fired) and `stop`. When an agent's wake ends, every job it touched and left open, while it has no job of its own out with another agent, closes as `noop` when the wake did nothing on it; one the wake did work on stays open. Every inbound message wakes the recipient. An agent's own messages are never folded back into its wake as arrivals, and a run with nothing new since the agent last yielded makes no model call. `messages` is the source of truth for human↔agent chat and the thread the agent reads: every message of its open jobs and the newest others up to `[runtime].thread_window_share` of the prompt ceiling (see The agent loop). The start of the other messages advances in jumps of `thread_window_step_chars` so the cached prefix survives new messages; nothing is summarized, and what falls out of the window is gone from context. The thread is the agent's scratchpad: how it did a task lives there and fades; facts about Ankur live in Yaad; the prompt holds only the agent's purpose. Older turns remain in `agent_logs` / `hath_get_logs`. Each `agent_logs` row is one of: `response` — one model call's full output (`provider`, `stop_reason`, `usage`, and `content` blocks in provider order: `thinking` / `redacted_thinking`, `text`, `tool_use`), written before its tools run; `tool_result` — one tool's outcome (`tool_use_id`, `name`, `content`, `is_error`, plus audit fields such as `browser_id`; a `send_message` result carries the `message_id` it produced). Messages are never copied into the log: speech lives in `messages`, a stretch of work in `wakes`. Wakes, locks, steer/intent queues and the event stream do not survive. Single-process only — do not run replicas sharing the DB and expecting run serialization.

**Routines and reminders.** A routine (`routines`) is an agent's own standing duty: an owner, a procedure, a local time `at_local` (HH:MM, the box's zone, wall time kept across daylight saving) and `days` (null is every day). Nobody sends it. When it fires, the scheduler opens a routine job with no requester (the previous run's job is closed as done) and wakes the owner; a helper report or reminder in that job is the same routine. A reminder (`reminders`) fires into its job once and returns a done or blocked job to open; a stopped job's reminder is dropped. The scheduler ticks from `[schedule].tick_seconds` in `config.toml` (wall clock is the box's zone from the required `TZ`, which Nas writes from `/etc/localtime`). Migration `0029` creates the tables; `convertScheduledMessages` (`src/db/convert-schedules.ts`, run by `migrate`) converts the old `scheduled_messages` rows (a daily or weekly repeat becomes a routine of its recipient, titled by the first line of its text, keeping its next fire time and, when another agent set it, `set_up_by` for a one-time line in its first firing; a one-shot becomes a reminder with its author; any other interval stops the migration with the row ids) and backs the table up as `scheduled_messages_backup_20261114` before dropping it.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok", "started_at": "<iso>" }` — process identity only; not a chat epoch |
| `POST` | `/router` | Ankur → router: runs the router until it yields; returns the messages it sent |
| `GET` | `/router` | `{ "running": [{ "run_id", "at" }] }`: the router runs in flight, from the moment `POST /router` accepts one (one waiting its turn included) until it finishes or fails; empty when the router is idle |
| `POST` | `/messages` | user → agent; `attachments` stored as rows (images described via Dwar); returns them as summaries |
| `GET` | `/attachments/:id` | the original file, with its media type |
| `GET` | `/threads` | human↔agent conversation summaries (active agents only), each with `unread` (the agent's messages to Ankur after `read_seq`, notices left out) and `read_seq` (null until read) |
| `GET` | `/agents/:id/messages` | durable human-thread messages with attachment summaries (`since_seq`, `limit`) |
| `POST` | `/agents/:id/read` | `{ seq }`: Ankur has read the thread through `seq`; the mark only moves forward, `seq` past the newest message is `422`; returns `{ agent_id, read_seq, unread }` and emits SSE `thread_read` so every device clears it |
| `GET` | `/events` | SSE live events; no replay. `schedules_changed` fires when a routine or reminder is created, ended, cancelled or fired, and names no schedule: clients refetch the lists they show; `sessions_changed` fires when a helper task is steered, reports, or Nas says its task list changed (the `sessions` on `GET /agents`); `wake_started {agent_id, wake_id, reason: {kind, ref}}` and `wake_ended {agent_id, wake_id, outcome}` (`waiting`, `yielded` or `failed`) bracket a wake, and `wake_activity {agent_id, wake_id, counts: {tool_calls, messages_sent, messages_received}}` reports a running wake's counts at most once a second |
| `GET` | `/agents` | all agents + `running` (`working`: whether its run holds the lock; `waiting_on`; `job`: the ledger of the job its wake is on, or null) + `sessions` (Nas helper tasks) |
| `GET` | `/agents/:id` | agent and children |
| `POST` | `/agents/:id/stop` | Ankur's stop: ends the agent's run, halts its current job's helper tasks and marks the job `stopped` by `ankur`; returns `{ agent_id, ended_run, job, stopped_tasks, halt_failed }` |
| `GET` | `/agents/:id/logs` | per-agent activity (`response` / `tool_result` rows; `event`, `limit`) |
| `GET` | `/agents/:id/logs/:log_id` | `{ log }`: one raw log row of that agent, whole; `404 log_not_found` |
| `GET` | `/agents/:id/wakes` | `?limit` (default 20, max 100), `before_started_at` + `before_id` (keyset on `started_at, id`, given together): `{ wakes, next_before }`, newest first, `next_before` null on the last page. A wake is `{ id, agent_id, reason: {kind, ref}, opened_by (message with seq, or null), started_at, ended_at, outcome, error, usage: {calls, input_tokens, output_tokens, cache_write, cache_read}, counts: {tool_calls, messages_sent, messages_received}, activity_trimmed }`. `outcome` is derived: `running` while the wake is open, `failed` when `error` is set, `waiting` when it ended and the agent's watch began during it and still stands (so only the latest wake can be waiting), else `yielded`. `usage` sums the wake's `response` rows. `activity_trimmed`: the wake ended with no activity rows and the agent's oldest activity row is newer than its end. The cursor keeps `started_at` to the millisecond |
| `GET` | `/agents/:id/wakes/:wake_id` | `{ wake, entries }`: the wake and its timeline, `ord` from 0. An entry is a `message` (`direction` `received` when stamped with the wake, `sent` when the agent sent it between the wake's start and end and it is stamped with no other wake; `message` has its `seq`) or a `turn` (one `response` row: `usage`, `thinking`, `text`, and `calls`, each `{ id, name, input, log_id, result }` paired by `tool_use_id` with its `tool_result` row; `result` is `{ content, is_error, truncated, chars }` cut to 8,000 characters, and `log_id`/`result` are null until the result is logged). Entries sort by time; a message precedes a turn of the same millisecond. `404 wake_not_found` for an unknown wake or another agent's |
| `POST` | `/agents/:id/sessions/:task_id/halt` | `task_id` is the URL-encoded `task/<kind>/<id>`; halts a Nas task the agent owns or last steered (`haltTask`) and returns `{ task }` (the `sessions` shape, status `stopped`); emits `sessions_changed`. `404 task_not_found` (unknown, or not this agent's, or Nas 404), `409 task_conflict` (Nas 409), Nas failures stay `502 nas` |
| `GET` | `/agents/:id/sessions/:task_id/log` | `?after_seq` (default 0), `limit` (default 200, max 1000); `task_id` is the URL-encoded `task/<kind>/<id>`. Passes Nas's helper log through: `{ task, entries, next_seq }`, `next_seq` the next page's `after_seq` or null on the last. An entry is `{ seq, at, agent, type }` plus, per `type`: `steer` `{ from, message, held, start }`, `turn` `{ ms, stop_reason, usage, thinking, text, calls: [{ id, name, input }] }`, `result` `{ tool_use_id, name, is_error, chars, head, ms }`, `state` `{ status, reason }`, `report` `{ state, text, files }`; an unknown type is `502 nas`. Ownership: a task in the live `sessions` must be the agent's (owned or last steered); a forgotten task (the log outlives it) is readable only when some entry of its first page (up to 1,000) has `agent` or, on a `steer`, `from` equal to the agent. `404 task_not_found` (foreign, no log, or Nas 404), `422` (bad query or Nas `invalid_request`), Nas failures stay `502 nas` |
| `GET` | `/agents/:id/routines` | the agent's routines and reminders, next run first |
| `DELETE` | `/routines/:id` | cancel a routine as Ankur |
| `DELETE` | `/reminders/:id` | cancel a reminder as Ankur |
| `GET` | `/logs` | cross-agent audit trail |

Unknown request fields are a 422. No CORS — clients use Tauri HTTP (or equivalent) outside the browser sandbox.
