import React, { useState, useEffect } from 'react';
import { getMe, adminBackup, getSettings, updateSettings } from '../api';

export default function Settings({ onSignOut, isAdmin, onNavigate }) {
  const [pushNotifications, setPushNotifications] = useState(true);
  const [appLock, setAppLock] = useState(false);
  const [account, setAccount] = useState({ email: '', displayName: '', inbox: { total: 0, unread: 0 }, adminLevel: 0 }); // added adminLevel
  const [loading, setLoading] = useState(true);

  // add settings state
  const [settings, setSettings] = useState({ outOfOffice:false, outOfOfficeReply:'', theme:'system', appLock:false });

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const r = await getMe();
        if (mounted && r && !r.error) {
          // include adminLevel from server response
          setAccount({
            email: r.email || '',
            displayName: r.displayName || '',
            inbox: r.inbox || { total:0, unread:0 },
            adminLevel: Number(r.adminLevel || 0)
          });
        }
      } catch (e) {
        console.warn('getMe failed', e);
      } finally {
        if (mounted) setLoading(false);
      }

      // load settings
      try {
        const s = await getSettings();
        if (mounted && s && s.settings) setSettings(s.settings);
      } catch (e) { /* ignore */ }
    }
    load();
    return () => { mounted = false; };
  }, []);

  async function startBackup() {
    const pwd = window.prompt('Enter hMailServer Administrator password to start backup:');
    if (!pwd) return;
    try {
      const r = await adminBackup(pwd);
      if (r && r.success) {
        alert('Backup started.');
      } else {
        alert('Backup failed: ' + (r && r.error ? r.error : 'unknown'));
      }
    } catch (e) {
      alert('Backup error: ' + (e && e.message ? e.message : e));
    }
  }

  // helper to persist settings and notify app
  async function saveSettings(newPartial) {
    const merged = { ...settings, ...newPartial };
    setSettings(merged);
    try {
      // only persist relevant flags (no theme handling)
      const res = await updateSettings({
        outOfOffice: !!merged.outOfOffice,
        outOfOfficeReply: merged.outOfOfficeReply || '',
        appLock: !!merged.appLock
      });
      if (res && res.settings) {
        setSettings(res.settings);
        // notify host app so it can apply theme or lock immediately
        window.dispatchEvent(new CustomEvent('settings:changed', { detail: res.settings }));
      }
    } catch (e) {
      console.warn('saveSettings failed', e && e.message);
    }
  }

  function row(label, value, onClick, rightNode) {
    return (
      <button className="settings-row" onClick={onClick || (() => {})}>
        <div className="settings-row-left">
          <div className="settings-row-label">{label}</div>
          {value && <div className="settings-row-sub">{value}</div>}
        </div>
        <div className="settings-row-right">{rightNode || <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>}</div>
      </button>
    );
  }

  return (
    <div className="settings-screen">
      <header className="settings-header">
        <button className="back-btn" onClick={() => window.history.back()} aria-label="Back">‹</button>
        <h1>Settings</h1>
        <div style={{width:36}} />
      </header>

      <div className="settings-content">
        <div className="section">
          <div className="section-title">ACCOUNT MANAGEMENT</div>

          <div className="account-card">
            <div className="account-left">
              <div className="account-avatar">{(account.displayName || account.email || '').split(' ').map(p=>p[0]).slice(0,2).join('').toUpperCase() || 'U'}</div>
            </div>
            <div className="account-right">
              <div className="account-name">{loading ? 'Loading…' : (account.displayName || account.email)}</div>
              <div className="account-email">{loading ? '' : account.email}</div>
            </div>
            <div className="account-chev">›</div>
            <div style={{position:'absolute', right:16, top:14, color:'#9aa6b2', fontSize:12}}>
              <div>Inbox {account.inbox.total}</div>
              <div style={{color:'#6ea6d1'}}>Unread {account.inbox.unread}</div>
            </div>
          </div>

          {/* Admin section — visible only to users with adminLevel >= 1 */}
          {Number(account.adminLevel || 0) >= 1 && (
            <div className="section" aria-hidden={false}>
              <div className="section-title">ADMINISTRATION</div>
              <button className="settings-row" onClick={() => onNavigate && onNavigate('admin-accounts')}>
                <div className="settings-row-left">
                  <div className="settings-row-label">Administration</div>
                  <div className="settings-row-sub">Manage accounts and server settings</div>
                </div>
                <div className="settings-row-right">›</div>
              </button>

              <button className="settings-row" onClick={() => onNavigate && onNavigate('admin-sessions')}>
  <div className="settings-row-left">
    <div className="settings-row-label">Active Sessions</div>
    <div className="settings-row-sub">View and revoke user sessions</div>
  </div>
  <div className="settings-row-right">›</div>
</button>

              <div className="settings-row" onClick={startBackup} style={{cursor:'pointer'}}>
                <div className="settings-row-left">
                  <div className="settings-row-label">Start Backup</div>
                  <div className="settings-row-sub">Trigger hMailServer backup via server</div>
                </div>
                <div className="settings-row-right">
                  <button className="primary-btn" onClick={(e)=>{ e.stopPropagation(); startBackup(); }}>Start</button>
                </div>
              </div>

            </div>
          )}

          {/* Out of Office */}
          <div className="settings-row" style={{alignItems:'flex-start'}}>
            <div className="settings-row-left" style={{width:'100%'}}>
              <div className="settings-row-label">Out of Office Auto-Reply</div>
              <div className="settings-row-sub">Automatically reply to incoming messages when enabled</div>
              {settings.outOfOffice && (
                <textarea
                  value={settings.outOfOfficeReply}
                  onChange={e=>setSettings(s=>({ ...s, outOfOfficeReply: e.target.value }))}
                  onBlur={()=>saveSettings({ outOfOfficeReply: settings.outOfOfficeReply })}
                  placeholder="Auto-reply message"
                  style={{width:'100%', marginTop:8, padding:10, borderRadius:8, border:'1px solid rgba(255,255,255,0.03)', background:'#071015', color:'#dff3ff'}}
                  rows={4}
                />
              )}
            </div>
            <div className="settings-row-right">
              <label className="switch">
                <input type="checkbox" checked={!!settings.outOfOffice} onChange={e=>saveSettings({ outOfOffice: !!e.target.checked })} />
                <span className="slider" />
              </label>
            </div>
          </div>
        </div>

        <div className="section">
          <div className="section-title">SECURITY</div>

          <div className="settings-row">
            <div className="settings-row-left">
              <div className="settings-row-label">App Lock</div>
              <div className="settings-row-sub">Require password to unlock the web UI when locked</div>
            </div>
            <div className="settings-row-right">
              <label className="switch">
                <input type="checkbox" checked={!!settings.appLock} onChange={e=>{
                  const enabled = !!e.target.checked;
                  // confirm enabling app lock
                  if (enabled && !window.confirm('Enable App Lock? You will need your password to unlock the app.')) {
                    return;
                  }
                  saveSettings({ appLock: enabled });
                }} />
                <span className="slider" />
              </label>
            </div>
          </div>

          <div className="settings-row" onClick={(e)=>e.preventDefault()}>
            <div className="settings-row-left">
              <div className="settings-row-label">Clear Cache</div>
            </div>
            <div className="settings-row-right">
              <div className="cache-size">128 MB</div>
            </div>
          </div>
        </div>

        <div className="section signout-section">
          <button className="signout-btn" onClick={()=>onSignOut && onSignOut()}>Sign Out</button>
          <div className="app-version">App Version 2.1.0 (Build 345)</div>
        </div>
      </div>
    </div>
  );
}
