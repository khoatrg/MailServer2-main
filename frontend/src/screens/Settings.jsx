import React, { useState, useEffect } from 'react';
import { getMe } from '../api';

export default function Settings({ onSignOut }) {
  const [pushNotifications, setPushNotifications] = useState(true);
  const [appLock, setAppLock] = useState(false);
  const [account, setAccount] = useState({ email: '', displayName: '', inbox: { total: 0, unread: 0 } });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const r = await getMe();
        if (mounted && r && !r.error) {
          setAccount({ email: r.email || '', displayName: r.displayName || '', inbox: r.inbox || { total:0, unread:0 }});
        }
      } catch (e) {
        console.warn('getMe failed', e);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, []);

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

          {/* account card now shows real logged-in account info */}
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

          {row('Signature Settings', null, (e)=>e.preventDefault())}
          {row('Out of Office', null, (e)=>e.preventDefault())}
        </div>

        <div className="section">
          <div className="section-title">GENERAL</div>
          {row('Appearance', 'System', (e)=>e.preventDefault())}
          {row('Default Browser', 'In-App', (e)=>e.preventDefault())}
        </div>

        <div className="section">
          <div className="section-title">NOTIFICATIONS</div>

          <div className="settings-row">
            <div className="settings-row-left">
              <div className="settings-row-label">Push Notifications</div>
            </div>
            <div className="settings-row-right">
              <label className="switch">
                <input type="checkbox" checked={pushNotifications} onChange={(e)=>setPushNotifications(e.target.checked)} />
                <span className="slider" />
              </label>
            </div>
          </div>

          {row('Sound & Vibration', null, (e)=>e.preventDefault())}
        </div>

        <div className="section">
          <div className="section-title">SECURITY</div>

          <div className="settings-row">
            <div className="settings-row-left">
              <div className="settings-row-label">App Lock</div>
            </div>
            <div className="settings-row-right">
              <label className="switch">
                <input type="checkbox" checked={appLock} onChange={(e)=>setAppLock(e.target.checked)} />
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
