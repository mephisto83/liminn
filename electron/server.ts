import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';

export interface ReceivedText {
  id: string;
  from: string;
  /**
   * The sender's machineId (stable across their restarts). Forwarded via
   * the POST body; used by the renderer as the conversation key so a
   * rename on the other side doesn't fork the thread. Optional because
   * older peers on the network may not send it.
   */
  fromId?: string;
  text: string;
  timestamp: number;
  /**
   * The sender's IP as observed on the socket. Forwarded so the renderer
   * can synthesize a peer entry when a message arrives from a host that
   * mDNS hasn't discovered — otherwise the message is received but has
   * nowhere to appear in the UI. May be IPv6-mapped (`::ffff:1.2.3.4`);
   * we normalize the mapped form before forwarding.
   */
  remoteAddr?: string;
}

export interface ReceivedFile {
  id: string;
  from: string;
  /** See ReceivedText.fromId. */
  fromId?: string;
  filename: string;
  size: number;
  path: string;
  timestamp: number;
  /** See ReceivedText.remoteAddr. */
  remoteAddr?: string;
}

function normalizeRemoteAddr(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Node sockets often report IPv4 traffic as `::ffff:192.168.1.5` when the
  // listener is dual-stack. Strip the prefix so the renderer gets a clean
  // IPv4 string that it can actually POST back to.
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  return raw;
}

type OnTextReceived = (item: ReceivedText) => void;
type OnFileReceived = (item: ReceivedFile) => void;

export class TransferServer {
  private app: express.Application;
  private server: http.Server | null = null;
  private receivedDir: string;
  private onTextReceived: OnTextReceived | null = null;
  private onFileReceived: OnFileReceived | null = null;

  constructor() {
    this.app = express();
    this.receivedDir = path.join(os.homedir(), 'Liminn Received');

    if (!fs.existsSync(this.receivedDir)) {
      fs.mkdirSync(this.receivedDir, { recursive: true });
    }

    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json({ limit: '50mb' }));

    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, this.receivedDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext);
        let finalName = file.originalname;
        let counter = 1;
        while (fs.existsSync(path.join(this.receivedDir, finalName))) {
          finalName = `${base} (${counter})${ext}`;
          counter++;
        }
        cb(null, finalName);
      },
    });
    const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

    this.app.post('/api/text', (req, res) => {
      const { from, fromId, text } = req.body;
      const remoteAddr = normalizeRemoteAddr(req.socket.remoteAddress);
      console.log(`[recv-text] POST /api/text from=${from} fromId=${fromId ?? '(none)'} remoteAddr=${remoteAddr} bytes=${text?.length ?? 0}`);
      if (!text) {
        console.log('[recv-text] rejected: no text in body');
        res.status(400).json({ error: 'No text provided' });
        return;
      }
      const item: ReceivedText = {
        id: `txt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        from: from || 'Unknown',
        fromId: typeof fromId === 'string' && fromId.length > 0 ? fromId : undefined,
        text,
        timestamp: Date.now(),
        remoteAddr,
      };
      if (this.onTextReceived) {
        this.onTextReceived(item);
        console.log('[recv-text] forwarded to renderer via onTextReceived');
      } else {
        console.error('[recv-text] no onTextReceived callback set — event lost!');
      }
      res.json({ ok: true });
    });

    this.app.post('/api/file', upload.single('file'), (req, res) => {
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }
      const body = (req.body as Record<string, string>) || {};
      const rawFromId = body.fromId;
      const item: ReceivedFile = {
        id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        from: body.from || 'Unknown',
        fromId: typeof rawFromId === 'string' && rawFromId.length > 0 ? rawFromId : undefined,
        filename: req.file.filename,
        size: req.file.size,
        path: req.file.path,
        timestamp: Date.now(),
        remoteAddr: normalizeRemoteAddr(req.socket.remoteAddress),
      };
      if (this.onFileReceived) this.onFileReceived(item);
      res.json({ ok: true });
    });

    this.app.get('/api/ping', (_req, res) => {
      res.json({ ok: true });
    });
  }

  onText(callback: OnTextReceived): void {
    this.onTextReceived = callback;
  }

  onFile(callback: OnFileReceived): void {
    this.onFileReceived = callback;
  }

  /**
   * Bind on `port` (or ephemeral if `port === 0`). If a non-zero port
   * is passed and already in use (EADDRINUSE), fall back to ephemeral
   * once and return the port that actually bound — callers use the
   * return value to persist the port for next launch, so the fallback
   * is what gets remembered.
   */
  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryListen = (p: number, allowFallback: boolean) => {
        const server = this.app.listen(p, '0.0.0.0');
        this.server = server;

        server.once('listening', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            resolve(addr.port);
          } else {
            reject(new Error('Failed to get server address'));
          }
        });

        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && allowFallback) {
            console.warn(`[server] port ${p} in use, falling back to ephemeral`);
            tryListen(0, false);
          } else {
            reject(err);
          }
        });
      };

      tryListen(port, port !== 0);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
    }
  }

  getReceivedDir(): string {
    return this.receivedDir;
  }
}
