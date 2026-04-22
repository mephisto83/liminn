import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { pickReachableAddress, probeAddress, Reachable } from '../reachability';

/**
 * The interesting behavior to lock down is address selection: bonjour
 * advertises every IP a host has (VPN, Docker bridge, link-local) in
 * arbitrary order, and the old code blindly used `addresses[0]`. These
 * tests confirm pickReachableAddress finds the answerable address in
 * parallel, caches it per-peer, invalidates stale cache entries, and
 * returns null rather than picking a dead IP.
 */
describe('probeAddress (live HTTP)', () => {
  let server: http.Server;
  let port: number;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url === '/api/ping') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') port = addr.port;
          resolve();
        });
      }),
  );

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it('resolves true against a real /api/ping responder', async () => {
    expect(await probeAddress('127.0.0.1', port)).toBe(true);
  });

  it('resolves false when nothing is listening on the port', async () => {
    // Use the already-known-free port after close. Bind+close to discover it.
    const probe = http.createServer();
    const freePort: number = await new Promise((res) => {
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        if (a && typeof a === 'object') res(a.port);
      });
    });
    await new Promise<void>((res) => probe.close(() => res()));

    expect(await probeAddress('127.0.0.1', freePort, 500)).toBe(false);
  });

  it('resolves false when the host itself is unreachable (timeout honored)', async () => {
    // TEST-NET-1 (RFC 5737) — documented as non-routable. A short timeout
    // keeps the test fast; we assert only that we don't hang past it.
    const start = Date.now();
    const ok = await probeAddress('192.0.2.1', 80, 300);
    const elapsed = Date.now() - start;
    expect(ok).toBe(false);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('pickReachableAddress', () => {
  const peer = (overrides: Partial<Reachable> = {}): Reachable => ({
    id: 'peer-1',
    name: 'TestPeer',
    addresses: ['10.0.0.1', '10.0.0.2'],
    port: 9999,
    ...overrides,
  });

  it('returns the cached address without probing if it is still advertised', async () => {
    const cache = new Map<string, string>([['peer-1', '10.0.0.2']]);
    const probe = vi.fn(async () => true);

    const addr = await pickReachableAddress(peer(), cache, probe);
    expect(addr).toBe('10.0.0.2');
    expect(probe).not.toHaveBeenCalled();
  });

  it('evicts a cached address that is no longer advertised and re-probes', async () => {
    const cache = new Map<string, string>([['peer-1', '192.168.99.99']]);
    const probe = vi.fn(async (addr: string) => addr === '10.0.0.1');

    const addr = await pickReachableAddress(peer(), cache, probe);
    expect(addr).toBe('10.0.0.1');
    expect(cache.get('peer-1')).toBe('10.0.0.1');
    expect(probe).toHaveBeenCalled();
  });

  it('picks the answering address even when the first address is dead', async () => {
    const cache = new Map<string, string>();
    // addresses[0] always fails; addresses[1] succeeds — the fix.
    const probe = vi.fn(async (addr: string) => addr === '10.0.0.2');

    const addr = await pickReachableAddress(peer(), cache, probe);
    expect(addr).toBe('10.0.0.2');
    expect(cache.get('peer-1')).toBe('10.0.0.2');
  });

  it('prefers whichever address answers first (parallel probing)', async () => {
    const cache = new Map<string, string>();
    // Simulate addresses[0] taking 100ms, addresses[1] returning immediately.
    // Sequential probing would pick addresses[0]; parallel picks addresses[1].
    const probe = vi.fn((addr: string) =>
      addr === '10.0.0.1'
        ? new Promise<boolean>((r) => setTimeout(() => r(true), 100))
        : Promise.resolve(true),
    );

    const addr = await pickReachableAddress(peer(), cache, probe);
    expect(addr).toBe('10.0.0.2');
  });

  it('returns null and leaves the cache empty when no address responds', async () => {
    const cache = new Map<string, string>();
    const probe = vi.fn(async () => false);

    const addr = await pickReachableAddress(peer(), cache, probe);
    expect(addr).toBeNull();
    expect(cache.has('peer-1')).toBe(false);
  });

  it('returns null immediately when the peer has no addresses', async () => {
    const cache = new Map<string, string>();
    const probe = vi.fn(async () => true);

    const addr = await pickReachableAddress(peer({ addresses: [] }), cache, probe);
    expect(addr).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});
