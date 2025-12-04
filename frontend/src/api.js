const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

export async function login(email, password) {
  const res = await fetch(`${API_BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  return res.json();
}

// session-scoped token helpers
export function setToken(token) {
  sessionStorage.setItem('token', token);
}
export function getToken() {
  return sessionStorage.getItem('token');
}
export function clearToken() {
  sessionStorage.removeItem('token');
}
export function isTokenExpired() {
  const token = getToken();
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    if (!payload.exp) return false;
    return Date.now() / 1000 >= payload.exp;
  } catch (e) {
    return true;
  }
}

function authHeaders() {
  if (isTokenExpired()) {
    clearToken();
    return {};
  }
  const token = getToken();
  return token ? { Authorization: 'Bearer ' + token } : {};
}

export async function listMessages() {
  const res = await fetch(`${API_BASE}/api/messages`, { headers: { ...authHeaders() } });
  return res.json();
}

export async function getMessage(uid) {
  const res = await fetch(`${API_BASE}/api/message/${uid}`, { headers: { ...authHeaders() } });
  return res.json();
}

// new: get current logged-in account info
export async function getMe() {
  const res = await fetch(`${API_BASE}/api/me`, { headers: { ...authHeaders() } });
  return res.json();
}

// new: get messages the user sent
export async function getSentMessages() {
  const res = await fetch(`${API_BASE}/api/messages/sent`, { headers: { ...authHeaders() } });
  return res.json();
}

// new: get drafts for the user
export async function getDraftMessages() {
  const res = await fetch(`${API_BASE}/api/messages/drafts`, { headers: { ...authHeaders() } });
  return res.json();
}

export async function sendMail(payload) {
  // if attachments provided (array of File or {file}), send as multipart/form-data
  const hasFiles = payload && payload.attachments && payload.attachments.length;
  if (hasFiles) {
    const form = new FormData();
    form.append('to', payload.to || '');
    form.append('subject', payload.subject || '');
    form.append('text', payload.text || '');
    form.append('html', payload.html || '');
    if (payload.from) form.append('from', payload.from);
    // attachments array may be Files or objects with .file
    for (const a of payload.attachments) {
      const fileObj = a instanceof File ? a : (a && a.file) ? a.file : null;
      if (fileObj) form.append('attachments', fileObj, fileObj.name || (a.name || 'attachment'));
    }
    const res = await fetch(`${API_BASE}/api/send`, {
      method: 'POST',
      headers: { ...authHeaders() }, // do NOT set Content-Type so browser sets multipart boundary
      body: form
    });
    return res.json();
  }

  // fallback: JSON body
  const res = await fetch(`${API_BASE}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// schedule a mail to be sent later (payload: { to, subject, text, html, sendAt })
export async function scheduleMail(payload) {
  const res = await fetch(`${API_BASE}/api/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// list scheduled jobs for current user
export async function getScheduledJobs() {
  const res = await fetch(`${API_BASE}/api/schedule`, { headers: { ...authHeaders() } });
  return res.json();
}

// cancel scheduled job by id
export async function deleteScheduledJob(id) {
  const res = await fetch(`${API_BASE}/api/schedule/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...authHeaders() }
  });
  return res.json();
}

// new: download an attachment; composite is mailbox::uid or uid, idx is number
export async function downloadAttachment(composite, idx) {
  const res = await fetch(`${API_BASE}/api/message/${encodeURIComponent(composite)}/attachment/${idx}`, {
    method: 'GET',
    headers: { ...authHeaders() }
  });
  if (!res.ok) throw new Error('Download failed: ' + res.statusText);
  const cd = res.headers.get('Content-Disposition') || '';
  let filename = 'attachment';
  const m = /filename="?([^"]+)"?/.exec(cd);
  if (m) filename = decodeURIComponent(m[1]);
  const blob = await res.blob();
  return { blob, filename };
}

// new: download full raw message (.eml) by composite id mailbox::uid or uid
export async function downloadMessageRaw(composite) {
  const res = await fetch(`${API_BASE}/api/message/${encodeURIComponent(composite)}/raw`, {
    method: 'GET',
    headers: { ...authHeaders() }
  });
  if (!res.ok) throw new Error('Download failed: ' + res.statusText);
  const cd = res.headers.get('Content-Disposition') || '';
  let filename = 'message.eml';
  const m = /filename="?([^"]+)"?/.exec(cd);
  if (m) filename = decodeURIComponent(m[1]);
  const blob = await res.blob();
  return { blob, filename };
}

// new: save a draft on the server (append to Drafts folder)
export async function saveDraft(payload) {
  const res = await fetch(`${API_BASE}/api/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// new: delete a specific draft message by mailbox + uid
export async function deleteDraftMessage(mailbox, uid) {
  const res = await fetch(`${API_BASE}/api/draft/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ mailbox, uid })
  });
  return res.json();
}

// fetch Trash folder messages (server will purge >30d before returning)
export async function getTrashMessages() {
  const res = await fetch(`${API_BASE}/api/messages/trash`, { headers: { ...authHeaders() } });
  return res.json();
}

// move message to trash (composite = mailbox::uid or uid)
export async function moveToTrash(composite) {
  const encoded = encodeURIComponent(composite);
  const res = await fetch(`${API_BASE}/api/message/${encoded}/move-to-trash`, {
    method: 'POST',
    headers: { ...authHeaders() }
  });
  if (!res.ok) {
    const body = await res.json().catch(()=>({ error: res.statusText }));
    throw new Error(body && (body.error || body.message) ? (body.error || body.message) : res.statusText || 'Move to trash failed');
  }
  return res.json();
}

// permanently delete message from given composite mailbox::uid
export async function deleteMessagePermanent(composite) {
  const encoded = encodeURIComponent(composite);
  const res = await fetch(`${API_BASE}/api/message/${encoded}/delete-permanent`, {
    method: 'POST',
    headers: { ...authHeaders() }
  });
  return res.json();
}

// restore message from trash (composite = mailbox::uid or uid)
export async function restoreFromTrash(composite) {
  const encoded = encodeURIComponent(composite);
  const res = await fetch(`${API_BASE}/api/message/${encoded}/restore`, {
    method: 'POST',
    headers: { ...authHeaders() }
  });
  return res.json();
}
