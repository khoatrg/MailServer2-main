import React, { useState, useEffect, useRef } from 'react';
import { getDraftMessages, getMessage, deleteDraftMessage } from '../api';
import Compose from './Compose'; // open compose inline when user picks a draft

export default function Drafts({ onOpenMessage, seenOverrides }) {
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);

  // compose overlay state for editing a draft
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitial, setComposeInitial] = useState(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);
  const searchTimer = useRef(null);

  async function load() {
    const r = await getDraftMessages();
    setMessages(r.messages || []);
  }

  useEffect(() => { load(); }, []);

  async function doSearch(q) {
    const qn = (q || '').trim().toLowerCase();
    if (!qn) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    try {
      const headers = messages.length ? messages : (await getDraftMessages()).messages || [];
      const matched = [];
      const toCheck = [];
      for (const h of headers) {
        const subj = (h.subject || '').toLowerCase();
        const from = (h.from || '').toLowerCase();
        const to = (h.to || '').toLowerCase();
        if (subj.includes(qn) || from.includes(qn) || to.includes(qn)) matched.push(h);
        else toCheck.push(h);
      }
      const bodyMatches = [];
      const limit = 200;
      const checkList = toCheck.slice(0, limit);
      await Promise.all(checkList.map(async h => {
        try {
          const composite = h.mailbox ? `${h.mailbox}::${h.uid}` : h.uid;
          const mr = await getMessage(composite);
          const msg = mr && mr.message;
          if (!msg) return;
          const text = ((msg.text || '') + ' ' + (msg.html || '')).toLowerCase();
          if (text.includes(qn)) bodyMatches.push(h);
        } catch (e) {}
      }));
      const uniq = {}; const results = [];
      for (const x of [...matched, ...bodyMatches]) {
        const key = `${x.mailbox||''}::${x.uid}`;
        if (!uniq[key]) { uniq[key] = true; results.push(x); }
      }
      setSearchResults(results);
    } catch (e) { console.warn('search error', e && e.message); setSearchResults([]); }
    finally { setSearching(false); }
  }

  function onSearchKey(e) {
    if (e.key === 'Enter') doSearch(searchQuery);
    if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); setSearchResults(null); }
  }

  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!showSearch) return;
    searchTimer.current = setTimeout(() => { doSearch(searchQuery); }, 350);
    return () => clearTimeout(searchTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, showSearch]);

  // open message by passing composite "mailbox::uid" so backend opens correct mailbox
  // When clicking a draft: fetch message, delete it from Draft mailbox, and open Compose pre-filled.
  async function open(uid, mailbox) {
    const composite = mailbox ? `${mailbox}::${uid}` : uid;
    try {
      const r = await getMessage(composite);
      const msg = r && r.message;
      if (!msg) {
        // fallback to normal behavior if not found
        if (onOpenMessage) onOpenMessage(composite);
        return;
      }

      // construct initialData for Compose
      const initial = {
        recipients: (msg.to || '').split(',').map(s => s.trim()).filter(Boolean),
        toInput: '',
        subject: msg.subject || '',
        body: msg.text || msg.html || '',
        savedAt: Date.now()
      };

      // delete the draft message from server (best-effort)
      try {
        await deleteDraftMessage(msg.mailbox || mailbox, uid);
      } catch (e) {
        console.warn('deleteDraftMessage failed', e && (e.message || e));
      }

      // remove the draft from the list UI
      setMessages(prev => prev.filter(m => !(String(m.uid) === String(uid) && m.mailbox === (mailbox || m.mailbox))));

      // open compose inline with initial data
      setComposeInitial(initial);
      setComposeOpen(true);
    } catch (e) {
      console.warn('Failed to open draft for editing', e && (e.message || e));
      if (onOpenMessage) onOpenMessage(composite);
    }
  }

  function avatarFor(to) {
    if (!to) return '';
    const name = (to.split('<')[0] || to).trim();
    const parts = name.split(/\s+/).filter(Boolean);
    const initials = parts.length === 1 ? parts[0][0] : (parts[0][0] + parts[1][0]);
    return initials.toUpperCase();
  }

  function formatTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    const now = new Date();
    const diff = now - d;
    if (diff < 1000*60*60*24) {
      return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    }
    return d.toLocaleDateString();
  }

  const listToRender = (searchResults !== null || searching || showSearch) ? (searchResults || []) : messages;

  return (
    <div className="inbox-screen">
      <header className="inbox-header">
        <h1>Drafts</h1>
        <div style={{marginLeft:'auto', display:'flex', alignItems:'center'}}>
          {!showSearch ? (
            <button style={{background:'transparent', border:'1px solid rgba(255,255,255,0.03)', padding:8, borderRadius:8, color:'#dff3ff', cursor:'pointer'}} onClick={() => { setShowSearch(true); setTimeout(()=>inputRef.current && inputRef.current.focus(),50); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="11" cy="11" r="6" stroke="#9aa6b2" strokeWidth="1.6"/></svg>
            </button>
          ) : (
            <div style={{display:'flex', alignItems:'center', gap:8, padding:'4px 6px', background:'#071015', border:'1px solid rgba(255,255,255,0.03)', borderRadius:8}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="11" cy="11" r="6" stroke="#9aa6b2" strokeWidth="1.6"/></svg>
              <input ref={inputRef} value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} onKeyDown={onSearchKey} placeholder="Search subject, email, or content" style={{padding:'8px 10px', borderRadius:6, border:'none', background:'transparent', color:'#dff3ff', outline:'none', width:300, maxWidth:'40vw'}} />
              <button onClick={()=>{ setShowSearch(false); setSearchQuery(''); setSearchResults(null); }} title="Close search" style={{background:'transparent', border:'none', color:'#9aa6b2', cursor:'pointer'}}>✕</button>
            </div>
          )}
        </div>
      </header>

      <ul className="message-list">
        {(!listToRender || listToRender.length === 0) && <li className="empty">{searching ? 'Searching…' : 'No drafts'}</li>}
        {listToRender.map(m => {
           const isSeen = !!(m.seen || (seenOverrides && seenOverrides[m.uid]));
           return (
             // use mailbox+uid as key and pass mailbox into open
             <li key={`${m.mailbox}::${m.uid}`} className="message-item" onClick={() => open(m.uid, m.mailbox)}>
               <div className="avatar">{avatarFor(m.to)}</div>

               <div className="message-body">
                 <div className="message-top">
                   <div className="sender">
                     <div className="sender-name">
                       {!isSeen && <span className="unread-dot" aria-hidden="true" />}
                       To: {(m.to || '').split('<')[0].trim() || m.to || 'Unknown'}
                     </div>
                     <div className="subject">{m.subject ? m.subject : <em style={{color:'#9aa6b2'}}>(no subject)</em>}</div>
                   </div>
                   <div className="time">{formatTime(m.date)}</div>
                 </div>

                 <div className="message-preview">
                   <span className="preview-text">{m.subject ? (m.subject + ' — ') : ''}</span>
                 </div>
               </div>
             </li>
           );
         })}
       </ul>

      {/* Inline compose for editing a picked draft */}
      {composeOpen && (
        <Compose
          noPortal={false}
          initialData={composeInitial}
          onCancel={() => { setComposeOpen(false); setComposeInitial(null); load(); }}
          onSent={() => { setComposeOpen(false); setComposeInitial(null); load(); }}
        />
      )}
    </div>
  );
}
