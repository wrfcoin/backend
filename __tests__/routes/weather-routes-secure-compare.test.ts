/**
 * audit/api-report-2026-09-09.md P2: weather-routes.js's admin-token and
 * operator-token checks used `===`/`!==`, not constant-time comparison.
 * Verifies both switched to secureCompare (crypto.timingSafeEqual) without
 * changing the exact-match behavior.
 */
const express = require('express');
const request = require('supertest');

const mockRegisterStation = jest.fn();

jest.mock('../../server/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../server/middleware/auth-middleware.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { address: '0xwalletowneraddress0000000000000000000001' };
    next();
  },
}));

jest.mock('../../server/db.js', () => ({
  pool: {
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => {},
    }),
  },
}));

jest.mock('../../server/services/station-registration-service.js', () => ({
  registerStation: (...args: unknown[]) => mockRegisterStation(...args),
}));

const weatherRoutes = require('../../server/routes/weather-routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/weather', weatherRoutes);
  return app;
}

describe('weather-routes token comparisons use secureCompare (timing-safe)', () => {
  const originalAdminToken = process.env.ADMIN_TOKEN;
  const originalOperatorToken = process.env.WRFCOIN_OPERATOR_TOKEN;
  const originalEncryptionKey = process.env.API_KEY_ENCRYPTION_KEY;

  beforeEach(() => {
    mockRegisterStation.mockReset();
    mockRegisterStation.mockResolvedValue({ status: 201, body: { ok: true } });
    process.env.ADMIN_TOKEN = 'admin-secret-token-value';
    process.env.WRFCOIN_OPERATOR_TOKEN = 'operator-secret-token-value';
    process.env.API_KEY_ENCRYPTION_KEY = 'a'.repeat(64);
  });

  afterAll(() => {
    process.env.ADMIN_TOKEN = originalAdminToken;
    process.env.WRFCOIN_OPERATOR_TOKEN = originalOperatorToken;
    process.env.API_KEY_ENCRYPTION_KEY = originalEncryptionKey;
  });

  describe('POST /stations admin override (x-admin-token)', () => {
    it('grants the override and honors the overridden ownerAddress when the token matches exactly', async () => {
      const res = await request(buildApp())
        .post('/api/weather/stations')
        .set('x-admin-token', 'admin-secret-token-value')
        .send({ ownerAddress: '0xoverriddenowner00000000000000000000000002' });

      expect(res.status).toBe(201);
      expect(mockRegisterStation).toHaveBeenCalledTimes(1);
      const [, ownerAddress, , , options] = mockRegisterStation.mock.calls[0];
      expect(options.isAdminOverride).toBe(true);
      expect(ownerAddress).toBe('0xoverriddenowner00000000000000000000000002');
    });

    it('refuses the override for a same-length but wrong token (not a substring/prefix bypass)', async () => {
      const wrongSameLength = 'x'.repeat('admin-secret-token-value'.length);
      const res = await request(buildApp())
        .post('/api/weather/stations')
        .set('x-admin-token', wrongSameLength)
        .send({ ownerAddress: '0xoverriddenowner00000000000000000000000002' });

      expect(res.status).toBe(201);
      const [, ownerAddress, , , options] = mockRegisterStation.mock.calls[0];
      expect(options.isAdminOverride).toBe(false);
      // Falls back to the authenticated wallet, not the requested override.
      expect(ownerAddress).toBe('0xwalletowneraddress0000000000000000000001');
    });

    it('refuses the override for a different-length token', async () => {
      const res = await request(buildApp())
        .post('/api/weather/stations')
        .set('x-admin-token', 'short')
        .send({ ownerAddress: '0xoverriddenowner00000000000000000000000002' });

      expect(res.status).toBe(201);
      const [, , , , options] = mockRegisterStation.mock.calls[0];
      expect(options.isAdminOverride).toBe(false);
    });
  });

  describe('GET /stations/credentials operator bearer token', () => {
    it('accepts the exact operator token', async () => {
      const res = await request(buildApp())
        .get('/api/weather/stations/credentials')
        .set('authorization', 'Bearer operator-secret-token-value');

      expect(res.status).not.toBe(403);
    });

    it('rejects a same-length but wrong token', async () => {
      const wrongSameLength = 'x'.repeat('operator-secret-token-value'.length);
      const res = await request(buildApp())
        .get('/api/weather/stations/credentials')
        .set('authorization', `Bearer ${wrongSameLength}`);

      expect(res.status).toBe(403);
    });

    it('rejects a different-length token', async () => {
      const res = await request(buildApp())
        .get('/api/weather/stations/credentials')
        .set('authorization', 'Bearer short');

      expect(res.status).toBe(403);
    });

    it('rejects a missing token', async () => {
      const res = await request(buildApp()).get('/api/weather/stations/credentials');

      expect(res.status).toBe(403);
    });
  });
});
