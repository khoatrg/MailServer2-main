const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const https = require('https');
dotenv.config();

const { listMessages, fetchMessage, sendMail, listAllMessages, searchMessagesByFrom, listMessagesFromBox, saveDraft, deleteMessage, getRawMessage, getAttachment, moveToTrash } = require('./mailService');

const app = express();
app.use(cors());
app.use(bodyParser.json());
const upload = multer({ storage: multer.memoryStorage() });

/* --- scheduled jobs persistence (must be defined before endpoints) --- */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');
const SCHEDULE_FILE = path.join(__dirname, 'scheduled_jobs.json');
let scheduledJobs = [];

function loadScheduledJobs() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const raw = fs.readFileSync(SCHEDULE_FILE, 'utf8');
      scheduledJobs = JSON.parse(raw) || [];
    } else {
      scheduledJobs = [];
    }
  } catch (e) { scheduledJobs = []; console.warn('Could not load scheduled jobs', e && e.message); }
}
function saveScheduledJobs() {
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduledJobs, null, 2)); } catch (e) { console.warn('Could not save scheduled jobs', e && e.message); }
}
loadScheduledJobs();

// lightweight processor (keeps existing processScheduledJobs usage intact)
async function processScheduledJobs() {
  const now = Date.now();
  const due = scheduledJobs.filter(j => Date.parse(j.sendAt) <= now);
  if (!due.length) return;
  for (const job of due) {
    try {
      console.log('Processing scheduled job id=', job.id, 'user=', job.user);
      await sendMail(job.user, job.password, {
        from: job.mailOptions.from || job.user,
        to: job.mailOptions.to,
        subject: job.mailOptions.subject,
        text: job.mailOptions.text,
        html: job.mailOptions.html,
        attachments: job.mailOptions.attachments || []
      });
      scheduledJobs = scheduledJobs.filter(j => j.id !== job.id);
      saveScheduledJobs();
    } catch (err) {
      console.error('Scheduled job failed id=', job.id, err && (err.message || err));
      // keep job for retry
    }
  }
}
setInterval(() => { processScheduledJobs().catch(e=>console.error(e)); }, 30 * 1000);
/* --- end scheduled block --- */

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

// ---------- Postgres-backed session store ----------
const { Pool } = require('pg'); // add PG pool
const PG_CONN = process.env.DATABASE_URL || (process.env.PGHOST ? undefined : undefined);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.PGHOST || undefined,
  user: process.env.PGUSER || undefined,
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE || undefined,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  ssl: (process.env.PGSSL === 'true') ? { rejectUnauthorized: false } : false,
  // rely on env for other tuning
});

// ensure sessions table exists
(async function ensureSessionsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        jti TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        password TEXT NOT NULL,
        exp BIGINT NOT NULL
      );
    `);

    // create user_settings table for storing per-account preferences
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        email TEXT PRIMARY KEY,
        out_of_office BOOLEAN DEFAULT FALSE,
        out_of_office_reply TEXT DEFAULT '',
        theme TEXT DEFAULT 'system',    -- 'system' | 'dark' | 'light'
        app_lock BOOLEAN DEFAULT FALSE
      );
    `);
  } catch (err) {
    console.error('Could not ensure sessions/user_settings tables:', err && err.stack || err);
    // allow server to continue; queries will fail if DB not available
  }
})();

// helper: parse expiry spec to ms (reuse existing)
function parseExpiryToMs(spec) {
  if (!spec) return 0;
  const num = parseFloat(spec);
  if (!isNaN(num) && String(spec).match(/^\d+$/)) return num * 1000;
  const m = /^(\d+)(s|m|h|d)$/.exec(String(spec));
  if (!m) return 0;
  const val = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case 's': return val * 1000;
    case 'm': return val * 60 * 1000;
    case 'h': return val * 60 * 60 * 1000;
    case 'd': return val * 24 * 60 * 60 * 1000;
    default: return 0;
  }
}

// DB session helpers
async function createSessionRow(jti, email, password, expMsTimestamp) {
  try {
    await pool.query(
      'INSERT INTO sessions(jti,email,password,exp) VALUES($1,$2,$3,$4) ON CONFLICT (jti) DO UPDATE SET email = EXCLUDED.email, password = EXCLUDED.password, exp = EXCLUDED.exp',
      [jti, email, password, expMsTimestamp]
    );
  } catch (err) {
    console.warn('createSessionRow failed', err && (err.message || err));
  }
}

async function getSessionRow(jti) {
  try {
    const r = await pool.query('SELECT jti,email,password,exp FROM sessions WHERE jti = $1', [jti]);
    if (!r.rows || r.rows.length === 0) return null;
    return r.rows[0];
  } catch (err) {
    console.warn('getSessionRow failed', err && (err.message || err));
    return null;
  }
}

async function deleteSessionRow(jti) {
  try {
    await pool.query('DELETE FROM sessions WHERE jti = $1', [jti]);
  } catch (err) {
    console.warn('deleteSessionRow failed', err && (err.message || err));
  }
}

async function cleanupExpiredSessions() {
  try {
    const now = Date.now();
    await pool.query('DELETE FROM sessions WHERE exp <= $1', [now]);
  } catch (err) {
    console.warn('cleanupExpiredSessions failed', err && (err.message || err));
  }
}

// periodic cleanup (hourly)
setInterval(() => { cleanupExpiredSessions().catch(e => console.error(e)); }, 60 * 60 * 1000);

// --- secure token creation (no password inside JWT) ---
async function createToken(email, password) {
  const jti = 'sess_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
  const token = jwt.sign({ email, jti }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  const expiryMs = parseExpiryToMs(JWT_EXPIRES) || (8 * 60 * 60 * 1000);
  const expTs = Date.now() + expiryMs;
  // persist to DB
  await createSessionRow(jti, email, password, expTs);
  return token;
}

// auth middleware now queries DB for session
async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // attach raw token payload for admin checks
  req.tokenPayload = payload;

  // require jti and email in token
  const jti = payload && payload.jti;
  const email = payload && payload.email;
  if (!jti || !email) return res.status(401).json({ error: 'Invalid token payload' });

  const sess = await getSessionRow(jti);
  if (!sess || sess.email !== email) {
    return res.status(401).json({ error: 'Session not found or expired' });
  }
  if (sess.exp && Date.now() >= Number(sess.exp)) {
    // expired -> remove and reject
    await deleteSessionRow(jti);
    return res.status(401).json({ error: 'Session expired' });
  }

  req.user = { email: sess.email, password: sess.password, jti };
  next();
}

// ---------- hMailServer COM admin helpers & endpoints ----------
let ActiveXObject = null;
try {
  ActiveXObject = require('winax').ActiveXObject;
} catch (e) {
  ActiveXObject = null;
  console.warn('winax require failed or not available:', e && (e.message || e));
}

// helper: run a temporary VBScript via cscript.exe and return stdout lines
async function runVbScriptAndCollect(adminScript) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const fn = path.join(tmpDir, `hmail_admin_${Date.now()}.vbs`);
    try {
      fs.writeFileSync(fn, adminScript, 'utf8');
    } catch (e) {
      return reject(new Error('Failed to write temp vbs: ' + (e && e.message)));
    }
    const cmd = process.env.COMSPEC || 'cscript'; // on Windows, cscript should be available
    // prefer explicit cscript.exe if on Windows
    const exe = (process.platform === 'win32') ? 'cscript.exe' : 'cscript';
    execFile(exe, ['//NoLogo', fn], { windowsHide: true, timeout: 30 * 1000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(fn); } catch (_) {}
      if (err) {
        const errMsg = (stderr || err.message || '').toString();
        return reject(new Error('VBScript execution failed: ' + errMsg));
      }
      const out = (stdout || '').toString().trim();
      const lines = out === '' ? [] : out.replace(/\r/g,'').split('\n').map(l => l.trim()).filter(Boolean);
      resolve(lines);
    });
  });
}

// DB-backed admin permission check (async)
async function ensureAdminPermission(req, res) {
  try {
    const email = req.user && req.user.email;
    if (!email) {
      res.status(403).json({ error: 'Forbidden: admin required' });
      return false;
    }
    // Query hm_accounts.accountadminlevel
    const q = await pool.query('SELECT accountadminlevel FROM hm_accounts WHERE accountaddress = $1 LIMIT 1', [email]);
    const lvl = q.rows && q.rows[0] ? Number(q.rows[0].accountadminlevel || 0) : 0;
    if (lvl < 1) {
      res.status(403).json({ error: 'Forbidden: admin required' });
      return false;
    }
    return true;
  } catch (err) {
    console.warn('ensureAdminPermission DB error', err && (err.message || err));
    res.status(500).json({ error: 'Internal error checking admin permission' });
    return false;
  }
}

// POST /api/admin/hmail-auth { adminPassword }
app.post('/api/admin/hmail-auth', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  const { adminPassword } = req.body || {};
  if (!adminPassword) return res.status(400).json({ error: 'adminPassword required' });
  if (!ActiveXObject) return res.status(500).json({ error: 'Server does not support COM (winax not installed or not Windows)' });

  try {
    const obApp = new ActiveXObject('hMailServer.Application');
    obApp.Authenticate('Administrator', adminPassword);
    // If no exception, auth succeeded
    return res.json({ success: true });
  } catch (err) {
    console.warn('hmail auth failed', err && (err.message || err));
    return res.status(401).json({ error: 'hMailServer authentication failed' });
  }
});

// POST /api/admin/accounts { adminPassword } -> returns list of account addresses
app.post('/api/admin/accounts', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  const { adminPassword } = req.body || {};
  if (!adminPassword) return res.status(400).json({ error: 'adminPassword required' });

  // Use winax when available
  if (ActiveXObject) {
    try {
      const obApp = new ActiveXObject('hMailServer.Application');
      obApp.Authenticate('Administrator', adminPassword);
      const out = [];
      const domains = obApp.Domains;
      for (let i = 0; i < domains.Count; i++) {
        const dom = domains.Item(i);
        const accounts = dom.Accounts;
        for (let j = 0; j < accounts.Count; j++) {
          const a = accounts.Item(j);
          out.push({ address: a.Address, domain: dom.Name });
        }
      }
      return res.json({ success: true, accounts: out });
    } catch (err) {
      console.error('admin/accounts (winax) error', err && (err.message || err));
      return res.status(500).json({ error: 'Failed to list accounts (COM error or invalid admin password)' });
    }
  }

  // Fallback: run VBScript via cscript.exe and parse output (each line: address|domain)
  try {
    const vb = `
On Error Resume Next
Set obApp = CreateObject("hMailServer.Application")
obApp.Authenticate "Administrator", "${String(adminPassword).replace(/"/g,'""')}"
If Err.Number <> 0 Then
  WScript.StdErr.Write "AUTH_FAILED"
  WScript.Quit 1
End If
Set domains = obApp.Domains
For i = 0 To domains.Count - 1
  Set dom = domains.Item(i)
  Set accounts = dom.Accounts
  For j = 0 To accounts.Count - 1
    Set a = accounts.Item(j)
    WScript.Echo a.Address & "|" & dom.Name
  Next
Next
`;
    const lines = await runVbScriptAndCollect(vb);
    const accounts = lines.map(l => {
      const parts = l.split('|');
      return { address: parts[0] || l, domain: parts[1] || '' };
    });
    return res.json({ success: true, accounts });
  } catch (e) {
    console.error('admin/accounts (vbs) error', e && (e.message || e));
    return res.status(500).json({ error: 'Failed to list accounts (cscript fallback failed): ' + (e && e.message) });
  }
});

// POST /api/admin/account/:addr/password { adminPassword, newPassword }
app.post('/api/admin/account/:addr/password', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  const { adminPassword, newPassword } = req.body || {};
  const addr = req.params.addr;
  if (!adminPassword || !newPassword) return res.status(400).json({ error: 'adminPassword and newPassword required' });

  // winax path
  if (ActiveXObject) {
    try {
      const obApp = new ActiveXObject('hMailServer.Application');
      obApp.Authenticate('Administrator', adminPassword);
      const atIdx = addr.indexOf('@');
      if (atIdx === -1) return res.status(400).json({ error: 'invalid address' });
      const domainName = addr.slice(atIdx + 1);
      const domain = obApp.Domains.ItemByName(domainName);
      if (!domain) return res.status(404).json({ error: 'domain not found' });
      const account = domain.Accounts.ItemByAddress(addr);
      if (!account) return res.status(404).json({ error: 'account not found' });
      account.Password = newPassword;
      account.Save();
      return res.json({ success: true });
    } catch (err) {
      console.error('admin change password (winax) failed', err && (err.message || err));
      return res.status(500).json({ error: 'Failed to change password (COM error or invalid admin credentials)' });
    }
  }

  // VBScript fallback
  try {
    // escape quotes in address and password
    const escAdmin = String(adminPassword).replace(/"/g,'""');
    const escAddr = String(addr).replace(/"/g,'""');
    const escNew = String(newPassword).replace(/"/g,'""');
    const vb = `
On Error Resume Next
Set obApp = CreateObject("hMailServer.Application")
obApp.Authenticate "Administrator", "${escAdmin}"
If Err.Number <> 0 Then
  WScript.StdErr.Write "AUTH_FAILED"
  WScript.Quit 1
End If
Dim obDomain
Set obDomain = obApp.Domains.ItemByName("${escAddr.split('@').slice(1).join('@')}")
If Err.Number <> 0 Or IsNull(obDomain) Then
  WScript.StdErr.Write "DOMAIN_NOT_FOUND"
  WScript.Quit 2
End If
Dim obAccount
Set obAccount = obDomain.Accounts.ItemByAddress("${escAddr}")
If Err.Number <> 0 Or IsNull(obAccount) Then
  WScript.StdErr.Write "ACCOUNT_NOT_FOUND"
  WScript.Quit 3
End If
obAccount.Password = "${escNew}"
obAccount.Save
WScript.Echo "OK"
`;
    const lines = await runVbScriptAndCollect(vb);
    if (lines.length && lines[0] === 'OK') return res.json({ success: true });
    return res.status(500).json({ error: 'VBScript did not report success' });
  } catch (e) {
    console.error('admin change password (vbs) error', e && (e.message || e));
    return res.status(500).json({ error: 'Failed to change password (cscript fallback failed): ' + (e && e.message) });
  }
});

// --- new: DELETE /api/admin/account/:addr { adminPassword } ---
app.delete('/api/admin/account/:addr', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  const { adminPassword } = req.body || {};
  const addr = req.params.addr;
  if (!adminPassword) return res.status(400).json({ error: 'adminPassword required' });
  if (!addr) return res.status(400).json({ error: 'address required' });

  // winax path
  if (ActiveXObject) {
    try {
      const obApp = new ActiveXObject('hMailServer.Application');
      obApp.Authenticate('Administrator', adminPassword);

      const atIdx = addr.indexOf('@');
      if (atIdx === -1) return res.status(400).json({ error: 'invalid address' });
      const domainName = addr.slice(atIdx + 1);

      const domain = obApp.Domains.ItemByName(domainName);
      if (!domain) return res.status(404).json({ error: 'domain not found' });

      const account = domain.Accounts.ItemByAddress(addr);
      if (!account) return res.status(404).json({ error: 'account not found' });

      // delete by DBID (as VB code)
      domain.Accounts.DeleteByDBID(account.ID);
      return res.json({ success: true });
    } catch (err) {
      console.error('admin delete account (winax) failed', err && (err.message || err));
      return res.status(500).json({ error: 'Failed to delete account (COM error or invalid admin credentials)' });
    }
  }

  // VBScript fallback
  try {
    const escAdmin = String(adminPassword).replace(/"/g,'""');
    const escAddr = String(addr).replace(/"/g,'""');
    const vb = `
On Error Resume Next
Set obApp = CreateObject("hMailServer.Application")
obApp.Authenticate "Administrator", "${escAdmin}"
If Err.Number <> 0 Then
  WScript.StdErr.Write "AUTH_FAILED"
  WScript.Quit 1
End If
Dim obDomain
Set obDomain = obApp.Domains.ItemByName("${escAddr.split('@').slice(1).join('@')}")
If Err.Number <> 0 Or IsNull(obDomain) Then
  WScript.StdErr.Write "DOMAIN_NOT_FOUND"
  WScript.Quit 2
End If
Dim obAccount
Set obAccount = obDomain.Accounts.ItemByAddress("${escAddr}")
If Err.Number <> 0 Or IsNull(obAccount) Then
  WScript.StdErr.Write "ACCOUNT_NOT_FOUND"
  WScript.Quit 3
End If
obDomain.Accounts.DeleteByDBID obAccount.ID
WScript.Echo "OK"
`;
    const lines = await runVbScriptAndCollect(vb);
    if (lines.length && lines[0] === 'OK') return res.json({ success: true });
    return res.status(500).json({ error: 'VBScript did not report success' });
  } catch (e) {
    console.error('admin delete account (vbs) error', e && (e.message || e));
    return res.status(500).json({ error: 'Failed to delete account (cscript fallback failed): ' + (e && e.message) });
  }
});

// POST /api/login { email, password }
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  // verify by attempting IMAP login
  try {
    const imap = require('imap-simple');
    await imap.connect({
      imap: {
        user: email,
        password: password,
        host: process.env.IMAP_HOST || 'localhost',
        port: parseInt(process.env.IMAP_PORT || '143', 10),
        tls: (process.env.IMAP_TLS === 'true')
      }
    }).then(conn => conn.end());

    // createToken is async — await it and handle errors
    try {
      const token = await createToken(email, password);
      return res.json({ token });
    } catch (tkErr) {
      console.error('createToken failed', tkErr && (tkErr.stack || tkErr));
      return res.status(500).json({ error: 'Failed to create session token' });
    }
  } catch (err) {
    return res.status(401).json({ error: 'Login failed: ' + (err.message || err) });
  }
});

// GET /api/messages
app.get('/api/messages', authMiddleware, async (req, res) => {
  try {
    const msgs = await listMessages(req.user.email, req.user.password);
    res.json({ messages: msgs });
  } catch (err) {
    res.status(500).json({ error: err.message || err });
  }
});

// GET /api/message/:uid
app.get('/api/message/:uid', authMiddleware, async (req, res) => {
  let uidParam = req.params.uid || '';
  // allow mailbox in query param
  let mailbox = req.query.mailbox || req.query.box || 'INBOX';
  // allow composite param like "Sent::123"
  if (uidParam.includes('::')) {
    const parts = uidParam.split('::');
    if (parts.length >= 2) {
      mailbox = parts[0] || mailbox;
      uidParam = parts[1];
    }
  }
  const uid = uidParam;
  try {
    const msg = await fetchMessage(req.user.email, req.user.password, uid, mailbox);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    res.json({ message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message || err });
  }
});

// GET /api/me -> return basic account info + inbox stats + adminLevel from DB
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    // derive a friendly display name from local part
    const local = (email || '').split('@')[0] || '';
    const displayName = local
      .replace(/[._]/g, ' ')
      .split(/\s+/)
      .map(p => p ? (p[0].toUpperCase() + p.slice(1)) : '')
      .join(' ')
      || email;

    // get inbox stats (uses IMAP login with the user's credentials)
    let total = 0, unread = 0;
    try {
      const msgs = await listMessages(req.user.email, req.user.password);
      total = (msgs && msgs.length) || 0;
      unread = (msgs && msgs.filter(m => !m.seen).length) || 0;
    } catch (e) {
      console.warn('Could not fetch inbox stats for', email, e.message || e);
    }

    // fetch admin level from hm_accounts (best-effort)
    let adminLevel = 0;
    try {
      const r = await pool.query('SELECT accountadminlevel FROM hm_accounts WHERE accountaddress = $1 LIMIT 1', [email]);
      if (r.rows && r.rows[0]) adminLevel = Number(r.rows[0].accountadminlevel || 0);
    } catch (e) {
      console.warn('Could not read accountadminlevel for', email, e && (e.message || e));
    }

    // fetch user settings (best-effort)
    let settings = { outOfOffice: false, outOfOfficeReply: '', theme: 'system', appLock: false };
    try {
      const s = await getUserSettings(email);
      if (s) settings = s;
    } catch (e) {
      console.warn('Could not read user settings for', email, e && (e.message || e));
    }

    res.json({ email, displayName, inbox: { total, unread }, adminLevel, settings });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// GET /api/messages/sent -> search server for messages whose FROM header contains the logged-in email
// GET /api/messages/sent -> read directly from Sent folder
app.get('/api/messages/sent', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const password = req.user.password;

    // Check for both common folder names:
    const possibleSentFolders = ["Sent", "Sent Items", "SENT", "Sent Mail"];

    let messages = [];
    let foundFolder = null;

    for (const folder of possibleSentFolders) {
      try {
        messages = await listMessagesFromBox(email, password, folder);
        foundFolder = folder;
        break; // success
      } catch (err) {
        // folder doesn't exist -> try next
      }
    }

    if (!foundFolder) {
      return res.json({ messages: [], info: "No Sent folder found" });
    }

    res.json({
      folder: foundFolder,
      messages
    });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list sent messages' });
  }
});

// GET /api/messages/drafts -> messages with IMAP Draft flag
app.get('/api/messages/drafts', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const password = req.user.password;

    // Use same candidates as saveDraft in mailService (include INBOX-prefixed and uppercase variants)
    const possibleDraftFolders = ["Drafts", "Draft", "DRAFT", "Draft Items", "INBOX.Drafts", "INBOX.DRAFT", "INBOX.DRAFTS"];

    let messages = [];
    let foundFolder = null;

    for (const folder of possibleDraftFolders) {
      try {
        messages = await listMessagesFromBox(email, password, folder);
        if (messages && messages.length) {
          foundFolder = folder;
          break; // success with results
        }
        // if folder opened but empty, still treat as found (server has that folder)
        // but continue to try others in case a different one contains drafts
        // keep last empty result if no other folder matches
      } catch (err) {
        // folder doesn't exist -> try next
      }
    }

    // If no folder produced results, fallback to scanning all mailboxes and filter by Draft flag
    if ((!foundFolder && (!messages || messages.length === 0))) {
      try {
        const all = await listAllMessages(email, password);
        const draftMsgs = (all || []).filter(m => {
          const flags = m.flags || [];
          return flags.some(f => String(f).toLowerCase().includes('draft'));
        });
        if (draftMsgs.length) {
          return res.json({ folder: 'multiple', messages: draftMsgs });
        }
      } catch (e) {
        console.warn('Failed to list all mailboxes when searching for drafts for', email, e && (e.message || e));
        // continue to return empty if fallback fails
      }
    }

    if (!foundFolder && (!messages || messages.length === 0)) {
      return res.json({ messages: [], info: "No Drafts folder or draft-flagged messages found" });
    }

    res.json({
      folder: foundFolder || 'unknown',
      messages
    });

  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list draft messages' });
  }
});

// POST /api/send -> accepts JSON or multipart/form-data with attachments (field name "attachments")
app.post('/api/send', authMiddleware, upload.array('attachments'), async (req, res) => {
  try {
    // support both JSON body and multipart form fields
    const body = req.body || {};
    const to = body.to || '';
    const subject = body.subject || '';
    const text = body.text || '';
    const html = body.html || '';
    const from = body.from || req.user.email;
    if (!to || !subject || !(text || html)) return res.status(400).json({ error: 'to, subject, and text/html required' });

    // build attachments array from multer buffers if present
    const files = req.files || [];
    const attachments = files.map(f => ({ filename: f.originalname, content: f.buffer, contentType: f.mimetype }));

    const mailOptions = { from, to, subject, text, html, attachments };
    console.log(`Sending mail from=${req.user.email} to=${to} subject=${subject} attachments=${attachments.length}`);
    const info = await sendMail(req.user.email, req.user.password, mailOptions);
    res.json({ success: true, info });
  } catch (err) {
    console.error('POST /api/send error for', req.user && req.user.email, err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to send message' });
  }
});

// GET /api/message/:uid/attachment/:idx -> download specific attachment
app.get('/api/message/:uid/attachment/:idx', authMiddleware, async (req, res) => {
  try {
    let uidParam = req.params.uid || '';
    let mailbox = req.query.mailbox || req.query.box || 'INBOX';
    if (uidParam.includes('::')) {
      const parts = uidParam.split('::');
      if (parts.length >= 2) {
        mailbox = parts[0] || mailbox;
        uidParam = parts[1];
      }
    }
    const idx = parseInt(req.params.idx || '0', 10);
    const attachment = await require('./mailService').getAttachment(req.user.email, req.user.password, uidParam, mailbox, idx);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
    const fname = attachment.filename || 'attachment';
    res.setHeader('Content-Disposition', `attachment; filename="${fname.replace(/"/g,'')}"`);
    res.send(attachment.content);
  } catch (err) {
    console.error('GET /api/message/:uid/attachment error', err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to fetch attachment' });
  }
});

// POST /api/draft { to, subject, text, html, from? }  -> save to Drafts folder (best-effort)
app.post('/api/draft', authMiddleware, async (req, res) => {
  try {
    const { to, subject, text, html, from } = req.body || {};
    // Allow partial content; require at least one field to avoid empty appends
    if (!to && !subject && !(text || html)) return res.status(400).json({ error: 'to, subject, or body required to save draft' });
    const mailOptions = { from: from || req.user.email, to: to || '', subject: subject || '', text: text || '', html: html || '' };
    await saveDraft(req.user.email, req.user.password, mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/draft error for', req.user && req.user.email, err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to save draft' });
  }
});

// POST /api/draft/delete { mailbox, uid } -> remove single message from mailbox (best-effort)
app.post('/api/draft/delete', authMiddleware, async (req, res) => {
  try {
    const { mailbox, uid } = req.body || {};
    if (!uid) return res.status(400).json({ error: 'uid required' });
    // best-effort delete: if mailbox not present, deleteMessage will error and we return failure
    await deleteMessage(req.user.email, req.user.password, mailbox || 'Drafts', uid);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/draft/delete error for', req.user && req.user.email, err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to delete draft' });
  }
});

// GET /api/messages/trash -> purge items older than 30 days then return Trash headers
app.get('/api/messages/trash', authMiddleware, async (req, res) => {
  try {
    // candidates for Trash (same names used in mailService)
    const possibleTrashFolders = ["Trash", "Deleted Items", "Deleted", "Bin", "INBOX.Trash", "INBOX.Deleted", "TRASH"];

    // find a folder that exists and list messages
    let messages = [];
    let foundFolder = null;
    for (const folder of possibleTrashFolders) {
      try {
        const msgs = await listMessagesFromBox(req.user.email, req.user.password, folder);
        // accept first folder we can read (even if empty)
        foundFolder = folder;
        messages = msgs;
        break;
      } catch (err) {
        // try next
      }
    }

    // if no folder found, return empty
    if (!foundFolder) return res.json({ messages: [], info: 'No Trash folder found' });

    // purge messages older than 30 days (best-effort)
    const now = Date.now();
    const days30 = 1000 * 60 * 60 * 24 * 30;
    for (const m of messages) {
      try {
        // Prefer the xMovedAt header (set when the message was moved to Trash).
        // Fall back: if xMovedAt is missing, skip age-based purge so we don't count from original send date.
        const movedAt = m.xMovedAt || m['x-moved-at'] || null;
        if (!movedAt) {
          // no move timestamp available -> skip age purge for this message
          continue;
        }
        const dt = new Date(movedAt);
        if (dt && (now - dt.getTime() > days30)) {
          // permanently delete by UID from that folder
          await deleteMessage(req.user.email, req.user.password, m.mailbox || foundFolder, m.uid);
        }
      } catch (e) {
        // ignore per-message errors
      }
    }

    // re-list after purge
    const refreshed = await listMessagesFromBox(req.user.email, req.user.password, foundFolder);
    res.json({ folder: foundFolder, messages: refreshed });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list trash' });
  }
});

// POST /api/message/:uid/move-to-trash -> move the message into user's Trash folder (best-effort)
app.post('/api/message/:uid/move-to-trash', authMiddleware, async (req, res) => {
  let uidParam = req.params.uid || '';
  let mailbox = req.query.mailbox || req.query.box || 'INBOX';
  if (uidParam.includes('::')) {
    const parts = uidParam.split('::');
    if (parts.length >= 2) {
      mailbox = parts[0] || mailbox;
      uidParam = parts[1];
    }
  }
  try {
    const result = await moveToTrash(req.user.email, req.user.password, uidParam, mailbox);
    if (result && result.moved) return res.json({ success: true, folder: result.target });
    return res.status(500).json({ error: 'Move to trash failed' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to move to trash' });
  }
});

// POST /api/message/:uid/delete-permanent -> permanently delete the message from its mailbox
app.post('/api/message/:uid/delete-permanent', authMiddleware, async (req, res) => {
  let uidParam = req.params.uid || '';
  let mailbox = req.query.mailbox || req.query.box || 'INBOX';
  if (uidParam.includes('::')) {
    const parts = uidParam.split('::');
    if (parts.length >= 2) {
      mailbox = parts[0] || mailbox;
      uidParam = parts[1];
    }
  }
  try {
    await deleteMessage(req.user.email, req.user.password, mailbox, uidParam);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete message permanently' });
  }
});

// POST /api/message/:uid/restore -> restore a message from Trash back to original mailbox (best-effort)
app.post('/api/message/:uid/restore', authMiddleware, async (req, res) => {
  let uidParam = req.params.uid || '';
  let mailbox = req.query.mailbox || req.query.box || 'Trash'; // allow specifying trash mailbox
  if (uidParam.includes('::')) {
    const parts = uidParam.split('::');
    if (parts.length >= 2) {
      mailbox = parts[0] || mailbox;
      uidParam = parts[1];
    }
  }
  try {
    const result = await require('./mailService').restoreFromTrash(req.user.email, req.user.password, uidParam, mailbox);
    if (result && result.restored) return res.json({ success: true, folder: result.target });
    return res.status(500).json({ error: 'Restore failed' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to restore message' });
  }
});

// POST /api/schedule { to, subject, text, html, sendAt }
app.post('/api/schedule', authMiddleware, async (req, res) => {
  try {
    const { to, subject, text, html, sendAt } = req.body || {};
    if (!to || !(text || html) || !sendAt) return res.status(400).json({ error: 'to, body and sendAt required' });
    const ts = Date.parse(sendAt);
    if (isNaN(ts) || ts <= Date.now()) return res.status(400).json({ error: 'sendAt must be a future datetime' });

    const id = 'job_' + Date.now() + '_' + Math.floor(Math.random()*10000);
    const job = {
      id,
      user: req.user.email,
      password: req.user.password,
      sendAt: new Date(ts).toISOString(),
      mailOptions: { from: req.user.email, to, subject: subject || '', text: text || '', html: html || '' }
    };
    scheduledJobs.push(job);
    saveScheduledJobs();
    return res.json({ success: true, id });
  } catch (err) {
    console.error('POST /api/schedule error', err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to schedule' });
  }
});

// GET /api/schedule -> list scheduled jobs for current user
app.get('/api/schedule', authMiddleware, async (req, res) => {
  try {
    const userJobs = (scheduledJobs || []).filter(j => j.user === req.user.email).map(j => ({
      id: j.id,
      sendAt: j.sendAt,
      mailOptions: j.mailOptions
    }));
    res.json({ jobs: userJobs });
  } catch (err) {
    console.error('GET /api/schedule error', err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to list scheduled jobs' });
  }
});

// DELETE /api/schedule/:id -> cancel a scheduled job owned by the user
app.delete('/api/schedule/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const idx = (scheduledJobs || []).findIndex(j => j.id === id && j.user === req.user.email);
    if (idx === -1) return res.status(404).json({ error: 'Job not found' });
    scheduledJobs.splice(idx, 1);
    saveScheduledJobs();
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/schedule/:id error', err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to cancel scheduled job' });
  }
});

// DB helpers for user settings
async function getUserSettings(email) {
  try {
    const r = await pool.query('SELECT out_of_office, out_of_office_reply, theme, app_lock FROM user_settings WHERE email = $1', [email]);
    if (!r.rows || r.rows.length === 0) {
      return { outOfOffice: false, outOfOfficeReply: '', theme: 'system', appLock: false };
    }
    const row = r.rows[0];
    return {
      outOfOffice: !!row.out_of_office,
      outOfOfficeReply: row.out_of_office_reply || '',
      theme: row.theme || 'system',
      appLock: !!row.app_lock
    };
  } catch (err) {
    console.warn('getUserSettings failed', err && (err.message || err));
    return { outOfOffice: false, outOfOfficeReply: '', theme: 'system', appLock: false };
  }
}

async function upsertUserSettings(email, { outOfOffice, outOfOfficeReply, theme, appLock }) {
  try {
    await pool.query(
      `INSERT INTO user_settings(email, out_of_office, out_of_office_reply, theme, app_lock)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE
         SET out_of_office = EXCLUDED.out_of_office,
             out_of_office_reply = EXCLUDED.out_of_office_reply,
             theme = EXCLUDED.theme,
             app_lock = EXCLUDED.app_lock`,
      [email, !!outOfOffice, outOfOfficeReply || '', theme || 'system', !!appLock]
    );
  } catch (err) {
    console.warn('upsertUserSettings failed', err && (err.message || err));
    throw err;
  }
}

// GET /api/settings -> return current user settings
app.get('/api/settings', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const settings = await getUserSettings(email);
    res.json({ success: true, settings });
  } catch (err) {
    console.error('GET /api/settings failed', err && (err.stack || err));
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

// POST /api/settings -> update current user settings (body: { outOfOffice, outOfOfficeReply, theme, appLock })
app.post('/api/settings', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const { outOfOffice, outOfOfficeReply, theme, appLock } = req.body || {};
    await upsertUserSettings(email, { outOfOffice, outOfOfficeReply, theme, appLock });
    const updated = await getUserSettings(email);
    res.json({ success: true, settings: updated });
  } catch (err) {
    console.error('POST /api/settings failed', err && (err.stack || err));
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

const port = process.env.PORT || 4000;
const SSL_KEY = process.env.SSL_KEY_PATH;
const SSL_CERT = process.env.SSL_CERT_PATH;

if (SSL_KEY && SSL_CERT && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
  const key = fs.readFileSync(SSL_KEY);
  const cert = fs.readFileSync(SSL_CERT);
  https.createServer({ key, cert }, app).listen(process.env.SSL_PORT, () => {
    console.log('HTTPS server listening on', process.env.SSL_PORT);
  });
} else {
  app.listen(process.env.PORT || 4000, () => console.log('HTTP server listening'));
}

// --- new: POST /api/admin/account { adminPassword, address, password, active?, maxSize? } ---
app.post('/api/admin/account', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  const { adminPassword, address, password: acctPassword, active = true, maxSize = 100 } = req.body || {};
  if (!adminPassword || !address || !acctPassword) return res.status(400).json({ error: 'adminPassword, address and password required' });

  // winax path
  if (ActiveXObject) {
    try {
      const obApp = new ActiveXObject('hMailServer.Application');
      obApp.Authenticate('Administrator', adminPassword);

      // domain from address
      const atIdx = address.indexOf('@');
      if (atIdx === -1) return res.status(400).json({ error: 'invalid address' });
      const domainName = address.slice(atIdx + 1);

      const domain = obApp.Domains.ItemByName(domainName);
      if (!domain) return res.status(404).json({ error: 'domain not found' });

      const obAccount = domain.Accounts.Add();
      obAccount.Address = address;
      obAccount.Password = acctPassword;
      obAccount.Active = !!active;
      obAccount.MaxSize = Number(maxSize) || 100;
      obAccount.Save();

      return res.json({ success: true });
    } catch (err) {
      console.error('admin create account (winax) failed', err && (err.message || err));
      return res.status(500).json({ error: 'Failed to create account (COM error or invalid admin credentials)' });
    }
  }

  // VBScript fallback
  try {
    const escAdmin = String(adminPassword).replace(/"/g,'""');
    const escAddr = String(address).replace(/"/g,'""');
    const escPass = String(acctPassword).replace(/"/g,'""');
    const vb = `
On Error Resume Next
Set obApp = CreateObject("hMailServer.Application")
obApp.Authenticate "Administrator", "${escAdmin}"
If Err.Number <> 0 Then
  WScript.StdErr.Write "AUTH_FAILED"
  WScript.Quit 1
End If
Dim obDomain
Set obDomain = obApp.Domains.ItemByName("${escAddr.split('@').slice(1).join('@')}")
If Err.Number <> 0 Or IsNull(obDomain) Then
  WScript.StdErr.Write "DOMAIN_NOT_FOUND"
  WScript.Quit 2
End If
Dim obAccount
Set obAccount = obDomain.Accounts.Add
obAccount.Address = "${escAddr}"
obAccount.Password = "${escPass}"
obAccount.Active = ${active ? 'True' : 'False'}
obAccount.MaxSize = ${Number(maxSize) || 100}
obAccount.Save
WScript.Echo "OK"
`;
    const lines = await runVbScriptAndCollect(vb);
    if (lines.length && lines[0] === 'OK') return res.json({ success: true });
    return res.status(500).json({ error: 'VBScript did not report success' });
  } catch (e) {
    console.error('admin create account (vbs) error', e && (e.message || e));
    return res.status(500).json({ error: 'Failed to create account (cscript fallback failed): ' + (e && e.message) });
  }
});

// POST /api/admin/account/:email/messages { adminPassword } -> list message headers for given account
app.post('/api/admin/account/:email/messages', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  const addr = req.params.email;
  const { adminPassword } = req.body || {};
  if (!adminPassword) return res.status(400).json({ error: 'adminPassword required' });
  if (!addr) return res.status(400).json({ error: 'address required' });

  // winax path
  if (ActiveXObject) {
    try {
      const obApp = new ActiveXObject('hMailServer.Application');
      obApp.Authenticate('Administrator', adminPassword);

      const atIdx = addr.indexOf('@');
      if (atIdx === -1) return res.status(400).json({ error: 'invalid address' });
      const domainName = addr.slice(atIdx + 1);
      const domain = obApp.Domains.ItemByName(domainName);
      if (!domain) return res.status(404).json({ error: 'domain not found' });

      const account = domain.Accounts.ItemByAddress(addr);
      if (!account) return res.status(404).json({ error: 'account not found' });

      const msgs = account.Messages;
      const out = [];
      // Messages is 0-based or 1-based depending on COM; iterate by index safely
      const count = msgs.Count || 0;
      for (let i = 0; i < count; i++) {
        try {
          const m = msgs.Item(i);
          out.push({
            id: m.ID || (m.ID === 0 ? 0 : null),
            subject: m.Subject || '',
            from: m.From || m.FromAddress || '',
            to: (m.To || m.Recipients || ''),
            date: m.Date || '',
            size: m.Size || null
          });
        } catch (e) { /* ignore individual message errors */ }
      }
      return res.json({ success: true, messages: out });
    } catch (err) {
      console.error('admin/account/messages (winax) error', err && (err.message || err));
      return res.status(500).json({ error: 'Failed to list messages (COM error or invalid admin password)' });
    }
  }

  // VBScript fallback: echo lines "id|subject|from|to|date|size"
  try {
    const vb = `
On Error Resume Next
Set obApp = CreateObject("hMailServer.Application")
obApp.Authenticate "Administrator", "${String(adminPassword).replace(/"/g,'""')}"
If Err.Number <> 0 Then
  WScript.StdErr.Write "AUTH_FAILED"
  WScript.Quit 1
End If
Set obDomain = obApp.Domains.ItemByName("${String(addr).split('@').slice(1).join('@')}")
If Err.Number <> 0 Or IsNull(obDomain) Then
  WScript.StdErr.Write "DOMAIN_NOT_FOUND"
  WScript.Quit 2
End If
Set obAccount = obDomain.Accounts.ItemByAddress("${String(addr).replace(/"/g,'""')}")
If Err.Number <> 0 Or IsNull(obAccount) Then
  WScript.StdErr.Write "ACCOUNT_NOT_FOUND"
  WScript.Quit 3
End If
Set msgs = obAccount.Messages
For i = 0 To msgs.Count - 1
  Set m = msgs.Item(i)
  ' id|subject|from|to|date|size
  WScript.Echo m.ID & "|" & Replace(m.Subject, "|", " ") & "|" & Replace(m.From, "|", " ") & "|" & Replace(m.To, "|", " ") & "|" & CStr(m.Date) & "|" & CStr(m.Size)
Next
`;
    const lines = await runVbScriptAndCollect(vb);
    const messages = lines.map(l => {
      const parts = l.split('|');
      return {
        id: parts[0] || null,
        subject: parts[1] || '',
        from: parts[2] || '',
        to: parts[3] || '',
        date: parts[4] || '',
        size: parts[5] || null
      };
    });
    return res.json({ success: true, messages });
  } catch (e) {
    console.error('admin/account/messages (vbs) error', e && (e.message || e));
    return res.status(500).json({ error: 'Failed to list messages (cscript fallback failed): ' + (e && e.message) });
  }
});

// --- new: POST /api/admin/backup { adminPassword } -> start hMailServer backup (no download) ---
app.post('/api/admin/backup', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  const { adminPassword } = req.body || {};
  if (!adminPassword) return res.status(400).json({ error: 'adminPassword required' });

  // winax path
  if (ActiveXObject) {
    try {
      const obApp = new ActiveXObject('hMailServer.Application');
      obApp.Authenticate('Administrator', adminPassword);
      const bm = obApp.BackupManager;
      if (!bm || typeof bm.StartBackup !== 'function') {
        return res.status(500).json({ error: 'BackupManager not available on this hMailServer COM object' });
      }
      // StartBackup may be synchronous; call it and return success
      bm.StartBackup();
      return res.json({ success: true, info: 'Backup started' });
    } catch (err) {
      console.error('admin/backup (winax) error', err && (err.message || err));
      return res.status(500).json({ error: 'Failed to start backup (COM error or invalid admin password)' });
    }
  }

  // VBScript fallback: call BackupManager.StartBackup
  try {
    const vb = `
On Error Resume Next
Set obApp = CreateObject("hMailServer.Application")
obApp.Authenticate "Administrator", "${String(adminPassword).replace(/"/g,'""')}"
If Err.Number <> 0 Then
  WScript.StdErr.Write "AUTH_FAILED"
  WScript.Quit 1
End If
On Error Resume Next
Set bm = obApp.BackupManager
If Err.Number <> 0 Or IsNull(bm) Then
  WScript.StdErr.Write "BACKUPMANAGER_NOT_FOUND"
  WScript.Quit 2
End If
bm.StartBackup
If Err.Number <> 0 Then
  WScript.StdErr.Write "STARTBACKUP_FAILED"
  WScript.Quit 3
End If
WScript.Echo "OK"
`;
    const lines = await runVbScriptAndCollect(vb);
    if (lines.length && lines[0] === 'OK') return res.json({ success: true, info: 'Backup started' });
    return res.status(500).json({ error: 'VBScript did not report success' });
  } catch (e) {
    console.error('admin/backup (vbs) error', e && (e.message || e));
    return res.status(500).json({ error: 'Failed to start backup (cscript fallback failed): ' + (e && e.message) });
  }
});
