/**
 * backend#1288: reveal 422 "Reveal payload does not match commit_hash" on long floats.
 *
 * core4 recomputes the commit id from serde_json::to_string of the PARSED reveal payload,
 * and serde_json (float_roundtrip OFF) does not round-trip 16-17 significant digit doubles
 * (a float32 pressure widened to f64). Every reading field is therefore quantized to 2 dp
 * before hashing and in the reveal body.
 *
 * Golden vectors: __tests__/fixtures/serde-float-golden/vectors.json, produced by the real
 * serde_json 1.0.149 (core4's lock) with the program beside it (main.rs): `raw` is the
 * JS-printed input, `rawRust` what core4 would re-print it as, `quantized*` the same after
 * the 2 dp rule. The mobile client must apply the identical rule.
 */
import { buildCanonicalReading, computeCommitId, quantize2dp } from '../shared/commit-reveal-hash';
import vectors from './fixtures/serde-float-golden/vectors.json';

type V = { raw: string; rawRust: string; quantized: string; quantizedRust: string };
const V = vectors as V[];
const longOnes = V.filter((v) => v.raw !== v.rawRust);

describe('serde_json float golden vectors', () => {
  it('the fixture contains real failing raw values (the bug is real)', () => {
    expect(longOnes.length).toBeGreaterThanOrEqual(10);
    expect(longOnes.map((v) => v.raw)).toContain('1008.2767333984375');
  });

  it.each(V.map((v) => [v.raw, v] as const))('quantize2dp(%s) prints as core4 re-prints it', (_l, v) => {
    const raw = v.raw === '-0' ? -0 : Number(v.raw);
    const q = quantize2dp(raw);
    expect(String(q)).toBe(v.quantized);
    // the quantized text survives core4's parse + re-print unchanged
    expect(v.quantizedRust).toBe(v.quantized);
    expect(Object.is(q, -0)).toBe(false);
  });

  it('buildCanonicalReading output is stable under core4 re-serialization for every field', () => {
    for (const v of longOnes) {
      const n = Number(v.raw);
      const c = buildCanonicalReading({
        temperature_c: n, humidity_percent: n, pressure_hpa: n, wind_speed_ms: n, precipitation_mm: n,
      } as any);
      for (const val of Object.values(c)) expect(String(val)).toBe(v.quantizedRust);
    }
  });

  it('the commit id is over the quantized payload (equals the id of the pre-quantized data)', () => {
    const base = { stationId: 's', nonce: 'n', timestamp: 1_790_000_000 };
    const c = buildCanonicalReading({
      temperature_c: 20.123456, humidity_percent: 50, pressure_hpa: 1008.2767333984375, wind_speed_ms: 0, precipitation_mm: 0,
    } as any);
    expect(c.pressure_hpa).toBe(1008.28);
    expect(computeCommitId({ ...base, data: c })).toBe(
      computeCommitId({ ...base, data: { ...c, temperature_c: 20.12, pressure_hpa: 1008.28 } })
    );
  });

  it('rounds half away from zero and normalises -0', () => {
    expect(quantize2dp(0.005)).toBe(0.01);
    expect(quantize2dp(-0.005)).toBe(-0.01);
    expect(quantize2dp(-0.001)).toBe(0);
    expect(Object.is(quantize2dp(-0.001), 0)).toBe(true);
    expect(quantize2dp(22.5)).toBe(22.5);
  });
});
