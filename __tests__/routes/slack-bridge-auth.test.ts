import express, { Request, Response } from 'express';
import request from 'supertest';
import crypto from 'crypto';

// Mock dependencies before importing the router
jest.mock('../../server/utils/logger.js', () => ({
  securityLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../server/services/slack-notification-service.js', () => ({
  slackNotificationService: { isEnabled: jest.fn().mockReturnValue(false) },
}));
jest.mock('../../server/services/incidentPlaybookEngine.js', () => ({
  incidentPlaybookEngine: { getIncidentHistory: jest.fn().mockReturnValue([]) },
}));

// Lazy import after mocks are set
let slackRouter: express.Router;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); },
  }));
  app.use(express.urlencoded({
    extended: true,
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); },
  }));
  app.use('/api/slack', slackRouter);
  return app;
}

function signedHeaders(secret: string, body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig };
}

const SECRET = 'test-slack-signing-secret-32chars!!';

beforeAll(async () => {
  slackRouter = (await import('../../server/routes/slack-command-routes.js')).default;
});

afterEach(() => {
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.NODE_ENV;
});

describe('verifySlackSignature — NODE_ENV bypass fix', () => {
  it('returns 503 when secret is missing and NODE_ENV=testnet', async () => {
    process.env.NODE_ENV = 'testnet';
    const app = buildApp();
    const res = await request(app)
      .post('/api/slack/commands')
      .type('form')
      .send({ command: '/wrfcoin-help', text: '' });
    expect(res.status).toBe(503);
  });

  it('returns 503 when secret is missing and NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildApp();
    const res = await request(app)
      .post('/api/slack/commands')
      .type('form')
      .send({ command: '/wrfcoin-help', text: '' });
    expect(res.status).toBe(503);
  });

  it('allows through when secret is missing and NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development';
    const app = buildApp();
    const res = await request(app)
      .post('/api/slack/commands')
      .type('form')
      .send({ command: '/wrfcoin-help', text: '' });
    // Handler runs — 200 with response_type field
    expect(res.status).toBe(200);
    expect(res.body.response_type).toBe('ephemeral');
  });

  it('allows through when secret is missing and NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test';
    const app = buildApp();
    const res = await request(app)
      .post('/api/slack/commands')
      .type('form')
      .send({ command: '/wrfcoin-help', text: '' });
    expect(res.status).toBe(200);
  });
});

describe('verifySlackSignature — header/signature validation', () => {
  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.NODE_ENV = 'testnet';
  });

  it('returns 401 when timestamp/signature headers are missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/slack/commands')
      .type('form')
      .send({ command: '/wrfcoin-help', text: '' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing Slack signature/);
  });

  it('returns 401 when timestamp is stale (>5 min ago)', async () => {
    const app = buildApp();
    const staleTs = String(Math.floor(Date.now() / 1000) - 400);
    const body = 'command=%2Fwrfcoin-help&text=';
    const sig = 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${staleTs}:${body}`).digest('hex');
    const res = await request(app)
      .post('/api/slack/commands')
      .set('x-slack-request-timestamp', staleTs)
      .set('x-slack-signature', sig)
      .type('form')
      .send({ command: '/wrfcoin-help', text: '' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/timestamp too old/);
  });

  it('returns 401 on invalid signature', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request(app)
      .post('/api/slack/commands')
      .set('x-slack-request-timestamp', ts)
      .set('x-slack-signature', 'v0=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb')
      .type('form')
      .send({ command: '/wrfcoin-help', text: '' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid signature/);
  });

  it('accepts a valid Slack signature over the raw urlencoded body', async () => {
    const app = buildApp();
    const body = 'command=%2Fwrfcoin-help&text=';
    const headers = signedHeaders(SECRET, body);
    const res = await request(app)
      .post('/api/slack/commands')
      .set(headers)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.response_type).toBe('ephemeral');
  });
});

describe('/events route — requires signature verification', () => {
  it('returns 401 on /events without headers when secret is set (testnet)', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.NODE_ENV = 'testnet';
    const app = buildApp();
    const res = await request(app)
      .post('/api/slack/events')
      .send({ type: 'url_verification', challenge: 'xyz' });
    expect(res.status).toBe(401);
  });

  it('handles url_verification with valid signature', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.NODE_ENV = 'testnet';
    const app = buildApp();
    const body = JSON.stringify({ type: 'url_verification', challenge: 'test-challenge' });
    const headers = signedHeaders(SECRET, body);
    const res = await request(app)
      .post('/api/slack/events')
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('test-challenge');
  });

  it('returns 503 on /events when secret is missing and NODE_ENV=testnet', async () => {
    process.env.NODE_ENV = 'testnet';
    const app = buildApp();
    const res = await request(app)
      .post('/api/slack/events')
      .send({ type: 'url_verification', challenge: 'xyz' });
    expect(res.status).toBe(503);
  });
});
