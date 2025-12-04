import React, { useState, useEffect } from 'react';
import { setToken, getToken, clearToken, isTokenExpired, getMessage, moveToTrash, deleteMessagePermanent, deleteScheduledJob } from './api';
import Login from './screens/Login';
import Inbox from './screens/Inbox';
import Compose from './screens/Compose';
import Sent from './screens/Sent';
import Drafts from './screens/Drafts';
import Settings from './screens/Settings';
import EmailDetails from './screens/EmailDetails';
import Trash from './screens/Trash';
import Scheduled from './screens/Scheduled'; // <-- new import
import BottomNav from './components/BottomNav';
import FloatingCompose from './components/FloatingCompose';

export default function App() {
  const [mode, setMode] = useState('login'); // login | inbox | compose | sent | drafts | settings | view
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [prevMode, setPrevMode] = useState('inbox'); // track origin for back navigation

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


      {/* main area: screens rendered here and can scroll internally */}
      <div className="app-content">
        {mode === 'login' && <Login onLogin={()=>setMode('inbox')} />}

        {mode === 'inbox' && <Inbox onOpenCompose={()=>setMode('compose')} onOpenMessage={openMessage} seenOverrides={seenOverrides} onNavigate={(m)=>setMode(m)} />}
        {mode === 'scheduled' && <Scheduled onNavigate={(m)=>setMode(m)} onOpenScheduled={(job)=>openScheduledJob(job)} />}
        {mode === 'compose' && <Compose onSent={()=>setMode('inbox')} onCancel={()=>setMode('inbox')} />}
        {mode === 'sent' && <Sent onOpenMessage={openMessage} seenOverrides={seenOverrides} />}
        {mode === 'drafts' && <Drafts onOpenMessage={openMessage} seenOverrides={seenOverrides} />}
        {mode === 'settings' && <Settings onSignOut={logout} />}
        {mode === 'trash' && <Trash onOpenMessage={openMessage} onNavigate={(m)=>setMode(m)} />}

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