/**
 * Error-path and edge-case tests for the weather ingestion pipeline.
 *
 * Targets server/services/weather-ingestion-service.ts which had zero coverage.
 * Covers: schema validation failures, duplicate/conflict handling,
 * idempotency replay, and persistence-failure rollback.
 *
 * Closes #369
 */

jest.mock('../shared/route-durable-store.js', () => ({
  routeDurableStore: {
    write: jest.fn(),
    getIdempotency: jest.fn(),
    putIdempotency: jest.fn(),
  },
  newDurableId: jest.fn(),
  resolveIdempotencyKey: jest.fn(),
}));

jest.mock('../shared/weather-payload-canonical.js', () => ({
  canonicalizeWeatherPayloadForApi: jest.fn(),
}));

jest.mock('../server/utils/metrics.js', () => ({
  recordWeatherPayloadFormatMetric: jest.fn(),
}));

jest.mock('../server/services/weather-submission-persistence.js', () => ({
  persistWeatherSubmission: jest.fn(),
}));

import { routeDurableStore, newDurableId, resolveIdempotencyKey } from '../shared/route-durable-store.js';
import { canonicalizeWeatherPayloadForApi } from '../shared/weather-payload-canonical.js';
import { persistWeatherSubmission } from '../server/services/weather-submission-persistence.js';
import { ingestWeatherPayload, weatherDataSchema } from '../server/services/weather-ingestion-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCanonical(stationId: string, timestamp: string, measurements: Record<string, number | undefined> = { temperature: 21.5 }) {
  return {
    canonicalPayload: {
      schema_version: 'wrf.weather.observation.v1' as const,
      station_id: stationId,
      observed_at_unix: 1_700_000_000,
      observation: { temperature_c: measurements.temperature ?? null },
    },
    normalizedLegacyRecord: {
      stationId,
      timestamp,
      ...measurements,
    },
    telemetry: undefined,
  };
}

const STATION  = 'stn-test01';
const TS       = '2024-01-15T12:00:00Z';
const ROUTE    = '/api/weather/submit';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let storeRecords: Record<string, Record<string, unknown>>;

beforeEach(() => {
  jest.clearAllMocks();

  storeRecords = {};

  (routeDurableStore.write as jest.Mock).mockImplementation(async (fn: Function) => {
    return fn({ weather: { records: storeRecords } });
  });
  (routeDurableStore.getIdempotency as jest.Mock).mockResolvedValue(null);
  (routeDurableStore.putIdempotency as jest.Mock).mockResolvedValue(undefined);
  (newDurableId as jest.Mock).mockReturnValue('id-001');
  (resolveIdempotencyKey as jest.Mock).mockImplementation((k: unknown) =>
    typeof k === 'string' ? k : null,
  );

  (canonicalizeWeatherPayloadForApi as jest.Mock).mockImplementation((payload: unknown) => {
    const p = payload as Record<string, unknown>;
    return makeCanonical(
      String(p.stationId ?? p.station_id ?? ''),
      String(p.timestamp ?? ''),
      { temperature: typeof p.temperature === 'number' ? p.temperature : 21.5 },
    );
  });

  (persistWeatherSubmission as jest.Mock).mockResolvedValue({
    id: 'persisted-001',
    stationId: STATION,
    timestamp: TS,
    storedAt: new Date().toISOString(),
    source: 'mock',
  });
});

// ---------------------------------------------------------------------------
// weatherDataSchema unit tests
// ---------------------------------------------------------------------------

describe('weatherDataSchema', () => {
  it('accepts a valid minimal payload (temperature only)', () => {
    expect(() =>
      weatherDataSchema.parse({ stationId: STATION, timestamp: TS, temperature: 20 }),
    ).not.toThrow();
  });

  it('rejects empty payload — missing stationId and timestamp', () => {
    expect(() => weatherDataSchema.parse({})).toThrow();
  });

  it('rejects payload with stationId but no measurements', () => {
    expect(() =>
      weatherDataSchema.parse({ stationId: STATION, timestamp: TS }),
    ).toThrow(/at least one weather measurement/i);
  });

  it('rejects stationId containing spaces', () => {
    expect(() =>
      weatherDataSchema.parse({ stationId: 'bad station', timestamp: TS, temperature: 20 }),
    ).toThrow();
  });

  it('rejects stationId with special characters (slash)', () => {
    expect(() =>
      weatherDataSchema.parse({ stationId: 'stn/x', timestamp: TS, temperature: 20 }),
    ).toThrow();
  });

  it('rejects stationId longer than 64 characters', () => {
    const longId = 'a'.repeat(65);
    expect(() =>
      weatherDataSchema.parse({ stationId: longId, timestamp: TS, temperature: 20 }),
    ).toThrow();
  });

  it('accepts stationId exactly 64 characters long', () => {
    const maxId = 'a'.repeat(64);
    expect(() =>
      weatherDataSchema.parse({ stationId: maxId, timestamp: TS, temperature: 20 }),
    ).not.toThrow();
  });

  it('rejects empty stationId', () => {
    expect(() =>
      weatherDataSchema.parse({ stationId: '', timestamp: TS, temperature: 20 }),
    ).toThrow();
  });

  it('accepts payload with only humidity (no temperature)', () => {
    expect(() =>
      weatherDataSchema.parse({ stationId: STATION, timestamp: TS, humidity: 60 }),
    ).not.toThrow();
  });

  it('accepts payload with only pressure', () => {
    expect(() =>
      weatherDataSchema.parse({ stationId: STATION, timestamp: TS, pressure: 1013 }),
    ).not.toThrow();
  });

  it('accepts humidity above 100 (range enforced by physics layer, not schema)', () => {
    // NOTE: the ingestion Zod schema is deliberately permissive on humidity range —
    // physics validation (validatePhysics) is the range-enforcement layer.
    expect(() =>
      weatherDataSchema.parse({ stationId: STATION, timestamp: TS, humidity: 101 }),
    ).not.toThrow();
  });

  it('accepts negative windSpeed (range enforced by physics layer, not schema)', () => {
    expect(() =>
      weatherDataSchema.parse({ stationId: STATION, timestamp: TS, windSpeed: -5 }),
    ).not.toThrow();
  });

  it('rejects payload where timestamp is missing', () => {
    expect(() =>
      weatherDataSchema.parse({ stationId: STATION, temperature: 20 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ingestWeatherPayload — happy path
// ---------------------------------------------------------------------------

describe('ingestWeatherPayload — happy path', () => {
  it('returns status 201 and an id for a fresh submission', async () => {
    const result = await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
    });

    expect(result.status).toBe(201);
    expect(result.body.success).toBe(true);
    expect(result.body.id).toBe('id-001');
    expect(result.body.persistence).toBeDefined();
  });

  it('stores the record in durable state', async () => {
    await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
    });

    expect(storeRecords['id-001']).toBeDefined();
    expect(storeRecords['id-001'].stationId).toBe(STATION);
  });

  it('calls persistWeatherSubmission with correct station data', async () => {
    await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 22 },
    });

    expect(persistWeatherSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: STATION, timestamp: TS }),
    );
  });
});

// ---------------------------------------------------------------------------
// ingestWeatherPayload — schema validation failures
// ---------------------------------------------------------------------------

describe('ingestWeatherPayload — schema validation failures', () => {
  it('throws ZodError when canonicalized record has no stationId', async () => {
    (canonicalizeWeatherPayloadForApi as jest.Mock).mockReturnValue({
      canonicalPayload: { schema_version: 'wrf.weather.observation.v1' as const, observation: {} },
      normalizedLegacyRecord: { timestamp: TS, temperature: 20 }, // missing stationId
      telemetry: undefined,
    });

    await expect(
      ingestWeatherPayload({ route: ROUTE, payload: {} }),
    ).rejects.toThrow();
  });

  it('throws ZodError when no measurement fields are present', async () => {
    (canonicalizeWeatherPayloadForApi as jest.Mock).mockReturnValue({
      canonicalPayload: { schema_version: 'wrf.weather.observation.v1' as const, observation: {} },
      normalizedLegacyRecord: { stationId: STATION, timestamp: TS }, // no measurements
      telemetry: undefined,
    });

    await expect(
      ingestWeatherPayload({ route: ROUTE, payload: {} }),
    ).rejects.toThrow(/at least one weather measurement/i);
  });

  it('throws ZodError for stationId with invalid characters', async () => {
    (canonicalizeWeatherPayloadForApi as jest.Mock).mockReturnValue(
      makeCanonical('bad station id!', TS, { temperature: 20 }),
    );

    await expect(
      ingestWeatherPayload({ route: ROUTE, payload: {} }),
    ).rejects.toThrow();
  });

  it('throws ZodError for oversized stationId (65 chars)', async () => {
    (canonicalizeWeatherPayloadForApi as jest.Mock).mockReturnValue(
      makeCanonical('a'.repeat(65), TS, { temperature: 20 }),
    );

    await expect(
      ingestWeatherPayload({ route: ROUTE, payload: {} }),
    ).rejects.toThrow();
  });

  it('does not call routeDurableStore.write when schema validation fails', async () => {
    (canonicalizeWeatherPayloadForApi as jest.Mock).mockReturnValue({
      canonicalPayload: { schema_version: 'wrf.weather.observation.v1' as const, observation: {} },
      normalizedLegacyRecord: { stationId: STATION, timestamp: TS }, // no measurements
      telemetry: undefined,
    });

    await expect(
      ingestWeatherPayload({ route: ROUTE, payload: {} }),
    ).rejects.toThrow();

    expect(routeDurableStore.write).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ingestWeatherPayload — duplicate handling
// ---------------------------------------------------------------------------

describe('ingestWeatherPayload — duplicate detection', () => {
  beforeEach(async () => {
    // Seed a record so the second call finds a duplicate
    await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
    });
  });

  it('returns status 200 with duplicate:true for identical re-submission', async () => {
    const result = await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
    });

    expect(result.status).toBe(200);
    expect(result.body.duplicate).toBe(true);
  });

  it('does not call persistWeatherSubmission for a duplicate', async () => {
    (persistWeatherSubmission as jest.Mock).mockClear();

    await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
    });

    expect(persistWeatherSubmission).not.toHaveBeenCalled();
  });

  it('returns status 409 for conflicting payload (same station+timestamp, different temperature)', async () => {
    (canonicalizeWeatherPayloadForApi as jest.Mock).mockReturnValue(
      makeCanonical(STATION, TS, { temperature: 99.9 }), // different from seeded 21.5
    );

    const result = await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 99.9 },
    });

    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/conflicting/i);
    expect(result.body.existingDataId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ingestWeatherPayload — idempotency
// ---------------------------------------------------------------------------

describe('ingestWeatherPayload — idempotency replay', () => {
  it('replays cached response with replayed:true when idempotency key matches', async () => {
    const cachedBody = { success: true, id: 'cached-id', weatherData: { stationId: STATION } };
    (routeDurableStore.getIdempotency as jest.Mock).mockResolvedValue({
      status: 201,
      responseBody: cachedBody,
    });

    const result = await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
      idempotencyKey: 'my-idem-key',
    });

    expect(result.status).toBe(201);
    expect(result.body.replayed).toBe(true);
  });

  it('does not hit durable store write on idempotency replay', async () => {
    (routeDurableStore.getIdempotency as jest.Mock).mockResolvedValue({
      status: 200,
      responseBody: { success: true, id: 'old-id' },
    });

    await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
      idempotencyKey: 'replay-key',
    });

    expect(routeDurableStore.write).not.toHaveBeenCalled();
  });

  it('stores response in idempotency cache after fresh successful submission', async () => {
    await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
      idempotencyKey: 'fresh-idem-key',
    });

    expect(routeDurableStore.putIdempotency).toHaveBeenCalledWith(
      'weather:data:create',
      'fresh-idem-key',
      201,
      expect.any(Object),
    );
  });

  it('does not call putIdempotency when no idempotency key is provided', async () => {
    await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
      // no idempotencyKey
    });

    expect(routeDurableStore.putIdempotency).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ingestWeatherPayload — persistence failure rollback
// ---------------------------------------------------------------------------

describe('ingestWeatherPayload — persistence failure rollback', () => {
  it('rethrows persistWeatherSubmission error', async () => {
    (persistWeatherSubmission as jest.Mock).mockRejectedValue(
      new Error('DB connection refused'),
    );

    await expect(
      ingestWeatherPayload({
        route: ROUTE,
        payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
      }),
    ).rejects.toThrow('DB connection refused');
  });

  it('removes the durable record from state on persistence failure', async () => {
    (persistWeatherSubmission as jest.Mock).mockRejectedValue(new Error('write failed'));

    try {
      await ingestWeatherPayload({
        route: ROUTE,
        payload: { stationId: STATION, timestamp: TS, temperature: 21.5 },
      });
    } catch {
      // expected
    }

    // Record created in first write, then deleted in rollback write
    expect(storeRecords['id-001']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ingestWeatherPayload — legacy format telemetry
// ---------------------------------------------------------------------------

describe('ingestWeatherPayload — legacy format telemetry', () => {
  it('records metric and does not fail when telemetry is present', async () => {
    const { recordWeatherPayloadFormatMetric } = jest.requireMock('../server/utils/metrics.js') as {
      recordWeatherPayloadFormatMetric: jest.Mock;
    };

    (canonicalizeWeatherPayloadForApi as jest.Mock).mockReturnValue({
      ...makeCanonical(STATION, TS, { temperature: 20 }),
      telemetry: {
        event: 'legacy-format-detected' as const,
        schemaVersion: 'wrf.weather.observation.v1' as const,
        source: 'legacy-flat' as const,
        legacyKeys: ['temp', 'hum'],
      },
    });

    const result = await ingestWeatherPayload({
      route: ROUTE,
      payload: { stationId: STATION, timestamp: TS, temperature: 20 },
    });

    expect(result.status).toBe(201);
    expect(recordWeatherPayloadFormatMetric).toHaveBeenCalledWith(
      ROUTE,
      expect.objectContaining({ event: 'legacy-format-detected' }),
    );
  });
});
