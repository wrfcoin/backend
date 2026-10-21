/**
 * Tests for real Axelar GMP and LayerZero API clients behind feature flag.
 *
 * Covers:
 *  (a) ENABLE_REAL_BRIDGES=false → stub/null behavior preserved
 *  (b) Axelar GMP status query with a stubbed HTTP response
 *  (c) Axelar fee estimation with a stubbed HTTP response
 *  (d) LayerZero tx tracking with a stubbed HTTP response
 *  (e) Network errors + non-200 responses handled gracefully
 *
 * ---------------------------------------------------------------------------
 * backend#1017 — why there is no `jest.doMock` / `jest.resetModules` here
 * ---------------------------------------------------------------------------
 *
 * This file used to build its subject by mutating Jest's module registry:
 * `jest.resetModules()`, `jest.doMock('axios', …)`, then `require()` of the
 * api-client, once per test. Every assertion then rested on a registry
 * operation that nothing asserted — and on `647473c4` it demonstrably did not
 * hold. A full-gate run (`npm test`, four workers) failed here with
 *
 *     Network egress blocked: https.request tried to reach
 *     https://api.axelarscan.io/gmp/searchGMP?txHash=0xdeadbeef
 *       at Object.queryGMPStatus (server/axelar/api-client.js:52:32)
 *       at Axios.<computed> [as get] (node_modules/axios/dist/node/axios.cjs:6476:17)
 *
 * The subject was holding the REAL axios: the `doMock` had not bound, so the
 * client called axelarscan.io for real, and only #1018's egress guard turned
 * that into a failure rather than a silent live third-party call. It is
 * intermittent — two of three full-gate runs reproduced it (6 then 12 failing
 * tests, different sets each time), while the suite alone and the suite at
 * `--maxWorkers=1` both pass.
 *
 * The fix is the one #1078 applied to `real-storage-integrations.test.ts`:
 * stop routing the dependency through the registry, and hand it to the subject.
 * `createAxelarApiClient({ http, config })` and `createLayerZeroApiClient(…)`
 * take their HTTP surface and configuration as arguments, and
 * `getTransactionStatus` / `getMessageStatus` take an optional api client. The
 * stub below is passed by reference, so `expect(http.get)…` asserts against the
 * object the subject is actually using. There is no binding step left to fail,
 * which is why `assertAxiosMockBound` is no longer needed here — it existed to
 * police exactly the step this change removes.
 *
 * `scripts/detect-module-registry-race.mjs` scores this file CLEAN after the
 * change and HAZARD before it.
 *
 * The one `jest.mock` below is hoisted: installed once, before any module
 * loads, and not something ordering can win or lose.
 */

import { jest, describe, it, expect, afterEach } from '@jest/globals';

// Hoisted, so it is installed before the requires below execute. Silences
// logger output for the whole file with no per-test registry work.
jest.mock('../server/utils/logger.js', () => ({
  crossChainLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Subjects, loaded ONCE at module scope. These are untyped CommonJS modules, so
// the shape is asserted here rather than inferred. Nothing below reloads them:
// every test varies behaviour through arguments, not through module identity.
// ---------------------------------------------------------------------------
type HttpResponse = { status: number; data: unknown };
type HttpClient = { get: (url: string, config?: unknown) => Promise<HttpResponse> };

type AxelarClient = {
  queryGMPStatus: (txHash: string) => Promise<Record<string, unknown> | null>;
  estimateFees: (
    sourceChain: string,
    destChain: string,
    symbol: string,
    amount: string | number,
  ) => Promise<Record<string, unknown> | null>;
  getAxelarApiUrl: () => string;
  isRealBridgesEnabled: () => boolean;
};

type LayerZeroClient = {
  trackMessage: (txHash: string) => Promise<Record<string, unknown> | null>;
  quoteFeeFromTx: (txHash: string) => Promise<Record<string, unknown> | null>;
  getLayerZeroEndpointUrl: () => string;
  isRealBridgesEnabled: () => boolean;
};

const axelarApi = require('../server/axelar/api-client') as {
  createAxelarApiClient: (deps: {
    http: HttpClient;
    config: { enabled: boolean; apiUrl: string };
  }) => AxelarClient;
  getAxelarApiUrl: () => string;
  isRealBridgesEnabled: () => boolean;
  normaliseAxelarStatus: (s: string) => string;
};

const layerZeroApi = require('../server/layer-zero/api-client') as {
  createLayerZeroApiClient: (deps: {
    http: HttpClient;
    config: { enabled: boolean; endpointUrl: string };
  }) => LayerZeroClient;
  getLayerZeroEndpointUrl: () => string;
  isRealBridgesEnabled: () => boolean;
};

const axelarBridge = require('../server/axelar/bridge') as {
  getTransactionStatus: (
    transactionId: string,
    deps?: { apiClient?: unknown },
  ) => Promise<Record<string, unknown>>;
};

const layerZeroBridge = require('../server/layer-zero/bridge') as {
  getMessageStatus: (
    messageId: string,
    deps?: { apiClient?: unknown },
  ) => Promise<Record<string, unknown>>;
};

// ---------------------------------------------------------------------------
// A stub HTTP surface. This exact object is handed to the client, so a call
// recorded on it is a call the subject made — nothing in between can substitute
// the real thing.
// ---------------------------------------------------------------------------
type HttpGet = (url: string, config?: unknown) => Promise<HttpResponse>;

function stubHttp(impl?: HttpGet) {
  const get = jest.fn<HttpGet>();
  if (impl) get.mockImplementation(impl);
  return { get };
}

const respond = (status: number, data: unknown): HttpGet => () => Promise.resolve({ status, data });
const rejectWith = (message: string): HttpGet => () => Promise.reject(new Error(message));

const AXELAR_URL = 'https://api.axelarscan.io';
const LZ_URL = 'https://api-mainnet.layerzero-scan.com';

const axelarClient = (
  http: HttpClient,
  { enabled = true, apiUrl = AXELAR_URL }: { enabled?: boolean; apiUrl?: string } = {},
) => axelarApi.createAxelarApiClient({ http, config: { enabled, apiUrl } });

const layerZeroClient = (
  http: HttpClient,
  { enabled = true, endpointUrl = LZ_URL }: { enabled?: boolean; endpointUrl?: string } = {},
) => layerZeroApi.createLayerZeroApiClient({ http, config: { enabled, endpointUrl } });

// ---------------------------------------------------------------------------
// Axelar API client tests
// ---------------------------------------------------------------------------
describe('Axelar API client', () => {
  // (a) Flag OFF — queryGMPStatus returns null without making an HTTP call
  it('(a) returns null for queryGMPStatus when real bridges are disabled', async () => {
    const http = stubHttp();
    const result = await axelarClient(http, { enabled: false }).queryGMPStatus('0xabc');

    expect(result).toBeNull();
    // #1017: this negative is load-bearing now. `http.get` is the function the
    // client holds, so "not called" cannot be trivially true the way it was
    // when an unbound doMock left the subject talking to the real axios.
    expect(http.get).not.toHaveBeenCalled();
  });

  // (a) Flag OFF — estimateFees returns null without making an HTTP call
  it('(a) returns null for estimateFees when real bridges are disabled', async () => {
    const http = stubHttp();
    const result = await axelarClient(http, { enabled: false }).estimateFees(
      'ethereum',
      'polygon',
      'axlUSDC',
      '100',
    );

    expect(result).toBeNull();
    expect(http.get).not.toHaveBeenCalled();
  });

  // (b) Axelar GMP status query — happy path
  it('(b) queryGMPStatus returns parsed status when API responds 200', async () => {
    const mockGMPRecord = {
      id: 'gmp-123',
      status: 'executed',
      call: {
        transactionHash: '0xdeadbeef',
        chain: 'ethereum',
        blockTimestamp: 1700000000,
        returnValues: {
          destinationChain: 'polygon',
          sender: '0xSender',
          destinationContractAddress: '0xRecipient',
          symbol: 'axlUSDC',
          amount: '500',
        },
      },
      executed: {
        transactionHash: '0xcafebabe',
        blockTimestamp: 1700001000,
      },
      gas_paid: {
        returnValues: {
          gasFeeAmount: '21000',
        },
      },
      error: null,
    };

    const http = stubHttp(respond(200, { data: [mockGMPRecord] }));
    const result = await axelarClient(http).queryGMPStatus('0xdeadbeef');

    expect(http.get).toHaveBeenCalledTimes(1);
    const calledUrl = http.get.mock.calls[0][0];
    expect(calledUrl).toContain('/gmp/searchGMP');
    expect(calledUrl).toContain('0xdeadbeef');

    expect(result).not.toBeNull();
    expect(result!.status).toBe('EXECUTED');
    expect(result!.sourceChain).toBe('ethereum');
    expect(result!.destinationChain).toBe('polygon');
    expect(result!.sourceTransactionHash).toBe('0xdeadbeef');
    expect(result!.destinationTransactionHash).toBe('0xcafebabe');
    expect(result!.gasUsed).toBe(21000);
  });

  // (b) queryGMPStatus — empty data array returns null
  it('(b) queryGMPStatus returns null when API returns empty records', async () => {
    const http = stubHttp(respond(200, { data: [] }));
    const result = await axelarClient(http).queryGMPStatus('0xnotfound');

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  // (c) Axelar fee estimation — happy path
  it('(c) estimateFees returns parsed fee breakdown when API responds 200', async () => {
    const http = stubHttp(
      respond(200, {
        base_fee: '0.025',
        execution_fee: '0.005',
        express_fee: '0.003',
        total_fee: '0.033',
        fee_token: 'axlUSDC',
      }),
    );
    const result = await axelarClient(http).estimateFees('ethereum', 'polygon', 'axlUSDC', '100');

    expect(http.get).toHaveBeenCalledTimes(1);
    const calledUrl = http.get.mock.calls[0][0];
    expect(calledUrl).toContain('/gmp/getFees');
    expect(calledUrl).toContain('sourceChain=ethereum');
    expect(calledUrl).toContain('destinationChain=polygon');
    expect(calledUrl).toContain('symbol=axlUSDC');

    expect(result).not.toBeNull();
    expect(result!.sourceChain).toBe('ethereum');
    expect(result!.destinationChain).toBe('polygon');
    expect(result!.baseFee).toBe('0.025');
    expect(result!.totalFee).toBe('0.033');
    expect(result!.feeToken).toBe('axlUSDC');
    expect(result!.symbol).toBe('axlUSDC');
    expect(result!.amount).toBe('100');
  });

  // (e) Axelar — non-200 response throws
  it('(e) queryGMPStatus throws on non-200 HTTP response', async () => {
    const http = stubHttp(respond(503, {}));

    await expect(axelarClient(http).queryGMPStatus('0xfail')).rejects.toThrow(/HTTP 503/);
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  // (e) Axelar — network error propagates
  it('(e) queryGMPStatus propagates network errors', async () => {
    const http = stubHttp(rejectWith('ECONNREFUSED'));

    await expect(axelarClient(http).queryGMPStatus('0xnetfail')).rejects.toThrow('ECONNREFUSED');
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  // (e) Axelar — fee estimation non-200 throws
  it('(e) estimateFees throws on non-200 HTTP response', async () => {
    const http = stubHttp(respond(429, {}));

    await expect(
      axelarClient(http).estimateFees('ethereum', 'polygon', 'axlUSDC', '100'),
    ).rejects.toThrow(/HTTP 429/);
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  // The injected base URL must be the one actually called, not merely reported.
  it('issues its request against the injected apiUrl', async () => {
    const http = stubHttp(respond(200, { data: [] }));
    const client = axelarClient(http, { apiUrl: 'https://custom-axelar.example.com' });

    await client.queryGMPStatus('0xabc');

    expect(client.getAxelarApiUrl()).toBe('https://custom-axelar.example.com');
    expect(http.get.mock.calls[0][0]).toContain('https://custom-axelar.example.com/gmp/');
  });

  it('reports the injected enabled flag rather than the ambient environment', () => {
    const previous = process.env.ENABLE_REAL_BRIDGES;
    process.env.ENABLE_REAL_BRIDGES = 'true';
    try {
      // Config is captured at construction, so an env change cannot reach in.
      expect(axelarClient(stubHttp(), { enabled: false }).isRealBridgesEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ENABLE_REAL_BRIDGES;
      else process.env.ENABLE_REAL_BRIDGES = previous;
    }
  });

  it('normaliseAxelarStatus maps Axelar vocabulary onto the platform constants', () => {
    expect(axelarApi.normaliseAxelarStatus('approved')).toBe('PENDING');
    expect(axelarApi.normaliseAxelarStatus('confirmed')).toBe('EXECUTED');
    expect(axelarApi.normaliseAxelarStatus('error')).toBe('FAILED');
    expect(axelarApi.normaliseAxelarStatus('')).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// The env-reading helpers stay module-level and still read `process.env` on
// every call. They are exercised directly — one module instance, no reload — so
// nothing here depends on load order. That laziness is deliberate and is what
// keeps these modules out of the import-time-env half of #1017's class.
// ---------------------------------------------------------------------------
describe('bridge feature-flag and URL helpers read the environment lazily', () => {
  afterEach(() => {
    delete process.env.ENABLE_REAL_BRIDGES;
    delete process.env.AXELAR_API_URL;
    delete process.env.LAYERZERO_ENDPOINT_URL;
  });

  it('isRealBridgesEnabled is true only when ENABLE_REAL_BRIDGES=true', () => {
    delete process.env.ENABLE_REAL_BRIDGES;
    expect(axelarApi.isRealBridgesEnabled()).toBe(false);
    expect(layerZeroApi.isRealBridgesEnabled()).toBe(false);

    process.env.ENABLE_REAL_BRIDGES = 'false';
    expect(axelarApi.isRealBridgesEnabled()).toBe(false);

    // Same module instance, never reloaded: the flag is read at call time.
    process.env.ENABLE_REAL_BRIDGES = 'true';
    expect(axelarApi.isRealBridgesEnabled()).toBe(true);
    expect(layerZeroApi.isRealBridgesEnabled()).toBe(true);
  });

  it('getAxelarApiUrl honours AXELAR_API_URL and strips a trailing slash', () => {
    delete process.env.AXELAR_API_URL;
    expect(axelarApi.getAxelarApiUrl()).toBe(AXELAR_URL);

    process.env.AXELAR_API_URL = 'https://custom-axelar.example.com/';
    expect(axelarApi.getAxelarApiUrl()).toBe('https://custom-axelar.example.com');
  });

  it('getLayerZeroEndpointUrl honours LAYERZERO_ENDPOINT_URL and strips a trailing slash', () => {
    delete process.env.LAYERZERO_ENDPOINT_URL;
    expect(layerZeroApi.getLayerZeroEndpointUrl()).toBe(LZ_URL);

    process.env.LAYERZERO_ENDPOINT_URL = 'https://custom-lz.example.com/';
    expect(layerZeroApi.getLayerZeroEndpointUrl()).toBe('https://custom-lz.example.com');
  });
});

// ---------------------------------------------------------------------------
// LayerZero API client tests
// ---------------------------------------------------------------------------
describe('LayerZero API client', () => {
  // (a) Flag OFF — trackMessage returns null without making an HTTP call
  it('(a) returns null for trackMessage when real bridges are disabled', async () => {
    const http = stubHttp();
    const result = await layerZeroClient(http, { enabled: false }).trackMessage('0xabc');

    expect(result).toBeNull();
    expect(http.get).not.toHaveBeenCalled();
  });

  // (a) Flag OFF — quoteFeeFromTx returns null
  it('(a) returns null for quoteFeeFromTx when real bridges are disabled', async () => {
    const http = stubHttp();
    const result = await layerZeroClient(http, { enabled: false }).quoteFeeFromTx('0xabc');

    expect(result).toBeNull();
    expect(http.get).not.toHaveBeenCalled();
  });

  // (d) LayerZero tx tracking — happy path
  it('(d) trackMessage returns parsed delivery status when API responds 200', async () => {
    const mockMessage = {
      id: 'lz-msg-001',
      nonce: 42,
      status: 'DELIVERED',
      srcChainId: 1,
      dstChainId: 137,
      srcUaAddress: { address: '0xSrcUA', chainId: 1 },
      dstUaAddress: { address: '0xDstUA', chainId: 137 },
      srcBlockHash: '0xsrcblock',
      dstTxHash: '0xdstblock',
      created: 1700000000000,
      updated: 1700001000000,
      nativeFee: '0.005',
      lzTokenFee: '0',
    };

    const http = stubHttp(respond(200, { messages: [mockMessage] }));
    const result = await layerZeroClient(http).trackMessage('0xsrcTxHash');

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get.mock.calls[0][0]).toContain('/tx/0xsrcTxHash');

    expect(result).not.toBeNull();
    expect(result!.messageId).toBe('lz-msg-001');
    expect(result!.status).toBe('DELIVERED');
    expect(result!.sourceChainId).toBe(1);
    expect(result!.destinationChainId).toBe(137);
    expect(result!.srcUaAddress).toBe('0xSrcUA');
    expect(result!.dstTxHash).toBe('0xdstblock');
  });

  // (d) LayerZero — INFLIGHT normalised to PENDING
  it('(d) trackMessage normalises INFLIGHT status to PENDING', async () => {
    const http = stubHttp(
      respond(200, { messages: [{ id: 'x', status: 'INFLIGHT', srcChainId: 1, dstChainId: 2 }] }),
    );
    const result = await layerZeroClient(http).trackMessage('0xinFlight');

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(result!.status).toBe('PENDING');
  });

  // (d) LayerZero — empty messages array returns null
  it('(d) trackMessage returns null when API returns no messages', async () => {
    const http = stubHttp(respond(200, { messages: [] }));
    const result = await layerZeroClient(http).trackMessage('0xnotfound');

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  // (e) LayerZero — non-200 throws
  it('(e) trackMessage throws on non-200 HTTP response', async () => {
    const http = stubHttp(respond(404, {}));

    await expect(layerZeroClient(http).trackMessage('0xbadTx')).rejects.toThrow(/HTTP 404/);
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  // (e) LayerZero — network error propagates
  it('(e) trackMessage propagates network errors', async () => {
    const http = stubHttp(rejectWith('ETIMEDOUT'));

    await expect(layerZeroClient(http).trackMessage('0xtimeout')).rejects.toThrow('ETIMEDOUT');
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  // quoteFeeFromTx — extracts fee fields from the tracked message
  it('quoteFeeFromTx extracts native fee from tracked message raw data', async () => {
    const mockMessage = {
      id: 'lz-fee-001',
      status: 'DELIVERED',
      srcChainId: 1,
      dstChainId: 10,
      nativeFee: '0.012',
      lzTokenFee: '0',
    };

    const http = stubHttp(respond(200, { messages: [mockMessage] }));
    const result = await layerZeroClient(http).quoteFeeFromTx('0xfeeTx');

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result!.txHash).toBe('0xfeeTx');
    expect(result!.nativeFee).toBe('0.012');
    expect(result!.lzTokenFee).toBe('0');
    expect(result!.sourceChainId).toBe(1);
    expect(result!.destinationChainId).toBe(10);
  });

  it('issues its request against the injected endpointUrl', async () => {
    const http = stubHttp(respond(200, { messages: [] }));
    const client = layerZeroClient(http, { endpointUrl: 'https://custom-lz.example.com' });

    await client.trackMessage('0xabc');

    expect(client.getLayerZeroEndpointUrl()).toBe('https://custom-lz.example.com');
    expect(http.get.mock.calls[0][0]).toContain('https://custom-lz.example.com/tx/');
  });
});

// ---------------------------------------------------------------------------
// Bridge integration — the api client is injected, not registry-substituted
// ---------------------------------------------------------------------------
describe('Axelar bridge.getTransactionStatus with feature flag', () => {
  it('(a) returns deterministic stub when real bridges are disabled', async () => {
    const queryGMPStatus = jest.fn<() => Promise<null>>().mockResolvedValue(null);
    const apiClient = { isRealBridgesEnabled: () => false, queryGMPStatus };

    const result = await axelarBridge.getTransactionStatus('test-tx-id-stub', { apiClient });

    expect(result).toBeDefined();
    expect(result.id).toBe('test-tx-id-stub');
    expect(['PENDING', 'EXECUTED', 'FAILED']).toContain(result.status);
    // #1017: the flag is off, so the API must not be consulted. `apiClient` is
    // the object the bridge was handed, so this negative cannot be vacuous.
    expect(queryGMPStatus).not.toHaveBeenCalled();
  });

  it('(b) calls the Axelar API when real bridges are enabled', async () => {
    const fakeAPIResult = {
      id: 'real-tx-id',
      status: 'EXECUTED',
      sourceChain: 'ethereum',
      destinationChain: 'polygon',
      sourceTransactionHash: '0xrealHash',
      destinationTransactionHash: '0xrealDst',
    };

    // #1017: this test is NAMED "calls the Axelar API" and used to assert only
    // on the returned fields. The call is the claim, so the call is what gets
    // pinned.
    const queryGMPStatus = jest
      .fn<(txHash: string) => Promise<typeof fakeAPIResult>>()
      .mockResolvedValue(fakeAPIResult);
    const apiClient = { isRealBridgesEnabled: () => true, queryGMPStatus };

    const result = await axelarBridge.getTransactionStatus('real-tx-id', { apiClient });

    expect(queryGMPStatus).toHaveBeenCalledTimes(1);
    expect(queryGMPStatus).toHaveBeenCalledWith('real-tx-id');

    expect(result.status).toBe('EXECUTED');
    expect(result.sourceChain).toBe('ethereum');
  });

  it('falls back to the production api client when no dependency is supplied', async () => {
    // Guards the default parameter itself. With ENABLE_REAL_BRIDGES unset the
    // production client short-circuits before any HTTP, so this returns the
    // deterministic stub; a mis-wired default would throw here instead.
    delete process.env.ENABLE_REAL_BRIDGES;
    const result = await axelarBridge.getTransactionStatus('default-deps-tx-id');

    expect(result.id).toBe('default-deps-tx-id');
    expect(['PENDING', 'EXECUTED', 'FAILED']).toContain(result.status);
  });
});

describe('LayerZero bridge.getMessageStatus with feature flag', () => {
  it('(a) returns deterministic stub when real bridges are disabled', async () => {
    const trackMessage = jest.fn<() => Promise<null>>().mockResolvedValue(null);
    const apiClient = { isRealBridgesEnabled: () => false, trackMessage };

    const result = await layerZeroBridge.getMessageStatus('lz-stub-msg-id', { apiClient });

    expect(result).toBeDefined();
    expect(result.messageId).toBe('lz-stub-msg-id');
    expect(['PENDING', 'DELIVERED', 'FAILED']).toContain(result.status);
    expect(trackMessage).not.toHaveBeenCalled();
  });

  it('(d) calls the LayerZero API when real bridges are enabled', async () => {
    const fakeAPIResult = {
      txHash: 'lz-real-msg-id',
      messageId: 'lz-real-msg-id',
      status: 'DELIVERED',
      sourceChainId: 1,
      destinationChainId: 137,
      srcUaAddress: '0xSrc',
      dstUaAddress: '0xDst',
      dstTxHash: '0xdstTx',
    };

    const trackMessage = jest
      .fn<(txHash: string) => Promise<typeof fakeAPIResult>>()
      .mockResolvedValue(fakeAPIResult);
    const apiClient = { isRealBridgesEnabled: () => true, trackMessage };

    const result = await layerZeroBridge.getMessageStatus('lz-real-msg-id', { apiClient });

    expect(trackMessage).toHaveBeenCalledTimes(1);
    expect(trackMessage).toHaveBeenCalledWith('lz-real-msg-id');

    expect(result.status).toBe('DELIVERED');
    expect(result.sourceChainId).toBe(1);
  });

  it('falls back to the production api client when no dependency is supplied', async () => {
    delete process.env.ENABLE_REAL_BRIDGES;
    const result = await layerZeroBridge.getMessageStatus('lz-default-deps-id');

    expect(result.messageId).toBe('lz-default-deps-id');
    expect(['PENDING', 'DELIVERED', 'FAILED']).toContain(result.status);
  });
});
