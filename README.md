# Hath

The sole UI client for dadi. One codebase, two form factors — desktop and mobile. Future modules ship as pages inside Hath; nothing else in the system gets a UI. Hath has no application-level authentication — reaching mesh services requires a provisioned tailnet node (Tauri) or mesh-reachable browser (dev web).

## Dependencies

- Nas (`http://nas.dadi`) — provision, status, logs, module config
- Dimaag (`http://dimaag.dadi`) — agents, messages, events
- Yaad (`http://yaad.dadi`) — memory graph
- Dwar (indirect via Dimaag/Yaad)
- Embedded tsnet (Go) + Tauri shell for mesh dialing (production)

## Layout

```
hath/
  src/
    pages/                 route construction sites
    features/<domain>/     agents, memory, timeline, system, logs
    chrome/                AppShell, Header, chatSidebar/
      chatSidebar/         portable unit (index = construction site)
        list/ thread/ composer/ message/
        format.ts lanes.ts constants.ts ActivityPulse.tsx
    shared/
      api/                 transport + domain clients (dimaag/, yaad/, nas/)
        constants.ts       mesh URLs (no env fallbacks)
        transport.ts       Transport + ConnectionState
        browser-transport.ts  fetch + EventSource (web / nas compose)
        tsnet-transport.ts    embedded tsnet (Tauri; dynamic import)
        runtime.ts         isTauriRuntime / transport kind
        sse.ts / credentials.ts / types.ts
        dimaag/ yaad/ nas/ portable client modules
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
  Dockerfile               web container (dev Vite / production static)
```

## Config vs env

Mesh addresses are **constants** in `shared/api/constants.ts` — no URL env fallbacks. Runtime form factor comes from `@tauri-apps/plugin-os` inside Tauri; outside Tauri, `detectTarget` returns `desktop`. Optional `HATH_LOG_FILE` appends Rust JSON logs for Alloy (Tauri only).

Signing / release secrets live in `.env.github` for CI only — not application runtime.

## Local run

Prerequisites once: `npm install`, then `cd net && ./build.sh && cd ..` (builds `libhathnet` for the Tauri shell).

### Desktop (Tauri)

```sh
npm run tauri dev
```

### Web (Vite only)

```sh
npm run dev
# → http://localhost:8080 (or http://hath.dadi if that host resolves here)
```

Browser transport — no tsnet. Mesh services must already be reachable from the machine. Dev mobile layout: `?target=mobile` or ⌘⇧M.

### iOS (Tauri)

Xcode required. First time (generates `src-tauri/gen/apple`):

```sh
npm run tauri ios init
```

Then:

```sh
npm run tauri ios dev
```

Uses a simulator or connected device per the Tauri iOS CLI prompts.

## Dockerfile

| Target | Role |
| --- | --- |
| `dev` | Vite on `0.0.0.0:8080`; source bind-mounted by Nas with `node_modules` preserved |
| `production` | `npm run build`, then `serve` static `dist` on 8080 with SPA fallback |

```sh
docker build --target production -t hath .
```

## CI / CD

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` → `ci` | PR + push to `main` | Build tsnet archive, `npm test`, `npm run build` |
| `ci.yml` → `container` | PR + push to `main` | `docker build --target production` |
| `ci.yml` → `publish` | `main` after `container` | `ghcr.io/dadi-os/hath:latest` + sha tag |
| `ci.yml` → `release-desktop` | `main` after `ci` | AppImage / DMG / NSIS → GitHub Release `hath-<sha>` |
| `ci.yml` → `release-ios` | `main` after `ci` | TestFlight when Apple secrets present; IPA on same `hath-<sha>` release |

## Logging / error codes

Rust `logutil` emits nas-contract JSON (`time` RFC3339, `level`, `service=hath`, `msg`, optional `code`) to stdout and optional `HATH_LOG_FILE`. Frontend uses `shared/lib/platform/log.ts` for the same shape. Hath’s Log explorer queries Nas → Loki.

## Targets

| Value | Layout |
| --- | --- |
| `desktop` | Bone-glass header + chat rail + widget home / full pages |
| `mobile` | Chat-only app (sidebar + thread); no widgets or system routes |

Do not detect by viewport width. Theme follows `prefers-color-scheme` (system light/dark).

## Addressing

| Constant | Address |
| --- | --- |
| `YAAD` | `http://yaad.dadi` |
| `DIMAAG` | `http://dimaag.dadi` |
| `NAS` | `http://nas.dadi` |

Plain HTTP on the WireGuard mesh. No localhost fallback.

## Provisioning

On the box: **Add Device** (or Preferences → Devices) mints a Nas `POST /provision` setup QR. New Tauri Hath: camera scan (or paste) → Join. Credentials store in app data. Browser Hath has no provisioning.

## Transport

All network calls go through a `Transport` (`shared/api/`). Tauri loads `TsnetTransport` (dynamic import); the browser loads `BrowserTransport` (fetch + EventSource, Nas `/health` for ONLINE/OFFLINE). Header shows ONLINE/OFFLINE. Not provisioned (Tauri) → setup screen. Provisioned but unreachable → calm retry.

## Chrome and routes

**Desktop:** glass header + chat sidebar; `<Outlet />` swaps. Routes: `/`, `/agents`, `/memory`, `/timeline`, `/system`.

**Mobile:** `MobileChatShell` — conversation drawer + thread/composer. All other paths redirect to `/`.

## Agents / chat / memory

`/agents` is a live d3 hierarchy (desktop). Chat sidebar is conversation list + thread; dual-lane busy rules and provisional new-chat routing are documented in code under `chrome/chatSidebar/` and `store/chat.ts`. Memory/timeline call Yaad via `shared/api` (`yaad` client; paths live in `shared/api/yaad`).

## Design tokens

Bone glass — field bloom, frosted veil panels, sage accent; dark palette via `prefers-color-scheme`. Tokens in `src/styles/tokens.css` (same language as dadiOS). Fonts under `src/assets/fonts/`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm test` | Vitest behavior suite |
| `npm run build` | `tsc` + Vite production build (no `libhathnet` required) |
| `npm run dev` | Vite web client (`0.0.0.0:8080`, `hath.dadi` allowedHosts) |
| `npm run tauri dev` | Desktop Tauri app (requires `net/build.sh` first) |
| `npm run tauri ios init` | Generate iOS Xcode project under `src-tauri/gen/apple` |
| `npm run tauri ios dev` | iOS simulator / device (requires `ios init` + Xcode) |
| `cd net && ./build.sh` | Build libhathnet for linking |
| `npx tauri icon app-icon.png` | Regenerate desktop / iOS / Android icons from `app-icon.png` (દાદી mark) |

Hath updates outside `bootc` / `podman-auto-update` as a native binary by design; the web container is for Nas compose / CI only.
