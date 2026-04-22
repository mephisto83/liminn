import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import http from 'http';
import fs from 'fs';
import { Discovery, Peer } from './discovery';
import { TransferServer, ReceivedText, ReceivedFile } from './server';
import { loadIdentity, saveNickname, Identity } from './identity';
import { ConversationStore, StoredMessage } from './conversations';
import { pickReachableAddress } from './reachability';

let mainWindow: BrowserWindow | null = null;
let discovery: Discovery | null = null;
let transferServer: TransferServer | null = null;
let currentPeers: Peer[] = [];
let identity: Identity | null = null;
let conversations: ConversationStore | null = null;
const receivedTexts: ReceivedText[] = [];
const receivedFiles: ReceivedFile[] = [];

// Cap the in-memory receive buffers. The persisted conversation log
// under `<userData>/conversations.json` is the long-term history — these
// arrays are just the short-term surface exposed via `get-received-items`
// (unused by the current renderer but still part of the LiminnAPI
// contract). Left uncapped, they grew without bound.
const RECEIVE_BUFFER_MAX = 500;

function peerKeyFromIncoming(fromId: string | undefined, from: string): string {
  // Mirror the renderer's key convention in `App.tsx` so the persisted
  // peerId matches what live `messages` state would use — that way a
  // re-hydrated thread doesn't split into its own bucket.
  return fromId && fromId.length > 0 ? fromId : `synthetic-${from}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}

const SERVER_PORT = 0; // auto-assign

/**
 * Cache of `peerId -> last-known reachable address`. Populated by
 * `pickReachableAddress`, consulted by the send helpers, and evicted on
 * any send/probe failure. Exists because bonjour advertises every IP the
 * host has (VPN, Docker bridge, link-local) and the order is arbitrary —
 * without this, sends blindly hit `addresses[0]` and fail silently
 * whenever that address isn't routable.
 */
const reachableAddressCache = new Map<string, string>();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'Liminn',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0f0a1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

async function startServices(): Promise<void> {
  if (!identity) {
    throw new Error('startServices called before identity was loaded');
  }

  transferServer = new TransferServer();
  const port = await transferServer.start(SERVER_PORT);

  transferServer.onText((item) => {
    receivedTexts.unshift(item);
    if (receivedTexts.length > RECEIVE_BUFFER_MAX) receivedTexts.length = RECEIVE_BUFFER_MAX;
    conversations?.append({
      id: item.id,
      peerId: peerKeyFromIncoming(item.fromId, item.from),
      direction: 'received',
      type: 'text',
      from: item.from,
      content: item.text,
      timestamp: item.timestamp,
    });
    mainWindow?.webContents.send('text-received', item);
  });

  transferServer.onFile((item) => {
    receivedFiles.unshift(item);
    if (receivedFiles.length > RECEIVE_BUFFER_MAX) receivedFiles.length = RECEIVE_BUFFER_MAX;
    conversations?.append({
      id: item.id,
      peerId: peerKeyFromIncoming(item.fromId, item.from),
      direction: 'received',
      type: 'file',
      from: item.from,
      content: item.filename,
      timestamp: item.timestamp,
      fileSize: item.size,
      filePath: item.path,
    });
    mainWindow?.webContents.send('file-received', item);
  });

  discovery = new Discovery(port, identity.machineId, identity.nickname);
  discovery.start((peers) => {
    currentPeers = peers;
    mainWindow?.webContents.send('peers-updated', peers);

    // Drop cached addresses for peers that disappeared so a returning
    // peer on a new network path isn't stuck to a stale pick.
    const currentIds = new Set(peers.map((p) => p.id));
    for (const id of reachableAddressCache.keys()) {
      if (!currentIds.has(id)) reachableAddressCache.delete(id);
    }

    // Warm the cache so the first user-initiated send doesn't pay
    // probe latency (and, more importantly, doesn't silently fail when
    // addresses[0] is unroutable).
    for (const peer of peers) {
      if (!reachableAddressCache.has(peer.id)) {
        void pickReachableAddress(peer, reachableAddressCache);
      }
    }
  });
}

function postTextOnce(peer: Peer, addr: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    // `from` is the user-visible nickname (what the other side shows as
    // the sender label). `fromId` is the machineId — the stable key the
    // receiver uses to group this message into the conversation, even
    // if we rename ourselves mid-thread.
    const postData = JSON.stringify({
      from: identity?.nickname ?? require('os').hostname(),
      fromId: identity?.machineId,
      text,
    });

    console.log(`[send-text] POST http://${addr}:${peer.port}/api/text (peer=${peer.name}, bytes=${postData.length})`);

    const req = http.request(
      {
        hostname: addr,
        port: peer.port,
        path: '/api/text',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          console.log(`[send-text] response status=${res.statusCode} body=${data}`);
          resolve(res.statusCode === 200);
        });
      },
    );
    req.on('error', (err) => {
      console.error(`[send-text] request error for ${addr}:${peer.port} ->`, err.message);
      resolve(false);
    });
    req.on('timeout', () => {
      console.error(`[send-text] request timeout after 10s for ${addr}:${peer.port}`);
      req.destroy();
    });
    req.write(postData);
    req.end();
  });
}

async function sendTextToPeer(peer: Peer, text: string): Promise<boolean> {
  const primary = await pickReachableAddress(peer, reachableAddressCache);
  if (primary) {
    if (await postTextOnce(peer, primary, text)) return true;
    // POST failed on the address that answered /api/ping — network
    // moved between probe and send, or the peer went down. Drop the
    // cache entry and fall through to blind retries below.
    console.warn(`[send-text] primary address ${primary} failed after successful probe; falling back to other addresses`);
    reachableAddressCache.delete(peer.id);
  } else {
    // Probe found nothing. Could mean the peer is truly unreachable, or
    // an unusual firewall blocks GET /api/ping but permits POST
    // /api/text (rare). Try each advertised address anyway — giving up
    // without attempting is worse UX than one-retry-per-address.
    console.warn(
      `[send-text] probe found no reachable address for ${peer.name}; attempting each advertised address blindly`,
    );
  }

  for (const addr of peer.addresses) {
    if (primary && addr === primary) continue; // already tried
    if (await postTextOnce(peer, addr, text)) {
      reachableAddressCache.set(peer.id, addr);
      return true;
    }
  }
  return false;
}

async function sendFileToPeer(peer: Peer, filePath: string): Promise<boolean> {
  // Files use a multipart stream that can't be replayed on error, so
  // we don't iterate addresses like text does. Fall back to
  // peer.addresses[0] when probe finds nothing — same rationale as
  // text sends: one attempt with logging beats silent refusal.
  let addr = await pickReachableAddress(peer, reachableAddressCache);
  if (!addr) {
    if (peer.addresses.length === 0) {
      console.error(`[send-file] no addresses advertised for peer=${peer.name}`);
      return false;
    }
    addr = peer.addresses[0];
    console.warn(
      `[send-file] probe found no reachable address for ${peer.name}; attempting ${addr} blindly`,
    );
  }
  const chosenAddr = addr;

  return new Promise((resolve) => {
    const fileName = path.basename(filePath);
    const fileStream = fs.createReadStream(filePath);
    const fileSize = fs.statSync(filePath).size;
    const boundary = `----Liminn${Date.now()}`;

    const fromName = identity?.nickname ?? require('os').hostname();
    const fromId = identity?.machineId ?? '';
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="from"\r\n\r\n` +
      `${fromName}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="fromId"\r\n\r\n` +
      `${fromId}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const totalSize = header.length + fileSize + footer.length;

    const req = http.request(
      {
        hostname: chosenAddr,
        port: peer.port,
        path: '/api/file',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalSize,
        },
        timeout: 300000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(res.statusCode === 200));
      },
    );

    req.on('error', (err) => {
      console.error(`[send-file] request error for ${chosenAddr}:${peer.port} ->`, err.message);
      reachableAddressCache.delete(peer.id);
      resolve(false);
    });

    req.write(header);

    let sent = header.length;
    fileStream.on('data', (chunk: Buffer) => {
      req.write(chunk);
      sent += chunk.length;
      mainWindow?.webContents.send('send-progress', {
        peerId: peer.id,
        percent: Math.round((sent / totalSize) * 100),
        done: false,
      });
    });

    fileStream.on('end', () => {
      req.write(footer);
      req.end();
      mainWindow?.webContents.send('send-progress', {
        peerId: peer.id,
        percent: 100,
        done: true,
      });
    });

    fileStream.on('error', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function setupIpc(): void {
  ipcMain.handle('get-peers', () => currentPeers);

  // get-device-name returns the user-set nickname (the thing advertised
  // to peers). Falls back to hostname only before identity is loaded,
  // which shouldn't happen in practice — startServices runs before the
  // window can invoke anything.
  ipcMain.handle('get-device-name', () => identity?.nickname ?? require('os').hostname());

  ipcMain.handle('get-nickname', () => identity?.nickname ?? require('os').hostname());

  ipcMain.handle('set-nickname', (_event, nickname: string) => {
    const trimmed = typeof nickname === 'string' ? nickname.trim() : '';
    if (!trimmed) return { ok: false, error: 'Nickname cannot be empty' };
    try {
      identity = saveNickname(app.getPath('userData'), trimmed);
      discovery?.setDeviceName(trimmed);
      return { ok: true, nickname: identity.nickname };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save nickname';
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('get-received-items', () => ({
    texts: receivedTexts,
    files: receivedFiles,
  }));

  ipcMain.handle('send-text', async (_event, peerId: string, text: string) => {
    const peer = currentPeers.find((p) => p.id === peerId);
    if (!peer) return { ok: false, error: 'Peer not found' };
    const ok = await sendTextToPeer(peer, text);
    if (ok) {
      conversations?.append({
        id: `sent-${Date.now()}-${randomSuffix()}`,
        peerId: peer.id,
        direction: 'sent',
        type: 'text',
        from: identity?.nickname ?? require('os').hostname(),
        content: text,
        timestamp: Date.now(),
      });
    }
    return { ok };
  });

  ipcMain.handle('send-file', async (_event, peerId: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      title: 'Select file to send',
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, error: 'Cancelled' };

    const peer = currentPeers.find((p) => p.id === peerId);
    if (!peer) return { ok: false, error: 'Peer not found' };

    const chosenPath = result.filePaths[0];
    const ok = await sendFileToPeer(peer, chosenPath);
    const filename = path.basename(chosenPath);
    if (ok) {
      const stat = fs.statSync(chosenPath);
      conversations?.append({
        id: `sent-${Date.now()}-${randomSuffix()}`,
        peerId: peer.id,
        direction: 'sent',
        type: 'file',
        from: identity?.nickname ?? require('os').hostname(),
        content: filename,
        timestamp: Date.now(),
        fileSize: stat.size,
      });
    }
    return { ok, filename };
  });

  ipcMain.handle('get-conversations', (): StoredMessage[] => conversations?.all() ?? []);

  ipcMain.handle('rekey-conversations', (_event, oldPeerId: string, newPeerId: string) => {
    if (typeof oldPeerId !== 'string' || typeof newPeerId !== 'string') return { ok: false };
    conversations?.rekey(oldPeerId, newPeerId);
    return { ok: true };
  });

  ipcMain.handle('open-file', async (_event, filePath: string) => {
    await shell.openPath(filePath);
  });

  ipcMain.handle('open-received-folder', async () => {
    if (transferServer) {
      await shell.openPath(transferServer.getReceivedDir());
    }
  });
}

app.whenReady().then(async () => {
  // Load identity first so any IPC call (get-nickname, get-device-name)
  // sees the real values, not the hostname fallback. startServices reads
  // from `identity` for the Discovery constructor.
  identity = loadIdentity(app.getPath('userData'));
  // Conversation log is loaded synchronously so the first renderer call
  // to get-conversations after boot sees prior history, not an empty
  // array followed by a late population.
  conversations = new ConversationStore(app.getPath('userData'));

  setupIpc();
  createWindow();
  await startServices();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  discovery?.stop();
  transferServer?.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  discovery?.stop();
  transferServer?.stop();
});
