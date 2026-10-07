# Hath

Agent runtime for dadi. It owns agent identity, transcripts, the dual-lane loop, inter-agent messaging, and the audit log. Every model call goes to Dwar. Hath never talks to a provider. Unauthenticated; private mesh only.

## Dependencies

- Postgres (`DATABASE_URL`)
- Dwar at `http://dwar.dadi` for chat and image describe
- Yaad at `http://yaad.dadi` for memory tools
- Ghar at `http://ghar.dadi` for home device tools
- Chaavi at `http://chaavi.dadi` for vault tools (`chaavi_*`); secrets and passkey keys are never returned to the model
- Nas at `http://nas.dadi` for host terminals, project filesystem, and headed Chromium browsers (also mesh DNS / logging)
- `playwright-core` (no browser download — Chromium comes from Nas over CDP)

## Layout

```
hath/
  src/
    app.ts, config.ts, logging.ts, errors.ts, constants.ts
    db/           Drizzle, migrate, messages, attachments, agent logs
    dwar/         Dwar axios client
    yaad/         Yaad axios client
    ghar/         Ghar axios client
    chaavi/       Chaavi axios client (vault metadata + inject)
    nas/          Nas axios client (terminals + filesystem + browsers)
    browser/      Playwright CDP driver for Nas Chromium
    runtime/      dual-lane engine, transcript cache, attachments, events, locks
    tools/        grantable tool registry (hath + yaad + ghar + chaavi + nas + browser)
    routers/      HTTP routes + schemas
    types/        domain types
  test/
  drizzle/
  prompts/
  config.toml
```

## Config vs env

`config.toml` (checked in): lane queue timeout, wake tool-result clearing budget, Dwar/Yaad/Ghar/Chaavi/Nas timeout and retry, browser action/navigation/snapshot limits and the click settle window.

Topology is hardcoded in `src/constants.ts`.

`DATABASE_URL` is required at startup (no empty default). Nas injects it in compose and on the appliance (`postgres://hath:hath@hath-postgres:5432/hath`). There is no Hath `.env` — Postgres is not Preferences-editable; `.env.example` documents the variables. `TZ` is required too and must be an IANA zone: it is the box's time zone, which Nas writes to `/var/lib/dadi/timezone.env` from `/etc/localtime` on every boot and the container loads with `EnvironmentFile=`; compose requires it in the shell.

## Local run

```sh
cd ../nas
docker compose up hath hath-postgres
docker compose run --rm hath npm run db:migrate
docker compose run --rm hath npm test
```

Migrations run schema SQL and sync the tool registry. They do not grant tools. The router is `POST /router`, not an agents row.

## CI / CD

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` → `ci` | PR + push to `main` | Postgres service, migrate, `npm test`, build images |
| `ci.yml` → `publish` | `main` after `ci` | Push `ghcr.io/<owner>/hath:{latest,sha}` |

## Logging / error codes

Logs follow the nas JSON contract (`service=hath`, request summary, `code` on errors). Default Fastify access logging is off.

HTTP errors: `{ "error": { "type": "<code>", "message": "..." } }`. Shared codes include `invalid_request`, `not_found`, `upstream_unreachable`, `internal_error`. Domain codes include `dwar`, `yaad`, `ghar`, `chaavi`, `vault_unconfigured`, `vault_unreachable`, `nas`, `conflict`, `stale_ref`, `retired`. See nas README for the shared catalog (`busy`, `forbidden`, `binary_file`, …).

## Agents

Every `agents` row is an agent. The router is not a row — it is `POST /router`. Agent primary keys are immutable lowercase kebab-case ids (`browser-manager`); there is no separate name column. API responses still expose `name` as an alias of `id` for desktop/roster compat. Root agents have `parent_agent_id` null: they are the router's children. Nested workers point at a real parent. `GET /agents` includes ephemeral `running` (lane locks) and `sessions` (Nas browsers and terminals the agent recently drove). Spawn/list do not attach; worker tools that take `browser_id` or `terminal_id` do. Both maps die with the process.

## Router

`POST /router` is Dadi's translator: Ankur says what he wants, and the router picks the owner, writes the message he would send, and sends it as him; his app opens that thread when the agent answers. It is not an agent and not a conversation. The router is the null identity — the same as the user — so every message it sends lands in an agent's thread as `from_agent_id` null, written as Ankur. The router is ephemeral: it has no transcript and carries nothing between runs. Each request:

1. Stages its attachments unbound and appends an `[Attachment …]` stub per file to the utterance, then writes an audit row (`agent_logs`, router lane, `message` / `receive`) holding it. The utterance is not stored as a message; staged files the router did not forward are deleted when the run ends.
2. Runs the router lane: the same step loop as agent lanes, calling Dwar `POST /chat/complete` (context-free on Dwar's side). System is `prompts/system.md` + `prompts/router.md` + identity + the active root agents; messages are exactly one turn, this utterance (headed `[From: Ankur]`) — no earlier run, nothing sent as Ankur, no reply to him, and nothing that arrives mid-run. What is underway it finds with its tools. Nothing in code caps the loop; it ends when the model calls `yield`.
3. Returns `201 { messages: [{ to_agent_id, content, attachments, seq, created_at }] }` — every message it sent or forwarded, in order (may be empty).

Router tools (hardcoded, not grants): `send_message` (deliver as Ankur; a retired recipient is a `retired` error), `forward_attachment` (deliver attachments by id as Ankur), `read_attachment`, `list_agents`, `recall_memory`, `hath_spawn_agent` (creates a root), and the embedded agent-management tools — `grant_tool` / `revoke_tool` on root agents only, `get_agent` / `get_logs` on any agent, `list_tools`. It cannot modify agents: agents reshape themselves. Its model turns and tool results log to `agent_logs` with a null `agent_id` on the `router` lane. The router's `get_logs` must name an agent; only the user (CLI, no `agent_id`) reads the null identity's rows — the router's turns plus every message sent by or to Ankur. Runs are serialized.

SSE: `router_started` / `router_finished` / `router_failed`. After a route, each thread's `lane_*` and `message` events take over.

## The user is null

No user table. Human messages use `from_agent_id = null` / `to_agent_id = null`; the router shares that identity.

## Dual lanes

Every agent has both lanes. **Reasoning** is the executor (tool-calling against `agent_tools` plus embedded `send_message` / `read_attachment` / `create_attachment` / `list_agents` / `wait` / `recall_memory` / `ingest_memory` / `manage_agent` / `modify_agent_prompt` / `get_agent` / `grant_tool` / `revoke_tool` / `list_tools` / `get_logs` / `yield`). **Conversation** is the control surface (`dispatch_message`, `forward_attachment`, `read_attachment`, `steer_reasoning`, `list_agents`, `yield`). Speech is only via those message tools — model text is thought, never speech. Reasoning calls Dwar with `tool_choice: "auto"`, so the model can think and write before, alongside, or instead of a tool call; a turn with no tool call continues the lane (a `[continue]` user turn follows it, saying the text reached no one), and a turn ends only on `yield`. Conversation calls with `tool_choice: "any"`: its only outputs are dispatch, steer and yield, and left free it writes replies as plain text that reach no one and never end the lane. `list_agents` looks up kebab-case ids (or lists the roster); it is not grantable. Assembled transcripts stamp each turn `[From: …]` / `[To: …]` (Ankur or an agent id) so multi-party threads stay attributable.

Transcript is in-process and shared. Conversation starts on inbound message, reasoning finish, or `send_message`. `steer_reasoning` queues instructions for the next reasoning step.

Both lanes share one **wake** per agent (`src/runtime/wake.ts`). It starts from the system and transcript frozen at the wake's first call (so `modify_agent_prompt` and new children reach an agent's system at its next wake), then records every step either lane takes, whole and in order: the model turn (thinking, text and tool calls, tagged with the provider and lane that produced it) followed by its tool results, plus messages that arrive mid-wake as one `[Arrived during this wake]` turn. Turns are never dropped and there is no step limit, but old tool results are: once the results still shown in full pass `[runtime].wake_tool_results_max_chars`, every result older than the newest `wake_tool_results_kept_chars` reads as a short `[cleared]` note for the rest of the wake. Each lane sends the whole wake on every call, so conversation sees reasoning's thinking, calls and results (and the reverse); Dwar replays each provider's own turns verbatim and translates the other lane's. Two kinds of turn are private to one lane: steers (reasoning only) and send_message intents (conversation only). A wake lasts while any lane run for the agent is queued or running; when the last one finishes it is dropped, and the next wake starts from the transcript alone. A conversation run that finds nothing new it can see since that lane last yielded in this wake ends without a model call, so wake-ups queued behind a run that already handled them cost nothing. Apart from that one-way cut, which moves in one jump, earlier turns never change mid-wake — Dwar caches the history prefix, so a byte-stable history is what keeps long wakes cheap. The transcript's last turn is sent with `cache_breakpoint`, so the next wake reads the shared transcript from cache instead of rewriting it. A lane run that throws (either lane) is reported to the agent's parent (Ankur for a root agent) as a `[runtime]` message, which also wakes the parent; tool errors never fail a lane, they come back to the model as tool results. A queued lane run waits for its lane without a deadline. Lane state is in memory, so a restart ends every running wake: at boot Hath reads `agent_logs` since each active agent's last runtime report (the `runtime_report` payload key), wakes an agent that had only a message waiting, and has an agent caught mid-wake report to its parent with its last step instead of replaying it.

`manage_agent` with `retired: true` retires an agent (`active` false): it does not run, and `POST /messages`, `send_message`, `dispatch_message`, `schedule_message` and the router's send to it fail with `409 retired`. Only its parent can change it again, and only by reactivating it with `retired: false`, which brings it back with its prompt, tools and history. `list_agents` leaves retired agents out unless `show_retired` is true.

Every Dwar call sends `X-Dadi-Caller` (`hath/<agent id>`, `hath/router`, `hath/attachments`) so Dwar's inference log attributes tokens; `response` logs carry the full usage including cache reads and writes.

Every system prompt starts with the shared system doctrine (`prompts/system.md`), then the charter (the agent's stored prompt), its identity, and its active children. Assembled context always includes a lane block (conversation manages reasoning via `steer_reasoning`, including `terminate` to halt the next tool call; conversation must not claim grants are missing) and an identity/routing block: agent id, parent (or root), point-of-contact messaging for the job, and grant escalation to the parent when the agent is a child. This is prompt guidance only — `send_message` / `dispatch_message` do not enforce it.

## Attachments

Files are rows in `attachments`, each bound to the message that carries it (`message_id`) or unbound until one does. Text files (`text/*` and a few textual `application/*` types, strict UTF-8) keep their text in `text_content`; images keep their bytes plus a Dwar `/image/describe` description; other files keep their bytes. One file is at most 10 MB, one message carries at most 8. A message delivers once, however many files it carries.

Transcripts never hold file contents. Each file renders under its message as an `[Attachment <id> · name · type · size]` block: text up to 8,000 characters in full, longer text as a 500-character preview, an image as its description. Agents read text in pages with `read_attachment` (`offset`/`limit` in characters, `next_offset` null at the end) and pass files on by id: conversation's `forward_attachment`, or reasoning's `send_message` `attachment_ids`, which conversation forwards. Sending an unbound file binds it; sending a bound one copies the row, so every message owns its files and deleting it deletes them. `create_attachment` turns a host text file into an unbound attachment owned by the agent (needs the `terminal_read_file` grant; Nas `/fs/read`, line prefixes stripped). `GET /attachments/:id` returns the original file.

## Tools

`src/tools/` is the source of truth; `tools` table is a projection synced at migrate. Grants are parent-to-direct-child only.

### Yaad (memory)

Every reasoning lane holds the two memory tools without a grant, so each agent reads and writes memory itself; there is no memory agent to hand facts to.

| embedded tool | Yaad route | when to use |
| --- | --- | --- |
| `recall_memory` | `POST /recall` | anchor on a `query` (by meaning), `from` node ids, or exact filters (`kind`, `name`, date window, `status`), then walk `hops` links out; `{ from: [id], hops: 1 }` is a node with its neighbors |
| `ingest_memory` | `POST /ingest` | store a fact, event, or scheduled meeting about Ankur's world |

`ingest_memory` sends `source: "agent"`, `agent_id` = the calling agent, and `occurred_at` stamped from the clock, so Yaad records which agent wrote every node. Agents store their lessons about Ankur's sites, accounts, and repos there too, so every agent can recall them.

| grantable tool | Yaad route | when to use |
| --- | --- | --- |
| `yaad_get_node_history` | `GET /nodes/:id/history` | correction log for one node |
| `yaad_search_history` | `POST /history/search` | semantic search over corrections |

### Chaavi (vault)

Grantable vault tools. Metadata may reach the model; passwords, passkey keys, and secret values never do.

| tool | Chaavi route | when to use |
| --- | --- | --- |
| `chaavi_list_items` | `GET /v1/items` | find a vault item id by name or site uri (`hasPasskey`, no secrets) |
| `chaavi_create_login` | `POST /v1/logins` | create a login with a generated password; never invent or `browser_type` a password |
| `chaavi_fill_login` | `POST /v1/items/:id/login` | type a login into a Nas browser; never `browser_type` a password |
| `chaavi_fill_passkey` | `POST /v1/items/:id/passkey` | load a passkey into the tab's Nas browser virtual authenticator, replacing its previous passkey; call before the site asks for it |
| `chaavi_fill_secret` | `POST /v1/items/:id/secret` | run a host command with the secret in `env_name`; output is redacted |

### Terminal (shell + files)

Thin clients over Nas. Shell is the run-a-command mechanism; file tools are the file-manipulation mechanism — no file IO through the shell by design. Terminal ids are handed off by the spawning agent (prompt or message); Hath does not enforce ownership.

| tool | holder | Nas route |
| --- | --- | --- |
| `terminal_spawn` | manager | `POST /terminals`. Optional `terminal_id` starts that session name; omit it for the lowest unused name. A new shell either way. |
| `terminal_list` | manager | `GET /terminals` |
| `terminal_close` | manager | `DELETE /terminals/{id}` |
| `terminal_execute_shell` | worker | `POST /terminals/{id}/exec` |
| `terminal_read` | worker | `GET /terminals/{id}/capture` |
| `terminal_send_keys` | worker | `POST /terminals/{id}/keys` |
| `terminal_read_file` | worker | `POST /fs/read` |
| `terminal_write_file` | worker | `POST /fs/write` |
| `terminal_edit_file` | worker | `POST /fs/edit` |
| `terminal_glob` | worker | `POST /fs/glob` |
| `terminal_grep` | worker | `POST /fs/grep` |

`terminal_execute_shell` HTTP timeout is `timeout_seconds + 10` so the client never gives up before Nas reports a shell timeout. On timeout the command keeps running — use `terminal_read` / `terminal_send_keys` (e.g. `C-c`) to follow up.

File tools take absolute host paths. Nas **denies writes** to OS and dadiOS runtime trees (`/usr`, `/etc`, `$DADI_STATE_DIR/modules`, …); reads are allowed. There is no project sandbox folder. Default terminal/glob/grep cwd is the Nas state dir (dadi home).

### Browser

Each worker drives one Nas Chromium over CDP (`playwright-core` `connectOverCDP`). Playwright resets Chromium's download behavior on connect, so every connection points downloads at the browser's Nas `downloads_dir` (the dadi home's `Downloads`) under their own file names. Act on accessibility refs, not coordinates. `tab_id` is the CDP target id; omit it to use the focused/attached page. Refs from `browser_accessibility_tree` (`e1`, `e2`, …) are valid only until the next snapshot. Screenshots go through Dwar `/image/describe` — pixels never enter the transcript; the raw image is kept in tool `audit` only.

| tool | holder | notes |
| --- | --- | --- |
| `browser_spawn` | manager | Nas `POST /browsers` → `{ browser_id, cdp_url }`. Optional `browser_id` reopens that profile; omit it for the lowest id with no saved Chromium data. |
| `browser_list` | manager | Nas `GET /browsers` |
| `browser_close` | manager | Nas `DELETE` + drop in-process CDP connection |
| `browser_list_tabs` / `browser_new_tab` / `browser_close_tab` | worker | CDP target ids |
| `browser_navigate` | worker | waits for `load`; returns `{ url, title }`, or with `read: "tree" \| "text"` the title plus the page as `browser_accessibility_tree` / `browser_extract_text` return it |
| `browser_accessibility_tree` | worker | bounded tree + refs across every visible frame and open shadow root (child frames under a `frame "url"` line); links, buttons, form fields, ARIA controls (checkbox, radio, tab, menuitem, option, textbox, …) and editable regions get refs, marked `disabled` / `checked` / `selected`; truncated flag |
| `browser_click` / `browser_type` / `browser_select` | worker | by ref in any frame; `stale_ref` if missing/ambiguous; click fails fast with `disabled` on a disabled element; click with `read` waits for a navigation it starts to load, or `[browser].click_settle_ms` for an in-place redraw, then returns the page too |
| `browser_press_key` | worker | Playwright key or chord (`Escape`, `Control+Enter`, `l`) on a ref or the focused element |
| `browser_wait_for` | worker | text, ref, and/or network_idle |
| `browser_upload_file` | worker | absolute host `paths` onto a file input or the chooser a ref opens; CDP `DOM.setFileInputFiles` so Chromium reads the host file itself; returns attached names + sizes |
| `browser_screenshot` | worker | `page` (Playwright) or `display` (Nas monitor) → Dwar describe |
| `browser_extract_text` | worker | visible body text, bounded |


### Nas (control plane)

Host ops via Nas HTTP. System logs are Loki (`nas_get_logs`); agent cognition is `get_logs`.

| tool | Nas route |
| --- | --- |
| `nas_get_status` | `GET /status` |
| `nas_get_logs` | `GET /logs` |
| `nas_restart_module` | `POST /modules/{name}/restart` |
| `nas_pull_updates` | `POST /pull_updates` (202, runs in background) |
| `nas_get_update_status` | `GET /pull_updates` |
| `nas_stack_up` | `POST /stack/up` |
| `nas_stack_down` | `POST /stack/down` |
| `nas_provision` | `POST /provision` |
| `nas_list_clients` | `GET /clients` |

### Devices (desktop and phone apps)

Read-only surveys over every enrolled device: each call lists every mesh client from `nas_list_clients` except the box (`os`) with `online`, `last_seen` and `app_running` (a `POST /devices/presence` heartbeat within 45s), and asks only devices with the app running, in parallel, over SSE `device_command` + `POST /devices/commands/:id/result`. Returns `{ devices: [{ node_name, online, last_seen, app_running, result | error }] }`; nothing is pushed to devices.

| tool | notes |
| --- | --- |
| `device_get_info` | platform, OS/app version, timezone |
| `device_get_battery` | percent + charging |
| `device_get_location` | lat/lng/accuracy/timestamp + address when available |
| `device_get_network` | mesh + connection type |

### Hath (meta)

Grantable (a job, not a general rule):

| tool | notes |
| --- | --- |
| `hath_spawn_agent` | create a child (a root when the router calls it); makes an agent a manager |

Embedded in every reasoning lane (never granted, never in the tools table):

| tool | notes |
| --- | --- |
| `manage_agent` | retire yourself or a direct child, or reactivate a retired direct child (immutable ids) |
| `modify_agent_prompt` | exact-match `old_string` → `new_string` edits to your own or a direct child's prompt; all apply or none |
| `grant_tool` / `revoke_tool` | manage a direct child's grants (`grant_tool` takes a list of `{tool_name, usage}`); the router's children are the roots |
| `list_tools` | grantable registry catalog (name + description); optional prefix filter |
| `get_agent` | id, system prompt, parent, active flag, and tool names for self or a direct child (any agent for the router) |
| `get_logs` | audit (`response` / `tool_result` / `message`) for self or a direct child (any named agent for the router, which never reads its own) |
| `schedule_message` / `list_schedules` / `cancel_schedule` | durable schedules sent from and owned by the caller, so every agent automates its own work; not the router's |

## CLI

The host `dadi` CLI lives in Nas (`service/cmd/dadi`, `/usr/bin/dadi` on the appliance). It invokes this registry over HTTP (`GET /tools`, `POST /tools/:name/execute`). Requires `HATH_URL` (no default). Execute runs as the user unless a caller identity is given: `--as-agent <kebab-id>` or `--as-router`. Agent callers must be active and hold a grant for the tool. `as_agent_id: "router"` is limited to the router's tools (`hath_spawn_agent`, `grant_tool`, `revoke_tool`, `get_agent`, `get_logs`, `list_tools`). Embedded tools can be executed by name too; agents need no grant for them. Omitting `as_agent_id` runs as the user: any tool, no grant or active check (human / ops).

## Persistence

`agents`, `agent_logs`, `messages`, `attachments`, and `scheduled_messages` survive restart. `messages` is the source of truth for human↔agent chat and the rolling lane transcript (at least the last `[runtime].transcript_window_messages` turns, default 40; the window's start advances in steps of `transcript_window_step_messages` so the cached prefix survives new messages). Older turns remain in `agent_logs` / `hath_get_logs`. Each `agent_logs` row is one of: `response` — one model call's full output (`provider`, `stop_reason`, `usage`, and `content` blocks in provider order: `thinking` / `redacted_thinking`, `text`, `tool_use`), written before its tools run; `tool_result` — one tool's outcome (`tool_use_id`, `name`, `content`, `is_error`, plus audit fields such as `browser_id`); `message` — a delivered message. Wakes, locks, steer/intent queues, host `sessions`, and the event stream do not survive. Single-process only — do not run replicas sharing the DB and expecting lane serialization.

Schedule tools (`schedule_message`, `list_schedules`, `cancel_schedule`) persist one-shot and recurring deliveries; the in-process scheduler ticks from `[schedule].tick_seconds` in `config.toml` (wall clock is the box's zone from the required `TZ`, which Nas writes from `/etc/localtime`).

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok", "started_at": "<iso>" }` — process identity only; not a chat epoch |
| `POST` | `/router` | Ankur → router: runs the router lane until it yields; returns the messages it sent |
| `POST` | `/messages` | user → agent; `attachments` stored as rows (images described via Dwar); returns them as summaries |
| `GET` | `/attachments/:id` | the original file, with its media type |
| `GET` | `/threads` | human↔agent conversation summaries (active agents only) |
| `GET` | `/agents/:id/messages` | durable human-thread messages with attachment summaries (`since_seq`, `limit`) |
| `GET` | `/events` | SSE live events; no replay |
| `GET` | `/agents` | all agents + `running` + `sessions` |
| `GET` | `/agents/:id` | agent, children, grants |
| `GET` | `/agents/:id/logs` | per-agent audit trail |
| `GET` | `/agents/:id/schedules` | every schedule the agent sends or receives, next run first |
| `PATCH` | `/schedules/:id` | hand edit as Ankur: any of `run_at` (future, with offset), `interval_minutes` (null for one-shot), `content` |
| `DELETE` | `/schedules/:id` | cancel a schedule as Ankur |
| `GET` | `/logs` | cross-agent audit trail |
| `GET` | `/tools` | grantable tool catalog |
| `GET` | `/tools/:name` | one tool schema |
| `POST` | `/tools/:name/execute` | run tool as `as_agent_id` (kebab-case id or `"router"`; omitted = user) |

Unknown request fields are a 422. No CORS — clients use Tauri HTTP (or equivalent) outside the browser sandbox.
