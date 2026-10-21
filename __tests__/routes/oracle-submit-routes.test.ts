import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFetchCore4Json = jest.fn();
const mockForwardCore4Headers = jest.fn(() => ({ authorization: 'Bearer test' }));
const mockRequireAuth = jest.fn((req: any, _res: any, next: any) => {
  req.user = { address: '0x0000000000000000000000000000000000000c03' };
  next();
});

jest.mock('../../server/middleware/authMiddleware', () => ({
  requireAuth: mockRequireAuth,
}));

// #1284: the station-owner guard reads weather_stations.owner_address.
const OWN_WALLET = '0x0000000000000000000000000000000000000c03';
const mockStationOwners: Record<string, string> = {
  'station-mobile-1': OWN_WALLET,
  'station-someone-else': '0x000000000000000000000000000000000000beef',
};
const mockExecuteQuery = jest.fn(async (_sql: string, params: unknown[] = []) => {
  const owner = mockStationOwners[String(params[0])];
  return { rows: owner ? [{ owner_address: owner }] : [] };
});
jest.mock('../../database/connection.js', () => ({
  executeQuery: mockExecuteQuery,
}));

jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: mockFetchCore4Json,
  extractCore4Data: (payload: any) => payload?.data ?? payload,
  forwardCore4Headers: mockForwardCore4Headers,
}));

import oracleSubmitRoutes from '../../server/routes/oracle-submit-routes';
import { computeCommitId } from '../../shared/commit-reveal-hash';
import { buildCommitAuthorizationMessage } from '../../shared/commit-authorization';

const canonicalReading = {
  temperature_c: 72.5,
  humidity_pct: 0,
  pressure_hpa: 0,
  wind_mps: 0,
  rainfall_mm: 0,
};
const expectedCommitHash = computeCommitId({
  data: canonicalReading,
  nonce: 'mobile-nonce',
  stationId: 'station-mobile-1',
  timestamp: 1780056000,
});

function mockReq(body: any = {}, headers: Record<string, string> = {}): any {
  return {
    body,
    headers,
    ip: '127.0.0.1',
    user: { walletAddress: '0x0000000000000000000000000000000000000c03' },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
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

const CONTRIBUTOR_TOKEN = 'core4-contributor-token';
const READER_TOKEN = 'core4-reader-token';

describe('oracle-submit-routes live mount path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = CONTRIBUTOR_TOKEN;
    process.env.WRFCOIN_READER_TOKEN = READER_TOKEN;
    mockFetchCore4Json.mockImplementation(async (path: string) => {
      if (path === '/transactions/contribution/commit') {
        return { ok: true, status: 202, payload: { tx_id: 'commit-tx' } };
      }
      if (path === '/transactions/contribution/reveal') {
        return { ok: true, status: 202, payload: { tx_id: 'reveal-tx' } };
      }
      if (path === `/transactions/commit/${expectedCommitHash}/status`) {
        return {
          ok: true,
          status: 200,
          payload: {
            status: 'revealed_pending_attestation',
            approvals: 0,
            rejections: 0,
            has_quorum: false,
            oracle_quorum: 2,
          },
        };
      }
      if (path === '/addresses/0x0000000000000000000000000000000000000c03') {
        return {
          ok: true,
          status: 200,
          payload: { earned_balance_total: '0' },
        };
      }
      throw new Error(`Unexpected core4 path: ${path}`);
    });
  });

  it('posts through the live route and reports honest pending-attestation state (#908)', async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');

    await handler(
      mockReq(
        {
          dataType: 'temperature',
          location: { stationId: 'station-mobile-1', lat: 41.9, lon: -87.6 },
          value: 72.5,
          timestamp: '2026-05-29T12:00:00.000Z',
          source: 'mobile',
          nonce: 'mobile-nonce',
        },
        { authorization: 'Bearer test' }
      ),
      res,
      jest.fn()
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: true,
        submissionId: expectedCommitHash,
        commitHash: expectedCommitHash,
        status: 'revealed_pending_attestation',
        stationId: 'station-mobile-1',
        rewardAmount: '0',
      })
    );
    expect(res.body.attestation).toEqual({
      approvals: 0,
      rejections: 0,
      hasQuorum: false,
      oracleQuorum: 2,
    });
    expect(res.body.blockInclusion).toEqual({
      commitAccepted: true,
      revealAccepted: true,
      txId: 'reveal-tx',
    });
    expect(mockFetchCore4Json).toHaveBeenCalledWith(
      '/transactions/contribution/commit',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          contributor: '0x0000000000000000000000000000000000000c03',
          station_id: 'station-mobile-1',
          commit_hash: expectedCommitHash,
        }),
      })
    );
    expect(mockFetchCore4Json).toHaveBeenCalledWith(
      '/transactions/contribution/reveal',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          station_id: 'station-mobile-1',
          commit_hash: expectedCommitHash,
          payload: canonicalReading,
          timestamp: 1780056000,
        }),
      })
    );
    expect(
      mockFetchCore4Json.mock.calls.some(
        ([path]: [string]) => path === '/transactions/oracle/attestation'
      )
    ).toBe(false);
  });

  it('uses wallet-compatible auth middleware instead of session-bound JWT auth', () => {
    expect(oracleSubmitRoutes.stack[0].handle).toBe(mockRequireAuth);
  });

  it('accepts a body contributor that matches the caller\'s own resolved wallet (#886)', async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');

    await handler(
      mockReq({
        dataType: 'temperature',
        location: { stationId: 'station-mobile-1', lat: 41.9, lon: -87.6 },
        value: 72.5,
        timestamp: '2026-05-29T12:00:00.000Z',
        source: 'mobile',
        nonce: 'mobile-nonce',
        contributor: '0x0000000000000000000000000000000000000c03',
      }),
      res,
      jest.fn()
    );

    expect(res.statusCode).toBe(200);
    expect(mockFetchCore4Json).toHaveBeenCalledWith(
      '/transactions/contribution/commit',
      expect.objectContaining({
        body: expect.objectContaining({
          contributor: '0x0000000000000000000000000000000000000c03',
        }),
      })
    );
  });

  it('rejects a body contributor that does NOT match the caller\'s own wallet — Sybil reward-farming guard (#886)', async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');

    await handler(
      mockReq({
        dataType: 'temperature',
        location: { stationId: 'station-mobile-1', lat: 41.9, lon: -87.6 },
        value: 72.5,
        timestamp: '2026-05-29T12:00:00.000Z',
        source: 'mobile',
        nonce: 'mobile-nonce',
        contributor: '0x000000000000000000000000000000000000dead',
      }),
      res,
      jest.fn()
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('Forbidden');
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('returns 400 when neither the body nor the authenticated caller supplies a wallet address', async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');

    const req = mockReq({
      dataType: 'temperature',
      location: { stationId: 'station-mobile-1', lat: 41.9, lon: -87.6 },
      value: 72.5,
      timestamp: '2026-05-29T12:00:00.000Z',
      source: 'mobile',
      nonce: 'mobile-nonce',
    });
    req.user = {};

    await handler(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Authenticated wallet address is required');
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('#217: rejects an unrecognized dataType with 400 instead of silently zeroing the measurement', async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');

    await handler(
      mockReq({
        dataType: 'barometric_pressure_unknown_type',
        location: { stationId: 'station-mobile-1', lat: 41.9, lon: -87.6 },
        value: 1013.2,
        timestamp: '2026-05-29T12:00:00.000Z',
        source: 'mobile',
      }),
      res,
      jest.fn()
    );

    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/Unrecognized dataType/);
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('#217: rejects a non-scalar (object) value with 400 — the mobile pressure-object bug', async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');

    await handler(
      mockReq({
        dataType: 'barometric_pressure',
        location: { stationId: 'station-mobile-1', lat: 41.9, lon: -87.6 },
        value: { pressureHpa: 1013.2, deviceId: 'dev-1' },
        timestamp: '2026-05-29T12:00:00.000Z',
        source: 'mobile',
      }),
      res,
      jest.fn()
    );

    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toMatch(/must be a numeric scalar/);
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('#217: maps the collector barometric_pressure alias to pressure_hpa and submits on-chain', async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');

    // Permissive mock: this submission's commit hash differs from the shared
    // fixture, so accept any commit/reveal/status/address path.
    mockFetchCore4Json.mockImplementation(async (path: string) => {
      if (path === '/transactions/contribution/commit') {
        return { ok: true, status: 202, payload: { tx_id: 'commit-tx' } };
      }
      if (path === '/transactions/contribution/reveal') {
        return { ok: true, status: 202, payload: { tx_id: 'reveal-tx' } };
      }
      if (path.startsWith('/transactions/commit/')) {
        return {
          ok: true,
          status: 200,
          payload: { status: 'revealed_pending_attestation' },
        };
      }
      if (path.startsWith('/addresses/')) {
        return { ok: true, status: 200, payload: { earned_balance_total: '0' } };
      }
      throw new Error(`Unexpected core4 path: ${path}`);
    });

    await handler(
      mockReq(
        {
          dataType: 'barometric_pressure',
          location: { stationId: 'station-mobile-1', lat: 41.9, lon: -87.6 },
          value: 1013.2,
          timestamp: '2026-05-29T12:00:00.000Z',
          source: 'mobile',
          nonce: 'mobile-nonce',
        },
        { authorization: 'Bearer test' }
      ),
      res,
      jest.fn()
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // The reveal payload forwarded to core4 must carry the real pressure, not 0.
    const revealCall = mockFetchCore4Json.mock.calls.find(
      (c: any[]) => c[0] === '/transactions/contribution/reveal'
    );
    expect(revealCall).toBeDefined();
    expect((revealCall as any[])[1].body.payload.pressure_hpa).toBe(1013.2);
  });
});

// ---------------------------------------------------------------------------
// #1284: core4 credentials, station-owner guard, and the two-step
// prepare → submit contract for a phone-signed commit authorization.
// ---------------------------------------------------------------------------

const USER_JWT = 'Bearer user-backend-jwt';
const USER_API_KEY = 'user-api-key';

function submitBody(overrides: Record<string, unknown> = {}) {
  return {
    dataType: 'temperature',
    location: { stationId: 'station-mobile-1', lat: 41.9, lon: -87.6 },
    value: 72.5,
    timestamp: '2026-05-29T12:00:00.000Z',
    source: 'mobile',
    nonce: 'mobile-nonce',
    ...overrides,
  };
}

function permissiveCore4() {
  mockFetchCore4Json.mockImplementation(async (path: string) => {
    if (path === '/transactions/contribution/commit') {
      return { ok: true, status: 201, payload: { tx_id: 'commit-tx' } };
    }
    if (path === '/transactions/contribution/reveal') {
      return { ok: true, status: 201, payload: { tx_id: 'reveal-tx' } };
    }
    if (path.startsWith('/transactions/commit/')) {
      return { ok: true, status: 200, payload: { status: 'revealed_pending_attestation' } };
    }
    if (path.startsWith('/addresses/')) {
      return { ok: true, status: 200, payload: { earned_balance_total: '0' } };
    }
    throw new Error(`Unexpected core4 path: ${path}`);
  });
}

function headersFor(path: string): Record<string, string> {
  const call = mockFetchCore4Json.mock.calls.find((c: any[]) => c[0] === path) as
    | any[]
    | undefined;
  expect(call).toBeDefined();
  return (call as any[])[1].headers;
}

describe('#1284 oracle submit: server core4 credentials and station-owner guard', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = CONTRIBUTOR_TOKEN;
    process.env.WRFCOIN_READER_TOKEN = READER_TOKEN;
    delete process.env.WRFCOIN_CHAIN_ID;
    delete process.env.WRFCOIN_NETWORK_ID;
    permissiveCore4();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('own-station submit uses the Contributor token for commit/reveal and the Reader token for reads; the user JWT is never forwarded', async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');

    await handler(
      mockReq(submitBody(), {
        authorization: USER_JWT,
        'x-api-key': USER_API_KEY,
        'x-request-id': 'req-1284',
      }),
      res,
      jest.fn()
    );

    expect(res.statusCode).toBe(200);
    expect(headersFor('/transactions/contribution/commit')).toEqual({
      authorization: `Bearer ${CONTRIBUTOR_TOKEN}`,
      'x-request-id': 'req-1284',
    });
    expect(headersFor('/transactions/contribution/reveal')).toEqual({
      authorization: `Bearer ${CONTRIBUTOR_TOKEN}`,
      'x-request-id': 'req-1284',
    });
    expect(headersFor(`/transactions/commit/${expectedCommitHash}/status`)).toEqual({
      authorization: `Bearer ${READER_TOKEN}`,
      'x-request-id': 'req-1284',
    });
    expect(headersFor(`/addresses/${OWN_WALLET}`)).toEqual({
      authorization: `Bearer ${READER_TOKEN}`,
      'x-request-id': 'req-1284',
    });
    const serialized = JSON.stringify(mockFetchCore4Json.mock.calls);
    expect(serialized).not.toContain('user-backend-jwt');
    expect(serialized).not.toContain(USER_API_KEY);
    expect(mockForwardCore4Headers).not.toHaveBeenCalled();
  });

  it("someone else's station → 403 with zero core4 calls", async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');

    await handler(
      mockReq(
        submitBody({ location: { stationId: 'station-someone-else', lat: 1, lon: 2 } }),
        { authorization: USER_JWT }
      ),
      res,
      jest.fn()
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('STATION_NOT_OWNED');
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('an unregistered station (including the mobile-oracle fallback) → 403 with zero core4 calls', async () => {
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');

    for (const location of [
      { stationId: 'station-nobody-registered', lat: 1, lon: 2 },
      // Today's mobile body: no stationId, so normalizeStationId falls back
      // to the shared literal 'mobile-oracle'.
      { latitude: 41.9, longitude: -87.6 },
    ]) {
      const res = mockRes();
      await handler(mockReq(submitBody({ location })), res, jest.fn());
      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('STATION_NOT_OWNED');
    }
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it('the owner comparison is case-insensitive', async () => {
    mockStationOwners['station-upper'] = OWN_WALLET.toUpperCase().replace('0X', '0x');
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');
    await handler(
      mockReq(submitBody({ location: { stationId: 'station-upper', lat: 1, lon: 2 } })),
      res,
      jest.fn()
    );
    delete mockStationOwners['station-upper'];
    expect(res.statusCode).toBe(200);
  });

  it('a station-ownership lookup failure fails closed with 503 and zero core4 calls', async () => {
    mockExecuteQuery.mockRejectedValueOnce(new Error('db down'));
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');
    await handler(mockReq(submitBody()), res, jest.fn());
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('STATION_OWNERSHIP_UNAVAILABLE');
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it.each([
    ['WRFCOIN_CONTRIBUTOR_TOKEN', 'CORE4_CONTRIBUTOR_CREDENTIAL_UNCONFIGURED'],
    ['WRFCOIN_READER_TOKEN', 'CORE4_READER_CREDENTIAL_UNCONFIGURED'],
  ])('unset %s → 503 %s envelope with zero core4 calls', async (envName, code) => {
    process.env[envName] = '   ';
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');
    await handler(mockReq(submitBody(), { authorization: USER_JWT }), res, jest.fn());
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: { code, message: expect.any(String) },
      timestamp: expect.any(String),
    });
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });

  it("the station-owner guard runs before the token check: someone else's station with no tokens is still 403", async () => {
    delete process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
    delete process.env.WRFCOIN_READER_TOKEN;
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');
    await handler(
      mockReq(submitBody({ location: { stationId: 'station-someone-else', lat: 1, lon: 2 } })),
      res,
      jest.fn()
    );
    expect(res.statusCode).toBe(403);
  });

  it('normalizes a client-supplied auth_pubkey and forwards auth_signature unchanged to the core4 commit', async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');
    await handler(
      mockReq(
        submitBody({ auth_pubkey: '  AbCd-not-validated  ', auth_signature: 'not even hex!' })
      ),
      res,
      jest.fn()
    );
    expect(res.statusCode).toBe(200);
    const commitCall = mockFetchCore4Json.mock.calls.find(
      (c: any[]) => c[0] === '/transactions/contribution/commit'
    ) as any[];
    expect(commitCall[1].body).toEqual({
      contributor: OWN_WALLET,
      station_id: 'station-mobile-1',
      commit_hash: expectedCommitHash,
      auth_pubkey: 'abcd-not-validated',
      auth_signature: 'not even hex!',
    });
    // The auth pair is not part of the reveal, and does not change the commit id.
    const revealCall = mockFetchCore4Json.mock.calls.find(
      (c: any[]) => c[0] === '/transactions/contribution/reveal'
    ) as any[];
    expect(revealCall[1].body).not.toHaveProperty('auth_pubkey');
    expect(revealCall[1].body).not.toHaveProperty('auth_signature');
  });

  it('omits the auth fields from the commit when the client supplies none', async () => {
    const res = mockRes();
    const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');
    await handler(mockReq(submitBody()), res, jest.fn());
    const commitCall = mockFetchCore4Json.mock.calls.find(
      (c: any[]) => c[0] === '/transactions/contribution/commit'
    ) as any[];
    expect(commitCall[1].body).toEqual({
      contributor: OWN_WALLET,
      station_id: 'station-mobile-1',
      commit_hash: expectedCommitHash,
    });
  });

  describe('POST /submit-data/prepare', () => {
    it('returns the exact commit-authorization inputs, makes zero core4 calls, and needs no core4 token', async () => {
      delete process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
      delete process.env.WRFCOIN_READER_TOKEN;
      const res = mockRes();
      const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data/prepare');
      await handler(mockReq(submitBody(), { authorization: USER_JWT }), res, jest.fn());

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        contributor: OWN_WALLET,
        stationId: 'station-mobile-1',
        commitId: expectedCommitHash,
        nonce: 'mobile-nonce',
        timestamp: 1780056000,
        authorization: {
          scheme: 'wrfcoin_commit_auth_v2',
          stationId: 'station-mobile-1',
          commitId: expectedCommitHash,
          contributionType: 'contribution',
          chainId: null,
          networkId: null,
          messageHex: null,
        },
      });
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('includes the preimage hex when the backend declares the chain identity', async () => {
      process.env.WRFCOIN_CHAIN_ID = 'wrfcoin-testnet';
      process.env.WRFCOIN_NETWORK_ID = 'testnet';
      const res = mockRes();
      const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data/prepare');
      await handler(mockReq(submitBody()), res, jest.fn());

      expect(res.statusCode).toBe(200);
      expect(res.body.authorization.chainId).toBe('wrfcoin-testnet');
      expect(res.body.authorization.networkId).toBe('testnet');
      expect(res.body.authorization.messageHex).toBe(
        buildCommitAuthorizationMessage({
          chainId: 'wrfcoin-testnet',
          networkId: 'testnet',
          stationId: 'station-mobile-1',
          commitId: expectedCommitHash,
          contributionType: 'contribution',
        }).toString('hex')
      );
    });

    it('omits the preimage when only one of chain id / network id is declared', async () => {
      process.env.WRFCOIN_CHAIN_ID = 'wrfcoin-testnet';
      const res = mockRes();
      const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data/prepare');
      await handler(mockReq(submitBody()), res, jest.fn());
      expect(res.body.authorization.messageHex).toBeNull();
    });

    it('prepare → sign → submit: the submitted commit carries the prepared commit id', async () => {
      const prepareHandler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data/prepare');
      const submitHandler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data');
      // No client nonce: the server derives it deterministically, and the
      // client echoes the prepared nonce back on submit.
      const body = submitBody({ nonce: undefined });

      const prepared = mockRes();
      await prepareHandler(mockReq(body), prepared, jest.fn());
      expect(prepared.statusCode).toBe(200);

      const submitted = mockRes();
      await submitHandler(
        mockReq({
          ...body,
          nonce: prepared.body.nonce,
          auth_pubkey: 'aa'.repeat(32),
          auth_signature: 'bb'.repeat(64),
        }),
        submitted,
        jest.fn()
      );
      expect(submitted.statusCode).toBe(200);
      expect(submitted.body.commitHash).toBe(prepared.body.commitId);
      const commitCall = mockFetchCore4Json.mock.calls.find(
        (c: any[]) => c[0] === '/transactions/contribution/commit'
      ) as any[];
      expect(commitCall[1].body.commit_hash).toBe(prepared.body.commitId);
    });

    it("someone else's station → 403 with zero core4 calls", async () => {
      const res = mockRes();
      const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data/prepare');
      await handler(
        mockReq(submitBody({ location: { stationId: 'station-someone-else', lat: 1, lon: 2 } })),
        res,
        jest.fn()
      );
      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('STATION_NOT_OWNED');
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });

    it('a body contributor that is not the caller → 403 (#886 applies to prepare too)', async () => {
      const res = mockRes();
      const handler = getHandler(oracleSubmitRoutes, 'POST', '/submit-data/prepare');
      await handler(
        mockReq(submitBody({ contributor: '0x000000000000000000000000000000000000dead' })),
        res,
        jest.fn()
      );
      expect(res.statusCode).toBe(403);
      expect(mockExecuteQuery).not.toHaveBeenCalled();
    });
  });
});
