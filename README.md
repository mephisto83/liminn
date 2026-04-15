# Liminn

Share text and files across your local network. No cloud, no accounts, no setup — devices discover each other automatically over mDNS and transfer directly peer-to-peer at LAN speed.

[**Download**](https://github.com/mephisto83/liminn/releases/latest) &middot; [**Website**](https://liminn.web.app) &middot; [Architecture](docs/architecture.md) &middot; [Identity & conversations](docs/identity-and-conversations.md)

---

## What it does

Liminn is an Electron desktop app that turns any two devices on the same LAN into a miniature messaging + file-drop client. Launch it, pick a peer from the sidebar, send a message or drag in a file. The receiving device gets a toast and the file lands in `~/Liminn Received`.

There is no central server. Peers advertise themselves via Bonjour / mDNS (`_liminn._tcp`) and connect directly. Your data never leaves the network you're already on.

Runs on macOS (Intel + Apple Silicon) and Windows. Linux AppImage builds are configured but not part of the release matrix yet.

## Features

- **Auto discovery** — peers appear in the sidebar the moment they come online; no IPs to type.
- **Text and files** — quick messages or arbitrary files, no size cap beyond what your network can move.
- **Stable conversations** — each install has a persistent `machineId`, so threads survive the other side restarting or renaming themselves. See [identity-and-conversations.md](docs/identity-and-conversations.md) for the mechanism.
- **Editable nickname** — click your name in the sidebar to rename yourself; peers see the update immediately without either side restarting.
- **Orphan tolerance** — a message from a host mDNS hasn't discovered yet (firewall, VLAN, timing race) still opens a chat for that sender and gets reconciled with the real peer once discovery catches up.
- **Cross-platform** — macOS ↔ Windows works out of the box.

## Install

Grab the latest installer from the [releases page](https://github.com/mephisto83/liminn/releases/latest):

- **macOS**: `Liminn-<version>.dmg` (Intel) or `Liminn-<version>-arm64.dmg` (Apple Silicon)
- **Windows**: `Liminn.Setup.<version>.exe`

First launch takes a moment while the app writes its identity file to the OS's `userData` directory — see [identity-and-conversations.md](docs/identity-and-conversations.md#the-identity-file) for what's in it.

### Firewall prompts

On first send, the OS may ask whether to allow Liminn to accept incoming connections on private networks. Say yes — without it, peers can discover you but can't deliver messages.

## Development

Requires Node.js 20+ and npm.

```bash
git clone https://github.com/mephisto83/liminn.git
cd liminn
npm install
npm run electron:dev       # concurrently: Vite on :5395 + Electron main
```

`electron:dev` waits for Vite to boot, compiles the Electron main process (`tsc -p tsconfig.electron.json`), then launches Electron pointing at the dev URL. Renderer edits hot-reload; main-process edits require restarting the `electron` half.

### Useful scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite renderer only (no Electron) |
| `npm run electron:dev` | Full dev loop (Vite + Electron main) |
| `npm run build` | Renderer `tsc` + Vite build + Electron main `tsc` |
| `npm run start` | Build Electron main and launch against `dist/` (no Vite) |
| `npm run all-dev` | `npm run build && npm start` — one-shot prod-like run |
| `npm run electron:build` | Build + invoke `electron-builder` for the current platform |
| `npm test` | Vitest run (server API + App routing + identity) |
| `npm run test:watch` | Vitest watch mode |

### Running on two machines

To actually exercise the discovery and transfer paths you need two processes on the same LAN. Easiest:

1. `npm run all-dev` on machine A.
2. Pull the same commit and run the same on machine B.
3. Each should appear in the other's sidebar within a second or two.

Two Liminn processes on **one** machine also work — mDNS uses a per-publication suffix on the service instance name and each process has its own `userData` directory.

## Architecture, briefly

Two processes, wired through a preload bridge:

```
┌──────────────────────────┐         ┌────────────────────────────────┐
│  Renderer (React, Vite)  │◄── IPC ►│  Main (Electron, Node)         │
│                          │         │  ├─ Discovery (mDNS)           │
│  App.tsx                 │         │  ├─ TransferServer (Express)   │
│  Sidebar / ChatArea / …  │         │  ├─ Identity (identity.json)   │
└──────────────────────────┘         │  └─ HTTP client for sends      │
                                     └────────────────────────────────┘
```

- **Discovery** (`electron/discovery.ts`) publishes an mDNS record with the local `machineId` and `nickname`, and browses the same service type for peers.
- **TransferServer** (`electron/server.ts`) listens on an ephemeral port advertised via mDNS. Accepts `POST /api/text` and `POST /api/file`.
- **Identity** (`electron/identity.ts`) owns `<userData>/identity.json` — the `machineId` that keeps conversations stable across restarts.
- **IPC** (`electron/preload.ts`) exposes `window.liminn` with peer list, send methods, nickname read/write, and event subscriptions for incoming messages.

Deeper treatment: [docs/architecture.md](docs/architecture.md). The identity + rename + thread-stability story has its own doc: [docs/identity-and-conversations.md](docs/identity-and-conversations.md).

## Project structure

```
liminn/
├── electron/                 # Main process (Node)
│   ├── main.ts               # App lifecycle, IPC handlers, send clients
│   ├── discovery.ts          # mDNS publish + browse
│   ├── server.ts             # HTTP receive (Express + multer)
│   ├── identity.ts           # Persistent machineId + nickname
│   ├── preload.ts            # contextBridge → window.liminn
│   └── __tests__/            # Vitest: server, identity
├── src/                      # Renderer (React)
│   ├── App.tsx               # Peer list, conversation state, routing
│   ├── components/           # Sidebar, ChatArea, EmptyState, Toast
│   ├── types.ts              # LiminnAPI + Peer / Received* shapes
│   └── App.test.tsx          # Vitest: routing + rename + synthetic peers
├── website/                  # Static marketing + download site (Firebase Hosting)
├── docs/                     # Long-form architecture / behavior docs
├── .github/workflows/        # Build & Release, Deploy Website
└── package.json              # electron-builder config lives here under "build"
```

## Testing

```bash
npm test
```

Three suites cover the behavior most likely to regress:

- `electron/__tests__/server.test.ts` — HTTP API contract via supertest against a real `TransferServer` on an ephemeral port.
- `electron/__tests__/identity.test.ts` — `loadIdentity` idempotency and partial-corruption repair; `saveNickname` preserves `machineId`.
- `src/App.test.tsx` — peer-keyed message routing, rename mid-thread, orphan/synthetic peers, synthetic-to-real migration, nickname IPC round-trip.

## Releasing

Binaries are built and published by `.github/workflows/build.yml` on tag push.

```bash
npm version minor -m "chore: release v%s"   # or major / patch
git push && git push --tags
```

The workflow:

1. Builds macOS artifacts (`.dmg` + `.zip`, x64 + arm64) on `macos-latest`.
2. Builds Windows NSIS installer (`.exe`, x64) on `windows-latest`.
3. Downloads both artifact sets and creates a GitHub Release with auto-generated notes, attaching all files.

The website's nav badge and "Latest" text use static fallback values that render before client-side JS runs. If you want those to show the new version on first paint (and in the HTML source for SEO), also bump `website/index.html` and push — `.github/workflows/deploy-website.yml` redeploys to Firebase Hosting whenever `website/**` changes on `main`. Users with JS will see the new version regardless, because the page fetches `/releases/latest` from GitHub and rewires the badge and download URLs at load.

The Firebase deploy relies on a `FIREBASE_SERVICE_ACCOUNT` repo secret (JSON key from the Firebase Console → Service Accounts). If it's missing or rotated, the deploy job fails with `Input required and not supplied: firebaseServiceAccount` — set it with `gh secret set FIREBASE_SERVICE_ACCOUNT < path/to/key.json` and rerun the workflow.

## Tech stack

- **Electron 33** (main + preload + renderer isolation via `contextBridge`)
- **React 18** + **Vite 6** (renderer)
- **TypeScript 5** (strict, across both processes)
- **bonjour-service** for mDNS
- **Express** + **multer** for the receive server
- **Vitest** + **@testing-library/react** + **supertest** + **jsdom** for tests
- **electron-builder 25** for platform installers
