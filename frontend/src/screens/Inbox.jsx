import React, { useState, useEffect, useRef, useMemo } from 'react';
import { listMessages, getMessage, moveToTrash } from '../api';
import { sortMessages } from '../utils/sortMessages';

// Helper: normalize subject by removing Re:, Fwd:, Fw: prefixes
function normalizeSubject(subj = '') {
  return (subj || '')
    .replace(/^\s*(re|fwd|fw)\s*:\s*/gi, '')
    .trim()
    .toLowerCase();
}

// Helper: group messages into threads by normalized subject
function groupIntoThreads(messages) {
  const threadMap = new Map(); // normalized subject -> array of messages
  
  for (const msg of messages) {
    const key = normalizeSubject(msg.subject);
    if (!key) {
      // No subject - treat as individual
      threadMap.set(`__no_subject_${msg.uid}`, [msg]);
      continue;
    }
    
    if (threadMap.has(key)) {
      threadMap.get(key).push(msg);
    } else {
      threadMap.set(key, [msg]);
    }
  }
  
  // Convert to array of threads, sort messages within each thread by date
  const threads = [];
  for (const [key, msgs] of threadMap) {
    // Sort messages in thread: oldest first (for display), newest for thread date
    const sorted = [...msgs].sort((a, b) => new Date(a.date) - new Date(b.date));
    const newest = sorted[sorted.length - 1];
    const oldest = sorted[0];
    
    threads.push({
      id: key,
      subject: oldest.subject, // Original subject from first message
      messages: sorted,
      count: msgs.length,
      // Use newest message's date for sorting threads
      date: newest.date,
      // Use oldest message's from for display (original sender)
      from: oldest.from,
      // Check if any message is unread
      hasUnread: msgs.some(m => !m.seen),
      // Latest message for preview
      latestMessage: newest,
      // All participants
      participants: [...new Set(msgs.map(m => (m.from || '').split('<')[0].trim()).filter(Boolean))]
    });
  }
  
  return threads;
}

export default function Inbox({ onOpenCompose, onOpenMessage, seenOverrides, onNavigate }) {
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const inputRef = useRef(null);
  const searchTimer = useRef(null);
  const [sortDir, setSortDir] = useState('desc');

  async function load() {
    const r = await listMessages();
    setMessages(r.messages || []);
  }

  useEffect(() => { load(); }, []);

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
      const headers = messages.length ? messages : (await listMessages()).messages || [];
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
        } catch (e) { /* ignore */ }
      }));

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

  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!showSearch) return;
    searchTimer.current = setTimeout(() => {
      doSearch(searchQuery);
    }, 350);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery, showSearch]);

  const rawList = (searchResults !== null || searching || showSearch) ? (searchResults || []) : messages;

  // Group messages into threads
  const threads = useMemo(() => {
    const grouped = groupIntoThreads(rawList);
    // Sort threads by date
    return grouped.sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      return sortDir === 'desc' ? dateB - dateA : dateA - dateB;
    });
  }, [rawList, sortDir]);

  const PAGE_SIZE = 7;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [messages.length, searchResults, searching, showSearch]);
  const totalPages = Math.max(1, Math.ceil(threads.length / PAGE_SIZE));
  const paginated = threads.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
    if (diff < 1000 * 60 * 60 * 24) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString();
  }

  async function deleteThread(e, thread) {
    e.stopPropagation();
    try {
      // Delete all messages in the thread
      for (const m of thread.messages) {
        const composite = m.mailbox ? `${m.mailbox}::${m.uid}` : m.uid;
        await moveToTrash(composite);
      }
      await load();
    } catch (err) {
      console.warn('move to trash failed', err && err.message);
    }
  }

  // Open thread - if single message, open directly; if multiple, open the latest
  function openThread(thread) {
    const msg = thread.latestMessage;
    const composite = msg.mailbox ? `${msg.mailbox}::${msg.uid}` : msg.uid;
    if (onOpenMessage) onOpenMessage(composite);
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

  return (
    <div className="inbox-screen">
      <header className="inbox-header" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div className="folder-dropdown" ref={folderRef}>
          <button className="trigger" onClick={() => setFolderOpen(s => !s)} aria-haspopup="menu" aria-expanded={folderOpen}>
            Inbox <span className="caret">▾</span>
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
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div className="pagination-inline" role="navigation" aria-label="Pagination">
              <button className="pagination-btn" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>Prev</button>
              <div className="pagination-info">{page} / {totalPages}</div>
              <button className="pagination-btn" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</button>
            </div>
          </div>

          {!showSearch ? (
            <button
              className="search-btn"
              aria-label="Open search"
              onClick={() => { setShowSearch(true); setTimeout(() => inputRef.current && inputRef.current.focus(), 50); }}
              style={{ background: 'transparent', border: '1px solid rgba(0,0,0,0.08)', padding: 8, borderRadius: 8, color: '#202124', cursor: 'pointer' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#5f6368" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="11" cy="11" r="6" stroke="#9aa6b2" strokeWidth="1.6" /></svg>
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', background: '#fff', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 8 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35" stroke="#5f6368" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="11" cy="11" r="6" stroke="#9aa6b2" strokeWidth="1.6" /></svg>
              <input
                ref={inputRef}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder="Search subject, email, or content"
                style={{ padding: '8px 10px', borderRadius: 6, border: 'none', background: 'transparent', color: '#202124', outline: 'none', width: 300, maxWidth: '40vw' }}
              />
              <button onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchResults(null); }} title="Close search" style={{ background: 'transparent', border: 'none', color: '#9aa6b2', cursor: 'pointer', padding: 6 }}>✕</button>
            </div>
          )}
        </div>
      </header>

      <ul className="message-list">
        {(!threads || threads.length === 0) && <li className="empty">{searching ? 'Searching…' : 'No messages'}</li>}
        {paginated.map(thread => {
          const hasUnread = thread.hasUnread || thread.messages.some(m => seenOverrides && !seenOverrides[m.uid] && !m.seen);
          const isUnread = thread.messages.some(m => !m.seen && !(seenOverrides && seenOverrides[m.uid]));
          
          return (
            <li 
              key={thread.id} 
              className="message-item" 
              onClick={() => openThread(thread)}
              style={isUnread ? { background: '#f2f6fc' } : {}}
            >
              <div className="avatar">{avatarFor(thread.from)}</div>

              <div className="message-body">
                <div className="message-top">
                  <div className="sender">
                    <div className="sender-name" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {isUnread && <span className="unread-dot" aria-hidden="true" />}
                      <span style={{ fontWeight: isUnread ? 700 : 500 }}>
                        {thread.participants.length > 1 
                          ? thread.participants.slice(0, 2).join(', ') + (thread.participants.length > 2 ? ` +${thread.participants.length - 2}` : '')
                          : (thread.from || '').split('<')[0].trim() || 'Unknown'
                        }
                      </span>
                      {/* Thread count badge */}
                      {thread.count > 1 && (
                        <span style={{
                          background: '#e8eaed',
                          color: '#5f6368',
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '2px 6px',
                          borderRadius: 10,
                          marginLeft: 4
                        }}>
                          {thread.count}
                        </span>
                      )}
                    </div>
                    <div className="subject" style={{ fontWeight: isUnread ? 600 : 400 }}>
                      {thread.subject || '(no subject)'}
                    </div>
                  </div>
                  <div className="time">{formatTime(thread.date)}</div>
                </div>

                <div className="message-preview">
                  <span className="preview-text" style={{ color: '#5f6368' }}>
                    {thread.count > 1 && (
                      <span style={{ color: '#1a73e8', marginRight: 4 }}>
                        {thread.latestMessage.from?.split('<')[0].trim()}:
                      </span>
                    )}
                    {thread.latestMessage.subject ? (thread.latestMessage.subject + ' — ') : ''}
                  </span>
                </div>
              </div>

              <div className="item-actions" onClick={e => e.stopPropagation()}>
                <button 
                  className="list-delete-btn" 
                  title={thread.count > 1 ? `Move ${thread.count} messages to Trash` : 'Move to Trash'} 
                  onClick={(e) => deleteThread(e, thread)}
                >
                  🗑
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}