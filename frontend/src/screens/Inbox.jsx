import React, { useState, useEffect, useRef } from 'react';
import { listMessages, getMessage } from '../api';

export default function Inbox({ onOpenCompose, onOpenMessage, seenOverrides }) {
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const inputRef = useRef(null);
  const searchTimer = useRef(null);

  async function load() {
    const r = await listMessages();
    setMessages(r.messages || []);
  }

  useEffect(()=>{ load(); }, []); // no refreshCounter now

  function open(uid) {
    if (onOpenMessage) onOpenMessage(uid);
  }

  async function doSearch(q) {
    const qn = (q || '').trim().toLowerCase();
    if (!qn) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      // ensure headers available
      const headers = messages.length ? messages : (await listMessages()).messages || [];

      // first pass: match subject / from / to
      const matched = [];
      const toCheck = [];
      for (const h of headers) {
        const subj = (h.subject || '').toLowerCase();
        const from = (h.from || '').toLowerCase();
        const to = (h.to || '').toLowerCase();
        if (subj.includes(qn) || from.includes(qn) || to.includes(qn)) {
          matched.push(h);
        } else {
          toCheck.push(h);
        }
      }

      // second pass: search bodies for remaining candidates
      const bodyMatches = [];
      // limit to reasonable number to avoid huge loads
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
        } catch (e) { /* ignore */ }
      }));

      // combine unique results
      const uniq = {};
      const results = [];
      for (const x of [...matched, ...bodyMatches]) {
        const key = `${x.mailbox || ''}::${x.uid}`;
        if (!uniq[key]) { uniq[key] = true; results.push(x); }
      }
      setSearchResults(results);
    } catch (e) {
      console.warn('search error', e && e.message);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function onSearchKey(e) {
    if (e.key === 'Escape') {
      setShowSearch(false);
      setSearchQuery('');
      setSearchResults(null);
    }
  }

  // auto-search: debounce searchQuery changes
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!showSearch) return;
    searchTimer.current = setTimeout(() => {
      doSearch(searchQuery);
    }, 350);
    return () => clearTimeout(searchTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, showSearch]);

  const listToRender = (searchResults !== null || searching || showSearch) ? (searchResults || []) : messages;

  function avatarFor(from) {
    if (!from) return '';
    const name = (from.split('<')[0] || from).trim();
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

  return (
    <div className="inbox-screen">
      <header className="inbox-header" style={{display:'flex', alignItems:'center', gap:12}}>
        <h1 style={{margin:0}}>Inbox</h1>
        <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:8}}>
          {!showSearch ? (
            <button
              className="search-btn"
              aria-label="Open search"
              onClick={() => { setShowSearch(true); setTimeout(()=>inputRef.current && inputRef.current.focus(), 50); }}
              style={{background:'transparent', border:'1px solid rgba(255,255,255,0.03)', padding:8, borderRadius:8, color:'#dff3ff', cursor:'pointer'}}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="11" cy="11" r="6" stroke="#9aa6b2" strokeWidth="1.6"/></svg>
            </button>
          ) : (
            <div style={{display:'flex', alignItems:'center', gap:8, padding:'4px 6px', background:'#071015', border:'1px solid rgba(255,255,255,0.03)', borderRadius:8}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#9aa6b2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="11" cy="11" r="6" stroke="#9aa6b2" strokeWidth="1.6"/></svg>
              <input
                ref={inputRef}
                value={searchQuery}
                onChange={e=>setSearchQuery(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder="Search subject, email, or content"
                style={{padding:'8px 10px', borderRadius:6, border:'none', background:'transparent', color:'#dff3ff', outline:'none', width:300, maxWidth:'40vw'}}
              />
              <button onClick={()=>{ setShowSearch(false); setSearchQuery(''); setSearchResults(null); }} title="Close search" style={{background:'transparent', border:'none', color:'#9aa6b2', cursor:'pointer', padding:6}}>✕</button>
            </div>
          )}
        </div>
      </header>

      <ul className="message-list">
        {(!listToRender || listToRender.length === 0) && <li className="empty">{searching ? 'Searching…' : 'No messages'}</li>}
        {listToRender.map(m => {
           const isSeen = !!(m.seen || (seenOverrides && seenOverrides[m.uid]));
           return (
            <li key={`${m.mailbox||'INBOX'}::${m.uid}`} className="message-item" onClick={() => open(m.mailbox ? `${m.mailbox}::${m.uid}` : m.uid)}>
              <div className="avatar">{avatarFor(m.from)}</div>

              <div className="message-body">
                <div className="message-top">
                  <div className="sender">
                    <div className="sender-name">
                      {!isSeen && <span className="unread-dot" aria-hidden="true" />}
                      {(m.from || '').split('<')[0].trim() || m.from || 'Unknown'}
                    </div>
                    <div className="subject">{m.subject || '(no subject)'}</div>
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

      {/* floating-compose removed from here; rendered globally in App.jsx */}
    </div>
  );
}
