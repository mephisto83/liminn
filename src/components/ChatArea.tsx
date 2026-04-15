import React, { useState, useRef, useEffect } from 'react';
import { Peer } from '../types';

interface Message {
  id: string;
  type: 'text-sent' | 'text-received' | 'file-sent' | 'file-received';
  from: string;
  content: string;
  timestamp: number;
  filePath?: string;
  fileSize?: number;
}

interface Props {
  peer: Peer;
  messages: Message[];
  onSendText: (text: string) => void;
  onSendFile: () => void;
  deviceName: string;
  progress?: number;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getPlatformLabel(platform: string): string {
  switch (platform) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return 'Device';
  }
}

export default function ChatArea({ peer, messages, onSendText, onSendFile, deviceName, progress }: Props) {
  const [text, setText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [peer.id]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSendText(text.trim());
    setText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="chat-area">
      <header className="chat-header">
        <div className="chat-header-info">
          <h2>{peer.name}</h2>
          <span className="chat-header-detail">
            {getPlatformLabel(peer.platform)} &middot; {peer.addresses[0]}
          </span>
        </div>
        <button className="send-file-header-btn" onClick={onSendFile} title="Send a file">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
      </header>

      <div className="messages-container">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p>Send a message or file to <strong>{peer.name}</strong></p>
            <p className="hint">Messages and files are sent directly over your local network</p>
          </div>
        ) : (
          <div className="messages-list">
            {messages.map((msg) => {
              const isSent = msg.type.includes('sent');
              const isFile = msg.type.includes('file');
              return (
                <div key={msg.id} className={`message ${isSent ? 'sent' : 'received'}`}>
                  <div className={`message-bubble ${isFile ? 'file-bubble' : ''}`}>
                    {isFile ? (
                      <div className="file-message">
                        <div className="file-icon-wrapper">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                        </div>
                        <div className="file-details">
                          <span className="file-name">{msg.content}</span>
                          {msg.fileSize && <span className="file-size">{formatSize(msg.fileSize)}</span>}
                        </div>
                      </div>
                    ) : (
                      <p>{msg.content}</p>
                    )}
                    <span className="message-time">{formatTime(msg.timestamp)}</span>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {progress !== undefined && progress >= 0 && (
        <div className="transfer-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="progress-text">{progress}% sent</span>
        </div>
      )}

      <form className="message-input" onSubmit={handleSubmit}>
        <button type="button" className="attach-btn" onClick={onSendFile} title="Send file">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${peer.name}...`}
          rows={1}
        />
        <button type="submit" className="send-btn" disabled={!text.trim()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
    </div>
  );
}
