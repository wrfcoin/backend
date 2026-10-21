/**
 * Station registration elevation (core4#3285).
 *
 * Owner ruling 2026-09-24: the sensor elevation comes from a USGS EPQS DEM
 * lookup at the registered coordinates plus the sensor height; an operator
 * override wins; a DEM failure registers WITHOUT an elevation — never a guess.
 *
 * Every DEM response here is mocked. No test makes a network call.
 */

import {
  registerStation,
  toRegistrationGrid,
  listStationCredentials,
  lookupDemElevation,
  resolveStationElevation,
  USGS_EPQS_URL,
  METADATA_UPSERT_SQL,
  type QueryablePool,
  type FetchLike,
} from '../server/services/station-registration-service.js';
import { encryptData } from '../server/utils/crypto.js';
import { ReferenceShadowScorer, referencePressurePlan } from '../server/services/reference-shadow-scorer.js';
import type { ReferenceVerifierClient } from '../server/services/reference-verifier-client.js';

const ENC_KEY = 'a'.repeat(64);
const OWNER = '0x' + '1'.repeat(40);
const fixedRandomHex = () => 'abc123';

// Synthetic positions; the elevations and DEM values are the core4#3285 decision record's.
const EXAMPLE = { lat: 40.0, lon: -100.0, elevationM: 227.7, demM: '247.9' };
const STEVEN = { lat: 40.5, lon: -100.5, demM: '240.509017944' };

function mockPool(): { pool: QueryablePool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool: QueryablePool = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
      return { rows: [] };
    }),
  };
  return { pool, calls };
}

/** EPQS-shaped success: `value` arrives as a STRING, as the live service returns it. */
function demFetch(value: unknown): jest.Mock {
  return jest.fn(async (url: string) => {
    if (!url.startsWith(USGS_EPQS_URL)) throw new Error(`unexpected URL in test: ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        location: { x: 0, y: 0, spatialReference: { wkid: 4326 } },
        locationId: 0,
        value,
        rasterId: 100360,
        resolution: 1,
      }),
    };
  });
}

/**
 * The mocks apply relocation-nulling ONLY when the executed SQL text carries
 * the clause, so removing it from the statement fails the behaviour tests.
 * The statement itself is run against real Postgres in the PR's probe.
 */
function sqlNullsOnRelocation(sql: string): boolean {
  return (
    /weather_stations\.latitude IS DISTINCT FROM EXCLUDED\.latitude/.test(sql) &&
    /NOT \(EXCLUDED\.metadata \? 'elevation_m'\)/.test(sql) &&
    sql.includes('"elevation_m": null')
  );
}

function insertedMetadata(calls: Array<{ sql: string; params: unknown[] }>): Record<string, unknown> {
  const insert = calls.find((c) => c.sql.includes('INSERT INTO weather_stations'));
  if (!insert) throw new Error('no weather_stations insert');
  return JSON.parse(String(insert.params[7]));
}

async function register(input: Record<string, unknown>, fetchFn: FetchLike) {
  const { pool, calls } = mockPool();
  const result = await registerStation(
    { name: 'Wx', ...input },
    OWNER,
    { pool, fetchFn, encryptionKey: ENC_KEY },
    fixedRandomHex
  );
  return { result, calls };
}

describe('core4#3285 registration elevation — DEM lookup', () => {
  it("Steven: no override → DEM ground (240.51) + sensor height, stored as metadata.elevation_m", async () => {
    const fetchFn = demFetch(STEVEN.demM);
    const { result, calls } = await register(
      { latitude: STEVEN.lat, longitude: STEVEN.lon, sensor_height_m: 2 },
      fetchFn as unknown as FetchLike
    );

    expect(result.status).toBe(201);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(`${url.origin}${url.pathname}`).toBe(USGS_EPQS_URL);
    // W20: the DEM lookup gets the registered 0.1-degree position, never the input.
    expect(Number(url.searchParams.get('x'))).toBe(toRegistrationGrid(STEVEN.lon)); // x = longitude
    expect(Number(url.searchParams.get('y'))).toBe(toRegistrationGrid(STEVEN.lat)); // y = latitude
    expect(url.searchParams.get('units')).toBe('Meters');
    expect(url.searchParams.get('wkid')).toBe('4326');
    // No API key of any kind is sent (zero-budget, public service).
    expect(url.search).not.toMatch(/key/i);

    const meta = insertedMetadata(calls);
    expect(meta.elevation_m).toBe(242.51);
    expect(meta.elevation_source).toBe('usgs_epqs_dem');
    expect(meta.dem_ground_elevation_m).toBe(240.51);
    expect(meta.sensor_height_m).toBe(2);
    expect(result.body.elevation).toEqual({
      elevationMeters: 242.51,
      source: 'usgs_epqs_dem',
      demGroundElevationM: 240.51,
      sensorHeightM: 2,
    });
  });

  it('sensor height defaults to 0 when not given', async () => {
    const { result } = await register(
      { latitude: STEVEN.lat, longitude: STEVEN.lon },
      demFetch(STEVEN.demM) as unknown as FetchLike
    );
    expect((result.body.elevation as Record<string, unknown>).elevationMeters).toBe(240.51);
  });

  it('camelCase sensorHeightM is accepted like sensor_height_m', async () => {
    const { result } = await register(
      { latitude: STEVEN.lat, longitude: STEVEN.lon, sensorHeightM: '1.5' },
      demFetch(STEVEN.demM) as unknown as FetchLike
    );
    expect((result.body.elevation as Record<string, unknown>).elevationMeters).toBe(242.01);
  });
});

describe('core4#3285 registration elevation — operator override wins', () => {
  it('Example Station: override 227.7 m wins over the DEM (247.9 m); the DEM is not even queried', async () => {
    const fetchFn = demFetch(EXAMPLE.demM);
    const { result, calls } = await register(
      { latitude: EXAMPLE.lat, longitude: EXAMPLE.lon, elevation_meters: EXAMPLE.elevationM },
      fetchFn as unknown as FetchLike
    );

    expect(result.status).toBe(201);
    expect(fetchFn).not.toHaveBeenCalled();
    const meta = insertedMetadata(calls);
    expect(meta.elevation_m).toBe(227.7);
    expect(meta.elevation_source).toBe('operator_override');
    expect(meta.dem_ground_elevation_m).toBeNull();
    expect(result.body.elevation).toEqual({ elevationMeters: 227.7, source: 'operator_override' });
  });

  it('sensor height is NOT added to an override (the override is the sensor elevation)', async () => {
    const { calls } = await register(
      { latitude: EXAMPLE.lat, longitude: EXAMPLE.lon, elevationMeters: '227.7', sensor_height_m: 3 },
      demFetch(EXAMPLE.demM) as unknown as FetchLike
    );
    expect(insertedMetadata(calls).elevation_m).toBe(227.7);
  });

  it.each([
    ['abc'],
    [20000],
    [-1000],
    [Number.NaN],
    [true],
  ])('invalid override %p → 400 INVALID_ELEVATION, no DEM call, no writes', async (bad) => {
    const fetchFn = demFetch(EXAMPLE.demM);
    const { result, calls } = await register(
      { latitude: EXAMPLE.lat, longitude: EXAMPLE.lon, elevation_meters: bad },
      fetchFn as unknown as FetchLike
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('INVALID_ELEVATION');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([[-1], [500], ['tall']])('invalid sensor height %p → 400 INVALID_SENSOR_HEIGHT', async (bad) => {
    const { result, calls } = await register(
      { latitude: STEVEN.lat, longitude: STEVEN.lon, sensor_height_m: bad },
      demFetch(STEVEN.demM) as unknown as FetchLike
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('INVALID_SENSOR_HEIGHT');
    expect(calls).toHaveLength(0);
  });
});

describe('core4#3285 registration elevation — DEM failure → no elevation, never a guess', () => {
  const failures: Array<[string, () => jest.Mock, string]> = [
    ['network error', () => jest.fn(async () => { throw new Error('ECONNREFUSED'); }), 'dem_unreachable'],
    ['HTTP 500', () => jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })), 'dem_http_500'],
    [
      'non-JSON body (EPQS "Invalid or missing input parameters.")',
      () => jest.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })),
      'dem_unreachable',
    ],
    ['EPQS no-data sentinel -1000000', () => demFetch(-1000000), 'dem_no_data'],
    ['non-numeric value', () => demFetch('abc'), 'dem_no_data'],
    ['missing value', () => demFetch(undefined), 'dem_no_data'],
    ['JSON null body', () => jest.fn(async () => ({ ok: true, status: 200, json: async () => null })), 'dem_no_data'],
  ];

  it.each(failures)('%s → 201 registered WITHOUT elevation_m', async (_label, makeFetch, reason) => {
    const { result, calls } = await register(
      { latitude: STEVEN.lat, longitude: STEVEN.lon, sensor_height_m: 2 },
      makeFetch() as unknown as FetchLike
    );
    expect(result.status).toBe(201);
    const meta = insertedMetadata(calls);
    expect(meta).not.toHaveProperty('elevation_m');
    expect(meta).not.toHaveProperty('elevation_source');
    expect(result.body.elevation).toEqual({ elevationMeters: null, source: null, unavailableReason: reason });
  });

  it('a hung DEM request times out → no elevation (does not hang registration)', async () => {
    const never = jest.fn(() => new Promise(() => {})) as unknown as FetchLike;
    const res = await resolveStationElevation(never, STEVEN.lat, STEVEN.lon, null, 2, 20);
    expect(res).toEqual({ elevationM: null, source: null, unavailableReason: 'dem_timeout' });
  });

  it('lookupDemElevation parses the live string form', async () => {
    const res = await lookupDemElevation(demFetch(STEVEN.demM) as unknown as FetchLike, STEVEN.lat, STEVEN.lon);
    expect(res).toEqual({ groundElevationM: 240.509017944 });
  });
});

describe('core4#3285 elevation reaches its consumers', () => {
  function credentialPool(metadata: unknown): QueryablePool {
    const enc = encryptData('api-key', ENC_KEY);
    return {
      query: jest.fn(async () => ({
        rows: [
          {
            station_id: 'PWS-X',
            provider: 'ambient',
            encrypted_api_key: enc.encrypted,
            key_iv: enc.iv,
            key_tag: enc.tag,
            encrypted_app_key: null,
            app_iv: null,
            app_tag: null,
            owner_address: OWNER,
            latitude: EXAMPLE.lat,
            longitude: EXAMPLE.lon,
            metadata,
          },
        ],
      })),
    };
  }

  it('collector roster carries elevation_m (the roster contract field) when registered', async () => {
    const rows = await listStationCredentials(credentialPool({ elevation_m: 227.7 }), ENC_KEY);
    expect(rows[0].elevation_m).toBe(227.7);
  });

  it('collector roster parses string JSON metadata too', async () => {
    const rows = await listStationCredentials(credentialPool(JSON.stringify({ elevation_m: 242.51 })), ENC_KEY);
    expect(rows[0].elevation_m).toBe(242.51);
  });

  it.each([[null], [{}], [{ elevation_m: 'x' }], ['not json']])(
    'collector roster OMITS elevation_m when none is registered (%p) — no default',
    async (metadata) => {
      const rows = await listStationCredentials(credentialPool(metadata), ENC_KEY);
      expect(rows[0]).not.toHaveProperty('elevation_m');
    }
  );
});

describe('core4#3285 reference shadow scorer — pressure kind decides the pairing', () => {
  function scorerFor(metadata: unknown) {
    const scoreObservation = jest.fn(async () => ({
      tier: 'good' as const,
      bandsVersion: 1,
      residuals: [],
      perSource: [],
      worst: null,
      worstRatio: null,
    }));
    const db = {
      execute: jest.fn(async (sql: string) =>
        sql.includes('FROM weather_stations')
          ? { rows: [{ latitude: EXAMPLE.lat, longitude: EXAMPLE.lon, metadata }] }
          : { rows: [] }
      ),
    };
    const scorer = new ReferenceShadowScorer(db, { scoreObservation } as unknown as ReferenceVerifierClient);
    return { scorer, scoreObservation };
  }

  async function sentFor(metadata: unknown, pressureHpa: number) {
    const { scorer, scoreObservation } = scorerFor(metadata);
    await scorer.scoreReveal({
      commitmentId: 1,
      stationId: 'PWS-X',
      observedAtUnix: 1_790_000_000,
      reading: { temperature_c: 10, humidity_pct: 50, pressure_hpa: pressureHpa, wind_mps: 1, rainfall_mm: 0 },
    });
    expect(scoreObservation).toHaveBeenCalledTimes(1);
    return (scoreObservation.mock.calls[0] as unknown[])[0] as {
      elevationM?: number;
      observation: Record<string, number>;
    };
  }

  it('ABSOLUTE station (Example Station): registered elevation is forwarded, raw station pressure is compared', async () => {
    const { calls } = await register(
      { latitude: EXAMPLE.lat, longitude: EXAMPLE.lon, elevation_meters: EXAMPLE.elevationM, pressure_kind: 'absolute' },
      demFetch(EXAMPLE.demM) as unknown as FetchLike
    );
    const sent = await sentFor(insertedMetadata(calls), 1001.2);
    // oracle-reference reduces model MSLP to 227.7 m: station vs station.
    expect(sent.elevationM).toBe(227.7);
    expect(sent.observation.pressure_hpa).toBe(1001.2);
  });

  it('RELATIVE station (Steven): elevation is NOT forwarded, so his sea-level value meets sea-level MSLP', async () => {
    const { calls } = await register(
      { latitude: STEVEN.lat, longitude: STEVEN.lon, sensor_height_m: 2, pressure_kind: 'relative' },
      demFetch(STEVEN.demM) as unknown as FetchLike
    );
    const metadata = insertedMetadata(calls);
    expect(metadata.elevation_m).toBe(242.51); // still registered (the attester's recompute needs it)
    const sent = await sentFor(metadata, 1020.4);
    // Forwarding 242.51 m would reduce the reference by ~29 hPa: a false +29 hPa residual.
    expect(sent.elevationM).toBeUndefined();
    expect(sent.observation.pressure_hpa).toBe(1020.4);
  });

  it.each([
    ['absolute with NO registered elevation (DEM failed, no override)', { pressure_kind: 'absolute' }],
    ['absolute with a nulled elevation (relocated)', { pressure_kind: 'absolute', elevation_m: null }],
    ['no pressure_kind', { elevation_m: 242.51 }],
    ['unrecognised pressure_kind', { elevation_m: 242.51, pressure_kind: 'sea_level' }],
    ['no metadata at all', null],
  ])('no trustworthy comparand (%s): pressure residual is skipped, no elevation sent, other variables still scored', async (_l, metadata) => {
    const sent = await sentFor(metadata, 1020.4);
    expect(sent.elevationM).toBeUndefined();
    expect(sent.observation).not.toHaveProperty('pressure_hpa');
    expect(sent.observation).toEqual({
      temperature_c: 10,
      humidity_pct: 50,
      wind_speed_ms: 1,
      rainfall_mm: 0,
    });
  });

  it('string JSON metadata is read the same way', async () => {
    const sent = await sentFor(JSON.stringify({ elevation_m: 227.7, pressure_kind: 'absolute' }), 1001.2);
    expect(sent.elevationM).toBe(227.7);
  });
});

describe('core4#3285 pressure_kind input', () => {
  it.each([['absolute'], ['relative']])('%s is stored in metadata and echoed', async (kind) => {
    const { result, calls } = await register(
      { latitude: STEVEN.lat, longitude: STEVEN.lon, pressureKind: kind },
      demFetch(STEVEN.demM) as unknown as FetchLike
    );
    expect(result.status).toBe(201);
    expect(insertedMetadata(calls).pressure_kind).toBe(kind);
    expect(result.body.pressureKind).toBe(kind);
  });

  it('omitted or empty → not stored (unknown)', async () => {
    for (const input of [{}, { pressure_kind: '' }, { pressure_kind: '  ' }]) {
      const { result, calls } = await register(
        { latitude: STEVEN.lat, longitude: STEVEN.lon, ...input },
        demFetch(STEVEN.demM) as unknown as FetchLike
      );
      expect(result.status).toBe(201);
      expect(insertedMetadata(calls)).not.toHaveProperty('pressure_kind');
    }
  });

  it.each([['Absolute'], ['sea_level'], [1]])('invalid %p → 400 INVALID_PRESSURE_KIND, no writes', async (bad) => {
    const { result, calls } = await register(
      { latitude: STEVEN.lat, longitude: STEVEN.lon, pressure_kind: bad },
      demFetch(STEVEN.demM) as unknown as FetchLike
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('INVALID_PRESSURE_KIND');
    expect(calls).toHaveLength(0);
  });
});

describe('core4#3285 empty-string override means "not provided"', () => {
  it.each([[''], ['   ']])('elevation_meters %p → DEM path runs (not 0, not a 400)', async (empty) => {
    const fetchFn = demFetch(STEVEN.demM);
    const { result, calls } = await register(
      { latitude: STEVEN.lat, longitude: STEVEN.lon, elevation_meters: empty, sensor_height_m: '' },
      fetchFn as unknown as FetchLike
    );
    expect(result.status).toBe(201);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const meta = insertedMetadata(calls);
    expect(meta.elevation_m).toBe(240.51);
    expect(meta.elevation_source).toBe('usgs_epqs_dem');
    expect(meta.sensor_height_m).toBe(0);
  });

  it('an explicit 0 override is still honoured (0 is provided, not empty)', async () => {
    const fetchFn = demFetch(STEVEN.demM);
    const { calls } = await register(
      { latitude: STEVEN.lat, longitude: STEVEN.lon, elevation_meters: 0 },
      fetchFn as unknown as FetchLike
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(insertedMetadata(calls).elevation_m).toBe(0);
  });
});

describe('core4#3285 DEM timeout aborts the request', () => {
  it('the fetch receives an AbortSignal that is aborted when the timeout fires', async () => {
    let seen: AbortSignal | undefined;
    const hung = jest.fn((_url: string, init?: { signal?: AbortSignal }) => {
      seen = init?.signal;
      return new Promise(() => {});
    }) as unknown as FetchLike;
    const res = await lookupDemElevation(hung, STEVEN.lat, STEVEN.lon, 20);
    expect(res).toEqual({ groundElevationM: null, reason: 'dem_timeout' });
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(true);
  });

  it('a fetch that honours the signal (rejects with AbortError) is also reported as dem_timeout', async () => {
    const honouring = jest.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    ) as unknown as FetchLike;
    const res = await lookupDemElevation(honouring, STEVEN.lat, STEVEN.lon, 20);
    expect(res.reason).toBe('dem_timeout');
  });

  it('a successful lookup leaves the signal un-aborted', async () => {
    const fetchFn = demFetch(STEVEN.demM);
    await lookupDemElevation(fetchFn as unknown as FetchLike, STEVEN.lat, STEVEN.lon);
    const init = fetchFn.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal?.aborted).toBe(false);
  });
});

describe('core4#3285 re-registration MERGES metadata (no silent loss of the #161 root)', () => {
  const ROOT = 'ab'.repeat(32);

  /**
   * Pool that models the weather_stations upsert with Postgres jsonb `||`
   * semantics (shallow merge, right-hand keys win), so a re-registration
   * runs against the row the first registration wrote.
   */
  function statefulPool() {
    const rows = new Map<
      string,
      { owner_address: string; latitude: number; longitude: number; metadata: Record<string, unknown> }
    >();
    const upserts: string[] = [];
    const pool: QueryablePool = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ n: rows.size }] };
        if (sql.includes('SELECT owner_address FROM weather_stations')) {
          const row = rows.get(String(params[0]));
          return { rows: row ? [{ owner_address: row.owner_address }] : [] };
        }
        if (sql.includes("metadata->>'hardwarePubkey'")) {
          for (const [id, row] of rows) {
            if (row.metadata.hardwarePubkey === params[0]) return { rows: [{ station_id: id }] };
          }
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO weather_stations')) {
          upserts.push(sql);
          const id = String(params[0]);
          const incoming = JSON.parse(String(params[7]));
          const existing = rows.get(id);
          const latitude = Number(params[3]);
          const longitude = Number(params[4]);
          // Models METADATA_UPSERT_SQL with jsonb `||` semantics; the real
          // statement is exercised against Postgres in the PR's probe.
          const merges = sql.includes("COALESCE(weather_stations.metadata, '{}'::jsonb) || EXCLUDED.metadata");
          let metadata = incoming;
          if (existing && merges) {
            const moved = existing.latitude !== latitude || existing.longitude !== longitude;
            const nulled =
              sqlNullsOnRelocation(sql) && moved && !('elevation_m' in incoming)
                ? { elevation_m: null, elevation_source: null, dem_ground_elevation_m: null, sensor_height_m: null }
                : {};
            metadata = { ...existing.metadata, ...nulled, ...incoming };
          }
          rows.set(id, { owner_address: String(params[1]), latitude, longitude, metadata });
        }
        return { rows: [] };
      }),
    };
    return { pool, rows, upserts };
  }

  it('hardwarePubkey, mac and hardware survive a re-registration that omits them; new keys win', async () => {
    const { pool, rows, upserts } = statefulPool();
    const dem = demFetch(STEVEN.demM);
    const fetchFn: FetchLike = async (url, init) => url.includes('ambientweather.net')
      ? { ok: true, status: 200, json: async () => [{ macAddress: 'AA:BB:CC:DD:EE:FF' }] }
      : dem(url, init);
    const deps = { pool, fetchFn, encryptionKey: ENC_KEY };

    const first = await registerStation(
      {
        name: 'Example private station',
        stationId: 'PWS-EXAMPLE-PRIVATE-01',
        latitude: STEVEN.lat,
        longitude: STEVEN.lon,
        mac: 'AA:BB:CC:DD:EE:FF',
        ambientApiKey: 'test-account-key',
        hardware: 'WS-2902D',
        hardwarePubkey: ROOT,
      },
      OWNER,
      deps,
      fixedRandomHex
    );
    expect(first.status).toBe(201);
    expect(rows.get('PWS-EXAMPLE-PRIVATE-01')?.metadata.hardwarePubkey).toBe(ROOT);

    // The runbook's re-registration: adds the pressure kind and a sensor
    // height, and omits the root / mac / hardware.
    const again = await registerStation(
      {
        name: 'Example private station',
        stationId: 'PWS-EXAMPLE-PRIVATE-01',
        latitude: STEVEN.lat,
        longitude: STEVEN.lon,
        sensor_height_m: 2,
        pressure_kind: 'relative',
      },
      OWNER,
      deps,
      fixedRandomHex
    );
    expect(again.status).toBe(201);
    expect(upserts[1]).toContain(`metadata = ${METADATA_UPSERT_SQL}`);
    expect(METADATA_UPSERT_SQL).toContain("COALESCE(weather_stations.metadata, '{}'::jsonb) || EXCLUDED.metadata");

    const meta = rows.get('PWS-EXAMPLE-PRIVATE-01')!.metadata;
    expect(meta.hardwarePubkey).toBe(ROOT);
    expect(meta.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(meta.hardware).toBe('WS-2902D');
    expect(meta.pressure_kind).toBe('relative');
    expect(meta.elevation_m).toBe(242.51); // new value won over the first (240.51)
    expect(meta.sensor_height_m).toBe(2);
  });

  it('switching DEM → operator override clears the stale DEM keys (written as null together)', async () => {
    const { pool, rows } = statefulPool();
    const base = { name: 'Example Station', stationId: 'PWS-EXAMPLE-WS5000', latitude: EXAMPLE.lat, longitude: EXAMPLE.lon };
    await registerStation(base, OWNER, { pool, fetchFn: demFetch(EXAMPLE.demM) as unknown as FetchLike, encryptionKey: ENC_KEY }, fixedRandomHex);
    expect(rows.get('PWS-EXAMPLE-WS5000')!.metadata.dem_ground_elevation_m).toBe(247.9);

    await registerStation(
      { ...base, elevation_meters: EXAMPLE.elevationM },
      OWNER,
      { pool, fetchFn: demFetch(EXAMPLE.demM) as unknown as FetchLike, encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    const meta = rows.get('PWS-EXAMPLE-WS5000')!.metadata;
    expect(meta.elevation_m).toBe(227.7);
    expect(meta.elevation_source).toBe('operator_override');
    expect(meta.dem_ground_elevation_m).toBeNull();
    expect(meta.sensor_height_m).toBeNull();
  });

  it('a first registration without mac/hardware does not write null placeholders', async () => {
    const { calls } = await register({ latitude: STEVEN.lat, longitude: STEVEN.lon }, demFetch(STEVEN.demM) as unknown as FetchLike);
    const meta = insertedMetadata(calls);
    expect(meta).not.toHaveProperty('mac');
    expect(meta).not.toHaveProperty('hardware');
    expect(meta.provider).toBe('ambient');
  });
});

describe('core4#3285 relocation never carries the old site elevation', () => {
  const failingDem = (() =>
    jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    })) as () => jest.Mock;

  function statefulPool() {
    const rows = new Map<string, { latitude: number; longitude: number; metadata: Record<string, unknown> }>();
    const pool: QueryablePool = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
        if (sql.includes('SELECT owner_address FROM weather_stations')) {
          return { rows: rows.has(String(params[0])) ? [{ owner_address: OWNER }] : [] };
        }
        if (sql.includes('INSERT INTO weather_stations')) {
          const id = String(params[0]);
          const incoming = JSON.parse(String(params[7]));
          const latitude = Number(params[3]);
          const longitude = Number(params[4]);
          const existing = rows.get(id);
          let metadata = incoming;
          if (existing) {
            const moved = existing.latitude !== latitude || existing.longitude !== longitude;
            metadata = {
              ...existing.metadata,
              ...(sqlNullsOnRelocation(sql) && moved && !('elevation_m' in incoming)
                ? { elevation_m: null, elevation_source: null, dem_ground_elevation_m: null, sensor_height_m: null }
                : {}),
              ...incoming,
            };
          }
          rows.set(id, { latitude, longitude, metadata });
        }
        return { rows: [] };
      }),
    };
    return { pool, rows };
  }

  const EXAMPLE_ROW = { name: 'Example Station', stationId: 'PWS-EXAMPLE-WS5000', pressure_kind: 'absolute' };

  async function seedExample(pool: QueryablePool) {
    const r = await registerStation(
      { ...EXAMPLE_ROW, latitude: EXAMPLE.lat, longitude: EXAMPLE.lon, elevation_meters: EXAMPLE.elevationM },
      OWNER,
      { pool, fetchFn: demFetch(EXAMPLE.demM) as unknown as FetchLike, encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(r.status).toBe(201);
  }

  it('moved + DEM down + no override → elevation keys written as null; roster and scorer see no elevation', async () => {
    const { pool, rows } = statefulPool();
    await seedExample(pool);
    expect(rows.get('PWS-EXAMPLE-WS5000')!.metadata.elevation_m).toBe(227.7);

    const moved = await registerStation(
      { ...EXAMPLE_ROW, latitude: 44.0, longitude: -93.0 },
      OWNER,
      { pool, fetchFn: failingDem() as unknown as FetchLike, encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(moved.status).toBe(201);
    expect((moved.body.elevation as Record<string, unknown>).elevationMeters).toBeNull();

    const meta = rows.get('PWS-EXAMPLE-WS5000')!.metadata;
    expect(meta.elevation_m).toBeNull();
    expect(meta.elevation_source).toBeNull();
    expect(meta.dem_ground_elevation_m).toBeNull();
    expect(meta.sensor_height_m).toBeNull();
    expect(meta.pressure_kind).toBe('absolute'); // non-site keys still merge

    // Roster: no elevation_m. Scorer: absolute without elevation → pressure skipped.
    const enc = encryptData('k', ENC_KEY);
    const roster = await listStationCredentials(
      {
        query: jest.fn(async () => ({
          rows: [
            {
              station_id: 'PWS-EXAMPLE-WS5000', provider: 'ambient',
              encrypted_api_key: enc.encrypted, key_iv: enc.iv, key_tag: enc.tag,
              encrypted_app_key: null, app_iv: null, app_tag: null,
              owner_address: OWNER, latitude: 44.0, longitude: -93.0, metadata: meta,
            },
          ],
        })),
      },
      ENC_KEY
    );
    expect(roster[0]).not.toHaveProperty('elevation_m');
    expect(referencePressurePlan(meta)).toEqual({ includePressure: false, elevationM: undefined });
  });

  it('same site + DEM down → the stored (real) elevation is kept', async () => {
    const { pool, rows } = statefulPool();
    await seedExample(pool);
    await registerStation(
      { ...EXAMPLE_ROW, latitude: EXAMPLE.lat, longitude: EXAMPLE.lon },
      OWNER,
      { pool, fetchFn: failingDem() as unknown as FetchLike, encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    expect(rows.get('PWS-EXAMPLE-WS5000')!.metadata.elevation_m).toBe(227.7);
  });

  it('moved + DEM up → the NEW site elevation is written', async () => {
    const { pool, rows } = statefulPool();
    await seedExample(pool);
    await registerStation(
      { ...EXAMPLE_ROW, latitude: STEVEN.lat, longitude: STEVEN.lon },
      OWNER,
      { pool, fetchFn: demFetch(STEVEN.demM) as unknown as FetchLike, encryptionKey: ENC_KEY },
      fixedRandomHex
    );
    const meta = rows.get('PWS-EXAMPLE-WS5000')!.metadata;
    expect(meta.elevation_m).toBe(240.51);
    expect(meta.elevation_source).toBe('usgs_epqs_dem');
  });

  it('the upsert statement carries the relocation clause', () => {
    expect(METADATA_UPSERT_SQL).toMatch(/weather_stations\.latitude IS DISTINCT FROM EXCLUDED\.latitude/);
    expect(METADATA_UPSERT_SQL).toMatch(/NOT \(EXCLUDED\.metadata \? 'elevation_m'\)/);
  });
});
