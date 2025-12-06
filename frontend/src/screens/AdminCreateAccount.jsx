import React, { useState, useEffect, useRef } from 'react';
import { adminCreateAccount } from '../api';

export default function AdminCreateAccount({ onNavigate }) {
  const [adminPassword, setAdminPassword] = useState('');
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [maxSize, setMaxSize] = useState(100);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function create() {
    setMsg('');
    if (!adminPassword || !address || !password) { setMsg('admin password, address and password required'); return; }
    setBusy(true);
    try {
      const r = await adminCreateAccount({ adminPassword, address, password, active, maxSize });
      if (r && r.success) {
        setMsg('Account created');
        setAddress(''); setPassword('');
      } else {
        setMsg(r && r.error ? r.error : 'Failed to create account');
      }
    } catch (e) {
      setMsg('Error: ' + (e.message || e));
    } finally {
      setBusy(false);
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
      <header className="settings-header">
        <button className="back-btn" onClick={() => onNavigate && onNavigate('admin-accounts')}>‹</button>
        <div className="folder-dropdown" ref={folderRef}>
          <button className="trigger" onClick={() => setFolderOpen(s => !s)} aria-haspopup="menu" aria-expanded={folderOpen}>
            Create Account <span className="caret">▾</span>
          </button>
          {folderOpen && (
            <div className="menu" role="menu">
               <div className="item" role="menuitem" onClick={() => goFolder('admin-accounts')}>Accounts</div>
            </div>
          )}
        </div>
        <div style={{width:36}} />
      </header>

      <div className="settings-content">
        <div className="section">
          <div className="section-title">hMailServer Admin</div>
          <input type="password" placeholder="hMailServer admin password" value={adminPassword} onChange={e=>setAdminPassword(e.target.value)} style={{flex:1, padding:8, borderRadius:8, border:'1px solid rgba(255,255,255,0.04)', background:'#071015', color:'#dff3ff'}} />
        </div>

        <div className="section">
          <div className="section-title">Account</div>
          <input placeholder="address (user@example.com)" value={address} onChange={e=>setAddress(e.target.value)} style={{flex:1, padding:8, borderRadius:8, border:'1px solid rgba(255,255,255,0.04)', background:'#071015', color:'#dff3ff'}} />
          <input placeholder="password" value={password} onChange={e=>setPassword(e.target.value)} style={{flex:1, padding:8, borderRadius:8, border:'1px solid rgba(255,255,255,0.04)', background:'#071015', color:'#dff3ff'}} />
          <div style={{display:'flex', gap:8, alignItems:'center', marginTop:6}}>
            <label><input type="checkbox" checked={active} onChange={e=>setActive(!!e.target.checked)} /> Active</label>
            <label style={{marginLeft:12}}>Max Size (MB) <input  value={maxSize} onChange={e=>setMaxSize(Number(e.target.value||0))} style={{flex:1, padding:8, borderRadius:8, border:'1px solid rgba(255,255,255,0.04)', background:'#071015', color:'#dff3ff'}} /></label>
          </div>
          <div style={{marginTop:12, display:'flex', gap:8}}>
            <button className="primary-btn" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create Account'}</button>
            <button className="list-delete-btn" style={{marginTop:12, display:'flex', gap:8}} onClick={()=>{ setAddress(''); setPassword(''); setMsg(''); }}>Clear</button>
          </div>
          {msg && <div style={{marginTop:8, color:'#ffb3b3'}}>{msg}</div>}
        </div>
      </div>
    </div>
  );
}
