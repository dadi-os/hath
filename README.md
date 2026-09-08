# Hath

The sole UI client for dadi. One codebase, two form factors — desktop and mobile. Future modules ship as pages inside Hath; nothing else in the system gets a UI. Hath has no application-level authentication — reaching mesh services requires a provisioned tailnet node.

## Dependencies

- Nas (`http://nas.dadi`) — provision, status, logs, module config
- Dimaag (`http://dimaag.dadi`) — agents, messages, events
- Yaad (`http://yaad.dadi`) — memory graph
- Dwar (indirect via Dimaag/Yaad)
- Embedded tsnet (Go) + Tauri shell for mesh dialing

## Layout

```
hath/
  src/
    pages/                 route construction sites
    features/<domain>/     agents, memory, timeline, system, logs
    chrome/                AppShell, Header, chatSidebar/
    shared/
      api/                 transport, dimaag/yaad/nas clients, constants
      lib/
        platform/          logging helpers
        content/           attachments
        ux/                motion, poll intervals
      components/          IconButton, Popover, Tooltip, WidgetFrame
    store/                 chat, connection, running
    hooks/
    styles/
  src-tauri/               Rust shell + logutil
  net/                     Go tsnet archive build
```

## Config vs env

Mesh addresses are **constants** in `shared/api/constants.ts` — no URL env fallbacks. Runtime form factor comes from `@tauri-apps/plugin-os`. Optional `HATH_LOG_FILE` (set by nas `./up`) appends Rust JSON logs for Alloy.

Signing / release secrets live in `.env.github` for CI only — not application runtime.

## Local run

```sh
cd net && ./build.sh && cd ..
npm install
npm test
npm run tauri dev
```

Dev mobile layout: `?target=mobile` or ⌘⇧M when `import.meta.env.DEV`.

## CI / CD

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` → `ci` | PR + push to `main` | Build tsnet archive, `npm test`, `npm run build` |
| `ci.yml` → `release-desktop` | `main` after `ci` | AppImage / DMG / NSIS → GitHub Release `v{version}` |
| `ci.yml` → `release-ios` | `main` after `ci` | TestFlight when Apple secrets present |

## Logging / error codes

Rust `logutil` emits nas-contract JSON (`time` RFC3339, `level`, `service=hath`, `msg`, optional `code`) to stdout and optional `HATH_LOG_FILE`. Frontend uses `shared/lib/platform/log.ts` for the same shape. Hath’s Log explorer queries Nas → Loki.

## Targets

| Value | Layout |
| --- | --- |
| `desktop` | Fixed chat rail, all routes |
| `mobile` | Chat drawer; `/agents` not registered |

Do not detect by viewport width.

## Addressing

| Constant | Address |
| --- | --- |
| `YAAD` | `http://yaad.dadi` |
| `DIMAAG` | `http://dimaag.dadi` |
| `NAS` | `http://nas.dadi` |

Plain HTTP on the WireGuard mesh. No localhost fallback.

## Provisioning

Connected device: System → DEVICES → create setup code (Nas `POST /provision`). New install: scan/paste bundle → Join. Credentials store in app data directory.

## Transport

All network calls go through `TsnetTransport` (`shared/api/`). Header shows ONLINE/OFFLINE. Not provisioned → setup screen. Provisioned but unreachable → calm retry (transport reconnects without throwing on the auto-retry path).

## Chrome and routes

Header + chat sidebar mount once; `<Outlet />` swaps. Routes: `/`, `/agents`, `/memory`, `/calendar`, `/system`.

## Agents / chat / memory

`/agents` is a live d3 hierarchy (desktop). Chat sidebar is conversation list + thread; dual-lane busy rules and provisional new-chat routing are documented in code under `chrome/chatSidebar/` and `store/chat.ts`. Memory/timeline call Yaad via `shared/api/yaad`.

## Design tokens

Light futurism — bone ground, sage accent. Tokens in `src/styles/tokens.css`. Fonts bundled under `src/assets/fonts/`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm test` | Vitest behavior suite |
| `npm run build` | `tsc` + Vite production build |
| `npm run tauri dev` | Full app (requires `net/build.sh` first) |
| `cd net && ./build.sh` | Build libhathnet for linking |

Hath updates outside `bootc` / `podman-auto-update` as a native binary by design.
