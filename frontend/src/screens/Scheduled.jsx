import React, { useEffect, useState, useRef } from 'react';
import { getScheduledJobs, deleteScheduledJob } from '../api';
import { sortMessages } from '../utils/sortMessages';

export default function Scheduled({ onNavigate }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);
  const searchTimer = useRef(null);
  const [sortDir, setSortDir] = useState('desc');
  
  // Expanded job detail view
  const [expandedId, setExpandedId] = useState(null);

  // Helper to get job properties (supports both old mailOptions and new flat structure)
  function getJobProp(job, prop) {
    if (!job) return '';
    if (job[prop] !== undefined) return job[prop];
    if (job.mailOptions && job.mailOptions[prop] !== undefined) return job.mailOptions[prop];
    if (prop === 'to' && job.mail_to) return job.mail_to;
    if (prop === 'subject' && job.mail_subject) return job.mail_subject;
    if (prop === 'text' && job.mail_text) return job.mail_text;
    if (prop === 'html' && job.mail_html) return job.mail_html;
    return '';
  }

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

  async function doSearch(q) {
    const qn = (q || '').trim().toLowerCase();
    if (!qn) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    try {
      const headers = jobs.length ? jobs : (await getScheduledJobs()).jobs || [];

      const matched = [];
      const toCheck = [];
      for (const h of headers) {
        const subj = (getJobProp(h, 'subject') || '').toLowerCase();
        const to = (getJobProp(h, 'to') || '').toLowerCase();
        if (subj.includes(qn) || to.includes(qn)) {
          matched.push(h);
        } else {
          toCheck.push(h);
        }
      }

      const bodyMatches = [];
      for (const h of toCheck.slice(0, 200)) {
        try {
          const text = ((getJobProp(h, 'text') || '') + ' ' + (getJobProp(h, 'html') || '')).toLowerCase();
          if (text.includes(qn)) bodyMatches.push(h);
        } catch (e) {}
      }

      const uniq = {};
      const results = [];
      for (const x of [...matched, ...bodyMatches]) {
        const key = x.id;
        if (!uniq[key]) { uniq[key] = true; results.push(x); }
      }
      setSearchResults(results);
    } catch (e) {
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
      setExpandedId(null);
      await load();
    } catch (e) {
      alert('Cancel failed: ' + (e && e.message || ''));
    } finally {
      setBusyId(null);
    }
  }

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

  function getStatusColor(status) {
    switch (status) {
      case 'sent': return { bg: '#e6f4ea', color: '#1e8e3e' };
      case 'failed': return { bg: '#fce8e6', color: '#d93025' };
      case 'pending': 
      default: return { bg: '#e8f0fe', color: '#1a73e8' };
    }
  }

  function toggleExpand(id) {
    setExpandedId(prev => prev === id ? null : id);
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
          <div className="pagination-inline" role="navigation" aria-label="Pagination">
            <button className="pagination-btn" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page<=1}>Prev</button>
            <div className="pagination-info">{page} / {totalPages}</div>
            <button className="pagination-btn" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page>=totalPages}>Next</button>
          </div>

          {!showSearch ? (
            <button style={{background:'transparent', border:'1px solid rgba(0,0,0,0.08)', padding:8, borderRadius:8, color:'#202124', cursor:'pointer'}} onClick={() => { setShowSearch(true); setTimeout(()=>inputRef.current?.focus(),50); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#5f6368" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="11" cy="11" r="6" stroke="#5f6368" strokeWidth="1.6"/></svg>
            </button>
          ) : (
            <div style={{display:'flex', alignItems:'center', gap:8, padding:'4px 6px', background:'#fff', border:'1px solid rgba(0,0,0,0.08)', borderRadius:8}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#5f6368" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><circle cx="11" cy="11" r="6" stroke="#5f6368" strokeWidth="1.6"/></svg>
              <input ref={inputRef} value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} onKeyDown={onSearchKey} placeholder="Search scheduled..." style={{padding:'8px 10px', borderRadius:6, border:'none', background:'transparent', color:'#202124', outline:'none', width:250}} />
              <button onClick={()=>{ setShowSearch(false); setSearchQuery(''); setSearchResults(null); }} style={{background:'transparent', border:'none', color:'#5f6368', cursor:'pointer'}}>✕</button>
            </div>
          )}
        </div>
      </header>

      <ul className="message-list">
        {(!paginated || paginated.length === 0) && (
          <li className="empty">{searching ? 'Searching…' : (loading ? 'Loading…' : 'No scheduled sends')}</li>
        )}
        {paginated.map(j => {
          const jobSubject = getJobProp(j, 'subject') || '(no subject)';
          const jobTo = getJobProp(j, 'to') || '';
          const jobText = getJobProp(j, 'text') || '';
          const jobHtml = getJobProp(j, 'html') || '';
          const jobStatus = j.status || 'pending';
          const statusStyle = getStatusColor(jobStatus);
          const attachmentCount = j.attachments || 0;
          const isExpanded = expandedId === j.id;

          return (
            <li 
              key={j.id} 
              className="message-item" 
              style={{
                cursor: 'pointer',
                background: isExpanded ? '#f8f9fa' : undefined,
                borderLeft: isExpanded ? '3px solid #1a73e8' : undefined
              }}
              onClick={() => toggleExpand(j.id)}
            >
              <div className="message-body">
                <div className="message-top" style={{display:'flex', justifyContent:'space-between', gap:12}}>
                  <div style={{flex:1}}>
                    <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
                      <span style={{fontWeight:700}}>{jobSubject}</span>
                      <span style={{
                        fontSize: 11,
                        padding: '2px 8px',
                        borderRadius: 12,
                        background: statusStyle.bg,
                        color: statusStyle.color,
                        fontWeight: 500,
                        textTransform: 'capitalize'
                      }}>
                        {jobStatus}
                      </span>
                      {attachmentCount > 0 && (
                        <span style={{fontSize: 12, color: '#5f6368'}}>📎 {attachmentCount}</span>
                      )}
                      <span style={{fontSize: 12, color: '#5f6368'}}>
                        {isExpanded ? '▼' : '▶'}
                      </span>
                    </div>
                    <div style={{color:'#5f6368', marginTop:6, fontSize: 13}}>To: {jobTo}</div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div style={{fontSize:12, color: '#5f6368'}}>{formatTime(j.sendAt)}</div>
                    {j.error && (
                      <div style={{fontSize:11, color:'#d93025', marginTop:4}} title={j.error}>⚠ Error</div>
                    )}
                  </div>
                </div>

                {/* Preview (always shown, truncated) */}
                {!isExpanded && jobText && (
                  <div className="message-preview" style={{marginTop: 8, color: '#5f6368', fontSize: 13}}>
                    {jobText.slice(0, 150)}{jobText.length > 150 ? '…' : ''}
                  </div>
                )}

                {/* Expanded view - full content */}
                {isExpanded && (
                  <div 
                    style={{
                      marginTop: 16,
                      padding: 16,
                      background: '#fff',
                      borderRadius: 8,
                      border: '1px solid #e8eaed'
                    }}
                    onClick={e => e.stopPropagation()}
                  >
                    {/* Header info */}
                    <div style={{marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #e8eaed'}}>
                      <div style={{display: 'flex', gap: 8, marginBottom: 8}}>
                        <span style={{color: '#5f6368', fontWeight: 500, width: 80}}>To:</span>
                        <span style={{color: '#202124'}}>{jobTo}</span>
                      </div>
                      <div style={{display: 'flex', gap: 8, marginBottom: 8}}>
                        <span style={{color: '#5f6368', fontWeight: 500, width: 80}}>Subject:</span>
                        <span style={{color: '#202124', fontWeight: 600}}>{jobSubject}</span>
                      </div>
                      <div style={{display: 'flex', gap: 8, marginBottom: 8}}>
                        <span style={{color: '#5f6368', fontWeight: 500, width: 80}}>Send at:</span>
                        <span style={{color: '#1a73e8', fontWeight: 500}}>{formatTime(j.sendAt)}</span>
                      </div>
                      {attachmentCount > 0 && (
                        <div style={{display: 'flex', gap: 8}}>
                          <span style={{color: '#5f6368', fontWeight: 500, width: 80}}>Attachments:</span>
                          <span style={{color: '#202124'}}>📎 {attachmentCount} file(s)</span>
                        </div>
                      )}
                    </div>

                    {/* Email body */}
                    <div style={{
                      maxHeight: 300,
                      overflowY: 'auto',
                      fontSize: 14,
                      lineHeight: 1.6,
                      color: '#202124'
                    }}>
                      {jobHtml ? (
                        <div dangerouslySetInnerHTML={{ __html: jobHtml }} />
                      ) : (
                        <div style={{whiteSpace: 'pre-wrap'}}>{jobText || '(no content)'}</div>
                      )}
                    </div>

                    {/* Error message if any */}
                    {j.error && (
                      <div style={{
                        marginTop: 12,
                        padding: 12,
                        background: '#fce8e6',
                        borderRadius: 6,
                        color: '#d93025',
                        fontSize: 13
                      }}>
                        <strong>Error:</strong> {j.error}
                      </div>
                    )}

                    {/* Actions */}
                    <div style={{marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
                      {jobStatus === 'pending' && (
                        <button
                          onClick={() => cancelJob(j.id)}
                          disabled={busyId === j.id}
                          style={{
                            background: '#fce8e6',
                            color: '#d93025',
                            border: 'none',
                            padding: '8px 16px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontWeight: 500
                          }}
                        >
                          {busyId === j.id ? 'Cancelling…' : '✕ Cancel Send'}
                        </button>
                      )}
                      <button
                        onClick={() => setExpandedId(null)}
                        style={{
                          background: '#f1f3f4',
                          color: '#5f6368',
                          border: 'none',
                          padding: '8px 16px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          fontWeight: 500
                        }}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}