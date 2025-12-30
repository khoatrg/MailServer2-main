import React, { useState } from 'react';
import { adminGetAccountMessages } from '../api';
import { Info } from 'lucide-react';

export default function AdminAccountMessages({ accountEmail, onNavigate }) {
  const [adminPassword, setAdminPassword] = useState('');
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);

  async function load() {
    setError('');
    setLoading(true);
    try {
      const r = await adminGetAccountMessages(accountEmail, adminPassword);
      if (r && r.success) {
        setMessages(r.messages || []);
      } else {
        setError(r && r.error ? r.error : 'Failed to load messages');
      }
    } catch (e) {
      setError(e && e.message ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-screen">
      <header className="admin-header">
        <button className="back-btn" onClick={() => onNavigate && onNavigate('admin-accounts')}>‹</button>
        <div className="admin-header-center">
          <h1>Messages</h1>
        </div>
        <div style={{ width: 36 }} />
      </header>

      <div className="admin-content">
        {/* Account Info Card */}
        <div className="admin-card">
          <div className="admin-card-body" style={{ padding: '16px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div className="account-avatar large">
                {(accountEmail || '').split('@')[0].slice(0, 2).toUpperCase()}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>{accountEmail}</span>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>Viewing messages for this account</span>
              </div>
            </div>
          </div>
        </div>

        {/* Auth Card */}
        <div className="admin-card">
          <div className="admin-card-header">
            <h3>hMailServer Authentication</h3>
          </div>
          <div className="admin-card-body">
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <input 
                type="password" 
                placeholder="Enter admin password" 
                value={adminPassword} 
                onChange={e => setAdminPassword(e.target.value)} 
                className="admin-input"
                style={{ flex: 1 }}
              />
              <button 
                className="admin-btn primary" 
                onClick={load} 
                disabled={!adminPassword || loading}
                style={{ whiteSpace: 'nowrap' }}
              >
                {loading ? 'Loading...' : 'Load Messages'}
              </button>
            </div>
            {error && <div className="admin-message error" style={{ marginTop: 12 }}>{error}</div>}
          </div>
        </div>

        {/* Messages List */}
        <div className="admin-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <div className="admin-card-header">
            <h3>Messages</h3>
            <span className="admin-badge">{messages.length}</span>
          </div>
          <div className="admin-card-body" style={{ padding: 0, flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {messages.length === 0 ? (
              <div className="admin-empty">
                <div className="admin-empty-icon">📭</div>
                <p>No messages loaded</p>
                <span>Enter admin password and click "Load Messages" to view</span>
              </div>
            ) : (
              <div className="admin-messages-list" style={{ maxHeight: 400, overflowY: 'auto' }}>
                {messages.map(m => (
                  <div key={String(m.id)} className={`admin-message-item ${expanded === m.id ? 'expanded' : ''}`}>
                    <div className="message-row" onClick={() => setExpanded(expanded === m.id ? null : m.id)}>
                      <div className="message-avatar">
                        {(m.from || '?').slice(0, 2).toUpperCase()}
                      </div>
                      <div className="message-content">
                        <div className="message-subject">{m.subject || '(no subject)'}</div>
                        <div className="message-meta">
                          <span className="meta-from">From: {m.from}</span>
                          <span className="meta-separator">•</span>
                          <span className="meta-to">To: {m.to}</span>
                        </div>
                      </div>
                      <div className="message-right">
                        <span className="message-date">{m.date}</span>
                        <span className={`expand-icon ${expanded === m.id ? 'open' : ''}`}>▾</span>
                      </div>
                    </div>
                    {expanded === m.id && (
                      <div className="message-details">
                        <div className="detail-row">
                          <span className="detail-label">ID:</span>
                          <span className="detail-value">{m.id}</span>
                        </div>
                        <div className="detail-row">
                          <span className="detail-label">Folder:</span>
                          <span className="detail-value">{m.folder || 'INBOX'}</span>
                        </div>
                        <div className="detail-row">
                          <span className="detail-label">Size:</span>
                          <span className="detail-value">{m.size ? `${Math.round(m.size / 1024)} KB` : 'n/a'}</span>
                        </div>
                        <div className="detail-note">
                          <Info size={15} />
                          This view shows header details. Use account-specific IMAP or COM export for full raw content.
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}