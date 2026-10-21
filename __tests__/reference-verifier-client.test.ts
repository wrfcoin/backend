import { ReferenceShadowScorer } from '../server/services/reference-shadow-scorer.js';
import { ReferenceVerifierClient } from '../server/services/reference-verifier-client.js';

function residualResponse(temperature: number, pressure: number) {
  const isFraud = Math.abs(temperature) > 5 || Math.abs(pressure) > 6;
  return {
    results: [
      {
        station_id: 'WX-REF-1',
        bands_version: 3,
        worst_ratio: isFraud ? 6.6667 : 0.2,
        worst: {
          source: 'hrrr',
          variable: isFraud ? 'pressure_hpa' : 'temperature_c',
          residual: isFraud ? pressure : temperature,
          band_ratio: isFraud ? 6.6667 : 0.2,
        },
        per_source: [
          {
            source: 'hrrr',
            residuals: {
              temperature_c: temperature,
              pressure_hpa: pressure,
            },
            band_ratios: {
              temperature_c: Math.abs(temperature) / 5,
              pressure_hpa: Math.abs(pressure) / 6,
            },
            reference: {
              temperature_c: 20,
              pressure_hpa: 1010,
            },
          },
          {
            source: 'hrrr_fx',
            residuals: {
              temperature_c: temperature + 0.5,
              pressure_hpa: pressure - 0.5,
            },
            band_ratios: {
              temperature_c: Math.abs(temperature + 0.5) / 6,
              pressure_hpa: Math.abs(pressure - 0.5) / 7,
            },
            reference: {
              temperature_c: 19.5,
              pressure_hpa: 1010.5,
            },
          },
        ],
      },
    ],
    service: { version: '0.2.0', bands_version: 3 },
  };
}

describe('ReferenceVerifierClient (#866)', () => {
  it('evaluates the submitted observation so the +8C/-40hPa fraud score moves', async () => {
    const fetchImpl = jest.fn(
      async (
        _url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const request = JSON.parse(String(init?.body));
        const observation = request.observations[0].observation;
        const bad = observation.temperature_c >= 28;
        return new globalThis.Response(
          JSON.stringify(
            bad ? residualResponse(8, -40) : residualResponse(0.5, -1),
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    ) as unknown as typeof fetch;
    const client = new ReferenceVerifierClient({
      baseUrl: 'http://oracle-reference:8010',
      fetchImpl,
    });

    const base = {
      stationId: 'WX-REF-1',
      lat: 46.8369,
      lon: -92.1833,
      observedAtUnix: 1785312000,
      observation: {
        temperature_c: 20,
        pressure_hpa: 1010,
        humidity_pct: 50,
        wind_speed_ms: 2,
        rainfall_mm: 0,
      },
    };

    const honest = await client.scoreObservation(base);
    const fraud = await client.scoreObservation({
      ...base,
      observation: {
        ...base.observation,
        temperature_c: 28,
        pressure_hpa: 970,
      },
    });

    expect(honest.tier).toBe('good');
    expect(fraud.tier).toBe('outlier');
    expect(fraud.worstRatio).toBeGreaterThan(honest.worstRatio ?? 0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects an oracle response using a different bands version', async () => {
    const body = residualResponse(0.5, -1);
    body.results[0].bands_version = 2;
    body.service.bands_version = 2;
    const client = new ReferenceVerifierClient({
      fetchImpl: jest.fn(
        async () =>
          new globalThis.Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ) as unknown as typeof fetch,
    });

    await expect(
      client.scoreObservation({
        stationId: 'WX-REF-1',
        lat: 46.8369,
        lon: -92.1833,
        observedAtUnix: 1785312000,
        observation: { temperature_c: 20 },
      }),
    ).rejects.toThrow('does not match pinned version 3');
  });

  // The malformed-envelope guard (`!Array.isArray(result.per_source)`) was
  // shipped untested. Without these two cases, deleting the guard leaves the
  // suite green while the caller silently accepts an incomplete oracle payload
  // — and the caller fails *open*, so an accepted-but-empty envelope becomes an
  // advisory score derived from nothing.
  it.each([
    ['results is empty', { results: [], service: { bands_version: 3 } }],
    [
      'per_source is absent',
      {
        results: [{ station_id: 'WX-REF-1', bands_version: 3 }],
        service: { bands_version: 3 },
      },
    ],
    [
      'per_source is not an array',
      {
        results: [
          { station_id: 'WX-REF-1', bands_version: 3, per_source: 'hrrr' },
        ],
        service: { bands_version: 3 },
      },
    ],
  ])('rejects a malformed residuals envelope when %s', async (_label, body) => {
    const client = new ReferenceVerifierClient({
      fetchImpl: jest.fn(
        async () =>
          new globalThis.Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ) as unknown as typeof fetch,
    });

    await expect(
      client.scoreObservation({
        stationId: 'WX-REF-1',
        lat: 46.8369,
        lon: -92.1833,
        observedAtUnix: 1785312000,
        observation: { temperature_c: 20 },
      }),
    ).rejects.toThrow('returned no result');
  });
});

describe('ReferenceShadowScorer persistence (#866)', () => {
  it('persists the advisory tier and fingerprint inputs without reward fields', async () => {
    const executeCalls: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
      execute: jest.fn(async (sql: string, params?: unknown[]) => {
        executeCalls.push({ sql, params });
        if (sql.includes('FROM weather_stations')) {
          return {
            rows: [
              {
                latitude: 46.8369,
                longitude: -92.1833,
                metadata: { elevation_m: 186 },
              },
            ],
          };
        }
        if (sql.includes('SELECT corr(')) {
          return { rows: [{ correlation: 0.75, sample_count: 2 }] };
        }
        return { rows: [] };
      }),
    };
    const client = new ReferenceVerifierClient({
      fetchImpl: jest.fn(
        async () =>
          new globalThis.Response(JSON.stringify(residualResponse(8, -40)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ) as unknown as typeof fetch,
    });
    const observe = jest.spyOn(client, 'scoreObservation');
    const scorer = new ReferenceShadowScorer(db, client);

    const result = await scorer.scoreReveal({
      commitmentId: 42,
      tieringContext: {height:100,grossGuardActivationHeight:100},
      stationId: 'WX-REF-1',
      observedAtUnix: 1785312000,
      reading: {
        temperature_c: 28,
        pressure_hpa: 970,
        humidity_pct: 50,
        wind_mps: 2,
        rainfall_mm: 0,
      },
    });

    expect(result).toEqual({ tier: 'outlier', bandsVersion: 3 });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({tieringContext:{height:100,grossGuardActivationHeight:100}}));
    const insert = executeCalls.find((call) =>
      call.sql.includes('INSERT INTO reference_scores'),
    );
    expect(insert?.params?.[0]).toBe(42);
    expect(insert?.params?.[2]).toBe('outlier');
    expect(insert?.sql).not.toMatch(/reward|mint/i);
  });
});

it.each([99,100,101])('selects deployed guard locally at height %s and sends the same oracle context', async height => {
  const fetchImpl = jest.fn(async()=>new Response(JSON.stringify({results:[{
    bands_version:3, tier:'good', worst_ratio:1.6667, worst:null,
    per_source:[{source:'nws_station',residuals:{temperature_c:10,humidity_pct:1},band_ratios:{},reference:{}}],
  }]}),{status:200}));
  const client = new ReferenceVerifierClient({fetchImpl:fetchImpl as typeof fetch});
  const score = await client.scoreObservation({stationId:'test',lat:0,lon:0,observedAtUnix:1,
    observation:{temperature_c:10,humidity_pct:1},tieringContext:{height,grossGuardActivationHeight:100}});
  expect(score.tier).toBe(height>=100?'outlier':'degraded');
  expect(score.foldRule).toBe('second_worst');
  expect(score.grossGuardActive).toBe(height>=100);
  expect(score.worstRatio).toBe(1.6667);
  const call = (fetchImpl.mock.calls as unknown as Array<[string,RequestInit]>)[0];
  expect(JSON.parse(String(call[1].body)).tiering_context).toEqual({height,gross_guard_activation_height:100});
});
