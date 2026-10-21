/**
 * LayerZero adapter/estimate routes — the backend#1026 crash-on-hit pair.
 *
 * `GET /chains/:chainId/adapter` and `POST /estimate-gas` called
 * `bridgeService.getAdapterInfo()` and `bridgeService.estimateGas()` — neither
 * of which `server/layer-zero/bridge.js` exports. `require()` of an untyped JS
 * module is `any`, so tsc could not see it, and the routes' own try/catch
 * converted the TypeError into a permanent generic 500 (#1016 class: present,
 * typed, dead). Found by the #1023 detector's Rule B, hand-verified.
 *
 * RED-first: on the pre-fix tree both tests fail — the routes answer 500
 * because the handler throws `bridgeService.getAdapterInfo is not a function`.
 * The bridge itself is deterministic mock-data code, so it is exercised REAL
 * here (no bridge mock) — a bridge mock would happily provide the phantom
 * methods and hide exactly this defect.
 */

const mockAuth = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());
const mockLimiter = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());

jest.mock('express', () => {
  const createRouter = () => ({
    stack: [] as any[],
    use(handler: unknown) {
      this.stack.push({ handle: handler });
      return this;
    },
    get(path: string, handler: unknown) {
      this.stack.push({ route: { path, methods: { get: true }, stack: [{ handle: handler }] } });
      return this;
    },
    post(path: string, _limiter: unknown, handler?: unknown) {
      const routeHandler = handler ?? _limiter;
      this.stack.push({ route: { path, methods: { post: true }, stack: [{ handle: routeHandler }] } });
      return this;
    },
  });
  const express = () => createRouter();
  (express as any).Router = () => createRouter();
  return express;
}, { virtual: true });

// The router must remain protected and rate-limited; route handlers are
// exercised directly below to avoid Supertest's sandbox-blocked socket bind.
jest.mock('../server/middleware/auth.js', () => ({
  authenticateJWT: mockAuth,
}));
jest.mock('../middleware/rateLimiting.js', () => ({
  generalLimiter: mockLimiter,
  transferLimiter: mockLimiter,
}));
// The two endpoints under test never touch the DB; the module-level import
// must simply resolve without a live connection.
jest.mock('../server/db.js', () => ({ db: {} }));
// The route uses the typed module's named cross-chain logger. The bridge keeps
// using the legacy JavaScript module's `crossChainLogger` spelling.
function makeLoggerModule() {
  const mk = () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  });
  const factory = Object.assign(() => mk(), {
    logger: mk(),
    createLogger: () => mk(),
    log: jest.fn(),
    // bridge.js destructures this named export; without it the no-adapter path
    // throws on `logger.warn` and every 404 becomes a 500.
    crossChainLogger: mk(),
    crosschainLogger: mk(),
  });
  return factory;
}
jest.mock('../utils/logger.js', () => makeLoggerModule());
jest.mock('../server/utils/logger.js', () => makeLoggerModule());

// eslint-disable-next-line @typescript-eslint/no-require-imports
const layerZeroRoutesModule = require('../server/routes/layer-zero-routes');
const layerZeroRoutes = layerZeroRoutesModule.default || layerZeroRoutesModule;

function getHandler(method: string, path: string): Function {
  for (const layer of layerZeroRoutes.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`No ${method.toUpperCase()} handler for ${path}`);
}

function createRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

describe('backend#1026 — adapter info route is callable', () => {
  test('GET /chains/1/adapter answers 200 with a serializable summary for an EVM chain', async () => {
    const res = createRes();
    await getHandler('get', '/chains/:chainId/adapter')({ params: { chainId: '1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Object.keys(res.body)).toEqual(['success', 'adapter']);
    expect(res.body.adapter).toMatchObject({ chainId: 1, supported: true });
    expect(Array.isArray(res.body.adapter.capabilities)).toBe(true);
    expect(res.body.adapter.capabilities.length).toBeGreaterThan(0);
  });

  test('GET /chains/500/adapter answers 404 for a chain with no adapter', async () => {
    const res = createRes();
    await getHandler('get', '/chains/:chainId/adapter')({ params: { chainId: '500' } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('backend#1026 — estimate-gas route is callable', () => {
  test('POST /estimate-gas answers 200 with a fee estimation', async () => {
    const res = createRes();
    await getHandler('post', '/estimate-gas')(
      { body: { sourceChainId: 1, destinationChainId: 2, messageType: 'MESSAGE' } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // Shape pinned to what bridge.estimateFee actually returns — this is the
    // assertion that fails with a 500 while the route calls a phantom method.
    expect(res.body.estimation).toMatchObject({
      sourceChainId: 1,
      destinationChainId: 2,
      operationType: 'MESSAGE',
    });
    expect(typeof res.body.estimation.estimatedGas).toBe('number');
    expect(typeof res.body.estimation.fee).toBe('string');
  });

  test('POST /estimate-gas still validates required fields (400, not 500)', async () => {
    const res = createRes();
    await getHandler('post', '/estimate-gas')({ body: { sourceChainId: 1 } }, res);
    expect(res.statusCode).toBe(400);
  });

  test('POST /estimate-gas rejects unsupported message types instead of quoting them', async () => {
    const res = createRes();
    await getHandler('post', '/estimate-gas')(
      {
        body: {
          sourceChainId: 1,
          destinationChainId: 2,
          messageType: 'NOT_A_REAL_TYPE',
        },
      },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: 'Unsupported messageType: NOT_A_REAL_TYPE',
    });
  });

  test('router registers authentication before its route handlers', () => {
    expect(layerZeroRoutes.stack[0].handle).toBe(mockAuth);
    expect(mockAuth).not.toHaveBeenCalled();
  });
});
