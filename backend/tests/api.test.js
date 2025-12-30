// backend/__tests__/api.test.js
jest.setTimeout(20000);

// Use supertest to call the running server
const supertest = require('supertest');

beforeAll(async () => {
  // make deterministic env for tests
  process.env.PORT = '4010';
  process.env.JWT_SECRET = 'testsecret';
  process.env.JWT_EXPIRES = '1h';
  process.env.IMAP_HOST = 'localhost';
  process.env.IMAP_PORT = '143';
  process.env.IMAP_TLS = 'false';
  process.env.SMTP_HOST = 'localhost';
  process.env.SMTP_PORT = '25';
  process.env.SMTP_SECURE = 'false';

  // reset modules so our mocks are used when server.js requires them
  jest.resetModules();

  // --- mock pg Pool with in-memory sessions store ---
  jest.doMock('pg', () => {
    class MockPool {
      constructor() { this.sessions = {}; }
      async query(sql, params) {
        const s = (sql || '').toString();
        if (s.includes('CREATE TABLE')) return { rows: [] };
        if (s.toUpperCase().includes('INSERT INTO SESSIONS')) {
          const [jti, email, password, exp] = params;
          this.sessions[jti] = { jti, email, password, exp };
          return { rows: [] };
        }
        if (s.toUpperCase().includes('FROM SESSIONS WHERE JTI') || s.toUpperCase().startsWith('SELECT JTI')) {
          const jti = params && params[0];
          const row = this.sessions[jti];
          return { rows: row ? [row] : [] };
        }
        if (s.toUpperCase().startsWith('DELETE FROM SESSIONS WHERE JTI')) {
          const jti = params && params[0];
          delete this.sessions[jti];
          return { rows: [] };
        }
        if (s.toUpperCase().startsWith('DELETE FROM SESSIONS WHERE EXP')) {
          const now = params && params[0];
          for (const k of Object.keys(this.sessions)) {
            if (this.sessions[k].exp <= now) delete this.sessions[k];
          }
          return { rows: [] };
        }
        // generic fallback
        return { rows: [] };
      }
    }
    return { Pool: MockPool };
  });

  // --- mock imap-simple so login succeeds ---
  jest.doMock('imap-simple', () => ({
    connect: jest.fn(async () => ({ end: () => {} }))
  }));

  // --- mock nodemailer so sendMail succeeds and returns info ---
  jest.doMock('nodemailer', () => ({
    createTransport: jest.fn(() => ({
      verify: cb => cb(null, true),
      sendMail: async (opts) => ({
        messageId: 'msgid',
        accepted: [opts.to],
        rejected: [],
        response: '250 OK',
        message: Buffer.from('raw')
      })
    }))
  }));

  // make require('winax') throw so server falls back gracefully
  jest.doMock('winax', () => { throw new Error('no winax in test'); });

  // require app (server.js now exports the Express app)
const app = require('../server');
global.__APP__ = app;
});

test('POST /api/login returns a token', async () => {
  const req = supertest(global.__APP__);
  const res = await req.post('/api/login')
    .send({ email: 'user@example.com', password: 'secret' })
    .expect(200);
  expect(res.body).toBeDefined();
  expect(res.body.token).toBeDefined();
});

test('Authenticated POST /api/send sends mail', async () => {
  const req = supertest(global.__APP__);

  // login first
  const login = await req.post('/api/login')
    .send({ email: 'user@example.com', password: 'secret' })
    .expect(200);
  const token = login.body.token;
  expect(token).toBeDefined();

  // send mail
  const sendRes = await req.post('/api/send')
    .set('Authorization', 'Bearer ' + token)
    .send({ to: 'dest@example.com', subject: 'Test', text: 'Hello' })
    .expect(200);

  expect(sendRes.body.success).toBe(true);
  expect(sendRes.body.info).toBeDefined();
  expect(sendRes.body.info.accepted).toContain('dest@example.com');
});