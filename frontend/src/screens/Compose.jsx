import React, { useState, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { sendMail, saveDraft as saveDraftAPI, scheduleMail } from '../api';

export default function Compose({ onSent, onCancel, noPortal = false, initialData = null }) {
  const [recipients, setRecipients] = useState([]);
  const [toInput, setToInput] = useState('');
  const [subject, setSubject] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const [sendLater, setSendLater] = React.useState(false);
  const [scheduledAt, setScheduledAt] = React.useState('');
  const [scheduling, setScheduling] = React.useState(false);
  const fileRef = useRef();
  const editorRef = useRef(null);
  const [fontSize, setFontSize] = useState('normal');
  
  // Track active formatting states
  const [activeBold, setActiveBold] = useState(false);
  const [activeItalic, setActiveItalic] = useState(false);
  const [activeUnderline, setActiveUnderline] = useState(false);

  const DRAFT_KEY = 'mail:compose:draft';
  const draftTimer = useRef(null);
  const [draftSavedAt, setDraftSavedAt] = useState(null);

  // Get editor HTML content
  const getEditorContent = useCallback(() => {
    if (editorRef.current) {
      return editorRef.current.innerHTML;
    }
    return '';
  }, []);

  // Get plain text from editor
  const getEditorText = useCallback(() => {
    if (editorRef.current) {
      return editorRef.current.innerText || editorRef.current.textContent || '';
    }
    return '';
  }, []);

  React.useEffect(() => {
    try {
      if (initialData && Object.keys(initialData).length) {
        if (initialData.recipients) setRecipients(initialData.recipients);
        if (initialData.toInput) setToInput(initialData.toInput);
        if (initialData.subject) setSubject(initialData.subject);
        if (initialData.body && editorRef.current) {
          // Convert plain text to HTML for display
          editorRef.current.innerHTML = escapeHtml(initialData.body).replace(/\n/g, '<br>');
        }
        if (initialData.savedAt) setDraftSavedAt(initialData.savedAt);
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
        return;
      }
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d.recipients) setRecipients(d.recipients);
        if (d.toInput) setToInput(d.toInput);
        if (d.subject) setSubject(d.subject);
        if (d.bodyHtml && editorRef.current) {
          editorRef.current.innerHTML = d.bodyHtml;
        }
        if (d.savedAt) setDraftSavedAt(d.savedAt);
      }
    } catch (e) {}
  }, []);

  function saveLocalDraft() {
    try {
      const bodyHtml = getEditorContent();
      const bodyText = getEditorText();
      const payload = { recipients, toInput, subject, bodyHtml, bodyText, savedAt: Date.now() };
      if ((recipients && recipients.length) || (toInput || '').trim() || (subject || '').trim() || bodyText.trim()) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
        setDraftSavedAt(payload.savedAt);
      } else {
        localStorage.removeItem(DRAFT_KEY);
        setDraftSavedAt(null);
      }
    } catch (e) {}
  }

  function clearLocalDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    setDraftSavedAt(null);
  }

  async function handleClose() {
    const trimmedInput = (toInput || '').trim();
    const combined = [...recipients];
    if (trimmedInput) combined.push(trimmedInput);
    const finalRecipients = Array.from(new Set(combined.map(r => (r || '').trim()).filter(Boolean)));

    const bodyText = getEditorText();
    const bodyHtml = getEditorContent();
    const hasContent = finalRecipients.length > 0 || (subject || '').trim() || bodyText.trim();

    if (hasContent) {
      try {
        await saveDraftAPI({
          to: finalRecipients.join(', '),
          subject,
          text: bodyText,
          html: bodyHtml,
          from: undefined
        });
        clearLocalDraft();
      } catch (e) {
        console.warn('saveDraft failed', e && (e.message || e));
      }
    } else {
      clearLocalDraft();
    }
    onCancel && onCancel();
  }

  // Auto-save draft on content change
  const handleEditorInput = useCallback(() => {
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { saveLocalDraft(); }, 1000);
    updateActiveFormats();
  }, [recipients, toInput, subject]);

  React.useEffect(() => {
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { saveLocalDraft(); }, 1000);
    return () => clearTimeout(draftTimer.current);
  }, [recipients, toInput, subject]);

  React.useEffect(() => {
    return () => { clearTimeout(draftTimer.current); };
  }, []);

  // Update active format states based on current selection
  const updateActiveFormats = useCallback(() => {
    setActiveBold(document.queryCommandState('bold'));
    setActiveItalic(document.queryCommandState('italic'));
    setActiveUnderline(document.queryCommandState('underline'));
  }, []);

  function formatTimeAgo(ts) {
    if (!ts) return '';
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  }

  function addRecipient(value) {
    const v = (value || '').trim();
    if (!v) return;
    setRecipients(prev => Array.from(new Set([...prev, v])));
  }
  function removeRecipient(ix) {
    setRecipients(prev => prev.filter((_,i)=>i!==ix));
  }
  function handleToKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addRecipient(toInput);
      setToInput('');
    } else if (e.key === 'Backspace' && !toInput && recipients.length) {
      setRecipients(prev => prev.slice(0, -1));
    }
  }

  function handleFiles(files) {
    const arr = Array.from(files).map(f => ({ file: f, name: f.name, size: f.size }));
    setAttachments(prev => [...prev, ...arr]);
  }
  function removeAttachment(ix) {
    setAttachments(prev => prev.filter((_,i)=>i!==ix));
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function submit(e) {
    e && e.preventDefault && e.preventDefault();
    setErr('');

    const trimmedInput = (toInput || '').trim();
    const combined = [...recipients];
    if (trimmedInput) combined.push(trimmedInput);
    const finalRecipients = Array.from(new Set(combined.map(r => (r || '').trim()).filter(Boolean)));

    if (finalRecipients.length === 0) {
      setErr('Add at least one recipient');
      return;
    }

    const bodyHtml = getEditorContent();
    const bodyText = getEditorText();

    if (sendLater && scheduledAt) {
      // NOW SUPPORTS ATTACHMENTS - removed the block
      setScheduling(true);
      try {
        const to = finalRecipients.join(', ');
        const payload = { 
          to, 
          subject, 
          text: bodyText, 
          html: bodyHtml, 
          sendAt: new Date(scheduledAt).toISOString() 
        };
        
        // Include attachments if any
        if (attachments && attachments.length) {
          payload.attachments = attachments;
        }
        
        const r = await scheduleMail(payload);
        if (r && r.success) {
          setRecipients([]); setToInput(''); setSubject(''); 
          if (editorRef.current) editorRef.current.innerHTML = '';
          setAttachments([]);
          clearLocalDraft();
          onSent && onSent();
        } else {
          setErr(r && r.error ? r.error : 'Schedule failed');
        }
      } catch (ex) {
        setErr(ex && ex.message ? ex.message : 'Schedule error');
      } finally {
        setScheduling(false);
      }
      return;
    }

    setSending(true);
    try {
      const to = finalRecipients.join(', ');
      const payload = { to, subject, text: bodyText, html: bodyHtml };
      if (attachments && attachments.length) payload.attachments = attachments;
      const r = await sendMail(payload);
      if (r.success) {
        setRecipients([]); setToInput(''); setSubject('');
        if (editorRef.current) editorRef.current.innerHTML = '';
        setAttachments([]);
        clearLocalDraft();
        onSent && onSent();
      } else {
        setErr(r.error || 'Send failed');
      }
    } catch (ex) {
      setErr(ex.message || 'Send error');
    } finally {
      setSending(false);
    }
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/(1024*1024)).toFixed(1) + ' MB';
  }

  // ========== WYSIWYG Formatting Functions ==========
  function execCommand(command, value = null) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    updateActiveFormats();
  }

  function toggleBold() {
    execCommand('bold');
  }

  function toggleItalic() {
    execCommand('italic');
  }

  function toggleUnderline() {
    execCommand('underline');
  }

  function toggleList() {
    execCommand('insertUnorderedList');
  }

  function applyFontSize(size) {
    const sizeMap = {
      small: '2',    // ~10px
      normal: '3',   // ~16px (default)
      large: '5',    // ~24px
      huge: '6'      // ~32px
    };
    execCommand('fontSize', sizeMap[size] || '3');
    setFontSize(size);
  }

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'b':
          e.preventDefault();
          toggleBold();
          break;
        case 'i':
          e.preventDefault();
          toggleItalic();
          break;
        case 'u':
          e.preventDefault();
          toggleUnderline();
          break;
      }
    }
  }, []);

  // ========== LIGHT THEME STYLES ==========
  const s = {
    overlay: {
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.25)',
      zIndex: 1000,
      padding: 20,
      boxSizing: 'border-box'
    },
    modal: {
      width: 'min(900px, 98%)',
      maxWidth: '900px',
      maxHeight: '90vh',
      overflow: 'hidden',
      borderRadius: 12,
      background: '#ffffff',
      boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
      border: '1px solid rgba(0,0,0,0.08)',
      display: 'flex',
      flexDirection: 'column',
      color: '#202124'
    },
    screen: { display:'flex', flexDirection:'column', height:'100%', background:'#fff', color:'#202124' },
    header: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid rgba(0,0,0,0.08)', background:'#f8f9fa' },
    title: { fontWeight:600, fontSize:16, textAlign:'center', flex:1, color:'#202124' },
    smallBtn: { background:'transparent', border:'none', color:'#5f6368', fontSize:18, cursor:'pointer', padding:8, borderRadius:6 },
    sendBtn: { background:'#1a73e8', color:'#fff', border:'none', padding:'8px 16px', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:14 },
    discardBtn: { background:'transparent', border:'1px solid rgba(0,0,0,0.08)', color:'#5f6368', padding:'6px 12px', borderRadius:6, cursor:'pointer', fontSize:13 },
    form: { padding:'16px', display:'flex', flexDirection:'column', gap:12, overflow:'auto', flex:1, maxHeight:'60vh' },
    toRow: { display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' },
    label: { width:32, color:'#5f6368', fontWeight:500, fontSize:14 },
    chips: { display:'flex', gap:6, flexWrap:'wrap', alignItems:'center', flex:1 },
    chip: { background:'#e8f0fe', color:'#1a73e8', padding:'4px 10px', borderRadius:16, display:'inline-flex', alignItems:'center', gap:6, fontSize:13 },
    chipX: { background:'transparent', border:'none', color:'#5f6368', cursor:'pointer', fontSize:12 },
    inputInline: { background:'transparent', border:'none', color:'#202124', outline:'none', minWidth:120, padding:'6px 4px', fontSize:14 },
    subject: { width:'100%', padding:'10px 12px', borderRadius:6, background:'#fff', border:'1px solid rgba(0,0,0,0.08)', color:'#202124', fontSize:14 },
    attachCard: { background:'#f1f3f4', borderRadius:8, padding:10, display:'flex', alignItems:'center', gap:12, border:'1px solid rgba(0,0,0,0.06)' },
    attachName: { fontWeight:600, color:'#202124', fontSize:13 },
    editor: {
      flex: 1,
      minHeight: 180,
      maxHeight: '40vh',
      padding: 12,
      borderRadius: 6,
      background: '#fff',
      color: '#202124',
      border: '1px solid rgba(0,0,0,0.08)',
      outline: 'none',
      overflowY: 'auto',
      fontSize: 14,
      lineHeight: 1.6,
      cursor: 'text'
    },
    topToolbar: {
      position:'sticky',
      top:0,
      zIndex:30,
      display:'flex',
      alignItems:'center',
      gap:8,
      padding:'8px 0',
      background:'#fff',
      borderBottom:'1px solid rgba(0,0,0,0.06)'
    },
    iconBtn: { 
      background:'transparent', 
      border:'1px solid transparent', 
      color:'#5f6368', 
      fontSize:16, 
      cursor:'pointer', 
      padding:'6px 10px', 
      borderRadius:4,
      minWidth: 32,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    },
    iconBtnActive: {
      background: '#e8f0fe',
      border: '1px solid #1a73e8',
      color: '#1a73e8'
    },
    dateInput: { padding:8, borderRadius:6, border:'1px solid rgba(0,0,0,0.08)', background:'#fff', color:'#202124', fontSize:13 }
  };

  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Handle selection change to update active formats
  React.useEffect(() => {
    const handleSelectionChange = () => {
      if (editorRef.current && editorRef.current.contains(document.activeElement)) {
        updateActiveFormats();
      }
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, [updateActiveFormats]);

  const jsx = (
    <div
      className="compose-overlay"
      style={s.overlay}
      onMouseDown={e => { if (e.target === e.currentTarget) handleClose(); }}
      aria-hidden={false}
    >
      <div className="compose-modal" role="dialog" aria-label="Compose email" style={s.modal}>
        <div className="compose-header" style={s.header}>
          <button style={s.smallBtn} onClick={handleClose} aria-label="Close">✕</button>

          <div style={{display:'flex', flexDirection:'column', alignItems:'center', flex:1}}>
            <div className="compose-title" style={s.title}>Compose</div>
            {draftSavedAt ? (
              <div style={{fontSize:11, color:'#5f6368', marginTop:2}}>
                Draft saved · {formatTimeAgo(draftSavedAt)}
              </div>
            ) : (
              <div style={{height:14}} />
            )}
          </div>

          <div className="compose-actions" style={{display:'flex', gap:8, alignItems:'center'}}>
            <button
              type="button"
              onClick={() => { clearLocalDraft(); if (editorRef.current) editorRef.current.innerHTML = ''; onCancel && onCancel(); }}
              style={s.discardBtn}
            >
              Discard
            </button>

            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <label style={{display:'flex', alignItems:'center', gap:6, color:'#5f6368', fontSize:13}}>
                <input type="checkbox" checked={sendLater} onChange={e=>setSendLater(e.target.checked)} />
                Send later
              </label>
              <button style={s.sendBtn} onClick={submit} disabled={sending || scheduling}>
                {scheduling ? 'Scheduling...' : (sending ? 'Sending...' : 'Send')}
              </button>
            </div>
          </div>
        </div>

        <form style={s.form} onSubmit={submit}>
          {sendLater && (
            <div style={{display:'flex', gap:8, alignItems:'center', marginBottom:4}}>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={e=>setScheduledAt(e.target.value)}
                style={s.dateInput}
              />
              <div style={{color:'#5f6368', fontSize:12}}>Time is local; timezone will be preserved on schedule.</div>
            </div>
          )}

          <div style={s.toRow}>
            <div style={s.label}>To:</div>
            <div style={s.chips}>
              {recipients.map((r,ix) => (
                <div key={ix} style={s.chip}>
                  <span>{r}</span>
                  <button type="button" style={s.chipX} onClick={()=>removeRecipient(ix)} aria-label="Remove recipient">✕</button>
                </div>
              ))}
              <input
                value={toInput}
                onChange={e=>setToInput(e.target.value)}
                onKeyDown={handleToKeyDown}
                placeholder="Add recipients"
                style={s.inputInline}
              />
            </div>
          </div>

          <input
            style={s.subject}
            placeholder="Subject"
            value={subject}
            onChange={e=>setSubject(e.target.value)}
          />

          <div className="topToolbar" style={s.topToolbar} role="toolbar" aria-label="Formatting toolbar">
            <button 
              type="button" 
              style={{...s.iconBtn, ...(activeBold ? s.iconBtnActive : {})}} 
              title="Bold (Ctrl+B)" 
              onClick={toggleBold}
            >
              <strong>B</strong>
            </button>
            <button 
              type="button" 
              style={{...s.iconBtn, ...(activeItalic ? s.iconBtnActive : {})}} 
              title="Italic (Ctrl+I)" 
              onClick={toggleItalic}
            >
              <em>I</em>
            </button>
            <button 
              type="button" 
              style={{...s.iconBtn, ...(activeUnderline ? s.iconBtnActive : {})}} 
              title="Underline (Ctrl+U)" 
              onClick={toggleUnderline}
            >
              <u>U</u>
            </button>
            <button type="button" style={s.iconBtn} title="List" onClick={toggleList}>☰</button>
            
            {/* Font Size Dropdown */}
            <select
              value={fontSize}
              onChange={e => applyFontSize(e.target.value)}
              style={{
                background: '#fff',
                border: '1px solid #dadce0',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 13,
                color: '#5f6368',
                cursor: 'pointer',
                outline: 'none'
              }}
              title="Font Size"
            >
              <option value="small">Small</option>
              <option value="normal">Normal</option>
              <option value="large">Large</option>
              <option value="huge">Huge</option>
            </select>
            
            <div style={{flex:1}} />
            <button type="button" style={s.iconBtn} title="More">⋮</button>
          </div>

          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            {attachments.map((a,ix) => (
              <div key={ix} style={s.attachCard}>
                <div style={{width:36, height:36, borderRadius:6, background:'#1a73e8', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:600, fontSize:12}}>📄</div>
                <div style={{flex:1}}>
                  <div style={s.attachName}>{a.name}</div>
                  <div style={{color:'#5f6368', fontSize:12}}>{fmtSize(a.size)}</div>
                </div>
                <button type="button" onClick={()=>removeAttachment(ix)} style={{...s.iconBtn, color:'#5f6368'}}>✕</button>
              </div>
            ))}

            <div style={{display:'flex', gap:8, alignItems:'center'}}>
              <input ref={fileRef} type="file" multiple style={{display:'none'}} onChange={e=>handleFiles(e.target.files)} />
              <button type="button" onClick={()=>fileRef.current && fileRef.current.click()} style={{...s.iconBtn, border:'1px solid rgba(0,0,0,0.08)', padding:'8px 12px', borderRadius:6, color:'#5f6368'}}>📎 Attach</button>
            </div>
          </div>

          {/* WYSIWYG Editor using contentEditable */}
          <div
            ref={editorRef}
            contentEditable
            style={s.editor}
            onInput={handleEditorInput}
            onKeyDown={handleKeyDown}
            onMouseUp={updateActiveFormats}
            data-placeholder="Compose email"
            suppressContentEditableWarning
          />

          {err && <div style={{color:'#d93025', fontSize:13}}>{err}</div>}
        </form>
      </div>
    </div>
  );

  if (noPortal) return jsx;
  return ReactDOM.createPortal(jsx, document.body);
}