import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import http from 'http';
import fs from 'fs';
import { Discovery, Peer } from './discovery';
import { TransferServer, ReceivedText, ReceivedFile } from './server';
import { loadIdentity, saveNickname, Identity } from './identity';

let mainWindow: BrowserWindow | null = null;
let discovery: Discovery | null = null;
let transferServer: TransferServer | null = null;
let currentPeers: Peer[] = [];
let identity: Identity | null = null;
const receivedTexts: ReceivedText[] = [];
const receivedFiles: ReceivedFile[] = [];

const SERVER_PORT = 0; // auto-assign

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
    mainWindow?.webContents.send('text-received', item);
  });

  transferServer.onFile((item) => {
    receivedFiles.unshift(item);
    mainWindow?.webContents.send('file-received', item);
  });

  discovery = new Discovery(port, identity.machineId, identity.nickname);
  discovery.start((peers) => {
    currentPeers = peers;
    mainWindow?.webContents.send('peers-updated', peers);
  });
}

function sendTextToPeer(peer: Peer, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const addr = peer.addresses[0];
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

function sendFileToPeer(peer: Peer, filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const addr = peer.addresses[0];
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
        hostname: addr,
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

    req.on('error', () => resolve(false));

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

    const ok = await sendFileToPeer(peer, result.filePaths[0]);
    return { ok, filename: path.basename(result.filePaths[0]) };
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
