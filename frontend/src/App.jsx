import React, { useState, useEffect } from 'react';
import { setToken, getToken, clearToken, isTokenExpired, getMessage } from './api';
import Login from './screens/Login';
import Inbox from './screens/Inbox';
import Compose from './screens/Compose';
import Sent from './screens/Sent';
import Drafts from './screens/Drafts';
import Settings from './screens/Settings';
import EmailDetails from './screens/EmailDetails';
import BottomNav from './components/BottomNav';
import FloatingCompose from './components/FloatingCompose';

export default function App() {
  const [mode, setMode] = useState('login'); // login | inbox | compose | sent | drafts | settings | view
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState(false);

  // optimistic seen overrides map: { [uid]: true }
  const [seenOverrides, setSeenOverrides] = useState({});

  useEffect(()=> {
    if (getToken() && !isTokenExpired()) {
      setMode('inbox');
    } else {
      clearToken();
      setMode('login');
    }
  }, []);

  function logout() {
    clearToken();
    setMode('login');
  }

  async function openMessage(uid) {
    // optimistic: mark as seen immediately in UI
    setSeenOverrides(prev => ({ ...prev, [uid]: true }));

    setLoadingMessage(true);
    try {
      const r = await getMessage(uid);
      setSelectedMessage(r.message || null);
      setMode('view');
      // no reload needed because UI already marked seen via seenOverrides
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingMessage(false);
    }
  }

  function closeDetails() {
    setSelectedMessage(null);
    setMode('inbox');
  }

  return (
    <div style={{ fontFamily: 'Arial', height: '100vh', padding: 20, boxSizing: 'border-box', overflow: 'hidden', paddingBottom: 100, display: 'flex', flexDirection: 'column' }}>


      {/* main area: screens rendered here and can scroll internally */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {mode === 'login' && <Login onLogin={()=>setMode('inbox')} />}

        {mode === 'inbox' && <Inbox onOpenCompose={()=>setMode('compose')} onOpenMessage={openMessage} seenOverrides={seenOverrides} />}
        {mode === 'compose' && <Compose onSent={()=>setMode('inbox')} onCancel={()=>setMode('inbox')} />}
        {mode === 'sent' && <Sent onOpenMessage={openMessage} seenOverrides={seenOverrides} />}
        {mode === 'drafts' && <Drafts onOpenMessage={openMessage} seenOverrides={seenOverrides} />}
        {mode === 'settings' && <Settings onSignOut={logout} />}

        {mode === 'view' && <EmailDetails
          message={selectedMessage}
          onBack={closeDetails}
          onReply={() => setMode('compose')}
          onReplyAll={() => setMode('compose')}
          onForward={() => setMode('compose')}
          onDelete={() => { setSelectedMessage(null); setMode('inbox'); }}
        />}
      </div>

      {/* global floating compose button: hide it while on the compose screen */}
      {mode !== 'login' && mode !== 'compose' && <FloatingCompose onClick={()=>setMode('compose')} />}

      {/* render bottom nav globally only when logged in; nav will call setMode */}
      {mode !== 'login' && <BottomNav active={mode} onNavigate={(m)=>setMode(m)} />}
    </div>
  );
}