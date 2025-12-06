import React, { useState } from 'react';
import { adminGetAccountMessages } from '../api';

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
    <div className="settings-screen">
      <header className="settings-header">
        <button className="back-btn" onClick={() => onNavigate && onNavigate('admin-accounts')}>‹</button>
        <h1>Messages — {accountEmail}</h1>
        <div style={{width:36}} />
      </header>

      <div className="settings-content">
        <div className="section">
          <div className="section-title">hMailServer Admin</div>
          <div style={{display:'flex', gap:8}}>
            <input type="password" placeholder="hMailServer admin password" value={adminPassword} onChange={e=>setAdminPassword(e.target.value)} style={{flex:1, padding:8, borderRadius:8, border:'1px solid rgba(255,255,255,0.04)', background:'#071015', color:'#dff3ff'}} />
            <button className="primary-btn" onClick={load} disabled={!adminPassword || loading}>{loading ? 'Loading…' : 'Load Messages'}</button>
          </div>
          {error && <div style={{color:'#ffb3b3', marginTop:8}}>{error}</div>}
        </div>

        <div className="section">
          <div className="section-title">Messages</div>
          {messages.length === 0 && <div className="settings-row">No messages loaded</div>}
          {messages.map(m => (
            <div key={String(m.id)} className="settings-row" style={{flexDirection:'column', alignItems:'stretch', gap:6}}>
              <div style={{display:'flex', alignItems:'center', gap:8}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700}}>{m.subject || '(no subject)'}</div>
                  <div style={{color:'#9aa6b2', fontSize:13}}>From: {m.from} · To: {m.to}</div>
                </div>
                <div style={{textAlign:'right', fontSize:12, color:'#9aa6b2'}}>{m.date}</div>
                <button className="settings-row" onClick={()=>setExpanded(expanded===m.id?null:m.id)}>{expanded===m.id? 'Hide' : 'View'}</button>
              </div>
              {expanded===m.id && (
                <div style={{marginTop:8, padding:8, borderRadius:6, background:'#071015', color:'#dff3ff', whiteSpace:'pre-wrap'}}>
                  <div><strong>ID:</strong> {m.id}</div>
                  <div><strong>Size:</strong> {m.size || 'n/a'}</div>
                  <div style={{marginTop:8}}><strong>Raw/Full body access:</strong> This view shows header details. Use account-specific IMAP or COM export for full raw content.</div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
