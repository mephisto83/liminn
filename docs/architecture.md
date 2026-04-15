# Architecture

How Liminn is put together: processes, services, wire protocol, and the
paths a message or file takes from one device to another.

For the narrower question of *who a peer is* and why a rename or a
restart doesn't fork your conversation, see
[identity-and-conversations.md](./identity-and-conversations.md).

## The two-process picture

Liminn is an Electron app, so there are two JavaScript processes per
install plus a thin preload bridge between them.

```
╭─ Renderer (React, Vite)  ─────────────────╮       ╭─ Main (Node)  ──────────────────────────╮
│                                            │       │                                          │
│  src/App.tsx                               │◄──IPC►│  electron/main.ts                        │
│   ├─ peer list state                       │       │   ├─ window/app lifecycle                │
│   ├─ messages keyed by peer.id (machineId) │       │   ├─ ipcMain.handle(…) for get/send/…    │
│   ├─ synthetic-peer reconciliation         │       │   └─ outbound http.request to peers      │
│   └─ Sidebar / ChatArea / Toast            │       │                                          │
│                                            │       │  electron/discovery.ts                   │
│  src/types.ts                              │       │   ├─ bonjour publish (machineId + name)  │
│   └─ LiminnAPI — strict contract           │       │   ├─ bonjour browse + addPeer            │
│                                            │       │   └─ sweep evicts stale, refreshed from  │
│                                            │       │      browser.services                    │
│  window.liminn                             │       │                                          │
│   (injected by preload)                    │       │  electron/server.ts                      │
│                                            │       │   ├─ express POST /api/text              │
│                                            │       │   ├─ express POST /api/file (multer)     │
│                                            │       │   └─ GET  /api/ping                      │
│                                            │       │                                          │
│                                            │       │  electron/identity.ts                    │
│                                            │       │   └─ <userData>/identity.json            │
╰────────────────────────────────────────────╯       ╰──────────────────────────────────────────╯
               ▲                                                     │
               │ contextBridge.exposeInMainWorld                     │
               └─────────────── electron/preload.ts ◄────────────────┘
```

The renderer has **no** direct access to Node APIs, the filesystem, or
the network. Every side-effect goes through the `window.liminn` surface
defined in `preload.ts` and handled by `ipcMain` in `main.ts`. Keeping
that contract narrow is what lets the renderer stay a pure React app.

## Components

### `Discovery` — mDNS publish + browse

File: [`electron/discovery.ts`](../electron/discovery.ts).

On start, `Discovery.publish()` advertises the local device as an
instance of `_liminn._tcp`, carrying the `machineId` and `nickname` in
the TXT record. `Discovery.startBrowsing()` listens for other instances
of the same service type.

Peers live in a `Map<machineId, Peer>` and are emitted to the renderer
via a callback on every change. The sweep interval (every 10s) is where
most of the subtlety lives:

- `bonjour-service` doesn't refire the `'up'` event for records it
  already knows about, so `lastSeen` would freeze at first-discovery
  time if we only trusted events.
- The sweep **refreshes** `lastSeen` for every peer that still appears
  in `browser.services` (bonjour's authoritative live cache), then
  evicts anything older than 30 seconds.
- Eviction logs the peer name and age, which is how we diagnosed the
  original "lost connection after a successful send" bug.

`setDeviceName()` stops the published service and republishes with the
new name, without touching the browser or sweep timer — so a rename
doesn't duplicate listeners or cause a dropout in peer discovery.

### `TransferServer` — inbound HTTP

File: [`electron/server.ts`](../electron/server.ts).

An Express app listening on an ephemeral port (selected at start, then
advertised via mDNS). Three routes:

| Method + path | Body | Effect |
| --- | --- | --- |
| `POST /api/text` | `{ from, fromId?, text }` | Invokes `onText` callback with a `ReceivedText` (adds `id`, `timestamp`, `remoteAddr`). Rejects with 400 if `text` is missing. |
| `POST /api/file` | multipart: `from`, `fromId?`, `file` | Saves file under `~/Liminn Received/`, invokes `onFile` with a `ReceivedFile`. Rejects with 400 if no file. |
| `GET /api/ping` | — | Returns `{ ok: true }`. Used by tests; useful for manual connectivity checks. |

Filename collisions in the receive folder are handled by the storage
engine: if `document.pdf` already exists, the next one becomes
`document (1).pdf`, then `document (2).pdf`, and so on. No overwrites.

JSON bodies are capped at 50 MB (`express.json({ limit: '50mb' })`).
Multipart uploads are capped at 5 GB by multer's `limits.fileSize`.
Both values are hard-coded in `setupRoutes`.

### `Identity` — persistent machineId + nickname

File: [`electron/identity.ts`](../electron/identity.ts).

Owns `<userData>/identity.json`. Covered in detail in
[identity-and-conversations.md](./identity-and-conversations.md); the
one-line summary is: `machineId` is a UUID generated once and used as
the mDNS `txt.id`, so every peer on the network uses the same
conversation key for you regardless of how many times you restart or
rename yourself.

`loadIdentity` is self-repairing — a missing file, malformed JSON, or
one corrupt field regenerates only what's broken. In particular, a
corrupt `nickname` never discards the `machineId`, because doing so
would orphan every active conversation on the other side.

### IPC bridge

Files: [`electron/preload.ts`](../electron/preload.ts) + the
`LiminnAPI` interface in [`src/types.ts`](../src/types.ts).

The renderer calls methods on `window.liminn`; the preload script
forwards to `ipcRenderer.invoke(...)`; `main.ts` handles them with
`ipcMain.handle(...)`.

Invocable methods:

| Method | Purpose |
| --- | --- |
| `getPeers()` | Current known peer list (snapshot; subscribe to updates with `onPeersUpdated`). |
| `sendText(peerId, text)` | POST `/api/text` to that peer. |
| `sendFile(peerId)` | Show OS file picker, then stream the chosen file to that peer. |
| `getDeviceName()` / `getNickname()` | Current nickname. |
| `setNickname(nickname)` | Persist a new nickname and republish the mDNS record. |
| `getReceivedItems()` | Backlog of received texts + files (main-process buffer). |
| `openFile(filePath)` | `shell.openPath` — opens a received file with the OS default. |
| `openReceivedFolder()` | Reveals `~/Liminn Received` in the file manager. |

Event subscriptions (renderer → main, via `ipcRenderer.on`):

| Event | Payload |
| --- | --- |
| `onPeersUpdated` | `Peer[]` on every discovery change. |
| `onTextReceived` | `ReceivedText` — fired when a peer POSTs text. |
| `onFileReceived` | `ReceivedFile` — fired when a file upload completes. |
| `onSendProgress` | `{ peerId, percent, done }` during an outbound file send. |

There's currently no unsubscribe helper — each `ipcRenderer.on`
registration persists for the lifetime of the renderer. React Strict
Mode or Vite HMR double-invoking the mount effect in dev can therefore
stack up duplicate listeners; see
[known edge cases](#known-edge-cases) below.

## Data flow

### Peer discovery

```
Device A                                            Device B
────────                                            ────────

Discovery.publish()                                 Discovery.publish()
  ├─ bonjour.publish(_liminn._tcp, txt={id,name})
  │                                                   bonjour.browser on('up', …)
  │                                                   ├─ addPeer(): self-filter,
  │                                                   │  IPv4-only, store by txt.id
  │                                                   └─ onPeersChanged → ipc → renderer
  │                                                                          setPeers([…])
Discovery.browser on('up', …) ◄──── symmetric ──────
```

The `'up'` event delivers the sender's resolved addresses; Discovery
filters out IPv6 and picks IPv4s. Anything without a `txt.id` or
matching our own `machineId` is dropped silently (logged).

### Sending a text

```
User types in ChatArea
  ↓
App.tsx handleSendText(selectedPeer.id, text)
  ↓
window.liminn.sendText(peerId, text)
  ↓  ipcRenderer.invoke → ipcMain.handle('send-text')
main.ts: find peer by id → sendTextToPeer(peer, text)
  ↓  http.request POST peer.addresses[0]:peer.port /api/text
  │  body: { from: nickname, fromId: machineId, text }
Device B server.ts: onText callback → webContents.send('text-received', …)
  ↓
Device B App.tsx onTextReceived → addMessage(fromId, …) → render
Device A addMessage(selectedPeer.id, …) on success → render locally
```

### Sending a file (with progress)

Same shape as text, but the outbound payload is a multipart stream.
Each `fileStream.on('data')` write triggers a `send-progress` IPC event
that updates the in-flight progress bar in the sidebar. On completion,
a `done: true` event lets the renderer clear the bar after a short
delay.

### Rename propagation

```
User edits nickname in Sidebar
  ↓
App.tsx handleSetNickname → window.liminn.setNickname(next)
  ↓  ipcMain.handle('set-nickname')
main.ts: identity.saveNickname(userDataDir, next)
      → discovery.setDeviceName(next)
           ├─ stop old published service
           └─ publish() with new txt.name (same machineId)
Peers:
  └─ browser 'down' on old record, 'up' on new
     → addPeer replaces the entry under the same machineId
     → renderer sees onPeersUpdated with peer.name changed
```

Because every conversation is keyed on `machineId` (which didn't
change), the thread stays unified across the rename. App.tsx has a
selection-promotion effect that swaps `selectedPeer` to the updated
object so the chat header reflects the new name instantly.

## Known edge cases

These are documented where relevant in the code; consolidated here as a
checklist for future work.

- **IPC listener leak across HMR.** `preload.ts` uses `ipcRenderer.on`
  without a corresponding `removeListener`. React Strict Mode's
  intentional double-effect and Vite HMR's re-invocation of the mount
  effect both re-register listeners. In production this doesn't fire,
  but in dev after several edits one incoming message can fan out to
  N handlers. Guard with `removeAllListeners(channel)` before adding.

- **Sends use `addresses[0]` blindly.** Dual-homed peers (VPN, Docker
  bridge, Ethernet + WiFi) can advertise a non-reachable address
  first. The request errors silently from the renderer's perspective.
  A retry-over-remaining-addresses or prefer-same-subnet policy would
  fix it.

- **Discovery stops on macOS window close, isn't restarted on
  re-activate.** `main.ts` calls `discovery?.stop()` in
  `window-all-closed`, but on darwin the app itself stays alive. When
  the user later reopens the window, `createWindow()` runs but
  `startServices()` doesn't, leaving a live window attached to dead
  discovery.

- **File send has no backpressure.** `req.write(chunk)` on every
  `fileStream.on('data')` without checking the drain signal. Fine for
  LAN-speed transfers of hundreds of megs; a multi-GB file over slow
  WiFi will balloon RSS.

- **Ghost peer after a restart.** The sender's previous `machineId`
  can remain in the peer list until the 30-second sweep (and bonjour's
  TTL) clears it, so briefly there are two entries for the same host
  until the ghost ages out. The new entry already has the correct
  thread because both sides keyed it on `machineId`.

## File reference

| Concern | File |
| --- | --- |
| App lifecycle, IPC handlers, outbound HTTP | [electron/main.ts](../electron/main.ts) |
| mDNS publish + browse + staleness sweep | [electron/discovery.ts](../electron/discovery.ts) |
| Inbound HTTP (text + file + ping) | [electron/server.ts](../electron/server.ts) |
| Persistent identity (machineId + nickname) | [electron/identity.ts](../electron/identity.ts) |
| `LiminnAPI` surface (contextBridge) | [electron/preload.ts](../electron/preload.ts) |
| Renderer entry, state, peer routing | [src/App.tsx](../src/App.tsx) |
| Sidebar (peer list + nickname edit) | [src/components/Sidebar.tsx](../src/components/Sidebar.tsx) |
| Chat area (thread view + input) | [src/components/ChatArea.tsx](../src/components/ChatArea.tsx) |
| Shared type surface (Peer, LiminnAPI, Received\*) | [src/types.ts](../src/types.ts) |
