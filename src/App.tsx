import React, { useState, useEffect, useCallback } from 'react';
import { Peer, ReceivedText, ReceivedFile, SendProgress } from './types';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import EmptyState from './components/EmptyState';
import Toast from './components/Toast';

interface Message {
  id: string;
  type: 'text-sent' | 'text-received' | 'file-sent' | 'file-received';
  from: string;
  content: string;
  timestamp: number;
  filePath?: string;
  fileSize?: number;
}

interface ToastData {
  id: string;
  message: string;
  type: 'success' | 'info' | 'error';
}

const isElectron = typeof window !== 'undefined' && window.landrop;

export default function App() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<Peer | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [deviceName, setDeviceName] = useState('This Device');
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [sendProgress, setSendProgress] = useState<Record<string, number>>({});

  const addToast = useCallback((message: string, type: ToastData['type'] = 'info') => {
    const id = `toast-${Date.now()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const addMessage = useCallback((peerId: string, msg: Message) => {
    setMessages((prev) => ({
      ...prev,
      [peerId]: [...(prev[peerId] || []), msg],
    }));
  }, []);

  useEffect(() => {
    if (!isElectron) return;

    window.landrop.getDeviceName().then(setDeviceName);
    window.landrop.getPeers().then(setPeers);

    window.landrop.onPeersUpdated((updatedPeers) => {
      setPeers(updatedPeers);
    });

    window.landrop.onTextReceived((item: ReceivedText) => {
      const peerId = findPeerIdByName(item.from);
      addMessage(peerId || item.from, {
        id: item.id,
        type: 'text-received',
        from: item.from,
        content: item.text,
        timestamp: item.timestamp,
      });
      addToast(`Message from ${item.from}`, 'info');
    });

    window.landrop.onFileReceived((item: ReceivedFile) => {
      const peerId = findPeerIdByName(item.from);
      addMessage(peerId || item.from, {
        id: item.id,
        type: 'file-received',
        from: item.from,
        content: item.filename,
        timestamp: item.timestamp,
        fileSize: item.size,
      });
      addToast(`File received: ${item.filename}`, 'success');
    });

    window.landrop.onSendProgress((progress: SendProgress) => {
      setSendProgress((prev) => ({
        ...prev,
        [progress.peerId]: progress.done ? -1 : progress.percent,
      }));
      if (progress.done) {
        setTimeout(() => {
          setSendProgress((prev) => {
            const next = { ...prev };
            delete next[progress.peerId];
            return next;
          });
        }, 1000);
      }
    });
  }, [addMessage, addToast]);

  function findPeerIdByName(name: string): string | null {
    const peer = peers.find((p) => p.name === name);
    return peer?.id || null;
  }

  const handleSendText = async (text: string) => {
    if (!selectedPeer || !isElectron) return;
    const result = await window.landrop.sendText(selectedPeer.id, text);
    if (result.ok) {
      addMessage(selectedPeer.id, {
        id: `sent-${Date.now()}`,
        type: 'text-sent',
        from: deviceName,
        content: text,
        timestamp: Date.now(),
      });
    } else {
      addToast('Failed to send message', 'error');
    }
  };

  const handleSendFile = async () => {
    if (!selectedPeer || !isElectron) return;
    const result = await window.landrop.sendFile(selectedPeer.id);
    if (result.ok && result.filename) {
      addMessage(selectedPeer.id, {
        id: `sent-${Date.now()}`,
        type: 'file-sent',
        from: deviceName,
        content: result.filename,
        timestamp: Date.now(),
      });
      addToast(`File sent: ${result.filename}`, 'success');
    } else if (result.error && result.error !== 'Cancelled') {
      addToast('Failed to send file', 'error');
    }
  };

  const peerMessages = selectedPeer ? messages[selectedPeer.id] || [] : [];

  return (
    <div className="app">
      <Sidebar
        peers={peers}
        selectedPeer={selectedPeer}
        onSelectPeer={setSelectedPeer}
        deviceName={deviceName}
        sendProgress={sendProgress}
      />
      <main className="main-area">
        {selectedPeer ? (
          <ChatArea
            peer={selectedPeer}
            messages={peerMessages}
            onSendText={handleSendText}
            onSendFile={handleSendFile}
            deviceName={deviceName}
            progress={sendProgress[selectedPeer.id]}
          />
        ) : (
          <EmptyState peerCount={peers.length} />
        )}
      </main>
      <div className="toast-container">
        {toasts.map((t) => (
          <Toast key={t.id} message={t.message} type={t.type} />
        ))}
      </div>
    </div>
  );
}
