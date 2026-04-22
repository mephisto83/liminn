import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadIdentity, saveNickname, saveServerPort } from '../identity';

/**
 * These tests treat `<userDataDir>/identity.json` as the unit under test —
 * loadIdentity must be idempotent, survive a corrupted file, and preserve
 * machineId across nickname updates so conversations on the other side
 * stay threaded.
 */
describe('identity', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liminn-id-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates identity.json on first load with a uuid machineId and a non-empty nickname', () => {
    expect(fs.existsSync(path.join(dir, 'identity.json'))).toBe(false);

    const identity = loadIdentity(dir);

    expect(identity.machineId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(identity.nickname.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, 'identity.json'))).toBe(true);
  });

  it('returns the same identity across repeated loads (no regeneration)', () => {
    const first = loadIdentity(dir);
    const second = loadIdentity(dir);
    expect(second).toEqual(first);
  });

  it('repairs a missing nickname without regenerating machineId', () => {
    const identityPath = path.join(dir, 'identity.json');
    const seededMachineId = 'seeded-machine-id-1234';
    fs.writeFileSync(identityPath, JSON.stringify({ machineId: seededMachineId }), 'utf8');

    const identity = loadIdentity(dir);

    expect(identity.machineId).toBe(seededMachineId);
    expect(identity.nickname.length).toBeGreaterThan(0);

    // Re-read from disk and confirm the repair was persisted
    const persisted = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    expect(persisted.machineId).toBe(seededMachineId);
    expect(persisted.nickname).toBe(identity.nickname);
  });

  it('recovers from a malformed identity.json with a fresh identity (no throw)', () => {
    const identityPath = path.join(dir, 'identity.json');
    fs.writeFileSync(identityPath, '{not valid json', 'utf8');

    const identity = loadIdentity(dir);
    expect(identity.machineId.length).toBeGreaterThan(0);
    expect(identity.nickname.length).toBeGreaterThan(0);
  });

  it('saveNickname persists the new nickname and keeps machineId stable', () => {
    const before = loadIdentity(dir);
    const updated = saveNickname(dir, 'My Studio Mac');

    expect(updated.machineId).toBe(before.machineId);
    expect(updated.nickname).toBe('My Studio Mac');

    const reloaded = loadIdentity(dir);
    expect(reloaded).toEqual(updated);
  });

  it('saveNickname trims whitespace and rejects empty input', () => {
    loadIdentity(dir);

    const trimmed = saveNickname(dir, '   Laptop   ');
    expect(trimmed.nickname).toBe('Laptop');

    expect(() => saveNickname(dir, '   ')).toThrow();
  });

  it('creates the userData directory if it does not exist yet', () => {
    const nested = path.join(dir, 'not-yet-created', 'sub');
    expect(fs.existsSync(nested)).toBe(false);

    const identity = loadIdentity(nested);
    expect(fs.existsSync(path.join(nested, 'identity.json'))).toBe(true);
    expect(identity.machineId.length).toBeGreaterThan(0);
  });

  describe('serverPort', () => {
    it('is undefined on first load (no prior value)', () => {
      const identity = loadIdentity(dir);
      expect(identity.serverPort).toBeUndefined();
    });

    it('saveServerPort persists the port and preserves machineId + nickname', () => {
      const before = loadIdentity(dir);
      const updated = saveServerPort(dir, 54321);

      expect(updated.machineId).toBe(before.machineId);
      expect(updated.nickname).toBe(before.nickname);
      expect(updated.serverPort).toBe(54321);

      const reloaded = loadIdentity(dir);
      expect(reloaded.serverPort).toBe(54321);
    });

    it('rejects invalid ports (0, negative, non-integer, out of range)', () => {
      loadIdentity(dir);
      expect(() => saveServerPort(dir, 0)).toThrow();
      expect(() => saveServerPort(dir, -1)).toThrow();
      expect(() => saveServerPort(dir, 65536)).toThrow();
      expect(() => saveServerPort(dir, 3.14)).toThrow();
    });

    it('drops a stored serverPort that is no longer a valid number (self-repair)', () => {
      const identityPath = path.join(dir, 'identity.json');
      fs.writeFileSync(
        identityPath,
        JSON.stringify({ machineId: 'seed-1', nickname: 'x', serverPort: 'not-a-port' }),
        'utf8',
      );

      const identity = loadIdentity(dir);
      expect(identity.serverPort).toBeUndefined();
      expect(identity.machineId).toBe('seed-1');
    });
  });
});
