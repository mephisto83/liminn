import { Bonjour, Service } from 'bonjour-service';
import os from 'os';

export interface Peer {
  id: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  platform: string;
  lastSeen: number;
}

type PeerCallback = (peers: Peer[]) => void;

type PublishedService = ReturnType<Bonjour['publish']>;

export class Discovery {
  private bonjour: Bonjour;
  private peers: Map<string, Peer> = new Map();
  private browser: ReturnType<Bonjour['find']> | null = null;
  private onPeersChanged: PeerCallback | null = null;
  private servicePort: number;
  private deviceName: string;
  private serviceType = 'liminn';
  private instanceId: string;
  private publishedService: PublishedService | null = null;
  private sweepInterval: NodeJS.Timeout | null = null;

  /**
   * @param port        Local transfer-server port to advertise.
   * @param machineId   Stable per-install identifier. Passed in (rather
   *                    than generated here) so it can be persisted
   *                    across restarts — which is what makes peer.id
   *                    usable as a conversation key on the other side.
   * @param deviceName  Initial display name (nickname). Falls back to
   *                    `os.hostname()`; can be changed at runtime via
   *                    `setDeviceName` without restarting discovery.
   */
  constructor(port: number, machineId: string, deviceName?: string) {
    this.bonjour = new Bonjour();
    this.servicePort = port;
    this.deviceName = deviceName || os.hostname();
    this.instanceId = machineId;
  }

  getDeviceId(): string {
    return this.instanceId;
  }

  getDeviceName(): string {
    return this.deviceName;
  }

  /**
   * Rename this device. The mDNS service is unpublished and
   * republished with the new `name` so peers see the update without
   * waiting for a stale-TTL refresh. The machineId stays fixed, so
   * peers keep their existing conversation threads.
   */
  setDeviceName(nextName: string): void {
    const trimmed = nextName.trim();
    if (!trimmed) return;
    if (trimmed === this.deviceName) return;
    this.deviceName = trimmed;
    this.republish();
  }

  /**
   * Begin advertising and browsing. Safe to call once; subsequent
   * renames go through `setDeviceName` → `republish()` and don't
   * re-enter here (which would duplicate the browser and sweep timer).
   */
  start(callback: PeerCallback): void {
    this.onPeersChanged = callback;
    this.publish();
    this.startBrowsing();
  }

  private republish(): void {
    // No-op if start() hasn't been called yet — deviceName will flow
    // through to the first publish naturally.
    if (!this.publishedService) return;

    const old = this.publishedService;
    this.publishedService = null;
    try {
      // `stop` is typed optional on bonjour-service's Service, but in
      // practice is always attached to a published instance. Guard just
      // in case the library ever returns something without it — a
      // missing stop would leak the old record, but that's still better
      // than a crash during a user-initiated rename.
      if (typeof old.stop === 'function') old.stop(() => undefined);
    } catch (err) {
      console.warn('[discovery] error stopping old service on republish:', err);
    }
    this.publish();
  }

  private publish(): void {
    const publishName = `${this.deviceName}-${this.getDeviceId().slice(-5)}`;
    console.log('[discovery] publishing:', {
      name: publishName,
      type: this.serviceType,
      port: this.servicePort,
      id: this.getDeviceId(),
      platform: process.platform,
    });

    const svc = this.bonjour.publish({
      name: publishName,
      type: this.serviceType,
      port: this.servicePort,
      txt: {
        id: this.getDeviceId(),
        name: this.deviceName,
        platform: process.platform,
      },
    });
    this.publishedService = svc;
    svc.on('up', () => console.log('[discovery] publish up:', publishName));
    svc.on('error', (err: Error) => console.error('[discovery] publish error:', err));
  }

  private startBrowsing(): void {
    this.browser = this.bonjour.find({ type: this.serviceType });
    console.log('[discovery] browser started for type:', this.serviceType);

    this.browser.on('up', (service: Service) => {
      console.log('[discovery] raw up event:', {
        name: service.name,
        host: service.host,
        port: service.port,
        addresses: service.addresses,
        txt: service.txt,
      });
      this.addPeer(service);
    });

    this.browser.on('down', (service: Service) => {
      console.log('[discovery] raw down event:', service.name);
      this.removePeer(service);
    });

    this.sweepInterval = setInterval(() => {
      const now = Date.now();
      let changed = false;

      // bonjour-service doesn't refire 'up' for records it already knows
      // about — including when a peer restarts on a new ephemeral port.
      // The sweep refreshes from browser.services (bonjour's authoritative
      // live cache) so that:
      //  - lastSeen stays current (we don't evict live peers)
      //  - port/addresses/name track peer restarts (the old stale-port
      //    bug: peer A restarts with a new port, peer B keeps POSTing
      //    to the dead port until a full B-side restart)
      //
      // Anything actually changed is surfaced via onPeersChanged so the
      // renderer updates its sidebar and the main process drops any
      // cached reachable address tied to the old port.
      const services = (this.browser?.services ?? []) as Service[];
      for (const service of services) {
        const id = (service.txt as Record<string, string> | undefined)?.id;
        if (!id) continue;
        const peer = this.peers.get(id);
        if (!peer) continue;

        peer.lastSeen = now;

        const addresses = (service.addresses || []).filter((addr: string) => !addr.includes(':'));
        const txt = service.txt as Record<string, string> | undefined;
        const nextName = txt?.name || service.name;

        if (peer.port !== service.port) {
          console.log(`[discovery] peer ${peer.name} port changed ${peer.port} -> ${service.port}`);
          peer.port = service.port;
          changed = true;
        }
        if (addresses.length > 0 && addresses.join(',') !== peer.addresses.join(',')) {
          console.log(`[discovery] peer ${peer.name} addresses changed ${peer.addresses.join(',')} -> ${addresses.join(',')}`);
          peer.addresses = addresses;
          changed = true;
        }
        if (nextName && nextName !== peer.name) {
          peer.name = nextName;
          changed = true;
        }
        if (service.host && service.host !== peer.host) {
          peer.host = service.host;
          changed = true;
        }
      }

      for (const [id, peer] of this.peers) {
        if (now - peer.lastSeen > 30000) {
          console.log(`[discovery] evicted stale peer: ${peer.name} (id=${id}, last seen ${Math.round((now - peer.lastSeen) / 1000)}s ago)`);
          this.peers.delete(id);
          changed = true;
        }
      }
      if (changed) this.notifyPeersChanged();
    }, 10000);
  }

  private addPeer(service: Service): void {
    const txt = service.txt as Record<string, string>;
    const peerId = txt?.id;
    if (!peerId) {
      console.log('[discovery] dropped: no txt.id on service', service.name);
      return;
    }
    if (peerId === this.getDeviceId()) {
      console.log('[discovery] dropped: self', service.name);
      return;
    }

    const addresses = (service.addresses || []).filter(
      (addr: string) => !addr.includes(':')
    );

    if (addresses.length === 0) {
      console.log('[discovery] dropped: no IPv4 addresses for', service.name, 'got:', service.addresses);
      return;
    }

    console.log('[discovery] added peer:', txt?.name || service.name, 'at', addresses.join(','));

    this.peers.set(peerId, {
      id: peerId,
      name: txt?.name || service.name,
      host: service.host,
      port: service.port,
      addresses,
      platform: txt?.platform || 'unknown',
      lastSeen: Date.now(),
    });

    this.notifyPeersChanged();
  }

  private removePeer(service: Service): void {
    const txt = service.txt as Record<string, string>;
    const peerId = txt?.id;
    if (peerId) {
      this.peers.delete(peerId);
      this.notifyPeersChanged();
    }
  }

  private notifyPeersChanged(): void {
    if (this.onPeersChanged) {
      this.onPeersChanged(Array.from(this.peers.values()));
    }
  }

  getPeers(): Peer[] {
    return Array.from(this.peers.values());
  }

  stop(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    if (this.browser) {
      this.browser.stop();
    }
    this.bonjour.unpublishAll();
    this.bonjour.destroy();
  }
}
