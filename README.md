# Hath

The sole UI client for dadi. One codebase, two form factors — desktop and mobile. Future modules ship as pages inside Hath; nothing else in the system gets a UI. Hath has no application-level authentication — reaching mesh services requires a provisioned tailnet node (Tauri) or mesh-reachable browser (dev web).

## Dependencies

- Nas (`http://nas.dadi`) — provision, status, logs, module config
- Dimaag (`http://dimaag.dadi`) — agents, messages, events
- Yaad (`http://yaad.dadi`) — memory graph
- Dwar (indirect via Dimaag/Yaad)
- dadiMesh (desktop: system `tailscaled` TUN + MagicDNS; iOS: Go tsnet dialer + Network Extension)

## Layout

```
hath/
  src/
    pages/                 route construction sites
    features/<domain>/     agents, memory, timeline, system, logs
      agents/              tree, popover, host-session peek (browser frame + terminal chip)
    chrome/                AppShell, Header, chatSidebar/
      chatSidebar/         portable unit (index = construction site)
        list/ thread/ composer/ message/
        format.ts lanes.ts constants.ts ActivityPulse.tsx
    shared/
      api/                 transport + domain clients (dimaag/, yaad/, nas/)
        constants.ts       mesh URLs (no env fallbacks)
        transport.ts       Transport + ConnectionState
        browser-transport.ts  fetch + EventSource (web / nas compose)
        tsnet-transport.ts    MeshTransport / dadiMesh (Tauri; dynamic import)
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
  src-tauri/               Rust shell + logutil + dadimesh-extension/
  net/                     Go dadiMesh (tsnet) archive build
  Dockerfile               web container (dev Vite / production static)
```

## Config vs env

Mesh addresses are **constants** in `shared/api/constants.ts` — no URL env fallbacks. Runtime form factor comes from `@tauri-apps/plugin-os` inside Tauri; outside Tauri, `detectTarget` returns `desktop`. Optional `HATH_LOG_FILE` appends Rust JSON logs for Alloy (Tauri only).

Signing / release secrets live in `.env.github` for CI only — not application runtime.

## Local run

Prerequisites once: `npm install`, then `cd net && ./build-tailscale.sh && cd ..` (desktop). For iOS builds also `cd net && ./build.sh ios-arm64`.

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
| `ci.yml` → `release-desktop` | `main` after `ci` | AppImage / DMG / NSIS (+ macOS `.app.tar.gz` for updater) → GitHub Release `hath-<sha>`; SemVer `0.0.<run_number>` |
| `ci.yml` → `release-updater-manifest` | `main` after any successful `release-desktop` leg | `latest.json` for platforms that uploaded this run (omit missing OS; `.sig` files stay off the release) |
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

On the box: **Add Device** (or Preferences → Devices) mints a Nas `POST /provision` setup QR. The bundle embeds the **control plane URL** from Preferences → Tunnel (not hardcoded in Hath). New Tauri Hath: camera scan (or paste) → join dadiMesh. Credentials store in app data. Browser Hath has no provisioning.

## Transport / dadiMesh

All network calls go through a `Transport` (`shared/api/`). Tauri loads `MeshTransport` (dynamic import); the browser loads `BrowserTransport` (fetch + EventSource, Nas `/health` for ONLINE/OFFLINE). Browser Hath is for Nas compose on-box UI only — it does not join Headscale.

Lifecycle (Tauri):

- Unprovisioned → onboarding (scan/paste)
- Provisioned + mesh down → glassy power overlay (tap to join); no silent auto-start
- Connected → app UI; chrome power control leaves the mesh
- **Desktop:** power on starts bundled `tailscaled` (TUN + MagicDNS `--accept-dns`) against the provisioned Headscale control URL — same model as the Nas host node `os`. Hath talks to `http://*.dadi` directly. Terminal can `ssh user@os.dadi` while joined. macOS prompts once for admin (osascript); Linux uses `pkexec`/`sudo`; Windows elevates via UAC for Wintun.
- **iOS:** in-process tsnet dialer + Network Extension profile (`dadiMesh` in Settings → VPN) with L3 CGNAT routes + MagicDNS (and optional HTTP proxy while the dialer port is non-zero)
- Leave → `tailscale down` / dialer stop; mesh names stop resolving

Header shows ONLINE / JOINING… / OFFLINE.

### Phase 1 success check (desktop)

**macOS / Windows / Linux** (same power button → `tailscaled` TUN):

1. Fresh Hath → provision → power on (approve admin / UAC / polkit once if prompted).
2. MagicDNS works: `ping os.dadi` (or `ping os.dadi` from PowerShell / `Get-Command` DNS resolve).
3. `ssh user@os.dadi` from a terminal while Hath is joined.
4. Hath header ONLINE against mesh services; power off → SSH to `os.dadi` fails again.

**Windows notes:** CI bundles `tailscale.exe`, `tailscaled.exe`, and `wintun.dll`. First join triggers UAC so Wintun can create the adapter.

**macOS Settings → VPN:** Phase 1 may **not** list dadiMesh (open-source `tailscaled`/utun often does not). That Settings profile is Phase 2 Network Extension work and needs Apple Developer signing — same class of hard fail as the ungated iOS release job when secrets are missing.

### Desktop system mesh binaries

```sh
cd net && ./build-tailscale.sh          # host platform → src-tauri/bin/<target>/
cd net && ./build-tailscale.sh all      # all desktop targets (CI)
```

Pin is `TS_VER` (default `v1.82.0`, aligned with `net/go.mod`). Required before `tauri build` / `tauri dev` on desktop.

Phase 2 (Apple Settings → VPN as a first-class System/Network Extension that owns WireGuard, plus iOS L3 packet path) uses sources under `src-tauri/dadimesh-extension/` (`PacketTunnelProvider.swift`, `Info-macos.plist`, `Info-ios.plist`, `dadimesh.entitlements`). Wire the Xcode NE target as below; until the extension embeds the crypto stack, desktop TUN from `tailscaled` is what carries SSH. Desktop `mesh_start` may register the VPN preference but does **not** start the NE tunnel on top of sysmesh.

### iOS / macOS Network Extension

Sources live under `src-tauri/dadimesh-extension/` (Packet Tunnel Provider with L3 CGNAT routes + MagicDNS + optional HTTP proxy). After `npm run tauri ios init` (or adding a macOS NE target):

1. Open `src-tauri/gen/apple/hath.xcodeproj`.
2. **File → New → Target → Network Extension → Packet Tunnel Provider** — Product Name `dadimesh`, Bundle ID `com.dadi.hath.dadimesh`.
3. Replace the generated Swift provider with `PacketTunnelProvider.swift`; use `Info-macos.plist` / `Info-ios.plist` / `dadimesh.entitlements` as needed.
4. Add `DadiMeshBridge.m` to the **main** Hath app target (not the extension); remove the cargo C stub if you hit duplicate symbols.
5. Enable on **both** targets: App Groups `group.com.dadi.hath`, Network Extensions → Packet Tunnel, Personal VPN (app).
6. No On Demand rules — join/leave stays explicit from Hath.

`mesh_start` / `mesh_stop` call into the bridge after the dialer/sysmesh is up.

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
| `npm run tauri dev` | Desktop Tauri app (requires `net/build-tailscale.sh` first) |
| `npm run tauri ios init` | Generate iOS Xcode project under `src-tauri/gen/apple` |
| `npm run tauri ios dev` | iOS simulator / device (requires `ios init` + Xcode) |
| `cd net && ./build.sh` | Build libhathnet for iOS dialer linking |
| `cd net && ./build-tailscale.sh` | Build desktop `tailscale`/`tailscaled` into `src-tauri/bin/` |
| `npx tauri icon app-icon.png` | Regenerate desktop / iOS / Android icons from `app-icon.png` (દાદી mark) |

### Desktop auto-update

Tauri desktop builds (Windows / macOS / Linux) check `https://github.com/dadi-os/hath/releases/latest/download/latest.json` via the updater plugin. Artifacts are signed with `TAURI_SIGNING_PRIVATE_KEY` (see `.env.github`). When a newer SemVer is available, the header shows **UPDATE** — install is explicit, then the app relaunches. iOS stays on TestFlight; browser Hath has no native updater.

Hath updates outside `bootc` / `podman-auto-update` as a native binary by design; the web container is for Nas compose / CI only.
