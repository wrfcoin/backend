import http from 'http';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createWeatherCommitRevealService } from '../../server/routes/weather-commit-reveal-routes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QueryResult = { rows: Record<string, unknown>[] };

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

// ---------------------------------------------------------------------------
// Mock Core4 HTTP server
// ---------------------------------------------------------------------------

function createMockCore4Server() {
  let currentHeight = 0;
  const recorded: RecordedRequest[] = [];
  let commitShouldFail = false;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      recorded.push({ method: req.method!, url: req.url!, body: parsed });

      if (req.url === '/api/blockchain/height' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ height: currentHeight }));
        return;
      }

      if (req.url === '/transactions/contribution/commit' && req.method === 'POST') {
        if (commitShouldFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'simulated upstream failure' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.url === '/transactions/contribution/reveal' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  return {
    server,
    setHeight(h: number) { currentHeight = h; },
    setCommitShouldFail(v: boolean) { commitShouldFail = v; },
    getRecorded() { return recorded; },
    clearRecorded() { recorded.length = 0; },
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
// Mock in-memory DbExecutor
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
    // (must come before the SELECT matcher since both contain 'FROM weather_commitments')
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
// Valid test reading
// ---------------------------------------------------------------------------

const validReading = {
  temperature_c: 22.5,
  pressure_hpa: 1013.25,
  humidity_pct: 65.0,
  timestamp: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Weather commit-reveal pipeline integration', () => {
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
      core4Token: 'test-token',
      defaultContributor: '0xTEST_CONTRIBUTOR',
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  // Reset state between tests
  beforeEach(() => {
    mock.clearRecorded();
    mock.setCommitShouldFail(false);
    mock.setHeight(0);
    // Clear db rows in-place (keep array reference stable)
    db.rows.length = 0;
  });

  test('happy path: commit then reveal produces valid receipt', async () => {
    mock.setHeight(10);

    const commitResult = await service.commit({
      stationId: 'WX-TEST-001',
      readings: [validReading],
      nonce: 'test-nonce-1',
    });

    // Commit assertions
    expect(commitResult.commitmentId).toBeGreaterThan(0);
    expect(commitResult.revealDeadline).toBe(13); // 10 + 3
    expect(commitResult.commitmentHash).toMatch(/^[0-9a-f]{64}$/);

    // Verify mock server received the commit payload
    const commitReqs = mock.getRecorded().filter(
      (r) => r.url === '/transactions/contribution/commit'
    );
    expect(commitReqs).toHaveLength(1);
    const commitBody = commitReqs[0].body as Record<string, unknown>;
    expect(commitBody).toHaveProperty('contributor');
    expect(commitBody).toHaveProperty('station_id', 'WX-TEST-001');
    expect(commitBody).toHaveProperty('commit_hash');

    // Advance height past deadline
    mock.setHeight(13);

    const revealResult = await service.reveal({
      commitmentId: commitResult.commitmentId,
      readings: [validReading],
      nonce: 'test-nonce-1',
    });

    // Reveal assertions
    expect(revealResult.receiptId).toMatch(/^wrf-/);
    expect(revealResult.accuracyScore).toBeGreaterThan(0);
    expect(typeof revealResult.rewardEstimate).toBe('string');

    // Verify mock server received the reveal payload
    const revealReqs = mock.getRecorded().filter(
      (r) => r.url === '/transactions/contribution/reveal'
    );
    expect(revealReqs).toHaveLength(1);
    const revealBody = revealReqs[0].body as Record<string, unknown>;
    expect(revealBody).toHaveProperty('station_id');
    expect(revealBody).toHaveProperty('commit_hash');
    expect(typeof revealBody.timestamp).toBe('number');
    expect(revealBody).toHaveProperty('nonce');
    expect(revealBody).toHaveProperty('payload');
  });

  test('reveal with hash mismatch rejects tampered readings', async () => {
    mock.setHeight(10);

    const commitResult = await service.commit({
      stationId: 'WX-TEST-002',
      readings: [validReading],
      nonce: 'test-nonce-2',
    });

    mock.setHeight(13);

    // Tamper with the reading
    const tamperedReading = { ...validReading, temperature_c: 99.9 };

    await expect(
      service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [tamperedReading],
        nonce: 'test-nonce-2',
      })
    ).rejects.toThrow('commitment hash mismatch');
  });

  test('early reveal is rejected when height < deadline', async () => {
    mock.setHeight(10);

    const commitResult = await service.commit({
      stationId: 'WX-TEST-003',
      readings: [validReading],
      nonce: 'test-nonce-3',
    });

    // Height 11 is before deadline of 13
    mock.setHeight(11);

    await expect(
      service.reveal({
        commitmentId: commitResult.commitmentId,
        readings: [validReading],
        nonce: 'test-nonce-3',
      })
    ).rejects.toThrow('reveal is too early');
  });

  test('reveal unknown commitmentId throws', async () => {
    mock.setHeight(20);

    await expect(
      service.reveal({
        commitmentId: 99999,
        readings: [validReading],
        nonce: 'some-nonce',
      })
    ).rejects.toThrow('commitment not found');
  });

  test('commit with empty readings throws', async () => {
    mock.setHeight(10);

    await expect(
      service.commit({
        stationId: 'WX-TEST-004',
        readings: [],
        nonce: 'test-nonce-4',
      })
    ).rejects.toThrow('at least one reading');
  });

  test('core4 commit failure triggers DB rollback', async () => {
    mock.setHeight(10);
    mock.setCommitShouldFail(true);

    await expect(
      service.commit({
        stationId: 'WX-TEST-005',
        readings: [validReading],
        nonce: 'test-nonce-5',
      })
    ).rejects.toThrow();

    // The commitment should have been deleted from the DB (rollback)
    const remaining = db.rows.filter((r) => r.station_id === 'WX-TEST-005');
    expect(remaining).toHaveLength(0);
  });

  test('commit payload uses snake_case field names for Rust API compatibility', async () => {
    mock.setHeight(10);

    await service.commit({
      stationId: 'WX-TEST-006',
      readings: [validReading],
      nonce: 'test-nonce-6',
    });

    const commitReqs = mock.getRecorded().filter(
      (r) => r.url === '/transactions/contribution/commit'
    );
    expect(commitReqs).toHaveLength(1);

    const payload = commitReqs[0].body as Record<string, unknown>;

    // Must use snake_case (Rust convention), not camelCase
    expect(payload).toHaveProperty('station_id');
    expect(payload).toHaveProperty('commit_hash');
    expect(payload).not.toHaveProperty('stationId');
    expect(payload).not.toHaveProperty('commitHash');
  });
});
