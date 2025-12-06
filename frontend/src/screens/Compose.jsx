import React, { useState, useRef } from 'react';
import ReactDOM from 'react-dom'; // <-- added for portal
import { sendMail, saveDraft as saveDraftAPI, scheduleMail } from '../api';

export default function Compose({ onSent, onCancel, noPortal = false, initialData = null }) {
  const [recipients, setRecipients] = useState([]); // array of emails/names
  const [toInput, setToInput] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState([]); // {file, name, size}
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const [sendLater, setSendLater] = React.useState(false);
  const [scheduledAt, setScheduledAt] = React.useState(''); // ISO-like from input
  const [scheduling, setScheduling] = React.useState(false);
  const fileRef = useRef();
  const editorRef = useRef(null); // <-- added editor ref

  // DRAFT: autosave/restore (local functions renamed to avoid collision with API export)
  const DRAFT_KEY = 'mail:compose:draft';
  const draftTimer = useRef(null);
  const [draftSavedAt, setDraftSavedAt] = useState(null);

  // load draft on mount (prefer initialData when provided)
  React.useEffect(() => {
    try {
      if (initialData && Object.keys(initialData).length) {
        // initialize from provided draft (we treat this as a "move" into composer)
        if (initialData.recipients) setRecipients(initialData.recipients);
        if (initialData.toInput) setToInput(initialData.toInput);
        if (initialData.subject) setSubject(initialData.subject);
        if (initialData.body) setBody(initialData.body);
        if (initialData.savedAt) setDraftSavedAt(initialData.savedAt);
        // remove any local saved draft to avoid merging old saved content
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
        return;
      }
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d.recipients) setRecipients(d.recipients);
        if (d.toInput) setToInput(d.toInput);
        if (d.subject) setSubject(d.subject);
        if (d.body) setBody(d.body);
        if (d.savedAt) setDraftSavedAt(d.savedAt);
      }
    } catch (e) { /* ignore */ }
  }, []);

  function saveLocalDraft() {
    try {
      const payload = { recipients, toInput, subject, body, savedAt: Date.now() };
      // only save if there's meaningful content
      if ((recipients && recipients.length) || (toInput || '').trim() || (subject || '').trim() || (body || '').trim()) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
        setDraftSavedAt(payload.savedAt);
      } else {
        // remove empty draft
        localStorage.removeItem(DRAFT_KEY);
        setDraftSavedAt(null);
      }
    } catch (e) {}
  }

  function clearLocalDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    setDraftSavedAt(null);
  }

  // close handler: save to server Drafts if there's content, then call onCancel
  async function handleClose() {
    // determine meaningful content
    const trimmedInput = (toInput || '').trim();
    const combined = [...recipients];
    if (trimmedInput) combined.push(trimmedInput);
    const finalRecipients = Array.from(new Set(combined.map(r => (r || '').trim()).filter(Boolean)));

    const hasContent = finalRecipients.length > 0 ||
      (subject || '').trim() ||
      (body || '').trim();

    if (hasContent) {
      try {
        // try to save to server drafts (best-effort)
        await saveDraftAPI({
          to: finalRecipients.join(', '),
          subject,
          text: body,
          html: textToHtml(body),
          from: undefined
        });
        // remove local autosaved draft once server copy exists
        clearLocalDraft();
      } catch (e) {
        // ignore errors (best-effort). local autosave still preserves content.
        console.warn('saveDraft failed', e && (e.message || e));
      }
    } else {
      // no meaningful content -> clear any empty local draft
      clearLocalDraft();
    }

    // finally close composer (cleanup provided by caller)
    onCancel && onCancel();
  }

  // debounce autosave when fields change
  React.useEffect(() => {
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveLocalDraft();
    }, 1000);
    return () => clearTimeout(draftTimer.current);
  }, [recipients, toInput, subject, body]);

  // cleanup timer on unmount
  React.useEffect(() => {
    return () => { clearTimeout(draftTimer.current); };
  }, []);

  // helper to format relative time
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
      // remove last
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

  // small helper to escape HTML
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // convert simple markup to HTML and preserve <u> tags inserted by toolbar
  function textToHtml(input) {
    if (!input) return '';

    // temporarily protect <u> tags we intentionally insert
    const U_OPEN = '@@U_OPEN@@';
    const U_CLOSE = '@@U_CLOSE@@';
    let tmp = input.replace(/<\s*u\s*>/gi, U_OPEN).replace(/<\s*\/\s*u\s*>/gi, U_CLOSE);

    // escape all HTML
    tmp = escapeHtml(tmp);

    // restore protected <u> placeholders back to tags
    tmp = tmp.replace(new RegExp(U_OPEN, 'g'), '<u>').replace(new RegExp(U_CLOSE, 'g'), '</u>');

    // convert bold **text** -> <strong>
    tmp = tmp.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
    // convert italic _text_ -> <em>
    tmp = tmp.replace(/_(.+?)_/gs, '<em>$1</em>');

    // simple list handling: lines starting with "- "
    const lines = tmp.split(/\r?\n/);
    const out = [];
    let inList = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*-\s+/.test(line)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + line.replace(/^\s*-\s+/, '') + '</li>');
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        if (line.trim() === '') {
          out.push(''); // paragraph break marker
        } else {
          out.push('<p>' + line + '</p>');
        }
      }
    }
    if (inList) out.push('</ul>');

    // join and clean up consecutive paragraph markers
    // Filter out empty markers and join
    const cleaned = out.join('\n').replace(/(<p><\/p>)+/g, '');
    return cleaned;
  }

  async function submit(e) {
    e && e.preventDefault && e.preventDefault();
    setErr('');

    // include any value still typed in the "to" input
    const trimmedInput = (toInput || '').trim();
    const combined = [...recipients];
    if (trimmedInput) combined.push(trimmedInput);

    // dedupe and remove empty entries
    const finalRecipients = Array.from(new Set(combined.map(r => (r || '').trim()).filter(Boolean)));

    if (finalRecipients.length === 0) {
      setErr('Add at least one recipient');
      return;
    }

    // If user chose "Send later" and provided a datetime, call schedule endpoint
    if (sendLater && scheduledAt) {
      // scheduling attachments is not supported (files cannot be serialized into scheduled job)
      if (attachments && attachments.length) {
        setErr('Scheduling with attachments is not supported');
        return;
      }

      setScheduling(true);
      try {
        const to = finalRecipients.join(', ');
        const html = textToHtml(body);
        const r = await scheduleMail({ to, subject, text: body, html, sendAt: new Date(scheduledAt).toISOString() });
        if (r && r.success) {
          // clear local state/draft and notify parent
          setRecipients([]);
          setToInput('');
          setSubject('');
          setBody('');
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

    // immediate send (include attachments)
    setSending(true);
    try {
      const to = finalRecipients.join(', ');
      const html = textToHtml(body);
      // include attachments array (each item has .file) so api.sendMail can detect and build FormData
      const payload = { to, subject, text: body, html };
      if (attachments && attachments.length) payload.attachments = attachments; // attachments items: { file, name, size }
      const r = await sendMail(payload);
      if (r.success) {
        setRecipients([]);
        setToInput('');
        setSubject('');
        setBody('');
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

  // size formatter
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/(1024*1024)).toFixed(1) + ' MB';
  }

  // inline styles adjusted:
  const s = {
    // overlay/backdrop covering viewport
    overlay: {
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)',
      zIndex: 1000,
      padding: 20,
      boxSizing: 'border-box'
    },
    // modal panel styling
    modal: {
      width: 'min(900px, 98%)',
      maxWidth: '900px',
      maxHeight: '90vh',
      overflow: 'hidden',
      borderRadius: 12,
      background: '#071015', // solid modal background to avoid transparency
      boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
      display: 'flex',
      flexDirection: 'column'
    },
    // use 100% so Compose flexes inside parent App (parent handles viewport height)
    screen: { display:'flex', flexDirection:'column', height:'100%', background:'#081217', color:'#e6eef1' },
    header: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid rgba(255,255,255,0.03)' },
    title: { fontWeight:700, fontSize:18, textAlign:'center', flex:1 },
    smallBtn: { background:'transparent', border:'none', color:'#e6eef1', fontSize:20, cursor:'pointer' },
    sendBtn: { background:'#0b88ff', color:'#fff', border:'none', padding:'8px 14px', borderRadius:20, cursor:'pointer', fontWeight:700 },
    // changed form sizing for modal
    form: { padding:'12px', display:'flex', flexDirection:'column', gap:12, overflow:'auto', flex:1, maxHeight:'56vh' },
    toRow: { display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' },
    label: { width:40, color:'#9aa6b2', fontWeight:600 },
    chips: { display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' },
    chip: { background:'#0f2a35', color:'#dff3ff', padding:'6px 10px', borderRadius:16, display:'inline-flex', alignItems:'center', gap:8 },
    chipX: { background:'transparent', border:'none', color:'#9aa6b2', cursor:'pointer', fontSize:14 },
    inputInline: { background:'transparent', border:'none', color:'#cfeffb', outline:'none', minWidth:120, padding:'6px 4px', fontSize:15 },
    subject: { width:'100%', padding:'12px', borderRadius:10, background:'#0b1317', border:'1px solid rgba(255,255,255,0.02)', color:'#dff3ff' },
    attachCard: { background:'#0f1a22', borderRadius:10, padding:12, display:'flex', alignItems:'center', gap:12, border:'1px solid rgba(255,255,255,0.03)' },
    attachName: { fontWeight:700, color:'#fff' },
    // textarea: slightly smaller for modal so it fits above toolbar
    textarea: {
      flex:1,
      minHeight:160,
      maxHeight:'34vh',
      resize:'vertical',
      padding:12,
      borderRadius:10,
      background:'#071015',
      color:'#dff3ff',
      border:'1px solid rgba(255,255,255,0.02)',
      outline:'none',
      whiteSpace:'pre-wrap',
      wordBreak:'break-word',
      overflowWrap:'anywhere',
      width:'100%',
      boxSizing:'border-box'
    },
    // toolbar moved to top inside the form (sticky so it stays visible while scrolling the form)
    topToolbar: {
      position:'sticky',
      top:0,
      zIndex:30,
      display:'flex',
      alignItems:'center',
      gap:12,
      padding:'8px 0',
      background:'linear-gradient(180deg, rgba(8,18,23,0.9), rgba(8,18,23,0.5))'
    },
    iconBtn: { background:'transparent', border:'none', color:'#dff3ff', fontSize:18, cursor:'pointer' }
  };

  // helper: apply a transformation to the current selection in the textarea
  function applyToSelection(transform) {
    const el = editorRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = body.slice(0, start);
    const selected = body.slice(start, end);
    const after = body.slice(end);
    const newText = transform(selected);
    const updated = before + newText + after;
    setBody(updated);
    // restore selection around the transformed text
    const newStart = start;
    const newEnd = start + newText.length;
    // update cursor after DOM update
    requestAnimationFrame(() => {
      try { el.selectionStart = newStart; el.selectionEnd = newEnd; el.focus(); } catch (e) {}
    });
  }

  function wrapSelection(prefix, suffix = prefix) {
    applyToSelection(sel => prefix + (sel || 'text') + suffix);
  }

  function toggleBold() { wrapSelection('**', '**'); }
  function toggleItalic() { wrapSelection('_', '_'); }
  function toggleUnderline() { applyToSelection(sel => `<u>${sel || 'text'}</u>`); }
  function toggleList() {
    applyToSelection(sel => {
      const lines = (sel || '').split(/\r?\n/);
      if (lines.length === 0) return '- ';
      return lines.map(l => (l.trim() ? '- ' + l : l)).join('\n');
    });
  }

  // prevent background scroll while compose is open
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // return via portal so compose overlays current page regardless of routing/layout
  const jsx = (
    <div
      className="compose-overlay"
      style={s.overlay}
      onMouseDown={e => {
        // click on backdrop (not inside modal) closes compose
        if (e.target === e.currentTarget) handleClose();
      }}
      aria-hidden={false}
    >
      {/* existing modal markup — unchanged content moved inside portal */}
      <div className="compose-modal" role="dialog" aria-label="Compose email" style={s.modal}>
        <div className="compose-header" style={s.header}>
          <button style={s.smallBtn} onClick={handleClose} aria-label="Close">✕</button>

          <div style={{display:'flex', flexDirection:'column', alignItems:'center', flex:1}}>
            <div className="compose-title" style={s.title}>Compose</div>
            {/* draft indicator */}
            {draftSavedAt ? (
              <div style={{fontSize:12, color:'#9aa6b2', marginTop:2}}>
                Draft saved · {formatTimeAgo(draftSavedAt)}
              </div>
            ) : (
              <div style={{height:16}} /> /* keep header height steady */
            )}
          </div>

          <div className="compose-actions" style={{display:'flex', gap:8, alignItems:'center'}}>
            {/* Discard button removes saved draft and closes composer */}
            <button
              type="button"
              onClick={() => { clearLocalDraft(); onCancel && onCancel(); }}
              style={{...s.smallBtn, fontSize:13, padding:'6px 10px', borderRadius:10, border:'1px solid rgba(255,255,255,0.04)'}}
            >
              Discard
            </button>

            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <label style={{display:'flex', alignItems:'center', gap:8, color:'#9aa6b2', fontSize:13}}>
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
                style={{padding:8, borderRadius:6, border:'1px solid rgba(255,255,255,0.03)', background:'#081217', color:'#dff3ff'}}
              />
              <div style={{color:'#9aa6b2', fontSize:12}}>Time is local; timezone will be preserved on schedule.</div>
            </div>
          )}

          <div style={s.toRow}>
            <div style={s.label}>To:</div>
            <div style={s.chips}>
              {recipients.map((r,ix) => (
                <div key={ix} style={s.chip}>
                  <span style={{fontSize:13}}>{r}</span>
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
            <div style={{width:1, height:20, background:'rgba(255,255,255,0.03)'}} />
            <button type="button" style={s.iconBtn} title="Bold" onClick={toggleBold}><strong>B</strong></button>
            <button type="button" style={s.iconBtn} title="Italic" onClick={toggleItalic}><em>I</em></button>
            <button type="button" style={s.iconBtn} title="Underline" onClick={toggleUnderline}><u>U</u></button>
            <button type="button" style={s.iconBtn} title="List" onClick={toggleList}>☰</button>
            <div style={{flex:1}} />
            <button type="button" style={s.iconBtn} title="More">⋮</button>
          </div>

          {/* attachments area */}
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            {attachments.map((a,ix) => (
              <div key={ix} style={s.attachCard}>
                <div style={{width:40, height:40, borderRadius:8, background:'#062a33', display:'flex', alignItems:'center', justifyContent:'center', color:'#0ea5ff', fontWeight:800}}>📄</div>
                <div style={{flex:1}}>
                  <div style={s.attachName}>{a.name}</div>
                  <div style={{color:'#9aa6b2', fontSize:13}}>{fmtSize(a.size)}</div>
                </div>
                <button type="button" onClick={()=>removeAttachment(ix)} style={{...s.iconBtn, color:'#9aa6b2'}}>✕</button>
              </div>
            ))}

            <div style={{display:'flex', gap:8, alignItems:'center'}}>
              <input ref={fileRef} type="file" multiple style={{display:'none'}} onChange={e=>handleFiles(e.target.files)} />
              <button type="button" onClick={()=>fileRef.current && fileRef.current.click()} style={{...s.iconBtn, border:'1px dashed rgba(255,255,255,0.03)', padding:'8px 12px', borderRadius:10}}>Attach</button>
            </div>
          </div>

          <textarea
            ref={editorRef}
            style={s.textarea}
            placeholder="Compose email"
            value={body}
            onChange={e=>setBody(e.target.value)}
          />

          {err && <div style={{color:'#ff8b8b'}}>{err}</div>}
        </form>
      </div>
    </div>
  );

  // if host already mounted by FloatingCompose (noPortal), render directly
  if (noPortal) return jsx;
  return ReactDOM.createPortal(jsx, document.body);
}
