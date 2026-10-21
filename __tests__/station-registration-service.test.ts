/**
 * Unit tests for the self-service station registration service (backend#788).
 * Pool and Ambient fetch are mocked; no real DB or network.
 */

import {
  registerStation,
  listRegisteredStations,
  listStationCredentials,
  verifyAmbientKey,
  resolveMaxStationsPerOwner,
  normalizeOwnerAddress,
  slug,
  type QueryablePool,
  type FetchLike,
} from '../server/services/station-registration-service.js';

// 32-byte (64-hex) AES-256-GCM key for the round-trip encryption assertions.
const ENC_KEY = 'a'.repeat(64);

function mockPool(): { pool: QueryablePool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool: QueryablePool = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      // Real Postgres COUNT(*) always yields exactly one row; a mock that
      // returns [] for it would trip the #589 fail-closed path in every test.
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ n: 0 }] };
      }
      return { rows: [] };
    }),
  };
  return { pool, calls };
}

/**
 * Pool that reports an already-registered station owned by `existingOwner` when
 * the ownership-conflict SELECT runs, and records every write. Used to exercise
 * the #789 station-ownership-hijack guard.
 */
function mockPoolWithExisting(
  existingOwner: string
): { pool: QueryablePool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool: QueryablePool = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT owner_address FROM weather_stations')) {
        return { rows: [{ owner_address: existingOwner }] };
      }
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ n: 0 }] };
      }
      return { rows: [] };
    }),
  };
  return { pool, calls };
}

function okFetch(devices: unknown[]): FetchLike {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => devices,
  })) as unknown as FetchLike;
}

const fixedRandomHex = (_bytes: number) => 'abc123';

const AMBIENT_DEVICE = {
  macAddress: 'AA:BB:CC:DD:EE:FF',
  info: { name: 'Backyard', coords: { coords: { lat: 46.8, lon: -92.0 } } },
};

describe('slug', () => {
  it('normalizes names to url-safe slugs', () => {
    expect(slug("Example Station!!")).toBe('example-station');
    expect(slug('   ')).toBe('station');
  });
});

describe('verifyAmbientKey', () => {
  it('returns valid + mapped devices on a 200 with a non-empty array', async () => {
    const res = await verifyAmbientKey(okFetch([AMBIENT_DEVICE]), 'api', 'app');
    expect(res.valid).toBe(true);
    expect(res.devices).toEqual([
      { name: 'Backyard', mac: 'AA:BB:CC:DD:EE:FF', latitude: 46.8, longitude: -92.0 },
    ]);
  });

  it('returns invalid on a non-200', async () => {
    const fetchFn = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as FetchLike;
    const res = await verifyAmbientKey(fetchFn, 'api', 'app');
    expect(res.valid).toBe(false);
    expect(res.devices).toEqual([]);
  });

  it('returns invalid on an empty array', async () => {
    const res = await verifyAmbientKey(okFetch([]), 'api', 'app');
    expect(res.valid).toBe(false);
  });
});

describe('registerStation', () => {
  it('valid Ambient key → 201 with stationId and encrypted credential upsert', async () => {
    const { pool, calls } = mockPool();
    const fetchFn = okFetch([AMBIENT_DEVICE]);

    const result = await registerStation(
      {
        name: "Example Station",
        latitude: 10.123456,
        longitude: 20.654321,
        provider: 'ambient',
        ambientApiKey: 'secret-api',
        ambientAppKey: 'secret-app',
        hardware: 'Ambient Weather WS-5000',
      },
      '0xOWNER',
      { pool, fetchFn, encryptionKey: ENC_KEY },
      fixedRandomHex
    );

    expect(result.status).toBe(201);
    expect(result.body.success).toBe(true);
    expect(result.body.stationId).toBe('pws-example-station-abc123');
    // Owner identity is canonicalised (trimmed + lowercased) on write.
    expect(result.body.ownerAddress).toBe('0xowner');

    // Owner lock/ownership, inferred MAC lock/probe, cap check, then upserts.
    expect(calls.length).toBe(7);
    expect(calls[0].sql).toContain('pg_advisory_xact_lock');
    expect(calls[1].sql).toContain('SELECT owner_address FROM weather_stations');
    expect(calls[2].sql).toContain('pg_advisory_xact_lock');
    expect(calls[3].sql).toContain("metadata->>'mac'");
    expect(calls[4].sql).toContain('COUNT(*)');
    expect(calls[5].sql).toContain('INSERT INTO weather_stations');
    expect(calls[6].sql).toContain('INSERT INTO station_provider_credentials');

    // The plaintext key must NOT be stored anywhere in the credential params.
    const credParams = calls[6].params.map(String).join('|');
    expect(credParams).not.toContain('secret-api');
    expect(credParams).not.toContain('secret-app');
  });

  it('invalid Ambient key → 400 INVALID_AMBIENT_KEY and no DB writes', async () => {
    const { pool, calls } = mockPool();
    const fetchFn = okFetch([]); // empty array => invalid

    const result = await registerStation(
      {
        name: 'Bad Station',
        latitude: 10,
        longitude: 10,
        ambientApiKey: 'nope',
        ambientAppKey: 'nope',
      },
      '0xOWNER',
      { pool, fetchFn, encryptionKey: ENC_KEY },
      fixedRandomHex
    );

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('INVALID_AMBIENT_KEY');
    expect(calls.length).toBe(0);
  });

  it('rejects out-of-range latitude', async () => {
    const { pool } = mockPool();
    const result = await registerStation(
      { name: 'X', latitude: 999, longitude: 0 },
      '0xOWNER',
      { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('INVALID_REQUEST');
  });

  it('rejects an unknown provider not in the allowlist', async () => {
    const { pool } = mockPool();
    const result = await registerStation(
      { name: 'X', latitude: 0, longitude: 0, provider: 'totally-made-up' },
      '0xOWNER',
      { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('UNSUPPORTED_PROVIDER');
    // The error advertises which providers ARE supported.
    expect(result.body.supportedProviders).toEqual(
      expect.arrayContaining(['ambient', 'acurite', 'davis', 'netatmo', 'ecowitt', 'tempest'])
    );
  });

  // --- #847: supported-but-not-yet-wired providers register in 'pending' ---

  it.each(['acurite', 'davis', 'netatmo', 'ecowitt', 'tempest'])(
    "accepts provider '%s' in a pending ingestion state (no key check, no credential row)",
    async (provider) => {
      const { pool, calls } = mockPool();
      // A fetch that would FAIL validation if it were (incorrectly) called —
      // proves pending providers never hit live key verification.
      const fetchFn = okFetch([]);
      const result = await registerStation(
        {
          name: `${provider} station`,
          latitude: 46.8,
          longitude: -92.0,
          provider,
          // A key is supplied, but for a pending provider it must be ignored
          // (no validation, no encrypted credential row).
          ambientApiKey: 'should-be-ignored',
          ambientAppKey: 'should-be-ignored',
        },
        '0xOWNER',
        { pool, fetchFn, encryptionKey: ENC_KEY },
        fixedRandomHex
      );

      expect(result.status).toBe(201);
      expect(result.body.success).toBe(true);
      expect(result.body.provider).toBe(provider);
      expect(result.body.ingestionStatus).toBe('pending');
      expect(typeof result.body.message).toBe('string');

      // Lock + ownership SELECT + #589 cap COUNT + the station upsert — NO
      // credential upsert (we don't store keys for unwired providers).
      expect(calls.length).toBe(4);
      expect(calls[0].sql).toContain('pg_advisory_xact_lock');
      expect(calls[1].sql).toContain('SELECT owner_address FROM weather_stations');
      expect(calls[2].sql).toContain('COUNT(*)');
      expect(calls[3].sql).toContain('INSERT INTO weather_stations');
      expect(calls.some((c) => c.sql.includes('station_provider_credentials'))).toBe(false);

      // The supplied key must NOT be stored anywhere.
      const allParams = calls.flatMap((c) => c.params).map(String).join('|');
      expect(allParams).not.toContain('should-be-ignored');

      // The metadata column records the pending ingestion status honestly.
      const stationParams = calls[3].params.map(String).join('|');
      expect(stationParams).toContain('"ingestionStatus":"pending"');
    }
  );

  it("ambient remains the live provider (ingestionStatus 'active', key validated + stored)", async () => {
    const { pool, calls } = mockPool();
    const fetchFn = okFetch([AMBIENT_DEVICE]);
    const result = await registerStation(
      {
        name: 'Live Ambient',
        latitude: 46.8,
        longitude: -92.0,
        provider: 'ambient',
        ambientApiKey: 'secret-api',
        ambientAppKey: 'secret-app',
      },
      '0xOWNER',
      { pool, fetchFn, encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(201);
    expect(result.body.ingestionStatus).toBe('active');
    // Owner lock + SELECT + cap COUNT + MAC lock/probe + two upserts.
    expect(calls.length).toBe(7);
    expect(calls[6].sql).toContain('INSERT INTO station_provider_credentials');
  });

  it('registers without a provider key (no credential row)', async () => {
    const { pool, calls } = mockPool();
    const result = await registerStation(
      { name: 'No Key', latitude: 1, longitude: 2, stationId: 'custom-id' },
      '0xOWNER',
      { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(201);
    expect(result.body.stationId).toBe('custom-id');
    // Lock + SELECT existing-owner probe + #589 cap COUNT + the station
    // upsert; no credential row.
    expect(calls.length).toBe(4);
    expect(calls[0].sql).toContain('pg_advisory_xact_lock');
    expect(calls[1].sql).toContain('SELECT owner_address FROM weather_stations');
    expect(calls[2].sql).toContain('COUNT(*)');
    expect(calls[3].sql).toContain('INSERT INTO weather_stations');
  });

  // --- #789: prevent station-ownership hijack on stationId conflict ---

  it('stationId conflict with a DIFFERENT owner → 409 STATION_ID_TAKEN and no writes', async () => {
    const { pool, calls } = mockPoolWithExisting('0xVICTIM');
    const result = await registerStation(
      { name: 'Hijack Attempt', latitude: 1, longitude: 2, stationId: 'taken-id' },
      '0xATTACKER',
      { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('STATION_ID_TAKEN');
    // Lock + the ownership SELECT — no INSERT/UPDATE reassigned the owner.
    expect(calls.length).toBe(2);
    expect(calls[0].sql).toContain('pg_advisory_xact_lock');
    expect(calls[1].sql).toContain('SELECT owner_address FROM weather_stations');
  });

  it('stationId conflict with the SAME owner → 201 (idempotent re-register / update)', async () => {
    const { pool, calls } = mockPoolWithExisting('0xOWNER');
    const result = await registerStation(
      { name: 'My Station Updated', latitude: 3, longitude: 4, stationId: 'mine-id' },
      '0xOWNER',
      { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(201);
    expect(result.body.stationId).toBe('mine-id');
    // Lock, owner probe, retained-MAC probe and station upsert.
    expect(calls.length).toBe(4);
    expect(calls[3].sql).toContain('INSERT INTO weather_stations');
  });

  it('stationId conflict with a different owner BUT admin override → 201 (reassign allowed)', async () => {
    const { pool, calls } = mockPoolWithExisting('0xVICTIM');
    const result = await registerStation(
      { name: 'Admin Reassign', latitude: 5, longitude: 6, stationId: 'taken-id' },
      '0xNEWOWNER',
      { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
      fixedRandomHex,
      { isAdminOverride: true }
    );
    expect(result.status).toBe(201);
    expect(result.body.ownerAddress).toBe('0xnewowner');
    expect(calls.length).toBe(4);
    expect(calls[3].sql).toContain('INSERT INTO weather_stations');
  });
});

describe('listRegisteredStations', () => {
  it('maps DB rows to the contributor-map shape', async () => {
    const pool: QueryablePool = {
      query: jest.fn(async () => ({
        rows: [
          {
            station_id: 'pws-1',
            name: 'Station One',
            owner_address: '0xabc',
            location: 'Duluth, MN',
            latitude: 46.8,
            longitude: -92.0,
            is_active: true,
            quality_score: 95,
            total_rewards: '12',
          },
        ],
      })),
    };
    const page = await listRegisteredStations(pool);
    expect(page.stations).toEqual([
      {
        id: 'pws-1',
        stationId: 'pws-1',
        name: 'Station One',
        latitude: 46.8,
        longitude: -92.0,
        location: 'Duluth, MN',
        status: 'registered',
        lastDataUpdate: null,
        isActive: true,
        qualityScore: 95,
        totalRewards: '12',
        ownerAddress: '0xabc',
      },
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('#885: bounds the query with a LIMIT and reports hasMore + nextCursor', async () => {
    // Two rows returned for a requested limit of 1 → one extra row signals more.
    const query = jest.fn(async () => ({
      rows: [
        { station_id: 'pws-1', name: 'One', owner_address: '0xa', location: null, latitude: 1, longitude: 2, is_active: true, quality_score: null, total_rewards: null },
        { station_id: 'pws-2', name: 'Two', owner_address: '0xb', location: null, latitude: 3, longitude: 4, is_active: false, quality_score: null, total_rewards: null },
      ],
    }));
    const pool: QueryablePool = { query };
    const page = await listRegisteredStations(pool, { limit: 1 });
    expect(page.stations).toHaveLength(1);
    expect(page.stations[0].stationId).toBe('pws-1');
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('pws-1');
    // The SQL must carry a LIMIT and request limit+1 rows.
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/LIMIT \$\d+/i);
    expect(params).toContain(2);
  });

  it('#885: applies the keyset cursor via station_id > $1', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const pool: QueryablePool = { query };
    await listRegisteredStations(pool, { limit: 50, after: 'pws-9' });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/station_id > \$1/);
    expect(params[0]).toBe('pws-9');
  });
});

describe('listStationCredentials', () => {
  it('decrypts stored keys for the collector', async () => {
    // Build an encrypted row using the real encryptData so decrypt round-trips.
    const { encryptData } = await import('../server/utils/crypto.js');
    const enc = encryptData('plaintext-api', ENC_KEY);
    const encApp = encryptData('plaintext-app', ENC_KEY);

    const pool: QueryablePool = {
      query: jest.fn(async () => ({
        rows: [
          {
            station_id: 'pws-1',
            provider: 'ambient',
            encrypted_api_key: enc.encrypted,
            key_iv: enc.iv,
            key_tag: enc.tag,
            encrypted_app_key: encApp.encrypted,
            app_iv: encApp.iv,
            app_tag: encApp.tag,
            owner_address: '0xabc',
            latitude: 46.8,
            longitude: -92.0,
          },
        ],
      })),
    };

    const creds = await listStationCredentials(pool, ENC_KEY);
    expect(creds).toEqual([
      {
        stationId: 'pws-1',
        ownerAddress: '0xabc',
        provider: 'ambient',
        apiKey: 'plaintext-api',
        appKey: 'plaintext-app',
        latitude: 46.8,
        longitude: -92.0,
      },
    ]);
  });
});

describe('#589 per-owner registration cap', () => {
  const VALID_INPUT = {
    name: 'Cap Test Wx',
    latitude: 46.8,
    longitude: -92.0,
    provider: 'ambient',
    ambientApiKey: 'k',
    ambientAppKey: 'a',
  };

  function poolWithCount(n: number | 'throw') {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool: QueryablePool = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('COUNT(*)')) {
          if (n === 'throw') throw new Error('db down');
          return { rows: [{ n }] };
        }
        return { rows: [] };
      }),
    };
    return { pool, calls };
  }

  it('refuses a NEW station once the owner is at the default cap (429, no writes)', async () => {
    const { pool, calls } = poolWithCount(10);
    const result = await registerStation(
      VALID_INPUT, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(429);
    expect(result.body.error).toBe('STATION_LIMIT_REACHED');
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('honours an explicit env cap, including 0 = registration frozen', async () => {
    const { pool } = poolWithCount(0);
    const result = await registerStation(
      VALID_INPUT, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex,
      { maxStationsPerOwner: '0' }
    );
    expect(result.status).toBe(429);
  });

  it('FAILS CLOSED: unreadable count refuses registration (503), never allows', async () => {
    const { pool, calls } = poolWithCount('throw');
    const result = await registerStation(
      VALID_INPUT, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(503);
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('update of an ALREADY-OWNED station bypasses the cap (key rotation at cap works)', async () => {
    const { pool, calls } = mockPoolWithExisting('0xOWNER');
    const result = await registerStation(
      { ...VALID_INPUT, stationId: 'pws-existing' }, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(201);
    expect(calls.some((c) => c.sql.includes('COUNT(*)'))).toBe(false);
  });

  it('admin override bypasses the cap (pre-existing contributor migration)', async () => {
    const { pool, calls } = poolWithCount(10);
    const result = await registerStation(
      VALID_INPUT, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex,
      { isAdminOverride: true }
    );
    expect(result.status).toBe(201);
    expect(calls.some((c) => c.sql.includes('COUNT(*)'))).toBe(false);
  });

  it('resolveMaxStationsPerOwner: default 10; malformed values NEVER widen to Infinity', () => {
    expect(resolveMaxStationsPerOwner(undefined)).toBe(10);
    expect(resolveMaxStationsPerOwner('')).toBe(10);
    expect(resolveMaxStationsPerOwner('abc')).toBe(10);
    expect(resolveMaxStationsPerOwner('-1')).toBe(10);
    expect(resolveMaxStationsPerOwner('1.5')).toBe(10);
    expect(resolveMaxStationsPerOwner('Infinity')).toBe(10);
    expect(resolveMaxStationsPerOwner('25')).toBe(25);
    expect(resolveMaxStationsPerOwner('0')).toBe(0);
  });
});

describe('#161 hardware-root admission mirror', () => {
  const ROOT = 'ab'.repeat(32);
  const INPUT = {
    name: 'Rooted Wx',
    latitude: 46.8,
    longitude: -92.0,
    provider: 'ambient',
    ambientApiKey: 'k',
    ambientAppKey: 'a',
    hardwarePubkey: ROOT.toUpperCase(), // normalization must lowercase it
  };

  function poolWithRootHolder(stationId: string | null) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool: QueryablePool = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("metadata->>'hardwarePubkey'")) {
          return stationId ? { rows: [{ station_id: stationId }] } : { rows: [] };
        }
        if (sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
        return { rows: [] };
      }),
    };
    return { pool, calls };
  }

  it('a valid root registers, normalized lowercase, stored in metadata', async () => {
    const { pool, calls } = poolWithRootHolder(null);
    const result = await registerStation(
      INPUT, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(201);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO weather_stations'));
    expect(insert).toBeDefined();
    expect(insert!.params.map(String).join('|')).toContain(`"hardwarePubkey":"${ROOT}"`);
  });

  it('a malformed root is rejected 400 — reject, never coerce; nothing runs', async () => {
    const { pool, calls } = poolWithRootHolder(null);
    const result = await registerStation(
      { ...INPUT, hardwarePubkey: 'not-a-key' }, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('INVALID_HARDWARE_PUBKEY');
    expect(calls.length).toBe(0);
  });

  it('a root already bound to ANOTHER station is refused 409, no writes', async () => {
    const { pool, calls } = poolWithRootHolder('pws-someone-else');
    const result = await registerStation(
      INPUT, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('HARDWARE_ROOT_TAKEN');
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('re-registering the SAME station with its own root stays idempotent (201)', async () => {
    const { pool } = poolWithRootHolder('pws-rooted-wx-abc123');
    const result = await registerStation(
      { ...INPUT, stationId: 'pws-rooted-wx-abc123' }, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(201);
  });

  it('FAILS CLOSED: unreadable uniqueness check refuses with 503', async () => {
    const calls: Array<{ sql: string }> = [];
    const pool: QueryablePool = {
      query: jest.fn(async (sql: string) => {
        calls.push({ sql });
        if (sql.includes("metadata->>'hardwarePubkey'")) throw new Error('db down');
        return { rows: [] };
      }),
    };
    const result = await registerStation(
      INPUT, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(503);
  });

  it('stations WITHOUT a root still register (the live cloud-pulled fleet)', async () => {
    const { pool, calls } = mockPool();
    const result = await registerStation(
      { ...INPUT, hardwarePubkey: undefined }, '0xOWNER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(201);
    expect(calls.some((c) => c.sql.includes("hardwarePubkey"))).toBe(false);
  });
});

describe('#589 cap under CONCURRENCY (PR #1000 review finding — measured 25-of-10 bypass)', () => {
  /**
   * Models a real database the way the review probe did: COUNT sees only
   * COMMITTED rows, every statement costs one async round-trip, and
   * pg_advisory_xact_lock is a real per-key mutex held until the caller's
   * "transaction" ends (releaseTx below — the route's COMMIT). Without the
   * advisory lock, all N callers pass their count round-trip before any
   * commit lands, which is exactly the measured 25×201 / 0×429 bypass.
   */
  function makeConcurrentDb() {
    const committed: Array<{ owner: string }> = [];
    const lockQueues = new Map<string, Promise<void>>();

    function client() {
      const releaseLocks: Array<() => void> = [];
      const pool: QueryablePool = {
        query: jest.fn(async (sql: string, params: unknown[] = []) => {
          await new Promise((r) => setImmediate(r)); // one network round-trip
          if (sql.includes('pg_advisory_xact_lock')) {
            const key = `${sql}:${String(params[0])}`;
            const prev = lockQueues.get(key) ?? Promise.resolve();
            let release!: () => void;
            const held = new Promise<void>((r) => { release = r; });
            lockQueues.set(key, prev.then(() => held));
            await prev;
            releaseLocks.push(release);
            return { rows: [] };
          }
          if (sql.includes('COUNT(*)')) {
            const owner = String(params[0]);
            return { rows: [{ n: committed.filter((r) => r.owner === owner).length }] };
          }
          if (sql.includes('INSERT INTO weather_stations')) {
            committed.push({ owner: String(params[1]) });
            return { rows: [] };
          }
          return { rows: [] };
        }),
      };
      return { pool, releaseTx: () => releaseLocks.splice(0).reverse().forEach((release) => release()) };
    }

    return { committed, client };
  }

  it('25 concurrent registrations from ONE wallet against cap 10 → exactly 10×201, 15×429', async () => {
    const db = makeConcurrentDb();
    const attempts = Array.from({ length: 25 }, (_, i) => {
      const { pool, releaseTx } = db.client();
      return registerStation(
        {
          name: `Burst Wx ${i}`,
          latitude: 46.8,
          longitude: -92.0,
          provider: 'ambient',
          ambientApiKey: 'k',
          ambientAppKey: 'a',
        },
        '0xONEWALLET',
        { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
        (bytes) => `r${i}-${'0'.repeat(bytes)}`
      ).then((result) => {
        releaseTx(); // the route's COMMIT — the xact lock releases here
        return result.status;
      });
    });

    const statuses = await Promise.all(attempts);
    const accepted = statuses.filter((s) => s === 201).length;
    const refused = statuses.filter((s) => s === 429).length;

    expect(accepted).toBe(10);
    expect(refused).toBe(15);
    expect(db.committed.length).toBe(10);
  });
});

describe('#161 root uniqueness under concurrency — the constraint is the guard', () => {
  it('surfaces the unique-index violation (23505) as the same 409, not a 500', async () => {
    const pool: QueryablePool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO weather_stations')) {
          const err = new Error('duplicate key value violates unique constraint') as Error & {
            code: string; constraint: string;
          };
          err.code = '23505';
          err.constraint = 'uniq_weather_stations_hardware_pubkey';
          throw err;
        }
        if (sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
        return { rows: [] };
      }),
    };
    const result = await registerStation(
      {
        name: 'Race Loser',
        latitude: 1, longitude: 2, provider: 'ambient',
        ambientApiKey: 'k', ambientAppKey: 'a',
        hardwarePubkey: 'cd'.repeat(32),
      },
      '0xLOSER',
      { pool, fetchFn: okFetch([AMBIENT_DEVICE]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('HARDWARE_ROOT_TAKEN');
  });
});

describe('case-insensitive owner matching (EVM mixed-case vs ed25519 lowercase subjects)', () => {
  // EVM login stores whatever case the client sent; ed25519 login subjects
  // are lowercase. The same wallet must be one owner.
  const MIXED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
  const LOWER = MIXED.toLowerCase();

  /**
   * Row-backed pool that evaluates the owner predicates the way Postgres
   * would for the SQL actually sent: `lower(owner_address) = $1` compares the
   * lowercased column, a bare `owner_address = $1` compares bytes. A
   * regression back to exact equality therefore changes the result.
   */
  function rowPool(rows: Array<{ station_id: string; owner_address: string }>) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool: QueryablePool = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('SELECT owner_address FROM weather_stations')) {
          return { rows: rows.filter((r) => r.station_id === params[0]).map((r) => ({ owner_address: r.owner_address })) };
        }
        if (sql.includes('COUNT(*)')) {
          const want = String(params[0]);
          const ci = /lower\(owner_address\)\s*=\s*\$1/.test(sql);
          const n = rows.filter((r) => (ci ? r.owner_address.toLowerCase() === want : r.owner_address === want)).length;
          return { rows: [{ n }] };
        }
        return { rows: [] };
      }),
    };
    return { pool, calls };
  }

  it('normalizeOwnerAddress trims and lowercases', () => {
    expect(normalizeOwnerAddress(`  ${MIXED} `)).toBe(LOWER);
  });

  it('advisory lock is keyed on the lowercased owner for every case variant', async () => {
    for (const variant of [MIXED, LOWER, MIXED.toUpperCase().replace('0X', '0x')]) {
      const { pool, calls } = rowPool([]);
      await registerStation(
        { name: 'Lock Wx', latitude: 1, longitude: 2 },
        variant,
        { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
        fixedRandomHex
      );
      expect(calls[0].sql).toContain('pg_advisory_xact_lock(589, hashtext($1))');
      expect(calls[0].params).toEqual([LOWER]);
    }
  });

  it('a pre-existing MIXED-case row still matches its owner logging in lowercase (no 409)', async () => {
    const { pool, calls } = rowPool([{ station_id: 'pws-mine', owner_address: MIXED }]);
    const result = await registerStation(
      { name: 'Mine', latitude: 1, longitude: 2, stationId: 'pws-mine' },
      LOWER,
      { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(201);
    // Update of own station: the cap is not consulted.
    expect(calls.some((c) => c.sql.includes('COUNT(*)'))).toBe(false);
  });

  it('a genuinely different owner is still refused (409) regardless of case', async () => {
    const { pool } = rowPool([{ station_id: 'pws-theirs', owner_address: MIXED }]);
    const result = await registerStation(
      { name: 'Hijack', latitude: 1, longitude: 2, stationId: 'pws-theirs' },
      '0x' + '9'.repeat(40),
      { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('STATION_ID_TAKEN');
  });

  it('per-owner cap counts stations across case variants', async () => {
    // 2 rows stored mixed-case + 1 lowercase = 3 stations for one wallet.
    const { pool, calls } = rowPool([
      { station_id: 's1', owner_address: MIXED },
      { station_id: 's2', owner_address: MIXED },
      { station_id: 's3', owner_address: LOWER },
    ]);
    const result = await registerStation(
      { name: 'Fourth', latitude: 1, longitude: 2 },
      LOWER,
      { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
      fixedRandomHex,
      { maxStationsPerOwner: '3' }
    );
    expect(result.status).toBe(429);
    expect(result.body.error).toBe('STATION_LIMIT_REACHED');
    const count = calls.find((c) => c.sql.includes('COUNT(*)'));
    expect(count?.sql).toContain('lower(owner_address) = $1');
    expect(count?.params).toEqual([LOWER]);
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('writes the station row with the lowercased owner', async () => {
    const { pool, calls } = rowPool([]);
    const result = await registerStation(
      { name: 'New', latitude: 1, longitude: 2 },
      MIXED,
      { pool, fetchFn: okFetch([]), encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(result.status).toBe(201);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO weather_stations'));
    expect(insert?.params[1]).toBe(LOWER);
  });
});

describe('station data freshness (#1255)', () => {
  it('uses observations rather than registration activity, with honest nulls and a 15-minute boundary', async () => {
    const now = Date.parse('2026-09-27T00:30:00Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const query = jest.fn(async () => ({ rows: [
      { station_id: 'registered', is_active: true, last_data_update: null },
      { station_id: 'live-inactive-registration', is_active: false, last_data_update: new Date(now - 60_000) },
      { station_id: 'boundary', is_active: true, last_data_update: new Date(now - 15 * 60_000).toISOString() },
      { station_id: 'stale', is_active: true, last_data_update: new Date(now - 15 * 60_000 - 1) },
      { station_id: 'invalid', is_active: true, last_data_update: 'invalid-time' },
      { station_id: 'future', is_active: true, last_data_update: new Date(now + 60_000) },
    ] }));
    try {
      const page = await listRegisteredStations({ query });
      expect(page.stations.map(s => s.status)).toEqual(['registered', 'live', 'live', 'stale', 'registered', 'registered']);
      expect(page.stations[0]).toMatchObject({ lastDataUpdate: null, isActive: true });
      expect(page.stations[1]).toMatchObject({ lastDataUpdate: '2026-09-27T00:29:00.000Z', isActive: false });
      expect(page.stations[4].lastDataUpdate).toBeNull();
      expect(page.stations[5].lastDataUpdate).toBeNull();
      const sql = String(query.mock.calls[0][0]);
      expect(sql).toMatch(/MAX\(timestamp\)/i);
      expect(sql).toMatch(/FROM weather_data/i);
      expect(sql).toMatch(/weather_data\.station_id\s*=\s*weather_stations\.station_id/i);
      expect(sql).toMatch(/timestamp\s*<=\s*CURRENT_TIMESTAMP/i);
    } finally { clock.mockRestore(); }
  });
});
