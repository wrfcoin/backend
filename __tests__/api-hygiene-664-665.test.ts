/**
 * Tests for API hygiene fixes:
 *   #665 — climatePrivacyController pagination capped (DoS prevention)
 *   #664 — CORS allowlist no longer contains http://0.0.0.0:5000
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ─── Module mocks (paths without .js to match moduleNameMapper) ───────────────

jest.mock('../database/db', () => ({
  db: { select: jest.fn() },
}));

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  http: jest.fn(),
};

jest.mock('../server/utils/logger', () => ({
  __esModule: true,
  default: jest.fn(() => mockLogger),
  securityLogger: mockLogger,
  appLogger: mockLogger,
  privacyLogger: mockLogger,
  governanceLogger: mockLogger,
  crosschainLogger: mockLogger,
  walletLogger: mockLogger,
  iotLogger: mockLogger,
  weatherLogger: mockLogger,
}));

jest.mock('../shared/schema-climate-privacy', () => ({
  privateClimateTransactions: 'privateClimateTransactions',
  climateTransactionAuditLog: 'climateTransactionAuditLog',
  privateCarbonCredits: {},
  privateClimateFunds: {},
  climateStealthAddressRegistry: {},
  climatePrivacyKeys: {},
  privateWeatherData: {},
  CLIMATE_PRIVACY_LEVELS: {},
  CLIMATE_STEALTH_ADDRESS_TYPES: {},
}));

jest.mock('../shared/schema', () => ({
  weatherData: {},
  transactions: {},
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((_col: unknown, _val: unknown) => ({ type: 'eq' })),
  and: jest.fn((...args: unknown[]) => ({ type: 'and', args })),
  desc: jest.fn((col: unknown) => col),
  gte: jest.fn(),
  lte: jest.fn(),
  sum: jest.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeQueryChain(limitCapture: { value: number }) {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn(),
  };
  (Object.keys(chain) as Array<keyof typeof chain>).forEach((k) => {
    chain[k].mockReturnValue(chain);
  });
  chain.limit.mockImplementation((v: number) => {
    limitCapture.value = v;
    return chain;
  });
  chain.offset.mockResolvedValue([]);
  return chain;
}

// ─── #665: pagination cap ─────────────────────────────────────────────────────

describe('#665 climatePrivacyController — pagination limit capped', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { db } = require('../database/db') as { db: { select: jest.Mock } };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { climatePrivacyController } = require('../server/controllers/climatePrivacyController') as {
    climatePrivacyController: {
      getPrivateClimateTransactions: (req: unknown, res: unknown) => Promise<void>;
      getClimateTransactionAuditLog: (req: unknown, res: unknown) => Promise<void>;
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as import('express').Response;
  }

  describe('getPrivateClimateTransactions', () => {
    it('caps an over-limit request (1 000 000) to 100', async () => {
      const capture = { value: -1 };
      db.select.mockReturnValue(makeQueryChain(capture));

      const req = {
        query: { limit: '1000000', offset: '0' },
        params: {},
        user: { id: 'u1' },
      } as unknown as import('express').Request;

      await climatePrivacyController.getPrivateClimateTransactions(req, makeRes());

      expect(capture.value).toBe(100);
    });

    it('passes a within-limit value (25) through unchanged', async () => {
      const capture = { value: -1 };
      db.select.mockReturnValue(makeQueryChain(capture));

      const req = {
        query: { limit: '25', offset: '0' },
        params: {},
        user: { id: 'u1' },
      } as unknown as import('express').Request;

      await climatePrivacyController.getPrivateClimateTransactions(req, makeRes());

      expect(capture.value).toBe(25);
    });

    it('uses default 50 when limit param is absent', async () => {
      const capture = { value: -1 };
      db.select.mockReturnValue(makeQueryChain(capture));

      const req = {
        query: { offset: '0' },
        params: {},
        user: { id: 'u1' },
      } as unknown as import('express').Request;

      await climatePrivacyController.getPrivateClimateTransactions(req, makeRes());

      expect(capture.value).toBe(50);
    });
  });

  describe('getClimateTransactionAuditLog', () => {
    it('caps an over-limit audit request (9999) to 200', async () => {
      const capture = { value: -1 };
      db.select.mockReturnValue(makeQueryChain(capture));

      const req = {
        query: { limit: '9999', offset: '0' },
        params: { transactionId: 'tx-abc' },
        user: { id: 'u1' },
      } as unknown as import('express').Request;

      await climatePrivacyController.getClimateTransactionAuditLog(req, makeRes());

      expect(capture.value).toBe(200);
    });
  });
});

// ─── #664: CORS allowlist ─────────────────────────────────────────────────────

describe('#664 CORS — http://0.0.0.0:5000 removed from allowlist', () => {
  // Import the real module once (validateOrigin reads NODE_ENV at call-time,
  // so we can change the env without resetting the module registry).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const corsModule = require('../shared/middleware/cors-config') as {
    validateOrigin: (origin: string) => string | false;
    corsConfig: { ALLOWED_ORIGINS: string[] };
  };

  const origEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = origEnv;
  });

  it('rejects http://0.0.0.0:5000 in production (not a valid browser origin)', () => {
    process.env.NODE_ENV = 'production';
    expect(corsModule.validateOrigin('http://0.0.0.0:5000')).toBe(false);
  });

  it('ALLOWED_ORIGINS export does not contain http://0.0.0.0:5000', () => {
    expect(corsModule.corsConfig.ALLOWED_ORIGINS).not.toContain('http://0.0.0.0:5000');
  });

  it('still allows legitimate localhost origins', () => {
    process.env.NODE_ENV = 'development';
    expect(corsModule.validateOrigin('http://localhost:3000')).toBeTruthy();
    expect(corsModule.validateOrigin('http://127.0.0.1:3000')).toBeTruthy();
  });
});
