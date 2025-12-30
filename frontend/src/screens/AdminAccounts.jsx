import React, { useState, useEffect, useRef } from 'react';
import { adminListAccounts, adminChangeAccountPassword, adminDeleteAccount } from '../api';

export default function AdminAccounts({ onNavigate }) {
  const [adminPassword, setAdminPassword] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState({});
  const [message, setMessage] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const hdrRef = useRef(null);

  useEffect(() => {
    if (!message) setMessage('Enter the hMailServer administrator password and click "List Accounts".');
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
      <header className="admin-header" ref={hdrRef}>
        <button className="back-btn" onClick={() => onNavigate && onNavigate('inbox')}>‹</button>
        <div className="admin-header-center">
          <div className="folder-dropdown" ref={folderRef}>
            <button className="trigger" onClick={() => setFolderOpen(s => !s)} aria-haspopup="menu" aria-expanded={folderOpen}>
              Accounts <span className="caret">▾</span>
            </button>
            {folderOpen && (
              <div className="menu" role="menu">
                <div className="item" role="menuitem" onClick={() => goFolder('admin-create')}>
                  Create Account
                </div>
                <div className="item" role="menuitem" onClick={() => goFolder('admin-sessions')}>
                  Sessions
                </div>
                <div className="divider"></div>
                <div className="item" role="menuitem" onClick={() => loadAccounts()}>
                  Refresh List
                </div>
              </div>
            )}
          </div>
        </div>
        <div style={{ width: 36 }} />
      </header>

      <div className="admin-content">
        {/* Auth Card */}
        <div className="admin-card">
          <div className="admin-card-header">
            <h3>hMailServer Authentication</h3>
          </div>
          <div className="admin-card-body">
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <input 
                value={adminPassword} 
                onChange={e => setAdminPassword(e.target.value)} 
                type="password" 
                placeholder="Enter admin password" 
                className="admin-input"
                style={{ flex: 1 }}
              />
              <button 
                className="admin-btn primary" 
                onClick={loadAccounts} 
                disabled={!adminPassword || loading}
                style={{ whiteSpace: 'nowrap' }}
              >
                {loading ? 'Loading...' : 'List Accounts'}
              </button>
            </div>
            {message && (
              <div className={`admin-message ${message.includes('Error') || message.includes('Failed') ? 'error' : 'info'}`} style={{ marginTop: 12 }}>
                {message}
              </div>
            )}
          </div>
        </div>

        {/* Accounts List */}
        <div className="admin-card" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div className="admin-card-header">
            <h3>Email Accounts</h3>
            <span className="admin-badge">{accounts.length}</span>
          </div>
          <div className="admin-card-body" style={{ padding: 0, flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {accounts.length === 0 ? (
              <div className="admin-empty">
                <div className="admin-empty-icon">📭</div>
                <p>No accounts loaded</p>
                <span>Enter admin password and click "List Accounts" to view</span>
              </div>
            ) : (
              <div className="admin-table-wrapper">
                <div className="admin-table">
                  <div className="admin-table-header">
                    <div className="col-account">Account</div>
                    <div className="col-domain">Domain</div>
                    <div className="col-password">New Password</div>
                    <div className="col-actions">Actions</div>
                  </div>
                  <div className="admin-table-body">
                    {accounts.map(a => (
                      <div key={a.address} className="admin-table-row">
                        <div className="col-account">
                          <div className="account-avatar">
                            {(a.address || '').split('@')[0].slice(0, 2).toUpperCase()}
                          </div>
                          <div className="account-info">
                            <span className="account-email">{a.address}</span>
                          </div>
                        </div>
                        <div className="col-domain">
                          <span className="domain-badge">{a.domain}</span>
                        </div>
                        <div className="col-password">
                          <input 
                            value={editing[a.address] || ''} 
                            onChange={e => setEditing(prev => ({ ...prev, [a.address]: e.target.value }))} 
                            placeholder="••••••••" 
                            type="password"
                            className="admin-input small"
                          />
                        </div>
                        <div className="col-actions">
                          <button 
                            className="admin-btn small primary" 
                            onClick={() => changePassword(a.address)} 
                            disabled={!adminPassword || loading}
                            title="Change Password"
                          >
                            Change
                          </button>
                          <button 
                            className="admin-btn small secondary"
                            onClick={() => { if (onNavigate) onNavigate('admin-account-messages::' + encodeURIComponent(a.address)); }}
                            disabled={!adminPassword || loading}
                            title="View Messages"
                          >
                            View
                          </button>
                          <button 
                            className="admin-btn small danger" 
                            onClick={() => deleteAccount(a.address)} 
                            disabled={!adminPassword || loading}
                            title="Delete Account"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}