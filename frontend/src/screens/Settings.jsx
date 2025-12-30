import React, { useState, useEffect } from 'react';
import { getMe, adminBackup, getSettings, updateSettings } from '../api';

export default function Settings({ onSignOut, isAdmin, onNavigate }) {
  const [pushNotifications, setPushNotifications] = useState(true);
  const [appLock, setAppLock] = useState(false);
  const [account, setAccount] = useState({ email: '', displayName: '', inbox: { total: 0, unread: 0 }, adminLevel: 0 });
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState({ outOfOffice: false, outOfOfficeReply: '', theme: 'system', appLock: false });
  
  // Cache state
  const [cacheSize, setCacheSize] = useState('Calculating...');
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const r = await getMe();
        if (mounted && r && !r.error) {
          setAccount({
            email: r.email || '',
            displayName: r.displayName || '',
            inbox: r.inbox || { total: 0, unread: 0 },
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

      // Calculate cache size
      if (mounted) calculateCacheSize();
    }
    load();
    return () => { mounted = false; };
  }, []);

  // Listen for settings changes from App.jsx (e.g., after unlock)
  useEffect(() => {
    function onSettingsChanged(e) {
      const s = e.detail || {};
      setSettings(prev => ({ ...prev, ...s }));
    }
    window.addEventListener('settings:changed', onSettingsChanged);
    return () => window.removeEventListener('settings:changed', onSettingsChanged);
  }, []);

  // Calculate cache size from various browser storages
  async function calculateCacheSize() {
    let totalBytes = 0;

    try {
      // 1. localStorage size
      let localStorageSize = 0;
      for (let key in localStorage) {
        if (localStorage.hasOwnProperty(key)) {
          localStorageSize += (localStorage[key].length + key.length) * 2; // UTF-16
        }
      }
      totalBytes += localStorageSize;

      // 2. sessionStorage size
      let sessionStorageSize = 0;
      for (let key in sessionStorage) {
        if (sessionStorage.hasOwnProperty(key)) {
          sessionStorageSize += (sessionStorage[key].length + key.length) * 2;
        }
      }
      totalBytes += sessionStorageSize;

      // 3. IndexedDB size (for WebLLM models) - estimate via Storage API
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        totalBytes += estimate.usage || 0;
      }

      // 4. Cache Storage size
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
          const cache = await caches.open(name);
          const requests = await cache.keys();
          // Rough estimate: count requests * average size
          totalBytes += requests.length * 50000; // ~50KB average per cached item
        }
      }
    } catch (e) {
      console.warn('Error calculating cache size', e);
    }

    setCacheSize(formatBytes(totalBytes));
  }

  // Format bytes to human readable
  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // Clear all caches
  async function clearAllCache() {
    if (!window.confirm('Clear all cached data? This includes:\n• Chat history\n• Downloaded AI models\n• Cached files\n\nYou may need to re-download the AI model.')) {
      return;
    }

    setClearingCache(true);

    try {
      // 1. Clear localStorage (except auth token)
      const token = localStorage.getItem('token');
      localStorage.clear();
      if (token) localStorage.setItem('token', token); // preserve login

      // 2. Clear sessionStorage (except auth token)
      const sessionToken = sessionStorage.getItem('token');
      sessionStorage.clear();
      if (sessionToken) sessionStorage.setItem('token', sessionToken);

      // 3. Clear IndexedDB (WebLLM models, etc.)
      if (window.indexedDB && window.indexedDB.databases) {
        const databases = await window.indexedDB.databases();
        for (const db of databases) {
          if (db.name) {
            window.indexedDB.deleteDatabase(db.name);
          }
        }
      }

      // 4. Clear Cache Storage
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
          await caches.delete(name);
        }
      }

      // 5. Unregister service workers
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
          await registration.unregister();
        }
      }

      alert('Cache cleared successfully!\n\nNote: You will need to re-download the AI model if you use the chat feature.');
      
      // Recalculate cache size
      await calculateCacheSize();

    } catch (e) {
      console.error('Error clearing cache', e);
      alert('Error clearing cache: ' + (e.message || e));
    } finally {
      setClearingCache(false);
    }
  }

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

  async function saveSettings(newPartial) {
    const merged = { ...settings, ...newPartial };
    setSettings(merged);
    try {
      const res = await updateSettings({
        outOfOffice: !!merged.outOfOffice,
        outOfOfficeReply: merged.outOfOfficeReply || '',
        appLock: !!merged.appLock
      });
      if (res && res.settings) {
        setSettings(res.settings);
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
        <div className="settings-row-right">{rightNode || <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}</div>
      </button>
    );
  }

  return (
    <div className="settings-screen">
      <header className="settings-header">
        <button className="back-btn" onClick={() => window.history.back()} aria-label="Back">‹</button>
        <h1>Settings</h1>
        <div style={{ width: 36 }} />
      </header>

      <div className="settings-content">
        <div className="section">
          <div className="section-title">ACCOUNT MANAGEMENT</div>

          <div className="account-card">
            <div className="account-left">
              <div className="account-avatar">{(account.displayName || account.email || '').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase() || 'U'}</div>
            </div>
            <div className="account-right">
              <div className="account-name">{loading ? 'Loading…' : (account.displayName || account.email)}</div>
              <div className="account-email">{loading ? '' : account.email}</div>
            </div>
            <div className="account-chev">›</div>
            <div style={{ position: 'absolute', right: 16, top: 14, color: '#9aa6b2', fontSize: 12 }}>
              <div>Inbox {account.inbox.total}</div>
              <div style={{ color: '#6ea6d1' }}>Unread {account.inbox.unread}</div>
            </div>
          </div>

          {/* Admin section */}
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

              <div className="settings-row" onClick={startBackup} style={{ cursor: 'pointer' }}>
                <div className="settings-row-left">
                  <div className="settings-row-label">Start Backup</div>
                  <div className="settings-row-sub">Trigger hMailServer backup via server</div>
                </div>
                <div className="settings-row-right">
                  <button className="primary-btn" onClick={(e) => { e.stopPropagation(); startBackup(); }}>Start</button>
                </div>
              </div>
            </div>
          )}

          {/* Out of Office */}
          <div className="settings-row" style={{ alignItems: 'flex-start' }}>
            <div className="settings-row-left" style={{ width: '100%' }}>
              <div className="settings-row-label">Out of Office Auto-Reply</div>
              <div className="settings-row-sub">Automatically reply to incoming messages when enabled</div>
              {settings.outOfOffice && (
                <textarea
                  value={settings.outOfOfficeReply}
                  onChange={e => setSettings(s => ({ ...s, outOfOfficeReply: e.target.value }))}
                  onBlur={() => saveSettings({ outOfOfficeReply: settings.outOfOfficeReply })}
                  placeholder="Auto-reply message"
                  style={{ width: '100%', marginTop: 8, padding: 10, borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)', background: '#fff', color: '#202124' }}
                  rows={4}
                />
              )}
            </div>
            <div className="settings-row-right">
              <label className="switch">
                <input type="checkbox" checked={!!settings.outOfOffice} onChange={e => saveSettings({ outOfOffice: !!e.target.checked })} />
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
                <input type="checkbox" checked={!!settings.appLock} onChange={e => {
                  const enabled = !!e.target.checked;
                  if (enabled && !window.confirm('Enable App Lock? You will need your password to unlock the app.')) {
                    return;
                  }
                  saveSettings({ appLock: enabled });
                }} />
                <span className="slider" />
              </label>
            </div>
          </div>

          {/* Clear Cache - now functional */}
          <div className="settings-row" onClick={clearAllCache} style={{ cursor: 'pointer' }}>
            <div className="settings-row-left">
              <div className="settings-row-label">Clear Cache</div>
              <div className="settings-row-sub">Clear downloaded models, chat history, and cached data</div>
            </div>
            <div className="settings-row-right">
              {clearingCache ? (
                <div style={{ color: '#1a73e8', fontWeight: 600 }}>Clearing...</div>
              ) : (
                <div className="cache-size">{cacheSize}</div>
              )}
            </div>
          </div>
        </div>

        <div className="section signout-section">
          <button className="signout-btn" onClick={() => onSignOut && onSignOut()}>Sign Out</button>
          <div className="app-version">App Version 2.1.0 (Build 345)</div>
        </div>
      </div>
    </div>
  );
}