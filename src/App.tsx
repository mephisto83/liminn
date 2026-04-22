import React, { useState, useEffect, useCallback } from 'react';
import { Peer, ReceivedText, ReceivedFile, SendProgress, StoredMessage } from './types';
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
  // Keyed by peer.id (machineId), which is now persistent across restarts —
  // the identity file in userData keeps it stable. Renames on the other
  // side don't split the thread because the id stays fixed while only the
  // advertised nickname changes.
  //
  // Synthetic peers (messages from hosts mDNS hasn't discovered) are keyed
  // by `item.fromId` when the sender supplied one, otherwise a
  // `synthetic-<hostname>` fallback. The fallback is migrated to the real
  // machineId the first time mDNS catches up with that host.
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [deviceName, setDeviceName] = useState('This Device');
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [sendProgress, setSendProgress] = useState<Record<string, number>>({});

  const addToast = useCallback((message: string, type: ToastData['type'] = 'info') => {
    const id = `toast-${Date.now()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const addMessage = useCallback((peerKey: string, msg: Message) => {
    setMessages((prev) => ({
      ...prev,
      [peerKey]: [...(prev[peerKey] || []), msg],
    }));
  }, []);

  /**
   * Ensure there's a Peer entry for the incoming message. If the
   * sender's machineId is already in the peer list, nothing to do.
   * Otherwise synthesize a read-only placeholder so the thread becomes
   * selectable — without this, messages from hosts that mDNS hasn't
   * discovered (firewall, cross-VLAN, legacy peer not advertising yet)
   * get stored in `messages[...]` but have nowhere in the UI to appear.
   *
   * Synthetic peers are tagged `platform: 'synthetic'` so the mDNS merge
   * below can tell them apart from real peers.
   */
  const ensurePeer = useCallback(
    (peerKey: string, from: string, remoteAddr: string | undefined) => {
      setPeers((prev) => {
        if (prev.some((p) => p.id === peerKey)) return prev;
        // If the peerKey is a synthetic fallback and we already have a
        // peer (real or synthetic) with the same display name, don't
        // create a second entry — that peer's thread is the right home.
        if (peerKey.startsWith('synthetic-') && prev.some((p) => p.name === from)) {
          return prev;
        }
        const synthetic: Peer = {
          id: peerKey,
          name: from,
          host: from,
          port: 0,
          addresses: remoteAddr ? [remoteAddr] : [],
          platform: 'synthetic',
        };
        return [...prev, synthetic];
      });
    },
    []
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.liminn) return;

    window.liminn.getDeviceName().then(setDeviceName);
    window.liminn.getPeers().then(setPeers);

    // Hydrate conversation history from the main-process log. Keyed by
    // `peerId` (machineId when known, `synthetic-<name>` otherwise), which
    // matches the live message bucket so in-session sends append to the
    // same thread, and the existing synthetic→real migration in
    // `onPeersUpdated` below still works against the hydrated state.
    window.liminn.getConversations().then((stored: StoredMessage[]) => {
      setMessages((prev) => {
        const grouped: Record<string, Message[]> = { ...prev };
        // Dedup by id across (a) React Strict Mode's double-mount, which
        // would otherwise call getConversations twice, and (b) a live
        // message racing hydration — both paths can try to add the same
        // entry. Sorting by timestamp keeps the thread in order even
        // when a live message slipped in before hydration resolved.
        for (const peerId of Object.keys(grouped)) {
          grouped[peerId] = [...grouped[peerId]];
        }

        for (const s of stored) {
          const entry: Message = {
            id: s.id,
            type:
              s.type === 'text'
                ? s.direction === 'sent'
                  ? 'text-sent'
                  : 'text-received'
                : s.direction === 'sent'
                  ? 'file-sent'
                  : 'file-received',
            from: s.from,
            content: s.content,
            timestamp: s.timestamp,
            filePath: s.filePath,
            fileSize: s.fileSize,
          };
          const bucket = grouped[s.peerId] ?? [];
          if (bucket.some((m) => m.id === entry.id)) continue;
          bucket.push(entry);
          grouped[s.peerId] = bucket;
        }

        for (const peerId of Object.keys(grouped)) {
          grouped[peerId].sort((a, b) => a.timestamp - b.timestamp);
        }
        return grouped;
      });

      // Rehydrate synthetic peer entries so persisted threads from
      // unresolved senders are selectable on startup — otherwise the
      // thread exists in `messages` but has no Sidebar row until mDNS
      // catches up (which it may never, for a LAN-gone-offline peer).
      const syntheticsToAdd = new Map<string, Peer>();
      for (const s of stored) {
        if (!s.peerId.startsWith('synthetic-')) continue;
        if (syntheticsToAdd.has(s.peerId)) continue;
        syntheticsToAdd.set(s.peerId, {
          id: s.peerId,
          name: s.peerId.slice('synthetic-'.length),
          host: s.peerId.slice('synthetic-'.length),
          port: 0,
          addresses: [],
          platform: 'synthetic',
        });
      }
      if (syntheticsToAdd.size > 0) {
        setPeers((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const existingNames = new Set(prev.map((p) => p.name));
          const additions: Peer[] = [];
          for (const [, syn] of syntheticsToAdd) {
            if (existingIds.has(syn.id)) continue;
            if (existingNames.has(syn.name)) continue;
            additions.push(syn);
          }
          return additions.length > 0 ? [...prev, ...additions] : prev;
        });
      }
    });

    // mDNS peer updates replace the discovered set, but we merge any
    // synthetic peers (from orphan messages) whose id AND name aren't in
    // the incoming list — otherwise a periodic peer refresh would wipe
    // out the placeholder we created for an unreached sender.
    //
    // When an mDNS peer's name matches a `synthetic-<name>` placeholder,
    // we migrate `messages[synthetic-<name>]` → `messages[realId]` so the
    // thread continues under the stable key instead of leaving a dangling
    // bucket.
    const unsubPeers = window.liminn.onPeersUpdated((mdnsPeers) => {
      setPeers((prev) => {
        const mdnsIds = new Set(mdnsPeers.map((p) => p.id));
        const mdnsNames = new Set(mdnsPeers.map((p) => p.name));
        const syntheticsToKeep = prev.filter(
          (p) =>
            p.platform === 'synthetic' &&
            !mdnsIds.has(p.id) &&
            !mdnsNames.has(p.name)
        );
        return [...mdnsPeers, ...syntheticsToKeep];
      });

      setMessages((prev) => {
        let next = prev;
        let mutated = false;
        for (const real of mdnsPeers) {
          const synthKey = `synthetic-${real.name}`;
          if (prev[synthKey] && !prev[real.id]) {
            if (!mutated) {
              next = { ...prev };
              mutated = true;
            }
            next[real.id] = next[synthKey];
            delete next[synthKey];
            // Mirror the in-memory migration onto the persisted log so
            // the synthetic bucket doesn't re-hydrate on next launch.
            // Fire-and-forget — the in-memory state is already correct.
            void window.liminn?.rekeyConversations(synthKey, real.id);
          }
        }
        return mutated ? next : prev;
      });

      // If the currently selected peer was a synthetic that mDNS has now
      // resolved — either by id (sender sent fromId) or by name (legacy
      // sender) — swap the selection to the real peer so sending works
      // without the user having to reselect.
      setSelectedPeer((prev) => {
        if (!prev) return prev;
        const byId = mdnsPeers.find((p) => p.id === prev.id);
        if (byId) return byId;
        if (prev.platform === 'synthetic') {
          const byName = mdnsPeers.find((p) => p.name === prev.name);
          if (byName) return byName;
        }
        return prev;
      });
    });

    const unsubText = window.liminn.onTextReceived((item: ReceivedText) => {
      const peerKey = item.fromId || `synthetic-${item.from}`;
      ensurePeer(peerKey, item.from, item.remoteAddr);
      addMessage(peerKey, {
        id: item.id,
        type: 'text-received',
        from: item.from,
        content: item.text,
        timestamp: item.timestamp,
      });
      addToast(`Message from ${item.from}`, 'info');
    });

    const unsubFile = window.liminn.onFileReceived((item: ReceivedFile) => {
      const peerKey = item.fromId || `synthetic-${item.from}`;
      ensurePeer(peerKey, item.from, item.remoteAddr);
      addMessage(peerKey, {
        id: item.id,
        type: 'file-received',
        from: item.from,
        content: item.filename,
        timestamp: item.timestamp,
        fileSize: item.size,
      });
      addToast(`File received: ${item.filename}`, 'success');
    });

    const unsubProgress = window.liminn.onSendProgress((progress: SendProgress) => {
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

    return () => {
      unsubPeers?.();
      unsubText?.();
      unsubFile?.();
      unsubProgress?.();
    };
  }, [addMessage, addToast, ensurePeer]);

  const handleSetNickname = useCallback(
    async (nextName: string): Promise<boolean> => {
      if (!window.liminn) return false;
      const result = await window.liminn.setNickname(nextName);
      if (result.ok && result.nickname) {
        setDeviceName(result.nickname);
        return true;
      }
      addToast(result.error || 'Failed to save nickname', 'error');
      return false;
    },
    [addToast]
  );

  const handleSendText = async (text: string) => {
    if (!selectedPeer || !window.liminn) return;
    const result = await window.liminn.sendText(selectedPeer.id, text);
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
    if (!selectedPeer || !window.liminn) return;
    const result = await window.liminn.sendFile(selectedPeer.id);
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
        onRenameDevice={handleSetNickname}
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
