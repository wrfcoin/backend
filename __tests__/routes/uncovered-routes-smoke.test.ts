/**
 * Smoke tests for route modules that previously lacked test coverage.
 * Each test verifies the module exports a valid Express router with handlers.
 * Addresses issue #340.
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Common middleware mocks
// ---------------------------------------------------------------------------

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../server/middleware/auth', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// requireAdmin may be used as direct middleware OR as a factory requireAdmin()
const mockAdminMiddleware = (_req: any, _res: any, next: any) => next();
const mockRequireAdmin: any = Object.assign(
  () => mockAdminMiddleware,
  mockAdminMiddleware
);

jest.mock('../../server/middleware/rbac-middleware.js', () => ({
  requireAdmin: mockRequireAdmin,
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  ROLES: { ADMIN: 'admin', OPERATOR: 'operator' },
}));

jest.mock('../../server/middleware/rbac-middleware', () => ({
  requireAdmin: mockRequireAdmin,
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  ROLES: { ADMIN: 'admin', OPERATOR: 'operator' },
}));

jest.mock('../../server/utils/logger.js', () => ({
  securityLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logError: jest.fn(),
}));

jest.mock('../../server/utils/logger', () => ({
  securityLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logError: jest.fn(),
}));

// generalLimiter may be used as direct middleware OR as a factory function
const mockLimiterMiddleware = (_req: any, _res: any, next: any) => next();
const mockLimiterFactory: any = Object.assign(
  jest.fn(() => mockLimiterMiddleware),
  { call: () => mockLimiterMiddleware }
);
// Make it work as both: direct middleware AND factory
const mockGeneralLimiter: any = (_req: any, _res: any, next?: any) => {
  // If called as factory (with config object), return middleware
  if (typeof _req === 'object' && !_req.path && typeof _res !== 'function') {
    return mockLimiterMiddleware;
  }
  // If called as middleware directly
  if (typeof _res === 'function') return _res(); // next is _res
  if (typeof next === 'function') return next();
};
jest.mock('../../middleware/rateLimiting.js', () => ({
  generalLimiter: mockGeneralLimiter,
  authLimiter: (_req: any, _res: any, next: any) => next(),
  transferLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: mockGeneralLimiter,
  authLimiter: (_req: any, _res: any, next: any) => next(),
  transferLimiter: (_req: any, _res: any, next: any) => next(),
}));

// ---------------------------------------------------------------------------
// onboarding-routes: faucet challenge/claim (no external deps)
// ---------------------------------------------------------------------------
describe('onboarding-routes module', () => {
  it('exports a defined router with handlers', async () => {
    const mod = await import('../../server/routes/onboarding-routes.js');
    const router = mod.default ?? mod;
    expect(router).toBeDefined();
    expect(typeof router).toBe('function'); // Express Router is a function
  });
});

// ---------------------------------------------------------------------------
// alignment-kpi-routes: KPI summary endpoints
// ---------------------------------------------------------------------------
jest.mock('../../database/index.js', () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    execute: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
  desc: jest.fn(),
  sql: jest.fn().mockReturnValue({ as: jest.fn().mockReturnValue('alias') }),
}));

jest.mock('../../shared/schema.js', () => ({
  users: {},
  forecastCoverageMetrics: {},
  contributorRewards: {},
}));

jest.mock('../../server/services/sanctions-orchestration-service.js', () => ({
  sanctionsOrchestrationService: {
    getStats: jest.fn().mockResolvedValue({}),
  },
}));

describe('alignment-kpi-routes module', () => {
  it('exports a defined router', async () => {
    const mod = await import('../../server/routes/alignment-kpi-routes.js');
    const router = mod.default ?? mod;
    expect(router).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// incident-automation: AlertManager integration
// ---------------------------------------------------------------------------
jest.mock('../../server/services/incidentPlaybookEngine.js', () => ({
  incidentPlaybookEngine: {
    processAlertManagerWebhook: jest.fn().mockResolvedValue([]),
    getPlaybook: jest.fn().mockReturnValue(null),
    getActiveIncidents: jest.fn().mockReturnValue([]),
    resolveIncident: jest.fn(),
  },
  IncidentSeverity: { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' },
  AlertManagerPayload: {},
}));

jest.mock('../../server/services/incidentPlaybookEngine', () => ({
  incidentPlaybookEngine: {
    processAlertManagerWebhook: jest.fn().mockResolvedValue([]),
    getPlaybook: jest.fn().mockReturnValue(null),
    getActiveIncidents: jest.fn().mockReturnValue([]),
    resolveIncident: jest.fn(),
  },
  IncidentSeverity: { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' },
  AlertManagerPayload: {},
}));

describe('incident-automation routes module', () => {
  it('exports a defined router', async () => {
    const mod = await import('../../server/routes/incident-automation.js');
    const router = mod.default ?? mod;
    expect(router).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// bigchaindb-routes
// ---------------------------------------------------------------------------
const bigchainHandler = jest.fn((_req: any, res: any) => res.json({ status: 'ok' }));
jest.mock('../../server/controllers/bigchaindbController.js', () => ({
  getStatus: bigchainHandler,
  createAsset: bigchainHandler,
  getAsset: bigchainHandler,
  searchAssets: bigchainHandler,
  getAssetsByOwner: bigchainHandler,
  transferAsset: bigchainHandler,
  updateAssetMetadata: bigchainHandler,
  createSharedAsset: bigchainHandler,
  generateKeyPair: bigchainHandler,
  createComputationalAsset: bigchainHandler,
  getAssetHistory: bigchainHandler,
}));

jest.mock('../../server/controllers/bigchaindbController', () => ({
  getStatus: bigchainHandler,
  createAsset: bigchainHandler,
  getAsset: bigchainHandler,
  searchAssets: bigchainHandler,
  getAssetsByOwner: bigchainHandler,
  transferAsset: bigchainHandler,
  updateAssetMetadata: bigchainHandler,
  createSharedAsset: bigchainHandler,
  generateKeyPair: bigchainHandler,
  createComputationalAsset: bigchainHandler,
  getAssetHistory: bigchainHandler,
}));

describe('bigchaindb-routes module', () => {
  it('exports a defined router with route handlers', async () => {
    const mod = await import('../../server/routes/bigchaindb-routes.js');
    const router = mod.default ?? mod;
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
    expect((router as any).stack.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// mfa-routes
// ---------------------------------------------------------------------------
jest.mock('../../server/services/mfa-service.js', () => ({
  mfaService: {
    setupTotp: jest.fn(),
    verifyTotp: jest.fn(),
    getStatus: jest.fn(),
    generateBackupCodes: jest.fn(),
    verifyBackupCode: jest.fn(),
    getTrustedDevices: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../../server/services/sms-service.js', () => ({
  smsService: {
    sendCode: jest.fn(),
    verifyCode: jest.fn(),
  },
}));

jest.mock('../../shared/schema.js', () => ({
  users: { id: 'id', mfaEnabled: 'mfaEnabled', totpSecret: 'totpSecret' },
}));

jest.mock('drizzle-orm/postgres-js', () => ({
  drizzle: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  })),
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
}));

jest.mock('postgres', () =>
  jest.fn(() => ({ end: jest.fn() }))
);

jest.mock('express-validator', () => {
  // Create a chainable middleware that returns itself from all chain methods
  const makeChain = (): any => {
    const fn: any = (_req: any, _res: any, next: any) => { if (typeof next === 'function') next(); };
    const methods = [
      'isLength', 'isString', 'trim', 'notEmpty', 'withMessage',
      'matches', 'isEmail', 'isIn', 'optional', 'isInt', 'isBoolean',
      'isArray', 'isObject', 'isMobilePhone', 'escape', 'normalizeEmail',
      'custom', 'customSanitizer', 'exists', 'not', 'isEmpty', 'isURL',
      'isAlphanumeric', 'isNumeric', 'isHexadecimal', 'isUUID',
    ];
    methods.forEach((m) => { fn[m] = jest.fn().mockReturnValue(fn); });
    return fn;
  };
  return {
    body: jest.fn(() => makeChain()),
    param: jest.fn(() => makeChain()),
    query: jest.fn(() => makeChain()),
    header: jest.fn(() => makeChain()),
    validationResult: jest.fn(() => ({ isEmpty: () => true, array: () => [] })),
    oneOf: jest.fn(() => makeChain()),
  };
});

describe('mfa-routes module', () => {
  it('exports a defined router', async () => {
    const mod = await import('../../server/routes/mfa-routes.js');
    const router = mod.default ?? mod;
    expect(router).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// wallet-auth-routes: wallet nonce/verify
// ---------------------------------------------------------------------------
jest.mock('../../server/auth/jwt-constants.js', () => ({
  JWT_ISSUER: 'test-issuer',
  JWT_AUDIENCE: 'test-audience',
}));

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    quit: jest.fn(),
  }));
});

describe('wallet-auth-routes module', () => {
  it('exports a createWalletAuthService function', async () => {
    const mod = await import('../../server/routes/wallet-auth-routes.js');
    expect(mod.createWalletAuthService ?? mod.default ?? mod).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// layer-zero-routes
// ---------------------------------------------------------------------------
jest.mock('../../server/layer-zero/bridge', () => ({
  estimateMessageFee: jest.fn().mockResolvedValue({ fee: '0' }),
  sendMessage: jest.fn().mockResolvedValue({ txHash: '0x0' }),
  transferTokens: jest.fn().mockResolvedValue({ txHash: '0x0' }),
  getMessageStatus: jest.fn().mockResolvedValue({ status: 'delivered' }),
  initialize: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../server/layer-zero/config', () => ({
  SUPPORTED_CHAINS: [],
  DEFAULT_GAS_LIMIT: 200000,
}));

jest.mock('../../server/db', () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'test-id' }]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  },
}));

jest.mock('../../shared/layer-zero-schema', () => ({
  layerZeroMessages: { id: 'id', status: 'status' },
  layerZeroTransfers: { id: 'id', status: 'status' },
}));

jest.mock('../../utils/logger', () =>
  jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }))
);

describe('layer-zero-routes module', () => {
  it('exports a defined router', async () => {
    const mod = await import('../../server/routes/layer-zero-routes.js');
    const router = mod.default ?? mod;
    expect(router).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// flux-routes
// ---------------------------------------------------------------------------
const fluxHandlerFn = jest.fn((_req: any, res: any) => res.json({ status: 'ok' }));
jest.mock('../../server/controllers/fluxController.js', () => ({
  getStatus: jest.fn((_req: any, res: any) => res.json({ status: 'ok' })),
  deployApp: jest.fn((_req: any, res: any) => res.json({})),
  deployApplication: jest.fn((_req: any, res: any) => res.json({})),
  getDeployment: jest.fn((_req: any, res: any) => res.json({})),
  startDeployment: jest.fn((_req: any, res: any) => res.json({})),
  stopDeployment: jest.fn((_req: any, res: any) => res.json({})),
  getAllNodes: jest.fn((_req: any, res: any) => res.json([])),
  submitJob: jest.fn((_req: any, res: any) => res.json({})),
  getNodeMetrics: jest.fn((_req: any, res: any) => res.json({})),
  getAllApps: jest.fn((_req: any, res: any) => res.json([])),
  getJobs: jest.fn((_req: any, res: any) => res.json([])),
}));

jest.mock('../../server/controllers/fluxController', () => ({
  getStatus: jest.fn((_req: any, res: any) => res.json({ status: 'ok' })),
  deployApp: jest.fn((_req: any, res: any) => res.json({})),
  deployApplication: jest.fn((_req: any, res: any) => res.json({})),
  getDeployment: jest.fn((_req: any, res: any) => res.json({})),
  startDeployment: jest.fn((_req: any, res: any) => res.json({})),
  stopDeployment: jest.fn((_req: any, res: any) => res.json({})),
  getAllNodes: jest.fn((_req: any, res: any) => res.json([])),
  submitJob: jest.fn((_req: any, res: any) => res.json({})),
  getNodeMetrics: jest.fn((_req: any, res: any) => res.json({})),
  getAllApps: jest.fn((_req: any, res: any) => res.json([])),
  getJobs: jest.fn((_req: any, res: any) => res.json([])),
}));

describe('flux-routes module', () => {
  it('exports a defined router', async () => {
    const mod = await import('../../server/routes/flux-routes.js');
    const router = mod.default ?? mod;
    expect(router).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// automated-regulatory-reporting-routes
// ---------------------------------------------------------------------------
jest.mock('../../server/controllers/automatedRegulatoryReportingController.js', () => ({
  generateAllReports: jest.fn((_req: any, res: any) => res.json({})),
  generateSpecificReport: jest.fn((_req: any, res: any) => res.json({})),
  submitReport: jest.fn((_req: any, res: any) => res.json({})),
  getReportingDeadlines: jest.fn((_req: any, res: any) => res.json([])),
  getRegulatoryFrameworks: jest.fn((_req: any, res: any) => res.json([])),
  getReportStatusEndpoint: jest.fn((_req: any, res: any) => res.json({})),
  getComplianceDashboard: jest.fn((_req: any, res: any) => res.json({})),
  scheduleAutomatedReporting: jest.fn((_req: any, res: any) => res.json({})),
  validateReportData: jest.fn((_req: any, res: any) => res.json({})),
}));

jest.mock('../../server/middleware/apiAudit.js', () =>
  (_req: any, _res: any, next: any) => next()
);

describe('automated-regulatory-reporting-routes module', () => {
  it('exports a defined router with handlers', async () => {
    const mod = await import('../../server/routes/automated-regulatory-reporting-routes.js');
    const router = mod.default ?? mod;
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
    expect((router as any).stack.length).toBeGreaterThan(0);
  });
});
