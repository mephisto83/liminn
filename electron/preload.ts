import { contextBridge, ipcRenderer } from 'electron';

export interface PeerInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  platform: string;
}

contextBridge.exposeInMainWorld('liminn', {
  getPeers: () => ipcRenderer.invoke('get-peers'),
  sendText: (peerId: string, text: string) => ipcRenderer.invoke('send-text', peerId, text),
  sendFile: (peerId: string) => ipcRenderer.invoke('send-file', peerId),
  getDeviceName: () => ipcRenderer.invoke('get-device-name'),
  getNickname: () => ipcRenderer.invoke('get-nickname'),
  setNickname: (nickname: string) => ipcRenderer.invoke('set-nickname', nickname),
  getReceivedItems: () => ipcRenderer.invoke('get-received-items'),
  openFile: (filePath: string) => ipcRenderer.invoke('open-file', filePath),
  openReceivedFolder: () => ipcRenderer.invoke('open-received-folder'),

  onPeersUpdated: (callback: (peers: PeerInfo[]) => void) => {
    ipcRenderer.on('peers-updated', (_event, peers) => callback(peers));
  },
  onTextReceived: (callback: (item: { id: string; from: string; fromId?: string; text: string; timestamp: number; remoteAddr?: string }) => void) => {
    ipcRenderer.on('text-received', (_event, item) => callback(item));
  },
  onFileReceived: (callback: (item: { id: string; from: string; fromId?: string; filename: string; size: number; timestamp: number; remoteAddr?: string }) => void) => {
    ipcRenderer.on('file-received', (_event, item) => callback(item));
  },
  onSendProgress: (callback: (progress: { peerId: string; percent: number; done: boolean }) => void) => {
    ipcRenderer.on('send-progress', (_event, progress) => callback(progress));
  },
});
