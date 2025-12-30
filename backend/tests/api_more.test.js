// backend/tests/api_more.test.js
jest.setTimeout(20000);
const supertest = require('supertest');

beforeAll(async () => {
  process.env.PORT = '4010';
  process.env.JWT_SECRET = 'testsecret';
  process.env.JWT_EXPIRES = '1h';
  process.env.IMAP_HOST = 'localhost';
  process.env.IMAP_PORT = '143';
  process.env.IMAP_TLS = 'false';
  process.env.SMTP_HOST = 'localhost';
  process.env.SMTP_PORT = '25';
  process.env.SMTP_SECURE = 'false';

  // --- mock imap-simple so login succeeds ---
jest.doMock('imap-simple', () => ({
  connect: jest.fn(async () => ({ end: () => {} }))
}));
  jest.resetModules();

  // Mock pg Pool supporting sessions, user_settings, hm_accounts
  jest.doMock('pg', () => {
    class MockPool {
      constructor() {
        this.sessions = {};
        this.userSettings = {};
        this.hmAccounts = {};
      }
      async query(sql, params) {
        const s = (sql || '').toString().toUpperCase();
        // create table calls
        if (s.includes('CREATE TABLE')) return { rows: [] };

        // sessions insert
        if (s.includes('INSERT INTO SESSIONS')) {
          const [jti, email, password, exp] = params;
          this.sessions[jti] = { jti, email, password, exp };
          return { rows: [] };
        }
        // select session by jti
        if (s.includes('FROM SESSIONS WHERE JTI')) {
          const jti = params && params[0];
          const row = this.sessions[jti];
          return { rows: row ? [row] : [] };
        }
        // delete session
        if (s.startsWith('DELETE FROM SESSIONS WHERE')) {
          const jti = params && params[0];
          delete this.sessions[jti];
          return { rows: [] };
        }
        // cleanup expired
        if (s.includes('DELETE FROM SESSIONS WHERE EXP')) {
          const now = params && params[0];
          for (const k of Object.keys(this.sessions)) {
            if (this.sessions[k].exp <= now) delete this.sessions[k];
          }
          return { rows: [] };
        }

        // user_settings select
        if (s.includes('FROM USER_SETTINGS WHERE EMAIL')) {
          const email = params && params[0];
          const row = this.userSettings[email];
          if (!row) return { rows: [] };
          return { rows: [{ out_of_office: row.out_of_office, out_of_office_reply: row.out_of_office_reply, theme: row.theme, app_lock: row.app_lock }] };
        }
        // upsert user_settings
        if (s.includes('INSERT INTO USER_SETTINGS')) {
          const [email, out_of_office, reply, theme, app_lock] = params;
          this.userSettings[email] = { out_of_office, out_of_office_reply: reply, theme, app_lock };
          return { rows: [] };
        }

        // hm_accounts lookup for admin level
        if (s.includes('FROM HM_ACCOUNTS WHERE ACCOUNTADDRESS')) {
          const email = params && params[0];
          const row = this.hmAccounts[email] || { accountadminlevel: 0 };
          return { rows: [row] };
        }

        return { rows: [] };
      }
    }
    return { Pool: MockPool };
  });

  // Mock mailService functions directly (used by server routes)
  jest.doMock('../mailService', () => ({
    listMessages: async () => ([{ uid: '1', from: 'alice@example.com', to: 'me@example.com', subject: 'hi', date: new Date().toISOString(), seen: false }]),
    fetchMessage: async (u, p, uid) => ({ uid, from: 'alice@example.com', to: 'me@example.com', subject: 'hello', text: 'body', html: null, date: new Date().toISOString() }),
    getAttachment: async () => ({ filename: 'file.txt', contentType: 'text/plain', content: Buffer.from('ok') }),
    listMessagesFromBox: async () => ([]),
    saveDraft: async () => {},
    deleteMessage: async () => {},
    moveToTrash: async () => ({ moved: true, target: 'Trash' }),
    listAllMessages: async () => [],
    searchMessagesByFrom: async () => []
  }));

  // Mock nodemailer so sendMail used by mailService (if invoked) succeeds
  jest.doMock('nodemailer', () => ({
    createTransport: jest.fn(() => ({
      verify: cb => cb(null, true),
      sendMail: async (opts) => ({ messageId: 'msgid', accepted: [opts.to], rejected: [], response: '250 OK', message: Buffer.from('raw') })
    }))
  }));

  // prevent winax
  jest.doMock('winax', () => { throw new Error('no winax in test'); });

  const app = require('../server');
global.__APP__ = app;
});

test('GET /api/messages returns messages for logged user', async () => {
  const req = supertest(global.__APP__);
  const login = await req.post('/api/login').send({ email: 'user@example.com', password: 'secret' }).expect(200);
  const token = login.body.token;
  const res = await req.get('/api/messages').set('Authorization', 'Bearer ' + token).expect(200);
  expect(res.body.messages).toBeInstanceOf(Array);
  expect(res.body.messages[0].subject).toBeDefined();
});

test('GET /api/message/:uid returns message body', async () => {
  const req = supertest(global.__APP__);
  const login = await req.post('/api/login').send({ email: 'user@example.com', password: 'secret' }).expect(200);
  const token = login.body.token;
  const res = await req.get('/api/message/1').set('Authorization', 'Bearer ' + token).expect(200);
  expect(res.body.message).toBeDefined();
  expect(res.body.message.text).toBe('body');
});

test('GET attachment returns buffer content', async () => {
  const req = supertest(global.__APP__);
  const login = await req.post('/api/login').send({ email: 'user@example.com', password: 'secret' }).expect(200);
  const token = login.body.token;
  const res = await req.get('/api/message/1/attachment/0').set('Authorization', 'Bearer ' + token).expect(200);
  expect(res.headers['content-type']).toBe('text/plain');
});

test('POST /api/draft saves draft', async () => {
  const req = supertest(global.__APP__);
  const login = await req.post('/api/login').send({ email: 'user@example.com', password: 'secret' }).expect(200);
  const token = login.body.token;
  await req.post('/api/draft').set('Authorization', 'Bearer ' + token).send({ to: 'a@b', text: 'x' }).expect(200);
});

test('schedule workflow: POST -> GET -> DELETE', async () => {
  const req = supertest(global.__APP__);
  const login = await req.post('/api/login').send({ email: 'user@example.com', password: 'secret' }).expect(200);
  const token = login.body.token;
  const future = new Date(Date.now() + 60 * 1000).toISOString();
  const post = await req.post('/api/schedule').set('Authorization', 'Bearer ' + token).send({ to: 't@t', subject: 's', text: 'x', sendAt: future }).expect(200);
  expect(post.body.id).toBeDefined();
  const id = post.body.id;
  const list = await req.get('/api/schedule').set('Authorization', 'Bearer ' + token).expect(200);
  expect(list.body.jobs.some(j => j.id === id)).toBe(true);
  await req.delete(`/api/schedule/${id}`).set('Authorization', 'Bearer ' + token).expect(200);
});

test('GET/POST settings roundtrip', async () => {
  const req = supertest(global.__APP__);
  const login = await req.post('/api/login').send({ email: 'user@example.com', password: 'secret' }).expect(200);
  const token = login.body.token;
  const get = await req.get('/api/settings').set('Authorization', 'Bearer ' + token).expect(200);
  expect(get.body.settings).toBeDefined();
  const update = await req.post('/api/settings').set('Authorization', 'Bearer ' + token).send({ outOfOffice: true, outOfOfficeReply: 'hi' }).expect(200);
  expect(update.body.settings.outOfOffice).toBe(true);
});