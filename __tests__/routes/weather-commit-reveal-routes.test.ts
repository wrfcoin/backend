/**
 * Unit tests for weather-commit-reveal-routes.ts
 *
 * Tests the backend->core4 forwarding path by mocking global.fetch (used
 * internally by fetchJson) and the DB executor.  No real HTTP servers or
 * databases are required.
 *
 * Closes #328
 */

import {
  createWeatherCommitRevealService,
  startCommitmentExpiryJob,
  startRevealSchedulerJob,
  type WeatherCommitRequest,
  type WeatherRevealRequest,
} from '../../server/routes/weather-commit-reveal-routes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QueryResult = { rows: Record<string, unknown>[] };

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

// ---------------------------------------------------------------------------
// Mock DB helper
// ---------------------------------------------------------------------------

function createMockDb(): DbExecutor & {
  rows: Record<string, unknown>[];
  executeCalls: Array<{ sql: string; params?: unknown[] }>;
} {
  let nextId = 1;
  const rows: Record<string, unknown>[] = [];
  const executeCalls: Array<{ sql: string; params?: unknown[] }> = [];

  const execute = async (sql: string, params?: unknown[]): Promise<QueryResult> => {
    executeCalls.push({ sql, params });
    const trimmed = sql.replace(/\s+/g, ' ').trim();

    // DDL no-ops
    if (
      trimmed.startsWith('CREATE TABLE IF NOT EXISTS') ||
      trimmed.startsWith('CREATE INDEX IF NOT EXISTS') ||
      trimmed.startsWith('ALTER TABLE') ||
      trimmed.startsWith('DO $$ BEGIN ALTER') ||
      trimmed.startsWith('DO $$ BEGIN')
    ) {
      return { rows: [] };
    }

    // INSERT INTO weather_commitments ... RETURNING id
    if (trimmed.includes('INSERT INTO weather_commitments') && trimmed.includes('RETURNING id')) {
      const id = nextId++;
      const row: Record<string, unknown> = {
        id,
        station_id: params?.[0],
        commitment_hash: params?.[1],
        reveal_deadline: params?.[2],
        status: 'pending',
        nonce: params?.[3],
        readings_json: params?.[4],
        contributor: params?.[5],
        commit_timestamp: params?.[6],
      };
      rows.push(row);
      return { rows: [{ id }] };
    }

    // DELETE FROM weather_commitments WHERE id = $1
    if (trimmed.includes('DELETE FROM weather_commitments') && trimmed.includes('WHERE id =')) {
      const id = Number(params?.[0]);
      const idx = rows.findIndex((r) => Number(r.id) === id);
      if (idx !== -1) rows.splice(idx, 1);
      return { rows: [] };
    }

    // SELECT ... FROM weather_commitments WHERE id = $1
    if (trimmed.includes('FROM weather_commitments') && trimmed.includes('WHERE id =') && !trimmed.includes('UPDATE')) {
      const id = Number(params?.[0]);
      const found = rows.filter((r) => Number(r.id) === id);
      return { rows: found };
    }

    // SELECT ... FROM weather_commitments WHERE station_id = $1  (listCommitments)
    if (trimmed.includes('FROM weather_commitments') && trimmed.includes('WHERE station_id =')) {
      const stationId = String(params?.[0]);
      const found = rows.filter((r) => r.station_id === stationId);
      return { rows: found };
    }

    // SELECT ... pending commitments eligible for auto-reveal
    if (trimmed.includes('FROM weather_commitments') && trimmed.includes("status = 'pending'") && trimmed.includes('reveal_deadline <=')) {
      const height = Number(params?.[0]);
      const found = rows.filter(
        (r) =>
          r.status === 'pending' &&
          Number(r.reveal_deadline) <= height &&
          r.nonce != null &&
          r.readings_json != null
      );
      return { rows: found.slice(0, 50) };
    }

    // UPDATE ... SET status = 'revealing' WHERE id = $1 AND status = 'pending'
    if (trimmed.includes("SET status = 'revealing'") && trimmed.includes('WHERE id =')) {
      const id = Number(params?.[0]);
      const updated: Record<string, unknown>[] = [];
      for (const r of rows) {
        if (Number(r.id) === id && r.status === 'pending') {
          r.status = 'revealing';
          updated.push(r);
        }
      }
      return { rows: updated };
    }

    // UPDATE ... SET status = $2 WHERE id = $1 AND status = 'revealing'
    if (trimmed.includes('SET status = $2') && trimmed.includes('WHERE id =')) {
      const id = Number(params?.[0]);
      const nextStatus = String(params?.[1]);
      for (const r of rows) {
        if (Number(r.id) === id && r.status === 'revealing') r.status = nextStatus;
      }
      return { rows: [] };
    }

    // Finalize reveal status and submission accounting atomically.
    if (trimmed.startsWith('WITH finalized AS')) {
      const id = Number(params?.[0]);
      let finalizedCount = 0;
      for (const r of rows) {
        if (Number(r.id) === id && r.status === 'revealing') {
          r.status = 'revealed';
          finalizedCount = 1;
        }
      }
      return { rows: [{ finalized_count: finalizedCount, inserted_count: finalizedCount }] };
    }

    // UPDATE ... SET status = 'revealed' WHERE id = $1
    if (trimmed.includes("SET status = 'revealed'") && trimmed.includes('WHERE id =')) {
      const id = Number(params?.[0]);
      for (const r of rows) {
        if (Number(r.id) === id) r.status = 'revealed';
      }
      return { rows: [] };
    }

    // UPDATE ... SET status = 'expired'
    if (trimmed.includes("SET status = 'expired'")) {
      const height = Number(params?.[0]);
      const updated: Record<string, unknown>[] = [];
      for (const r of rows) {
        if (r.status === 'pending' && Number(r.reveal_deadline) + 100 < height) {
          r.status = 'expired';
          updated.push(r);
        }
      }
      return { rows: updated };
    }

    // UPDATE ... SET status = 'reveal_failed'
    if (trimmed.includes("SET status = 'reveal_failed'")) {
      const id = Number(params?.[0]);
      for (const r of rows) {
        if (Number(r.id) === id && (r.status === 'pending' || r.status === 'revealing')) r.status = 'reveal_failed';
      }
      return { rows: [] };
    }

    // INSERT INTO weather_submissions -- no-op
    if (trimmed.includes('INSERT INTO weather_submissions')) {
      return { rows: [] };
    }

    // Fallback
    return { rows: [] };
  };

  return { execute, rows, executeCalls };
}

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

type MockRoute = {
  method: string;
  pathPrefix: string;
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown };
};

function installFetchMock(routes: MockRoute[]) {
  (global as any).fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const pathname = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return url;
      }
    })();
    const method = (init?.method ?? 'GET').toUpperCase();

    for (const route of routes) {
      const matchesPath =
        url.includes(route.pathPrefix) ||
        (route.pathPrefix === '/api/blockchain/height' && pathname === '/blockchain');
      if (method === route.method.toUpperCase() && matchesPath) {
        const { status, body } = route.handler(url, init);
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Default 404
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function restoreFetch() {
  global.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Valid test readings
// ---------------------------------------------------------------------------

const validReading = {
  temperature_c: 22.5,
  pressure_hpa: 1013.25,
  humidity_percent: 65.0,
  timestamp: '2026-03-25T12:00:00Z',
};

const validReadingLegacy = {
  temperature_c: 22.5,
  pressure_hpa: 1013.25,
  humidity_pct: 65.0,
  timestamp: '2026-03-25T12:00:00Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('weather-commit-reveal-routes', () => {
  const originalOperatorToken = process.env.WRFCOIN_OPERATOR_TOKEN;

  beforeEach(() => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'test-token';
  });

  afterEach(() => {
    restoreFetch();
    jest.restoreAllMocks();
    if (originalOperatorToken === undefined) {
      delete process.env.WRFCOIN_OPERATOR_TOKEN;
    } else {
      process.env.WRFCOIN_OPERATOR_TOKEN = originalOperatorToken;
    }
  });

  // =========================================================================
  // 1. createWeatherCommitRevealService factory
  // =========================================================================

  describe('createWeatherCommitRevealService factory', () => {
    it('creates a service with all expected methods', () => {
      const db = createMockDb();
      installFetchMock([]);

      const service = createWeatherCommitRevealService({ db, core4BaseUrl: 'http://localhost:9999' });
      expect(typeof service.commit).toBe('function');
      expect(typeof service.reveal).toBe('function');
      expect(typeof service.listCommitments).toBe('function');
      expect(typeof service.expireStaleCommitments).toBe('function');
      expect(typeof service.revealPendingCommitments).toBe('function');
    });

    it('respects custom core4BaseUrl', async () => {
      const db = createMockDb();
      let capturedUrl = '';

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: (url) => {
            capturedUrl = url;
            return { status: 200, body: { height: 10 } };
          },
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://custom-host:7777',
      });

      await service.commit({
        stationId: 'WX-001',
        readings: [validReading],
        nonce: 'n1',
      });

      expect(capturedUrl).toContain('http://custom-host:7777');
    });

    it('respects custom defaultContributor', async () => {
      const db = createMockDb();
      let capturedPayload: any = null;

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 5 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: (_url, init) => {
            capturedPayload = JSON.parse(init?.body as string);
            return { status: 200, body: { success: true } };
          },
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        defaultContributor: '0xMY_CUSTOM_CONTRIBUTOR',
      });

      await service.commit({
        stationId: 'WX-001',
        readings: [validReading],
        nonce: 'n1',
      });

      expect(capturedPayload.contributor).toBe('0xMY_CUSTOM_CONTRIBUTOR');
    });
  });

  // =========================================================================
  // 2. Commit path (happy path)
  // =========================================================================

  describe('commit (happy path)', () => {
    it('commits with valid request and returns expected shape', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 100 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { txId: 'abc123' } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        defaultContributor: '0xTEST',
      });

      const result = await service.commit({
        stationId: 'WX-HAPPY-001',
        readings: [validReading],
        nonce: 'happy-nonce',
      });

      // Shape assertions
      expect(result.commitmentId).toBeGreaterThan(0);
      expect(result.revealDeadline).toBe(103); // 100 + 3
      expect(result.commitmentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.core4).toEqual({ txId: 'abc123' });
    });

    it('stores commitment in DB with correct fields', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 50 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        defaultContributor: '0xTEST',
      });

      await service.commit({
        stationId: 'WX-DB-001',
        readings: [validReading],
        nonce: 'db-nonce',
        contributor: '0xCONTRIBUTOR',
      });

      // Check the DB row was inserted
      expect(db.rows).toHaveLength(1);
      const row = db.rows[0];
      expect(row.station_id).toBe('WX-DB-001');
      expect(row.status).toBe('pending');
      expect(row.nonce).toBe('db-nonce');
      expect(row.contributor).toBe('0xCONTRIBUTOR');
      expect(row.commitment_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.reveal_deadline).toBe(53);
    });

    it('forwards correct snake_case payload to core4', async () => {
      const db = createMockDb();
      let capturedPayload: any = null;

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: (_url, init) => {
            capturedPayload = JSON.parse(init?.body as string);
            return { status: 200, body: { success: true } };
          },
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        defaultContributor: '0xDEFAULT',
      });

      await service.commit({
        stationId: 'WX-SNAKE-001',
        readings: [validReading],
        nonce: 'snake-nonce',
      });

      expect(capturedPayload).toHaveProperty('station_id', 'WX-SNAKE-001');
      expect(capturedPayload).toHaveProperty('commit_hash');
      expect(capturedPayload).toHaveProperty('contributor', '0xDEFAULT');
      // Must NOT use camelCase
      expect(capturedPayload).not.toHaveProperty('stationId');
      expect(capturedPayload).not.toHaveProperty('commitHash');
    });

    it('normalizes legacy humidity_pct field in readings', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 5 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const result = await service.commit({
        stationId: 'WX-LEGACY-001',
        readings: [validReadingLegacy],
        nonce: 'legacy-nonce',
      });

      // Should succeed without error (normalization happened internally)
      expect(result.commitmentHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // =========================================================================
  // 3. Reveal path (happy path)
  // =========================================================================

  describe('reveal (happy path)', () => {
    it('reveals a valid commitment and returns expected shape', async () => {
      const db = createMockDb();
      let revealPayload: any = null;

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: (_url, init) => {
            revealPayload = JSON.parse(init?.body as string);
            return { status: 200, body: { success: true, rewardTx: 'rx1' } };
          },
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        defaultContributor: '0xTEST',
      });

      // Commit first
      const commitResult = await service.commit({
        stationId: 'WX-REVEAL-001',
        readings: [validReading],
        nonce: 'reveal-nonce',
      });

      // Advance height past deadline
      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: (_url, init) => {
            revealPayload = JSON.parse(init?.body as string);
            return { status: 200, body: { success: true, rewardTx: 'rx1' } };
          },
        },
      ]);

      const revealResult = await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'reveal-nonce',
      });

      // Shape assertions
      expect(revealResult.receiptId).toMatch(/^wrf-/);
      expect(revealResult.stationId).toBe('WX-REVEAL-001');
      expect(revealResult.accuracyScore).toBe(100);
      expect(typeof revealResult.rewardEstimate).toBe('string');
      expect(revealResult.core4).toEqual({ success: true, rewardTx: 'rx1' });

      // DB commitment should be marked revealed
      const row = db.rows.find((r) => Number(r.id) === commitResult.commitmentId);
      expect(row?.status).toBe('revealed');

      // Reveal payload should include correct fields
      expect(revealPayload).toHaveProperty('station_id', 'WX-REVEAL-001');
      expect(revealPayload).toHaveProperty('commit_hash');
      expect(revealPayload).toHaveProperty('nonce', 'reveal-nonce');
      expect(revealPayload).toHaveProperty('payload');
      // core4 requires payload to be a JSON object, not the readings array (#767)
      expect(Array.isArray(revealPayload.payload)).toBe(false);
      expect(typeof revealPayload.payload).toBe('object');
      expect(typeof revealPayload.timestamp).toBe('number');
    });

    it('passes optional data_cid, data_hash, and storage_provider to core4', async () => {
      const db = createMockDb();
      let revealPayload: any = null;

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        defaultContributor: '0xTEST',
      });

      const commitResult = await service.commit({
        stationId: 'WX-OPT-001',
        readings: [validReading],
        nonce: 'opt-nonce',
      });

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: (_url, init) => {
            revealPayload = JSON.parse(init?.body as string);
            return { status: 200, body: { success: true } };
          },
        },
      ]);

      await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'opt-nonce',
        data_cid: 'QmTestCid123',
        data_hash: 'abc123hash',
        storage_provider: 'ipfs',
      });

      expect(revealPayload.data_cid).toBe('QmTestCid123');
      expect(revealPayload.data_hash).toBe('abc123hash');
      expect(revealPayload.storage_provider).toBe('ipfs');
    });

    it('records an outlier shadow result after finalization without changing reward', async () => {
      const db = createMockDb();
      const scoreReveal = jest.fn(async () => {
        const row = db.rows.find((entry) => entry.station_id === 'WX-SHADOW-001');
        expect(row?.status).toBe('revealed');
        return { tier: 'outlier' as const, bandsVersion: 1 };
      });

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        referenceShadow: true,
        referenceScorer: { scoreReveal },
      });
      const commitResult = await service.commit({
        stationId: 'WX-SHADOW-001',
        readings: [validReading],
        nonce: 'shadow-nonce',
      });

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 200, body: { success: true, rewardTx: 'paid' } }),
        },
      ]);

      const result = await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'shadow-nonce',
      });

      expect(result.referenceScore).toEqual({ tier: 'outlier', bandsVersion: 1 });
      expect(result.rewardEstimate).toBe('0.05');
      expect(result.core4).toEqual({ success: true, rewardTx: 'paid' });
      expect(scoreReveal).toHaveBeenCalledTimes(1);
    });

    it('fails open when the advisory scorer is unavailable', async () => {
      const db = createMockDb();
      const scoreReveal = jest.fn(async () => {
        throw new Error('oracle-reference unavailable');
      });

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        referenceShadow: true,
        referenceScorer: { scoreReveal },
      });
      const commitResult = await service.commit({
        stationId: 'WX-SHADOW-FAILOPEN',
        readings: [validReading],
        nonce: 'shadow-failopen-nonce',
      });

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 200, body: { success: true, rewardTx: 'paid' } }),
        },
      ]);

      const result = await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'shadow-failopen-nonce',
      });

      expect(result.referenceScore).toBeUndefined();
      expect(result.rewardEstimate).toBe('0.05');
      expect(result.core4).toEqual({ success: true, rewardTx: 'paid' });
    });

    // The default-off gate is what keeps this feature inert in production.
    // Every other test in this block passes `referenceShadow: true`, so
    // replacing the gate with an unconditional enable left the suite green
    // while activating an outbound oracle call and advisory persistence by
    // default. These two cases pin the gate in BOTH directions — a test that
    // only proves the gate closes cannot tell "correctly disabled" apart from
    // "wired to nothing".
    async function runRevealWithScorer(
      db: ReturnType<typeof createMockDb>,
      stationId: string,
      serviceOptions: Record<string, unknown>,
    ) {
      const scoreReveal = jest.fn(async () => ({
        tier: 'good' as const,
        bandsVersion: 1,
      }));

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        referenceScorer: { scoreReveal },
        ...serviceOptions,
      });
      const commitResult = await service.commit({
        stationId,
        readings: [validReading],
        nonce: `${stationId}-nonce`,
      });

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 200, body: { success: true, rewardTx: 'paid' } }),
        },
      ]);

      const result = await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: `${stationId}-nonce`,
      });

      return { result, scoreReveal };
    }

    it.each([['14', 14], ['13', 13], ['12', 12], ['', null]])(
      'passes resolved height and configured activation %s to production scoring', async (configured, expected) => {
        const previous = process.env.REFERENCE_GROSS_GUARD_ACTIVATION_HEIGHT;
        process.env.REFERENCE_GROSS_GUARD_ACTIVATION_HEIGHT = configured as string;
        try {
          const { scoreReveal } = await runRevealWithScorer(createMockDb(), 'WX-CONTEXT', { referenceShadow: true });
          expect(scoreReveal).toHaveBeenCalledWith(expect.objectContaining({
            tieringContext: { height: 13, grossGuardActivationHeight: expected },
          }));
        } finally {
          if (previous === undefined) delete process.env.REFERENCE_GROSS_GUARD_ACTIVATION_HEIGHT;
          else process.env.REFERENCE_GROSS_GUARD_ACTIVATION_HEIGHT = previous;
        }
      },
    );
    it.each(['-1', '1.5', '9007199254740992', 'garbage'])('skips only advisory scoring for invalid activation %s', async configured => {
      const previous = process.env.REFERENCE_GROSS_GUARD_ACTIVATION_HEIGHT;
      process.env.REFERENCE_GROSS_GUARD_ACTIVATION_HEIGHT = configured;
      try {
        const { result, scoreReveal } = await runRevealWithScorer(createMockDb(), 'WX-BAD-CONTEXT', { referenceShadow: true });
        expect(scoreReveal).not.toHaveBeenCalled();
        expect(result.referenceScore).toBeUndefined();
        expect(result.rewardEstimate).toBe('0.05');
        expect(result.core4).toEqual({ success: true, rewardTx: 'paid' });
      } finally {
        if (previous === undefined) delete process.env.REFERENCE_GROSS_GUARD_ACTIVATION_HEIGHT;
        else process.env.REFERENCE_GROSS_GUARD_ACTIVATION_HEIGHT = previous;
      }
    });

    it('does not score, call the oracle, or persist when REFERENCE_SHADOW is unset', async () => {
      const previous = process.env.REFERENCE_SHADOW;
      delete process.env.REFERENCE_SHADOW;

      try {
        const db = createMockDb();
        // No `referenceShadow` option: the env var alone decides, and it is unset.
        const { result, scoreReveal } = await runRevealWithScorer(
          db,
          'WX-SHADOW-DEFAULT-OFF',
          {},
        );

        expect(scoreReveal).not.toHaveBeenCalled();
        expect(result.referenceScore).toBeUndefined();
        // The reveal itself must be entirely unaffected by the feature being off.
        expect(result.rewardEstimate).toBe('0.05');
        expect(result.core4).toEqual({ success: true, rewardTx: 'paid' });
        // Nothing may be WRITTEN to the advisory ledger on the default path.
        // Note the table itself is still created: `ensureWeatherTables` runs the
        // `reference_scores` DDL unconditionally, independent of the gate. So the
        // property here is "no advisory row is written", not "the table is absent"
        // — asserting the latter fails against schema creation, which is not
        // feature activation.
        const advisoryWrites = db.executeCalls.filter((call) =>
          /^\s*(INSERT\s+INTO|UPDATE)\s+reference_scores/i.test(
            call.sql.replace(/\s+/g, ' ').trim(),
          ),
        );
        expect(advisoryWrites).toHaveLength(0);
      } finally {
        if (previous === undefined) delete process.env.REFERENCE_SHADOW;
        else process.env.REFERENCE_SHADOW = previous;
      }
    });

    it('scores when REFERENCE_SHADOW=1 is the only thing enabling it', async () => {
      const previous = process.env.REFERENCE_SHADOW;
      process.env.REFERENCE_SHADOW = '1';

      try {
        const db = createMockDb();
        const { result, scoreReveal } = await runRevealWithScorer(
          db,
          'WX-SHADOW-ENV-ON',
          {},
        );

        expect(scoreReveal).toHaveBeenCalledTimes(1);
        expect(result.referenceScore).toEqual({ tier: 'good', bandsVersion: 1 });
      } finally {
        if (previous === undefined) delete process.env.REFERENCE_SHADOW;
        else process.env.REFERENCE_SHADOW = previous;
      }
    });
  });

  // =========================================================================
  // 4. Error: core4 unreachable (503)
  // =========================================================================

  describe('error: core4 unreachable', () => {
    it('throws structured error when all height endpoints fail', async () => {
      const db = createMockDb();

      // Return 503 for all height-resolution endpoints
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 503, body: { error: 'service unavailable' } }),
        },
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/status',
          handler: () => ({ status: 503, body: { error: 'service unavailable' } }),
        },
        {
          method: 'GET',
          pathPrefix: '/status',
          handler: () => ({ status: 503, body: { error: 'service unavailable' } }),
        },
        {
          method: 'GET',
          pathPrefix: '/transactions/contributions/status',
          handler: () => ({ status: 503, body: { error: 'service unavailable' } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      await expect(
        service.commit({
          stationId: 'WX-503-001',
          readings: [validReading],
          nonce: 'nonce-503',
        })
      ).rejects.toThrow('Failed to resolve current chain height from core4');
    });

    it('rolls back DB insert when core4 commit endpoint fails', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 500, body: { error: 'internal error' } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      await expect(
        service.commit({
          stationId: 'WX-ROLLBACK-001',
          readings: [validReading],
          nonce: 'rollback-nonce',
        })
      ).rejects.toThrow();

      // The commitment row should have been deleted (rolled back)
      const remaining = db.rows.filter((r) => r.station_id === 'WX-ROLLBACK-001');
      expect(remaining).toHaveLength(0);
    });

    it('throws when fetch itself throws (network error)', async () => {
      const db = createMockDb();

      // Simulate network failure: fetch throws instead of returning a Response
      (global as any).fetch = jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      });

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      await expect(
        service.commit({
          stationId: 'WX-NET-001',
          readings: [validReading],
          nonce: 'net-nonce',
        })
      ).rejects.toThrow('Failed to resolve current chain height from core4');
    });
  });

  // =========================================================================
  // 5. Error: core4 returns invalid JSON
  // =========================================================================

  describe('error: core4 returns invalid JSON', () => {
    it('handles non-JSON response body on height endpoint gracefully', async () => {
      const db = createMockDb();

      // Return valid Response with non-JSON body.  The fetchJson helper
      // catches the parse failure and falls through to the next path, so
      // ultimately getCurrentHeight exhausts all fallback paths.
      (global as any).fetch = jest.fn(async () => {
        return new Response('<!DOCTYPE html><html>not json</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      });

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      // The height will be extracted as null (string body won't match extractHeight)
      // so it falls through all 4 endpoints and throws
      await expect(
        service.commit({
          stationId: 'WX-NONJSON-001',
          readings: [validReading],
          nonce: 'nonjson-nonce',
        })
      ).rejects.toThrow('Failed to resolve current chain height from core4');
    });
  });

  // =========================================================================
  // 6. Error: missing required fields
  // =========================================================================

  describe('error: missing required fields', () => {
    let service: ReturnType<typeof createWeatherCommitRevealService>;
    let db: ReturnType<typeof createMockDb>;

    beforeEach(() => {
      db = createMockDb();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);
      service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });
    });

    it('rejects commit with missing stationId', async () => {
      await expect(
        service.commit({
          stationId: '',
          readings: [validReading],
          nonce: 'n',
        })
      ).rejects.toThrow('stationId and at least one reading are required');
    });

    it('rejects commit with empty readings array', async () => {
      await expect(
        service.commit({
          stationId: 'WX-001',
          readings: [],
          nonce: 'n',
        })
      ).rejects.toThrow('stationId and at least one reading are required');
    });

    it('rejects commit with missing nonce', async () => {
      await expect(
        service.commit({
          stationId: 'WX-001',
          readings: [validReading],
          nonce: '',
        })
      ).rejects.toThrow('nonce is required');
    });

    it('rejects reveal with missing commitmentId', async () => {
      await expect(
        service.reveal({
          commitmentId: 0,
          readings: [validReading],
          nonce: 'n',
        })
      ).rejects.toThrow('commitmentId and at least one reading are required');
    });

    it('rejects reveal with empty readings array', async () => {
      await expect(
        service.reveal({
          commitmentId: 1,
          readings: [],
          nonce: 'n',
        })
      ).rejects.toThrow('commitmentId and at least one reading are required');
    });

    it('rejects reveal with missing nonce', async () => {
      await expect(
        service.reveal({
          commitmentId: 1,
          readings: [validReading],
          nonce: '',
        })
      ).rejects.toThrow('nonce is required');
    });
  });

  // =========================================================================
  // 7. Error: reveal edge cases
  // =========================================================================

  describe('reveal error cases', () => {
    it('rejects reveal for non-existent commitmentId', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 100 } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      await expect(
        service.reveal({
          commitmentId: 99999,
          readings: [validReading],
          nonce: 'n',
        })
      ).rejects.toThrow('commitment not found');
    });

    it('rejects reveal with hash mismatch (tampered readings)', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const commitResult = await service.commit({
        stationId: 'WX-TAMPER-001',
        readings: [validReading],
        nonce: 'tamper-nonce',
      });

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
      ]);

      const tampered = { ...validReading, temperature_c: 99.9 };

      await expect(
        service.reveal({
          commitmentId: commitResult.commitmentId,
          readings: [tampered],
          nonce: 'tamper-nonce',
        })
      ).rejects.toThrow('commitment hash mismatch');
    });

    it('rejects early reveal when current height < reveal deadline', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const commitResult = await service.commit({
        stationId: 'WX-EARLY-001',
        readings: [validReading],
        nonce: 'early-nonce',
      });

      // Height 11 is before deadline of 13
      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 11 } }),
        },
      ]);

      await expect(
        service.reveal({
          commitmentId: commitResult.commitmentId,
          readings: [validReading],
          nonce: 'early-nonce',
        })
      ).rejects.toThrow('reveal is too early');
    });

    it('rejects reveal for already-revealed commitment', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const commitResult = await service.commit({
        stationId: 'WX-DUP-001',
        readings: [validReading],
        nonce: 'dup-nonce',
      });

      // Advance height and reveal
      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'dup-nonce',
      });

      // Attempt to reveal again
      await expect(
        service.reveal({
          commitmentId: commitResult.commitmentId,
          readings: [validReading],
          nonce: 'dup-nonce',
        })
      ).rejects.toThrow('commitment status must be pending, got revealed');
    });

    it('does not call core4 when a concurrent revealer wins the atomic claim', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const commitService = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const commitResult = await commitService.commit({
        stationId: 'WX-RACE-001',
        readings: [validReading],
        nonce: 'race-nonce',
      });

      const racingDb: DbExecutor = {
        execute: async (sql, params) => {
          const trimmed = sql.replace(/\s+/g, ' ').trim();
          if (trimmed.includes('FROM weather_commitments') && trimmed.includes('WHERE id =') && !trimmed.includes('UPDATE')) {
            const result = await db.execute(sql, params);
            const staleRows = result.rows.map((row) => ({ ...row }));
            const row = db.rows.find((candidate) => Number(candidate.id) === Number(params?.[0]));
            if (row) row.status = 'revealed';
            return { rows: staleRows };
          }
          return db.execute(sql, params);
        },
      };

      let revealCalls = 0;
      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => {
            revealCalls++;
            return { status: 200, body: { success: true } };
          },
        },
      ]);

      const service = createWeatherCommitRevealService({
        db: racingDb,
        core4BaseUrl: 'http://localhost:9999',
      });

      await expect(
        service.reveal({
          commitmentId: commitResult.commitmentId,
          readings: [validReading],
          nonce: 'race-nonce',
        })
      ).rejects.toThrow('commitment status must be pending, got claimed');

      expect(revealCalls).toBe(0);
    });

    it('restores a claimed reveal to pending after transient core4 failure', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const commitResult = await service.commit({
        stationId: 'WX-TRANSIENT-001',
        readings: [validReading],
        nonce: 'transient-nonce',
      });

      let revealCalls = 0;
      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => {
            revealCalls++;
            return { status: 503, body: { error: 'temporarily unavailable' } };
          },
        },
      ]);

      await expect(
        service.reveal({
          commitmentId: commitResult.commitmentId,
          readings: [validReading],
          nonce: 'transient-nonce',
        })
      ).rejects.toThrow('Core4 /transactions/contribution/reveal failed (503)');

      const row = db.rows.find((r) => Number(r.id) === commitResult.commitmentId);
      expect(row?.status).toBe('pending');
      expect(revealCalls).toBe(3);

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 200, body: { success: true, rewardTx: 'rx-retry' } }),
        },
      ]);

      const retryResult = await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'transient-nonce',
      });

      expect(retryResult.core4).toEqual({ success: true, rewardTx: 'rx-retry' });
      expect(row?.status).toBe('revealed');
    });

    it('keeps permanent core4 reveal rejections terminal', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const commitResult = await service.commit({
        stationId: 'WX-PERMANENT-001',
        readings: [validReading],
        nonce: 'permanent-nonce',
      });

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 422, body: { error: 'invalid reveal' } }),
        },
      ]);

      await expect(
        service.reveal({
          commitmentId: commitResult.commitmentId,
          readings: [validReading],
          nonce: 'permanent-nonce',
        })
      ).rejects.toThrow('Core4 /transactions/contribution/reveal failed (422)');

      const row = db.rows.find((r) => Number(r.id) === commitResult.commitmentId);
      expect(row?.status).toBe('reveal_failed');
    });
  });

  // =========================================================================
  // 8. extractHeight edge cases (tested indirectly via getCurrentHeight)
  // =========================================================================

  describe('extractHeight edge cases (via getCurrentHeight)', () => {
    function makeService(db: DbExecutor) {
      return createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });
    }

    async function resolveHeight(responseBody: unknown): Promise<number> {
      const db = createMockDb();

      // Only respond on the first height endpoint so we can control what data is returned
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: responseBody }),
        },
      ]);

      const service = makeService(db);

      // We need to trigger getCurrentHeight -- commit calls it internally
      // but we also need the commit endpoint.  Easier: just add a commit
      // endpoint mock too.
      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: responseBody }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const result = await service.commit({
        stationId: 'WX-HEIGHT-TEST',
        readings: [validReading],
        nonce: 'height-nonce',
      });

      // revealDeadline = height + 3, so height = revealDeadline - 3
      return result.revealDeadline - 3;
    }

    it('extracts height from { height: N }', async () => {
      const height = await resolveHeight({ height: 42 });
      expect(height).toBe(42);
    });

    it('extracts height from { blockHeight: N }', async () => {
      const height = await resolveHeight({ blockHeight: 77 });
      expect(height).toBe(77);
    });

    it('extracts height from { currentHeight: N }', async () => {
      const height = await resolveHeight({ currentHeight: 99 });
      expect(height).toBe(99);
    });

    it('extracts height from { data: { height: N } }', async () => {
      const height = await resolveHeight({ data: { height: 55 } });
      expect(height).toBe(55);
    });

    it('extracts height from { data: { blockHeight: N } }', async () => {
      const height = await resolveHeight({ data: { blockHeight: 33 } });
      expect(height).toBe(33);
    });

    it('extracts height from { data: { currentHeight: N } }', async () => {
      const height = await resolveHeight({ data: { currentHeight: 88 } });
      expect(height).toBe(88);
    });

    it('extracts height from plain number response', async () => {
      const height = await resolveHeight(42);
      expect(height).toBe(42);
    });

    it('extracts height from string number in object', async () => {
      const height = await resolveHeight({ height: '123' });
      expect(height).toBe(123);
    });

    it('fails when response is null on all endpoints', async () => {
      const db = createMockDb();

      // All endpoints return null body
      (global as any).fetch = jest.fn(async () => {
        return new Response('null', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const service = makeService(db);

      await expect(
        service.commit({
          stationId: 'WX-NULL-001',
          readings: [validReading],
          nonce: 'null-nonce',
        })
      ).rejects.toThrow('Failed to resolve current chain height from core4');
    });

    it('fails when response contains NaN height', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: NaN } }),
        },
        // NaN serializes as null in JSON, so extractHeight won't find a finite number
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/status',
          handler: () => ({ status: 200, body: { height: NaN } }),
        },
        {
          method: 'GET',
          pathPrefix: '/status',
          handler: () => ({ status: 200, body: { height: NaN } }),
        },
        {
          method: 'GET',
          pathPrefix: '/transactions/contributions/status',
          handler: () => ({ status: 200, body: { height: NaN } }),
        },
      ]);

      const service = makeService(db);

      await expect(
        service.commit({
          stationId: 'WX-NAN-001',
          readings: [validReading],
          nonce: 'nan-nonce',
        })
      ).rejects.toThrow('Failed to resolve current chain height from core4');
    });

    it('falls through to secondary endpoint when primary returns no height', async () => {
      const db = createMockDb();
      const endpointsCalled: string[] = [];

      (global as any).fetch = jest.fn(async (input: string, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        endpointsCalled.push(`${method} ${url}`);

        // Current core4 launch_api primary height route.
        if (url.endsWith('/blockchain')) {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Primary /api/blockchain/height returns empty object (no usable height)
        if (url.includes('/api/blockchain/height')) {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Secondary /api/blockchain/status returns valid height
        if (url.includes('/api/blockchain/status')) {
          return new Response(JSON.stringify({ height: 77 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Commit endpoint
        if (url.includes('/transactions/contribution/commit') && method === 'POST') {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const service = makeService(db);

      const result = await service.commit({
        stationId: 'WX-FALLBACK-001',
        readings: [validReading],
        nonce: 'fallback-nonce',
      });

      // Height should come from secondary endpoint
      expect(result.revealDeadline).toBe(80); // 77 + 3

      // Both endpoints should have been called
      expect(endpointsCalled.some((e) => e.endsWith('/blockchain'))).toBe(true);
      expect(endpointsCalled.some((e) => e.includes('/api/blockchain/height'))).toBe(true);
      expect(endpointsCalled.some((e) => e.includes('/api/blockchain/status'))).toBe(true);
    });
  });

  // =========================================================================
  // 9. listCommitments
  // =========================================================================

  describe('listCommitments', () => {
    it('returns commitments for a given station', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      await service.commit({
        stationId: 'WX-LIST-001',
        readings: [validReading],
        nonce: 'list-nonce-1',
      });

      await service.commit({
        stationId: 'WX-LIST-001',
        readings: [validReading],
        nonce: 'list-nonce-2',
      });

      await service.commit({
        stationId: 'WX-LIST-OTHER',
        readings: [validReading],
        nonce: 'list-nonce-3',
      });

      const results = await service.listCommitments('WX-LIST-001');
      expect(results).toHaveLength(2);
      for (const row of results) {
        expect(row.station_id).toBe('WX-LIST-001');
      }
    });
  });

  // =========================================================================
  // 10. expireStaleCommitments
  // =========================================================================

  describe('expireStaleCommitments', () => {
    it('expires pending commitments past grace window', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      // Create a commitment (deadline = 13)
      await service.commit({
        stationId: 'WX-EXPIRE-001',
        readings: [validReading],
        nonce: 'expire-nonce',
      });

      // Advance height well past deadline + 100 (13 + 100 = 113, need > 113)
      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 200 } }),
        },
      ]);

      const expired = await service.expireStaleCommitments();
      expect(expired).toBe(1);

      const row = db.rows[0];
      expect(row.status).toBe('expired');
    });

    it('returns 0 when core4 height is unavailable', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      await service.commit({
        stationId: 'WX-NOEXPIRE-001',
        readings: [validReading],
        nonce: 'noexpire-nonce',
      });

      // Make core4 unreachable
      restoreFetch();
      (global as any).fetch = jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      });

      const expired = await service.expireStaleCommitments();
      expect(expired).toBe(0);
    });
  });

  // =========================================================================
  // 11. revealPendingCommitments (auto-reveal)
  // =========================================================================

  describe('revealPendingCommitments', () => {
    it('auto-reveals eligible pending commitments', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        defaultContributor: '0xAUTO',
      });

      await service.commit({
        stationId: 'WX-AUTO-001',
        readings: [validReading],
        nonce: 'auto-nonce',
      });

      // Advance height past deadline
      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const revealed = await service.revealPendingCommitments();
      expect(revealed).toBe(1);

      const row = db.rows[0];
      expect(row.status).toBe('revealed');
    });

    it('leaves auto-reveal commitments pending after transient core4 failure', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        defaultContributor: '0xAUTO',
      });

      await service.commit({
        stationId: 'WX-AUTO-TRANSIENT-001',
        readings: [validReading],
        nonce: 'auto-transient-nonce',
      });

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 503, body: { error: 'temporarily unavailable' } }),
        },
      ]);

      const revealed = await service.revealPendingCommitments();

      expect(revealed).toBe(0);
      expect(db.rows[0].status).toBe('pending');
    });

    it('marks auto-reveal commitments failed after permanent reveal errors', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
        defaultContributor: '0xAUTO',
      });

      await service.commit({
        stationId: 'WX-AUTO-PERMANENT-001',
        readings: [validReading],
        nonce: 'auto-permanent-nonce',
      });

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 422, body: { error: 'invalid reveal' } }),
        },
      ]);

      const revealed = await service.revealPendingCommitments();

      expect(revealed).toBe(0);
      expect(db.rows[0].status).toBe('reveal_failed');
    });

    it('returns 0 when core4 height is unavailable', async () => {
      const db = createMockDb();

      (global as any).fetch = jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      });

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const revealed = await service.revealPendingCommitments();
      expect(revealed).toBe(0);
    });
  });

  // =========================================================================
  // 12. Timer job helpers
  // =========================================================================

  describe('startCommitmentExpiryJob / startRevealSchedulerJob', () => {
    it('startCommitmentExpiryJob returns a cleanup function', () => {
      const db = createMockDb();
      installFetchMock([]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const stop = startCommitmentExpiryJob(service, 60_000);
      expect(typeof stop).toBe('function');
      stop(); // cleanup
    });

    it('startRevealSchedulerJob returns a cleanup function', () => {
      const db = createMockDb();
      installFetchMock([]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const stop = startRevealSchedulerJob(service, 60_000);
      expect(typeof stop).toBe('function');
      stop(); // cleanup
    });
  });

  // =========================================================================
  // 13. Accuracy and reward estimation
  // =========================================================================

  describe('accuracy and reward computation (via reveal)', () => {
    it('computes 100% accuracy for fully complete readings', async () => {
      const db = createMockDb();

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const commitResult = await service.commit({
        stationId: 'WX-ACC-001',
        readings: [validReading, validReading],
        nonce: 'acc-nonce',
      });

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const result = await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading, validReading],
        nonce: 'acc-nonce',
      });

      expect(result.accuracyScore).toBe(100);
      // With 100% accuracy and 2 readings, reward should be nonzero
      expect(parseFloat(result.rewardEstimate)).toBeGreaterThan(0);
    });

    it('computes 0% accuracy for readings missing all required fields', async () => {
      const db = createMockDb();
      const incompleteReading = { some_other_field: 'x' };

      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 10 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/commit',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const service = createWeatherCommitRevealService({
        db,
        core4BaseUrl: 'http://localhost:9999',
      });

      const commitResult = await service.commit({
        stationId: 'WX-NOACC-001',
        readings: [incompleteReading],
        nonce: 'noacc-nonce',
      });

      restoreFetch();
      installFetchMock([
        {
          method: 'GET',
          pathPrefix: '/api/blockchain/height',
          handler: () => ({ status: 200, body: { height: 13 } }),
        },
        {
          method: 'POST',
          pathPrefix: '/transactions/contribution/reveal',
          handler: () => ({ status: 200, body: { success: true } }),
        },
      ]);

      const result = await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [incompleteReading],
        nonce: 'noacc-nonce',
      });

      expect(result.accuracyScore).toBe(0);
    });
  });
});
