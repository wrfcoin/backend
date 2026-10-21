/**
 * Tests for sensor-ingest-routes.ts commit-reveal forwarding (#191).
 *
 * Verifies that after successful DB persistence, the sensor ingest handler
 * fires a commit to the weather commit-reveal service, and that commit
 * failures do not cause a 500 response to the mobile client.
 */

import express from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that transitively pull them in
// ---------------------------------------------------------------------------

// Mock auth middleware — prevent transitive import of redis-session-service.
// Tests can override `mockAuthUser` per-case to simulate different callers.
let mockAuthUser: Record<string, unknown> | null = { userId: 42 };
jest.mock('../../server/middleware/auth.js', () => ({
  authenticateSessionJWT: (req: any, _res: any, next: any) => {
    if (mockAuthUser) {
      req.user = mockAuthUser;
    }
    next();
  },
}));

const mockValidatePhysics = jest.fn();
const mockQualityScore = jest.fn();
jest.mock('../../server/services/physics-validation.js', () => ({
  validatePhysics: mockValidatePhysics,
  qualityScore: mockQualityScore,
  DEFAULT_PHYSICS_POLICY: {
    tempMinC: -89.2, tempMaxC: 70.7,
    pressureMinHpa: 870.0, pressureMaxHpa: 1085.0,
    humidityMinPct: 0.0, humidityMaxPct: 100.0,
    windSpeedMaxMs: 113.3, tempRateMaxCPerMin: 5.0,
  },
}));

const mockCommit = jest.fn();
jest.mock('../../server/routes/weather-commit-reveal-routes.js', () => ({
  createWeatherCommitRevealService: () => ({
    commit: mockCommit,
  }),
}));

import { createSensorIngestRouter } from '../../server/routes/sensor-ingest-routes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function makeDb(responses: { rows: Row[] }[]) {
  let call = 0;
  return {
    execute: jest.fn(async (_sql: string, _params?: unknown[]) => {
      return responses[call++] ?? { rows: [] };
    }),
  };
}

function makeApp(db: { execute: jest.Mock }) {
  const app = express();
  app.use(express.json());
  app.use('/api/sensors', createSensorIngestRouter(db as any));
  return app;
}

const VALID_ADDR = '0xaBcD1234567890aBcD1234567890aBcD12345678';
const VALID_BODY = {
  walletAddress: VALID_ADDR,
  deviceId: 'device-001',
  latitude: 51.5,
  longitude: -0.12,
  temperature: 20.5,
  pressure: 1013.25,
  humidity: 55,
  timestampUnix: 1700000000,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthUser = { userId: 42 };
  mockValidatePhysics.mockReturnValue([]);
  mockQualityScore.mockReturnValue(100);
  // Default: commit succeeds
  mockCommit.mockResolvedValue({ commitmentId: 1, revealDeadline: 10, commitmentHash: 'abc', core4: {} });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/sensors/reading — commit-reveal forwarding (#191)', () => {
  it('calls commit after successful DB persistence', async () => {
    const db = makeDb([
      { rows: [{ wallet_address: VALID_ADDR }] }, // ownership lookup (users.id -> wallet_address)
      { rows: [{ '?column?': 1 }] },               // social_accounts exists
      { rows: [] },                                 // INSERT
    ]);
    const app = makeApp(db);

    const res = await request(app).post('/api/sensors/reading').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);

    // Give the fire-and-forget promise a tick to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCommit).toHaveBeenCalledTimes(1);
    const commitArg = mockCommit.mock.calls[0][0];
    expect(commitArg.stationId).toBe('device-001');
    expect(commitArg.contributor).toBe(VALID_ADDR);
    expect(commitArg.nonce).toBeDefined();
    expect(commitArg.readings).toHaveLength(1);
    expect(commitArg.readings[0]).toEqual(expect.objectContaining({
      temperature_c: 20.5,
      pressure_hpa: 1013.25,
      humidity_percent: 55,
      wind_speed_ms: null,
      latitude: 51.5,
      longitude: -0.12,
      timestamp_unix: 1700000000,
    }));
  });

  it('returns 200 even when commit-reveal forwarding fails', async () => {
    // Make commit reject — simulates core4 being unreachable
    mockCommit.mockRejectedValue(new Error('core4 is down'));

    const db = makeDb([
      { rows: [{ wallet_address: VALID_ADDR }] }, // ownership lookup
      { rows: [{ '?column?': 1 }] },               // social_accounts exists
      { rows: [] },                                 // INSERT
    ]);
    const app = makeApp(db);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).post('/api/sensors/reading').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);

    // Give the fire-and-forget .catch() a tick to run
    await new Promise((r) => setTimeout(r, 10));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[sensor-ingest] commit-reveal forwarding failed:',
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('does NOT call commit when DB INSERT fails', async () => {
    const db = makeDb([]);
    // Make the INSERT throw
    db.execute.mockImplementationOnce(async () => ({ rows: [{ wallet_address: VALID_ADDR }] })) // ownership
      .mockImplementationOnce(async () => ({ rows: [{ '?column?': 1 }] }))                       // social
      .mockImplementationOnce(async () => { throw new Error('DB write failed'); });              // INSERT

    const app = makeApp(db);

    const res = await request(app).post('/api/sensors/reading').send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('does NOT call commit when social account check fails (403)', async () => {
    const db = makeDb([
      { rows: [{ wallet_address: VALID_ADDR }] }, // ownership lookup succeeds
      { rows: [] },                                 // social_accounts empty
    ]);
    const app = makeApp(db);

    const res = await request(app).post('/api/sensors/reading').send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('does NOT call commit and returns 401 when there is no authenticated caller (#886)', async () => {
    mockAuthUser = null;
    const db = makeDb([]);
    const app = makeApp(db);

    const res = await request(app).post('/api/sensors/reading').send(VALID_BODY);

    expect(res.status).toBe(401);
    expect(mockCommit).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('does NOT call commit and returns 403 when the caller has no wallet linked (#886)', async () => {
    const db = makeDb([{ rows: [] }]); // users lookup finds no row / null wallet_address
    const app = makeApp(db);

    const res = await request(app).post('/api/sensors/reading').send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('No wallet linked');
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('does NOT call commit and returns 403 when body walletAddress does not match the caller\'s own wallet — Sybil reward-farming guard (#886)', async () => {
    const OTHER_ADDR = '0x1111111111111111111111111111111111111111';
    const db = makeDb([
      { rows: [{ wallet_address: VALID_ADDR }] }, // caller actually owns VALID_ADDR
    ]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/sensors/reading')
      .send({ ...VALID_BODY, walletAddress: OTHER_ADDR });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('maps optional weather fields to null when absent', async () => {
    const minimalBody = {
      walletAddress: VALID_ADDR,
      deviceId: 'device-minimal',
      latitude: 40.0,
      longitude: -74.0,
      timestampUnix: 1700000000,
    };

    const db = makeDb([
      { rows: [{ wallet_address: VALID_ADDR }] }, // ownership lookup
      { rows: [{ '?column?': 1 }] },               // social_accounts exists
      { rows: [] },                                 // INSERT
    ]);
    const app = makeApp(db);

    const res = await request(app).post('/api/sensors/reading').send(minimalBody);

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCommit).toHaveBeenCalledTimes(1);
    const reading = mockCommit.mock.calls[0][0].readings[0];
    expect(reading.temperature_c).toBeNull();
    expect(reading.pressure_hpa).toBeNull();
    expect(reading.humidity_percent).toBeNull();
    expect(reading.wind_speed_ms).toBeNull();
  });
});
