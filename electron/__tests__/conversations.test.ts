import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConversationStore, StoredMessage } from '../conversations';

/**
 * Treats `<userDataDir>/conversations.json` as the unit under test. The
 * store has to be crash-safe (tmp + atomic rename), survive a corrupt
 * file without erasing in-memory state, and serialize concurrent
 * appends so two writes can't interleave a half-written JSON file.
 */
describe('ConversationStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liminn-conv-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function waitForWrites(ms = 50): Promise<void> {
    // Appends are synchronous in-memory but flush asynchronously through
    // the write queue; tests poll briefly after an append before reading
    // the file back. 50ms is generous — actual writes are sub-ms on tmpfs.
    return new Promise((r) => setTimeout(r, ms));
  }

  function readFileAsJson(): unknown {
    return JSON.parse(fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8'));
  }

  const sampleText = (overrides: Partial<StoredMessage> = {}): StoredMessage => ({
    id: 'txt-1',
    peerId: 'peer-uuid-1',
    direction: 'received',
    type: 'text',
    from: 'Alice',
    content: 'hello',
    timestamp: 1_700_000_000_000,
    ...overrides,
  });

  it('starts with an empty log when no file exists yet', () => {
    const store = new ConversationStore(dir);
    expect(store.all()).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'conversations.json'))).toBe(false);
  });

  it('persists an appended message to disk in the canonical file', async () => {
    const store = new ConversationStore(dir);
    store.append(sampleText());
    await waitForWrites();

    const persisted = readFileAsJson();
    expect(persisted).toEqual([sampleText()]);
  });

  it('rehydrates prior messages on construction', async () => {
    const first = new ConversationStore(dir);
    first.append(sampleText({ id: 'txt-1' }));
    first.append(sampleText({ id: 'txt-2', content: 'second' }));
    await waitForWrites();

    const second = new ConversationStore(dir);
    expect(second.all()).toHaveLength(2);
    expect(second.all().map((m) => m.id)).toEqual(['txt-1', 'txt-2']);
  });

  it('survives a corrupt JSON file by starting empty rather than throwing', () => {
    fs.writeFileSync(path.join(dir, 'conversations.json'), '{not valid json', 'utf8');
    const store = new ConversationStore(dir);
    expect(store.all()).toEqual([]);

    // New appends should still succeed (the corrupt file gets overwritten).
    store.append(sampleText());
    expect(store.all()).toHaveLength(1);
  });

  it('treats an unexpected file shape (object instead of array) as empty', () => {
    fs.writeFileSync(
      path.join(dir, 'conversations.json'),
      JSON.stringify({ messages: [sampleText()] }),
      'utf8',
    );
    const store = new ConversationStore(dir);
    expect(store.all()).toEqual([]);
  });

  it('serializes two concurrent appends so the final file contains both in order', async () => {
    const store = new ConversationStore(dir);
    // Fire without awaiting between — the store's write queue must chain
    // the two flushes or the second rename could race the first write.
    store.append(sampleText({ id: 'txt-A', timestamp: 1 }));
    store.append(sampleText({ id: 'txt-B', timestamp: 2 }));
    await waitForWrites();

    const persisted = readFileAsJson() as StoredMessage[];
    expect(persisted.map((m) => m.id)).toEqual(['txt-A', 'txt-B']);
  });

  it('stores both sent and received, text and file records verbatim', async () => {
    const store = new ConversationStore(dir);
    store.append(sampleText({ id: 'r-1', direction: 'received', type: 'text' }));
    store.append(
      sampleText({
        id: 's-1',
        direction: 'sent',
        type: 'file',
        content: 'photo.png',
        fileSize: 2048,
        filePath: undefined, // sent files don't carry a local path
      }),
    );
    store.append(
      sampleText({
        id: 'r-2',
        direction: 'received',
        type: 'file',
        content: 'doc.pdf',
        fileSize: 4096,
        filePath: '/tmp/doc.pdf',
      }),
    );
    await waitForWrites();

    const persisted = readFileAsJson() as StoredMessage[];
    expect(persisted).toHaveLength(3);
    expect(persisted[1]).toMatchObject({ direction: 'sent', type: 'file', fileSize: 2048 });
    expect(persisted[2]).toMatchObject({ filePath: '/tmp/doc.pdf' });
  });

  it('returns a snapshot from all() — mutating it does not affect the store', () => {
    const store = new ConversationStore(dir);
    store.append(sampleText());

    const snapshot = store.all();
    snapshot.push(sampleText({ id: 'injected' }));

    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].id).toBe('txt-1');
  });

  it('does not leave a .tmp file behind after a successful write', async () => {
    const store = new ConversationStore(dir);
    store.append(sampleText());
    await waitForWrites();

    const entries = fs.readdirSync(dir);
    expect(entries).toContain('conversations.json');
    expect(entries).not.toContain('conversations.json.tmp');
  });

  it('creates the userData directory if it does not exist yet', async () => {
    const nested = path.join(dir, 'not-yet-created');
    expect(fs.existsSync(nested)).toBe(false);

    const store = new ConversationStore(nested);
    store.append(sampleText());
    await waitForWrites();

    expect(fs.existsSync(path.join(nested, 'conversations.json'))).toBe(true);
  });

  describe('rekey', () => {
    it('rewrites every record matching oldPeerId to newPeerId and persists the change', async () => {
      const store = new ConversationStore(dir);
      store.append(sampleText({ id: 'm-1', peerId: 'synthetic-Bob' }));
      store.append(sampleText({ id: 'm-2', peerId: 'synthetic-Bob', content: 'again' }));
      store.append(sampleText({ id: 'm-3', peerId: 'alice-uuid', content: 'unrelated' }));
      await waitForWrites();

      store.rekey('synthetic-Bob', 'bob-machine-uuid');
      await waitForWrites();

      const persisted = readFileAsJson() as StoredMessage[];
      const byId = Object.fromEntries(persisted.map((m) => [m.id, m]));
      expect(byId['m-1'].peerId).toBe('bob-machine-uuid');
      expect(byId['m-2'].peerId).toBe('bob-machine-uuid');
      expect(byId['m-3'].peerId).toBe('alice-uuid'); // untouched
    });

    it('is a no-op when no records match and does not rewrite the file', async () => {
      const store = new ConversationStore(dir);
      store.append(sampleText({ peerId: 'alice-uuid' }));
      await waitForWrites();

      const before = fs.statSync(path.join(dir, 'conversations.json')).mtimeMs;
      store.rekey('synthetic-Nobody', 'ghost-uuid');
      await waitForWrites();
      const after = fs.statSync(path.join(dir, 'conversations.json')).mtimeMs;

      // No rewrite — mtime unchanged. Not strictly a correctness property,
      // but it documents the "don't churn disk on every mDNS refresh" intent.
      expect(after).toBe(before);
    });

    it('is a no-op when old and new ids match (defensive)', () => {
      const store = new ConversationStore(dir);
      store.append(sampleText({ peerId: 'same-id' }));
      store.rekey('same-id', 'same-id');
      expect(store.all()[0].peerId).toBe('same-id');
    });

    it('survives a reload after rekey — the new peerId is what comes back', async () => {
      const first = new ConversationStore(dir);
      first.append(sampleText({ id: 'm-1', peerId: 'synthetic-Bob' }));
      await waitForWrites();
      first.rekey('synthetic-Bob', 'bob-uuid');
      await waitForWrites();

      const second = new ConversationStore(dir);
      expect(second.all()[0].peerId).toBe('bob-uuid');
    });
  });
});
