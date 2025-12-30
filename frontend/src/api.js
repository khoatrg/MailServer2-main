export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

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
  const hasFiles = payload && payload.attachments && payload.attachments.length;
  
  if (hasFiles) {
    // Use FormData for attachments
    const form = new FormData();
    form.append('to', payload.to || '');
    form.append('subject', payload.subject || '');
    form.append('text', payload.text || '');
    form.append('html', payload.html || '');
    form.append('sendAt', payload.sendAt || '');
    
    // Attachments array may be Files or objects with .file
    for (const a of payload.attachments) {
      const fileObj = a instanceof File ? a : (a && a.file) ? a.file : null;
      if (fileObj) {
        form.append('attachments', fileObj, fileObj.name || (a.name || 'attachment'));
      }
    }
    
    const res = await fetch(`${API_BASE}/api/schedule`, {
      method: 'POST',
      headers: { ...authHeaders() }, // Don't set Content-Type, let browser set multipart boundary
      body: form
    });
    return res.json();
  }
  
  // Fallback: JSON body (no attachments)
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

// admin: authenticate hMailServer admin password (returns {success})
export async function adminHMailAuth(adminPassword) {
  const res = await fetch(`${API_BASE}/api/admin/hmail-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ adminPassword })
  });
  return res.json();
}

// admin: list all accounts (body: { adminPassword })
export async function adminListAccounts(adminPassword) {
  const res = await fetch(`${API_BASE}/api/admin/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ adminPassword })
  });
  return res.json();
}

// admin: change account password (route param address, body: { adminPassword, newPassword })
export async function adminChangeAccountPassword(address, adminPassword, newPassword) {
  const res = await fetch(`${API_BASE}/api/admin/account/${encodeURIComponent(address)}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ adminPassword, newPassword })
  });
  return res.json();
}

// admin: create account (body: { adminPassword, address, password, active, maxSize })
export async function adminCreateAccount(payload) {
  const res = await fetch(`${API_BASE}/api/admin/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  return res.json();
}

export async function adminDeleteAccount(email, adminPassword) {
  const res = await fetch(`${API_BASE}/api/admin/account/${encodeURIComponent(email)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ adminPassword })
  });
  return res.json();
}
export async function adminListCredentials() {
  const res = await fetch(`${API_BASE}/api/admin/credentials`, { headers: { ...authHeaders() } });
  return res.json();
}
export async function adminUpdateCredential(payload) {
  const res = await fetch(`${API_BASE}/api/admin/credential`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  return res.json();
}
// admin backup -> start backup (body: { adminPassword })
export async function adminBackup(adminPassword) {
  const res = await fetch(`${API_BASE}/api/admin/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ adminPassword })
  });
  return res.json();
}

// ---- new admin helpers ----
export async function adminAllMails() {
  const res = await fetch(`${API_BASE}/api/admin/all-mails`, { headers: { ...authHeaders() } });
  return res.json();
}

// delete a message for an account (admin) - body: { mailbox, uid }
export async function adminDeleteAccountMessage(email, mailbox, uid) {
  const res = await fetch(`${API_BASE}/api/admin/account/${encodeURIComponent(email)}/message`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ mailbox, uid })
  });
  return res.json();
}

// fetch messages for a single account (admin) - now POST with adminPassword
export async function adminGetAccountMessages(email, adminPassword) {
  const res = await fetch(`${API_BASE}/api/admin/account/${encodeURIComponent(email)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ adminPassword })
  });
  return res.json();
}

// fetch user settings
export async function getSettings() {
  const res = await fetch(`${API_BASE}/api/settings`, { headers: { ...authHeaders() } });
  return res.json();
}

// update user settings (body: { outOfOffice, outOfOfficeReply, theme, appLock })
export async function updateSettings(payload) {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  return res.json();
}

export async function LOGOUT() {
  const res = await fetch(`${API_BASE}/api/logout`, {
    method: 'POST',
    headers: { ...authHeaders() }
  });
  return res.json();
}

// admin: list active sessions (returns { success, sessions: [{ jti, email, exp, expiresAt }] })
export async function adminListSessions() {
  const res = await fetch(`${API_BASE}/api/admin/sessions`, { headers: { ...authHeaders() } });
  return res.json();
}

// admin: delete session by jti
export async function adminDeleteSession(jti) {
  const res = await fetch(`${API_BASE}/api/admin/sessions/${encodeURIComponent(jti)}`, {
    method: 'DELETE',
    headers: { ...authHeaders() }
  });
  return res.json();
}
