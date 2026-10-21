/**
 * Core4 HTTP API Contract Tests (#329)
 *
 * These tests validate the HTTP API contract between the backend TypeScript
 * services and the core4 Rust node. If core4 changes its response shapes
 * (e.g. renaming `height` to `chain_height`), these tests will fail.
 *
 * Three tiers:
 *  1. Contract shape tests — always run, no network needed
 *  2. Mock-server integration tests — always run, uses a local HTTP mock
 *  3. Live-node tests — gated behind WRFCOIN_CORE4_URL env var
 */

import http from 'http';
import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createWeatherCommitRevealService } from '../../server/routes/weather-commit-reveal-routes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QueryResult = { rows: Record<string, unknown>[] };

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

// ---------------------------------------------------------------------------
// Env-gated describe helpers
// ---------------------------------------------------------------------------

const CORE4_BASE_URL = process.env.WRFCOIN_CORE4_URL ?? null;
const CORE4_TOKEN = process.env.WRFCOIN_OPERATOR_TOKEN ?? null;
const RUN_WRITE_TESTS = process.env.WRFCOIN_CORE4_WRITE_TESTS === '1';

const describeWithCore4 = CORE4_BASE_URL ? describe : describe.skip;
const describeWithCore4Write =
  CORE4_BASE_URL && CORE4_TOKEN && RUN_WRITE_TESTS ? describe : describe.skip;

// ---------------------------------------------------------------------------
// extractHeight — re-implement the same logic for contract shape testing.
// We import the service factory but extractHeight is not exported, so we
// replicate its logic here as the "expected contract" and then test the
// service's behavior against it via the mock server.
// ---------------------------------------------------------------------------

/**
 * Contract-level type guard: validates a chain-height response has one of
 * the shapes that the backend currently knows how to parse.
 */
function isValidHeightResponse(data: unknown): boolean {
  if (typeof data === 'number' && Number.isFinite(data)) return true;
  if (!data || typeof data !== 'object') return false;

  const record = data as Record<string, unknown>;
  const candidates = [
    record.height,
    record.blockHeight,
    record.currentHeight,
    (record.data as Record<string, unknown> | undefined)?.height,
    (record.data as Record<string, unknown> | undefined)?.blockHeight,
    (record.data as Record<string, unknown> | undefined)?.currentHeight,
  ];

  return candidates.some(
    (c) =>
      (typeof c === 'number' && Number.isFinite(c)) ||
      (typeof c === 'string' && c.trim().length > 0 && Number.isFinite(Number(c)))
  );
}

/**
 * Validates the shape of a commit request payload sent to core4.
 */
function isValidCommitPayload(body: unknown): body is {
  contributor: string;
  station_id: string;
  commit_hash: string;
} {
  if (!body || typeof body !== 'object') return false;
  const rec = body as Record<string, unknown>;
  return (
    typeof rec.contributor === 'string' &&
    typeof rec.station_id === 'string' &&
    typeof rec.commit_hash === 'string'
  );
}

/**
 * Validates the shape of a reveal request payload sent to core4.
 */
function isValidRevealPayload(body: unknown): body is {
  contributor: string;
  station_id: string;
  payload: unknown[];
  nonce: string;
  commit_hash: string;
  timestamp: number;
} {
  if (!body || typeof body !== 'object') return false;
  const rec = body as Record<string, unknown>;
  return (
    typeof rec.contributor === 'string' &&
    typeof rec.station_id === 'string' &&
    Array.isArray(rec.payload) &&
    typeof rec.nonce === 'string' &&
    typeof rec.commit_hash === 'string' &&
    typeof rec.timestamp === 'number'
  );
}

// ---------------------------------------------------------------------------
// Mock in-memory DbExecutor (mirrors the pipeline integration test)
// ---------------------------------------------------------------------------

function createMockDb(): DbExecutor & { rows: Record<string, unknown>[] } {
  let nextId = 1;
  const rows: Record<string, unknown>[] = [];

  const execute = async (sql: string, params?: unknown[]): Promise<QueryResult> => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();

    // DDL no-ops
    if (
      trimmed.startsWith('CREATE TABLE IF NOT EXISTS') ||
      trimmed.startsWith('CREATE INDEX IF NOT EXISTS') ||
      trimmed.startsWith('ALTER TABLE') ||
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
    if (trimmed.includes('FROM weather_commitments') && trimmed.includes('WHERE id =')) {
      const id = Number(params?.[0]);
      const found = rows.filter((r) => Number(r.id) === id);
      return { rows: found };
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
      const updated: Record<string, unknown>[] = [];
      for (const r of rows) {
        if (r.status === 'pending') {
          r.status = 'expired';
          updated.push(r);
        }
      }
      return { rows: updated };
    }

    // INSERT INTO weather_submissions — no-op
    if (trimmed.includes('INSERT INTO weather_submissions')) {
      return { rows: [] };
    }

    // Fallback — no-op
    return { rows: [] };
  };

  return { execute, rows };
}

// ---------------------------------------------------------------------------
// Mock Core4 HTTP server with request recording
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function createMockCore4Server() {
  let currentHeight = 42;
  const recorded: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      recorded.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: parsed,
      });

      // GET /api/blockchain/height — primary height endpoint
      if (req.url === '/api/blockchain/height' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ height: currentHeight }));
        return;
      }

      // POST /transactions/contribution/commit
      if (req.url === '/transactions/contribution/commit' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, tx_id: 'mock-tx-001' }));
        return;
      }

      // POST /transactions/contribution/reveal
      if (req.url === '/transactions/contribution/reveal' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, receipt_id: 'mock-receipt-001' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  return {
    server,
    setHeight(h: number) {
      currentHeight = h;
    },
    getRecorded() {
      return recorded;
    },
    clearRecorded() {
      recorded.length = 0;
    },
    start(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          resolve(addr.port);
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Valid test reading fixture
// ---------------------------------------------------------------------------

const validReading = {
  temperature_c: 22.5,
  pressure_hpa: 1013.25,
  humidity_pct: 65.0,
  timestamp: new Date().toISOString(),
};

// =========================================================================
// 1. CONTRACT SHAPE TESTS (always run, no live node needed)
// =========================================================================

describe('Core4 HTTP API contract shapes', () => {
  describe('chain height response shapes', () => {
    test('accepts { height: <number> } — primary shape', () => {
      expect(isValidHeightResponse({ height: 42 })).toBe(true);
    });

    test('accepts { blockHeight: <number> } — alternative shape', () => {
      expect(isValidHeightResponse({ blockHeight: 100 })).toBe(true);
    });

    test('accepts { currentHeight: <number> } — alternative shape', () => {
      expect(isValidHeightResponse({ currentHeight: 200 })).toBe(true);
    });

    test('accepts nested { data: { height: <number> } }', () => {
      expect(isValidHeightResponse({ data: { height: 42 } })).toBe(true);
    });

    test('accepts nested { data: { blockHeight: <number> } }', () => {
      expect(isValidHeightResponse({ data: { blockHeight: 42 } })).toBe(true);
    });

    test('accepts nested { data: { currentHeight: <number> } }', () => {
      expect(isValidHeightResponse({ data: { currentHeight: 42 } })).toBe(true);
    });

    test('accepts a bare number', () => {
      expect(isValidHeightResponse(42)).toBe(true);
    });

    test('accepts string-encoded height { height: "42" }', () => {
      expect(isValidHeightResponse({ height: '42' })).toBe(true);
    });

    test('rejects null', () => {
      expect(isValidHeightResponse(null)).toBe(false);
    });

    test('rejects undefined', () => {
      expect(isValidHeightResponse(undefined)).toBe(false);
    });

    test('rejects empty object (contract drift detection)', () => {
      expect(isValidHeightResponse({})).toBe(false);
    });

    test('rejects { chain_height: 42 } — unknown field name (drift)', () => {
      expect(isValidHeightResponse({ chain_height: 42 })).toBe(false);
    });

    test('rejects { block_number: 42 } — unknown field name (drift)', () => {
      expect(isValidHeightResponse({ block_number: 42 })).toBe(false);
    });

    test('rejects { height: NaN }', () => {
      expect(isValidHeightResponse({ height: NaN })).toBe(false);
    });

    test('rejects { height: Infinity }', () => {
      expect(isValidHeightResponse({ height: Infinity })).toBe(false);
    });

    test('rejects { height: "" } — empty string', () => {
      expect(isValidHeightResponse({ height: '' })).toBe(false);
    });

    test('rejects string that is not a number', () => {
      expect(isValidHeightResponse({ height: 'abc' })).toBe(false);
    });
  });

  describe('commit request payload shape', () => {
    test('accepts valid commit payload', () => {
      expect(
        isValidCommitPayload({
          contributor: '0xTEST',
          station_id: 'WX-001',
          commit_hash: 'abc123',
        })
      ).toBe(true);
    });

    test('rejects payload with camelCase keys (not what core4 expects)', () => {
      expect(
        isValidCommitPayload({
          contributor: '0xTEST',
          stationId: 'WX-001',
          commitHash: 'abc123',
        })
      ).toBe(false);
    });

    test('rejects payload missing contributor', () => {
      expect(
        isValidCommitPayload({
          station_id: 'WX-001',
          commit_hash: 'abc123',
        })
      ).toBe(false);
    });

    test('rejects null', () => {
      expect(isValidCommitPayload(null)).toBe(false);
    });
  });

  describe('reveal request payload shape', () => {
    test('accepts valid reveal payload', () => {
      expect(
        isValidRevealPayload({
          contributor: '0xTEST',
          station_id: 'WX-001',
          payload: [{ temperature_c: 22.5 }],
          nonce: 'test-nonce',
          commit_hash: 'abc123',
          timestamp: 1711000000,
        })
      ).toBe(true);
    });

    test('rejects payload with camelCase keys', () => {
      expect(
        isValidRevealPayload({
          contributor: '0xTEST',
          stationId: 'WX-001',
          payload: [],
          nonce: 'test',
          commitHash: 'abc',
          timestamp: 123,
        })
      ).toBe(false);
    });

    test('rejects payload missing timestamp', () => {
      expect(
        isValidRevealPayload({
          contributor: '0xTEST',
          station_id: 'WX-001',
          payload: [],
          nonce: 'test',
          commit_hash: 'abc',
        })
      ).toBe(false);
    });

    test('rejects null', () => {
      expect(isValidRevealPayload(null)).toBe(false);
    });
  });
});

// =========================================================================
// 2. MOCK-SERVER CONTRACT TESTS (always run, no live node needed)
// =========================================================================

describe('Core4 mock-server contract integration', () => {
  const mock = createMockCore4Server();
  let port: number;
  let db: ReturnType<typeof createMockDb>;
  let service: ReturnType<typeof createWeatherCommitRevealService>;

  beforeAll(async () => {
    port = await mock.start();
    db = createMockDb();
    service = createWeatherCommitRevealService({
      db,
      core4BaseUrl: `http://127.0.0.1:${port}`,
      core4Token: 'test-bearer-token-42',
      defaultContributor: '0xCONTRACT_TEST',
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  beforeEach(() => {
    mock.clearRecorded();
    mock.setHeight(42);
    db.rows.length = 0;
  });

  // -----------------------------------------------------------------------
  // Height resolution
  // -----------------------------------------------------------------------

  describe('height resolution', () => {
    test('service resolves height from mock /api/blockchain/height endpoint', async () => {
      mock.setHeight(100);

      const result = await service.commit({
        stationId: 'WX-CONTRACT-H1',
        readings: [validReading],
        nonce: 'height-test-1',
      });

      // revealDeadline = currentHeight + 3 = 100 + 3 = 103
      expect(result.revealDeadline).toBe(103);
    });

    test('height response matches expected { height: number } shape', async () => {
      mock.setHeight(55);

      // Use expireStaleCommitments to trigger a height fetch
      await service.expireStaleCommitments();

      const heightReqs = mock.getRecorded().filter(
        (r) => r.url === '/api/blockchain/height' && r.method === 'GET'
      );
      expect(heightReqs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Commit flow
  // -----------------------------------------------------------------------

  describe('commit flow', () => {
    test('commit sends correct payload shape to core4', async () => {
      mock.setHeight(10);

      await service.commit({
        stationId: 'WX-CONTRACT-C1',
        readings: [validReading],
        nonce: 'commit-contract-1',
      });

      const commitReqs = mock.getRecorded().filter(
        (r) => r.url === '/transactions/contribution/commit' && r.method === 'POST'
      );
      expect(commitReqs).toHaveLength(1);

      const payload = commitReqs[0].body;
      expect(isValidCommitPayload(payload)).toBe(true);

      // Verify specific fields
      const body = payload as Record<string, unknown>;
      expect(body.station_id).toBe('WX-CONTRACT-C1');
      expect(body.contributor).toBe('0xCONTRACT_TEST');
      expect(typeof body.commit_hash).toBe('string');
      expect((body.commit_hash as string).length).toBe(64); // blake3 hex
    });

    test('commit returns valid result shape', async () => {
      mock.setHeight(10);

      const result = await service.commit({
        stationId: 'WX-CONTRACT-C2',
        readings: [validReading],
        nonce: 'commit-contract-2',
      });

      expect(typeof result.commitmentId).toBe('number');
      expect(result.commitmentId).toBeGreaterThan(0);
      expect(typeof result.revealDeadline).toBe('number');
      expect(result.revealDeadline).toBe(13); // 10 + 3
      expect(result.commitmentHash).toMatch(/^[0-9a-f]{64}$/);
      // core4 field should contain the mock server response
      expect(result.core4).toBeTruthy();
    });

    test('commit does NOT send camelCase field names to core4', async () => {
      mock.setHeight(10);

      await service.commit({
        stationId: 'WX-CONTRACT-C3',
        readings: [validReading],
        nonce: 'commit-contract-3',
      });

      const commitReqs = mock.getRecorded().filter(
        (r) => r.url === '/transactions/contribution/commit'
      );
      const body = commitReqs[0].body as Record<string, unknown>;

      // Must use snake_case for Rust API compatibility
      expect(body).toHaveProperty('station_id');
      expect(body).toHaveProperty('commit_hash');
      expect(body).not.toHaveProperty('stationId');
      expect(body).not.toHaveProperty('commitHash');
    });
  });

  // -----------------------------------------------------------------------
  // Reveal flow
  // -----------------------------------------------------------------------

  describe('reveal flow', () => {
    test('reveal sends correct payload shape to core4', async () => {
      mock.setHeight(10);

      const commitResult = await service.commit({
        stationId: 'WX-CONTRACT-R1',
        readings: [validReading],
        nonce: 'reveal-contract-1',
      });

      // Advance past deadline
      mock.setHeight(13);
      mock.clearRecorded();

      await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'reveal-contract-1',
      });

      const revealReqs = mock.getRecorded().filter(
        (r) => r.url === '/transactions/contribution/reveal' && r.method === 'POST'
      );
      expect(revealReqs).toHaveLength(1);

      const payload = revealReqs[0].body;
      expect(isValidRevealPayload(payload)).toBe(true);

      const body = payload as Record<string, unknown>;
      expect(body.station_id).toBe('WX-CONTRACT-R1');
      expect(body.contributor).toBe('0xCONTRACT_TEST');
      expect(body.nonce).toBe('reveal-contract-1');
      expect(typeof body.timestamp).toBe('number');
      expect(Array.isArray(body.payload)).toBe(true);
    });

    test('reveal result has correct shape', async () => {
      mock.setHeight(10);

      const commitResult = await service.commit({
        stationId: 'WX-CONTRACT-R2',
        readings: [validReading],
        nonce: 'reveal-contract-2',
      });

      mock.setHeight(13);

      const revealResult = await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'reveal-contract-2',
      });

      expect(revealResult.receiptId).toMatch(/^wrf-/);
      expect(typeof revealResult.stationId).toBe('string');
      expect(typeof revealResult.accuracyScore).toBe('number');
      expect(revealResult.accuracyScore).toBeGreaterThanOrEqual(0);
      expect(revealResult.accuracyScore).toBeLessThanOrEqual(100);
      expect(typeof revealResult.rewardEstimate).toBe('string');
      expect(revealResult.core4).toBeTruthy();
    });

    test('reveal includes optional storage fields when provided', async () => {
      mock.setHeight(10);

      const commitResult = await service.commit({
        stationId: 'WX-CONTRACT-R3',
        readings: [validReading],
        nonce: 'reveal-contract-3',
      });

      mock.setHeight(13);
      mock.clearRecorded();

      await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'reveal-contract-3',
        data_cid: 'QmTest123',
        data_hash: 'abcdef1234',
        storage_provider: 'ipfs',
      });

      const revealReqs = mock.getRecorded().filter(
        (r) => r.url === '/transactions/contribution/reveal'
      );
      const body = revealReqs[0].body as Record<string, unknown>;
      expect(body.data_cid).toBe('QmTest123');
      expect(body.data_hash).toBe('abcdef1234');
      expect(body.storage_provider).toBe('ipfs');
    });
  });

  // -----------------------------------------------------------------------
  // Request headers
  // -----------------------------------------------------------------------

  describe('request headers', () => {
    test('sends Authorization bearer token on height requests', async () => {
      mock.setHeight(10);

      await service.commit({
        stationId: 'WX-CONTRACT-AUTH1',
        readings: [validReading],
        nonce: 'auth-test-1',
      });

      const heightReqs = mock.getRecorded().filter(
        (r) => r.url === '/api/blockchain/height'
      );
      expect(heightReqs.length).toBeGreaterThanOrEqual(1);
      expect(heightReqs[0].headers.authorization).toBe('Bearer test-bearer-token-42');
    });

    test('sends Authorization bearer token on commit requests', async () => {
      mock.setHeight(10);

      await service.commit({
        stationId: 'WX-CONTRACT-AUTH2',
        readings: [validReading],
        nonce: 'auth-test-2',
      });

      const commitReqs = mock.getRecorded().filter(
        (r) => r.url === '/transactions/contribution/commit'
      );
      expect(commitReqs).toHaveLength(1);
      expect(commitReqs[0].headers.authorization).toBe('Bearer test-bearer-token-42');
    });

    test('sends Content-Type application/json on all requests', async () => {
      mock.setHeight(10);

      await service.commit({
        stationId: 'WX-CONTRACT-CT1',
        readings: [validReading],
        nonce: 'content-type-test-1',
      });

      for (const req of mock.getRecorded()) {
        expect(req.headers['content-type']).toBe('application/json');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Endpoint path contract
  // -----------------------------------------------------------------------

  describe('endpoint paths', () => {
    test('height uses /api/blockchain/height as primary endpoint', async () => {
      mock.setHeight(50);

      await service.commit({
        stationId: 'WX-CONTRACT-EP1',
        readings: [validReading],
        nonce: 'endpoint-test-1',
      });

      const heightReqs = mock.getRecorded().filter((r) => r.url === '/api/blockchain/height');
      expect(heightReqs.length).toBeGreaterThanOrEqual(1);
    });

    test('commit uses /transactions/contribution/commit', async () => {
      mock.setHeight(10);

      await service.commit({
        stationId: 'WX-CONTRACT-EP2',
        readings: [validReading],
        nonce: 'endpoint-test-2',
      });

      const commitReqs = mock.getRecorded().filter(
        (r) => r.url === '/transactions/contribution/commit'
      );
      expect(commitReqs).toHaveLength(1);
    });

    test('reveal uses /transactions/contribution/reveal', async () => {
      mock.setHeight(10);

      const commitResult = await service.commit({
        stationId: 'WX-CONTRACT-EP3',
        readings: [validReading],
        nonce: 'endpoint-test-3',
      });

      mock.setHeight(13);
      mock.clearRecorded();

      await service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'endpoint-test-3',
      });

      const revealReqs = mock.getRecorded().filter(
        (r) => r.url === '/transactions/contribution/reveal'
      );
      expect(revealReqs).toHaveLength(1);
    });
  });
});

// =========================================================================
// 3. LIVE-NODE CONTRACT TESTS (gated behind WRFCOIN_CORE4_URL env var)
// =========================================================================

describeWithCore4('Core4 live-node HTTP contract', () => {
  test('GET /blockchain returns the height envelope consumed by backend', async () => {
    const response = await fetch(`${CORE4_BASE_URL}/blockchain`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(CORE4_TOKEN ? { Authorization: `Bearer ${CORE4_TOKEN}` } : {}),
      },
    });

    expect(response.ok).toBe(true);

    const envelope = await response.json() as Record<string, unknown>;
    expect(envelope.ok).toBe(true);
    expect(isValidHeightResponse(envelope.data)).toBe(true);
  });

  test('service resolves height from live node via expireStaleCommitments', async () => {
    const db = createMockDb();
    const svc = createWeatherCommitRevealService({
      db,
      core4BaseUrl: CORE4_BASE_URL!,
      core4Token: CORE4_TOKEN ?? undefined,
    });

    // expireStaleCommitments internally calls getCurrentHeight
    // If the shape changed, this would throw
    const expiredCount = await svc.expireStaleCommitments();
    expect(typeof expiredCount).toBe('number');
    expect(expiredCount).toBeGreaterThanOrEqual(0);
  });
});

describeWithCore4Write('Core4 live-node write contract', () => {
  test('POST /transactions/contribution/commit accepts a weather commitment', async () => {
    const db = createMockDb();
    const svc = createWeatherCommitRevealService({
      db,
      core4BaseUrl: CORE4_BASE_URL!,
      core4Token: CORE4_TOKEN ?? undefined,
      defaultContributor: '0x0000000000000000000000000000000000000b02',
    });

    const result = await svc.commit({
      stationId: `WX-LIVE-${Date.now()}`,
      readings: [
        {
          temperature_c: 21.4,
          pressure_hpa: 1012.8,
          humidity_pct: 58.3,
          timestamp: new Date().toISOString(),
        },
      ],
      nonce: `live-contract-${Date.now()}`,
    });

    expect(result.commitmentId).toBeGreaterThan(0);
    expect(result.commitmentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.revealDeadline).toBeGreaterThan(0);
    expect(result.core4).toBeTruthy();
  });
});
