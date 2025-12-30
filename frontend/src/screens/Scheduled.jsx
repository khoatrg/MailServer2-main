import React, { useEffect, useState, useRef } from 'react';
import { getScheduledJobs, deleteScheduledJob } from '../api';
import { sortMessages } from '../utils/sortMessages';

export default function Scheduled({ onNavigate, onOpenScheduled }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  // search state (same pattern as other screens)
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);
  const searchTimer = useRef(null);
  const [sortDir, setSortDir] = useState('desc'); // 'desc' = newest first

  async function load() {
    setLoading(true);
    try {
      const r = await getScheduledJobs();
      setJobs((r && r.jobs) || []);
    } catch (e) {
      console.warn('load scheduled failed', e && e.message);
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);
  const PAGE_SIZE = 7;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [jobs.length, searchResults, searching, showSearch]);
  const rawList = (searchResults !== null || searching || showSearch) ? (searchResults || []) : jobs;
const listToRender = sortMessages(rawList, 'date', sortDir);
  const totalPages = Math.max(1, Math.ceil((listToRender && listToRender.length) / PAGE_SIZE));
  const paginated = (listToRender || []).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // search implementation
  async function doSearch(q) {
    const qn = (q || '').trim().toLowerCase();
    if (!qn) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    try {
      const headers = jobs.length ? jobs : (await getScheduledJobs()).jobs || [];

      const matched = [];
      const toCheck = [];
      for (const h of headers) {
        const subj = (h.mailOptions && (h.mailOptions.subject || '')).toLowerCase();
        const to = (h.mailOptions && (h.mailOptions.to || '')).toLowerCase();
        const from = (h.mailOptions && (h.mailOptions.from || '')).toLowerCase();
        if (subj.includes(qn) || from.includes(qn) || to.includes(qn)) {
          matched.push(h);
        } else {
          toCheck.push(h);
        }
      }

      const bodyMatches = [];
      const limit = 200;
      const checkList = toCheck.slice(0, limit);
      for (const h of checkList) {
        try {
          const text = ((h.mailOptions && (h.mailOptions.text || '')) + ' ' + (h.mailOptions && (h.mailOptions.html || ''))).toLowerCase();
          if (text.includes(qn)) bodyMatches.push(h);
        } catch (e) { /* ignore */ }
      }

      const uniq = {};
      const results = [];
      for (const x of [...matched, ...bodyMatches]) {
        const key = x.id || JSON.stringify(x.mailOptions || {});
        if (!uniq[key]) { uniq[key] = true; results.push(x); }
      }
      setSearchResults(results);
    } catch (e) {
      console.warn('scheduled search error', e && e.message);
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

  // debounce searchQuery changes
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!showSearch) return;
    searchTimer.current = setTimeout(() => { doSearch(searchQuery); }, 350);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery, showSearch]);

  function formatTime(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d)) return t;
    return d.toLocaleString();
  }

  async function cancelJob(id) {
    if (!window.confirm('Cancel this scheduled send?')) return;
    setBusyId(id);
    try {
      await deleteScheduledJob(id);
      await load();
    } catch (e) {
      alert('Cancel failed: ' + (e && e.message || ''));
    } finally {
      setBusyId(null);
    }
  }

  // dropdown state
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
    <div className="inbox-screen">
      <header className="inbox-header" style={{display:'flex', alignItems:'center', gap:12}}>
        <div className="folder-dropdown" ref={folderRef}>
          <button className="trigger" onClick={() => setFolderOpen(s => !s)} aria-haspopup="menu" aria-expanded={folderOpen}>
            Scheduled <span className="caret">▾</span>
          </button>
          {folderOpen && (
            <div className="menu" role="menu">
              <div className="item" role="menuitem" onClick={() => goFolder('inbox')}>Inbox</div>
              <div className="item" role="menuitem" onClick={() => goFolder('scheduled')}>Scheduled</div>
              <div className="item" role="menuitem" onClick={() => goFolder('trash')}>Trash</div>
            </div>
          )}
        </div>

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

          {!showSearch ? (
            <button style={{background:'transparent', border:'1px solid rgba(0,0,0,0.08)' , padding:8, borderRadius:8, color:'#202124', cursor:'pointer'}} onClick={() => { setShowSearch(true); setTimeout(()=>inputRef.current && inputRef.current.focus(),50); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#5f6368" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="11" cy="11" r="6" stroke="#5f6368" strokeWidth="1.6"/></svg>
            </button>
          ) : (
            <div style={{display:'flex', alignItems:'center', gap:8, padding:'4px 6px', background:'#fff', border:'1px solid rgba(0,0,0,0.08)', borderRadius:8}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#5f6368" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="11" cy="11" r="6" stroke="#5f6368" strokeWidth="1.6"/></svg>
              <input ref={inputRef} value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} onKeyDown={onSearchKey} placeholder="Search scheduled subject, email, or content" style={{padding:'8px 10px', borderRadius:6, border:'none', background:'transparent', color:'#202124', outline:'none', width:300, maxWidth:'40vw'}} />
              <button onClick={()=>{ setShowSearch(false); setSearchQuery(''); setSearchResults(null); }} title="Close search" style={{background:'transparent', border:'none', color:'#5f6368', cursor:'pointer'}}>✕</button>
            </div>
          )}
        </div>
      </header>

      <ul className="message-list">
        {(!paginated || paginated.length === 0) && <li className="empty">{searching ? 'Searching…' : (loading ? 'Loading…' : 'No scheduled sends')}</li>}
        {paginated.map(j => (
          <li key={j.id} className="message-item" onClick={() => onOpenScheduled ? onOpenScheduled(j) : null}>
            <div className="message-body">
              <div className="message-top" style={{display:'flex', justifyContent:'space-between', gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700}}>{j.mailOptions.subject || '(no subject)'}</div>
                  <div style={{color:'#5f6368 ', marginTop:6}}>To: {j.mailOptions.to}</div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{fontSize:12}}>{formatTime(j.sendAt)}</div>
                </div>
              </div>
              <div className="message-preview">{j.mailOptions.text ? (j.mailOptions.text.slice(0,200) + (j.mailOptions.text.length>200? '…':'')) : ''}</div>
            </div>

            <div className="item-actions" onClick={e=>e.stopPropagation()}>
              <button className="list-delete-btn" title="Cancel" onClick={()=>cancelJob(j.id)} disabled={busyId===j.id}>
                {busyId===j.id ? 'Cancelling…' : 'Cancel'}
              </button>
            </div>
          </li>
        ))}
      </ul>
     </div>
   );
 }
