// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import App from './App';
import type { Peer, ReceivedText, LiminnAPI } from './types';

/**
 * These tests lock in hostname-keyed message routing. Threads are stored by
 * hostname (peer.name / item.from) so they survive a peer restart — peer.id
 * is a per-launch instance identifier that changes whenever the other side
 * relaunches, and keying by id would split the conversation into a fresh
 * empty thread every time. Since peer.name and item.from are both the
 * device hostname, they converge on a single stable key.
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

  it('synthesizes a peer when a message arrives from a host mDNS has not discovered', async () => {
    render(<App />);
    await screen.findByText('TestMachine');

    act(() => {
      peersUpdatedCb!([alice]);
    });

    // Message from a sender we've never discovered (e.g. Windows Firewall
    // ate the inbound mDNS). A synthetic peer is synthesized from the
    // sender's `from` + `remoteAddr` so the thread becomes selectable.
    act(() => {
      textReceivedCb!({
        id: 'msg-orphan',
        from: 'stranger.local',
        text: 'hi from nowhere',
        timestamp: Date.now(),
        remoteAddr: '192.168.1.240',
      });
    });

    // The synthetic peer appears in the sidebar — click to open its thread
    fireEvent.click(await screen.findByText('stranger.local'));
    expect(await screen.findByText('hi from nowhere')).toBeInTheDocument();

    // Alice's thread should still be empty — the orphan only lands in the
    // synthetic peer's bucket, not leaking into other peers' threads.
    fireEvent.click(screen.getByText('alice.local'));
    expect(screen.queryByText('hi from nowhere')).not.toBeInTheDocument();
  });

  it('preserves synthetic peers across mDNS updates that do not include them', async () => {
    render(<App />);
    await screen.findByText('TestMachine');

    act(() => {
      peersUpdatedCb!([alice]);
    });

    act(() => {
      textReceivedCb!({
        id: 'msg-orphan',
        from: 'stranger.local',
        text: 'hi',
        timestamp: Date.now(),
        remoteAddr: '192.168.1.240',
      });
    });

    await screen.findByText('stranger.local');

    // Another mDNS refresh — still only Alice discovered. The synthetic
    // peer must survive the refresh; otherwise a routine peer update would
    // wipe out every orphan thread.
    act(() => {
      peersUpdatedCb!([alice]);
    });

    expect(screen.getByText('stranger.local')).toBeInTheDocument();
  });
});
