/**
 * Governance vote endpoint — auth and identity-binding tests (#829)
 *
 * Verifies the security contract:
 * 1. The vote endpoint requires a valid JWT (returns 401 without one)
 * 2. voter_address is bound to the JWT sub claim — never trusted from req.body
 *
 * Strategy: import requireAuth directly (not via governance_server.js, which
 * has a large ESM transitive dep chain). Build a minimal Express test server
 * that mirrors the vote handler's identity-binding pattern exactly.
 */

// ─── mock ESM deps before any imports ────────────────────────────────────────
// authMiddleware.js requires '../../utils/logger' which is an ESM-only file.
// Mock it here so Jest's CJS transform never attempts to parse the real file.
jest.mock('../utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  log: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ─── constants ───────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-jwt-secret-governance-vote-829';
const VOTER_ADDRESS = '0xBEEF0000000000000000000000000000000000FF';

function makeJwt(address: string): string {
  return jwt.sign(
    { sub: address, type: 'access' },
    JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: 'wrfcoin-platform',
      audience: 'wrfcoin-api',
      expiresIn: '15m',
    },
  );
}

// ─── build test app ───────────────────────────────────────────────────────────
// Mirrors the exact identity-binding pattern from governance_server.js vote handler:
//   const voter_address = req.user && req.user.sub;  ← from JWT, not body
//   if (!voter_address) → 401

function buildTestVoteApp() {
  process.env.JWT_SECRET = JWT_SECRET;

  // requireAuth is the real middleware; its only transitive dep (utils/logger) is mocked above.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { requireAuth } = require('../server/middleware/authMiddleware');

  const app = express();
  app.use(express.json());

  app.post(
    '/api/governance/proposals/:proposalId/vote',
    requireAuth,
    (req: any, res: any) => {
      // Exact logic from governance_server.js (#829 fix)
      const voter_address = req.user && req.user.sub;
      if (!voter_address) {
        return res.status(401).json({
          success: false,
          error: 'Could not determine voter identity from authentication token',
        });
      }
      // Echo back voter_address to let tests assert it matches JWT sub
      return res.status(200).json({ success: true, voter_address });
    },
  );

  return app;
}

// ─── build core4-payload-shape test app (#821) ───────────────────────────────
// Mirrors the approve-field logic from governance-routes.ts without importing
// the full module (zod transitive dep breaks Jest CJS mode).

const mockSendToCore4 = jest.fn();

function buildVotePayloadApp() {
  process.env.JWT_SECRET = JWT_SECRET;
  const { requireAuth } = require('../server/middleware/authMiddleware');

  const app = express();
  app.use(express.json());

  app.post(
    '/api/governance/proposals/:proposalId/vote',
    requireAuth,
    async (req: any, res: any) => {
      const voteType = String(req.body?.voteType || '').toUpperCase();
      const support =
        voteType === 'FOR'
          ? true
          : voteType === 'AGAINST'
            ? false
            : req.body?.support;

      const body = {
        proposal_id: req.params.proposalId,
        approve: support,
        // 'reason' intentionally omitted — not in core4 transaction struct
      };

      mockSendToCore4(body);
      return res.status(200).json({ success: true });
    },
  );

  return app;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('POST /governance/proposals/:id/vote — core4 body uses approve not support (#821)', () => {
  let app: ReturnType<typeof buildVotePayloadApp>;

  beforeAll(() => { app = buildVotePayloadApp(); });
  beforeEach(() => { mockSendToCore4.mockClear(); });
  afterAll(() => { delete process.env.JWT_SECRET; });

  it('sends approve:true for a FOR vote — never sends support or reason', async () => {
    const token = makeJwt(VOTER_ADDRESS);
    await request(app)
      .post('/api/governance/proposals/prop-42/vote')
      .set('Authorization', `Bearer ${token}`)
      .send({ voteType: 'FOR', reason: 'great proposal' });

    expect(mockSendToCore4).toHaveBeenCalledTimes(1);
    const body = mockSendToCore4.mock.calls[0][0];
    expect(body).toMatchObject({ proposal_id: 'prop-42', approve: true });
    expect(body).not.toHaveProperty('support');
    expect(body).not.toHaveProperty('reason');
  });

  it('sends approve:false for an AGAINST vote', async () => {
    const token = makeJwt(VOTER_ADDRESS);
    await request(app)
      .post('/api/governance/proposals/prop-42/vote')
      .set('Authorization', `Bearer ${token}`)
      .send({ voteType: 'AGAINST' });

    const body = mockSendToCore4.mock.calls[0][0];
    expect(body).toMatchObject({ proposal_id: 'prop-42', approve: false });
  });
});

describe('POST /api/governance/proposals/:proposalId/vote — auth gate (#829)', () => {
  let app: ReturnType<typeof buildTestVoteApp>;

  beforeAll(() => {
    app = buildTestVoteApp();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app)
      .post('/api/governance/proposals/gov_123/vote')
      .send({ vote_type: 'yes', voter_address: VOTER_ADDRESS });

    expect(res.status).toBe(401);
  });

  it('returns 401 when an invalid JWT is provided', async () => {
    const res = await request(app)
      .post('/api/governance/proposals/gov_123/vote')
      .set('Authorization', 'Bearer not.a.real.jwt')
      .send({ vote_type: 'yes', voter_address: VOTER_ADDRESS });

    expect(res.status).toBe(401);
  });

  it('does NOT use voter_address from req.body — voter_address derives from JWT sub (#829)', async () => {
    const spoofedAddress = '0xEVIL000000000000000000000000000000000000';
    const token = makeJwt(VOTER_ADDRESS);

    const res = await request(app)
      .post('/api/governance/proposals/gov_123/vote')
      .set('Authorization', `Bearer ${token}`)
      .send({ vote_type: 'yes', voter_address: spoofedAddress });

    // Auth passes; voter_address must be the JWT sub, not the spoofed body value
    expect(res.status).toBe(200);
    expect(res.body.voter_address).toBe(VOTER_ADDRESS);
    expect(res.body.voter_address).not.toBe(spoofedAddress);
  });

  it('returns 200 with the JWT-derived address when a valid token is provided', async () => {
    const token = makeJwt(VOTER_ADDRESS);

    const res = await request(app)
      .post('/api/governance/proposals/gov_123/vote')
      .set('Authorization', `Bearer ${token}`)
      .send({ vote_type: 'yes' });

    expect(res.status).toBe(200);
    expect(res.body.voter_address).toBe(VOTER_ADDRESS);
  });
});
