import React, { useEffect, useState, useRef } from 'react';
import { getTrashMessages, deleteMessagePermanent, restoreFromTrash } from '../api';

export default function Trash({ onOpenMessage, onNavigate }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const PAGE_SIZE = 7;
  const [page, setPage] = useState(1);

  async function load() {
    setLoading(true);
    try {
      const r = await getTrashMessages();
      setMessages((r && r.messages) || []);
      setPage(1);
    } catch (e) {
      console.warn('load trash failed', e && e.message);
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // re-render timers every minute
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60 * 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { setPage(1); }, [messages.length]);

  function remainingTimeLabel(movedAt) {
    if (!movedAt) return '';
    const start = new Date(movedAt).getTime();
    if (isNaN(start)) return '';
    const days30 = 1000 * 60 * 60 * 24 * 30;
    const diff = start + days30 - Date.now();
    if (diff <= 0) return 'Deleting soon';
    const days = Math.floor(diff / (1000*60*60*24));
    const hours = Math.floor((diff % (1000*60*60*24)) / (1000*60*60));
    if (days > 0) return `Deletes in ${days}d ${hours}h`;
    const mins = Math.floor(diff / (1000*60));
    if (mins > 0) return `Deletes in ${mins}m`;
    return 'Deleting soon';
  }

  async function deletePermanent(e, m) {
    e.stopPropagation();
    // confirm destructive action
    if (!window.confirm('Permanently delete this message? This cannot be undone.')) return;
    try {
      const composite = m.mailbox ? `${m.mailbox}::${m.uid}` : m.uid;
      await deleteMessagePermanent(composite);
      await load();
    } catch (err) {
      console.warn('delete permanent failed', err && err.message);
    }
  }

  async function restoreItem(e, m) {
    e.stopPropagation();
    try {
      const composite = m.mailbox ? `${m.mailbox}::${m.uid}` : m.uid;
      await restoreFromTrash(composite);
      await load();
    } catch (err) {
      console.warn('restore failed', err && err.message);
      alert('Restore failed: ' + (err && err.message || ''));
    }
  }

  // dropdown same as Inbox
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
  function goFolder(target) { setFolderOpen(false); if (onNavigate) onNavigate(target); }

  function open(m) {
    const composite = m.mailbox ? `${m.mailbox}::${m.uid}` : m.uid;
    onOpenMessage && onOpenMessage(composite);
  }

  const listToRender = messages || [];
  const totalPages = Math.max(1, Math.ceil(listToRender.length / PAGE_SIZE));
  const paginated = listToRender.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="inbox-screen">
      <header className="inbox-header" style={{display:'flex', alignItems:'center', gap:12}}>
        <div className="folder-dropdown" ref={folderRef}>
          <button className="trigger" onClick={() => setFolderOpen(s => !s)} aria-haspopup="menu" aria-expanded={folderOpen}>
            Trash <span className="caret">▾</span>
          </button>
          {folderOpen && (
            <div className="menu" role="menu">
              <div className="item" role="menuitem" onClick={() => goFolder('inbox')}>Inbox</div>
              <div className="item" role="menuitem" onClick={() => goFolder('scheduled')}>Scheduled</div>
              <div className="item" role="menuitem" onClick={() => goFolder('trash')}>Trash</div>
            </div>
          )}
        </div>

        <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:12}}>
          <div>
            <div className="pagination-inline" role="navigation" aria-label="Pagination">
              <button className="pagination-btn" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page<=1}>Prev</button>
              <div className="pagination-info">{page} / {totalPages}</div>
              <button className="pagination-btn" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page>=totalPages}>Next</button>
            </div>
          </div>
        </div>
      </header>

      <ul className="message-list">
        {(!messages || messages.length === 0) && <li className="empty">{loading ? 'Loading…' : 'No messages in Trash'}</li>}
        {paginated.map(m => {
           const movedAt = m.xMovedAt || m['x-moved-at'] || null;
           return (
             <li key={`${m.mailbox||'TRASH'}::${m.uid}`} className="message-item" onClick={() => open(m)}>
              <div className="avatar">{(m.from||m.to||'').split(' ')[0].slice(0,2).toUpperCase()}</div>

              <div className="message-body">
                <div className="message-top">
                  <div className="sender">
                    <div className="sender-name">{(m.from || '').split('<')[0].trim() || m.from || 'Unknown'}</div>
                    <div className="subject">{m.subject || '(no subject)'}</div>
                  </div>
                  <div style={{display:'flex', flexDirection:'column', alignItems:'flex-end'}}>
                    <div className="time">{ movedAt ? new Date(movedAt).toLocaleString() : (m.date ? new Date(m.date).toLocaleDateString() : '') }</div>
                    <div className="trash-timer">{ remainingTimeLabel(movedAt || m.date) }</div>
                  </div>
                </div>
                <div className="message-preview">{m.subject ? (m.subject + ' — ') : ''}</div>
              </div>

            <div className="item-actions" onClick={e=>e.stopPropagation()}>
              <button className="list-delete-btn" title="Restore" onClick={(e)=>restoreItem(e, m)}>↩</button>
              <button className="list-delete-btn" title="Delete permanently" onClick={(e)=>deletePermanent(e, m)}>🗑</button>
            </div>
           </li>
           );
         })}
       </ul>
     </div>
   );
 }
