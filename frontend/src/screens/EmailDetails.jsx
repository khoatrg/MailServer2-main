import React from 'react';
import { sendMail, getSentMessages, getMessage, downloadAttachment, listMessages } from '../api';

function getFileIcon(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const icons = {
    pdf: 'PDF',
    doc: 'DOC',
    docx: 'DOC',
    xls: 'XLS',
    xlsx: 'XLS',
    ppt: 'PPT',
    pptx: 'PPT',
    jpg: '🖼',
    jpeg: '🖼',
    png: '🖼',
    gif: '🖼',
    zip: 'ZIP',
    rar: 'RAR',
    txt: 'TXT',
    csv: 'CSV',
    mp3: '🎵',
    mp4: '🎬',
    avi: '🎬',
    mov: '🎬'
  };
  return icons[ext] || '📄';
}

function getFileColor(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const colors = {
    pdf: '#ea4335',
    doc: '#4285f4',
    docx: '#4285f4',
    xls: '#34a853',
    xlsx: '#34a853',
    ppt: '#fbbc04',
    pptx: '#fbbc04',
    jpg: '#ff7043',
    jpeg: '#ff7043',
    png: '#ff7043',
    gif: '#ff7043',
    zip: '#9e9e9e',
    rar: '#9e9e9e',
    txt: '#607d8b',
    csv: '#34a853'
  };
  return colors[ext] || '#1a73e8';
}

function normalizeSubject(subj = '') {
  return (subj || '')
    .replace(/^\s*(re|fwd|fw)\s*:\s*/gi, '')
    .trim()
    .toLowerCase();
}

function getMainContent(text) {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const mainLines = [];
  
  for (const line of lines) {
    if (/^On\s+\d+\/\d+\/\d+.*wrote:?$/i.test(line.trim())) break;
    if (/^On .+,\s+.+@.+\s*wrote:?$/i.test(line.trim())) break;
    if (/^>/.test(line.trim())) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(line.trim())) break;
    mainLines.push(line);
  }
  
  return mainLines.join('\n').trim();
}

function getMainContentHtml(html) {
  if (!html) return '';
  
  let cleaned = html;
  cleaned = cleaned.replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, '');
  cleaned = cleaned.replace(/<div class="gmail_quote"[^>]*>[\s\S]*<\/div>/gi, '');
  cleaned = cleaned.replace(/<div class="gmail_extra"[^>]*>[\s\S]*<\/div>/gi, '');
  cleaned = cleaned.replace(/<div class="yahoo_quoted"[^>]*>[\s\S]*<\/div>/gi, '');
  cleaned = cleaned.replace(/<div id="divRplyFwdMsg"[^>]*>[\s\S]*<\/div>/gi, '');
  cleaned = cleaned.replace(/<div[^>]*>\s*On\s+[\d\/]+.*?wrote:[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<p[^>]*>\s*On\s+[\d\/]+.*?wrote:[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/On\s+\d+\/\d+\/\d+[^<]*wrote:[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<br\s*\/?>\s*&gt;[^<]*/gi, '');
  cleaned = cleaned.replace(/^&gt;[^<]*/gim, '');
  cleaned = cleaned.replace(/(<br\s*\/?>\s*){3,}/gi, '<br/><br/>');
  cleaned = cleaned.replace(/<p>\s*<\/p>/gi, '');
  cleaned = cleaned.replace(/<div>\s*<\/div>/gi, '');
  
  return cleaned.trim();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFormattedContent(text) {
  if (!text) return null;
  
  let html = text;
  const spanMatches = [];
  html = html.replace(/<span\s+style="([^"]+)">(.+?)<\/span>/gi, (match, style, content) => {
    const placeholder = `@@SPAN${spanMatches.length}@@`;
    spanMatches.push({ style, content });
    return placeholder;
  });
  
  html = escapeHtml(html);
  
  spanMatches.forEach((m, i) => {
    html = html.replace(`@@SPAN${i}@@`, `<span style="${m.style}">${escapeHtml(m.content)}</span>`);
  });
  
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '<em>$1</em>');
  html = html.replace(/&lt;u&gt;(.+?)&lt;\/u&gt;/g, '<u>$1</u>');
  
  const lines = html.split('\n');
  const processed = [];
  let inList = false;
  
  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      if (!inList) {
        processed.push('<ul style="margin: 8px 0; padding-left: 24px;">');
        inList = true;
      }
      processed.push('<li>' + line.replace(/^\s*-\s+/, '') + '</li>');
    } else {
      if (inList) {
        processed.push('</ul>');
        inList = false;
      }
      processed.push(line);
    }
  }
  if (inList) processed.push('</ul>');
  
  html = processed.join('<br/>').replace(/<br\/><ul/g, '<ul').replace(/<\/ul><br\/>/g, '</ul>');
  
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// Forward Modal Component
function ForwardModal({ message, onClose, onSuccess }) {
  const [forwardTo, setForwardTo] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState('');

  async function handleForward() {
    const to = forwardTo.trim();
    if (!to) {
      setError('Please enter an email address');
      return;
    }

    setSending(true);
    setError('');

    try {
      const fwdSubject = (message.subject || '').match(/^\s*Fwd?:/i)
        ? message.subject
        : `Fwd: ${message.subject || '(no subject)'}`;

      const originalDate = message.date ? new Date(message.date).toLocaleString() : '';
      const fromText = message.from || '';
      const toText = message.to || '';

      const fwdHeader = `---------- Forwarded message ----------\nFrom: ${fromText}\nDate: ${originalDate}\nSubject: ${message.subject || ''}\nTo: ${toText}\n\n`;
      
      const originalBody = message.text || (message.html ? message.html.replace(/<[^>]+>/g, '') : '');
      const fwdText = fwdHeader + originalBody;

      const fwdHtml = `
        <div style="padding: 12px 0;">
          <div style="border-left: 2px solid #ccc; padding-left: 12px; color: #5f6368;">
            <div style="margin-bottom: 12px; font-size: 12px;">
              <strong>---------- Forwarded message ----------</strong><br/>
              <strong>From:</strong> ${escapeHtml(fromText)}<br/>
              <strong>Date:</strong> ${escapeHtml(originalDate)}<br/>
              <strong>Subject:</strong> ${escapeHtml(message.subject || '')}<br/>
              <strong>To:</strong> ${escapeHtml(toText)}
            </div>
            <div>${message.html || escapeHtml(originalBody).replace(/\n/g, '<br/>')}</div>
          </div>
        </div>
      `;

      const payload = {
        to,
        subject: fwdSubject,
        text: fwdText,
        html: fwdHtml
      };

      // Note: Attachments forwarding would need backend support
      // For now, we forward without attachments

      const r = await sendMail(payload);
      if (r && r.success) {
        onSuccess && onSuccess();
        onClose();
      } else {
        setError(r && r.error ? r.error : 'Forward failed');
      }
    } catch (ex) {
      setError(ex && ex.message ? ex.message : 'Forward error');
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          padding: 24,
          width: 'min(400px, 90%)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)'
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 18, color: '#202124' }}>Forward Email</h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 20,
              color: '#5f6368',
              cursor: 'pointer',
              padding: 4
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{
            padding: 12,
            background: '#f8f9fa',
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 13,
            color: '#5f6368'
          }}>
            <div style={{ fontWeight: 600, color: '#202124', marginBottom: 4 }}>
              {message.subject || '(no subject)'}
            </div>
            <div>From: {(message.from || '').split('<')[0].trim()}</div>
            <div style={{ marginTop: 4, fontSize: 12 }}>
              {message.date ? new Date(message.date).toLocaleString() : ''}
            </div>
          </div>

          <label style={{ display: 'block', marginBottom: 8, fontSize: 14, color: '#5f6368', fontWeight: 500 }}>
            Forward to:
          </label>
          <input
            type="email"
            value={forwardTo}
            onChange={e => setForwardTo(e.target.value)}
            placeholder="recipient@example.com"
            autoFocus
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 8,
              border: '1px solid #dadce0',
              fontSize: 14,
              outline: 'none',
              boxSizing: 'border-box'
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !sending) {
                handleForward();
              }
            }}
          />
        </div>

        {error && (
          <div style={{ color: '#d93025', fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            disabled={sending}
            style={{
              background: 'transparent',
              border: '1px solid #dadce0',
              color: '#5f6368',
              padding: '10px 20px',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 500
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleForward}
            disabled={sending}
            style={{
              background: '#1a73e8',
              border: 'none',
              color: '#fff',
              padding: '10px 24px',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            {sending ? 'Forwarding...' : (
              <>
                <span>→</span>
                Forward
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function EmailDetails({ message, onBack, onReply, onReplyAll, onForward, onDelete, onNavigate }) {
  if (!message) return null;

  const fromText = message.from || '';
  const toText = message.to || '';
  const dateText = message.date ? new Date(message.date).toLocaleString() : '';

  const [showQuoted, setShowQuoted] = React.useState(false);
  const [threadMessages, setThreadMessages] = React.useState([]);
  const [loadingThread, setLoadingThread] = React.useState(false);

  // Forward modal state
  const [forwardModalOpen, setForwardModalOpen] = React.useState(false);
  const [forwardingMessage, setForwardingMessage] = React.useState(null);

  function avatarFor(name) {
    if (!name) return '';
    const n = (name.split('<')[0] || name).trim();
    const parts = n.split(/\s+/).filter(Boolean);
    const initials = parts.length === 1 ? parts[0][0] : (parts[0][0] + parts[1][0]);
    return initials.toUpperCase();
  }

  // Inline reply state
  const [replyOpen, setReplyOpen] = React.useState(false);
  const [replyIsAll, setReplyIsAll] = React.useState(false);
  const [replyTo, setReplyTo] = React.useState('');
  const [replySubject, setReplySubject] = React.useState('');
  const [replyQuoted, setReplyQuoted] = React.useState('');
  const [replyAttachments, setReplyAttachments] = React.useState([]);
  const [replySending, setReplySending] = React.useState(false);
  const [replyErr, setReplyErr] = React.useState('');
  const [replyFontSize, setReplyFontSize] = React.useState('normal');

  // WYSIWYG state
  const [activeBold, setActiveBold] = React.useState(false);
  const [activeItalic, setActiveItalic] = React.useState(false);
  const [activeUnderline, setActiveUnderline] = React.useState(false);

  const editorRef = React.useRef(null);
  const fileRef = React.useRef(null);

  function buildQuoted() {
    const dt = message.date ? new Date(message.date).toLocaleString() : '';
    const header = `On ${dt}, ${fromText} wrote:\n`;
    const original = (message.text && String(message.text)) || (message.html && String(message.html).replace(/<\/?[^>]+(>|$)/g, '')) || '';
    const quoted = original.split(/\r?\n/).map(l => `> ${l}`).join('\n');
    return header + quoted;
  }

  async function loadFullThread() {
    setLoadingThread(true);
    try {
      const baseSubject = normalizeSubject(message.subject || '');
      if (!baseSubject) {
        setThreadMessages([]);
        return;
      }

      const inboxRes = await listMessages();
      const inboxHeaders = (inboxRes && inboxRes.messages) || [];

      const sentRes = await getSentMessages();
      const sentHeaders = (sentRes && sentRes.messages) || [];

      const inboxCandidates = inboxHeaders.filter(h => normalizeSubject(h.subject || '') === baseSubject);
      const sentCandidates = sentHeaders.filter(h => normalizeSubject(h.subject || '') === baseSubject);

      const allCandidates = [
        ...inboxCandidates.map(h => ({ ...h, _type: 'received' })),
        ...sentCandidates.map(h => ({ ...h, _type: 'sent' }))
      ];

      const seen = new Set();
      const uniqueCandidates = allCandidates.filter(h => {
        const key = `${(h.mailbox || '').toLowerCase()}::${h.uid}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const fetched = await Promise.all(uniqueCandidates.map(async h => {
        try {
          const composite = h.mailbox ? `${h.mailbox}::${h.uid}` : h.uid;
          const mr = await getMessage(composite);
          const msg = (mr && mr.message) || null;
          if (msg) {
            return {
              ...msg,
              _type: h._type,
              uid: h.uid,
              mailbox: h.mailbox
            };
          }
          return null;
        } catch (e) {
          return null;
        }
      }));

      const validMessages = fetched.filter(Boolean).sort((a, b) =>
        new Date(a.date) - new Date(b.date)
      );

      setThreadMessages(validMessages);
    } catch (err) {
      console.warn('loadFullThread failed', err && (err.message || err));
      setThreadMessages([]);
    } finally {
      setLoadingThread(false);
    }
  }

  React.useEffect(() => {
    setThreadMessages([]);
    setShowQuoted(false);
    loadFullThread();
  }, [message && message.uid, message && message.mailbox]);

  function openInlineReply(all = false, targetMsg = null) {
    const msg = targetMsg || message;
    const msgFrom = msg.from || '';
    const msgTo = msg.to || '';

    setReplyIsAll(Boolean(all));
    if (all) {
      const originalTo = (msgTo || '').split(',').map(s => s.trim()).filter(Boolean);
      const toCandidates = Array.from(new Set([msgFrom, ...originalTo]));
      setReplyTo(toCandidates.join(', '));
    } else {
      setReplyTo(msgFrom);
    }
    const subj = msg.subject || '';
    setReplySubject(subj.match(/^\s*Re:/i) ? subj : `Re: ${subj}`);

    const dt = msg.date ? new Date(msg.date).toLocaleString() : '';
    const header = `On ${dt}, ${msgFrom} wrote:\n`;
    const original = (msg.text && String(msg.text)) || (msg.html && String(msg.html).replace(/<\/?[^>]+(>|$)/g, '')) || '';
    const quoted = original.split(/\r?\n/).map(l => `> ${l}`).join('\n');
    setReplyQuoted(header + quoted);

    setReplyAttachments([]);
    setReplyErr('');
    setReplyOpen(true);
    
    // Clear editor
    if (editorRef.current) {
      editorRef.current.innerHTML = '';
    }
  }

  // Open forward modal for a specific message
  function openForwardModal(msg) {
    setForwardingMessage(msg);
    setForwardModalOpen(true);
  }

  // WYSIWYG functions
  const updateActiveFormats = React.useCallback(() => {
    setActiveBold(document.queryCommandState('bold'));
    setActiveItalic(document.queryCommandState('italic'));
    setActiveUnderline(document.queryCommandState('underline'));
  }, []);

  function execCommand(command, value = null) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    updateActiveFormats();
  }

  function toggleBold() { execCommand('bold'); }
  function toggleItalic() { execCommand('italic'); }
  function toggleUnderline() { execCommand('underline'); }
  function toggleList() { execCommand('insertUnorderedList'); }

  function applyFontSize(size) {
    const sizeMap = { small: '2', normal: '3', large: '5', huge: '6' };
    execCommand('fontSize', sizeMap[size] || '3');
    setReplyFontSize(size);
  }

  const handleKeyDown = React.useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'b': e.preventDefault(); toggleBold(); break;
        case 'i': e.preventDefault(); toggleItalic(); break;
        case 'u': e.preventDefault(); toggleUnderline(); break;
      }
    }
  }, []);

  const getReplyContent = React.useCallback(() => {
    if (editorRef.current) {
      return {
        html: editorRef.current.innerHTML,
        text: editorRef.current.innerText || editorRef.current.textContent || ''
      };
    }
    return { html: '', text: '' };
  }, []);

  function handleFiles(files) {
    const arr = Array.from(files).map(f => ({ file: f, name: f.name, size: f.size }));
    setReplyAttachments(prev => [...prev, ...arr]);
  }

  function removeAttachment(ix) {
    setReplyAttachments(prev => prev.filter((_, i) => i !== ix));
  }

  async function handleSendInlineReply(e) {
    e && e.preventDefault && e.preventDefault();
    setReplyErr('');

    const to = (replyTo || '').trim();
    const subject = replySubject || '';
    const { html: replyHtml, text: replyText } = getReplyContent();

    const quotedHtml = replyQuoted ? `<br/><br/><div style="border-left:2px solid #ccc;padding-left:12px;color:#5f6368;margin-top:16px;">${escapeHtml(replyQuoted).replace(/\n/g, '<br/>')}</div>` : '';
    const fullHtml = replyHtml + quotedHtml;
    const fullText = [replyText, replyQuoted].filter(Boolean).join('\n\n');

    if (!to) {
      setReplyErr('Add at least one recipient');
      return;
    }

    setReplySending(true);
    try {
      const payload = { to, subject, text: fullText, html: fullHtml };
      if (replyAttachments && replyAttachments.length) {
        payload.attachments = replyAttachments;
      }

      const r = await sendMail(payload);
      if (r && r.success) {
        if (editorRef.current) editorRef.current.innerHTML = '';
        setReplyAttachments([]);
        setReplyOpen(false);
        setTimeout(() => { loadFullThread(); }, 800);
      } else {
        setReplyErr(r && r.error ? r.error : 'Send failed');
      }
    } catch (ex) {
      setReplyErr(ex && ex.message ? ex.message : 'Send error');
    } finally {
      setReplySending(false);
    }
  }

  function handleDiscardInline() {
    setReplyOpen(false);
    if (editorRef.current) editorRef.current.innerHTML = '';
    setReplyTo('');
    setReplySubject('');
    setReplyQuoted('');
    setReplyAttachments([]);
    setReplyErr('');
  }

  const inTrash = !!(message && message.mailbox && String(message.mailbox).toLowerCase().includes('trash'));

  const fullConversation = React.useMemo(() => {
    return [...threadMessages].sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [threadMessages]);

  const toolbarBtnStyle = {
    background: 'transparent',
    border: '1px solid #dadce0',
    color: '#5f6368',
    padding: '6px 10px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 32
  };

  const msgActionBtn = {
    background: 'transparent',
    border: '1px solid #e8eaed',
    color: '#5f6368',
    padding: '4px 8px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4
  };

  return (
    <div className="details-screen">
      {/* Forward Modal */}
      {forwardModalOpen && forwardingMessage && (
        <ForwardModal
          message={forwardingMessage}
          onClose={() => {
            setForwardModalOpen(false);
            setForwardingMessage(null);
          }}
          onSuccess={() => {
            // Optionally show success toast
          }}
        />
      )}

      <div className="details-header">
        <button className="back-btn" onClick={() => { if (onBack) return onBack(); if (onNavigate) return onNavigate('inbox'); }}>←</button>
        <div className="details-actions">
          <button
            title="Print"
            aria-label="Print"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'transparent',
              border: '1px solid rgba(0,0,0,0.08)',
              color: '#5f6368',
              padding: '6px 12px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 500
            }}
            onClick={async () => {
              try {
                const subj = message.subject || '(no subject)';
                const bodyHtml = message.html ? String(message.html) : `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(message.text || '(no content)')}</pre>`;
                const metaHtml = `<div style="margin-bottom:10px;color:#444">
                  <div><strong>From:</strong> ${escapeHtml(fromText)}</div>
                  <div><strong>To:</strong> ${escapeHtml(toText)}</div>
                  <div><strong>Date:</strong> ${escapeHtml(dateText)}</div>
                </div>`;

                const styles = `<style>
                  body{font-family: Arial, Helvetica, sans-serif; padding:20px; color:#000}
                  .subject{font-size:20px;font-weight:700;margin-bottom:8px}
                  hr{margin:18px 0}
                </style>`;

                const win = window.open('', '_blank');
                if (!win) throw new Error('Popup blocked');
                win.document.open();
                win.document.write(`<html><head><title>${escapeHtml(subj)}</title>${styles}</head><body>
                  <div class="subject">${escapeHtml(subj)}</div>
                  ${metaHtml}
                  <hr/>
                  <div class="message-content">${bodyHtml}</div>
                </body></html>`);
                win.document.close();
                win.focus();
                win.onload = () => { try { win.print(); } catch (e) { } };
              } catch (err) {
                alert('Print failed: ' + (err && err.message || ''));
              }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            Print
          </button>
        </div>
      </div>

      <div className="details-content">
        <h2 className="details-subject">{message.subject || '(no subject)'}</h2>

        {fullConversation.length > 1 && (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: '#e8f0fe',
            color: '#1a73e8',
            padding: '4px 12px',
            borderRadius: 16,
            fontSize: 13,
            fontWeight: 500,
            marginBottom: 16
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {fullConversation.length} messages in this conversation
          </div>
        )}

        <div className="conversation-thread">
          {fullConversation.map((msg, idx) => {
            const msgFrom = msg.from || '';
            const msgTo = msg.to || '';
            const msgDate = msg.date ? new Date(msg.date).toLocaleString() : '';
            const isSent = msg._type === 'sent';
            const msgContent = getMainContent(msg.text) || msg.text || '';
            const msgAttachments = msg.attachments || [];

            return (
              <div
                key={`${msg.mailbox || ''}::${msg.uid}::${idx}`}
                style={{
                  padding: 16,
                  marginBottom: 12,
                  borderRadius: 8,
                  background: isSent ? '#e8f5e9' : '#f8f9fa',
                  border: '1px solid #e8eaed',
                  borderLeft: isSent ? '4px solid #34a853' : '4px solid #1a73e8'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
                  <div style={{
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    background: isSent ? 'linear-gradient(135deg, #34a853, #1e8e3e)' : 'linear-gradient(135deg, #4285f4, #1a73e8)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: 13,
                    flexShrink: 0
                  }}>
                    {avatarFor(msgFrom)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontWeight: 600, color: '#202124', fontSize: 14 }}>
                          {msgFrom.split('<')[0].trim() || msgFrom}
                          {isSent && (
                            <span style={{
                              marginLeft: 8,
                              fontSize: 11,
                              background: '#34a853',
                              color: '#fff',
                              padding: '2px 6px',
                              borderRadius: 4
                            }}>Sent</span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: '#5f6368', marginTop: 2 }}>
                          To: {msgTo}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: '#5f6368', whiteSpace: 'nowrap' }}>
                        {msgDate}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Message content */}
                <div style={{
                  paddingLeft: 48,
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: '#202124'
                }}>
                  {msg.html ? (
                    <div dangerouslySetInnerHTML={{ __html: getMainContentHtml(msg.html) }} />
                  ) : (
                    renderFormattedContent(msgContent) || <span>(no content)</span>
                  )}
                </div>

                {/* Attachments inside this message */}
                {msgAttachments.length > 0 && (
                  <div style={{ paddingLeft: 48, marginTop: 12 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {msgAttachments.map((a, i) => (
                        <div
                          key={i}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '8px 12px',
                            background: '#fff',
                            borderRadius: 8,
                            border: '1px solid #e8eaed',
                            cursor: 'pointer',
                            transition: 'background 0.15s, box-shadow 0.15s'
                          }}
                          onClick={async () => {
                            try {
                              const composite = msg.mailbox ? `${msg.mailbox}::${msg.uid}` : msg.uid;
                              const { blob, filename } = await downloadAttachment(composite, i);
                              const url = URL.createObjectURL(blob);
                              const aEl = document.createElement('a');
                              aEl.href = url;
                              aEl.download = filename || (a.filename || a.name || 'attachment');
                              document.body.appendChild(aEl);
                              aEl.click();
                              aEl.remove();
                              URL.revokeObjectURL(url);
                            } catch (err) {
                              alert('Download failed: ' + (err && err.message || ''));
                            }
                          }}
                          onMouseOver={e => {
                            e.currentTarget.style.background = '#f8f9fa';
                            e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
                          }}
                          onMouseOut={e => {
                            e.currentTarget.style.background = '#fff';
                            e.currentTarget.style.boxShadow = 'none';
                          }}
                        >
                          <div style={{
                            width: 32,
                            height: 32,
                            borderRadius: 6,
                            background: getFileColor(a.filename || a.name || ''),
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#fff',
                            fontSize: 11,
                            fontWeight: 700
                          }}>
                            {getFileIcon(a.filename || a.name || '')}
                          </div>
                          <div>
                            <div style={{
                              fontWeight: 500,
                              color: '#202124',
                              fontSize: 13,
                              maxWidth: 150,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}>
                              {a.filename || a.name || 'attachment'}
                            </div>
                            <div style={{ color: '#5f6368', fontSize: 11 }}>
                              {a.size ? fmtSize(a.size) : (a.contentType || '')}
                            </div>
                          </div>
                          <div style={{ color: '#d4dadaff', fontSize: 25, marginLeft: 4 }}>⬇</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Action buttons for each message */}
                {!inTrash && (
                  <div style={{ paddingLeft: 48, marginTop: 12, display: 'flex', gap: 8 }}>
                    <button
                      style={msgActionBtn}
                      onClick={() => openInlineReply(false, msg)}
                      title="Reply to this message"
                    >
                      ↩ Reply
                    </button>
                    <button
                      style={msgActionBtn}
                      onClick={() => openInlineReply(true, msg)}
                      title="Reply all to this message"
                    >
                      ⤺ Reply All
                    </button>
                    <button
                      style={msgActionBtn}
                      onClick={() => openForwardModal(msg)}
                      title="Forward this message"
                    >
                      → Forward
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Enhanced Inline Reply Editor */}
        {replyOpen && (
          <div className="inline-reply" style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 12,
            background: '#fff',
            border: '1px solid #dadce0',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: '#202124', fontSize: 14 }}>
                {replyIsAll ? 'Reply All' : 'Reply'}
              </div>
              <button
                onClick={handleDiscardInline}
                style={{ background: 'transparent', border: 'none', color: '#5f6368', cursor: 'pointer', padding: 4 }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: '#5f6368', marginBottom: 4, display: 'block' }}>To</label>
                <input
                  style={{
                    width: '100%',
                    padding: 10,
                    borderRadius: 6,
                    border: '1px solid #dadce0',
                    background: '#fff',
                    color: '#202124',
                    fontSize: 14
                  }}
                  value={replyTo}
                  onChange={e => setReplyTo(e.target.value)}
                  placeholder="Recipients"
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: '#5f6368', marginBottom: 4, display: 'block' }}>Subject</label>
                <input
                  style={{
                    width: '100%',
                    padding: 10,
                    borderRadius: 6,
                    border: '1px solid #dadce0',
                    background: '#fff',
                    color: '#202124',
                    fontSize: 14
                  }}
                  value={replySubject}
                  onChange={e => setReplySubject(e.target.value)}
                  placeholder="Subject"
                />
              </div>
            </div>

            {/* Formatting Toolbar */}
            <div style={{
              display: 'flex',
              gap: 4,
              padding: '8px 0',
              borderBottom: '1px solid #e8eaed',
              marginBottom: 12,
              flexWrap: 'wrap',
              alignItems: 'center'
            }}>
              <button
                type="button"
                style={{ ...toolbarBtnStyle, ...(activeBold ? { background: '#e8f0fe', borderColor: '#1a73e8', color: '#1a73e8' } : {}) }}
                title="Bold (Ctrl+B)"
                onClick={toggleBold}
              >
                <strong>B</strong>
              </button>
              <button
                type="button"
                style={{ ...toolbarBtnStyle, ...(activeItalic ? { background: '#e8f0fe', borderColor: '#1a73e8', color: '#1a73e8' } : {}) }}
                title="Italic (Ctrl+I)"
                onClick={toggleItalic}
              >
                <em>I</em>
              </button>
              <button
                type="button"
                style={{ ...toolbarBtnStyle, ...(activeUnderline ? { background: '#e8f0fe', borderColor: '#1a73e8', color: '#1a73e8' } : {}) }}
                title="Underline (Ctrl+U)"
                onClick={toggleUnderline}
              >
                <u>U</u>
              </button>
              <button type="button" style={toolbarBtnStyle} title="Bulleted List" onClick={toggleList}>
                ☰
              </button>

              <select
                value={replyFontSize}
                onChange={e => applyFontSize(e.target.value)}
                style={{
                  background: '#fff',
                  border: '1px solid #dadce0',
                  borderRadius: 4,
                  padding: '5px 8px',
                  fontSize: 13,
                  color: '#5f6368',
                  cursor: 'pointer',
                  outline: 'none',
                  marginLeft: 4
                }}
                title="Font Size"
              >
                <option value="small">Small</option>
                <option value="normal">Normal</option>
                <option value="large">Large</option>
                <option value="huge">Huge</option>
              </select>

              <div style={{ flex: 1 }} />
              <input
                ref={fileRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={e => handleFiles(e.target.files)}
              />
              <button
                type="button"
                style={{ ...toolbarBtnStyle, gap: 6 }}
                title="Attach files"
                onClick={() => fileRef.current && fileRef.current.click()}
              >
                📎 Attach
              </button>
            </div>

            {/* Attachments List */}
            {replyAttachments.length > 0 && (
              <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {replyAttachments.map((a, ix) => (
                  <div key={ix} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: 10,
                    background: '#f1f3f4',
                    borderRadius: 8,
                    border: '1px solid #e8eaed'
                  }}>
                    <div style={{
                      width: 32,
                      height: 32,
                      borderRadius: 6,
                      background: '#1a73e8',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontSize: 14
                    }}>
                      📄
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: '#202124', fontSize: 13 }}>{a.name}</div>
                      <div style={{ color: '#5f6368', fontSize: 12 }}>{fmtSize(a.size)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttachment(ix)}
                      style={{ background: 'transparent', border: 'none', color: '#5f6368', cursor: 'pointer', padding: 4 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* WYSIWYG Editor */}
            <div
              ref={editorRef}
              contentEditable
              style={{
                width: '100%',
                padding: 12,
                borderRadius: 8,
                border: '1px solid #dadce0',
                background: '#fff',
                color: '#202124',
                fontSize: 14,
                lineHeight: 1.6,
                minHeight: 150,
                maxHeight: 300,
                overflowY: 'auto',
                outline: 'none',
                cursor: 'text'
              }}
              onInput={updateActiveFormats}
              onKeyDown={handleKeyDown}
              onMouseUp={updateActiveFormats}
              data-placeholder="Write your reply..."
              suppressContentEditableWarning
            />

            {/* Quoted text */}
            {replyQuoted && (
              <details style={{ marginTop: 12 }}>
                <summary style={{
                  cursor: 'pointer',
                  color: '#1a73e8',
                  fontSize: 13,
                  padding: '8px 0',
                  fontWeight: 500
                }}>
                  ▸ Show quoted text
                </summary>
                <div style={{
                  marginTop: 8,
                  padding: 12,
                  borderRadius: 6,
                  background: '#f8f9fa',
                  border: '1px solid #e8eaed',
                  borderLeft: '3px solid #dadce0',
                  color: '#5f6368',
                  whiteSpace: 'pre-wrap',
                  fontSize: 13,
                  maxHeight: 200,
                  overflow: 'auto'
                }}>
                  {replyQuoted}
                </div>
              </details>
            )}

            {replyErr && (
              <div style={{ color: '#d93025', fontSize: 13, marginTop: 8 }}>{replyErr}</div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button
                style={{
                  background: 'transparent',
                  color: '#5f6368',
                  border: '1px solid #dadce0',
                  padding: '10px 20px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontWeight: 500
                }}
                onClick={handleDiscardInline}
              >
                Discard
              </button>
              <button
                style={{
                  background: '#1a73e8',
                  color: '#fff',
                  border: 'none',
                  padding: '10px 24px',
                  borderRadius: 6,
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8
                }}
                onClick={handleSendInlineReply}
                disabled={replySending}
              >
                {replySending ? 'Sending...' : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                    Send
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}