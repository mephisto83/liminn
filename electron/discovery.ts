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

export class Discovery {
  private bonjour: Bonjour;
  private peers: Map<string, Peer> = new Map();
  private browser: ReturnType<Bonjour['find']> | null = null;
  private onPeersChanged: PeerCallback | null = null;
  private servicePort: number;
  private deviceName: string;
  private serviceType = 'liminn';

  constructor(port: number, deviceName?: string) {
    this.bonjour = new Bonjour();
    this.servicePort = port;
    this.deviceName = deviceName || os.hostname();
    this.instanceId = Discovery.generateInstanceId();
  }

  private instanceId: string;

  private static generateInstanceId(): string {
    const interfaces = os.networkInterfaces();
    let mac = '';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          mac = iface.mac;
          break;
        }
      }
      if (mac) break;
    }
    return `${mac || 'unknown'}-${process.pid}-${Date.now()}`;
  }

  getDeviceId(): string {
    return this.instanceId;
  }

  start(callback: PeerCallback): void {
    this.onPeersChanged = callback;

    this.bonjour.publish({
      name: `${this.deviceName}-${this.getDeviceId().slice(-5)}`,
      type: this.serviceType,
      port: this.servicePort,
      txt: {
        id: this.getDeviceId(),
        name: this.deviceName,
        platform: process.platform,
      },
    });

    this.browser = this.bonjour.find({ type: this.serviceType });

    this.browser.on('up', (service: Service) => {
      this.addPeer(service);
    });

    this.browser.on('down', (service: Service) => {
      this.removePeer(service);
    });

    setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, peer] of this.peers) {
        if (now - peer.lastSeen > 30000) {
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
    if (!peerId || peerId === this.getDeviceId()) return;

    const addresses = (service.addresses || []).filter(
      (addr: string) => !addr.includes(':')
    );

    if (addresses.length === 0) return;

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
    if (this.browser) {
      this.browser.stop();
    }
    this.bonjour.unpublishAll();
    this.bonjour.destroy();
  }
}
