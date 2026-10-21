import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../server/utils/logger', () => ({
  logger: mockLogger,
}));

jest.mock('../../utils/logger', () => ({
  logger: mockLogger,
}));

const passthrough = (_req: any, _res: any, next: any) => next();

jest.mock('../../server/middleware/authMiddleware', () => ({
  requireAuth: passthrough,
}));

jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: passthrough,
  transferLimiter: passthrough,
}));

jest.mock('../../config', () => ({
  jwtSecret: 'test-secret',
}));

const mockFetchCore4Json = jest.fn();
const mockExtractCore4Data = jest.fn((payload: any) => payload);
const mockForwardCore4Headers = jest.fn(
  (headers: Record<string, string> = {}, extra: Record<string, string> = {}) => ({
    ...(headers.authorization ? { authorization: headers.authorization } : {}),
    ...extra,
  }),
);
const mockExecuteQuery = jest.fn();

jest.mock('../../database/index.js', () => ({
  executeQuery: mockExecuteQuery,
}));

jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: mockFetchCore4Json,
  extractCore4Data: mockExtractCore4Data,
  forwardCore4Headers: mockForwardCore4Headers,
  sendCore4Unavailable: (
    res: any,
    error: any,
    message = 'Blockchain node unavailable',
  ) =>
    res.status(503).json({
      success: false,
      error: {
        code: 'CORE4_UNAVAILABLE',
        message,
        details:
          error instanceof Error
            ? error.message
            : String(error ?? 'Unknown error'),
      },
      timestamp: new Date().toISOString(),
    }),
  sendCore4Error: (res: any, response: any, fallbackMessage: string) =>
    res.status(response?.status || 502).json({
      success: false,
      error: {
        code: 'CORE4_ERROR',
        message: response?.payload?.error?.message ?? fallbackMessage,
        details: response?.payload ?? null,
      },
      timestamp: new Date().toISOString(),
    }),
  sendNotImplemented: (
    res: any,
    message: string,
    details = 'This backend route has no matching core4 API yet.',
  ) =>
    res.status(501).json({
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message,
        details,
      },
      timestamp: new Date().toISOString(),
    }),
}));

const walletRoutes = require('../../server/routes/wallet-routes');

function mockReq(
  params: Record<string, string> = {},
  body: any = {},
  query: any = {},
  headers: Record<string, string> = {},
  user?: Record<string, any>,
): any {
  return {
    params,
    body,
    query,
    headers,
    method: 'GET',
    url: '/',
    ...(user !== undefined ? { user } : {}),
  };
}

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
    send(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

function getHandler(router: any, method: string, pathSuffix: string): Function {
  for (const layer of router.stack) {
    if (
      layer.route &&
      layer.route.path === pathSuffix &&
      layer.route.methods[method.toLowerCase()]
    ) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${pathSuffix}`);
}

describe('wallet-routes', () => {
  const OWNER = '0x1111111111111111111111111111111111111111';

  beforeEach(() => {
    jest.clearAllMocks();

    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = 'core4-contributor-fixture';
    mockExtractCore4Data.mockImplementation((payload: any) => payload);
    mockExecuteQuery.mockResolvedValue({ rows: [] });
    mockFetchCore4Json.mockImplementation(async (path: string) => {
      if (path === '/addresses/wrf1abc') {
        return {
          ok: true,
          status: 200,
          payload: {
            spendable_balance: '125.5',
            transaction_count: 17,
            nonce: '42',
            first_seen: '2026-03-30T00:00:00.000Z',
            last_active: '2026-03-31T12:00:00.000Z',
            balance_history: [{ balance: '100.0' }],
            pending_transactions: 2,
            data_submissions: 4,
            computational_tasks: 1,
            reputation_score: 88,
          },
        };
      }

      if (path === '/transactions/submit') {
        return {
          ok: true,
          status: 200,
          payload: {
            hash: '0xabc123',
            status: 'confirmed',
            timestamp: '2026-03-31T00:00:00.000Z',
            block_height: 44,
          },
        };
      }

      throw new Error(`Unexpected core4 path: ${path}`);
    });
  });

  describe('POST /api/wallet/mnemonic/generate (folded in from wallet_server.js, #1116)', () => {
    const handler = getHandler(walletRoutes, 'POST', '/mnemonic/generate');

    it('returns a 12-word BIP-39 mnemonic by default and never logs the phrase', async () => {
      const res = mockRes();
      await handler(mockReq({}, {}), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.wordCount).toBe(12);
      expect(res.body.data.strength).toBe(128);
      expect(res.body.data.mnemonic.split(' ')).toHaveLength(12);

      const logged = JSON.stringify(mockLogger.info.mock.calls);
      expect(logged).not.toContain(res.body.data.mnemonic);
    });

    it('honours every valid strength and produces checksum-valid phrases', async () => {
      const { Mnemonic } = require('ethers');
      for (const [strength, words] of [
        [128, 12],
        [160, 15],
        [192, 18],
        [224, 21],
        [256, 24],
      ]) {
        const res = mockRes();
        await handler(mockReq({}, { strength }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.data.wordCount).toBe(words);
        expect(Mnemonic.isValidMnemonic(res.body.data.mnemonic)).toBe(true);
      }
    });

    it('returns 400 for an unsupported strength', async () => {
      const res = mockRes();
      await handler(mockReq({}, { strength: 100 }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Invalid strength parameter');
    });
  });

  describe('POST /api/wallet/mnemonic/validate (folded in from wallet_server.js, #1116)', () => {
    const handler = getHandler(walletRoutes, 'POST', '/mnemonic/validate');
    const validPhrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    it('accepts a checksum-valid phrase', async () => {
      const res = mockRes();
      await handler(mockReq({}, { mnemonic: validPhrase }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({
        valid: true,
        wordCount: 12,
        strength: 128,
      });
    });

    it('rejects a phrase with a bad checksum (right word count, wrong last word)', async () => {
      const res = mockRes();
      await handler(
        mockReq({}, { mnemonic: validPhrase.replace(/about$/, 'abandon') }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.data.valid).toBe(false);
      expect(res.body.data.error).toMatch(/checksum/);
    });

    it('reports an invalid word count without throwing', async () => {
      const res = mockRes();
      await handler(mockReq({}, { mnemonic: 'abandon abandon abandon' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({
        valid: false,
        error: 'Invalid word count',
        actual: 3,
      });
    });

    it('returns 400 when mnemonic is missing', async () => {
      const res = mockRes();
      await handler(mockReq({}, {}), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Invalid input');
    });
  });

  describe('POST /api/wallet/send', () => {
    const CALLER = '0x0000000000000000000000000000000000000a11';
    const callerUser = { sub: CALLER };
    const validPayload = {
      from: CALLER,
      to: '0x0000000000000000000000000000000000000b22',
      amount: '10',
      nonce: '7',
      auth_pubkey: 'a'.repeat(64),
      auth_signature: 'b'.repeat(128),
    };

    it('returns 401 when not authenticated (no req.user)', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'POST', '/send');

      await handler(mockReq({}, validPayload), res);

      expect(res.statusCode).toBe(401);
    });

    it('returns success for a valid transfer — from bound to JWT sub, not body', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'POST', '/send');
      mockFetchCore4Json.mockImplementationOnce(async (_path, options: any) => {
        if (options.headers?.authorization !== 'Bearer core4-contributor-fixture') {
          return {
            ok: false,
            status: 403,
            payload: { error: { code: 'FORBIDDEN', message: 'Invalid API token' } },
          };
        }
        return {
          ok: true,
          status: 200,
          payload: { hash: '0xabc123', status: 'confirmed' },
        };
      });

      await handler(
        mockReq(
          {},
          validPayload,
          {},
          { authorization: 'Bearer backend-jwt-fixture' },
          callerUser,
        ),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.hash).toBe('0xabc123');
      expect(res.body.status).toBe('submitted');
      // from must be the JWT sub claim, never the request body
      expect(mockFetchCore4Json).toHaveBeenCalledWith(
        '/transactions/submit',
        expect.objectContaining({
          method: 'POST',
          headers: {
            authorization: 'Bearer core4-contributor-fixture',
          },
          body: expect.objectContaining({
            from: CALLER,
            to: '0x0000000000000000000000000000000000000b22',
            amount: 10,
            nonce: '7',
            auth_pubkey: 'a'.repeat(64),
            auth_signature: 'b'.repeat(128),
          }),
        }),
      );
      expect(mockForwardCore4Headers).not.toHaveBeenCalled();
    });

    it('keeps unsigned transfers on the honest not-wired path', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'POST', '/send');

      await handler(
        mockReq(
          {},
          { ...validPayload, auth_signature: undefined },
          {},
          { authorization: 'Bearer backend-jwt-fixture' },
          callerUser,
        ),
        res,
      );

      expect(res.statusCode).toBe(501);
      expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('rejects a signed from address that differs from JWT sub', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'POST', '/send');

      await handler(
        mockReq(
          {},
          { ...validPayload, from: '0x0000000000000000000000000000000000000c33' },
          {},
          { authorization: 'Bearer backend-jwt-fixture' },
          callerUser,
        ),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('returns 400 when to is missing', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'POST', '/send');

      await handler(
        mockReq({}, { ...validPayload, to: undefined }, {}, {}, callerUser),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when amount is zero', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'POST', '/send');

      await handler(
        mockReq({}, { ...validPayload, amount: '0' }, {}, {}, callerUser),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when to address format is not a core4 hex address', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'POST', '/send');

      await handler(
        mockReq(
          {},
          { ...validPayload, to: 'wrf2def' },
          {},
          {},
          callerUser,
        ),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error.message).toContain('core4 hex addresses');
    });

    it('forwards the client-signed integer base units without conversion', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'POST', '/send');

      await handler(
        mockReq({}, { ...validPayload, amount: '1000' }, {}, {}, callerUser),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(mockFetchCore4Json).toHaveBeenCalledWith(
        '/transactions/submit',
        expect.objectContaining({
          body: expect.objectContaining({ amount: 1000 }),
        }),
      );
    });
  });

  describe('POST /api/wallet/estimate-gas', () => {
    const handler = getHandler(walletRoutes, 'POST', '/estimate-gas');
    const TO = '0x0000000000000000000000000000000000000b22';

    it.each([
      ['100000000', '100000'],
      ['25000000000', '25000000'],
      [100000000, '100000'],
      ['1999', '1'],
      ['999', '0'],
    ])('labels the base-unit display figure for amount %p as non-authoritative', async (
      amount,
      feeBaseUnits,
    ) => {
      const res = mockRes();

      await handler(mockReq({}, { from: OWNER, to: TO, amount }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        amountBaseUnits: String(amount),
        feeBaseUnits,
        unit: 'integer base units',
        currency: 'WRF',
        authoritative: false,
        source: 'backend-display-rule',
        rule: 'floor(amountBaseUnits/1000)',
        note: expect.stringContaining('not debited on chain'),
      });
      expect(typeof res.body.feeBaseUnits).toBe('string');
      expect(res.body).not.toHaveProperty('fee');
      expect(res.body).not.toHaveProperty('from');
    });

    it.each([
      [{ amount: '1000' }],
      [{ to: 'not-an-address', amount: '1000' }],
      [{ to: TO, amount: 'NaN' }],
      [{ to: TO, amount: '0' }],
      [{ to: TO, amount: '-1000' }],
      [{ to: TO, amount: '1.5' }],
      [{ to: TO, amount: '0.001' }],
      [{ to: TO, amount: 1.5 }],
      [{ to: TO, amount: '1e9' }],
      [{ to: TO, amount: '9007199254740992' }],
    ])('rejects non-base-unit or invalid estimate input %#', async (body) => {
      const res = mockRes();

      await handler(mockReq({}, body), res);

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('base units');
      expect(res.body).not.toHaveProperty('feeBaseUnits');
    });
  });

  describe('POST /api/wallet/:address/transactions', () => {
    const OWNER = '0x0000000000000000000000000000000000000a11';
    const OTHER = '0x0000000000000000000000000000000000000c33';
    const ownerUser = { sub: OWNER };

    it('returns 403 when caller is not authenticated (#824)', async () => {
      const res = mockRes();
      const handler = getHandler(
        walletRoutes,
        'POST',
        '/:address/transactions',
      );

      await handler(
        mockReq({ address: OWNER }, { to: OTHER, amount: '10' }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body.message).toContain('Forbidden');
    });

    it('returns 403 when authenticated caller does not own the from address (#824)', async () => {
      const res = mockRes();
      const handler = getHandler(
        walletRoutes,
        'POST',
        '/:address/transactions',
      );

      // Caller owns OWNER but tries to send from OTHER
      await handler(
        mockReq(
          { address: OTHER },
          { to: OWNER, amount: '10' },
          {},
          {},
          ownerUser,
        ),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body.message).toContain('Forbidden');
    });

    it('returns 400 when to is missing (caller owns address)', async () => {
      const res = mockRes();
      const handler = getHandler(
        walletRoutes,
        'POST',
        '/:address/transactions',
      );

      await handler(
        mockReq(
          { address: OWNER },
          {
            from: OWNER,
            amount: '10',
            nonce: '7',
            auth_pubkey: 'a'.repeat(64),
            auth_signature: 'b'.repeat(128),
          },
          {},
          {},
          ownerUser,
        ),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('submits the legacy transaction path through core4 when caller owns address', async () => {
      const res = mockRes();
      const handler = getHandler(
        walletRoutes,
        'POST',
        '/:address/transactions',
      );

      await handler(
        mockReq(
          { address: OWNER },
          {
            from: OWNER,
            to: '0x0000000000000000000000000000000000000b22',
            amount: '100000001',
            nonce: '7',
            auth_pubkey: 'a'.repeat(64),
            auth_signature: 'b'.repeat(128),
          },
          {},
          {},
          ownerUser,
        ),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.hash).toBe('0xabc123');
      expect(mockFetchCore4Json).toHaveBeenCalledWith(
        '/transactions/submit',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            from: OWNER,
            to: '0x0000000000000000000000000000000000000b22',
            amount: 100000001,
          }),
        }),
      );
    });
  });

  describe('GET /api/wallet/:address (Reader-backed, #1282)', () => {
    const OTHER = '0x2222222222222222222222222222222222222222';
    const READER = 'reader-token';
    let previousReader: string | undefined;

    beforeEach(() => {
      previousReader = process.env.WRFCOIN_READER_TOKEN;
      process.env.WRFCOIN_READER_TOKEN = READER;
    });

    afterEach(() => {
      if (previousReader === undefined) delete process.env.WRFCOIN_READER_TOKEN;
      else process.env.WRFCOIN_READER_TOKEN = previousReader;
    });

    it('own address → 200 mapped into the wallet shape, core4 called with the Reader bearer', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address');

      await handler(mockReq({ address: 'wrf1abc' }, {}, {}, {}, { sub: 'WRF1ABC' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.address).toBe('wrf1abc');
      expect(res.body.balance).toBe('125.5');
      expect(res.body.transactions).toBe(17);
      expect(res.body.reputationScore).toBe(88);
      expect(res.body.balanceHistory).toEqual([{ balance: '100.0' }]);
      expect(mockFetchCore4Json).toHaveBeenCalledTimes(1);
      expect(mockFetchCore4Json).toHaveBeenCalledWith('/addresses/wrf1abc', {
        headers: { authorization: `Bearer ${READER}` },
      });
    });

    it('never forwards the caller JWT or API key to core4; only tracing headers pass through', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address');

      await handler(mockReq({ address: 'wrf1abc' }, {}, {}, {
        authorization: 'Bearer backend-user-jwt',
        'x-api-key': 'caller-key',
        'x-request-id': 'req-1',
      }, { sub: 'wrf1abc' }), res);

      expect(res.statusCode).toBe(200);
      expect(mockForwardCore4Headers).not.toHaveBeenCalled();
      expect(mockFetchCore4Json).toHaveBeenCalledWith('/addresses/wrf1abc', {
        headers: { 'x-request-id': 'req-1', authorization: `Bearer ${READER}` },
      });
      const sent = JSON.stringify(mockFetchCore4Json.mock.calls);
      expect(sent).not.toContain('backend-user-jwt');
      expect(sent).not.toContain('caller-key');
    });

    it('another user\'s address → 403 and core4 is never called (no confused deputy)', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address');

      await handler(mockReq({ address: OTHER }, {}, {}, {
        authorization: 'Bearer backend-user-jwt',
      }, { sub: OWNER }), res);

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe(true);
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('no authenticated user → 401 and core4 is never called', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address');

      await handler(mockReq({ address: OWNER }), res);

      expect(res.statusCode).toBe(401);
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('Reader token unset → 503 CORE4_READER_CREDENTIAL_UNCONFIGURED and core4 is never called', async () => {
      delete process.env.WRFCOIN_READER_TOKEN;
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address');

      await handler(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body.error.code).toBe('CORE4_READER_CREDENTIAL_UNCONFIGURED');
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/wallet/:address on-chain earned total and reward split (S10)', () => {
    let previousReader: string | undefined;
    // Verbatim shape of core4 get_address_compat data (chain.rs) incl. contribution_rewards_response.
    const core4Account = (over: Record<string, unknown> = {}) => ({
      ok: true,
      status: 200,
      payload: { ok: true, data: {
        address: OWNER, balance: '900', nonce: '3', stake_required: '0', stake_locked: '0',
        spendable_balance: '900', earned_balance_total: '5000000',
        contribution_rewards: {
          real_paid: '4500000', real_pending: '250000', synthetic_paid: '100000', unclassified_paid: '0',
          real_decision_count: 9, synthetic_decision_count: 1, unclassified_decision_count: 0,
        },
        ...over,
      }, error: null },
    });
    beforeEach(() => {
      previousReader = process.env.WRFCOIN_READER_TOKEN; process.env.WRFCOIN_READER_TOKEN = 'reader-token';
      mockExtractCore4Data.mockImplementation((payload: any) => payload?.data ?? payload); // the real {ok,data} unwrap
    });
    afterEach(() => { if (previousReader === undefined) delete process.env.WRFCOIN_READER_TOKEN; else process.env.WRFCOIN_READER_TOKEN = previousReader; });
    const get = async () => {
      const res = mockRes();
      await getHandler(walletRoutes, 'GET', '/:address')(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);
      return res;
    };

    it('returns the on-chain earned total and the REAL paid/pending contribution rewards (not synthetic)', async () => {
      mockFetchCore4Json.mockResolvedValueOnce(core4Account());
      const res = await get();
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        balance: '900', earned_balance_total: '5000000', earnedBalanceTotal: '5000000',
        weatherRewards: '4500000', weatherRewardsPending: '250000', weatherRewardsUnavailable: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('100000'); // synthetic_paid never leaks in as weather rewards
    });

    it('no contribution_rewards block (older node) -> weatherRewards null WITH a reason, total still real', async () => {
      const r = core4Account(); delete (r.payload.data as any).contribution_rewards;
      mockFetchCore4Json.mockResolvedValueOnce(r);
      const res = await get();
      expect(res.body.weatherRewards).toBeNull();
      expect(res.body.weatherRewardsUnavailable).toMatch(/did not report/);
      expect(res.body.earned_balance_total).toBe('5000000');
    });

    it.each([['-5'], ['1.5'], [12], ['abc'], [null]])('a malformed amount (%p) is null, never coerced', async (bad) => {
      mockFetchCore4Json.mockResolvedValueOnce(core4Account({ earned_balance_total: bad, contribution_rewards: { real_paid: bad, real_pending: bad } }));
      const res = await get();
      const ok = bad === 12; // a non-negative safe integer is accepted as its decimal string
      expect(res.body.earned_balance_total).toBe(ok ? '12' : null);
      expect(res.body.weatherRewards).toBe(ok ? '12' : null);
    });
  });

  describe('GET /api/wallet/:address for a wallet with no chain state yet (#1285)', () => {
    const OTHER = '0x2222222222222222222222222222222222222222';
    let previousReader: string | undefined;

    // The exact body core4 get_address_compat sends via envelope_error when the
    // address parses but has no account state (native-chain launch_api
    // routes/chain.rs): 404, code NOT_FOUND, message "address not found".
    const core4AddressNotFound = () => ({
      ok: false,
      status: 404,
      payload: {
        ok: false,
        data: null,
        error: { code: 'NOT_FOUND', message: 'address not found' },
        meta: { request_id: 'req-core4', api_version: 'v1' },
      },
    });

    beforeEach(() => {
      previousReader = process.env.WRFCOIN_READER_TOKEN;
      process.env.WRFCOIN_READER_TOKEN = 'reader-token';
      mockFetchCore4Json.mockImplementation(async () => core4AddressNotFound());
    });

    afterEach(() => {
      if (previousReader === undefined) delete process.env.WRFCOIN_READER_TOKEN;
      else process.env.WRFCOIN_READER_TOKEN = previousReader;
    });

    it('core4 404 "address not found" → 200 zero-balance account marked exists:false', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address');

      await handler(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        address: OWNER,
        balance: '0',
        spendable_balance: '0',
        earned_balance_total: '0',
        earnedBalanceTotal: '0',
        weatherRewards: '0',
        weatherRewardsPending: '0',
        weatherRewardsUnavailable: null,
        exists: false,
      });
      expect(mockFetchCore4Json).toHaveBeenCalledTimes(1);
    });

    it('a core4 404 with any other body still passes through as 404', async () => {
      const handler = getHandler(walletRoutes, 'GET', '/:address');
      const otherBodies = [
        { ok: false, data: null, error: { code: 'NOT_FOUND', message: 'route not found' } },
        { ok: false, data: null, error: { code: 'ROUTE_NOT_FOUND', message: 'address not found' } },
        { ok: true, data: null, error: { code: 'NOT_FOUND', message: 'address not found' } },
        'address not found',
        null,
      ];

      for (const payload of otherBodies) {
        mockFetchCore4Json.mockResolvedValueOnce({ ok: false, status: 404, payload });
        const res = mockRes();

        await handler(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);

        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.exists).toBeUndefined();
      }
    });

    it('a core4 5xx still passes through as 5xx, whatever its message', async () => {
      mockFetchCore4Json.mockResolvedValueOnce({
        ok: false,
        status: 500,
        payload: {
          ok: false,
          data: null,
          error: { code: 'NOT_FOUND', message: 'address not found' },
        },
      });
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address');

      await handler(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);

      expect(res.statusCode).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.exists).toBeUndefined();
    });

    it('another user\'s address → 403 and core4 is never called, even when it would say "not found"', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address');

      await handler(mockReq({ address: OTHER }, {}, {}, {}, { sub: OWNER }), res);

      expect(res.statusCode).toBe(403);
      expect(res.body.exists).toBeUndefined();
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('Reader token unset → 503, never a synthesized zero balance', async () => {
      delete process.env.WRFCOIN_READER_TOKEN;
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address');

      await handler(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);

      expect(res.statusCode).toBe(503);
      expect(res.body.error.code).toBe('CORE4_READER_CREDENTIAL_UNCONFIGURED');
      expect(res.body.exists).toBeUndefined();
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });
  });

  describe('Reader-backed reads: GET /api/wallet/:address/transactions and /nonce', () => {
    const OTHER = '0x2222222222222222222222222222222222222222';
    const READER = 'reader-token';
    let previousReader: string | undefined;

    beforeEach(() => {
      previousReader = process.env.WRFCOIN_READER_TOKEN;
      process.env.WRFCOIN_READER_TOKEN = READER;
    });

    afterEach(() => {
      if (previousReader === undefined) delete process.env.WRFCOIN_READER_TOKEN;
      else process.env.WRFCOIN_READER_TOKEN = previousReader;
    });

    it('returns only bounded rows supplied by core4 with window metadata', async () => {
      mockFetchCore4Json.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { data: {
          transactions: [{ tx_id: '0xabc', tx_type: 'Transfer', sender: OWNER, block_height: 77 }],
          window_start_height: 50,
          limit: 100,
          offset: 3,
          total_in_window: 1,
          window_limited: true,
        } },
      });
      mockExtractCore4Data.mockImplementationOnce((payload: any) => payload.data);
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address/transactions');

      await handler(mockReq({ address: OWNER }, {}, { limit: '999', offset: '3' }, {}, { sub: OWNER }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        schemaVersion: 1,
        items: [{ txId: '0xabc', blockHeight: 77, type: 'Transfer', from: OWNER, to: null, amount: null }],
        creditItems: [],
        creditTotal: null,
        creditRecordsExamined: null,
        creditScanLimit: null,
        creditLimit: null,
        creditNextCursor: null,
        creditOrder: null,
        windowStartHeight: 50,
        source: 'core4',
        complete: false,
        limit: 100,
        offset: 3,
        totalInWindow: 1,
      });
      expect(mockFetchCore4Json).toHaveBeenCalledWith(
        `/addresses/${OWNER}/transactions?limit=100&offset=3`,
        { headers: { authorization: `Bearer ${READER}` } },
      );
      expect(mockExecuteQuery).not.toHaveBeenCalled();
    });

    it('mounted history preserves paid credit strings, identities and independent pagination', async () => {
      const express = require('express');
      const request = require('supertest');
      const app = express();
      app.use((req: any, _res: any, next: any) => { req.user = { sub: OWNER }; next(); });
      app.use('/api/wallet', walletRoutes);
      const huge = '340282366920938463463374607431768211455';
      mockFetchCore4Json.mockResolvedValueOnce({ ok: true, status: 200, payload: { data: {
        transactions: [{ tx_id: 'real-hash', event_id: 'transaction:real-hash', tx_type: 'Transfer',
          sender: OTHER, from: OTHER, to: OWNER, amount_base_units: '18446744073709551615',
          direction: 'received', counterparty: OTHER, kind: 'transfer', settlement: 'included', block_height: 80 }],
        credit_events: [{ event_id: 'forecast:commit-z', tx_id: null, sender: null, from: null, to: OWNER,
          amount_base_units: huge, direction: 'received', counterparty: null, kind: 'forecast_reward',
          settlement: 'paid', block_height: null, timestamp: null, station_id: 'must-not-leak' }],
        credit_records_examined: 2, credit_scan_limit: 2, credit_limit: 1, credit_next_cursor: 'commit-z', credit_order: 'commit_id_ascending',
        window_start_height: 70, total_in_window: 1,
      } } });
      mockExtractCore4Data.mockImplementationOnce((payload: any) => payload.data);
      const res = await request(app).get(`/api/wallet/${OWNER}/transactions?limit=5&offset=2&creditLimit=1&creditAfter=a%26b`);
      expect(res.status).toBe(200);
      expect(res.body.schemaVersion).toBe(2);
      expect(res.body.complete).toBe(false);
      expect(res.body.items[0]).toMatchObject({ eventId: 'transaction:real-hash', amount: '18446744073709551615', direction: 'received', from: OTHER });
      expect(res.body.creditItems).toEqual([{ eventId: 'forecast:commit-z', txId: null, blockHeight: null,
        timestamp: null, type: 'forecast_reward', from: null, to: OWNER, amount: huge,
        amountBaseUnits: huge, direction: 'received', counterparty: null, kind: 'forecast_reward', settlement: 'paid' }]);
      expect(res.body).toMatchObject({ creditTotal: null, creditRecordsExamined: 2, creditScanLimit: 2,
        creditLimit: 1, creditNextCursor: 'commit-z', creditOrder: 'commit_id_ascending', totalInWindow: 1 });
      expect(mockFetchCore4Json).toHaveBeenCalledWith(`/addresses/${OWNER}/transactions?limit=5&offset=2&credit_limit=1&credit_after=a%26b`, expect.any(Object));
      expect(mockExecuteQuery).not.toHaveBeenCalled();
    });

    it('keeps malformed new-schema amounts and directions unknown without guessing from sender', async () => {
      mockFetchCore4Json.mockResolvedValueOnce({ ok: true, status: 200, payload: { data: {
        transactions: [{ tx_id: 'unknown', tx_type: 'Reward', sender: OWNER, amount_base_units: 9007199254740992 }],
        credit_events: [],
      } } });
      mockExtractCore4Data.mockImplementationOnce((payload: any) => payload.data);
      const res = mockRes();
      await getHandler(walletRoutes, 'GET', '/:address/transactions')(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);
      expect(res.body.schemaVersion).toBe(2);
      expect(res.body.items[0]).toMatchObject({ direction: 'unknown', amount: null, amountBaseUnits: null, settlement: null });
      expect(res.body.creditItems).toEqual([]);
      expect(res.body.complete).toBe(false);
    });

    it('preserves sparse-page progress and excludes unsupported, pending, malformed or foreign income', async () => {
      const credit = { event_id: 'contribution:a', to: OWNER, amount_base_units: '1', kind: 'weather_reward', direction: 'received', settlement: 'paid' };
      mockFetchCore4Json.mockResolvedValueOnce({ ok: true, status: 200, payload: { data: {
        transactions: [], credit_events: [
          { ...credit, kind: 'achievement_reward' }, { ...credit, settlement: 'pending' },
          { ...credit, amount_base_units: 1 }, { ...credit, amount_base_units: '0' },
          { ...credit, amount_base_units: '1.5' }, { ...credit, to: OTHER },
        ], credit_next_cursor: 'scanned-key', credit_records_examined: 7, credit_scan_limit: 7,
      } } });
      mockExtractCore4Data.mockImplementationOnce((payload: any) => payload.data);
      const res = mockRes();
      await getHandler(walletRoutes, 'GET', '/:address/transactions')(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);
      expect(res.body.creditItems).toEqual([]);
      expect(res.body.creditNextCursor).toBe('scanned-key');
      expect(res.body.creditTotal).toBeNull();
      expect(res.body.complete).toBe(false);
    });

    it('own address (case-insensitive) → 200, core4 called with the server Reader token and never the caller JWT', async () => {
      mockFetchCore4Json.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { data: { transactions: [] } },
      });
      mockExtractCore4Data.mockImplementationOnce((payload: any) => payload.data);
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address/transactions');
      const mixedCase = '0xAbCdEf0000000000000000000000000000000001';

      await handler(mockReq({ address: mixedCase }, {}, {}, {
        authorization: 'Bearer backend-user-jwt',
        'x-api-key': 'caller-key',
        'x-request-id': 'req-1',
      }, { sub: mixedCase.toLowerCase() }), res);

      expect(res.statusCode).toBe(200);
      expect(mockFetchCore4Json).toHaveBeenCalledTimes(1);
      expect(mockFetchCore4Json).toHaveBeenCalledWith(
        `/addresses/${mixedCase}/transactions?limit=25&offset=0`,
        { headers: { 'x-request-id': 'req-1', authorization: `Bearer ${READER}` } },
      );
    });

    it('another user\'s address → 403 and core4 is never called (no confused deputy)', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address/transactions');

      await handler(mockReq({ address: OTHER }, {}, { limit: '100', offset: '0' }, {}, { sub: OWNER }), res);

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe(true);
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('no authenticated user → 401 and core4 is never called', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address/transactions');

      await handler(mockReq({ address: OWNER }), res);

      expect(res.statusCode).toBe(401);
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('keeps the honest wallet.history gap for an older core4 node', async () => {
      mockFetchCore4Json.mockResolvedValueOnce({ ok: false, status: 404, payload: null });
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address/transactions');

      await handler(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);

      expect(res.statusCode).toBe(501);
      expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
      expect(res.body.error.details).toContain('wallet.history');
      expect(mockExecuteQuery).not.toHaveBeenCalled();
    });

    it('Reader token unset → 503 on every Reader-backed read, core4 never called, one warning logged', async () => {
      delete process.env.WRFCOIN_READER_TOKEN;
      // The warn-once latch is module state; load a fresh copy so earlier
      // 503 tests in this file cannot have already tripped it.
      let freshRoutes: any;
      jest.isolateModules(() => {
        freshRoutes = require('../../server/routes/wallet-routes');
      });
      const paths = ['/:address', '/:address/transactions', '/:address/nonce', '/:address/nfts'];

      for (const path of paths) {
        const res = mockRes();
        await getHandler(freshRoutes, 'GET', path)(
          mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }),
          res,
        );
        expect(res.statusCode).toBe(503);
        expect(res.body.error.code).toBe('CORE4_READER_CREDENTIAL_UNCONFIGURED');
      }
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
      const readerWarnings = mockLogger.warn.mock.calls.filter(([msg]) =>
        String(msg).includes('WRFCOIN_READER_TOKEN'),
      );
      expect(readerWarnings).toHaveLength(1);
    });

    it('nonce: own address → 200 with the Reader bearer', async () => {
      mockFetchCore4Json.mockResolvedValueOnce({ ok: true, status: 200, payload: { nonce: 9 } });
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address/nonce');

      await handler(mockReq({ address: OWNER }, {}, {}, { authorization: 'Bearer backend-user-jwt' }, { sub: OWNER }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ address: OWNER, nonce: '9' });
      expect(mockFetchCore4Json).toHaveBeenCalledWith(
        `/addresses/${OWNER}`,
        { headers: { authorization: `Bearer ${READER}` } },
      );
    });

    it('nonce: another user\'s address → 403 and core4 is never called', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address/nonce');

      await handler(mockReq({ address: OTHER }, {}, {}, {}, { sub: OWNER }), res);

      expect(res.statusCode).toBe(403);
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('nonce: no authenticated user → 401 and core4 is never called', async () => {
      const res = mockRes();
      const handler = getHandler(walletRoutes, 'GET', '/:address/nonce');

      await handler(mockReq({ address: OWNER }), res);

      expect(res.statusCode).toBe(401);
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/wallet/:address/nfts (Reader-backed, #1282)', () => {
    const OTHER = '0x2222222222222222222222222222222222222222';
    const READER = 'reader-token';
    let previousReader: string | undefined;

    beforeEach(() => {
      previousReader = process.env.WRFCOIN_READER_TOKEN;
      process.env.WRFCOIN_READER_TOKEN = READER;
    });

    afterEach(() => {
      if (previousReader === undefined) delete process.env.WRFCOIN_READER_TOKEN;
      else process.env.WRFCOIN_READER_TOKEN = previousReader;
    });

    it('returns only owner-filtered records supplied by core4', async () => {
      const handler = getHandler(walletRoutes, 'GET', '/:address/nfts');
      const upstreamNft = {
        id: 'nft-chain-7',
        owner: OWNER,
        creator: OWNER,
        metadata: { name: 'Observed storm cell', image: 'ipfs://bafy-real' },
        verified: false,
        created_at: 1700000000,
      };
      mockFetchCore4Json.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { items: [upstreamNft], total: 1, limit: 10, offset: 0 },
      });
      const res = mockRes();

      await handler(mockReq({ address: OWNER }, {}, { limit: '10' }, { authorization: 'Bearer backend-user-jwt' }, { sub: OWNER }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual([upstreamNft]);
      expect(res.body.source).toBe('core4:/nft/list');
      expect(JSON.stringify(res.body)).not.toContain('assets.wrfcoin.dev');
      expect(mockFetchCore4Json).toHaveBeenCalledWith('/nft/list', {
        headers: { authorization: `Bearer ${READER}` },
        query: { owner: OWNER, limit: 10, offset: 0 },
      });
      expect(JSON.stringify(mockFetchCore4Json.mock.calls)).not.toContain('backend-user-jwt');
    });

    it('preserves an upstream-derived empty collection', async () => {
      mockFetchCore4Json.mockResolvedValueOnce({
        ok: true,
        status: 200,
        payload: { items: [], total: 0, limit: 10, offset: 0 },
      });
      const res = mockRes();
      await getHandler(
        walletRoutes,
        'GET',
        '/:address/nfts',
      )(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('returns a typed error when core4 fails', async () => {
      mockFetchCore4Json.mockResolvedValueOnce({
        ok: false,
        status: 502,
        payload: { error: { message: 'core4 read failed' } },
      });
      const res = mockRes();
      await getHandler(
        walletRoutes,
        'GET',
        '/:address/nfts',
      )(mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }), res);
      expect(res.statusCode).toBe(502);
      expect(res.body.error).toMatchObject({
        code: 'CORE4_ERROR',
        message: 'core4 read failed',
      });
    });
  
    it('another user\'s address → 403 and core4 is never called', async () => {
      const res = mockRes();
      await getHandler(walletRoutes, 'GET', '/:address/nfts')(
        mockReq({ address: OTHER }, {}, {}, {}, { sub: OWNER }),
        res,
      );
      expect(res.statusCode).toBe(403);
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('Reader token unset → 503 and core4 is never called', async () => {
      delete process.env.WRFCOIN_READER_TOKEN;
      const res = mockRes();
      await getHandler(walletRoutes, 'GET', '/:address/nfts')(
        mockReq({ address: OWNER }, {}, {}, {}, { sub: OWNER }),
        res,
      );
      expect(res.statusCode).toBe(503);
      expect(res.body.error.code).toBe('CORE4_READER_CREDENTIAL_UNCONFIGURED');
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/wallet/:address/data', () => {
    it('maps only persisted submission fields and marks chain fields unavailable', async () => {
      const handler = getHandler(walletRoutes, 'GET', '/:address/data');
      mockExecuteQuery.mockResolvedValueOnce({
        rows: [{ total_count: 1 }],
      });
      mockExecuteQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 42,
            station_id: 'station-real-1',
            reward_amount: '1.25000000',
            quality_score: 98,
            source: 'mobile',
            submitted_at: '2026-09-17T12:34:56.000Z',
          },
        ],
      });
      const res = mockRes();

      await handler(mockReq({ address: OWNER }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual([
        {
          submissionId: '42',
          timestamp: '2026-09-17T12:34:56.000Z',
          dataType: 'mobile',
          reward: '1.25000000',
          stationId: 'station-real-1',
          qualityScore: 98,
        },
      ]);
      expect(res.body.unavailable).toEqual([
        'dataHash',
        'status',
        'blockHeight',
      ]);
      expect(mockExecuteQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM weather_submissions ws'),
        [OWNER, 25, 0],
      );
      expect(res.body.pagination.total).toBe(1);
    });

    it('preserves total when an offset page has no rows', async () => {
      mockExecuteQuery.mockResolvedValueOnce({
        rows: [{ total_count: 3 }],
      });
      mockExecuteQuery.mockResolvedValueOnce({ rows: [] });
      const res = mockRes();
      await getHandler(
        walletRoutes,
        'GET',
        '/:address/data',
      )(mockReq({ address: OWNER }, {}, { offset: '100' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination.total).toBe(3);
      expect(res.body.pagination.offset).toBe(100);
    });

    it('attributes commit-reveal submissions through the stored contributor', async () => {
      mockExecuteQuery.mockResolvedValueOnce({
        rows: [{ total_count: 1 }],
      });
      mockExecuteQuery.mockResolvedValueOnce({ rows: [] });
      const res = mockRes();

      await getHandler(
        walletRoutes,
        'GET',
        '/:address/data',
      )(mockReq({ address: OWNER }), res);

      expect(res.statusCode).toBe(200);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
      for (const [sql, params] of mockExecuteQuery.mock.calls) {
        expect(sql).toContain(
          'LEFT JOIN weather_commitments wc ON wc.id = ws.commitment_id',
        );
        expect(sql).toContain('LOWER(wc.contributor) = LOWER($1)');
        expect(params[0]).toBe(OWNER);
      }
    });

    it('returns typed unavailable when canonical storage fails', async () => {
      mockExecuteQuery.mockRejectedValueOnce(new Error('database offline'));
      const res = mockRes();
      await getHandler(
        walletRoutes,
        'GET',
        '/:address/data',
      )(mockReq({ address: OWNER }), res);
      expect(res.statusCode).toBe(503);
      expect(res.body).toMatchObject({
        success: false,
        unavailable: true,
        error: {
          code: 'DATABASE_UNAVAILABLE',
          details: 'database offline',
        },
      });
    });
  });
});
