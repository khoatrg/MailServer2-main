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

  // Format time same as Sent screen: show HH:MM if within 24h, otherwise date
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

  return (
    <div className="admin-sessions-screen settings-screen">
      <header className="settings-header">
        <button className="back-btn" onClick={() => onNavigate && onNavigate('settings')} aria-label="Back">‹</button>
        <h1>Active Sessions</h1>
        <div style={{width:36}} />
      </header>

      <div className="settings-content">
        {err && <div className="error-text">{err}</div>}
        {loading ? (
          <div style={{padding:20}}>Loading…</div>
        ) : (
          <>
            {sessions.length === 0 ? (
              <div style={{padding:20, color:'var(--muted)'}}>No active sessions found.</div>
            ) : (
              <div className="session-list">
                {sessions.map(s => (
                  <div className="session-card" key={s.jti}>
                    <div className="session-left">
                      <div className="session-avatar">{(s.email||'').split('@')[0].slice(0,2).toUpperCase()}</div>
                    </div>

                    <div className="session-main">
                      <div className="session-row-top">
                        <div className="session-email" title={s.email}>{s.email}</div>
                        <div className="session-exp">{formatTime(s.exp || s.expiresAt)}</div>
                      </div>

                      <div className="session-row-bottom">
                        <div className="session-jti" title={s.jti}>{s.jti}</div>
                        <div className="session-action">
                          <button
                            className="primary-btn small"
                            onClick={() => handleDelete(s.jti)}
                            disabled={busyJti === s.jti}
                          >
                            {busyJti === s.jti ? 'Deleting…' : 'Delete'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}