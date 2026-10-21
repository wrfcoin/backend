/**
 * #910 — a real backend-to-core4 boundary check.
 *
 * There is deliberately no mock server here: this asserts against a live
 * `launch_api`. It is opt-in via `WRFCOIN_CORE4_URL` + `WRFCOIN_OPERATOR_TOKEN`
 * and **skips** when they are absent, rather than throwing.
 *
 * Skipping rather than failing is the whole point: this file is collected by the
 * canonical gate (`__tests__/​**​/*.test.ts`), so a module-scope `throw` would turn
 * `npm test` red on every machine without a core4 node — which is every machine,
 * by default. An opt-in integration check must be inert when it is not opted into.
 *
 * The ONE place a skip must be a hard failure is the dedicated CI job that
 * exists to run this live: it sets `WRFCOIN_REQUIRE_LIVE_CORE4=1`, so losing
 * the env there throws instead of reporting a vacuous green skip.
 *
 * The `core4-http-contract` job in `.github/workflows/ci.yml` starts an
 * isolated launch_api on the CT102 self-hosted runner and runs this file with
 * the env supplied — the live assertions execute on every backend PR.
 */
import { describe, expect, jest, test } from '@jest/globals';
import { createWeatherCommitRevealService } from '../../server/routes/weather-commit-reveal-routes.js';

// The governance router imports the app database module; the governance list
// and status routes never touch it, and this job has no database.
jest.mock('../../server/db.js', () => ({
  db: { execute: jest.fn(), select: jest.fn(), update: jest.fn(), insert: jest.fn() },
}));

/**
 * The opt-in predicate, extracted so it can be tested against inputs it did
 * NOT read at module scope (#990 review: the previous wiring test compared
 * `live` to its own definition and could not fail).
 */
export const isLiveConfigured = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(env.WRFCOIN_CORE4_URL && env.WRFCOIN_OPERATOR_TOKEN);

const core4BaseUrl = process.env.WRFCOIN_CORE4_URL;
const core4Token = process.env.WRFCOIN_OPERATOR_TOKEN;
const live = isLiveConfigured(process.env);

if (!live && process.env.WRFCOIN_REQUIRE_LIVE_CORE4 === '1') {
  throw new Error('WRFCOIN_CORE4_URL and WRFCOIN_OPERATOR_TOKEN are required for the live core4 contract');
}

const db = {
  async execute() {
    return { rows: [] as Record<string, unknown>[] };
  },
};

const describeLive = live ? describe : describe.skip;

describeLive('live backend to core4 HTTP contract (#910)', () => {
  test('backend NFT reads use the real Reader credential while a caller JWT is refused (#1284)', async () => {
    const readerToken = process.env.WRFCOIN_READER_TOKEN;
    expect(readerToken).toBeTruthy(); // CI must configure a distinct Reader role.
    expect(readerToken).not.toBe(core4Token);
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const jwt = (await import('jsonwebtoken')).default;
    const oldUrl = process.env.CORE4_API_URL;
    const oldSecret = process.env.JWT_SECRET;
    const fixtureSecret = 'test-only-live-core4-reader-wallet-jwt-000000000000';
    process.env.CORE4_API_URL = core4BaseUrl;
    process.env.JWT_SECRET = fixtureSecret;
    try {
      const caller = jwt.sign({ sub: 'contract-user', role: 'user', type: 'access' }, fixtureSecret, {
        algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m',
      });
      const refused = await fetch(`${core4BaseUrl}/nft/list`, { headers: { Authorization: `Bearer ${caller}` } });
      expect(refused.status).toBe(403);
      const direct = await fetch(`${core4BaseUrl}/nft/list`, { headers: { Authorization: `Bearer ${readerToken}` } });
      expect(direct.ok).toBe(true);
      const directBody = await direct.json() as any;
      const directItems = (directBody.data ?? directBody).items;
      expect(Array.isArray(directItems)).toBe(true);
      const mod = await import('../../server/routes/nft-routes.js');
      const app = express();
      app.use('/api/nft', (mod as any).default ?? mod);
      const result = await supertest(app).get('/api/nft').set('authorization', `Bearer ${caller}`)
        .set('x-api-key', 'test-only-caller-api-key');
      expect(result.status).toBe(200);
      // This boundary case proves Reader authentication. Populated catalog
      // projection and offset pagination are a separate existing gap (#1319).
      expect(Array.isArray(result.body.data)).toBe(true);
      expect(JSON.stringify(result.body)).not.toContain(readerToken);
    } finally {
      if (oldUrl === undefined) delete process.env.CORE4_API_URL; else process.env.CORE4_API_URL = oldUrl;
      if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
    }
  });

  test('launch_api health is live, not a manufactured fixture', async () => {
    const response = await fetch(`${core4BaseUrl}/health`, {
      headers: { Authorization: `Bearer ${core4Token}` },
    });
    expect(response.ok).toBe(true);
    expect((await response.json() as { status?: unknown }).status).toBe('ok');
  });

  test('backend consumes core4 blockchain envelope and numeric height', async () => {
    // core4 registers `/blockchain` (native-chain/src/bin/launch_api/routes/mod.rs).
    // There is no `/api/blockchain/height` route — asserting against it would
    // fail against any real node.
    const response = await fetch(`${core4BaseUrl}/blockchain`, {
      headers: { Authorization: `Bearer ${core4Token}` },
    });
    expect(response.ok).toBe(true);
    const envelope = await response.json() as { ok?: unknown; data?: { height?: unknown } };
    expect(envelope.ok).toBe(true);
    expect(typeof envelope.data?.height).toBe('number');

    const service = createWeatherCommitRevealService({ db, core4BaseUrl, core4Token });
    await expect(service.expireStaleCommitments()).resolves.toEqual(expect.any(Number));
  });

  // backend#1242: the list is a paginated object, and the backend must read it
  // as one. This isolated node has no funded proposer or deterministic block
  // inclusion, so it asserts the live SHAPE and the pagination round trip
  // rather than a created proposal.
  test('core4 GET /governance/proposals answers {total, offset, limit, proposals} and honours limit/offset', async () => {
    const response = await fetch(`${core4BaseUrl}/governance/proposals?offset=0&limit=7`, {
      headers: { Authorization: `Bearer ${core4Token}` },
    });
    expect(response.ok).toBe(true);
    const page = await response.json() as Record<string, unknown>;
    expect(Array.isArray(page)).toBe(false);
    expect(page).toEqual(expect.objectContaining({
      total: expect.any(Number),
      offset: 0,
      limit: 7,
      proposals: expect.any(Array),
    }));
  });

  test('backend /governance/proposals and /status read the live page, not an empty list', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    process.env.CORE4_API_URL = core4BaseUrl;
    const mod = await import('../../server/routes/governance-routes.js');
    const app = express();
    app.use('/governance', (mod as any).default ?? mod);

    const direct = await (await fetch(`${core4BaseUrl}/governance/proposals?offset=0&limit=500`, {
      headers: { Authorization: `Bearer ${core4Token}` },
    })).json() as { total: number; proposals: unknown[] };

    const list = await supertest(app).get('/governance/proposals?limit=7');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ success: true, total: direct.total, offset: 0, limit: 7 });
    expect(list.body.count).toBe(Math.min(7, direct.total));
    expect(list.body.proposals).toHaveLength(list.body.count);
    // Mobile's ProposalModel requires string title/description (codex round 18).
    for (const item of list.body.proposals as Array<Record<string, unknown>>) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.title).toBe('string');
      expect(typeof item.description).toBe('string');
    }

    const status = await supertest(app).get('/governance/status');
    expect(status.status).toBe(200);
    expect(status.body.data.proposalCount).toBe(direct.total);
  });
});

describe('live core4 contract opt-in wiring (#910)', () => {
  // What this does NOT pin: that the `live` const above actually calls
  // isLiveConfigured — a bypass at the assignment site would not fail here.
  // It DOES pin the predicate itself: weakening it to opt in on the URL
  // alone (the exact mutation applied in the #990 review) fails case 2.
  test.each([
    [{}, false],
    [{ WRFCOIN_CORE4_URL: 'http://127.0.0.1:8556' }, false],
    [{ WRFCOIN_OPERATOR_TOKEN: 'token' }, false],
    [{ WRFCOIN_CORE4_URL: 'http://127.0.0.1:8556', WRFCOIN_OPERATOR_TOKEN: 'token' }, true],
  ])('isLiveConfigured(%j) === %p', (env, expected) => {
    expect(isLiveConfigured(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});
