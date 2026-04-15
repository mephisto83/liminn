// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import App from './App';
import type { Peer, ReceivedText, LiminnAPI } from './types';

/**
 * These tests lock in the peer-routing behavior that regressed earlier —
 * received messages must be stored under the peer's id (from the current
 * peer list), not under the sender's hostname string. Without the ref-based
 * fix in App.tsx, the listener closes over the initial peers=[] and routes
 * messages to messages[item.from] instead of messages[peer.id], and the
 * chat area (which reads messages[selectedPeer.id]) shows nothing.
 */
describe('App peer-keyed message routing', () => {
  let peersUpdatedCb: ((peers: Peer[]) => void) | null = null;
  let textReceivedCb: ((item: ReceivedText) => void) | null = null;

  beforeEach(() => {
    peersUpdatedCb = null;
    textReceivedCb = null;

    const liminn: LiminnAPI = {
      getPeers: vi.fn().mockResolvedValue([]),
      sendText: vi.fn().mockResolvedValue({ ok: true }),
      sendFile: vi.fn().mockResolvedValue({ ok: false, error: 'Cancelled' }),
      getDeviceName: vi.fn().mockResolvedValue('TestMachine'),
      getReceivedItems: vi.fn().mockResolvedValue({ texts: [], files: [] }),
      openFile: vi.fn().mockResolvedValue(undefined),
      openReceivedFolder: vi.fn().mockResolvedValue(undefined),
      onPeersUpdated: (cb) => {
        peersUpdatedCb = cb;
      },
      onTextReceived: (cb) => {
        textReceivedCb = cb;
      },
      onFileReceived: vi.fn(),
      onSendProgress: vi.fn(),
    };

    // @ts-expect-error — test-time injection of contextBridge API
    window.liminn = liminn;
  });

  afterEach(() => {
    cleanup();
    // @ts-expect-error
    delete window.liminn;
  });

  const alice: Peer = {
    id: 'peer-alice-uuid',
    name: 'alice.local',
    host: 'alice.local',
    port: 12345,
    addresses: ['192.168.1.2'],
    platform: 'darwin',
  };

  it('routes a received text to the peer matched by name, even when peers arrive after the listeners are registered', async () => {
    render(<App />);

    // Wait until initial mount's async getDeviceName resolves so the device
    // name is rendered — proxy for "useEffect has run and listeners are wired"
    await screen.findByText('TestMachine');

    expect(peersUpdatedCb).toBeTruthy();
    expect(textReceivedCb).toBeTruthy();

    // Peers arrive AFTER mount — this is the scenario that exposed the stale
    // closure: at the time onTextReceived was registered, peers was [].
    act(() => {
      peersUpdatedCb!([alice]);
    });

    // Alice shows in sidebar — click to select so the chat area renders her messages
    const aliceEntry = await screen.findByText('alice.local');
    fireEvent.click(aliceEntry);

    // Now a text arrives from alice.local
    act(() => {
      textReceivedCb!({
        id: 'msg-1',
        from: 'alice.local',
        text: 'hello from alice',
        timestamp: Date.now(),
      });
    });

    // If the routing is correct, the message ends up at messages[alice.id],
    // which is what the chat area reads when Alice is selected.
    expect(await screen.findByText('hello from alice')).toBeInTheDocument();
  });

  it('falls back to item.from as the storage key when no peer matches (does not throw)', async () => {
    render(<App />);
    await screen.findByText('TestMachine');

    act(() => {
      peersUpdatedCb!([alice]);
    });

    // Message from a sender we've never discovered — should not crash and
    // should not be routed to alice. We assert only that the app stays alive.
    act(() => {
      textReceivedCb!({
        id: 'msg-orphan',
        from: 'stranger.local',
        text: 'hi from nowhere',
        timestamp: Date.now(),
      });
    });

    // Select Alice — orphan message should NOT appear in her chat
    fireEvent.click(await screen.findByText('alice.local'));
    expect(screen.queryByText('hi from nowhere')).not.toBeInTheDocument();
  });
});
