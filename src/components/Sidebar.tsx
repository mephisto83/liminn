import React from 'react';
import { Peer } from '../types';

interface Props {
  peers: Peer[];
  selectedPeer: Peer | null;
  onSelectPeer: (peer: Peer) => void;
  deviceName: string;
  sendProgress: Record<string, number>;
}

function getPlatformIcon(platform: string): string {
  switch (platform) {
    case 'darwin': return '🍎';
    case 'win32': return '🪟';
    case 'linux': return '🐧';
    default: return '💻';
  }
}

function getPlatformLabel(platform: string): string {
  switch (platform) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return 'Device';
  }
}

export default function Sidebar({ peers, selectedPeer, onSelectPeer, deviceName, sendProgress }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="app-logo">
          <div className="logo-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="url(#grad1)" />
              <path d="M2 17L12 22L22 17" stroke="url(#grad1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 12L12 17L22 12" stroke="url(#grad1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <defs>
                <linearGradient id="grad1" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#818cf8" />
                  <stop offset="1" stopColor="#c084fc" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div className="app-title">
            <h1>Liminn</h1>
            <span className="device-name">{deviceName}</span>
          </div>
        </div>
      </div>

      <div className="sidebar-section-label">
        <span className="dot online" />
        Devices on network
        <span className="peer-count">{peers.length}</span>
      </div>

      <nav className="peer-list">
        {peers.length === 0 ? (
          <div className="no-peers">
            <div className="scanning-animation">
              <div className="scan-ring" />
              <div className="scan-ring delay" />
            </div>
            <p>Scanning network...</p>
            <p className="hint">Other devices running Liminn will appear here</p>
          </div>
        ) : (
          peers.map((peer) => (
            <button
              key={peer.id}
              className={`peer-item ${selectedPeer?.id === peer.id ? 'active' : ''}`}
              onClick={() => onSelectPeer(peer)}
            >
              <div className="peer-avatar">
                <span>{getPlatformIcon(peer.platform)}</span>
                <span className="status-dot" />
              </div>
              <div className="peer-info">
                <span className="peer-name">{peer.name}</span>
                <span className="peer-platform">{getPlatformLabel(peer.platform)}</span>
              </div>
              {sendProgress[peer.id] !== undefined && sendProgress[peer.id] >= 0 && (
                <div className="peer-progress">
                  <div className="progress-ring">
                    <svg viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
                      <circle
                        cx="12" cy="12" r="10" fill="none" stroke="#818cf8" strokeWidth="2"
                        strokeDasharray={`${(sendProgress[peer.id] / 100) * 62.8} 62.8`}
                        strokeLinecap="round"
                        transform="rotate(-90 12 12)"
                      />
                    </svg>
                  </div>
                </div>
              )}
            </button>
          ))
        )}
      </nav>

      <div className="sidebar-footer">
        <button
          className="open-folder-btn"
          onClick={() => window.liminn?.openReceivedFolder()}
          title="Open received files folder"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          Received Files
        </button>
      </div>
    </aside>
  );
}
