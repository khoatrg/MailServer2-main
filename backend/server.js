const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const https = require('https');
const rateLimit = require('express-rate-limit');

const chatLimiter = rateLimit({
  windowMs: 30*1000,
  max: 6,
  message: { error: 'Too many chat/context requests, try later.' }
});
dotenv.config();

const { listMessages, fetchMessage, sendMail, listAllMessages, searchMessagesByFrom, listMessagesFromBox, saveDraft, deleteMessage, getRawMessage, getAttachment, moveToTrash } = require('./mailService');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // Increase limit for attachments
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB max

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

// ---------- Postgres Pool ----------
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.PGHOST || undefined,
  user: process.env.PGUSER || undefined,
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE || undefined,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  ssl: (process.env.PGSSL === 'true') ? { rejectUnauthorized: false } : false,
});

// ========== DATABASE TABLES SETUP ==========
(async function ensureTables() {
  try {
    // Sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        jti TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        password TEXT NOT NULL,
        exp BIGINT NOT NULL
      );
    `);

    // User settings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        email TEXT PRIMARY KEY,
        out_of_office BOOLEAN DEFAULT FALSE,
        out_of_office_reply TEXT DEFAULT '',
        theme TEXT DEFAULT 'system',
        app_lock BOOLEAN DEFAULT FALSE
      );
    `);

    // NEW: Scheduled emails table (with attachments support)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scheduled_emails (
        id TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        user_password TEXT NOT NULL,
        send_at TIMESTAMPTZ NOT NULL,
        mail_to TEXT NOT NULL,
        mail_subject TEXT DEFAULT '',
        mail_text TEXT DEFAULT '',
        mail_html TEXT DEFAULT '',
        attachments JSONB DEFAULT '[]',
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        error_message TEXT DEFAULT NULL,
        retry_count INTEGER DEFAULT 0
      );
    `);

    // Index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_emails_send_at 
      ON scheduled_emails(send_at) 
      WHERE status = 'pending';
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_emails_user 
      ON scheduled_emails(user_email);
    `);

    console.log('[DB] All tables ensured');
  } catch (err) {
    console.error('Could not ensure tables:', err && err.stack || err);
  }
})();

// ========== SCHEDULED EMAILS - DATABASE BACKED ==========

// Process scheduled emails (runs every 30 seconds)
async function processScheduledEmails() {
  try {
    const now = new Date();
    
    // Get all pending jobs that are due
    const result = await pool.query(`
      SELECT * FROM scheduled_emails 
      WHERE status = 'pending' AND send_at <= $1
      ORDER BY send_at ASC
      LIMIT 10
    `, [now]);

    if (!result.rows || result.rows.length === 0) return;

    console.log(`[Scheduler] Processing ${result.rows.length} scheduled email(s)`);

    for (const job of result.rows) {
      try {
        console.log(`[Scheduler] Sending job id=${job.id} to=${job.mail_to}`);

        // Parse attachments from JSONB
        let attachments = [];
        if (job.attachments) {
          try {
            const parsed = typeof job.attachments === 'string' 
              ? JSON.parse(job.attachments) 
              : job.attachments;
            
            // Convert base64 back to Buffer
            attachments = parsed.map(a => ({
              filename: a.filename,
              content: Buffer.from(a.content, 'base64'),
              contentType: a.contentType
            }));
          } catch (e) {
            console.warn(`[Scheduler] Failed to parse attachments for job ${job.id}:`, e.message);
          }
        }

        // Send the email
        await sendMail(job.user_email, job.user_password, {
          from: job.user_email,
          to: job.mail_to,
          subject: job.mail_subject || '',
          text: job.mail_text || '',
          html: job.mail_html || '',
          attachments
        });

        // Mark as sent
        await pool.query(`
          UPDATE scheduled_emails 
          SET status = 'sent', error_message = NULL 
          WHERE id = $1
        `, [job.id]);

        console.log(`[Scheduler] Successfully sent job id=${job.id}`);

      } catch (err) {
        console.error(`[Scheduler] Failed job id=${job.id}:`, err && (err.message || err));

        // Update retry count and error message
        const newRetryCount = (job.retry_count || 0) + 1;
        const maxRetries = 3;

        if (newRetryCount >= maxRetries) {
          // Mark as failed after max retries
          await pool.query(`
            UPDATE scheduled_emails 
            SET status = 'failed', error_message = $1, retry_count = $2 
            WHERE id = $3
          `, [err.message || 'Unknown error', newRetryCount, job.id]);
        } else {
          // Keep pending for retry
          await pool.query(`
            UPDATE scheduled_emails 
            SET error_message = $1, retry_count = $2 
            WHERE id = $3
          `, [err.message || 'Unknown error', newRetryCount, job.id]);
        }
      }
    }
  } catch (err) {
    console.error('[Scheduler] processScheduledEmails error:', err && (err.message || err));
  }
}

// Run scheduler every 30 seconds
setInterval(() => {
  processScheduledEmails().catch(e => console.error('[Scheduler] Error:', e));
}, 30 * 1000);

// Initial run on startup
setTimeout(() => {
  processScheduledEmails().catch(e => console.error('[Scheduler] Initial run error:', e));
}, 5000);

console.log('[Scheduler] Scheduled email processor started (every 30s)');

// ========== AUTO-PURGE TRASH - BACKGROUND JOB ==========

// Purge trash for all users (runs every hour)
async function purgeAllUsersTrash() {
  try {
    console.log('[Trash Purge] Starting auto-purge for all users...');

    // Get all unique users from sessions (active users)
    const sessionsResult = await pool.query(`
      SELECT DISTINCT email, password FROM sessions 
      WHERE exp > $1
    `, [Date.now()]);

    if (!sessionsResult.rows || sessionsResult.rows.length === 0) {
      console.log('[Trash Purge] No active sessions found');
      return;
    }

    const TRASH_RETENTION_DAYS = parseInt(process.env.TRASH_RETENTION_DAYS || '30', 10);
    const retentionMs = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();

    let totalPurged = 0;

    for (const user of sessionsResult.rows) {
      try {
        // Find trash folder for this user
        const possibleTrashFolders = ["Trash", "Deleted Items", "Deleted", "Bin", "INBOX.Trash", "INBOX.Deleted", "TRASH"];
        
        let trashMessages = [];
        let foundFolder = null;

        for (const folder of possibleTrashFolders) {
          try {
            trashMessages = await listMessagesFromBox(user.email, user.password, folder);
            foundFolder = folder;
            break;
          } catch (e) {
            // folder doesn't exist, try next
          }
        }

        if (!foundFolder || !trashMessages.length) continue;

        // Purge messages older than retention period
        for (const msg of trashMessages) {
          try {
            const movedAt = msg.xMovedAt || msg['x-moved-at'] || null;
            
            if (!movedAt) continue; // Skip if no move timestamp

            const movedDate = new Date(movedAt);
            if (isNaN(movedDate.getTime())) continue;

            if (now - movedDate.getTime() > retentionMs) {
              await deleteMessage(user.email, user.password, msg.mailbox || foundFolder, msg.uid);
              totalPurged++;
              console.log(`[Trash Purge] Deleted message uid=${msg.uid} for user=${user.email} (moved ${TRASH_RETENTION_DAYS}+ days ago)`);
            }
          } catch (e) {
            // Ignore per-message errors
          }
        }
      } catch (e) {
        console.warn(`[Trash Purge] Error processing user ${user.email}:`, e && (e.message || e));
      }
    }

    console.log(`[Trash Purge] Completed. Total messages purged: ${totalPurged}`);
  } catch (err) {
    console.error('[Trash Purge] Error:', err && (err.message || err));
  }
}

// Run trash purge every hour
const PURGE_INTERVAL_HOURS = parseInt(process.env.PURGE_INTERVAL_HOURS || '1', 10);
setInterval(() => {
  purgeAllUsersTrash().catch(e => console.error('[Trash Purge] Error:', e));
}, PURGE_INTERVAL_HOURS * 60 * 60 * 1000);

// Initial run after 1 minute (give server time to start)
setTimeout(() => {
  purgeAllUsersTrash().catch(e => console.error('[Trash Purge] Initial run error:', e));
}, 60 * 1000);

console.log(`[Trash Purge] Auto-purge started (every ${PURGE_INTERVAL_HOURS}h, retention: ${process.env.TRASH_RETENTION_DAYS || 30} days)`);

// ========== CLEANUP EXPIRED SESSIONS ==========

async function cleanupExpiredSessions() {
  try {
    const now = Date.now();
    const r = await pool.query('DELETE FROM sessions WHERE exp <= $1 RETURNING jti', [now]);
    if (r && r.rowCount) {
      console.log(`[Sessions] Cleaned up ${r.rowCount} expired sessions`);
    }
  } catch (err) {
    console.warn('cleanupExpiredSessions failed', err && (err.message || err));
  }
}

// Cleanup sessions hourly
setInterval(() => { cleanupExpiredSessions().catch(e => console.error(e)); }, 60 * 60 * 1000);
cleanupExpiredSessions().catch(e => console.error('Initial cleanupExpiredSessions failed', e && e.message));

// ========== SESSION HELPERS ==========

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

async function createSessionRow(jti, email, password, expMsTimestamp) {
  try {
    await pool.query('DELETE FROM sessions WHERE email = $1', [email]);
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

async function createToken(email, password) {
  const jti = 'sess_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
  const token = jwt.sign({ email, jti }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  const expiryMs = parseExpiryToMs(JWT_EXPIRES) || (8 * 60 * 60 * 1000);
  const expTs = Date.now() + expiryMs;
  await createSessionRow(jti, email, password, expTs);
  return token;
}

// ========== AUTH MIDDLEWARE ==========

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { clockTolerance: 5 });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  req.tokenPayload = payload;

  const jti = payload && payload.jti;
  const email = payload && payload.email;
  if (!jti || !email) return res.status(401).json({ error: 'Invalid token payload' });

  const sess = await getSessionRow(jti);
  if (!sess || sess.email !== email) {
    return res.status(401).json({ error: 'Session not found or expired' });
  }
  if (sess.exp && Date.now() >= Number(sess.exp)) {
    await deleteSessionRow(jti);
    return res.status(401).json({ error: 'Session expired' });
  }

  req.user = { email: sess.email, password: sess.password, jti };
  next();
}

// ========== hMailServer COM Helpers ==========
let ActiveXObject = null;
try {
  ActiveXObject = require('winax').ActiveXObject;
} catch (e) {
  ActiveXObject = null;
  console.warn('winax require failed or not available:', e && (e.message || e));
}

async function runVbScriptAndCollect(adminScript) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const fn = path.join(tmpDir, `hmail_admin_${Date.now()}.vbs`);
    try {
      fs.writeFileSync(fn, adminScript, 'utf8');
    } catch (e) {
      return reject(new Error('Failed to write temp vbs: ' + (e && e.message)));
    }
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

async function ensureAdminPermission(req, res) {
  try {
    const email = req.user && req.user.email;
    if (!email) {
      res.status(403).json({ error: 'Forbidden: admin required' });
      return false;
    }
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

// ========== USER SETTINGS ==========

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

    // Sync Out of Office to hMailServer
    try {
      await pool.query(
        `UPDATE hm_accounts 
         SET accountvacationmessageon = $1,
             accountvacationmessage = $2
         WHERE LOWER(accountaddress) = LOWER($3)`,
        [outOfOffice ? 1 : 0, outOfOfficeReply || '', email]
      );
    } catch (hmErr) {
      console.warn('Failed to sync out-of-office to hm_accounts:', hmErr && (hmErr.message || hmErr));
    }
  } catch (err) {
    console.warn('upsertUserSettings failed', err && (err.message || err));
    throw err;
  }
}

// ========== API ENDPOINTS ==========

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
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

// POST /api/logout
app.post('/api/logout', authMiddleware, async (req, res) => {
  try {
    const jti = req.user && req.user.jti;
    if (jti) await deleteSessionRow(jti);
    return res.json({ success: true });
  } catch (err) {
    console.error('POST /api/logout failed', err && (err.stack || err));
    return res.status(500).json({ error: 'Failed to logout' });
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
  let mailbox = req.query.mailbox || req.query.box || 'INBOX';
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

// GET /api/me
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const local = (email || '').split('@')[0] || '';
    const displayName = local
      .replace(/[._]/g, ' ')
      .split(/\s+/)
      .map(p => p ? (p[0].toUpperCase() + p.slice(1)) : '')
      .join(' ')
      || email;

    let total = 0, unread = 0;
    try {
      const msgs = await listMessages(req.user.email, req.user.password);
      total = (msgs && msgs.length) || 0;
      unread = (msgs && msgs.filter(m => !m.seen).length) || 0;
    } catch (e) {
      console.warn('Could not fetch inbox stats for', email, e.message || e);
    }

    let adminLevel = 0;
    try {
      const r = await pool.query('SELECT accountadminlevel FROM hm_accounts WHERE accountaddress = $1 LIMIT 1', [email]);
      if (r.rows && r.rows[0]) adminLevel = Number(r.rows[0].accountadminlevel || 0);
    } catch (e) {
      console.warn('Could not read accountadminlevel for', email, e && (e.message || e));
    }

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

// GET /api/messages/sent
app.get('/api/messages/sent', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const password = req.user.password;
    const possibleSentFolders = ["Sent", "Sent Items", "SENT", "Sent Mail"];

    let messages = [];
    let foundFolder = null;

    for (const folder of possibleSentFolders) {
      try {
        messages = await listMessagesFromBox(email, password, folder);
        foundFolder = folder;
        break;
      } catch (err) {}
    }

    if (!foundFolder) {
      return res.json({ messages: [], info: "No Sent folder found" });
    }

    res.json({ folder: foundFolder, messages });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list sent messages' });
  }
});

// GET /api/messages/drafts
app.get('/api/messages/drafts', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const password = req.user.password;
    const possibleDraftFolders = ["Drafts", "Draft", "DRAFT", "Draft Items", "INBOX.Drafts", "INBOX.DRAFT", "INBOX.DRAFTS"];

    let messages = [];
    let foundFolder = null;

    for (const folder of possibleDraftFolders) {
      try {
        messages = await listMessagesFromBox(email, password, folder);
        if (messages && messages.length) {
          foundFolder = folder;
          break;
        }
      } catch (err) {}
    }

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
      }
    }

    if (!foundFolder && (!messages || messages.length === 0)) {
      return res.json({ messages: [], info: "No Drafts folder or draft-flagged messages found" });
    }

    res.json({ folder: foundFolder || 'unknown', messages });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list draft messages' });
  }
});

// POST /api/send
app.post('/api/send', authMiddleware, upload.array('attachments'), async (req, res) => {
  try {
    const body = req.body || {};
    const to = body.to || '';
    const subject = body.subject || '';
    const text = body.text || '';
    const html = body.html || '';
    const from = body.from || req.user.email;
    if (!to || !subject || !(text || html)) return res.status(400).json({ error: 'to, subject, and text/html required' });

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

// GET /api/message/:uid/attachment/:idx
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

// POST /api/draft
app.post('/api/draft', authMiddleware, async (req, res) => {
  try {
    const { to, subject, text, html, from } = req.body || {};
    if (!to && !subject && !(text || html)) return res.status(400).json({ error: 'to, subject, or body required to save draft' });
    const mailOptions = { from: from || req.user.email, to: to || '', subject: subject || '', text: text || '', html: html || '' };
    await saveDraft(req.user.email, req.user.password, mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/draft error for', req.user && req.user.email, err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to save draft' });
  }
});

// POST /api/draft/delete
app.post('/api/draft/delete', authMiddleware, async (req, res) => {
  try {
    const { mailbox, uid } = req.body || {};
    if (!uid) return res.status(400).json({ error: 'uid required' });
    await deleteMessage(req.user.email, req.user.password, mailbox || 'Drafts', uid);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/draft/delete error for', req.user && req.user.email, err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to delete draft' });
  }
});

// GET /api/messages/trash (NO MORE AUTO-PURGE HERE - moved to background job)
app.get('/api/messages/trash', authMiddleware, async (req, res) => {
  try {
    const possibleTrashFolders = ["Trash", "Deleted Items", "Deleted", "Bin", "INBOX.Trash", "INBOX.Deleted", "TRASH"];

    let messages = [];
    let foundFolder = null;
    for (const folder of possibleTrashFolders) {
      try {
        const msgs = await listMessagesFromBox(req.user.email, req.user.password, folder);
        foundFolder = folder;
        messages = msgs;
        break;
      } catch (err) {}
    }

    if (!foundFolder) return res.json({ messages: [], info: 'No Trash folder found' });

    res.json({ folder: foundFolder, messages });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list trash' });
  }
});

// POST /api/message/:uid/move-to-trash
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

// POST /api/message/:uid/delete-permanent
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

// POST /api/message/:uid/restore
app.post('/api/message/:uid/restore', authMiddleware, async (req, res) => {
  let uidParam = req.params.uid || '';
  let mailbox = req.query.mailbox || req.query.box || 'Trash';
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

// ========== SCHEDULED EMAILS API (DATABASE-BACKED) ==========

// POST /api/schedule - Create scheduled email (with attachments support)
app.post('/api/schedule', authMiddleware, upload.array('attachments'), async (req, res) => {
  try {
    const { to, subject, text, html, sendAt } = req.body || {};
    if (!to || !(text || html) || !sendAt) {
      return res.status(400).json({ error: 'to, body and sendAt required' });
    }
    
    const ts = Date.parse(sendAt);
    if (isNaN(ts) || ts <= Date.now()) {
      return res.status(400).json({ error: 'sendAt must be a future datetime' });
    }

    const id = 'sched_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    
    // Convert attachments to base64 for JSON storage
    const files = req.files || [];
    const attachmentsJson = files.map(f => ({
      filename: f.originalname,
      content: f.buffer.toString('base64'),
      contentType: f.mimetype
    }));

    await pool.query(`
      INSERT INTO scheduled_emails 
      (id, user_email, user_password, send_at, mail_to, mail_subject, mail_text, mail_html, attachments, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
    `, [
      id,
      req.user.email,
      req.user.password,
      new Date(ts).toISOString(),
      to,
      subject || '',
      text || '',
      html || '',
      JSON.stringify(attachmentsJson)
    ]);

    console.log(`[Schedule] Created job id=${id} for user=${req.user.email} sendAt=${new Date(ts).toISOString()} attachments=${files.length}`);

    return res.json({ 
      success: true, 
      id,
      sendAt: new Date(ts).toISOString(),
      attachments: files.length
    });
  } catch (err) {
    console.error('POST /api/schedule error', err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to schedule' });
  }
});

// GET /api/schedule - List user's scheduled emails
app.get('/api/schedule', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, send_at, mail_to, mail_subject, status, created_at, error_message, 
             attachments::text as attachments_raw
      FROM scheduled_emails 
      WHERE user_email = $1 
      ORDER BY send_at ASC
    `, [req.user.email]);

    const jobs = result.rows.map(row => {
      let attachmentCount = 0;
      try {
        const attachments = row.attachments_raw ? JSON.parse(row.attachments_raw) : [];
        attachmentCount = attachments.length;
      } catch (e) {}

      return {
        id: row.id,
        sendAt: row.send_at,
        to: row.mail_to,
        subject: row.mail_subject,
        status: row.status,
        createdAt: row.created_at,
        error: row.error_message,
        attachments: attachmentCount
      };
    });

    res.json({ jobs });
  } catch (err) {
    console.error('GET /api/schedule error', err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to list scheduled jobs' });
  }
});

// DELETE /api/schedule/:id - Cancel a scheduled email
app.delete('/api/schedule/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    
    const result = await pool.query(`
      DELETE FROM scheduled_emails 
      WHERE id = $1 AND user_email = $2 AND status = 'pending'
      RETURNING id
    `, [id, req.user.email]);

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found or already sent' });
    }

    console.log(`[Schedule] Cancelled job id=${id} for user=${req.user.email}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/schedule/:id error', err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to cancel scheduled job' });
  }
});

// GET /api/settings
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

// POST /api/settings
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

// ========== ADMIN ENDPOINTS ==========
// (Keep all existing admin endpoints - POST /api/admin/hmail-auth, /api/admin/accounts, etc.)
// ... [giữ nguyên tất cả admin endpoints từ file gốc]

// POST /api/admin/hmail-auth
app.post('/api/admin/hmail-auth', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  const { adminPassword } = req.body || {};
  if (!adminPassword) return res.status(400).json({ error: 'adminPassword required' });
  if (!ActiveXObject) return res.status(500).json({ error: 'Server does not support COM (winax not installed or not Windows)' });

  try {
    const obApp = new ActiveXObject('hMailServer.Application');
    obApp.Authenticate('Administrator', adminPassword);
    return res.json({ success: true });
  } catch (err) {
    console.warn('hmail auth failed', err && (err.message || err));
    return res.status(401).json({ error: 'hMailServer authentication failed' });
  }
});

// POST /api/admin/accounts
app.post('/api/admin/accounts', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  const { adminPassword } = req.body || {};
  if (!adminPassword) return res.status(400).json({ error: 'adminPassword required' });

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

  // VBScript fallback
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

// GET /api/admin/sessions
app.get('/api/admin/sessions', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  try {
    const r = await pool.query('SELECT jti, email, exp FROM sessions ORDER BY exp DESC');
    const rows = (r.rows || []).map(row => ({
      jti: row.jti,
      email: row.email,
    }));
    res.json({ success: true, sessions: rows });
  } catch (err) {
    console.error('admin/sessions error', err && (err.stack || err));
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// DELETE /api/admin/sessions/:jti
app.delete('/api/admin/sessions/:jti', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  const jti = req.params.jti;
  if (!jti) return res.status(400).json({ error: 'jti required' });
  try {
    await deleteSessionRow(jti);
    return res.json({ success: true });
  } catch (err) {
    console.error('admin/delete-session error', err && (err.stack || err));
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// POST /api/chat/context
app.post('/api/chat/context', authMiddleware, chatLimiter, async (req, res) => {
  try {
    const email = req.user.email;
    const password = req.user.password;
    const mailbox = req.body.mailbox || 'INBOX';
    const limit = Math.min(Number(req.body.limit) || 20, 100);
    const includeBodies = !!req.body.includeBodies;
    const maxChars = Math.min(Number(req.body.maxChars) || 1000, 5000);

    const msgs = await listMessagesFromBox(email, password, mailbox);
    const recent = (msgs || []).sort((a,b) => {
      const da = Date.parse(a.date || 0), db = Date.parse(b.date || 0);
      return db - da;
    }).slice(0, limit);

    const out = [];
    for (const m of recent) {
      const item = {
        uid: m.uid,
        mailbox: m.mailbox || mailbox,
        from: m.from,
        to: m.to,
        subject: m.subject,
        date: m.date,
        snippet: (m.subject || '') + ' — ' + ((m.from || '') + '')
      };
      if (includeBodies) {
        try {
          const full = await fetchMessage(email, password, String(m.uid), m.mailbox || mailbox);
          const bodyText = (full && (full.text || full.html || '')) || '';
          item.body = bodyText.length > maxChars ? (bodyText.slice(0, maxChars) + '...') : bodyText;
        } catch (e) {
          item.body = '';
        }
      }
      out.push(item);
    }
    return res.json({ success: true, mailbox, messages: out });
  } catch (err) {
    console.error('/api/chat/context error', err && (err.stack || err));
    return res.status(500).json({ error: 'Failed to load mailbox context' });
  }
});

// GET /api/chat/message/:uid
app.get('/api/chat/message/:uid', authMiddleware, chatLimiter, async (req, res) => {
  try {
    const uid = req.params.uid;
    const mailbox = req.query.mailbox || 'INBOX';
    if (!uid) return res.status(400).json({ error: 'uid required' });
    const email = req.user.email;
    const password = req.user.password;
    const msg = await fetchMessage(email, password, String(uid), mailbox);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    return res.json({ success: true, message: msg });
  } catch (err) {
    console.error('/api/chat/message/:uid error', err && (err.stack || err));
    return res.status(500).json({ error: 'Failed to fetch message' });
  }
});

// POST /api/admin/account/:email/messages - Get messages for a specific account (admin)
app.post('/api/admin/account/:email/messages', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  
  const targetEmail = decodeURIComponent(req.params.email);
  const { adminPassword } = req.body || {};
  
  if (!adminPassword) {
    return res.status(400).json({ error: 'adminPassword required' });
  }
  if (!targetEmail) {
    return res.status(400).json({ error: 'email parameter required' });
  }

  // Verify admin password with hMailServer first
  if (ActiveXObject) {
    try {
      const obApp = new ActiveXObject('hMailServer.Application');
      obApp.Authenticate('Administrator', adminPassword);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid hMailServer admin password' });
    }
  } else {
    // VBScript fallback to verify admin password
    try {
      const vbAuth = `
On Error Resume Next
Set obApp = CreateObject("hMailServer.Application")
obApp.Authenticate "Administrator", "${String(adminPassword).replace(/"/g,'""')}"
If Err.Number <> 0 Then
  WScript.StdErr.Write "AUTH_FAILED"
  WScript.Quit 1
End If
WScript.Echo "OK"
`;
      await runVbScriptAndCollect(vbAuth);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid hMailServer admin password' });
    }
  }

  // Now get the account's password from hm_accounts to fetch messages via IMAP
  try {
    // Try to get password from hm_accounts (hashed, won't work for IMAP)
    // Alternative: Use COM to get messages directly
    
    if (ActiveXObject) {
      try {
        const obApp = new ActiveXObject('hMailServer.Application');
        obApp.Authenticate('Administrator', adminPassword);
        
        const messages = [];
        const domains = obApp.Domains;
        
        for (let i = 0; i < domains.Count; i++) {
          const dom = domains.Item(i);
          const accounts = dom.Accounts;
          
          for (let j = 0; j < accounts.Count; j++) {
            const acc = accounts.Item(j);
            
            if (acc.Address.toLowerCase() === targetEmail.toLowerCase()) {
              // Found the account, now get messages from its IMAPFolders
              const imapFolders = acc.IMAPFolders;
              
              for (let f = 0; f < imapFolders.Count; f++) {
                const folder = imapFolders.Item(f);
                const folderMessages = folder.Messages;
                
                for (let m = 0; m < Math.min(folderMessages.Count, 100); m++) {
                  try {
                    const msg = folderMessages.Item(m);
                    messages.push({
                      id: msg.ID,
                      folder: folder.Name,
                      from: msg.FromAddress || '',
                      to: msg.To || '',
                      subject: msg.Subject || '(no subject)',
                      date: msg.InternalDate ? new Date(msg.InternalDate).toISOString() : '',
                      size: msg.Size || 0
                    });
                  } catch (msgErr) {
                    // Skip individual message errors
                  }
                }
              }
              break;
            }
          }
        }
        
        return res.json({ success: true, messages });
      } catch (comErr) {
        console.error('admin/account/messages COM error:', comErr && (comErr.message || comErr));
        return res.status(500).json({ error: 'Failed to fetch messages via COM: ' + (comErr.message || comErr) });
      }
    }
    
    // VBScript fallback
    try {
      const vbMessages = `
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
    Set acc = accounts.Item(j)
    If LCase(acc.Address) = LCase("${targetEmail.replace(/"/g,'""')}") Then
      Set imapFolders = acc.IMAPFolders
      For f = 0 To imapFolders.Count - 1
        Set folder = imapFolders.Item(f)
        Set msgs = folder.Messages
        msgCount = msgs.Count
        If msgCount > 100 Then msgCount = 100
        For m = 0 To msgCount - 1
          On Error Resume Next
          Set msg = msgs.Item(m)
          If Err.Number = 0 Then
            WScript.Echo msg.ID & "|" & folder.Name & "|" & msg.FromAddress & "|" & msg.Subject & "|" & msg.Size
          End If
          Err.Clear
        Next
      Next
      Exit For
    End If
  Next
Next
`;
      const lines = await runVbScriptAndCollect(vbMessages);
      const messages = lines.map(l => {
        const parts = l.split('|');
        return {
          id: parts[0] || '',
          folder: parts[1] || '',
          from: parts[2] || '',
          subject: parts[3] || '(no subject)',
          size: parseInt(parts[4] || '0', 10) || 0
        };
      });
      
      return res.json({ success: true, messages });
    } catch (vbErr) {
      console.error('admin/account/messages VBS error:', vbErr && (vbErr.message || vbErr));
      return res.status(500).json({ error: 'Failed to fetch messages: ' + (vbErr.message || vbErr) });
    }
  } catch (err) {
    console.error('admin/account/messages error:', err && (err.stack || err));
    return res.status(500).json({ error: err.message || 'Failed to get account messages' });
  }
});

// POST /api/admin/account/:address/password - Change account password
app.post('/api/admin/account/:address/password', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  
  const address = decodeURIComponent(req.params.address);
  const { adminPassword, newPassword } = req.body || {};
  
  if (!adminPassword || !newPassword) {
    return res.status(400).json({ error: 'adminPassword and newPassword required' });
  }

  if (ActiveXObject) {
    try {
      const obApp = new ActiveXObject('hMailServer.Application');
      obApp.Authenticate('Administrator', adminPassword);
      
      const domains = obApp.Domains;
      for (let i = 0; i < domains.Count; i++) {
        const dom = domains.Item(i);
        const accounts = dom.Accounts;
        for (let j = 0; j < accounts.Count; j++) {
          const acc = accounts.Item(j);
          if (acc.Address.toLowerCase() === address.toLowerCase()) {
            acc.Password = newPassword;
            acc.Save();
            return res.json({ success: true });
          }
        }
      }
      return res.status(404).json({ error: 'Account not found' });
    } catch (err) {
      console.error('admin/account/password COM error:', err && (err.message || err));
      return res.status(500).json({ error: 'Failed to change password: ' + (err.message || err) });
    }
  }

  // VBScript fallback
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
found = False
For i = 0 To domains.Count - 1
  Set dom = domains.Item(i)
  Set accounts = dom.Accounts
  For j = 0 To accounts.Count - 1
    Set acc = accounts.Item(j)
    If LCase(acc.Address) = LCase("${address.replace(/"/g,'""')}") Then
      acc.Password = "${String(newPassword).replace(/"/g,'""')}"
      acc.Save
      found = True
      WScript.Echo "OK"
      Exit For
    End If
  Next
  If found Then Exit For
Next
If Not found Then
  WScript.StdErr.Write "NOT_FOUND"
  WScript.Quit 1
End If
`;
    await runVbScriptAndCollect(vb);
    return res.json({ success: true });
  } catch (e) {
    console.error('admin/account/password VBS error:', e && (e.message || e));
    return res.status(500).json({ error: 'Failed to change password: ' + (e.message || e) });
  }
});

// POST /api/admin/account - Create new account
app.post('/api/admin/account', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  
  const { adminPassword, address, password, active, maxSize } = req.body || {};
  
  if (!adminPassword || !address || !password) {
    return res.status(400).json({ error: 'adminPassword, address and password required' });
  }

  const parts = address.split('@');
  if (parts.length !== 2) {
    return res.status(400).json({ error: 'Invalid email address format' });
  }
  const domainName = parts[1];

  if (ActiveXObject) {
    try {
      const obApp = new ActiveXObject('hMailServer.Application');
      obApp.Authenticate('Administrator', adminPassword);
      
      const domains = obApp.Domains;
      let targetDomain = null;
      for (let i = 0; i < domains.Count; i++) {
        const dom = domains.Item(i);
        if (dom.Name.toLowerCase() === domainName.toLowerCase()) {
          targetDomain = dom;
          break;
        }
      }
      
      if (!targetDomain) {
        return res.status(404).json({ error: `Domain ${domainName} not found in hMailServer` });
      }
      
      const newAccount = targetDomain.Accounts.Add();
      newAccount.Address = address;
      newAccount.Password = password;
      newAccount.Active = active !== false;
      newAccount.MaxSize = maxSize || 100;
      newAccount.Save();
      
      return res.json({ success: true, address });
    } catch (err) {
      console.error('admin/account create COM error:', err && (err.message || err));
      return res.status(500).json({ error: 'Failed to create account: ' + (err.message || err) });
    }
  }

  // VBScript fallback
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
found = False
For i = 0 To domains.Count - 1
  Set dom = domains.Item(i)
  If LCase(dom.Name) = LCase("${domainName.replace(/"/g,'""')}") Then
    Set newAcc = dom.Accounts.Add()
    newAcc.Address = "${address.replace(/"/g,'""')}"
    newAcc.Password = "${String(password).replace(/"/g,'""')}"
    newAcc.Active = ${active !== false ? 'True' : 'False'}
    newAcc.MaxSize = ${maxSize || 100}
    newAcc.Save
    If Err.Number <> 0 Then
      WScript.StdErr.Write Err.Description
      WScript.Quit 1
    End If
    found = True
    WScript.Echo "OK"
    Exit For
  End If
Next
If Not found Then
  WScript.StdErr.Write "DOMAIN_NOT_FOUND"
  WScript.Quit 1
End If
`;
    await runVbScriptAndCollect(vb);
    return res.json({ success: true, address });
  } catch (e) {
    console.error('admin/account create VBS error:', e && (e.message || e));
    return res.status(500).json({ error: 'Failed to create account: ' + (e.message || e) });
  }
});

// DELETE /api/admin/account/:email - Delete account
app.delete('/api/admin/account/:email', authMiddleware, async (req, res) => {
  if (!(await ensureAdminPermission(req, res))) return;
  
  const email = decodeURIComponent(req.params.email);
  const { adminPassword } = req.body || {};
  
  if (!adminPassword) {
    return res.status(400).json({ error: 'adminPassword required' });
  }

  if (ActiveXObject) {
    try {
      const obApp = new ActiveXObject('hMailServer.Application');
      obApp.Authenticate('Administrator', adminPassword);
      
      const domains = obApp.Domains;
      for (let i = 0; i < domains.Count; i++) {
        const dom = domains.Item(i);
        const accounts = dom.Accounts;
        for (let j = 0; j < accounts.Count; j++) {
          const acc = accounts.Item(j);
          if (acc.Address.toLowerCase() === email.toLowerCase()) {
            accounts.DeleteByDBID(acc.ID);
            return res.json({ success: true });
          }
        }
      }
      return res.status(404).json({ error: 'Account not found' });
    } catch (err) {
      console.error('admin/account delete COM error:', err && (err.message || err));
      return res.status(500).json({ error: 'Failed to delete account: ' + (err.message || err) });
    }
  }

  // VBScript fallback
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
found = False
For i = 0 To domains.Count - 1
  Set dom = domains.Item(i)
  Set accounts = dom.Accounts
  For j = 0 To accounts.Count - 1
    Set acc = accounts.Item(j)
    If LCase(acc.Address) = LCase("${email.replace(/"/g,'""')}") Then
      accID = acc.ID
      accounts.DeleteByDBID accID
      If Err.Number <> 0 Then
        WScript.StdErr.Write Err.Description
        WScript.Quit 1
      End If
      found = True
      WScript.Echo "OK"
      Exit For
    End If
  Next
  If found Then Exit For
Next
If Not found Then
  WScript.StdErr.Write "NOT_FOUND"
  WScript.Quit 1
End If
`;
    await runVbScriptAndCollect(vb);
    return res.json({ success: true });
  } catch (e) {
    console.error('admin/account delete VBS error:', e && (e.message || e));
    return res.status(500).json({ error: 'Failed to delete account: ' + (e.message || e) });
  }
});

// ========== SERVER START ==========

const port = process.env.PORT || 4000;
const SSL_KEY = process.env.SSL_KEY_PATH;
const SSL_CERT = process.env.SSL_CERT_PATH;

function startServer() {
  if (SSL_KEY && SSL_CERT && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
    const key = fs.readFileSync(SSL_KEY);
    const cert = fs.readFileSync(SSL_CERT);
    https.createServer({ key, cert }, app).listen(process.env.SSL_PORT || 443, () => {
      console.log('HTTPS server listening on', process.env.SSL_PORT || 443);
    });
  } else {
    app.listen(process.env.PORT || 4000, () => console.log('HTTP server listening on port', process.env.PORT || 4000));
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;