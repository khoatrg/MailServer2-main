import React, { useState, useEffect } from 'react';
import { setToken, getToken, clearToken, isTokenExpired, getMessage, moveToTrash, deleteMessagePermanent, deleteScheduledJob, getSettings, updateSettings, login, getMe, LOGOUT } from './api';
import Login from './screens/Login';
import Inbox from './screens/Inbox';
import Compose from './screens/Compose';
import Sent from './screens/Sent';
import Drafts from './screens/Drafts';
import Settings from './screens/Settings';
import EmailDetails from './screens/EmailDetails';
import Trash from './screens/Trash';
import Scheduled from './screens/Scheduled'; 
import BottomNav from './components/BottomNav';
import FloatingCompose from './components/FloatingCompose';
import AdminAccounts from './screens/AdminAccounts';
import AdminCreateAccount from './screens/AdminCreateAccount';
import AdminAccountMessages from './screens/AdminAccountMessages';
import AdminSessions from './screens/AdminSessions';

export default function App() {
  const [mode, setMode] = useState('login'); // login | inbox | compose | sent | drafts | settings | view
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [prevMode, setPrevMode] = useState('inbox'); // track origin for back navigation

  // optimistic seen overrides map: { [uid]: true }
  const [seenOverrides, setSeenOverrides] = useState({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [locked, setLocked] = useState(false);
  const [userSettings, setUserSettings] = useState(null);
  const [adminViewEmail, setAdminViewEmail] = useState(null);

  useEffect(()=> {
    async function init() {
      if (getToken() && !isTokenExpired()) {
        setMode('inbox');
        // load settings and apply
        try {
          const r = await getSettings();
          if (r && r.settings) {
            setUserSettings(r.settings);
            if (r.settings.appLock) setLocked(true);
          }
        } catch (e) { /* ignore */ }

        // determine admin flag via /api/me (DB-driven)
        try {
          const me = await getMe();
          if (me && typeof me.adminLevel !== 'undefined') {
            setIsAdmin(Number(me.adminLevel) >= 1);
          }
        } catch (e) {
          setIsAdmin(false);
        }
      } else {
        clearToken();
        setMode('login');
      }
    }
    init();
  }, []);

  // listen for settings changes from Settings screen
  useEffect(() => {
    function onSettings(e) {
      const s = e.detail || {};
      setUserSettings(s);
      if (s && s.appLock) setLocked(true);
    }
    window.addEventListener('settings:changed', onSettings);
    return () => window.removeEventListener('settings:changed', onSettings);
  }, []);

  // lock overlay component
  function LockOverlay() {
    const [pwd, setPwd] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);

    async function unlock() {
      setErr('');
      setBusy(true);
      try {
        // need email to re-login; fetch via /api/me (token still valid)
        const me = await getMe();
        const email = me && me.email;
        if (!email) throw new Error('Could not determine account email');
        const res = await login(email, pwd);
        if (res.token) {
          setToken(res.token);
          // mark unlocked locally first
          setLocked(false);
          // persist change on server: turn off appLock so switch in Settings updates
          try {
            await updateSettings({ appLock: false });
            // update local settings copy and notify UI
            setUserSettings(prev => ({ ...(prev || {}), appLock: false }));
            window.dispatchEvent(new CustomEvent('settings:changed', { detail: { ...(userSettings || {}), appLock: false } }));
          } catch (e) {
            // ignore server-setting errors but keep app unlocked locally
            console.warn('updateSettings(appLock:false) failed', e && e.message);
          }
        } else {
          setErr(res.error || 'Unlock failed');
        }
      } catch (e) {
        setErr(e && e.message ? e.message : 'Unlock error');
      } finally {
        setBusy(false);
        setPwd('');
      }
    }

    return (
      <div className="lock-overlay" role="dialog" aria-modal="true">
        <div className="lock-panel">
          <h3>App Locked</h3>
          <div className="hint">Enter your password to unlock the app.</div>
          <input
            className="lock-input"
            type="password"
            value={pwd}
            onChange={e=>setPwd(e.target.value)}
            aria-label="Unlock password"
          />
          {err && <div style={{color:'#ff8b8b', marginBottom:8}}>{err}</div>}
          <div className="lock-actions">
            <button
              className="lock-signout"
              onClick={()=>{ setLocked(false); clearToken(); setMode('login'); }}
            >
              Sign out
            </button>
            <button
              className="lock-unlock"
              onClick={unlock}
              disabled={busy}
            >
              {busy ? 'Unlocking...' : 'Unlock'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  async function logout() {
  try {
    const token = getToken();
    if (token) {
      await LOGOUT();
    }
  } catch(e) { /* ignore */ }
  clearToken();
  setMode('login');
}

  async function openMessage(uid) {
    // remember where we came from so EmailDetails can navigate back
    setPrevMode(mode);
    // optimistic: mark as seen immediately in UI
    setSeenOverrides(prev => ({ ...prev, [uid]: true }));

    setLoadingMessage(true);
    try {
      const r = await getMessage(uid);
      setSelectedMessage(r.message || null);
      setMode('view');
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingMessage(false);
    }
  }

  async function handleDelete() {
    if (!selectedMessage) { setSelectedMessage(null); setMode('inbox'); return; }

    // handle scheduled-item deletion (cancelling scheduled send)
    if (selectedMessage.scheduledId) {
      try {
        await deleteScheduledJob(selectedMessage.scheduledId);
      } catch (e) {
        console.warn('cancel scheduled job failed', e && (e.message || e));
      } finally {
        setSelectedMessage(null);
        setMode('inbox');
      }
      return;
    }

    const composite = selectedMessage.mailbox ? `${selectedMessage.mailbox}::${selectedMessage.uid}` : selectedMessage.uid;
    try {
      if (mode === 'trash' || (selectedMessage.mailbox && String(selectedMessage.mailbox).toLowerCase().includes('trash'))) {
        await deleteMessagePermanent(composite);
      } else {
        await moveToTrash(composite);
      }
    } catch (e) {
      console.warn('delete action failed', e && (e.message || e));
    } finally {
      setSelectedMessage(null);
      setMode('inbox');
    }
  }

  // open a scheduled job as a details view (construct a message-like object)
  function openScheduledJob(job) {
    setPrevMode(mode);
    const msg = {
      from: (job.mailOptions && job.mailOptions.from) || '',
      to: (job.mailOptions && job.mailOptions.to) || '',
      subject: (job.mailOptions && job.mailOptions.subject) || '',
      text: (job.mailOptions && job.mailOptions.text) || '',
      html: (job.mailOptions && job.mailOptions.html) || '',
      date: job.sendAt || new Date().toISOString(),
      scheduledId: job.id
    };
    setSelectedMessage(msg);
    setMode('view');
  }

  function closeDetails() {
    setSelectedMessage(null);
    setMode('inbox');
  }

  return (
    <div className="app-root">
      {/* lock overlay shown on top of everything when locked */}
      {locked && <LockOverlay />}

      {/* main area: screens rendered here and can scroll internally */}
      <div className="app-content">
        {mode === 'login' && <Login onLogin={()=>setMode('inbox')} />}

        {mode === 'inbox' && <Inbox onOpenCompose={()=>setMode('compose')} onOpenMessage={openMessage} seenOverrides={seenOverrides} onNavigate={(m)=>setMode(m)} />}
        {mode === 'scheduled' && <Scheduled onNavigate={(m)=>setMode(m)} onOpenScheduled={(job)=>openScheduledJob(job)} />}
        {mode === 'compose' && <Compose onSent={()=>setMode('inbox')} onCancel={()=>setMode('inbox')} />}
        {mode === 'sent' && <Sent onOpenMessage={openMessage} seenOverrides={seenOverrides} />}
        {mode === 'drafts' && <Drafts onOpenMessage={openMessage} seenOverrides={seenOverrides} />}
        {mode === 'settings' && <Settings onSignOut={logout} isAdmin={isAdmin} onNavigate={(m)=>setMode(m)} />}
        {mode === 'trash' && <Trash onOpenMessage={openMessage} onNavigate={(m)=>setMode(m)} />}

        {mode === 'admin-accounts' && <AdminAccounts onNavigate={(m)=>{
            // allow navigation string for account messages: 'admin-account-messages::email'
            if (typeof m === 'string' && m.startsWith('admin-account-messages::')) {
              const parts = m.split('::');
              const email = parts[1] ? decodeURIComponent(parts[1]) : null;
              setAdminViewEmail(email);
              setMode('admin-account-messages');
              return;
            }
            setMode(m);
          }} />}
        {mode === 'admin-create' && <AdminCreateAccount onNavigate={(m)=>setMode(m)} />}
        {mode === 'admin-account-messages' && <AdminAccountMessages accountEmail={adminViewEmail} onNavigate={(m)=>setMode(m)} />}
          {mode === 'admin-sessions' && <AdminSessions onNavigate={(m)=>setMode(m)} />}


        {mode === 'view' && <EmailDetails
          message={selectedMessage}
          onBack={() => { setSelectedMessage(null); setMode(prevMode || 'inbox'); }}
          onReply={() => setMode('compose')}
          onReplyAll={() => setMode('compose')}
          onForward={() => setMode('compose')}
          onDelete={handleDelete}
        />}
      </div>

      {/* global floating compose button: hide it while on the compose screen */}
      {mode !== 'login' && mode !== 'compose' && <FloatingCompose onClick={()=>setMode('compose')} />}

      {/* render bottom nav globally only when logged in; nav will call setMode */}
      {mode !== 'login' && <BottomNav active={mode} onNavigate={(m)=>setMode(m)} />}
    </div>
  );
}