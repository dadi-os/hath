# Hath

The single client for Dadi. One codebase, three targets — kiosk, desktop, and iOS. Future modules ship as pages inside Hath; nothing else in the system gets a UI.

## Targets

Set `HATH_TARGET` at build/dev time. Do not detect by viewport width.

| Value | Layout | Notes |
| --- | --- | --- |
| `kiosk` (default on the box under `cage`) | Fixed chat rail, all routes, no window chrome | Trusted by physical presence |
| `desktop` (default) | Fixed chat rail, all routes, normal window | Auth comes later |
| `mobile` | Chat is a pull-out drawer; `/agents` is not registered | Chat-first; always uses embedded tsnet |

```sh
HATH_TARGET=kiosk npm run tauri dev
HATH_TARGET=mobile npm run tauri dev
```

## Design tokens

Light futurism — bone ground, sage accent, no dark mode. Tokens live in `src/styles/tokens.css` and are mirrored into the Tailwind `@theme` in `src/styles/index.css`.

Widget surfaces use dashed sage borders and a faint sage fill (`.widget-surface`). Motion tokens start at 1s — nothing on an always-on screen should read as an alert.

Fonts are bundled under `src/assets/fonts/` (Inter + Noto Sans Gujarati). No CDN.

## Transport

Every network call goes through `Transport` (`src/api/transport.ts`).

- **HttpTransport** (desktop/kiosk default) — plain HTTP via `@tauri-apps/plugin-http` to local Docker URLs.
- **TsnetTransport** (mobile, or `HATH_TSNET=1`) — embedded Tailscale node via Go `tsnet`. The Go side runs a local proxy on `127.0.0.1`; the app sends `X-Hath-Upstream` and Go forwards over the mesh.

Connection UX: power icon toggles `connect()` / `disconnect()`, breathes while connecting. On first tsnet join with no stored key, the disconnected view asks for a Headscale pre-auth key (paste once).

### Accepted tsnet limits

- Only Hath gets the tunnel. SSH, curl, and browsers still need a system Tailscale client.
- Each install is its own tailnet node. Reinstall means re-authenticating.
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

### Headscale pre-auth key

```sh
headscale preauthkeys create --user <user> --reusable --expiration 24h
```

Paste the key into Hath on first connect. Control URL is fixed infra via `HATH_CONTROL_URL` (not user input).

### tsnet env

```sh
HATH_TSNET=1
HATH_CONTROL_URL=https://headscale.example.com
DIMAAG_URL=http://dimaag:8080
YAAD_URL=http://yaad:8080
```

## API clients

- `src/api/dimaag.ts` — messages, agents, logs, events stream
- `src/api/yaad.ts` — query, recall, nodes, history

Root Dadi id: `00000000-0000-4000-8000-000000000001`.

HTTP allowlists live in `src-tauri/capabilities/default.json` (includes `127.0.0.1:*` for the local tsnet proxy).

## Chrome and routes

Header + chat sidebar are persistent — they mount once. Only `<Outlet />` swaps on navigation. No tab bar, no nav rail.

Routes: `/`, `/agents`, `/memory`, `/calendar`, `/system` (placeholders).

## Chat

Chat always targets root Dadi (`00000000-0000-4000-8000-000000000001`). There is no thread spawning from the client — `spawn_agent` is a tool Dadi can call, not an HTTP route Hath can hit. One continuous conversation.

History is seeded from `GET /agents/:id/logs?event=message` (newest-first from Dimaag; reversed before render) and filtered to the user thread: messages where `from_agent_id` or `to_agent_id` is null. Live updates arrive over SSE `message` events; optimistic sends reconcile on matching content + seq.

`agent_logs` survives Dimaag restarts; the in-process transcript does not. After a restart Hath can show durable history that Dimaag no longer has in working context. That divergence is intentional — the audit trail is durable, the live context is not. Hath does not try to reconcile them.

Replies are plain text with preserved whitespace (`white-space: pre-wrap`). No markdown renderer yet — Dadi may emit markdown, but rendering it (code blocks, links, tables) is a deliberate later decision.

## Develop against local Docker

With Dwar, Yaad, and Dimaag up on the usual ports (no tsnet needed):

```sh
cd hath
cd net && ./build.sh && cd ..
npm install
npm run tauri dev
```

On launch Hath auto-connects. The header should show **ONLINE**, and:

```sh
curl -s http://localhost:8091/agents | jq '.agents[] | select(.id=="00000000-0000-4000-8000-000000000001")'
```

should return root Dadi.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite only (browser; HTTP plugin needs Tauri) |
| `npm run tauri dev` | Full app (requires `net/build.sh` first) |
| `npm run build` | Frontend production build |
| `npm run tauri build` | Native bundle |
| `cd net && ./build.sh` | Build libhathnet for linking |
