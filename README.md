# Hath

The single client for Dadi. One codebase, three targets — kiosk, desktop, and iOS. Future modules ship as pages inside Hath; nothing else in the system gets a UI.

This scaffold is the **frame only**: design tokens, persistent chrome, routing, and the API/transport layer. Chat rendering, the agent tree, widgets, auth, and tsnet land in later prompts.

## Targets

Set `HATH_TARGET` at build/dev time. Do not detect by viewport width.

| Value | Layout | Notes |
| --- | --- | --- |
| `kiosk` (default on the box under `cage`) | Fixed chat rail, all routes, no window chrome | Trusted by physical presence |
| `desktop` (default) | Fixed chat rail, all routes, normal window | Auth comes later |
| `mobile` | Chat is a pull-out drawer; `/agents` is not registered | Chat-first |

```sh
HATH_TARGET=kiosk npm run tauri dev
HATH_TARGET=mobile npm run tauri dev
```

## Design tokens

Light futurism — bone ground, sage accent, no dark mode. Tokens live in `src/styles/tokens.css` and are mirrored into the Tailwind `@theme` in `src/styles/index.css`.

Widget surfaces use dashed sage borders and a faint sage fill (`.widget-surface`). Motion tokens start at 1s — nothing on an always-on screen should read as an alert.

Fonts are bundled under `src/assets/fonts/` (Inter + Noto Sans Gujarati). No CDN.

## Transport seam

Every network call goes through `Transport` (`src/api/transport.ts`). The current implementation is `HttpTransport` over `@tauri-apps/plugin-http` (Rust-side HTTP, bypassing browser CORS — Dimaag sends none on purpose).

The next prompt swaps in an embedded tsnet node behind the same interface. Components talk to `dimaag` / `yaad` clients only.

Connection UX is wired now: power icon in the header toggles `connect()` / `disconnect()`, breathes while connecting, and the main region shows a calm empty state when disconnected.

## API clients

- `src/api/dimaag.ts` — messages, agents, logs, events stream
- `src/api/yaad.ts` — query, recall, nodes, history

Base URLs from env (MacBook Docker defaults shown):

```sh
DIMAAG_URL=http://localhost:8091
YAAD_URL=http://localhost:8090
```

Root Dadi id: `00000000-0000-4000-8000-000000000001`.

HTTP allowlists for those origins live in `src-tauri/capabilities/default.json` (Tauri v2 permission scopes).

## Chrome and routes

Header + chat sidebar are persistent — they mount once. Only `<Outlet />` swaps on navigation. No tab bar, no nav rail.

Routes: `/`, `/agents`, `/memory`, `/calendar`, `/system` (placeholders).

## Develop against local Docker

With Dwar, Yaad, and Dimaag up on the usual ports:

```sh
cd hath
npm install
npm run tauri dev
```

On launch Hath auto-connects. The header should show **ONLINE**, and:

```sh
curl -s http://localhost:8091/agents | jq '.agents[] | select(.id=="00000000-0000-4000-8000-000000000001")'
```

should return root Dadi. The same `GET /agents` path is what Hath uses through the transport.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite only (browser; HTTP plugin needs Tauri) |
| `npm run tauri dev` | Full app |
| `npm run build` | Frontend production build |
| `npm run tauri build` | Native bundle |
