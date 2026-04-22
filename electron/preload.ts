import { contextBridge, ipcRenderer } from 'electron';

export interface PeerInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  platform: string;
}

/**
 * Subscribe to `channel` with only-one-listener semantics: any prior
 * registration for the same channel is removed first. Without this, a
 * React Strict Mode double-mount or a Vite HMR reload would stack
 * duplicate listeners; one incoming IPC message would fan out to N
 * handlers and double-process the event. Returns an unsubscribe.
 */
function singletonOn<T>(channel: string, callback: (payload: T) => void): () => void {
  ipcRenderer.removeAllListeners(channel);
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('liminn', {
  getPeers: () => ipcRenderer.invoke('get-peers'),
  sendText: (peerId: string, text: string) => ipcRenderer.invoke('send-text', peerId, text),
  sendFile: (peerId: string) => ipcRenderer.invoke('send-file', peerId),
  getDeviceName: () => ipcRenderer.invoke('get-device-name'),
  getNickname: () => ipcRenderer.invoke('get-nickname'),
  setNickname: (nickname: string) => ipcRenderer.invoke('set-nickname', nickname),
  getReceivedItems: () => ipcRenderer.invoke('get-received-items'),
  getConversations: () => ipcRenderer.invoke('get-conversations'),
  rekeyConversations: (oldPeerId: string, newPeerId: string) =>
    ipcRenderer.invoke('rekey-conversations', oldPeerId, newPeerId),
  openFile: (filePath: string) => ipcRenderer.invoke('open-file', filePath),
  openReceivedFolder: () => ipcRenderer.invoke('open-received-folder'),

  onPeersUpdated: (callback: (peers: PeerInfo[]) => void) =>
    singletonOn('peers-updated', callback),
  onTextReceived: (
    callback: (item: {
      id: string;
      from: string;
      fromId?: string;
      text: string;
      timestamp: number;
      remoteAddr?: string;
    }) => void,
  ) => singletonOn('text-received', callback),
  onFileReceived: (
    callback: (item: {
      id: string;
      from: string;
      fromId?: string;
      filename: string;
      size: number;
      timestamp: number;
      remoteAddr?: string;
    }) => void,
  ) => singletonOn('file-received', callback),
  onSendProgress: (callback: (progress: { peerId: string; percent: number; done: boolean }) => void) =>
    singletonOn('send-progress', callback),
});
