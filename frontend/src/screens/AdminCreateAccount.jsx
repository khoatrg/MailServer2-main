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
  const [msgType, setMsgType] = useState('info');

  async function create() {
    setMsg('');
    if (!adminPassword || !address || !password) { 
      setMsg('Admin password, address and password are required'); 
      setMsgType('error');
      return; 
    }
    setBusy(true);
    try {
      const r = await adminCreateAccount({ adminPassword, address, password, active, maxSize });
      if (r && r.success) {
        setMsg('Account created successfully!');
        setMsgType('success');
        setAddress(''); 
        setPassword('');
      } else {
        setMsg(r && r.error ? r.error : 'Failed to create account');
        setMsgType('error');
      }
    } catch (e) {
      setMsg('Error: ' + (e.message || e));
      setMsgType('error');
    } finally {
      setBusy(false);
    }
  }

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
    <div className="admin-screen">
      <header className="admin-header">
        <button className="back-btn" onClick={() => onNavigate && onNavigate('admin-accounts')}>‹</button>
        <div className="admin-header-center">
          <div className="folder-dropdown" ref={folderRef}>
            <button className="trigger" onClick={() => setFolderOpen(s => !s)} aria-haspopup="menu" aria-expanded={folderOpen}>
  
              Create Account <span className="caret">▾</span>
            </button>
            {folderOpen && (
              <div className="menu" role="menu">
                <div className="item" role="menuitem" onClick={() => goFolder('admin-accounts')}>
        Accounts
                </div>
                <div className="item" role="menuitem" onClick={() => goFolder('admin-sessions')}>
 Sessions
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="admin-header-badge">Admin</div>
      </header>

      <div className="admin-content">
        {/* Auth Card */}
        <div className="admin-card admin-auth-card">
          <div className="admin-card-header">
            <h3>hMailServer Authentication</h3>
          </div>
          <div className="admin-card-body">
            <input 
              type="password" 
              placeholder="Enter admin password" 
              value={adminPassword} 
              onChange={e => setAdminPassword(e.target.value)} 
              className="admin-input"
            />
          </div>
        </div>

        {/* Create Account Form */}
        <div className="admin-card">
          <div className="admin-card-header">
            <h3>New Account Details</h3>
          </div>
          <div className="admin-card-body">
            <div className="admin-form">
              <div className="admin-form-group">
                <label className="admin-label">Email Address</label>
                <input 
                  placeholder="user@example.com" 
                  value={address} 
                  onChange={e => setAddress(e.target.value)} 
                  className="admin-input"
                />
              </div>

              <div className="admin-form-group">
                <label className="admin-label">Password</label>
                <input 
                  type="password"
                  placeholder="Enter password" 
                  value={password} 
                  onChange={e => setPassword(e.target.value)} 
                  className="admin-input"
                />
              </div>

              <div className="admin-form-row">
                <div className="admin-form-group half">
                  <label className="admin-label">Max Size (MB)</label>
                  <input 
                    type="number"
                    value={maxSize} 
                    onChange={e => setMaxSize(Number(e.target.value || 0))} 
                    className="admin-input"
                  />
                </div>
                <div className="admin-form-group half">
                  <label className="admin-label">Status</label>
                  <div className="admin-toggle-wrapper">
                    <label className="admin-toggle">
                      <input 
                        type="checkbox" 
                        checked={active} 
                        onChange={e => setActive(!!e.target.checked)} 
                      />
                      <span className="admin-toggle-slider"></span>
                    </label>
                    <span className={`admin-toggle-label ${active ? 'active' : ''}`}>
                      {active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              </div>

              {msg && (
                <div className={`admin-message ${msgType}`}>
                  {msgType === 'success' && <span className="msg-icon">✓</span>}
                  {msgType === 'error' && <span className="msg-icon">✕</span>}
                  {msg}
                </div>
              )}

              <div className="admin-form-actions">
                <button 
                  className="admin-btn secondary" 
                  onClick={() => { setAddress(''); setPassword(''); setMsg(''); }}
                >
                  Clear
                </button>
                <button 
                  className="admin-btn primary" 
                  onClick={create} 
                  disabled={busy}
                >
                  {busy ? (
                    <><span className="spinner"></span> Creating...</>
                  ) : (
                    <> Create Account</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}