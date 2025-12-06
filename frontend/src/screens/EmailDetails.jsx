import React from 'react';
import { sendMail, getSentMessages, getMessage, downloadAttachment } from '../api'; // updated import (removed raw download)


export default function EmailDetails({ message, onBack, onReply, onReplyAll, onForward, onDelete, onNavigate }) {
	if (!message) return null;

	const fromText = message.from || '';
	const toText = message.to || '';
	const dateText = message.date ? new Date(message.date).toLocaleString() : '';

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
	// editable area (start empty); quoted original shown separately
	const [replyBody, setReplyBody] = React.useState('');
	const [replyQuoted, setReplyQuoted] = React.useState('');
	// replies will hold both remote-sourced (from Sent) and local (just-sent) replies.
	const [replies, setReplies] = React.useState([]); // local thread of sent replies

	// helper: normalize subject by stripping common prefixes
	function normalizeSubject(subj = '') {
		return (subj || '').replace(/^\s*(re|fwd|fw):\s*/i, '').trim().toLowerCase();
	}

	// prepare quoted original text (simple plaintext fallback)
	function buildQuoted() {
		const dt = message.date ? new Date(message.date).toLocaleString() : '';
		const header = `On ${dt}, ${fromText} wrote:\n`;
		const original = (message.text && String(message.text)) || (message.html && String(message.html).replace(/<\/?[^>]+(>|$)/g, '')) || '';
		const quoted = original.split(/\r?\n/).map(l => `> ${l}`).join('\n');
		return header + quoted;
	}

	// load sent-thread: fetch Sent headers, filter by normalized subject, then fetch full bodies
	async function loadThread() {
		try {
			const base = normalizeSubject(message.subject || '');
			const sentRes = await getSentMessages();
			const sentHeaders = (sentRes && sentRes.messages) || [];

			// find candidate sent messages whose normalized subject matches base
			const candidates = sentHeaders.filter(h => normalizeSubject(h.subject || '') === base)
				// exclude the message currently being viewed to avoid showing it twice
				.filter(h => {
					// compare uid + mailbox when available
					const sameUid = String(h.uid) === String(message.uid);
					const sameMailbox = (h.mailbox || '').toLowerCase() === (message.mailbox || '').toLowerCase();
					return !(sameUid && sameMailbox);
				});

			// fetch full messages for candidates (parallel)
			const fetched = await Promise.all(candidates.map(async h => {
				try {
					// composite id for getMessage to open correct mailbox
					const composite = h.mailbox ? `${h.mailbox}::${h.uid}` : h.uid;
					const mr = await getMessage(composite);
					return (mr && mr.message) || null;
				} catch (e) {
					return null;
				}
			}));

			// map to reply-like shape and filter nulls
			const remoteReplies = fetched.filter(Boolean).map(m => ({
				_to: m.to || '',
				to: m.to || '',
				subject: m.subject || '',
				text: m.text || m.html || '',
				date: m.date || '',
				_remote: true
			}));

			// preserve any local (just-sent) replies already in state (marked _local)
			const localReplies = replies.filter(r => r._local);

			// Merge remote first, then local so local appear on top
			setReplies([...remoteReplies, ...localReplies]);
		} catch (err) {
			console.warn('loadThread failed', err && (err.message || err));
		}
	}

	// ensure thread loads when message changes
	React.useEffect(() => {
		setReplies([]); // clear previous thread while loading
		loadThread();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [message && message.uid, message && message.mailbox]);

	function openInlineReply(all = false) {
		setReplyIsAll(Boolean(all));
		// Reply -> to = from; Reply All -> include to/from and others from original To (simple merge)
		if (all) {
			const originalTo = (toText || '').split(',').map(s => s.trim()).filter(Boolean);
			const toCandidates = Array.from(new Set([fromText, ...originalTo]));
			setReplyTo(toCandidates.join(', '));
		} else {
			setReplyTo(fromText);
		}
		// subject prefix
		const subj = message.subject || '';
		setReplySubject(subj.match(/^\s*Re:/i) ? subj : `Re: ${subj}`);
		// prepare quoted original separately and keep the editable textarea empty
		setReplyQuoted(buildQuoted());
		setReplyBody('');
		setReplyOpen(true);
	}

	async function handleSendInlineReply(e) {
		e && e.preventDefault && e.preventDefault();
		const to = (replyTo || '').trim();
		const subject = replySubject || '';
		// combine editable body with the quoted original for sending
		const combined = [ (replyBody || '').trim(), replyQuoted || '' ].filter(Boolean).join('\n\n');
		const text = combined;
		if (!to) {
			alert('Add at least one recipient');
			return;
		}
		try {
			const r = await sendMail({ to, subject, text, html: `<div>${text.replace(/\n/g, '<br/>')}</div>` });
			if (r && r.success) {
				// add local reply so it appears immediately (mark as local)
				const local = { to, subject, text, date: new Date().toISOString(), _local: true };
				setReplies(prev => [local, ...prev.filter(x => !x._local)]); // put local on top, keep remote below
				// clear editable area but keep quoted
				setReplyBody('');
				// refresh remote thread (will bring sent copy from Sent folder when available)
				setTimeout(() => { loadThread(); }, 800);
			} else {
				alert(r && r.error ? r.error : 'Send failed');
			}
		} catch (ex) {
			alert(ex && ex.message ? ex.message : 'Send error');
		}
	}

	function handleDiscardInline() {
		setReplyOpen(false);
		setReplyBody('');
		setReplyTo('');
		setReplySubject('');
		setReplyQuoted('');
	}

	// determine if this message is coming from a Trash-like mailbox
	const inTrash = !!(message && message.mailbox && String(message.mailbox).toLowerCase().includes('trash'));

	return (
		<div className="details-screen">
			<div className="details-header">
				<button className="back-btn" onClick={() => { if (onBack) return onBack(); if (onNavigate) return onNavigate('inbox'); }}>←</button>
				<div className="details-actions">
					<button title="Print" aria-label="Print" onClick={async ()=>{
						// helper to escape plain text when embedding into HTML
						function escapeHtml(s='') {
							return String(s)
								.replace(/&/g, '&amp;')
								.replace(/</g, '&lt;')
								.replace(/>/g, '&gt;')
								.replace(/"/g, '&quot;')
								.replace(/'/g, '&#39;');
						}

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
							// wait for resources to load then print
							win.onload = () => { try { win.print(); } catch(e){} };
						} catch (err) {
							alert('Print failed: ' + (err && err.message || ''));
						}
					}}>🖨 Print</button>
					<button title="More" onClick={()=>{}} aria-label="More">⋮</button>
				</div>
			</div>

			<div className="details-content">
				<h2 className="details-subject">{message.subject || '(no subject)'}</h2>

				<div className="details-meta">
					<div className="details-avatar">{avatarFor(fromText)}</div>
					<div className="details-sender">
						<div className="sender-name">{fromText}</div>
						<div className="sender-to">To: {toText}</div>
					</div>
					<div className="details-time">{dateText}</div>
				</div>

				{/* inline toolbar placed on top of the email content */}
				{!inTrash && (
					<div className="details-inline-toolbar" role="toolbar" aria-label="Message actions">
						<button onClick={() => openInlineReply(false)} title="Reply">↩ Reply</button>
						<button onClick={() => openInlineReply(true)} title="Reply All">⤺ Reply All</button>
						<button onClick={onForward} title="Forward">⇢ Forward</button>
					</div>
				)}

				<div className="details-body">
					{/* if html available, render dangerously; fallback to text */}
					{message.html ? (
						<div className="html-body" dangerouslySetInnerHTML={{__html: message.html}} />
					) : (
						<pre className="text-body">{message.text || '(no content)'}</pre>
					)}
				</div>

				{/* Combined thread: remote sent replies + local just-sent replies */}
				{replies.length > 0 && (
					<div className="sent-thread">
						{replies.map((r, i) => (
							<div key={i} className="sent-reply">
								<div style={{fontSize:13, color:'#9aa6b2'}}>
									{r.date ? new Date(r.date).toLocaleString() : ''} · To: {r.to || r._to || ''}
									{r._local ? ' (sent)' : ''}
								</div>
								<div style={{marginTop:6, whiteSpace:'pre-wrap'}}>{r.text}</div>
								<hr style={{margin:'12px 0', borderColor:'rgba(255,255,255,0.03)'}} />
							</div>
						))}
					</div>
				)}

				{/* Inline reply editor */}
				{replyOpen && (
					<div className="inline-reply" style={{marginTop:12, padding:12, borderRadius:8, background:'#071015', border:'1px solid rgba(255,255,255,0.03)'}}>
						<div style={{display:'flex', gap:8, marginBottom:8}}>
							<input style={{flex:1, padding:8, borderRadius:6, border:'1px solid rgba(255,255,255,0.04)', background:'#081217', color:'#fff'}} value={replyTo} onChange={e=>setReplyTo(e.target.value)} placeholder="To" />
							<input style={{flex:1, padding:8, borderRadius:6, border:'1px solid rgba(255,255,255,0.04)', background:'#081217', color:'#fff'}} value={replySubject} onChange={e=>setReplySubject(e.target.value)} placeholder="Subject" />
						</div>
						<textarea value={replyBody} onChange={e=>setReplyBody(e.target.value)} rows={6} style={{width:'100%', padding:10, borderRadius:8, border:'1px solid rgba(255,255,255,0.04)', background:'#061017', color:'#fff', resize:'vertical'}} />
						{replyQuoted ? (
							<div style={{marginTop:10, padding:10, borderRadius:6, background:'#041014', border:'1px solid rgba(255,255,255,0.02)', color:'#9aa6b2', whiteSpace:'pre-wrap', fontSize:13}}>
								{replyQuoted}
							</div>
						) : null}
						<div style={{display:'flex', gap:8, marginTop:8}}>
							<button style={{background:'#0b88ff', color:'#fff', border:'none', padding:'8px 12px', borderRadius:6}} onClick={handleSendInlineReply}>Send</button>
							<button style={{background:'transparent', color:'#9aa6b2', border:'1px solid rgba(255,255,255,0.03)', padding:'8px 12px', borderRadius:6}} onClick={handleDiscardInline}>Discard</button>
						</div>
					</div>
				)}

				{message.attachments && message.attachments.length > 0 && (
					<div className="attachments-section">
						<h3>Attachments</h3>
						<div className="attachments-list">
							{message.attachments.map((a, i) => (
								<div key={i} className="attachment-card">
									<div className="attachment-icon">📎</div>
									<div className="attachment-info">
										<div className="attachment-name">{a.filename || a.name || 'attachment'}</div>
										<div className="attachment-size">{a.size ? (Math.round(a.size/1024) + ' KB') : (a.contentType || '')}</div>
									</div>
									<div className="attachment-actions">
										<button onClick={async ()=> {
											try {
												const composite = message.mailbox ? `${message.mailbox}::${message.uid}` : message.uid;
												const { blob, filename } = await downloadAttachment(composite, i);
												const url = URL.createObjectURL(blob);
												const aEl = document.createElement('a');
												aEl.href = url;
												aEl.download = filename || (a.filename || 'attachment');
												document.body.appendChild(aEl);
												aEl.click();
												aEl.remove();
												URL.revokeObjectURL(url);
											} catch (err) {
												alert('Download failed: ' + (err && err.message || ''));
											}
										}}>⬇</button>
									</div>
								</div>
							))}
						</div>
					</div>
				)}
			</div>

			{/* removed fixed bottom toolbar; actions now inline above message */}
		</div>
	);
}
