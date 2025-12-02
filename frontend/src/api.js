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
  const res = await fetch(`${API_BASE}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  return res.json();
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
