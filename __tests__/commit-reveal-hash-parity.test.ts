/**
 * Cross-language commit-hash parity test for backend#767.
 *
 * The backend must compute the weather commit id byte-for-byte the same way the
 * core4 Rust node does (SHA3-256 over a sorted-key JSON object and a 5-field
 * `||` preimage). The original bug shipped a BLAKE3 hash over a readings ARRAY,
 * which core4 rejected at reveal time (422). The mocked unit suite missed it
 * because it only checked payload *shape*, never the hash value or that the
 * forwarded `payload` is an object.
 *
 * The golden vectors below are asserted identically by the core4 Rust test
 * `core4/native-chain/tests/commit_reveal_hash_parity.rs`. Keep them in sync.
 */

import {
  buildCanonicalReading,
  canonicalizeJson,
  computeCommitId,
} from '../shared/commit-reveal-hash.js';
import { createWeatherCommitRevealService } from '../server/routes/weather-commit-reveal-routes.js';

// ---------------------------------------------------------------------------
// Golden vectors — must match commit_reveal_hash_parity.rs exactly.
// ---------------------------------------------------------------------------

interface GoldenVector {
  label: string;
  data: Record<string, number>;
  nonce: string;
  stationId: string;
  timestamp: number;
  expected: string;
}

const GOLDEN_VECTORS: GoldenVector[] = [
  {
    label: 'integer+fractional',
    data: { temperature_c: 22.5, humidity_pct: 65, pressure_hpa: 1013.25, wind_mps: 0, rainfall_mm: 0 },
    nonce: 'reveal-nonce',
    stationId: 'WX-REVEAL-001',
    timestamp: 1_700_000_000,
    expected: 'f662f1e6a3e3c2cfb07ded9a65a9da0106250efe8985144ece9bf15bd8677708',
  },
  {
    label: 'all-fractional',
    data: { temperature_c: 18.3, humidity_pct: 54.2, pressure_hpa: 1009.7, wind_mps: 3.6, rainfall_mm: 0.4 },
    nonce: 'abc-123',
    stationId: 'station-001',
    timestamp: 1_733_000_000,
    expected: '140ded74a31cb1fb52d42a4c88b82764f1f05bb7e19b4aedd9d67cf08f9e7ee4',
  },
  {
    label: 'collector-style-converted',
    data: { temperature_c: 21.11111111111111, humidity_pct: 50, pressure_hpa: 1016.916, wind_mps: 2.2352, rainfall_mm: 0 },
    nonce: 'n1',
    stationId: 'WX-DAVIS-7',
    timestamp: 1_699_999_999,
    expected: '42bcec3eb1fe024428c10468723fb76b37a78d4082a3fdd8f72f21e6f14b2729',
  },
  {
    label: 'all-zero',
    data: { temperature_c: 0, humidity_pct: 0, pressure_hpa: 0, wind_mps: 0, rainfall_mm: 0 },
    nonce: 'z',
    stationId: 'S0',
    timestamp: 1,
    expected: '98db71e92de2b1327bba34822c2595347c820ad522a8adf6a0fec30ba42f9cd8',
  },
];

describe('commit-reveal hash parity with core4 (#767)', () => {
  describe('computeCommitId golden vectors', () => {
    it.each(GOLDEN_VECTORS)('matches core4 for $label', ({ data, nonce, stationId, timestamp, expected }) => {
      expect(computeCommitId({ data, nonce, stationId, timestamp })).toBe(expected);
    });

    it('defaults contributionType to "contribution"', () => {
      const v = GOLDEN_VECTORS[0];
      expect(computeCommitId({ ...v, contributionType: 'contribution' })).toBe(v.expected);
    });
  });

  describe('canonicalizeJson', () => {
    it('sorts object keys recursively (matches Rust serde_json BTreeMap order)', () => {
      const out = canonicalizeJson({ b: 1, a: { d: 4, c: 3 } });
      expect(JSON.stringify(out)).toBe('{"a":{"c":3,"d":4},"b":1}');
    });
  });

  describe('buildCanonicalReading', () => {
    it('maps WeatherObservation field names to the canonical 5-key collector shape', () => {
      const reading = {
        temperature_c: 22.5,
        humidity_percent: 65,
        pressure_hpa: 1013.25,
        wind_speed_ms: 4.1,
        precipitation_mm: 0.2,
        timestamp: '2026-03-25T12:00:00Z',
        extra_field: 'dropped',
      };
      expect(buildCanonicalReading(reading)).toEqual({
        temperature_c: 22.5,
        humidity_pct: 65,
        pressure_hpa: 1013.25,
        wind_mps: 4.1,
        rainfall_mm: 0.2,
      });
    });

    it('falls back to legacy humidity_pct when humidity_percent is absent', () => {
      expect(buildCanonicalReading({ temperature_c: 1, humidity_pct: 42 } as Record<string, unknown>).humidity_pct).toBe(42);
    });

    it('defaults ABSENT numeric fields to 0 (temperature-only stations still work)', () => {
      // pressure_hpa entirely absent → still 0 (no fail-closed regression).
      expect(buildCanonicalReading({ some_other_field: 'x' } as Record<string, unknown>)).toEqual({
        temperature_c: 0,
        humidity_pct: 0,
        pressure_hpa: 0,
        wind_mps: 0,
        rainfall_mm: 0,
      });
    });

    it('#217: throws when pressure_hpa is PRESENT but unparseable (object) — no fail-open to 0', () => {
      expect(() =>
        buildCanonicalReading({ pressure_hpa: { pressureHpa: 1013 } } as unknown as Record<string, unknown>)
      ).toThrow(/pressure_hpa was present but is not a finite scalar/);
    });

    it('#217: still coerces legitimate zero-valued OTHER fields (0°C, 0mm rain)', () => {
      expect(buildCanonicalReading({ temperature_c: 0, precipitation_mm: 0, pressure_hpa: 1000 } as Record<string, unknown>)).toEqual({
        temperature_c: 0,
        humidity_pct: 0,
        pressure_hpa: 1000,
        wind_mps: 0,
        rainfall_mm: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Service-level: the reveal forwarded to core4 must be an OBJECT payload with
  // the timestamp fixed at commit time (the two things core4 rejected before).
  // -------------------------------------------------------------------------
  describe('service forwards a core4-valid reveal', () => {
    const originalOperatorToken = process.env.WRFCOIN_OPERATOR_TOKEN;
    const originalFetch = global.fetch;

    beforeEach(() => {
      process.env.WRFCOIN_OPERATOR_TOKEN = 'test-token';
    });
    afterEach(() => {
      global.fetch = originalFetch;
      jest.restoreAllMocks();
      if (originalOperatorToken === undefined) delete process.env.WRFCOIN_OPERATOR_TOKEN;
      else process.env.WRFCOIN_OPERATOR_TOKEN = originalOperatorToken;
    });

    function createMockDb() {
      let nextId = 1;
      const rows: Record<string, unknown>[] = [];
      const execute = async (sql: string, params?: unknown[]) => {
        const t = sql.replace(/\s+/g, ' ').trim();
        if (t.startsWith('CREATE') || t.startsWith('DO $$') || t.startsWith('ALTER')) return { rows: [] as Record<string, unknown>[] };
        if (t.includes('INSERT INTO weather_commitments') && t.includes('RETURNING id')) {
          const id = nextId++;
          rows.push({
            id,
            station_id: params?.[0],
            commitment_hash: params?.[1],
            reveal_deadline: params?.[2],
            status: 'pending',
            nonce: params?.[3],
            readings_json: params?.[4],
            contributor: params?.[5],
            commit_timestamp: params?.[6],
          });
          return { rows: [{ id }] };
        }
        if (t.includes('FROM weather_commitments') && t.includes('WHERE id =') && !t.includes('UPDATE')) {
          return { rows: rows.filter((r) => Number(r.id) === Number(params?.[0])) };
        }
        if (t.includes("SET status = 'revealing'") && t.includes('WHERE id =')) {
          const updated: Record<string, unknown>[] = [];
          for (const r of rows) {
            if (Number(r.id) === Number(params?.[0]) && r.status === 'pending') {
              r.status = 'revealing';
              updated.push(r);
            }
          }
          return { rows: updated };
        }
        if (t.startsWith('WITH finalized AS')) {
          let finalizedCount = 0;
          for (const r of rows) {
            if (Number(r.id) === Number(params?.[0]) && r.status === 'revealing') {
              r.status = 'revealed';
              finalizedCount = 1;
            }
          }
          return { rows: [{ finalized_count: finalizedCount, inserted_count: finalizedCount }] };
        }
        if (t.includes("SET status = 'revealed'")) {
          for (const r of rows) if (Number(r.id) === Number(params?.[0])) r.status = 'revealed';
          return { rows: [] };
        }
        if (t.includes('INSERT INTO weather_submissions')) return { rows: [] };
        return { rows: [] };
      };
      return { execute, rows };
    }

    it('forwards payload as an object (not an array) with the persisted commit timestamp', async () => {
      const db = createMockDb();
      let height = 10;
      let revealBody: any = null;

      (global as any).fetch = jest.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
          return new Response(JSON.stringify({ height }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/transactions/contribution/commit')) {
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/transactions/contribution/reveal')) {
          revealBody = JSON.parse(init?.body as string);
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      });

      const service = createWeatherCommitRevealService({ db, core4BaseUrl: 'http://localhost:9999', defaultContributor: '0xTEST' });

      const reading = { temperature_c: 22.5, pressure_hpa: 1013.25, humidity_percent: 65, timestamp: '2026-03-25T12:00:00Z' };
      const commit = await service.commit({ stationId: 'WX-OBJ-001', readings: [reading], nonce: 'obj-nonce' });

      const storedTs = Number(db.rows[0].commit_timestamp);
      expect(Number.isFinite(storedTs)).toBe(true);

      height = commit.revealDeadline; // open the reveal window
      await service.reveal({ commitmentId: commit.commitmentId, readings: [reading], nonce: 'obj-nonce' });

      // The two things core4 rejected before the fix:
      expect(revealBody.payload).not.toBeNull();
      expect(Array.isArray(revealBody.payload)).toBe(false);
      expect(typeof revealBody.payload).toBe('object');
      expect(revealBody.payload).toEqual(buildCanonicalReading(reading));
      // timestamp must be the one fixed at commit time, not Date.now()
      expect(revealBody.timestamp).toBe(storedTs);
      // commit_hash must re-derive from exactly what was forwarded
      expect(revealBody.commit_hash).toBe(
        computeCommitId({ data: revealBody.payload, nonce: 'obj-nonce', stationId: 'WX-OBJ-001', timestamp: storedTs })
      );
    });
  });
});
