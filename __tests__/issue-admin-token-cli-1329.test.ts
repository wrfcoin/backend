/** backend#1329 item 1: host CLI that issues short-lived admin tokens. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

// eslint-disable-next-line @typescript-eslint/no-var-requires
// A minimal in-memory ioredis so the REAL RedisSessionService (and the real requireAdmin gate) run.
const mockStore = new Map<string, string>();
const mockHooks: { afterGet?: (key: string) => void; throwOn?: string } = {};
let mockRecreated = false;
jest.mock('ioredis', () => {
  class FakeRedis {
    private handlers: Record<string, Array<() => void>> = {};
    on(event: string, cb: () => void) { (this.handlers[event] ||= []).push(cb); return this; }
    async connect() { setImmediate(() => { (this.handlers.connect || []).forEach(f => f()); (this.handlers.ready || []).forEach(f => f()); }); }
    async get(key: string) {
      if (mockHooks.throwOn && key.endsWith(mockHooks.throwOn)) throw new Error('redis down');
      const v = mockStore.get(key) ?? null;
      mockHooks.afterGet?.(key); // e.g. an operator DEL landing right after this read
      return v;
    }
    async setex(key: string, _ttl: number, value: string) { if (key.startsWith('session:') && !mockStore.has(key)) mockRecreated = true; mockStore.set(key, value); return 'OK'; }
    async del(key: string) { return mockStore.delete(key) ? 1 : 0; }
    async sadd() { return 1; } async expire() { return 1; } async smembers() { return []; } async keys() { return []; }
    async quit() { return 'OK'; } disconnect() { /* noop */ }
  }
  return { __esModule: true, default: FakeRedis, Redis: FakeRedis };
});
const cli = require('../scripts/issue-admin-token.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { hasAdminRole } = require('../server/utils/admin-role.js');
import { JWT_ISSUER, JWT_AUDIENCE } from '../server/auth/jwt-constants.js';

const SECRET = 'cli-test-secret-0123456789abcdef0123456789';
const SCRIPT = path.resolve(__dirname, '../scripts/issue-admin-token.cjs');

function fakeRedis() {
  const calls: any[][] = [];
  return { calls, setex: async (...a: any[]) => { calls.push(['setex', ...a]); }, sadd: async (...a: any[]) => { calls.push(['sadd', ...a]); },
    expire: async (...a: any[]) => { calls.push(['expire', ...a]); }, quit: async () => { calls.push(['quit']); } };
}
function sink() { let text = ''; return { write: (s: string) => { text += s; }, get text() { return text; } }; }

describe('scripts/issue-admin-token.cjs (#1329)', () => {
  it('shares the backend issuer/audience constants', () => {
    expect(cli.JWT_ISSUER).toBe(JWT_ISSUER); expect(cli.JWT_AUDIENCE).toBe(JWT_AUDIENCE);
  });

  it('issues a token the backend verifier would accept: admin role, session id, <=15 min, backend iss/aud', async () => {
    const redis = fakeRedis(); const out = sink(); const err = sink();
    await cli.run({ argv: ['--ttl-minutes', '5', '--subject', 'ops-tony'], env: { JWT_SECRET: SECRET }, stdout: out, stderr: err, redisFactory: async () => redis });
    const token = out.text.trim();
    const decoded: any = jwt.verify(token, SECRET, { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    expect(hasAdminRole(decoded)).toBe(true);
    expect(decoded.userId).toBe('ops-tony');
    expect(decoded.sessionId).toBe(decoded.jti);
    expect(decoded.exp - decoded.iat).toBe(300);
    // the session the middleware requires (middleware/auth.ts:410) is written under redis-session-service's key/shape
    const setex = redis.calls.find(c => c[0] === 'setex')!;
    expect(setex[1]).toBe(`session:${decoded.sessionId}`); expect(setex[2]).toBe(300);
    expect(JSON.parse(setex[3])).toMatchObject({ userId: 'ops-tony', roles: ['admin'], sessionId: decoded.sessionId });
    expect(redis.calls.some(c => c[0] === 'quit')).toBe(true);
  });

  it('refuses RS256 issuance (the admin verifier is HS256-only)', async () => {
    await expect(cli.run({ argv: [], env: { JWT_PRIVATE_KEY_PATH: '/nonexistent.pem', JWT_SECRET: SECRET }, stdout: sink(), stderr: sink(), redisFactory: async () => fakeRedis() }))
      .rejects.toThrow(/RS256 issuance is not supported/);
  });

  it('prints only the token on stdout; the audit line has no token and no secret', async () => {
    const out = sink(); const err = sink();
    await cli.run({ argv: [], env: { JWT_SECRET: SECRET }, stdout: out, stderr: err, redisFactory: async () => fakeRedis() });
    expect(out.text.trim().split('.')).toHaveLength(3);
    expect(out.text).not.toContain(SECRET);
    const audit = JSON.parse(err.text);
    expect(audit.event).toBe('admin_token_issued');
    expect(err.text).not.toContain(SECRET); expect(err.text).not.toContain(out.text.trim());
  });

  it('appends the audit line to ADMIN_TOKEN_AUDIT_LOG when set', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adm-')), 'audit.log');
    await cli.run({ argv: [], env: { JWT_SECRET: SECRET, ADMIN_TOKEN_AUDIT_LOG: file }, stdout: sink(), stderr: sink(), redisFactory: async () => fakeRedis() });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).event).toBe('admin_token_issued');
  });

  it.each([['0'], ['16'], ['abc'], ['1.5'], ['-1']])('refuses --ttl-minutes %s', (v) => {
    expect(() => cli.parseArgs(['--ttl-minutes', v])).toThrow(/ttl-minutes/);
  });
  it('refuses unknown args and unsafe subjects', () => {
    expect(() => cli.parseArgs(['--roles', 'admin'])).toThrow(/Unknown/);
    expect(() => cli.parseArgs(['--subject', 'a b'])).toThrow(/subject/);
  });

  it('fails without issuing when JWT_SECRET is missing/short, or Redis is unreachable', async () => {
    const out = sink();
    await expect(cli.run({ argv: [], env: {}, stdout: out, stderr: sink(), redisFactory: async () => fakeRedis() })).rejects.toThrow(/JWT_SECRET/);
    await expect(cli.run({ argv: [], env: { JWT_SECRET: 'short' }, stdout: out, stderr: sink(), redisFactory: async () => fakeRedis() })).rejects.toThrow(/32/);
    await expect(cli.run({ argv: [], env: { JWT_SECRET: SECRET }, stdout: out, stderr: sink(), redisFactory: async () => { throw new Error('redis down'); } })).rejects.toThrow(/redis down/);
    expect(out.text).toBe('');
  });

  it('a session-write failure emits no token', async () => {
    const out = sink(); const bad = { ...fakeRedis(), setex: async () => { throw new Error('write failed'); } };
    await expect(cli.run({ argv: [], env: { JWT_SECRET: SECRET }, stdout: out, stderr: sink(), redisFactory: async () => bad })).rejects.toThrow(/write failed/);
    expect(out.text).toBe('');
  });

  it('process: exits 1 with empty stdout and never echoes the secret when the ttl is invalid', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--ttl-minutes', '99'], { env: { PATH: process.env.PATH, JWT_SECRET: SECRET }, encoding: 'utf8' });
    expect(r.status).toBe(1); expect(r.stdout).toBe(''); expect(r.stderr).not.toContain(SECRET);
  });
});

// The REAL admin gate (authMiddleware.js requireAdmin) + the REAL RedisSessionService (over a fake ioredis).
describe('CLI token vs the mounted requireAdmin gate (#1329)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { requireAdmin } = require('../server/middleware/authMiddleware.js');
  const express = require('express');
  const request = require('supertest');
  const app = express();
  app.get('/admin', requireAdmin, (_req: any, res: any) => res.json({ ok: true }));
  const prevSecret = process.env.JWT_SECRET;
  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    // wait for the session service's (fake) Redis connection events
    for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 5)); if (require('../server/services/redis-session-service.js').sessionService.isRedisConnected()) break; }
  });
  afterAll(() => { if (prevSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prevSecret; });
  beforeEach(() => { mockStore.clear(); mockHooks.afterGet = undefined; mockHooks.throwOn = undefined; });

  const sign = (claims: object) => jwt.sign(claims, SECRET, { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 300 });
  const get = (t: string) => request(app).get('/admin').set('authorization', `Bearer ${t}`);
  async function issue() {
    const out = sink();
    const redis = { setex: async (k: string, ttl: number, v: string) => { mockStore.set(k, v); }, sadd: async () => 0, expire: async () => 0, quit: async () => 'OK' };
    await cli.run({ argv: [], env: { JWT_SECRET: SECRET }, stdout: out, stderr: sink(), redisFactory: async () => redis });
    const token = out.text.trim();
    return { token, sessionKey: `session:${(jwt.decode(token) as any).sessionId}` };
  }

  it('a CLI token with its session is accepted; the same token after the session key is deleted is refused', async () => {
    const { token, sessionKey } = await issue();
    expect((await get(token)).status).toBe(200);
    mockStore.delete(sessionKey); // == DEL session:<id>
    expect((await get(token)).status).toBe(401);
  });

  it.each([1, 2])('a DEL landing right after the gate\'s read #%i is never undone by the request', async (n) => {
    const { token, sessionKey } = await issue();
    let reads = 0; let deleted = false; mockRecreated = false;
    mockHooks.afterGet = (key) => { if (key === sessionKey && ++reads === n) { mockStore.delete(key); deleted = true; } };
    await get(token);
    mockHooks.afterGet = undefined;
    // A gate that renews the session (GET then SETEX, like validateSession) re-creates the deleted key.
    expect(mockRecreated).toBe(false);
    if (deleted) expect((await get(token)).status).toBe(401); // the NEXT request is refused
    else { mockStore.delete(sessionKey); expect((await get(token)).status).toBe(401); }
  });

  it('a valid admin JWT that has no sessionId is refused', async () => {
    expect((await get(sign({ userId: 'x', roles: ['admin'], permissions: [] }))).status).toBe(401);
  });

  it('a session belonging to another user, or without the admin role, is refused', async () => {
    const stamp = new Date().toISOString();
    mockStore.set('session:s-other', JSON.stringify({ userId: 'someone-else', roles: ['admin'], permissions: [], sessionId: 's-other', createdAt: stamp, lastActivity: stamp }));
    mockStore.set('session:s-user', JSON.stringify({ userId: 'x', roles: ['user'], permissions: [], sessionId: 's-user', createdAt: stamp, lastActivity: stamp }));
    expect((await get(sign({ userId: 'x', roles: ['admin'], sessionId: 's-other', permissions: [] }))).status).toBe(401);
    expect((await get(sign({ userId: 'x', roles: ['admin'], sessionId: 's-user', permissions: [] }))).status).toBe(401);
  });

  it('a session-store error refuses (never fails open, never falls back to memory)', async () => {
    const { token, sessionKey } = await issue();
    mockHooks.throwOn = sessionKey.replace('session:', '');
    expect((await get(token)).status).toBe(401);
  });

  it('a non-admin token is still 403 before the session is consulted', async () => {
    expect((await get(sign({ userId: 'x', roles: ['user'], sessionId: 's', permissions: [] }))).status).toBe(403);
  });
});
