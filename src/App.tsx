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

export default function App() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<Peer | null>(null);
  // Keyed by hostname (peer.name / item.from), NOT peer.id — peer.id is a
  // per-launch instance identifier that changes whenever the other side
  // restarts, which would split the conversation into a new empty thread
  // every time. Hostname is stable across restarts.
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [deviceName, setDeviceName] = useState('This Device');
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [sendProgress, setSendProgress] = useState<Record<string, number>>({});

  const addToast = useCallback((message: string, type: ToastData['type'] = 'info') => {
    const id = `toast-${Date.now()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const addMessage = useCallback((hostname: string, msg: Message) => {
    setMessages((prev) => ({
      ...prev,
      [hostname]: [...(prev[hostname] || []), msg],
    }));
  }, []);

  /**
   * Ensure there's a Peer entry for `from`. If mDNS has already discovered
   * this host, leave peers untouched. Otherwise synthesize a read-only
   * placeholder so the thread becomes selectable — without this, messages
   * from hosts that haven't been discovered (Windows Firewall eating
   * inbound mDNS, Bonjour not advertising, cross-VLAN, etc.) get stored in
   * `messages[from]` but have nowhere in the UI to appear.
   *
   * Synthetic peers are tagged `platform: 'synthetic'` so the mDNS merge
   * below can tell them apart from real peers.
   */
  const ensurePeer = useCallback((from: string, remoteAddr: string | undefined) => {
    setPeers((prev) => {
      if (prev.some((p) => p.name === from)) return prev;
      const synthetic: Peer = {
        id: `synthetic-${from}`,
        name: from,
        host: from,
        port: 0,
        addresses: remoteAddr ? [remoteAddr] : [],
        platform: 'synthetic',
      };
      return [...prev, synthetic];
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.liminn) return;

    window.liminn.getDeviceName().then(setDeviceName);
    window.liminn.getPeers().then(setPeers);

    // mDNS peer updates replace the discovered set, but we merge any
    // synthetic peers (from orphan messages) whose name isn't in the
    // incoming list — otherwise a periodic peer refresh would wipe out
    // the placeholder we created for an unreached sender.
    window.liminn.onPeersUpdated((mdnsPeers) => {
      setPeers((prev) => {
        const mdnsNames = new Set(mdnsPeers.map((p) => p.name));
        const syntheticsToKeep = prev.filter(
          (p) => p.platform === 'synthetic' && !mdnsNames.has(p.name)
        );
        return [...mdnsPeers, ...syntheticsToKeep];
      });
      // If mDNS has now discovered a host we had as a synthetic, promote
      // the selection to the real peer so sending works without the user
      // having to reselect.
      setSelectedPeer((prev) => {
        if (!prev) return prev;
        const match = mdnsPeers.find((p) => p.name === prev.name);
        return match ?? prev;
      });
    });

    window.liminn.onTextReceived((item: ReceivedText) => {
      ensurePeer(item.from, item.remoteAddr);
      addMessage(item.from, {
        id: item.id,
        type: 'text-received',
        from: item.from,
        content: item.text,
        timestamp: item.timestamp,
      });
      addToast(`Message from ${item.from}`, 'info');
    });

    window.liminn.onFileReceived((item: ReceivedFile) => {
      ensurePeer(item.from, item.remoteAddr);
      addMessage(item.from, {
        id: item.id,
        type: 'file-received',
        from: item.from,
        content: item.filename,
        timestamp: item.timestamp,
        fileSize: item.size,
      });
      addToast(`File received: ${item.filename}`, 'success');
    });

    window.liminn.onSendProgress((progress: SendProgress) => {
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
  }, [addMessage, addToast, ensurePeer]);

  const handleSendText = async (text: string) => {
    if (!selectedPeer || !window.liminn) return;
    const result = await window.liminn.sendText(selectedPeer.id, text);
    if (result.ok) {
      addMessage(selectedPeer.name, {
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
    if (!selectedPeer || !window.liminn) return;
    const result = await window.liminn.sendFile(selectedPeer.id);
    if (result.ok && result.filename) {
      addMessage(selectedPeer.name, {
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

  const peerMessages = selectedPeer ? messages[selectedPeer.name] || [] : [];

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
