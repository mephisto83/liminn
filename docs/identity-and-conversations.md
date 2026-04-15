# Identity and conversations

How Liminn keeps track of *who* a peer is, and why a rename on the other
side doesn't fork your conversation.

## The problem this solves

Earlier versions keyed threads by hostname. That had two failure modes:

1. **Rename forks the thread.** If Alice renamed her Mac from
   `alice.local` to `alice-studio`, her next message landed under a new
   key and the conversation appeared empty.
2. **Per-launch instance ids.** Before persistence, peer ids were
   generated fresh on every process start. Keying by id meant every
   Liminn restart on the other side wiped the thread.

The fix is a persistent per-install identity that separates two concerns
that used to be conflated:

- A **`machineId`** — stable, never shown to the user, used as the
  conversation key on the receiving side.
- A **`nickname`** — user-settable, shown in the sidebar and chat
  header, can change at any time without affecting message routing.

## The identity file

Each install writes `<app.getPath('userData')>/identity.json` on first
launch:

```json
{
  "machineId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "nickname": "Alice's Studio Mac"
}
```

- `machineId` is a UUID generated once with `crypto.randomUUID()`. It
  survives restart, reboot, and nickname changes. It's wiped only when
  the OS clears `userData` (reinstall, profile wipe).
- `nickname` defaults to `os.hostname()` on first run, then whatever
  the user sets via the sidebar.

`loadIdentity()` is **idempotent and self-repairing**: a missing file,
malformed JSON, or partial corruption doesn't throw. If one field is
bad it regenerates only that field — a corrupt `nickname` will never
discard the `machineId`, because doing so would split every active
conversation on the other side.

Implementation: [electron/identity.ts](../electron/identity.ts).

## How identity flows over the wire

### mDNS advertisement

`Discovery` publishes the machineId as `txt.id` and the nickname as
`txt.name`:

```
_liminn._tcp
  name: "<nickname>-<last-5-of-machineId>"
  txt.id:   <machineId>
  txt.name: <nickname>
  txt.platform: darwin | win32 | linux
```

The appended id-suffix in the mDNS instance name keeps Bonjour's
uniqueness-per-network property even when two devices share a nickname.

When the user renames themselves, `setDeviceName()` stops the old
service and republishes with the new name. The machineId stays fixed,
so every peer on the network keeps the same `peer.id` for us — the
thread doesn't fork.

Implementation: [electron/discovery.ts](../electron/discovery.ts). The
`start()` method owns the browser and the staleness sweep timer;
`publish()` only advertises. That separation exists specifically so
`republish()` (called on every rename) can re-advertise without
duplicating the browser or the sweep interval.

### Outbound text and file POSTs

Every outbound message carries both fields:

```
POST /api/text
{
  "from":   "<nickname>",    // display label the other side will show
  "fromId": "<machineId>",   // stable conversation key
  "text":   "..."
}
```

Files use the same pair as multipart fields. The server forwards both
onto `ReceivedText` / `ReceivedFile`.

## How the renderer keys conversations

`App.tsx` stores messages as `Record<string, Message[]>` where the key
is the sender's `machineId`:

```ts
const peerKey = item.fromId || `synthetic-${item.from}`;
addMessage(peerKey, ...);
```

And when reading back:

```ts
const peerMessages = selectedPeer ? messages[selectedPeer.id] || [] : [];
```

Because `peer.id === machineId` (both are the same value advertised on
the wire), the key used to *store* messages matches the key used to
*look them up* exactly — no translation layer needed.

## Edge cases

### Orphan messages — synthetic peers

A message can arrive from a host that mDNS hasn't discovered (Windows
firewall swallowing inbound Bonjour, cross-VLAN, timing race on
startup). Without handling, the message is accepted by the HTTP server
but has no UI slot.

The fix: when an inbound message's sender isn't in the peer list,
`ensurePeer()` synthesizes a placeholder tagged `platform: 'synthetic'`
with `id` set to the sender's `fromId` (when present) or
`synthetic-<from>` as a fallback.

When mDNS later discovers that host, `onPeersUpdated` deduplicates:

- If the real peer has the same id as the synthetic (common case when
  the sender supplied `fromId`), the synthetic gets replaced in place.
  Messages keyed by that id continue under the real peer with no
  migration needed.
- If the synthetic was keyed as `synthetic-<name>` (legacy sender
  that didn't send `fromId`), `messages[synthetic-<name>]` is
  **migrated** to `messages[realMachineId]` during the same update,
  and the synthetic peer is dropped from the peer list.

### Rename mid-thread

When the other side renames themselves, `mdnsPeers` is published with
the same `id` but a new `name`. App.tsx's selection-promotion logic
finds the updated peer by id and swaps the `selectedPeer` reference, so
the sidebar and chat header show the new nickname immediately. Nothing
about message routing changes — the thread stays keyed on the
unchanged machineId.

### Legacy peers (pre-update builds)

If a peer on the network is running an older build that doesn't send
`fromId`, their messages land under `synthetic-<hostname>` until mDNS
catches up with them. At that point the migration path above moves the
thread onto their real machineId. They remain interoperable; the thread
just starts under a fallback key for a short window.

### Reinstall

A reinstall clears `userData` and therefore regenerates the machineId.
From other peers' point of view, that looks like a new device with an
empty thread. This is deliberate: we can't prove it's the same install,
so starting fresh is the safe behavior.

## Nickname editing

The sidebar's "This Device" label is a click-to-edit button. Enter
commits, Escape reverts, blur commits. A failure (empty input or IPC
error) reverts the input to the previous value and toasts the error.

The flow:

1. User edits the label and hits Enter.
2. `App.tsx` calls `window.liminn.setNickname(next)`.
3. Main process calls `saveNickname()` to persist, then
   `discovery.setDeviceName()` to republish the mDNS record.
4. On success, `App.tsx` updates `deviceName` state; the sidebar
   reflects the new name. Peers pick up the change via the new mDNS
   advertisement without needing a restart.

## File reference

| Concern | File |
| --- | --- |
| Identity persistence (load/save, repair) | [electron/identity.ts](../electron/identity.ts) |
| mDNS advertisement + peer discovery | [electron/discovery.ts](../electron/discovery.ts) |
| IPC handlers, outbound POSTs, identity load on startup | [electron/main.ts](../electron/main.ts) |
| Inbound POST handling + `fromId` passthrough | [electron/server.ts](../electron/server.ts) |
| `LiminnAPI` surface exposed to the renderer | [electron/preload.ts](../electron/preload.ts) |
| Conversation keying, synthetic peers, promotion/migration | [src/App.tsx](../src/App.tsx) |
| Inline nickname edit | [src/components/Sidebar.tsx](../src/components/Sidebar.tsx) |

## Tests

- [electron/\_\_tests\_\_/identity.test.ts](../electron/__tests__/identity.test.ts)
  — load idempotency, partial-corruption repair, malformed-JSON
  recovery, `saveNickname` stability, whitespace trimming.
- [electron/\_\_tests\_\_/server.test.ts](../electron/__tests__/server.test.ts)
  — `fromId` passthrough for text and file, empty-string `fromId`
  treated as absent.
- [src/App.test.tsx](../src/App.test.tsx) — rename-mid-thread keeps the
  conversation unified, `fromId`-keyed orphan works, legacy-sender
  fallback works, synthetic→real migration on mDNS catchup, nickname
  IPC round-trip from the sidebar.
