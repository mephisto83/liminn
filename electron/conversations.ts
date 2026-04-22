import fs from 'fs';
import path from 'path';

/**
 * A single persisted chat entry. One record per text or file in either
 * direction. Stored flat (all peers, all directions) in
 * `<userData>/conversations.json`; the renderer groups them by `peerId`
 * at hydration time, which matches how `messages` is already keyed in
 * `App.tsx`.
 *
 * `peerId` follows the same convention the renderer uses for its live
 * `messages` map: the peer's machineId when we know it, otherwise the
 * `synthetic-<display-name>` fallback. Storing under the synthetic key
 * is fine — when mDNS later resolves the real peer, App.tsx already
 * migrates `messages[synthetic-<name>]` to `messages[realId]` in-memory,
 * so the rehydrated thread picks up the migration naturally.
 */
export interface StoredMessage {
  id: string;
  peerId: string;
  direction: 'sent' | 'received';
  type: 'text' | 'file';
  /** Display name at the time the message was stored. */
  from: string;
  /** Text body for `type: 'text'`; filename for `type: 'file'`. */
  content: string;
  timestamp: number;
  fileSize?: number;
  /** Absolute path of the received file — only set for received files. */
  filePath?: string;
}

const CONVERSATIONS_FILE = 'conversations.json';

function conversationsPath(userDataDir: string): string {
  return path.join(userDataDir, CONVERSATIONS_FILE);
}

function readConversations(p: string): StoredMessage[] {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as StoredMessage[];
    console.warn('[conversations] unexpected file shape, starting empty');
    return [];
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn('[conversations] failed to load, starting empty:', err);
    }
    return [];
  }
}

/**
 * Single-writer, crash-safe conversation log. Writes are serialized
 * through a promise chain so two appends in flight can't interleave a
 * partial rewrite; each write lands as a tmp file then atomic-renames
 * over the canonical path so a crash mid-write can't produce a
 * half-written JSON file.
 */
export class ConversationStore {
  private userDataDir: string;
  private messages: StoredMessage[];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
    this.messages = readConversations(conversationsPath(userDataDir));
  }

  all(): StoredMessage[] {
    return this.messages.slice();
  }

  append(msg: StoredMessage): void {
    this.messages.push(msg);
    // Chain through writeQueue so concurrent appends never race on the
    // tmp file. Errors are logged but swallowed — the in-memory log is
    // still consistent, and losing a persisted line is preferable to
    // stalling the send/receive pipeline on a disk error.
    this.writeQueue = this.writeQueue.then(() => this.flush());
  }

  /**
   * Rewrite every record whose `peerId` matches `oldPeerId` to use
   * `newPeerId` instead. Used when the renderer migrates a synthetic
   * `synthetic-<name>` thread onto a real machineId discovered later —
   * without this, every restart would rebuild the synthetic bucket
   * from disk and re-run the in-memory migration, accumulating cruft.
   * No-op if no records match (keeps callers unconditional).
   */
  rekey(oldPeerId: string, newPeerId: string): void {
    if (oldPeerId === newPeerId) return;
    let changed = false;
    for (const msg of this.messages) {
      if (msg.peerId === oldPeerId) {
        msg.peerId = newPeerId;
        changed = true;
      }
    }
    if (changed) {
      this.writeQueue = this.writeQueue.then(() => this.flush());
    }
  }

  private async flush(): Promise<void> {
    const target = conversationsPath(this.userDataDir);
    const tmp = `${target}.tmp`;
    const dir = path.dirname(target);

    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify(this.messages), 'utf8');
      await fs.promises.rename(tmp, target);
    } catch (err) {
      console.warn('[conversations] write failed:', err);
    }
  }
}
