// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import App from './App';
import type { Peer, ReceivedText, LiminnAPI, StoredMessage } from './types';

// Peer names appear in both the sidebar (`.peer-name`) and the chat
// header (`<h2>` in ChatArea) once a thread is open. Scope sidebar-
// oriented assertions to the aside so "is this peer listed?" is clear.
const sidebar = () => within(document.querySelector('aside.sidebar') as HTMLElement);

/**
 * These tests lock in machineId-keyed message routing. Threads are
 * stored by the sender's stable machineId (peer.id / item.fromId), not
 * by hostname — machineId is now persisted in `<userData>/identity.json`
 * so it survives restarts, while nicknames can change over time. Keying
 * by hostname would split the thread when the sender renames themselves;
 * keying by machineId holds the conversation together.
 */
describe('App peer-keyed message routing', () => {
  let peersUpdatedCb: ((peers: Peer[]) => void) | null = null;
  let textReceivedCb: ((item: ReceivedText) => void) | null = null;
  let setNickname: LiminnAPI['setNickname'];
  let rekeyConversations: ReturnType<typeof vi.fn<LiminnAPI['rekeyConversations']>>;

  beforeEach(() => {
    peersUpdatedCb = null;
    textReceivedCb = null;
    setNickname = vi.fn(async (_nickname: string) => ({ ok: true, nickname: 'Renamed' }));
    rekeyConversations = vi.fn(async () => ({ ok: true }));

    const noop = () => undefined;
    const liminn: LiminnAPI = {
      getPeers: async () => [],
      sendText: async () => ({ ok: true }),
      sendFile: async () => ({ ok: false, error: 'Cancelled' }),
      getDeviceName: async () => 'TestMachine',
      getNickname: async () => 'TestMachine',
      setNickname,
      getReceivedItems: async () => ({ texts: [], files: [] }),
      getConversations: async () => [],
      rekeyConversations,
      openFile: async () => undefined,
      openReceivedFolder: async () => undefined,
      onPeersUpdated: (cb) => {
        peersUpdatedCb = cb;
        return noop;
      },
      onTextReceived: (cb) => {
        textReceivedCb = cb;
        return noop;
      },
      onFileReceived: () => noop,
      onSendProgress: () => noop,
    };

    window.liminn = liminn;
  });

  afterEach(() => {
    cleanup();
    // @ts-expect-error
    delete window.liminn;
  });

  const alice: Peer = {
    id: 'alice-machine-uuid',
    name: 'Alice-Studio',
    host: 'alice.local',
    port: 12345,
    addresses: ['192.168.1.2'],
    platform: 'darwin',
  };

  it('routes a received text to the peer matched by machineId, even when peers arrive after listeners are registered', async () => {
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

    // Click Alice's entry so her thread renders
    const aliceEntry = await screen.findByText('Alice-Studio');
    fireEvent.click(aliceEntry);

    // Message arrives carrying alice's machineId — the stable key
    act(() => {
      textReceivedCb!({
        id: 'msg-1',
        from: 'Alice-Studio',
        fromId: alice.id,
        text: 'hello from alice',
        timestamp: Date.now(),
      });
    });

    expect(await screen.findByText('hello from alice')).toBeInTheDocument();
  });

  it('keeps the thread unified when the sender renames themselves mid-conversation', async () => {
    render(<App />);
    await screen.findByText('TestMachine');

    act(() => {
      peersUpdatedCb!([alice]);
    });

    fireEvent.click(await screen.findByText('Alice-Studio'));

    act(() => {
      textReceivedCb!({
        id: 'msg-before-rename',
        from: 'Alice-Studio',
        fromId: alice.id,
        text: 'before rename',
        timestamp: Date.now(),
      });
    });

    expect(await screen.findByText('before rename')).toBeInTheDocument();

    // Alice republishes with a new nickname — same machineId
    const renamedAlice: Peer = { ...alice, name: 'Alice-Laptop' };
    act(() => {
      peersUpdatedCb!([renamedAlice]);
    });

    // A second message arrives after the rename, carrying the same fromId
    act(() => {
      textReceivedCb!({
        id: 'msg-after-rename',
        from: 'Alice-Laptop',
        fromId: alice.id,
        text: 'after rename',
        timestamp: Date.now(),
      });
    });

    // Sidebar shows the new name, and the thread contains BOTH messages —
    // proof the rename didn't fork the conversation.
    await sidebar().findByText('Alice-Laptop');
    expect(screen.getByText('before rename')).toBeInTheDocument();
    expect(await screen.findByText('after rename')).toBeInTheDocument();
  });

  it('synthesizes a peer (keyed by fromId) when a message arrives from a machine mDNS has not discovered', async () => {
    render(<App />);
    await screen.findByText('TestMachine');

    act(() => {
      peersUpdatedCb!([alice]);
    });

    act(() => {
      textReceivedCb!({
        id: 'msg-orphan',
        from: 'Stranger',
        fromId: 'stranger-machine-uuid',
        text: 'hi from nowhere',
        timestamp: Date.now(),
        remoteAddr: '192.168.1.240',
      });
    });

    fireEvent.click(await screen.findByText('Stranger'));
    expect(await screen.findByText('hi from nowhere')).toBeInTheDocument();

    // Alice's thread stays empty — the orphan only lands in the stranger's
    // bucket, not leaking into other peers.
    fireEvent.click(screen.getByText('Alice-Studio'));
    expect(screen.queryByText('hi from nowhere')).not.toBeInTheDocument();
  });

  it('falls back to a synthetic-<name> key when the sender did not supply fromId (legacy peer)', async () => {
    render(<App />);
    await screen.findByText('TestMachine');

    act(() => {
      peersUpdatedCb!([alice]);
    });

    act(() => {
      textReceivedCb!({
        id: 'msg-legacy',
        from: 'Legacy-Host',
        text: 'from an old build',
        timestamp: Date.now(),
        remoteAddr: '192.168.1.241',
      });
    });

    fireEvent.click(await screen.findByText('Legacy-Host'));
    expect(await screen.findByText('from an old build')).toBeInTheDocument();
  });

  it('migrates a synthetic-<name> thread onto the real machineId once mDNS discovers that host', async () => {
    render(<App />);
    await screen.findByText('TestMachine');

    // Legacy-style orphan arrives before mDNS sees the host
    act(() => {
      textReceivedCb!({
        id: 'msg-legacy',
        from: 'Bob-Desktop',
        text: 'before discovery',
        timestamp: Date.now(),
        remoteAddr: '192.168.1.50',
      });
    });

    // Select the synthetic Bob
    fireEvent.click(await screen.findByText('Bob-Desktop'));
    expect(await screen.findByText('before discovery')).toBeInTheDocument();

    // mDNS now catches up — the real Bob shows up with a stable machineId
    const bob: Peer = {
      id: 'bob-machine-uuid',
      name: 'Bob-Desktop',
      host: 'bob.local',
      port: 23456,
      addresses: ['192.168.1.50'],
      platform: 'win32',
    };
    act(() => {
      peersUpdatedCb!([bob]);
    });

    // A new message arrives, this time with fromId set — it must land in
    // the same thread as the pre-discovery message (migrated to bob.id).
    act(() => {
      textReceivedCb!({
        id: 'msg-after-discovery',
        from: 'Bob-Desktop',
        fromId: bob.id,
        text: 'after discovery',
        timestamp: Date.now(),
      });
    });

    // Only one Bob in the sidebar — the synthetic got replaced, not
    // duplicated — and both messages live under the real peer.
    await waitFor(() => {
      expect(sidebar().getAllByText('Bob-Desktop')).toHaveLength(1);
    });
    expect(screen.getByText('before discovery')).toBeInTheDocument();
    expect(await screen.findByText('after discovery')).toBeInTheDocument();
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
        from: 'Stranger',
        fromId: 'stranger-machine-uuid',
        text: 'hi',
        timestamp: Date.now(),
        remoteAddr: '192.168.1.240',
      });
    });

    await screen.findByText('Stranger');

    // Another mDNS refresh — still only Alice discovered. The synthetic
    // must survive or routine peer refreshes would wipe out orphan threads.
    act(() => {
      peersUpdatedCb!([alice]);
    });

    expect(screen.getByText('Stranger')).toBeInTheDocument();
  });

  it('hydrates persisted conversations into the live message state on mount', async () => {
    const stored: StoredMessage[] = [
      {
        id: 'hist-1',
        peerId: alice.id,
        direction: 'received',
        type: 'text',
        from: 'Alice-Studio',
        content: 'hello from yesterday',
        timestamp: 1_700_000_000_000,
      },
      {
        id: 'hist-2',
        peerId: alice.id,
        direction: 'sent',
        type: 'text',
        from: 'TestMachine',
        content: 'and my reply',
        timestamp: 1_700_000_001_000,
      },
    ];
    window.liminn.getConversations = async () => stored;

    render(<App />);
    await screen.findByText('TestMachine');

    act(() => {
      peersUpdatedCb!([alice]);
    });

    fireEvent.click(await screen.findByText('Alice-Studio'));
    expect(await screen.findByText('hello from yesterday')).toBeInTheDocument();
    expect(screen.getByText('and my reply')).toBeInTheDocument();
  });

  it('reconstructs a synthetic peer row from a hydrated synthetic-keyed message', async () => {
    // Previous session received a message from Bob before mDNS resolved
    // him — stored under synthetic-Bob-Desktop. On this startup Bob still
    // isn't on the network; the thread must still be selectable.
    window.liminn.getConversations = async () => [
      {
        id: 'hist-bob',
        peerId: 'synthetic-Bob-Desktop',
        direction: 'received',
        type: 'text',
        from: 'Bob-Desktop',
        content: 'offline message',
        timestamp: 1_700_000_000_000,
      },
    ];

    render(<App />);
    await screen.findByText('TestMachine');

    fireEvent.click(await sidebar().findByText('Bob-Desktop'));
    expect(await screen.findByText('offline message')).toBeInTheDocument();
  });

  it('does not duplicate hydrated messages under React Strict Mode double-mount', async () => {
    const stored: StoredMessage[] = [
      {
        id: 'hist-dup',
        peerId: alice.id,
        direction: 'received',
        type: 'text',
        from: 'Alice-Studio',
        content: 'only once please',
        timestamp: 1_700_000_000_000,
      },
    ];
    window.liminn.getConversations = async () => stored;

    // <StrictMode> intentionally runs mount effects twice, which would
    // otherwise call getConversations → setMessages twice and duplicate
    // every persisted entry if the merge weren't id-deduped.
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByText('TestMachine');

    act(() => {
      peersUpdatedCb!([alice]);
    });

    fireEvent.click(await screen.findByText('Alice-Studio'));
    await screen.findByText('only once please');

    expect(screen.getAllByText('only once please')).toHaveLength(1);
  });

  it('calls rekeyConversations when a synthetic thread migrates to a real machineId', async () => {
    render(<App />);
    await screen.findByText('TestMachine');

    // Legacy-style orphan arrives from Bob before mDNS knows him.
    act(() => {
      textReceivedCb!({
        id: 'msg-legacy',
        from: 'Bob-Desktop',
        text: 'hi',
        timestamp: Date.now(),
        remoteAddr: '192.168.1.50',
      });
    });
    await sidebar().findByText('Bob-Desktop');

    // mDNS resolves Bob — migration should fire rekeyConversations.
    const bob: Peer = {
      id: 'bob-machine-uuid',
      name: 'Bob-Desktop',
      host: 'bob.local',
      port: 23456,
      addresses: ['192.168.1.50'],
      platform: 'win32',
    };
    act(() => {
      peersUpdatedCb!([bob]);
    });

    await waitFor(() => {
      expect(rekeyConversations).toHaveBeenCalledWith('synthetic-Bob-Desktop', bob.id);
    });
  });

  it('sends the nickname change through the IPC bridge when the sidebar label is edited', async () => {
    render(<App />);
    await screen.findByText('TestMachine');

    fireEvent.click(screen.getByText('TestMachine'));

    const input = await screen.findByLabelText('Device nickname');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(setNickname).toHaveBeenCalledWith('Renamed');
    });
    expect(await screen.findByText('Renamed')).toBeInTheDocument();
  });
});
