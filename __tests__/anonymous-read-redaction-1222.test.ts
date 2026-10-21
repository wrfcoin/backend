/**
 * backend#1222: anonymous reads exposed exact station/device coordinates and
 * per-address reward amounts, `near`/`radius_km` worked as a location oracle,
 * and DB errors were echoed. Each surface keeps its public shape; only the
 * sensitive fields are coarsened, aggregated or dropped. The operator bearer
 * (WRFCOIN_OPERATOR_TOKEN) still sees exact data.
 */
import * as http from 'http';
import * as querystring from 'querystring';
import * as url from 'url';
import express from 'express';
import request from 'supertest';

const OPERATOR = 'test-operator-token-1222';
const AUTH = { Authorization: `Bearer ${OPERATOR}` };

const mockListRegisteredStations = jest.fn();
jest.mock('../server/services/station-registration-service', () => ({
  listRegisteredStations: (...args: unknown[]) => mockListRegisteredStations(...args),
}));
jest.mock('../server/db', () => ({ pool: { query: jest.fn() } }));

const mockFetchCore4Json = jest.fn();
jest.mock('../shared/core4-route-client.js', () => ({
  extractCore4Data: (payload: unknown) => payload,
  fetchCore4Json: (...args: unknown[]) => mockFetchCore4Json(...args),
  sendCore4Error: (res: any, _r: unknown, msg: string) => res.status(502).json({ error: msg }),
  sendCore4Unavailable: (res: any, _e: unknown, msg: string) => res.status(503).json({ error: msg }),
  toNullable: (value: unknown) => value ?? null,
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { coarsenCoordinate, redactRewardEntriesMetadata } = require('../server/utils/anonymous-projection');
const { handleWeatherExportRequest, resetWeatherExportRateLimiter } = require('../server/routes/export-routes');
const { createWeatherLeaderboardRouter } = require('../server/routes/weather-leaderboard-routes');
const { parseNear, NEAR_MIN_RADIUS_KM } = require('../server/routes/leaderboard-regions');
const { createOperatorProfileRouter } = require('../server/routes/operator-profile-routes');
const { createRouter: createRealtimeRouter } = require('../server/routes/storage-realtime-routes');
/* eslint-enable @typescript-eslint/no-var-requires */

// Owner ruling 2026-10-01: no anonymous response carries a position finer than
// 0.1 degree. Walks the whole body; every coordinate-named value must have at
// most one decimal digit.
const COORDINATE_KEY = /^(lat|lng|lon|latitude|longitude)$/i;
function decimals(value: unknown): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}
function expectNoFinerThanOneDecimal(body: unknown, path = 'body'): void {
  if (Array.isArray(body)) {
    body.forEach((item, i) => expectNoFinerThanOneDecimal(item, `${path}[${i}]`));
    return;
  }
  if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(body)) {
      if (COORDINATE_KEY.test(key) && value !== null && value !== undefined && value !== '') {
        expect({ at: `${path}.${key}`, decimals: decimals(value) <= 1 }).toEqual({ at: `${path}.${key}`, decimals: true });
      }
      expectNoFinerThanOneDecimal(value, `${path}.${key}`);
    }
  }
}

beforeEach(() => {
  process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  jest.clearAllMocks();
});
afterAll(() => {
  delete process.env.WRFCOIN_OPERATOR_TOKEN;
});

describe('anonymous-projection helpers', () => {
  it('coarsens to 0.1 deg and tolerates junk', () => {
    expect(coarsenCoordinate(10.123456)).toBe(10.1);
    expect(coarsenCoordinate('-20.987654')).toBe(-21);
    expect(coarsenCoordinate(null)).toBeNull();
    expect(coarsenCoordinate('')).toBeNull();
    expect(coarsenCoordinate('abc')).toBeNull();
  });

  it('aggregates reward_entries (JSON string or array) into a count and total', () => {
    const entries = [
      { address: 'wrfA', amount: 42000, station_id: 's1' },
      { address: 'wrfB', amount: '8000', station_id: 's2' },
    ];
    for (const encoded of [JSON.stringify(entries), entries]) {
      const out = redactRewardEntriesMetadata({ reward_entries: encoded, producer: 'p1' });
      expect(out).toEqual({ producer: 'p1', reward_entries_summary: { count: 2, total_amount: '50000' } });
    }
    expect(redactRewardEntriesMetadata({ reward_entries: '[{"amount":{"v":1}}]' }))
      .toEqual({ reward_entries_summary: { count: 1, total_amount: null } });
    expect(redactRewardEntriesMetadata({ reward_entries: 'not json' }))
      .toEqual({ reward_entries_summary: { count: null, total_amount: null } });
    expect(redactRewardEntriesMetadata({ other: 1 })).toEqual({ other: 1 });
    expect(redactRewardEntriesMetadata(null)).toBeNull();
  });
});

describe('GET /api/weather/stations (contributor map)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const weatherRoutes = require('../server/routes/weather-routes');
  const app = express();
  app.use('/api/weather', weatherRoutes.default ?? weatherRoutes);
  const station = {
    id: 'st-1', stationId: 'st-1', name: 'Hill Top', latitude: 10.123456, longitude: -20.987654,
    location: '1234 Elm St, Duluth', status: 'active', qualityScore: 91, totalRewards: '777', ownerAddress: 'wrfOwner',
  };

  beforeEach(() => {
    mockListRegisteredStations.mockResolvedValue({ stations: [station], nextCursor: null, hasMore: false });
  });

  it('anonymous: coarse coordinates, no free-text location, no owner/rewards', async () => {
    const res = await request(app).get('/api/weather/stations').expect(200);
    expectNoFinerThanOneDecimal(res.body);
    // Owner ruling Q5: the anonymous projection is keyed by the public alias
    // and carries no id/stationId at all.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stationAlias } = require('../server/utils/station-alias');
    expect(res.body.stations[0]).toEqual({
      alias: stationAlias('st-1'), name: 'Hill Top', latitude: 10.1, longitude: -21, status: 'active',
      lastDataUpdate: null, isActive: null, qualityScore: 91,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/46\.786543|Elm St|wrfOwner|777|"st-1"|stationId/);
  });

  it('operator: exact rows', async () => {
    const res = await request(app).get('/api/weather/stations').set(AUTH).expect(200);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stationAlias } = require('../server/utils/station-alias');
    expect(res.body.stations[0]).toEqual({ ...station, alias: stationAlias('st-1') });
  });
});

describe('GET /api/storage/weather/realtime/:stationId', () => {
  const row = {
    station_id: 'phone-abc', latitude: '10.123456', longitude: '-20.987654', temperature: 20,
    humidity: 50, pressure: 1013, wind_speed: 3, wind_direction: 90, rainfall: 0,
    quality_score: 90, source: 'mobile', submitted_at: '2026-09-26T00:00:00.000Z',
  };
  const app = express();
  app.use('/api/storage', createRealtimeRouter({ pool: { query: async () => ({ rows: [row] }) } }));

  it('anonymous: coordinates coarsened; mobile contract fields intact', async () => {
    const res = await request(app).get('/api/storage/weather/realtime/phone-abc').expect(200);
    expectNoFinerThanOneDecimal(res.body);
    expect(res.body.latitude).toBe(10.1);
    expect(res.body.longitude).toBe(-21);
    expect(res.body.temperature).toBe(20);
    expect(res.body.location).toBe('phone-abc');
  });

  it('operator: exact coordinates', async () => {
    const res = await request(app).get('/api/storage/weather/realtime/phone-abc').set(AUTH).expect(200);
    expect(res.body.latitude).toBe(10.123456);
    expect(res.body.longitude).toBe(-20.987654);
  });
});

describe('/api/v1/export', () => {
  const exportRow = {
    station_id: 'st-1', submitted_at: '2026-09-01T00:00:00.000Z', temperature: 20, pressure: 1013,
    humidity: 50, quality_score: 90, reward_amount: '123.45', source: 'station',
    latitude: 10.123456, longitude: -20.987654, distance_km: 3.4567,
  };
  let lastParams: unknown[] = [];

  function server() {
    let served = false;
    const executeQuery = async (_sql: string, params: unknown[] = []) => {
      lastParams = params;
      if (served) return { rows: [] };
      served = true;
      return { rows: [exportRow] };
    };
    return http.createServer(async (req, res) => {
      const parsed = url.parse(req.url || '');
      const handled = await handleWeatherExportRequest({
        path: parsed.pathname || '/', method: req.method,
        query: querystring.parse(parsed.query || ''), req, res, executeQuery,
      });
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  }

  beforeEach(() => resetWeatherExportRateLimiter());

  const region = '/api/v1/export/region?lat=10.12&lon=-20.99&radius_km=0.2&from=2026-08-01&to=2026-09-26';

  it('anonymous JSON: coarse coordinates, no reward amount, whole-km distance, radius clamped', async () => {
    const res = await request(server()).get(region).expect(200);
    expectNoFinerThanOneDecimal(res.body);
    const [obs] = res.body.data.observations;
    expect(obs).toMatchObject({ latitude: 10.1, longitude: -21, rewardAmount: null, distanceKm: 3 });
    expect(res.body.data.filters.radiusKm).toBe(25);
    expect(lastParams).toContain(25);
  });

  it('anonymous CSV carries the same redaction', async () => {
    const res = await request(server())
      .get('/api/v1/export/stations/st-1/observations?format=csv&from=2026-08-01&to=2026-09-26')
      .expect(200);
    const [header, line] = res.text.trim().split('\n');
    const columns = header.split(',');
    const cells = line.split(',');
    columns.forEach((column, i) => {
      if (COORDINATE_KEY.test(column)) expect({ column, decimals: decimals(cells[i]) <= 1 }).toEqual({ column, decimals: true });
    });
    expect(line).not.toContain('123.45');
    expect(line).not.toContain('10.123456');
    expect(line).toContain('10.1');
  });

  it('operator: exact rows and the requested radius', async () => {
    const res = await request(server()).get(region).set(AUTH).expect(200);
    const [obs] = res.body.data.observations;
    expect(obs).toMatchObject({ latitude: 10.123456, longitude: -20.987654, rewardAmount: 123.45, distanceKm: 3.4567 });
    expect(res.body.data.filters.radiusKm).toBe(0.2);
  });
});

describe('GET /api/weather/leaderboard', () => {
  it('clamps near radius_km up to the minimum', () => {
    expect(NEAR_MIN_RADIUS_KM).toBe(25);
    expect(parseNear('10.12,-20.99', '0.1')).toEqual({ lat: 10.12, lng: -20.99, radiusKm: 25 });
    expect(parseNear('10.12,-20.99', '100')).toEqual({ lat: 10.12, lng: -20.99, radiusKm: 100 });
  });

  it('does not echo DB error text', async () => {
    const app = express();
    app.use('/api/weather/leaderboard', createWeatherLeaderboardRouter({
      db: { execute: async () => { throw new Error('relation "users" does not exist at 10.0.0.5'); } },
      cache: null,
      rateLimit: null,
    }));
    const res = await request(app).get('/api/weather/leaderboard').expect(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation|10\.0\.0\.5/);
  });
});

describe('GET /api/operators/:wallet/profile', () => {
  const wallet = 'wrf' + 'b'.repeat(40);
  const db = {
    execute: async (sql: string) => {
      if (/FROM users/i.test(sql)) return { rows: [{ id: 'u1', wallet_address: wallet, created_at: '2026-01-01T00:00:00.000Z' }] };
      if (/SUM\(reward_amount\)/i.test(sql)) return { rows: [{ total_rewards: '98765' }] };
      return { rows: [{ total_submissions: 3, avg_quality: 90, station_count: 1, longest_streak: 2, current_streak: 1, rank: 4 }] };
    },
  };
  const app = express();
  app.use('/api/operators', createOperatorProfileRouter(db));

  it('anonymous: per-address reward total is null, activity stats stay', async () => {
    const res = await request(app).get(`/api/operators/${wallet}/profile`).expect(200);
    expect(res.body.profile.totalRewardsEarned).toBeNull();
    expect(res.body.profile.totalSubmissions).toBe(3);
    expect(JSON.stringify(res.body)).not.toContain('98765');
  });

  it('operator: reward total included', async () => {
    const res = await request(app).get(`/api/operators/${wallet}/profile`).set(AUTH).expect(200);
    expect(res.body.profile.totalRewardsEarned).toBe('98765');
  });

  it('does not echo DB error text', async () => {
    const broken = express();
    broken.use('/api/operators', createOperatorProfileRouter({
      execute: async () => { throw new Error('password authentication failed for user "wrf"'); },
    }));
    const wallet2 = 'wrf' + 'c'.repeat(40);
    for (const path of [`/api/operators/${wallet2}/profile`, `/api/operators/${wallet2}/og-meta`]) {
      const res = await request(broken).get(path).expect(500);
      expect(JSON.stringify(res.body)).not.toMatch(/password|authentication failed/);
    }
  });
});

describe('GET /api/blockchain/blocks/:height', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const blockchainRoutes = require('../server/routes/blockchain-routes');
  const app = express();
  app.use('/api/blockchain', blockchainRoutes.default ?? blockchainRoutes);
  const metadata = {
    producer: 'p1',
    reward_entries: JSON.stringify([
      { address: 'wrfAlice', amount: 42000, station_id: 's1' },
      { address: 'wrfBob', amount: 8000, station_id: 's2' },
    ]),
  };

  beforeEach(() => {
    mockFetchCore4Json.mockResolvedValue({ ok: true, status: 200, payload: { height: 7, hash: 'h', metadata } });
  });

  it('anonymous: reward_entries aggregated, no per-address amounts', async () => {
    const res = await request(app).get('/api/blockchain/blocks/7').expect(200);
    expect(res.body.metadata).toEqual({ producer: 'p1', reward_entries_summary: { count: 2, total_amount: '50000' } });
    expect(JSON.stringify(res.body)).not.toMatch(/wrfAlice|wrfBob/);
  });

  it('operator: raw metadata', async () => {
    const res = await request(app).get('/api/blockchain/blocks/7').set(AUTH).expect(200);
    expect(res.body.metadata).toEqual(metadata);
  });

  // backend#1265: shape of core4 chain.rs chain_block_detail `transactions`.
  const COMMIT = 'ab'.repeat(32);
  const rawTransactions = [
    { type: 'ContributionCommit', sender: '0x7d29aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', station_id: 'PWS-EXAMPLE-WS5000', extra: 'x' },
    { type: 'ContributionReveal', sender: '0x1747bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', payload: { commit_id: COMMIT, station_id: 'PWS-EXAMPLE-PRIVATE-01', nonce: 'n-secret' } },
    { type: 'OracleAttestation', sender: '0xed36cccccccccccccccccccccccccccccccccccc', payload: { commit_id: COMMIT, oracle_id: 'oracle-1', approved: true, nonce: 7 } },
    { type: 'OracleAttestation', sender: '0xabc', payload_error: 'undecodable_canonical_payload' },
    { type: 'Bad Type With Spaces', payload: { commit_id: 'not-hex', oracle_id: 'has space', approved: 'yes' } },
    'not-an-object',
    null,
  ];

  it('anonymous: transactions are an allowlist projection (no sender, station id, nonce, unknown keys)', async () => {
    mockFetchCore4Json.mockResolvedValue({ ok: true, status: 200, payload: { height: 7, hash: 'h', tx_count: 7, transactions: rawTransactions } });
    const res = await request(app).get('/api/blockchain/blocks/7').expect(200);
    expect(res.body.transactionCount).toBe(7);
    expect(res.body.transactions).toEqual([
      { type: 'ContributionCommit' },
      { type: 'ContributionReveal', payload: { commit_id: COMMIT } },
      { type: 'OracleAttestation', payload: { commit_id: COMMIT, oracle_id: 'oracle-1', approved: true } },
      { type: 'OracleAttestation', payload_error: 'undecodable_canonical_payload' },
      { type: null, payload: {} },
      { type: null },
      { type: null },
    ]);
    expect(JSON.stringify(res.body.transactions)).not.toMatch(/0x7d29|0x1747|0xed36|PWS-|JON|STEVEN|n-secret|extra|sender|station_id/);
  });

  it('operator: raw transactions are unchanged', async () => {
    mockFetchCore4Json.mockResolvedValue({ ok: true, status: 200, payload: { height: 7, hash: 'h', transactions: rawTransactions } });
    const res = await request(app).get('/api/blockchain/blocks/7').set(AUTH).expect(200);
    expect(res.body.transactions).toEqual(rawTransactions);
  });

  it('anonymous: a missing or malformed transactions field is an empty list', async () => {
    for (const transactions of [undefined, null, 'x', { a: 1 }]) {
      mockFetchCore4Json.mockResolvedValue({ ok: true, status: 200, payload: { height: 7, hash: 'h', transactions } });
      expect((await request(app).get('/api/blockchain/blocks/7').expect(200)).body.transactions).toEqual([]);
    }
  });
});

// Stage 1.5 / frontend#349: the per-station detail routes must never carry
// coordinates or owner/device identity, even when an upstream row does.
describe('GET /api/stations/:id/{observations,quality,submissions} carry no location or owner', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createStationDetailRouter } = require('../server/routes/station-detail-routes');
  const leaky = {
    latitude: 10.123456, longitude: -20.987654, owner_address: 'wrfOwnerLeak', device_id: 'MAC-AA:BB',
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { stationAlias } = require('../server/utils/station-alias');
  const ALIAS = stationAlias('st-1');
  const db = {
    execute: async (sql: string) => {
      // Owner ruling Q5: anonymous callers address the station by alias.
      if (/sha256\(/.test(sql)) return { rows: [{ station_id: 'st-1' }] };
      if (/weather_data_quality/.test(sql)) {
        return { rows: [{ quality_score: 90, confidence: 0.9, factors: { freshness: 1 }, ...leaky }] };
      }
      if (/weather_commitments/.test(sql)) {
        return { rows: [{ id: 1, commitment_hash: 'abcdef0123456789', status: 'revealed', created_at: 't', reveal_deadline: 't', ...leaky }] };
      }
      return { rows: [{ timestamp: 't', temperature: 20, ...leaky }] };
    },
  };
  const core4Item = {
    commit_id: 'c1', station_id: 'st-1', height: 7, observed_at: 1, values: { temperature_c: 20 },
    provenance_class: 'real', attestation: { approvals: 2, has_quorum: true }, ...leaky,
  };

  it.each([
    ['core4 observations', 'reader', `/api/stations/${ALIAS}/observations`],
    ['backend-db observations', undefined, `/api/stations/${ALIAS}/observations`],
    ['quality', undefined, `/api/stations/${ALIAS}/quality`],
    ['submissions', undefined, `/api/stations/${ALIAS}/submissions`],
  ])('%s', async (_label, token, path) => {
    const app = express();
    app.use('/api', createStationDetailRouter({
      db,
      readerToken: () => token,
      fetchCore4Json: async () => ({ ok: true, status: 200, payload: { ok: true, data: { items: [core4Item], has_more: false } } }),
    }));
    const res = await request(app).get(path).expect(200);
    // Non-vacuous: the leaky upstream row was actually served.
    expect(JSON.stringify(res.body)).toMatch(/"temperatureC":20|"overall":90|"commitmentHash":"abcdef0123456789"/);
    if (token) expect(res.body.source).toBe('core4');
    expect(JSON.stringify(res.body)).not.toMatch(/latitude|longitude|46\.78|wrfOwnerLeak|owner|MAC-AA|"st-1"/);
  });
});
