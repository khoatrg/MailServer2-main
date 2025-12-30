import React, { useState, useEffect, useRef } from 'react';
import { getSentMessages, getMessage } from '../api';
import { sortMessages } from '../utils/sortMessages';

export default function Sent({ onOpenMessage, seenOverrides }) {
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);
  const searchTimer = useRef(null);
  const [sortDir, setSortDir] = useState('desc'); // 'desc' = newest first

  async function load() {
    const r = await getSentMessages();
    setMessages(r.messages || []);
  }

  useEffect(()=>{ load(); }, []);

  function open(uid) {
    if (onOpenMessage) onOpenMessage(uid);
  }

  async function doSearch(q) {
    const qn = (q || '').trim().toLowerCase();
    if (!qn) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    try {
      const headers = messages.length ? messages : (await getSentMessages()).messages || [];
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
    if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); setSearchResults(null); }
  }

  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!showSearch) return;
    searchTimer.current = setTimeout(() => { doSearch(searchQuery); }, 350);
    return () => clearTimeout(searchTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, showSearch]);

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

  const rawList = (searchResults !== null || searching || showSearch) ? (searchResults || []) : messages;
const listToRender = sortMessages(rawList, 'date', sortDir);
  const PAGE_SIZE = 7;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [messages.length, searchResults, searching, showSearch]);
  const totalPages = Math.max(1, Math.ceil((listToRender && listToRender.length) / PAGE_SIZE));
  const paginated = (listToRender || []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="inbox-screen">
      <header className="inbox-header">
        <h1>Sent</h1>

        <div className="sort-select-wrapper">
  <select className="sort-select" value={sortDir} onChange={e => setSortDir(e.target.value)} aria-label="Sort messages">
    <option value="desc">Newest first</option>
    <option value="asc">Oldest first</option>
  </select>
</div>

        <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:12}}>
          <div>
            <div className="pagination-inline" role="navigation" aria-label="Pagination">
              <button className="pagination-btn" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page<=1}>Prev</button>
              <div className="pagination-info">{page} / {totalPages}</div>
              <button className="pagination-btn" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page>=totalPages}>Next</button>
            </div>
          </div>
          

          <div style={{display:'flex', alignItems:'center'}}>
            {!showSearch ? (
              <button style={{background:'transparent', border:'1px solid rgba(0,0,0,0.08)', padding:8, borderRadius:8, color:'#202124', cursor:'pointer'}} onClick={() => { setShowSearch(true); setTimeout(()=>inputRef.current && inputRef.current.focus(),50); }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#5f6368 " strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="11" cy="11" r="6" stroke="#5f6368 " strokeWidth="1.6"/></svg>
              </button>
            ) : (
              <div style={{display:'flex', alignItems:'center', gap:8, padding:'4px 6px', background:'#fff', border:'1px solid rgba(0,0,0,0.08)', borderRadius:8}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#5f6368 " strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="11" cy="11" r="6" stroke="#5f6368 " strokeWidth="1.6"/></svg>
                <input ref={inputRef} value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} onKeyDown={onSearchKey} placeholder="Search subject, email, or content" style={{padding:'8px 10px', borderRadius:6, border:'none', background:'transparent', color:'#202124', outline:'none', width:300, maxWidth:'40vw'}} />
                <button onClick={()=>{ setShowSearch(false); setSearchQuery(''); setSearchResults(null); }} title="Close search" style={{background:'transparent', border:'none', color:'#5f6368 ', cursor:'pointer'}}>✕</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <ul className="message-list">
        {(!paginated || paginated.length === 0) && <li className="empty">{searching ? 'Searching…' : 'No messages'}</li>}
        {paginated.map(m => {
           const isSeen = !!(m.seen || (seenOverrides && seenOverrides[m.uid]));
           return (
            <li
                 key={m.uid}
                 className="message-item"
                 onClick={() => {
                   const composite = m.mailbox ? `${m.mailbox}::${m.uid}` : m.uid;
                   open(composite);
                 }}
               >

               <div className="message-body">
                 <div className="message-top">
                   <div className="sender">
                     <div className="sender-name">
                       {!isSeen && <span className="unread-dot" aria-hidden="true" />}
                       To: {(m.to || '').split('<')[0].trim() || m.to || 'Unknown'}
                     </div>
                     <div className="subject">{m.subject || '(no subject)'}</div>
                   </div>
                   <div className="time">{formatTime(m.date)}</div>
                 </div>

                 <div className="message-preview">
                   <span className="preview-text">{m.subject ? (m.subject + ' — ') : ''}</span>
                 </div>
               </div>

              {/* Sent items do not show a delete action here */}


             </li>
           );
         })}
       </ul>
     </div>
   );
 }
