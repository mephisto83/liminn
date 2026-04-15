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
  text: string;
  timestamp: number;
}

export interface ReceivedFile {
  id: string;
  from: string;
  filename: string;
  size: number;
  path?: string;
  timestamp: number;
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
