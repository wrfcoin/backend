import express from 'express';
import request from 'supertest';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };

const getRecord = jest.fn();
const getAllBatches = jest.fn();

jest.mock('express-rate-limit', () => {
  return jest.fn(() => (_req: any, _res: any, next: any) => next());
});

jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  format: {
    combine: jest.fn(),
    timestamp: jest.fn(),
    json: jest.fn(),
    simple: jest.fn(),
  },
  transports: {
    File: jest.fn(),
    Console: jest.fn(),
  },
}));

jest.mock('../../server/utils/logger.js', () => ({
  securityLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../server/services/lineage-service.js', () => ({
  lineageService: {
    getRecord,
    getAncestors: jest.fn(),
    getDescendants: jest.fn(),
    getByCommitId: jest.fn(),
    getByStationId: jest.fn(),
    verifyIntegrity: jest.fn(),
    exportChain: jest.fn(),
  },
}));

jest.mock('../../services/secure-wallet-service.js', () => ({
  SecureWalletService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../blockchain/services/smart-contract-service.js', () => ({
  smartContractService: {},
}));

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn().mockImplementation(() => ({})),
    Contract: jest.fn().mockImplementation(() => ({
      getAllBatches,
    })),
    ZeroAddress: '0x0000000000000000000000000000000000000000',
    isAddress: jest.fn(() => true),
  },
}));

function loadLineageRouter() {
  return require('../../api/lineage-api.ts').lineageAPI;
}

function loadCarbonRouter() {
  return require('../../api/carbon-credit-api.ts').carbonCreditAPI;
}

function loadProductionCorsCleanup() {
  return require('../../middleware/production-cors-cleanup.js').default;
}

describe('lineage and carbon CORS hardening', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'production',
      // backend#1236: production requires an explicit, non-loopback allowlist.
      CORS_ORIGIN: 'https://wrfcoin-testnet.example',
      FRONTEND_URL: 'http://localhost:5000',
      SILENT_LOGS: 'true',
      DISABLE_FILE_LOG_TRANSPORTS: 'true',
    };
    getRecord.mockResolvedValue({ lineageId: 'lin-1' });
    getAllBatches.mockResolvedValue([]);
    jest.clearAllMocks();
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('does not use the lineage router FRONTEND_URL fallback in production', async () => {
    const router = loadLineageRouter();
    const app = express();
    app.use(express.json());
    app.use('/api/lineage', router);

    const res = await request(app)
      .get('/api/lineage/lin-1')
      .set('Origin', 'http://localhost:5000');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(getRecord).toHaveBeenCalledWith('lin-1');
  });

  it('does not use the carbon router FRONTEND_URL fallback in production', async () => {
    const router = loadCarbonRouter();
    const app = express();
    app.use(express.json());
    app.use('/api', router);

    const res = await request(app)
      .get('/api/carbon-credits/batches')
      .set('Origin', 'http://localhost:5000');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(getAllBatches).toHaveBeenCalled();
  });

  it('inherits the centralized production CORS policy for allowed origins', async () => {
    const ProductionCORSCleanup = loadProductionCorsCleanup();
    const router = loadLineageRouter();
    const app = express();

    ProductionCORSCleanup.autoConfigureCORS(app, {
      customOrigins: [/\.replit\.dev$/],
    });
    app.use('/api/lineage', router);

    const res = await request(app)
      .get('/api/lineage/lin-1')
      .set('Origin', 'https://wrfcoin.app');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://wrfcoin.app',
    );
  });
});
