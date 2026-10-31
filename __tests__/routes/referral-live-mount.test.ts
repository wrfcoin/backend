/**
 * backend#1178 — /api/referrals on the live entrypoint, honestly.
 *
 * The real referral router and the real wallet-JWT middleware
 * (auth-middleware.ts authenticateToken) run against an in-memory referrals
 * table. The app mirrors the entrypoint's order: the router is mounted before
 * a token-gated catch-all that answers 401, so a garbage path proves whether
 * the router is mounted (404) or not (401).
 */
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../server/auth/jwt-constants';

type Row = Record<string, unknown>;
type Pred = { eq: [string, unknown] } | { and: Pred[] };

const mockTable: Row[] = [];

function mockMatches(row: Row, p: Pred): boolean {
  if ('and' in p) return p.and.every((q) => mockMatches(row, q));
  return row[p.eq[0]] === p.eq[1];
}

// auth-middleware.ts (wallet JWT verification, used unmocked) also exports
// API-key auth; its service pulls the DB schema, which the drizzle mock below
// cannot satisfy. authenticateToken does not use it.
jest.mock('../../server/services/api-key-service.js', () => ({ apiKeyService: {} }));

jest.mock('drizzle-orm', () => ({
  eq: (col: string, val: unknown) => ({ eq: [col, val] }),
  and: (...conds: unknown[]) => ({ and: conds }),
}));

jest.mock('../../shared/schema-engagement.js', () => ({
  referrals: {
    id: 'id',
    referralCode: 'referralCode',
    referrerAddress: 'referrerAddress',
    refereeAddress: 'refereeAddress',
    status: 'status',
    rewardAmountWrf: 'rewardAmountWrf',
  },
  REFERRAL_STATUS: { PENDING: 'pending', ACTIVATED: 'activated', REWARDED: 'rewarded' },
}));

jest.mock('../../database/connection.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (p: Pred) => {
          const rows = mockTable.filter((r) => mockMatches(r, p)).map((r) => ({ ...r }));
          const thenable = Promise.resolve(rows) as Promise<Row[]> & { limit: (n: number) => Promise<Row[]> };
          thenable.limit = (n: number) => Promise.resolve(rows.slice(0, n));
          return thenable;
        },
      }),
    }),
    insert: () => ({
      values: async (v: Row) => {
        mockTable.push({ id: `id-${mockTable.length + 1}`, rewardAmountWrf: 0, refereeAddress: null, ...v });
      },
    }),
    update: () => ({
      set: (patch: Row) => ({
        where: (p: Pred) => ({
          returning: async () => {
            const hit = mockTable.filter((r) => mockMatches(r, p));
            for (const r of hit) Object.assign(r, patch);
            return hit.map((r) => ({ id: r.id }));
          },
        }),
      }),
    }),
  },
}));

jest.mock('../../server/utils/metrics.js', () => ({ recordReferralFunnelStep: jest.fn() }));
jest.mock('../../server/utils/logger.js', () => {
  const noop = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  return { appLogger: noop, securityLogger: noop, logError: jest.fn() };
});

import router from '../../server/routes/referral-routes';

const REFERRER = '0xAAAA000000000000000000000000000000000001';
const REFEREE = '0xbbbb000000000000000000000000000000000002';
const STRANGER = '0xcccc000000000000000000000000000000000003';

function bearer(address: string): string {
  const token = jwt.sign(
    { sub: address, address, role: 'wallet', type: 'access' },
    process.env.JWT_SECRET as string,
    { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 600 },
  );
  return `Bearer ${token}`;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/referrals', router);
  // Stand-in for the entrypoint's token-gated catch-all.
  app.use('/api', (_req, res) => res.status(401).json({ success: false, error: 'AUTH_REQUIRED' }));
  return app;
}

async function generate(app: express.Express): Promise<string> {
  const res = await request(app)
    .post('/api/referrals/generate')
    .set('Authorization', bearer(REFERRER))
    .send({ walletAddress: REFERRER });
  expect(res.status).toBe(201);
  return res.body.data.referralCode;
}

beforeEach(() => {
  mockTable.length = 0;
});

describe('/api/referrals mounted honestly (#1178)', () => {
  it('garbage path is the router\'s 404, not the catch-all 401', async () => {
    const res = await request(makeApp()).get('/api/referrals/nonexistent-zzz');
    expect(res.status).toBe(404);
  });

  it('POST /generate without a token is 401; for another wallet is 403; for yourself creates a code', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/referrals/generate').send({ walletAddress: REFERRER })).status).toBe(401);

    const other = await request(app)
      .post('/api/referrals/generate')
      .set('Authorization', bearer(STRANGER))
      .send({ walletAddress: REFERRER });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('REFERRAL_WALLET_MISMATCH');
    expect(mockTable).toHaveLength(0);

    const code = await generate(app);
    expect(code).toMatch(/^[0-9A-F]{16}$/);
    expect(mockTable[0].referrerAddress).toBe(REFERRER.toLowerCase());

    // Idempotent, and the address comparison is case-insensitive.
    const again = await request(app)
      .post('/api/referrals/generate')
      .set('Authorization', bearer(REFERRER.toLowerCase()))
      .send({ walletAddress: REFERRER });
    expect(again.status).toBe(200);
    expect(again.body.data.referralCode).toBe(code);
  });

  it('POST /activate without a token is 401 and changes nothing', async () => {
    const app = makeApp();
    const code = await generate(app);
    const res = await request(app).post('/api/referrals/activate').send({ referralCode: code, refereeAddress: REFEREE });
    expect(res.status).toBe(401);
    expect(mockTable[0].status).toBe('pending');
  });

  it('POST /activate with a token for a different wallet is 403 and changes nothing', async () => {
    const app = makeApp();
    const code = await generate(app);
    const res = await request(app)
      .post('/api/referrals/activate')
      .set('Authorization', bearer(STRANGER))
      .send({ referralCode: code, refereeAddress: REFEREE });
    expect(res.status).toBe(403);
    expect(mockTable[0].status).toBe('pending');
  });

  it.each([
    ['refereeAddress (mobile)', 'refereeAddress'],
    ['walletAddress (web)', 'walletAddress'],
  ])('activation via %s records activated and never a paid reward', async (_label, field) => {
    const app = makeApp();
    const code = await generate(app);
    const res = await request(app)
      .post('/api/referrals/activate')
      .set('Authorization', bearer(REFEREE))
      .send({ referralCode: code, [field]: REFEREE });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('activated');
    expect(res.body.data.status).not.toBe('rewarded');
    expect(res.body.data.rewardAmountWrf ?? 0).toBe(0);
    expect(res.body.data.reward).toEqual({ state: 'not_paid', reason: 'no on-chain referral payout exists' });

    const row = mockTable[0];
    expect(row.status).toBe('activated');
    expect(row.rewardAmountWrf).toBeNull();
    expect(row).not.toHaveProperty('rewardedAt');
    expect(row.refereeAddress).toBe(REFEREE);

    const stats = await request(app).get(`/api/referrals/stats/${REFERRER}`);
    expect(stats.status).toBe(200);
    expect(stats.body.data).toMatchObject({
      totalReferrals: 1,
      byStatus: { activated: 1 },
      pendingActivations: 1,
      earnedWrf: 0,
      totalRewardsWrf: 0,
    });

    // A second activation of the same code is refused.
    const twice = await request(app)
      .post('/api/referrals/activate')
      .set('Authorization', bearer(REFEREE))
      .send({ referralCode: code, refereeAddress: REFEREE });
    expect(twice.status).toBe(404);
  });

  it('self-referral is still refused (case-insensitive)', async () => {
    const app = makeApp();
    const code = await generate(app);
    const res = await request(app)
      .post('/api/referrals/activate')
      .set('Authorization', bearer(REFERRER.toLowerCase()))
      .send({ referralCode: code, refereeAddress: REFERRER.toUpperCase().replace('0X', '0x') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SELF_REFERRAL_NOT_ALLOWED');
  });
});

describe('live entrypoint wiring (#1178)', () => {
  const entry = readFileSync(path.join(__dirname, '../../server/enhanced_unified_api_optimized.ts'), 'utf8');
  const routerSrc = readFileSync(path.join(__dirname, '../../server/routes/referral-routes.ts'), 'utf8');

  it('mounts /api/referrals through safeMount', () => {
    expect(entry).toMatch(/^\s*safeMount\('\/api\/referrals',\s*'\.\/routes\/referral-routes'\);/m);
  });

  it.each([
    // proof-card-routes left this list in backend#229 and competition-routes in backend#251: both mounted default-OFF.
    'duel-routes', 'challenge-routes', 'marketplace-routes',
    'academic-routes', 'subscription-routes', 'webhook-routes', 'telemetry-routes', 'contributor-summary-routes',
  ])('does not mount the deferred %s', (mod) => {
    expect(entry).not.toMatch(new RegExp(`['"]\\./routes/${mod}(\\.js)?['"]`));
  });

  it('the router has no path that can write a rewarded status or a reward amount', () => {
    expect(routerSrc).not.toMatch(/REFERRAL_STATUS\.REWARDED/);
    expect(routerSrc).not.toMatch(/rewardedAt:/);
    expect(routerSrc).not.toMatch(/REFERRAL_REWARD_WRF/);
  });
});
