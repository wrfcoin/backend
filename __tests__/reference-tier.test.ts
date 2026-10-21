import { describe, expect, it } from '@jest/globals';
import vectors from '../shared/fixtures/reference_tier_vectors.json';
import { REFERENCE_BANDS_VERSION, tierReferenceResiduals } from '../shared/reference-tier.js';

describe('reference tier parity (#866)', () => {
  it('uses the same pinned bands version as core4 vectors', () => {
    expect(REFERENCE_BANDS_VERSION).toBe(3);
    expect(REFERENCE_BANDS_VERSION).toBe(vectors.bands_version);
  });

  for (const vector of vectors.vectors) {
    it(`matches core4 vector: ${vector.name}`, () => {
      expect(tierReferenceResiduals(vector.residuals)).toBe(vector.expected_tier);
    });
  }
});

// Both rule branches and activation truth tables are pinned to deployed core4.
import { foldVariableTiers, grossGuardActiveAt, variableTier, type ReferenceTier } from '../shared/reference-tier.js';

const foldCases: Array<[ReferenceTier[], ReferenceTier]> = [
  [[], 'good'], [['good'], 'good'], [['degraded'], 'degraded'], [['outlier'], 'outlier'],
  [['good','degraded'], 'degraded'], [['degraded','degraded'], 'degraded'],
  [['good','outlier'], 'degraded'], [['degraded','outlier'], 'degraded'], [['outlier','outlier'], 'outlier'],
  [['good','good','good'], 'good'], [['good','good','degraded'], 'good'],
  [['good','degraded','degraded'], 'degraded'], [['good','good','outlier'], 'degraded'],
  [['good','degraded','outlier'], 'degraded'], [['degraded','degraded','outlier'], 'degraded'],
  [['good','outlier','outlier'], 'outlier'], [['outlier','outlier','outlier'], 'outlier'],
  [['good','good','good','outlier'], 'degraded'], [['good','good','outlier','outlier'], 'outlier'],
];
it.each(foldCases)('folds %j to %s, preserving the old branch as a control', (tiers, expected) => {
  expect(foldVariableTiers(tiers)).toBe(expected);
  expect(foldVariableTiers([...tiers].reverse())).toBe(expected);
  const rank = {good:0,degraded:1,outlier:2};
  const worst = [...tiers].sort((a,b)=>rank[a]-rank[b]).pop() ?? 'good';
  expect(foldVariableTiers(tiers, 'worst')).toBe(worst);
});
it.each(vectors.vectors)('matches pre/post activation vector $name', vector => {
  for (const height of [99,100,101]) {
    const expected = height >= 100 && 'expected_tier_gross_guard' in vector
      ? vector.expected_tier_gross_guard : vector.expected_tier;
    expect(tierReferenceResiduals(vector.residuals, {height,grossGuardActivationHeight:100})).toBe(expected);
  }
});
it.each([NaN,Infinity,-Infinity])('a nonfinite residual is an outlier, not gross (%s)', residual => {
  expect(variableTier('nws_station','temperature_c',residual)).toBe('outlier');
  expect(tierReferenceResiduals([
    {source:'nws_station',variable:'temperature_c',residual},
    {source:'nws_station',variable:'humidity_pct',residual:1},
  ],{height:100,grossGuardActivationHeight:100})).toBe('degraded');
});
it('supports unscheduled/zero-height activation and rejects imprecise heights', () => {
  expect(grossGuardActiveAt({height:100,grossGuardActivationHeight:null})).toBe(false);
  expect(grossGuardActiveAt({height:0,grossGuardActivationHeight:0})).toBe(true);
  for(const height of [-1,1.5,NaN,Infinity,null as unknown as number,Number.MAX_SAFE_INTEGER+1]) {
    expect(()=>grossGuardActiveAt({height,grossGuardActivationHeight:0})).toThrow(/safe integers/);
  }
});
it('refuses an old fixture at module load', () => {
  jest.resetModules();
  jest.doMock('../shared/fixtures/reference_bands.json',()=>({version:1,sources:{}}));
  try { expect(()=>require('../shared/reference-tier.js')).toThrow(/version\/fold rule/); }
  finally { jest.dontMock('../shared/fixtures/reference_bands.json'); jest.resetModules(); }
});

it('skips unknown pairs including JavaScript prototype property names', () => {
  for(const [source,variable] of [['missing','temperature_c'],['__proto__','toString'],['constructor','name'],['hrrr','toString']]) {
    expect(variableTier(source,variable,999)).toBeNull();
    expect(tierReferenceResiduals([{source,variable,residual:999}])).toBe('good');
  }
});

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
it('pins reference_bands.json byte-for-byte to deployed core4 9ef92a235', () => {
  expect(createHash('sha256').update(readFileSync('shared/fixtures/reference_bands.json')).digest('hex')).toBe('87e09f04b5575aeba19140574fc7e702dd29e55a95bda5b8046f8a68cbce91f2');
});
it('pins reference_tier_vectors.json byte-for-byte to deployed core4 9ef92a235', () => {
  expect(createHash('sha256').update(readFileSync('shared/fixtures/reference_tier_vectors.json')).digest('hex')).toBe('44933eacace9c13162507b2c2eb6f67b034e6ac1cfdb114b36c53d92b3447572');
});

// backend#1270: core4#3285 `tier_under_with_unverified`. Golden cases were produced by core4
// 65134a64's own Rust (shared-protocol/src/weather/reference.rs, verbatim) through the harness in
// __tests__/fixtures/tier-unverified-golden (main.rs.txt); regenerate with generate.cjs.
import golden from './fixtures/tier-unverified-golden/golden.json';
describe('unverified variables count as Outlier (core4#3285), differential vs core4 Rust', () => {
  const cases = golden.cases as unknown as Array<[Array<[string, string, number | string]>, number, number, string]>;
  it('has a meaningful case mix', () => {
    expect(cases.length).toBeGreaterThan(5000);
    for (const tier of ['good', 'degraded', 'outlier']) expect(cases.filter(c => c[3] === tier).length).toBeGreaterThan(100);
    expect(cases.some(c => c[2] > 0 && c[1] === 1)).toBe(true);
  });
  it('matches core4 on every golden case (pre- and post-#3131 gross guard, 0..n unverified)', () => {
    const num = (v: number | string) => (typeof v === 'number' ? v : v === 'nan' || v === 'NaN' ? NaN : v === 'Infinity' || v === 'inf' ? Infinity : -Infinity);
    const mismatches: string[] = [];
    cases.forEach(([res, guard, unverified, expected], i) => {
      const residuals = res.map(([source, variable, residual]) => ({ source, variable, residual: num(residual) }));
      const context = guard ? { height: 100, grossGuardActivationHeight: 100 } : undefined;
      const got = tierReferenceResiduals(residuals, context, unverified);
      if (got !== expected) mismatches.push(`#${i}: got ${got}, core4 ${expected}`);
    });
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
  it('unverified = 0 is exactly the plain tier; a lone submitted-but-unverified variable is Outlier', () => {
    expect(tierReferenceResiduals([], undefined, 0)).toBe('good');
    expect(tierReferenceResiduals([], undefined, 1)).toBe('outlier');
    expect(tierReferenceResiduals([{ source: 'hrrr', variable: 'temperature_c', residual: 0.1 }], undefined, 1)).toBe('degraded');
    expect(tierReferenceResiduals([{ source: 'hrrr', variable: 'temperature_c', residual: 0.1 }], undefined, 2)).toBe('outlier');
  });
  it('rejects a negative or fractional unverified count', () => {
    for (const bad of [-1, 1.5, NaN]) expect(() => tierReferenceResiduals([], undefined, bad)).toThrow(/unverified/);
  });
});
