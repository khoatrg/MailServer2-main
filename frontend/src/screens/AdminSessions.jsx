import React, { useState, useEffect } from 'react';
import { adminListSessions, adminDeleteSession } from '../api';

export default function AdminSessions({ onNavigate }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyJti, setBusyJti] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setErr('');
      try {
        const r = await adminListSessions();
        if (mounted) setSessions(r && r.sessions ? r.sessions : []);
      } catch (e) {
        if (mounted) setErr(e && e.message ? e.message : 'Failed to load sessions');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, []);

  async function handleDelete(jti) {
    if (!window.confirm('Revoke this session?')) return;
    setBusyJti(jti);
    try {
      const r = await adminDeleteSession(jti);
      if (r && r.success) {
        setSessions(prev => prev.filter(s => s.jti !== jti));
      } else {
        alert('Delete failed: ' + (r && r.error ? r.error : 'unknown'));
      }
    } catch (e) {
      alert('Delete error: ' + (e && e.message ? e.message : e));
    } finally {
      setBusyJti(null);
    }
  }

  function formatTime(dateInput) {
    if (!dateInput && dateInput !== 0) return '';
    const d = (typeof dateInput === 'number') ? new Date(dateInput) : new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    const now = new Date();
    const diff = now - d;
    if (diff < 1000 * 60 * 60 * 24) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString();
  }

  function getTimeStatus(dateInput) {
    if (!dateInput && dateInput !== 0) return 'unknown';
    const d = (typeof dateInput === 'number') ? new Date(dateInput) : new Date(dateInput);
    if (isNaN(d.getTime())) return 'unknown';
    const now = new Date();
    const diff = d - now;
    if (diff < 0) return 'expired';
    if (diff < 1000 * 60 * 60) return 'expiring';
    return 'active';
  }

  return (
    <div className="admin-screen">
      <header className="admin-header">
        <button className="back-btn" onClick={() => onNavigate && onNavigate('admin-accounts')} aria-label="Back">‹</button>
        <div className="admin-header-center">
          <h1>Active Sessions</h1>
        </div>
        <div style={{ width: 36 }} />
      </header>

      <div className="admin-content">
        {err && <div className="admin-message error">{err}</div>}
        
        {loading ? (
          <div className="admin-loading">
            <div className="loading-spinner large"></div>
            <p>Loading sessions...</p>
          </div>
        ) : (
          <div className="admin-card" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div className="admin-card-header">
              <h3>Sessions</h3>
              <span className="admin-badge">{sessions.length}</span>
            </div>
            <div className="admin-card-body" style={{ padding: 0, flex: 1, minHeight: 0, overflow: 'hidden' }}>
              {sessions.length === 0 ? (
                <div className="admin-empty">
                  <div className="admin-empty-icon">🔒</div>
                  <p>No active sessions found</p>
                </div>
              ) : (
                <div className="admin-sessions-wrapper">
                  {sessions.map(s => {
                    const status = getTimeStatus(s.exp || s.expiresAt);
                    return (
                      <div className="admin-session-card" key={s.jti}>
                        <div className="session-header">
                          <div className="session-avatar">
                            {(s.email || '').split('@')[0].slice(0, 2).toUpperCase()}
                          </div>
                          <div className="session-info">
                            <span className="session-email" title={s.email}>{s.email}</span>
                            <span className="session-jti" title={s.jti}>ID: {s.jti.slice(0, 12)}...</span>
                          </div>
                        </div>
                        <div className="session-footer">
                          <div className={`session-status ${status}`}>
                            <span className="status-dot"></span>
                            <span className="status-label">
                              {status === 'expired' ? 'Expired' : status === 'expiring' ? 'Expiring soon' : 'Active'}
                            </span>
                            <span className="status-time">{formatTime(s.exp || s.expiresAt)}</span>
                          </div>
                          <button
                            className="admin-btn small danger"
                            onClick={() => handleDelete(s.jti)}
                            disabled={busyJti === s.jti}
                          >
                            {busyJti === s.jti ? 'Revoking...' : 'Revoke'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}