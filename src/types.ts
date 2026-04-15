export interface Peer {
  id: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  platform: string;
}

export interface ReceivedText {
  id: string;
  from: string;
  /**
   * Sender's machineId (stable across their restarts and renames). When
   * present, it's the canonical conversation key on the receiving side —
   * threads stay unified even if the sender's nickname changes.
   * Optional because old senders may not include it.
   */
  fromId?: string;
  text: string;
  timestamp: number;
  /**
   * Socket-observed IP of the sender. Used to synthesize a peer entry
   * when a message arrives from a host mDNS hasn't yet discovered.
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
  path?: string;
  timestamp: number;
  /** See ReceivedText.remoteAddr. */
  remoteAddr?: string;
}

export interface SendProgress {
  peerId: string;
  percent: number;
  done: boolean;
}

export interface LiminnAPI {
  getPeers: () => Promise<Peer[]>;
  sendText: (peerId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  sendFile: (peerId: string) => Promise<{ ok: boolean; error?: string; filename?: string }>;
  getDeviceName: () => Promise<string>;
  getNickname: () => Promise<string>;
  setNickname: (nickname: string) => Promise<{ ok: boolean; error?: string; nickname?: string }>;
  getReceivedItems: () => Promise<{ texts: ReceivedText[]; files: ReceivedFile[] }>;
  openFile: (filePath: string) => Promise<void>;
  openReceivedFolder: () => Promise<void>;
  onPeersUpdated: (callback: (peers: Peer[]) => void) => void;
  onTextReceived: (callback: (item: ReceivedText) => void) => void;
  onFileReceived: (callback: (item: ReceivedFile) => void) => void;
  onSendProgress: (callback: (progress: SendProgress) => void) => void;
}

declare global {
  interface Window {
    liminn: LiminnAPI;
  }
}
