const ImapClient = require('imap-simple');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const dotenv = require('dotenv');
const MailComposer = require('nodemailer/lib/mail-composer');
dotenv.config();

const imapConfigBase = (user, password) => ({
  imap: {
    user,
    password,
    host: process.env.IMAP_HOST || 'localhost',
    port: parseInt(process.env.IMAP_PORT || '143', 10),
    tls: (process.env.IMAP_TLS === 'true'),
    authTimeout: 10000
  }
});

async function connectImap(user, password) {
  const cfg = imapConfigBase(user, password);
  return ImapClient.connect(cfg);
}

async function listMessages(user, password) {
  const client = await connectImap(user, password);
  try {
    await client.openBox('INBOX');
    const searchCriteria = ['ALL']; // use ['UNSEEN'] to get only unread
    const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], struct: true };
    const results = await client.search(searchCriteria, fetchOptions);
    return results.map(item => {
      const header = item.parts.find(p => p.which && p.which.startsWith('HEADER')) || { body: {} };
      const uid = item.attributes && item.attributes.uid;
      const flags = (item.attributes && item.attributes.flags) || [];
      // flags can include '\Seen', '\Draft', etc.
      const seen = flags.map(f => String(f).toLowerCase()).includes('\\seen') || flags.map(f => String(f).toLowerCase()).includes('seen');
      return {
        uid,
        from: header.body.from && header.body.from[0],
        to: header.body.to && header.body.to[0],
        subject: header.body.subject && header.body.subject[0],
        date: header.body.date && header.body.date[0],
        seen,   // existing
        flags   // raw flags array (new)
      };
    });
  } finally {
    client.end();
  }
}

async function fetchMessage(user, password, uid, mailbox = 'INBOX') {
  const client = await connectImap(user, password);
  try {
    await client.openBox(mailbox);
    const fetchOptions = { bodies: [''], markSeen: true };
    const results = await client.search([['UID', uid]], fetchOptions);
    if (!results || results.length === 0) return null;
    const raw = results[0].parts[0].body;
    const parsed = await simpleParser(raw);
    return {
      uid,
      mailbox, // include mailbox in returned object (helpful for clients)
      from: parsed.from && parsed.from.text,
      to: parsed.to && parsed.to.text,
      subject: parsed.subject,
      date: parsed.date,
      text: parsed.text,
      html: parsed.html,
      attachments: (parsed.attachments || []).map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size }))
    };
  } finally {
    client.end();
  }
}

// new: retrieve a single attachment (by index) for a message (returns { filename, contentType, size, content: Buffer })
async function getAttachment(user, password, uid, mailbox = 'INBOX', index = 0) {
  const client = await connectImap(user, password);
  try {
    await client.openBox(mailbox);
    const fetchOptions = { bodies: [''], markSeen: false };
    const results = await client.search([['UID', uid]], fetchOptions);
    if (!results || results.length === 0) return null;
    const raw = results[0].parts[0].body;
    const parsed = await simpleParser(raw);
    const attach = (parsed.attachments || [])[index];
    if (!attach) return null;
    return {
      filename: attach.filename || ('attachment-' + index),
      contentType: attach.contentType || 'application/octet-stream',
      size: attach.size || (attach.content ? attach.content.length : 0),
      content: attach.content // Buffer
    };
  } finally {
    client.end();
  }
}

async function saveToSentFolder(user, password, rawMessage) {
  const client = await connectImap(user, password);
  try {
    // Try a few common Sent mailbox names and ensure we open writable (openBox(mailbox, false))
    const possibleSentFolders = ["Sent", "Sent Items", "SENT", "Sent Mail", "INBOX.Sent"];
    let opened = false;
    for (const folder of possibleSentFolders) {
      try {
        await client.openBox(folder, false); // open writable
        // success
        opened = folder;
        break;
      } catch (err) {
        // try next
      }
    }

    // If none opened, try to create the first candidate
    if (!opened) {
      const target = possibleSentFolders[0];
      try {
        // try addBox to create the folder (imap-simple exposes underlying imap client)
        if (client.imap && typeof client.imap.addBox === 'function') {
          await new Promise((resolve, reject) => client.imap.addBox(target, (err) => err ? reject(err) : resolve()));
          await client.openBox(target, false);
          opened = target;
        }
      } catch (e) {
        // can't create mailbox — log and bail out gracefully
        console.warn('saveToSentFolder: could not create Sent folder', e && (e.message || e));
      }
    }

    if (!opened) {
      // nothing we can do — return silently
      console.warn('saveToSentFolder: no writable Sent folder found, skipping saving message');
      return;
    }

    if (!rawMessage) {
      console.warn('saveToSentFolder: no raw message provided, skipping append');
      return;
    }

    // Append the raw RFC822 message into the opened Sent mailbox.
    // Prefer the underlying node-imap append (client.imap.append), fall back to client.append if present.
    await new Promise((resolve, reject) => {
      try {
        const appendFn = (client.imap && typeof client.imap.append === 'function')
          ? client.imap.append.bind(client.imap)
          : (typeof client.append === 'function')
            ? client.append.bind(client)
            : null;
        if (!appendFn) return reject(new Error('saveToSentFolder: no append function available on IMAP client'));
        appendFn(rawMessage, { mailbox: opened }, (err) => err ? reject(err) : resolve());
      } catch (err) {
        reject(err);
      }
    });

  } finally {
    client.end();
  }
}

async function sendMail(user, password, mailOptions) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT || '25', 10),
    secure: (process.env.SMTP_SECURE === 'true'),
    auth: { user, pass: password },
    tls: { rejectUnauthorized: false }
  });

  // Verify transporter connectivity — helpful to surface auth/connection issues early.
  try {
    await new Promise((resolve, reject) => {
      transporter.verify((err, success) => err ? reject(err) : resolve(success));
    });
    console.log('sendMail: transporter verified for', user);
  } catch (err) {
    console.warn('sendMail: transporter.verify failed for', user, err && (err.message || err));
    // continue to let sendMail surface the actual error if any
  }

  let info;
  try {
    info = await transporter.sendMail(mailOptions);
    // Log a concise summary of the send operation
    console.log('sendMail: sent', {
      user,
      messageId: info && info.messageId,
      accepted: info && info.accepted,
      rejected: info && info.rejected,
      response: info && info.response
    });
  } catch (err) {
    console.error('sendMail: transporter.sendMail error for', user, err && (err.stack || err.message || err));
    throw err; // rethrow so caller (server) can report the error
  }

  // Save to Sent folder — best-effort only. Try nodemailer's info.message first, then build one with MailComposer.
  try {
    // prefer nodemailer's returned raw if present
    let raw = info && info.message;
    if (!raw) {
      // build raw RFC822 message from mailOptions using MailComposer
      try {
        raw = await new Promise((resolve, reject) => {
          const mc = new MailComposer(mailOptions);
          mc.compile().build((err, message) => err ? reject(err) : resolve(message));
        });
      } catch (err) {
        console.warn('sendMail: MailComposer failed to build raw message', err && (err.message || err));
      }
    }

    if (!raw) {
      console.warn('sendMail: no raw RFC822 message available; skipping save to Sent');
    } else {
      await saveToSentFolder(user, password, raw);
    }
  } catch (err) {
    // Log but do not rethrow — sending succeeded, saving to Sent is best-effort.
    console.warn('sendMail: failed to save message to Sent folder', err && (err.message || err));
  }

  return info;
}

async function listMessagesFromBox(user, password, mailboxName) {
  const client = await connectImap(user, password);
  try {
    // Try to open requested mailbox; if it fails, try to locate a matching mailbox case-insensitively
    try {
      await client.openBox(mailboxName);
    } catch (openErr) {
      // flatten boxes to search for case-insensitive / INBOX-prefixed matches
      const boxes = await client.getBoxes();
      function flattenBoxes(boxesObj, prefix = '') {
        const out = [];
        for (const name of Object.keys(boxesObj || {})) {
          const box = boxesObj[name];
          const path = prefix ? `${prefix}${name}` : name;
          out.push(path);
          if (box.children) {
            out.push(...flattenBoxes(box.children, path + box.delimiter));
          }
        }
        return out;
      }
      const mailboxNames = flattenBoxes(boxes);
      const targetLower = mailboxName.toLowerCase();
      // try to find exact path or last-segment match (case-insensitive), or INBOX.<name>
      let found = mailboxNames.find(b => {
        const last = (b.split(/[\./]/).pop() || '').toLowerCase();
        const full = b.toLowerCase();
        return full === targetLower || last === targetLower || full === (`inbox.${targetLower}`);
      });
      if (!found) {
        // also try common INBOX variants explicitly
        const extraCandidates = [`INBOX.${mailboxName}`, `INBOX.${mailboxName.toUpperCase()}`, `INBOX.${mailboxName.toLowerCase()}`];
        found = mailboxNames.find(b => extraCandidates.map(c => c.toLowerCase()).includes(b.toLowerCase()));
      }
      if (!found) {
        // rethrow original open error so caller knows no mailbox matched
        throw openErr;
      }
      await client.openBox(found);
      mailboxName = found; // update for returned mailbox field
    }

    const fetchOptions = {
      // request the custom X-MOVED-AT header so clients can know when it was moved
      bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE X-MOVED-AT)'],
      struct: true
    };

    const results = await client.search(['ALL'], fetchOptions);

    return results.map(item => {
      const header = item.parts.find(p => p.which && p.which.startsWith('HEADER')) || { body: {} };
      const uid = item.attributes?.uid;
      const flags = item.attributes?.flags || [];
      const seen = flags.some(f => String(f).toLowerCase().includes('seen'));

      return {
        uid,
        mailbox: mailboxName,
        from: header.body.from?.[0] || '',
        to: header.body.to?.[0] || '',
        subject: header.body.subject?.[0] || '',
        date: header.body.date?.[0] || '',
        // expose custom header (imap headers are case-insensitive; header.body keys may be lowercased)
        xMovedAt: header.body['x-moved-at']?.[0] || header.body['x-moved-at'] || header.body['x-moved-at']?.[0] || null,
        seen,
        flags
      };
    });
  } finally {
    client.end();
  }
}


async function listAllMessages(user, password) {
  const client = await connectImap(user, password);
  try {
    // helper: flatten boxes object into full mailbox paths
    function flattenBoxes(boxes, prefix = '') {
      const out = [];
      for (const name of Object.keys(boxes || {})) {
        const box = boxes[name];
        const path = prefix ? `${prefix}${name}` : name;
        out.push(path);
        if (box.children) {
          out.push(...flattenBoxes(box.children, path + box.delimiter));
        }
      }
      return out;
    }

    const boxes = await client.getBoxes();
    const mailboxNames = flattenBoxes(boxes);

    const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], struct: true };
    const all = [];

    for (const boxName of mailboxNames) {
      try {
        await client.openBox(boxName);
        const results = await client.search(['ALL'], fetchOptions);
        results.forEach(item => {
          const header = item.parts.find(p => p.which && p.which.startsWith('HEADER')) || { body: {} };
          const uid = item.attributes && item.attributes.uid;
          const flags = (item.attributes && item.attributes.flags) || [];
          const seen = flags.map(f => String(f).toLowerCase()).includes('\\seen') || flags.map(f => String(f).toLowerCase()).includes('seen');
          all.push({
            uid,
            mailbox: boxName,
            from: header.body.from && header.body.from[0],
            to: header.body.to && header.body.to[0],
            subject: header.body.subject && header.body.subject[0],
            date: header.body.date && header.body.date[0],
            seen,
            flags
          });
        });
      } catch (e) {
        // ignore mailbox errors (permission/localized names) but continue
        console.warn('Failed to read mailbox', boxName, e.message || e);
      }
    }

    return all;
  } finally {
    client.end();
  }
}

async function searchMessagesByFrom(user, password, fromAddress) {
  const client = await connectImap(user, password);
  try {
    // ensure mailbox is open (hMailServer uses INBOX)
    await client.openBox('INBOX');
    const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], struct: true };

    // Use nested-array criteria so imap-simple passes a proper IMAP SEARCH command
    // (matches how UID search is used elsewhere in the code)
    const results = await client.search([['HEADER', 'FROM', fromAddress]], fetchOptions);

    return results.map(item => {
      const header = item.parts.find(p => p.which && p.which.startsWith('HEADER')) || { body: {} };
      const uid = item.attributes && item.attributes.uid;
      const flags = (item.attributes && item.attributes.flags) || [];
      const seen = flags.map(f => String(f).toLowerCase()).includes('\\seen') || flags.map(f => String(f).toLowerCase()).includes('seen');
      return {
        uid,
        from: header.body.from && header.body.from[0],
        to: header.body.to && header.body.to[0],
        subject: header.body.subject && header.body.subject[0],
        date: header.body.date && header.body.date[0],
        seen,
        flags
      };
    });
  } catch (err) {
    console.error('searchMessagesByFrom error for', user, 'fromAddress=', fromAddress, err && (err.message || err));
    return []; // fail gracefully for the endpoint
  } finally {
    client.end();
  }
}

// new helper: build raw RFC822 and append into provided folder candidates (best-effort)
async function saveMessageToFolder(user, password, mailOptions, possibleFolders = []) {
  const client = await connectImap(user, password);
  try {
    // Build raw RFC822 message using MailComposer
    let raw;
    try {
      raw = await new Promise((resolve, reject) => {
        const mc = new MailComposer(mailOptions);
        mc.compile().build((err, message) => err ? reject(err) : resolve(message));
      });
    } catch (err) {
      console.warn('saveMessageToFolder: MailComposer failed', err && (err.message || err));
      // If we cannot build raw, nothing to append
      return;
    }

    // Try to open a writable folder from candidates
    let opened = null;
    for (const folder of possibleFolders) {
      try {
        await client.openBox(folder, false);
        opened = folder;
        break;
      } catch (err) {
        // try next
      }
    }

    // If none opened, try creating the first candidate
    if (!opened && possibleFolders && possibleFolders.length) {
      const target = possibleFolders[0];
      try {
        if (client.imap && typeof client.imap.addBox === 'function') {
          await new Promise((resolve, reject) => client.imap.addBox(target, (err) => err ? reject(err) : resolve()));
          await client.openBox(target, false);
          opened = target;
        }
      } catch (e) {
        console.warn('saveMessageToFolder: could not create folder', target, e && (e.message || e));
      }
    }

    if (!opened) {
      console.warn('saveMessageToFolder: no writable folder found, skipping append');
      return;
    }

    // Append the raw message
    await new Promise((resolve, reject) => {
      try {
        const appendFn = (client.imap && typeof client.imap.append === 'function')
          ? client.imap.append.bind(client.imap)
          : (typeof client.append === 'function')
            ? client.append.bind(client)
            : null;
        if (!appendFn) return reject(new Error('saveMessageToFolder: no append function available on IMAP client'));
        appendFn(raw, { mailbox: opened }, (err) => err ? reject(err) : resolve());
      } catch (err) {
        reject(err);
      }
    });

  } finally {
    client.end();
  }
}

// new: save draft (tries common Drafts folder names)
async function saveDraft(user, password, mailOptions) {
  // include INBOX-prefixed variants and common casings
  const possibleDraftFolders = ["Drafts", "Draft", "DRAFT", "Draft Items", "INBOX.Drafts", "INBOX.DRAFT", "INBOX.DRAFTS"];
  return saveMessageToFolder(user, password, mailOptions, possibleDraftFolders);
}

// new: delete a message by UID from a specific mailbox (best-effort)
async function deleteMessage(user, password, mailboxName, uid) {
  const client = await connectImap(user, password);
  try {
    // open writable box
    await client.openBox(mailboxName || 'INBOX', false);

    // mark message as Deleted by UID and expunge
    await new Promise((resolve, reject) => {
      try {
        // node-imap addFlags often accepts UID/sequence; pass uid directly
        client.imap.addFlags(uid, '\\Deleted', (err) => err ? reject(err) : resolve());
      } catch (err) {
        reject(err);
      }
    });

    // expunge (best-effort)
    await new Promise((resolve, reject) => {
      client.imap.expunge((err) => err ? reject(err) : resolve());
    });
  } finally {
    client.end();
  }
}

// new: move message (by UID) from its mailbox into a Trash-like folder (best-effort)
// Try IMAP COPY (preserves headers/flags) first; if not supported/fails, fall back to appending modified raw with X-MOVED-AT header.
async function moveToTrash(user, password, uid, sourceMailbox = 'INBOX') {
  const client = await connectImap(user, password);
  try {
    // open source mailbox to read raw (and ensure UID exists)
    await client.openBox(sourceMailbox);
    const fetchOptions = { bodies: [''], markSeen: false };
    const results = await client.search([['UID', uid]], fetchOptions);
    if (!results || results.length === 0) return { moved: false, reason: 'not_found' };
    const raw = results[0].parts[0].body;

    // candidate trash folders
    const possibleTrashFolders = ["Trash", "Deleted Items", "Deleted", "Bin", "INBOX.Trash", "INBOX.Deleted", "TRASH"];

    // find or create a target trash folder
    let target = null;
    try {
      for (const f of possibleTrashFolders) {
        try {
          await client.openBox(f, false);
          target = f;
          break;
        } catch (e) {
          // try next
        }
      }
      if (!target) {
        const candidate = possibleTrashFolders[0];
        if (client.imap && typeof client.imap.addBox === 'function') {
          await new Promise((resolve, reject) => client.imap.addBox(candidate, (err) => err ? reject(err) : resolve()));
          await client.openBox(candidate, false);
          target = candidate;
        }
      }
    } catch (e) {
      target = null;
    }

    // If we couldn't locate or create a Trash mailbox, do NOT delete the original.
    if (!target) {
      return { moved: false, reason: 'no_trash' };
    }

    // Append modified raw with X-MOVED-AT and X-ORIGINAL-MAILBOX headers (reliable path)
    try {
      const movedHeader = `X-MOVED-AT: ${new Date().toISOString()}\r\nX-ORIGINAL-MAILBOX: ${sourceMailbox}\r\n`;
      const modifiedRaw = movedHeader + raw;

      await new Promise((resolve, reject) => {
        try {
          const appendFn = (client.imap && typeof client.imap.append === 'function')
            ? client.imap.append.bind(client.imap)
            : (typeof client.append === 'function')
              ? client.append.bind(client)
              : null;
          if (!appendFn) return reject(new Error('no append function on IMAP client'));
          appendFn(modifiedRaw, { mailbox: target }, (err) => err ? reject(err) : resolve());
        } catch (err) { reject(err); }
      });

      // only after successful append, mark original as Deleted + expunge (best-effort)
      try {
        await client.openBox(sourceMailbox, false);
        await new Promise((resolve, reject) => client.imap.addFlags(uid, '\\Deleted', (err) => err ? reject(err) : resolve()));
        await new Promise((resolve, reject) => client.imap.expunge((err) => err ? reject(err) : resolve()));
      } catch (e) {
        // ignore deletion failure but we've already appended to Trash
      }

      return { moved: true, target, method: 'append' };
    } catch (appendErr) {
      // append failed
      return { moved: false, reason: 'append_failed', error: appendErr && appendErr.message };
    }
  } finally {
    client.end();
  }
}

// new: restore message from Trash back to original mailbox (or INBOX)
// - reads raw from trash mailbox by UID, strips X-MOVED-AT / X-ORIGINAL-MAILBOX headers,
//   appends sanitized raw into original mailbox (or INBOX), then deletes the trash entry.
async function restoreFromTrash(user, password, uid, trashMailbox = 'Trash') {
  const client = await connectImap(user, password);
  try {
    await client.openBox(trashMailbox);
    const fetchOptions = { bodies: [''], markSeen: false };
    const results = await client.search([['UID', uid]], fetchOptions);
    if (!results || results.length === 0) return { restored: false, reason: 'not_found' };
    const raw = results[0].parts[0].body;

    // extract original mailbox header if present
    const m = (raw || '').match(/X-ORIGINAL-MAILBOX:\s*(.+)/i);
    const originalMailbox = m ? m[1].trim() : null;
    const targetMailbox = originalMailbox || 'INBOX';

    // remove our helper headers before appending
    let sanitized = raw.replace(/^X-MOVED-AT:.*\r?\n/ig, '').replace(/^X-ORIGINAL-MAILBOX:.*\r?\n/ig, '');

    // ensure destination exists / open writable
    try {
      await client.openBox(targetMailbox, false);
    } catch (err) {
      // try to create if possible
      try {
        if (client.imap && typeof client.imap.addBox === 'function') {
          await new Promise((resolve, reject) => client.imap.addBox(targetMailbox, (e) => e ? reject(e) : resolve()));
          await client.openBox(targetMailbox, false);
        } else {
          // fallback: try opening INBOX
          await client.openBox('INBOX', false);
        }
      } catch (e) {
        // fallback to INBOX
        try { await client.openBox('INBOX', false); } catch (_) {}
      }
    }

    // append sanitized raw into target mailbox
    await new Promise((resolve, reject) => {
      try {
        const appendFn = (client.imap && typeof client.imap.append === 'function')
          ? client.imap.append.bind(client.imap)
          : (typeof client.append === 'function')
            ? client.append.bind(client)
            : null;
        if (!appendFn) return reject(new Error('no append function on IMAP client'));
        appendFn(sanitized, { mailbox: targetMailbox }, (err) => err ? reject(err) : resolve());
      } catch (err) { reject(err); }
    });

    // remove the original message in trash (mark deleted + expunge)
    try {
      await client.openBox(trashMailbox, false);
      await new Promise((resolve, reject) => {
        client.imap.addFlags(uid, '\\Deleted', (err) => err ? reject(err) : resolve());
      });
      await new Promise((resolve, reject) => {
        client.imap.expunge((err) => err ? reject(err) : resolve());
      });
    } catch (e) {
      // ignore deletion failure
    }

    return { restored: true, target: targetMailbox };
  } finally {
    client.end();
  }
}

module.exports = {
  listMessages, fetchMessage, sendMail, listAllMessages, searchMessagesByFrom, listMessagesFromBox,
  saveToSentFolder, saveDraft, deleteMessage, getAttachment, moveToTrash, restoreFromTrash
};
