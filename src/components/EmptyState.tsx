import React from 'react';

interface Props {
  peerCount: number;
}

export default function EmptyState({ peerCount }: Props) {
  return (
    <div className="empty-state">
      <div className="empty-state-content">
        <div className="empty-logo">
          <svg width="80" height="80" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="url(#emptyGrad)" opacity="0.6" />
            <path d="M2 17L12 22L22 17" stroke="url(#emptyGrad)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.4" />
            <path d="M2 12L12 17L22 12" stroke="url(#emptyGrad)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
            <defs>
              <linearGradient id="emptyGrad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop stopColor="#818cf8" />
                <stop offset="1" stopColor="#c084fc" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <h2>Welcome to LANDrop</h2>
        <p className="empty-desc">
          {peerCount === 0
            ? 'Waiting for other devices on your network...'
            : `Select a device to start sharing`}
        </p>
        <div className="feature-grid">
          <div className="feature-card">
            <div className="feature-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h3>Send Text</h3>
            <p>Share messages instantly</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </div>
            <h3>Send Files</h3>
            <p>Transfer any file type</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </div>
            <h3>Auto Discover</h3>
            <p>No setup required</p>
          </div>
        </div>
      </div>
    </div>
  );
}
