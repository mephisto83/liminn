import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * Persistent per-install identity.
 *
 * - `machineId` is generated once on first launch and stored in
 *   `<userData>/identity.json`. It's used as the mDNS `txt.id`, which
 *   means peer.id is stable across restarts and reboots (unlike the
 *   earlier per-launch id that regenerated on every process start).
 *   Stable peer.id is what lets the renderer key conversations on the
 *   peer itself — if the other side renames or restarts, the thread
 *   stays intact.
 *
 *   Wiped on reinstall (or whenever the OS clears `userData`). At that
 *   point the other side sees a new machineId and starts a fresh
 *   thread, which is the correct behavior — we can't prove it's the
 *   same install.
 *
 * - `nickname` is the user-set display name. Defaults to
 *   `os.hostname()` so a fresh install shows something sensible.
 *   Advertised via mDNS `txt.name` and used as the `from` field in
 *   outbound POSTs, so renaming is visible to peers without any
 *   manual restart.
 */
export interface Identity {
  machineId: string;
  nickname: string;
  /**
   * Preferred TCP port for the transfer server. Persisted after the
   * first successful bind so peers on the other side don't have to
   * re-discover us every restart — stale peer caches were posting to
   * yesterday's ephemeral port and timing out. Undefined on first
   * launch; the caller picks an ephemeral port and writes it back.
   */
  serverPort?: number;
}

interface StoredIdentity {
  machineId?: unknown;
  nickname?: unknown;
  serverPort?: unknown;
}

function defaultNickname(): string {
  // os.hostname() on macOS sometimes returns '.local' or the FQDN; both
  // are reasonable fallbacks, but users usually want something shorter.
  // We leave it to the user to rename — this just has to be non-empty.
  return os.hostname() || 'Liminn Device';
}

function readStored(identityPath: string): StoredIdentity | null {
  try {
    const raw = fs.readFileSync(identityPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as StoredIdentity;
    return null;
  } catch {
    // Missing file or malformed JSON — caller will regenerate.
    return null;
  }
}

function writeIdentity(identityPath: string, identity: Identity): void {
  const dir = path.dirname(identityPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), 'utf8');
}

/**
 * Load `Identity` from `<userDataDir>/identity.json`, creating or
 * repairing the file as needed. Always returns a valid identity:
 *
 * - Missing file → fresh machineId + hostname-derived nickname.
 * - File present, both fields valid → use as-is.
 * - File present but one field missing/invalid → fill in the missing
 *   field and persist the merged result. This means a corrupt
 *   `nickname` won't force a new `machineId` (which would split the
 *   user's conversations).
 */
export function loadIdentity(userDataDir: string): Identity {
  const identityPath = path.join(userDataDir, 'identity.json');
  const stored = readStored(identityPath);

  const machineId =
    stored && typeof stored.machineId === 'string' && stored.machineId.length > 0
      ? stored.machineId
      : crypto.randomUUID();

  const nickname =
    stored && typeof stored.nickname === 'string' && stored.nickname.length > 0
      ? stored.nickname
      : defaultNickname();

  const serverPort =
    stored && typeof stored.serverPort === 'number' && Number.isInteger(stored.serverPort) && stored.serverPort > 0 && stored.serverPort < 65536
      ? stored.serverPort
      : undefined;

  const identity: Identity = { machineId, nickname, ...(serverPort ? { serverPort } : {}) };

  // Persist if anything was missing or the file didn't exist. Cheap
  // write, and we want subsequent launches to read the canonical
  // identity without touching the fallback code path.
  const needsWrite =
    !stored ||
    stored.machineId !== machineId ||
    stored.nickname !== nickname;
  if (needsWrite) writeIdentity(identityPath, identity);

  return identity;
}

/**
 * Persist the transfer-server port alongside the existing identity so
 * the next launch rebinds to the same port by default. Caller is
 * responsible for only invoking this once the bind has succeeded —
 * otherwise we'd remember a port we couldn't actually use.
 */
export function saveServerPort(userDataDir: string, port: number): Identity {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error(`Invalid server port: ${port}`);
  }
  const current = loadIdentity(userDataDir);
  const next: Identity = { ...current, serverPort: port };
  writeIdentity(path.join(userDataDir, 'identity.json'), next);
  return next;
}

/**
 * Overwrite just the nickname, leaving `machineId` untouched.
 * Throws on empty/whitespace input — callers should validate before
 * getting here, but defense-in-depth protects the persisted file.
 */
export function saveNickname(userDataDir: string, nickname: string): Identity {
  const trimmed = nickname.trim();
  if (!trimmed) throw new Error('Nickname cannot be empty');

  const current = loadIdentity(userDataDir);
  const next: Identity = { ...current, nickname: trimmed };
  writeIdentity(path.join(userDataDir, 'identity.json'), next);
  return next;
}
