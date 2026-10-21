/**
 * backend#1297: a wallet-login caller (role 'wallet', no session) may read only its own user.
 * Session callers are unchanged.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const WALLET = '0x' + 'ab'.repeat(20);
const OTHER_WALLET = '0x' + 'cd'.repeat(20);

// The test picks the caller with x-test-caller: wallet | other-wallet | session-7 | session-9.
jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (req: any, _res: any, next: any) => {
    const who = req.get('x-test-caller');
    if (who === 'wallet') req.user = { id: WALLET, userId: WALLET, address: WALLET, role: 'wallet', roles: ['wallet'], permissions: [] };
    if (who === 'other-wallet') req.user = { id: OTHER_WALLET, userId: OTHER_WALLET, address: OTHER_WALLET, role: 'wallet', roles: ['wallet'], permissions: [] };
    if (who === 'session-7') req.user = { id: '7', userId: '7', roles: ['user'], permissions: [], sessionId: 's-7' };
    next();
  },
}));

// The users table: wallet WALLET owns user 7; OTHER_WALLET owns nobody.
const lookups: string[] = [];
function chain(rowsFor: () => unknown[]) {
  const c: any = {};
  ['from', 'where', 'orderBy', 'limit', 'groupBy'].forEach((m) => { c[m] = jest.fn(() => c); });
  c.then = (resolve: any) => Promise.resolve(rowsFor()).then(resolve);
  return c;
}
const mockDb = {
  select: jest.fn(() => chain(() => {
    lookups.push('select');
    return [{ id: 7 }];
  })),
  transaction: jest.fn(),
};
jest.mock('../../database/index.js', () => ({ db: mockDb }));
jest.mock('../../server/utils/logger.js', () => ({
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import rewardsRouter from '../../server/routes/rewards.js';
import { walletMayOnlyUseOwnUserId } from '../../server/middleware/wallet-ownership.js';
import * as fs from 'fs';
import * as path from 'path';

function rewardsApp() {
  const app = express();
  app.use(express.json());
  app.use('/rewards', rewardsRouter);
  return app;
}

describe('rewards /user/:userId ownership for wallet callers', () => {
  beforeEach(() => { jest.clearAllMocks(); lookups.length = 0; });

  it('a wallet caller reading ITS OWN user id is allowed', async () => {
    const res = await request(rewardsApp()).get('/rewards/user/7').set('x-test-caller', 'wallet');
    expect(res.status).toBe(200);
  });

  it.each(['/rewards/user/8', '/rewards/user/8/offsets', '/rewards/user/8/computational', '/rewards/user/8/algorithms'])(
    'a wallet caller reading ANOTHER id (%s) gets 403',
    async (url) => {
      const res = await request(rewardsApp()).get(url).set('x-test-caller', 'wallet');
      expect(res.status).toBe(403);
    },
  );

  it('a NON-EXISTENT id with a wallet token is 403, not a 404 that leaks existence', async () => {
    for (const url of ['/rewards/user/999999', '/rewards/user/999999/offsets']) {
      const res = await request(rewardsApp()).get(url).set('x-test-caller', 'wallet');
      expect(res.status).toBe(403);
      expect(res.body).not.toHaveProperty('rewards');
    }
  });

  it('a wallet with no users row gets 403 even for id 7', async () => {
    mockDb.select.mockImplementationOnce(() => chain(() => []));
    const res = await request(rewardsApp()).get('/rewards/user/7').set('x-test-caller', 'other-wallet');
    expect(res.status).toBe(403);
  });

  it('a non-numeric or non-canonical id is refused for a wallet caller', async () => {
    for (const bad of ['7abc', '07x', '7.0']) {
      const res = await request(rewardsApp()).get(`/rewards/user/${bad}`).set('x-test-caller', 'wallet');
      expect(res.status).toBe(403);
    }
  });

  it('only the canonical decimal spelling of the caller\'s own id is accepted (#1388): a leading zero is 403', async () => {
    for (const spelled of ['07', '0007', '00', '7.0', '+7', ' 7']) {
      const res = await request(rewardsApp()).get(`/rewards/user/${encodeURIComponent(spelled)}`).set('x-test-caller', 'wallet');
      expect(res.status).toBe(403);
    }
    const ok = await request(rewardsApp()).get('/rewards/user/7').set('x-test-caller', 'wallet');
    expect(ok.status).toBe(200);
  });

  it('a session caller is unchanged: any id still answers (no ownership lookup)', async () => {
    const res = await request(rewardsApp()).get('/rewards/user/8').set('x-test-caller', 'session-7');
    expect(res.status).toBe(200);
    expect(lookups.length).toBeLessThanOrEqual(3); // only the handler's own queries
  });

  it('claim and history no longer misread a wallet address as a numeric user id', async () => {
    // The wallet is mapped through users.wallet_address; a wallet with no row is Unauthenticated.
    mockDb.select.mockImplementationOnce(() => chain(() => []));
    const res = await request(rewardsApp()).get('/rewards/history').set('x-test-caller', 'other-wallet');
    expect(res.status).toBe(401);
  });
});

describe('the same guard on any router with a :userId param', () => {
  function app() {
    const a = express();
    const r = express.Router();
    r.param('userId', walletMayOnlyUseOwnUserId);
    r.get('/:userId', (req, res) => res.json({ ok: true, userId: req.params.userId }));
    r.post('/:userId/award', (req, res) => res.json({ ok: true }));
    a.use('/achievement', (req: any, _res, next) => {
      const who = req.get('x-test-caller');
      if (who === 'wallet') req.user = { id: WALLET, userId: WALLET, address: WALLET, role: 'wallet', roles: ['wallet'] };
      next();
    }, r);
    return a;
  }
  it('own id 200, another id 403, write routes included', async () => {
    expect((await request(app()).get('/achievement/7').set('x-test-caller', 'wallet')).status).toBe(200);
    expect((await request(app()).get('/achievement/8').set('x-test-caller', 'wallet')).status).toBe(403);
    expect((await request(app()).post('/achievement/8/award').set('x-test-caller', 'wallet')).status).toBe(403);
    expect((await request(app()).get('/achievement/8')).status).toBe(200); // no caller marker = unchanged
  });

  it('achievementRoutes.ts installs the guard', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/routes/achievementRoutes.ts'), 'utf8');
    expect(src).toMatch(/router\.param\('userId', walletMayOnlyUseOwnUserId\)/);
  });
});
