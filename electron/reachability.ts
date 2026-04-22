import http from 'http';

/**
 * Minimal shape of a peer needed for reachability probing — extracted
 * so tests can build a fixture without depending on the full `Peer`
 * type from discovery.ts (which pulls in bonjour-service).
 */
export interface Reachable {
  id: string;
  name: string;
  addresses: string[];
  port: number;
}

/**
 * Issue a single `GET /api/ping` against `addr:port`. Resolves `true`
 * only on a 200 response; any network error, non-200 status, or the
 * timeout firing resolves `false`. Never throws.
 */
export function probeAddress(addr: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: addr, port, path: '/api/ping', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Pick the first advertised address on `peer` that answers `/api/ping`.
 * Probes in parallel so dead addresses don't cost a full timeout each
 * (bonjour commonly lists VPN / Docker / link-local IPs ahead of the
 * real LAN IP, and sequential probing would wait 2s per dead one).
 *
 * The cache is passed in — not a module global — so the cache lifetime
 * matches whoever owns it (the Electron main process), and tests can
 * supply an isolated cache per run. A cached address is trusted only
 * if the peer still advertises it; stale entries are dropped first.
 */
export async function pickReachableAddress(
  peer: Reachable,
  cache: Map<string, string>,
  probe: (addr: string, port: number) => Promise<boolean> = probeAddress,
): Promise<string | null> {
  const cached = cache.get(peer.id);
  if (cached && peer.addresses.includes(cached)) return cached;
  cache.delete(peer.id);

  if (peer.addresses.length === 0) return null;

  const attempts = peer.addresses.map(
    (addr) =>
      new Promise<string>((resolve, reject) => {
        probe(addr, peer.port).then((ok) => (ok ? resolve(addr) : reject()));
      }),
  );

  try {
    const winner = await Promise.any(attempts);
    cache.set(peer.id, winner);
    return winner;
  } catch {
    return null;
  }
}
