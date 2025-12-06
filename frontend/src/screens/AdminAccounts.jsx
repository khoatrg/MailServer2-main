import React, { useState, useEffect, useRef } from 'react';
import { adminListAccounts, adminChangeAccountPassword, adminDeleteAccount } from '../api';

export default function AdminAccounts({ onNavigate }) {
  const [adminPassword, setAdminPassword] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState({}); // { address: newPassword }
  const [message, setMessage] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const hdrRef = useRef(null);

  useEffect(() => {
    // ensure the screen has helpful info on mount
    if (!message) setMessage('Enter the hMailServer administrator password and click "List Accounts".');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onDoc(e) { if (hdrRef.current && !hdrRef.current.contains(e.target)) setMenuOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  async function loadAccounts() {
    setLoading(true);
    setMessage('');
    try {
      const r = await adminListAccounts(adminPassword);
      if (r && r.success) {
        setAccounts(r.accounts || []);
        setMessage('');
      } else {
        setMessage(r && r.error ? r.error : 'Failed to list accounts');
      }
    } catch (e) {
      setMessage('Error: ' + (e.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function changePassword(addr) {
    const np = editing[addr];
    if (!np || np.length < 4) { alert('Enter a new password (min 4 chars)'); return; }
    setLoading(true);
    try {
      const r = await adminChangeAccountPassword(addr, adminPassword, np);
      if (r && r.success) {
        alert('Password updated for ' + addr);
        setEditing(prev => { const c = { ...prev }; delete c[addr]; return c; });
      } else {
        alert('Failed: ' + (r && r.error ? r.error : 'unknown'));
      }
    } catch (e) {
      alert('Error: ' + (e.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function deleteAccount(addr) {
    if (!window.confirm(`Permanently delete account ${addr}? This cannot be undone.`)) return;
    setLoading(true);
    try {
      const r = await adminDeleteAccount(addr, adminPassword);
      if (r && r.success) {
        alert('Account deleted: ' + addr);
        setAccounts(prev => prev.filter(a => a.address !== addr));
      } else {
        alert('Delete failed: ' + (r && r.error ? r.error : 'unknown'));
      }
    } catch (e) {
      alert('Error: ' + (e.message || e));
    } finally {
      setLoading(false);
    }
  }

   // dropdown state
  const [folderOpen, setFolderOpen] = useState(false);
  const folderRef = useRef(null);
  useEffect(() => {
    function onDoc(e) {
      if (!folderRef.current) return;
      if (!folderRef.current.contains(e.target)) setFolderOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function goFolder(target) {
    setFolderOpen(false);
    if (onNavigate) onNavigate(target);
  }

  return (
    <div className="settings-screen">
      <header className="settings-header" ref={hdrRef}>
        <button className="back-btn" onClick={() => onNavigate && onNavigate('inbox')}>‹</button>
        <div style={{display:'flex', alignItems:'center', gap:8}}>
          <div className="folder-dropdown" ref={folderRef}>
          <button className="trigger" onClick={() => setFolderOpen(s => !s)} aria-haspopup="menu" aria-expanded={folderOpen}>
            Admin — Accounts <span className="caret">▾</span>
          </button>
          {folderOpen && (
            <div className="menu" role="menu">
              <div className="item" role="menuitem" onClick={() => goFolder('admin-create')}>Create Account</div>
              <div className="item" role="menuitem" onClick={() => loadAccounts()}>Refresh List</div>
            </div>
          )}
        </div>
        </div>
        <div style={{width:36}} />
      </header>

      <div className="settings-content">
        <div className="section">
          <div className="section-title">HMailServer Admin</div>
          <div style={{display:'flex', gap:8, alignItems:'center'}}>
            <input value={adminPassword} onChange={e=>setAdminPassword(e.target.value)} type="password" placeholder="hMailServer admin password" style={{flex:1, padding:8, borderRadius:8, border:'1px solid rgba(255,255,255,0.04)', background:'#071015', color:'#dff3ff'}} />
            <button className="primary-btn" onClick={loadAccounts} disabled={!adminPassword || loading}>{loading ? 'Loading…' : 'List Accounts'}</button>
          </div>
          {message && <div style={{color:'#ffb3b3', marginTop:8}}>{message}</div>}
        </div>

        <div className="section">
          <div className="section-title">Accounts</div>
          {accounts.length === 0 && <div className="settings-row">No accounts loaded</div>}
          {accounts.map(a => (
            <div key={a.address} className="settings-row" style={{alignItems:'center'}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:800}}>{a.address}</div>
                <div style={{color:'#9aa6b2', fontSize:13}}>{a.domain}</div>
              </div>
              <div style={{display:'flex', gap:8, alignItems:'center'}}>
                <input value={editing[a.address]||''} onChange={e=>setEditing(prev=>({ ...prev, [a.address]: e.target.value }))} placeholder="new password" style={{padding:8, borderRadius:8, border:'1px solid rgba(255,255,255,0.04)', background:'#071015', color:'#dff3ff'}} />
                <button className="primary-btn" style={{padding:'8px 10px', minWidth:100}} onClick={()=>changePassword(a.address)} disabled={!adminPassword || loading}>Change</button>
                <button className="list-delete-btn" title="Delete account" onClick={()=>deleteAccount(a.address)} disabled={!adminPassword || loading} style={{marginLeft:4}}>Delete</button>
                <button className="settings-row" style={{marginLeft:6, padding:'6px 8px'}} onClick={() => { if (onNavigate) onNavigate('admin-account-messages::' + encodeURIComponent(a.address)); }} disabled={!adminPassword || loading}>View</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
