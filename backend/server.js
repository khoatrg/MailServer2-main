const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
dotenv.config();

const { listMessages, fetchMessage, sendMail, listAllMessages, searchMessagesByFrom, listMessagesFromBox, saveDraft, deleteMessage, getRawMessage, getAttachment, moveToTrash } = require('./mailService');

const app = express();
app.use(cors());
app.use(bodyParser.json());
const upload = multer({ storage: multer.memoryStorage() });

/* --- scheduled jobs persistence (must be defined before endpoints) --- */
const fs = require('fs');
const path = require('path');
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

function createToken(email, password) {
  // Prototype: token contains password - do NOT use in production
  return jwt.sign({ email, password }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

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
        password,
        host: process.env.IMAP_HOST || 'localhost',
        port: parseInt(process.env.IMAP_PORT || '143', 10),
        tls: (process.env.IMAP_TLS === 'true')
      }
    }).then(conn => conn.end());
    const token = createToken(email, password);
    return res.json({ token });
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

// GET /api/me -> return basic account info + inbox stats
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    // derive a friendly display name from local part (john.doe -> John Doe)
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
      // if IMAP fails, return counts as 0 but still return account info
      console.warn('Could not fetch inbox stats for', email, e.message || e);
    }

    res.json({ email, displayName, inbox: { total, unread } });
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

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Mail backend listening on ${port}`));
