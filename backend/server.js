const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const { listMessages, fetchMessage, sendMail, listAllMessages, searchMessagesByFrom, listMessagesFromBox, saveDraft, deleteMessage } = require('./mailService');

const app = express();
app.use(cors());
app.use(bodyParser.json());

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

// POST /api/send { to, subject, text, html, from? }
app.post('/api/send', authMiddleware, async (req, res) => {
  const { to, subject, text, html, from } = req.body || {};
  if (!to || !subject || !(text || html)) return res.status(400).json({ error: 'to, subject, and text/html required' });
  const mailOptions = { from: from || req.user.email, to, subject, text, html };
  try {
    console.log(`Sending mail from=${req.user.email} to=${to} subject=${subject}`);
    const info = await sendMail(req.user.email, req.user.password, mailOptions);
    res.json({ success: true, info });
  } catch (err) {
    // log full error to server console for diagnosis (but do not echo password to client)
    console.error('POST /api/send error for', req.user && req.user.email, err && (err.stack || err));
    res.status(500).json({ error: err.message || 'Failed to send message' });
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

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Mail backend listening on ${port}`));
