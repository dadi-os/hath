# Hath

The single client for Dadi. One codebase, two form factors — desktop and mobile. Future modules ship as pages inside Hath; nothing else in the system gets a UI.

Hath has no application-level authentication and will not get any. Reaching Dimaag or Yaad requires being a provisioned node on the tailnet, and provisioning requires physical access to the box. A login screen on top of that would be a second lock on the same door.

## Targets

Form factor is detected at runtime via `@tauri-apps/plugin-os` (`detectTarget()`). There is no `HATH_TARGET` build flag. Kiosk is not a separate target — it is the desktop build running fullscreen under `cage` on the box.

| Value | Layout | Notes |
| --- | --- | --- |
| `desktop` | Fixed chat rail, all routes | macOS, Linux, Windows |
| `mobile` | Chat is a pull-out drawer; `/agents` is not registered | iOS, Android; chat-first |

Do not detect by viewport width — a narrow desktop window is still desktop.

**Dev-only override** (active when `import.meta.env.DEV`): append `?target=mobile` or press ⌘⇧M to flip layouts on a Mac build. Not a build flag.

## Addressing

Services are reached by fixed DNS names on the tailnet — no ports, no URL env vars:

| Constant | Address |
| --- | --- |
| `YAAD` | `http://yaad.dadi` |
| `DIMAAG` | `http://dimaag.dadi` |
| `NAS` | `http://nas.dadi` |

Nas will reverse-proxy by `Host` header; Headscale serves DNS for these names pointing at the box. Every client — including Hath on the box — uses the same addresses. Plain HTTP is correct: WireGuard encrypts the mesh; terminating TLS inside it would add certificate management for no gain.

**These addresses cannot be verified until Nas exists.** There is no localhost fallback — a misconfigured proxy should fail loudly.

## Provisioning

First launch with no stored credentials shows a setup screen (chrome still visible): paste a setup code from the box.

The code is base64 of JSON:

```json
{
  "control_url": "https://headscale.example.com",
  "auth_key": "hskey-...",
  "node_name": "ankur-phone"
}
```

- `control_url` lives in the bundle because a device that has not joined the tailnet cannot resolve `.dadi` names to find Headscale.
- `node_name` is chosen during the walkthrough on the already-connected device that generates the bundle, so nodes show meaningful names in `headscale nodes list`. It is passed to tsnet as `Hostname`.
- Hostnames and ports for Yaad/Dimaag/Nas are not in the bundle — they are the constants above.

On success the credentials are stored in the app data directory (not `localStorage`) and never prompted again. On decode failure: a quiet inline message. On auth failure: Go's error text is shown (used or expired keys should say so).

QR scanning is a later, client-only change against the same payload — camera swap on the paste field, nothing more.

Generate a pre-auth key on the box:

```sh
headscale preauthkeys create --user <user> --reusable --expiration 24h
```

## Design tokens

Light futurism — bone ground, sage accent, no dark mode. Tokens live in `src/styles/tokens.css` and are mirrored into the Tailwind `@theme` in `src/styles/index.css`.

Widget surfaces use dashed sage borders and a faint sage fill (`.widget-surface`). Motion tokens start at 1s — nothing on an always-on screen should read as an alert.

Fonts are bundled under `src/assets/fonts/` (Inter + Noto Sans Gujarati). No CDN.

## Transport

Every network call goes through `Transport` (`src/api/transport.ts`). Hath always uses `TsnetTransport` — an embedded Tailscale node via Go `tsnet`. The Go side runs a local proxy on `127.0.0.1`; the app sends `X-Hath-Upstream` and Go forwards over the mesh.

Connection UX: the header shows `ONLINE` / `OFFLINE` (sage / ink-ghost) and breathes while connecting. There is no power button — tsnet is app-scoped and lives with the process. `AppShell` calls `connect()` on mount; `net_stop` runs on teardown.

Disconnected is not an error:

- **Not provisioned** — no stored credentials → setup screen (first-run, not a failure).
- **Provisioned but unreachable** — credentials exist, the box is not answering → a calm line that the box is unreachable and retrying. No red, no alert iconography, no retry button — the transport already retries.

### Accepted tsnet limits

- Only Hath gets the tunnel. SSH, curl, and browsers still need a system Tailscale client.
- Each install is its own tailnet node. Reinstall means re-provisioning.
- The tunnel dies when the app is killed. Nothing syncs in the background.

## Embedded tsnet (build)

Prerequisites: Go toolchain (`go` on `PATH`). Xcode + iOS SDK only when building `ios-arm64`.

```sh
cd net
./build.sh              # darwin-arm64 (default)
./build.sh ios-arm64
./build.sh linux-amd64
./build.sh all
```

This writes `src-tauri/lib/<target>/libhathnet.a` (+ `.h`). Those archives are gitignored — run `build.sh` before `cargo` / `npm run tauri dev`.

## API clients

- `src/api/dimaag.ts` — messages, agents, logs, events stream
- `src/api/yaad.ts` — query, recall, nodes, history

Root Dadi id: `00000000-0000-4000-8000-000000000001`.

HTTP allowlists live in `src-tauri/capabilities/default.json` (`http://*.dadi/*` plus `127.0.0.1:*` for the local tsnet proxy).

## Chrome and routes

Header + chat sidebar are persistent — they mount once. Only `<Outlet />` swaps on navigation. No tab bar, no nav rail.

Routes: `/`, `/agents`, `/memory`, `/calendar`, `/system`. Memory, calendar, and system are still placeholders. The header uptime line is a placeholder for Nas `GET /status` (Nas does not exist yet).

## Agents tree

`/agents` (desktop only) is a live `d3-hierarchy` tree of every agent row, including dormant ones. Root Dadi is always present — there is no empty state. Running agents pulse with the `--breath` ring; idle agents are solid sage; dormant agents render smaller and lower-contrast. Pruning is manual and deliberate — Hath does not auto-hide, archive, or clean up finished workers.

Structural changes (`agent_spawned`, `agent_modified`) invalidate the agents query; lane running state comes from the shared event store (seeded from `GET /agents` so a mid-run load already pulses). Node positions animate with motion (`--slow`); links redraw instantly on reflow. Node click opens a widget-surface popover (prompt, tool grants with `usage`, parent/children, recent logs). Browser session screens are a noted future addition for that popover — no browser tools exist yet.

## Chat

Chat always targets root Dadi (`00000000-0000-4000-8000-000000000001`). There is no thread spawning from the client — `spawn_agent` is a tool Dadi can call, not an HTTP route Hath can hit. One continuous conversation.

History is seeded from `GET /agents/:id/logs?event=message` (newest-first from Dimaag; reversed before render) and filtered to the user thread: messages where `from_agent_id` or `to_agent_id` is null. Live updates arrive over SSE `message` events; optimistic sends reconcile on matching content + seq.

`agent_logs` survives Dimaag restarts; the in-process transcript does not. After a restart Hath can show durable history that Dimaag no longer has in working context. That divergence is intentional — the audit trail is durable, the live context is not. Hath does not try to reconcile them.

Replies are plain text with preserved whitespace (`white-space: pre-wrap`). No markdown renderer yet — Dadi may emit markdown, but rendering it (code blocks, links, tables) is a deliberate later decision.

## Develop

```sh
cd hath
cd net && ./build.sh && cd ..
npm install
npm run tauri dev
```

On macOS the runtime target is `desktop`. With no stored credentials the provisioning screen appears. Mesh reachability itself cannot be verified until Nas exists.

Dev mobile layout: `npm run tauri dev` then open with `?target=mobile`, or press ⌘⇧M.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite only (browser; plugins need Tauri) |
| `npm run tauri dev` | Full app (requires `net/build.sh` first) |
| `npm run build` | Frontend production build |
| `npm run tauri build` | Native bundle |
| `cd net && ./build.sh` | Build libhathnet for linking |
