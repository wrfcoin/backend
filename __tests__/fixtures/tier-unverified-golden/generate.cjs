// Regenerates golden.json: node generate.cjs <path-to-built tier-diff binary>
// The binary is the harness in main.rs.txt built against core4 65134a64's
// shared-protocol/src/weather/{reference,quality_tier}.rs and fixtures/reference_bands.json (verbatim).
const { execFileSync } = require('child_process');
const fs = require('fs');
const bands = require('../../../shared/fixtures/reference_bands.json');
const vars = [];
for (const [s, m] of Object.entries(bands.sources)) for (const [v, b] of Object.entries(m)) vars.push({ s, v, b });
let seed = 20260930;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
// tier -> a residual for that band: 0 good, 1 degraded, 2 outlier (not gross), 3 gross (or just past marginal when no gross_max)
function residualFor(b, kind) {
  const sign = rnd() < 0.5 ? -1 : 1;
  if (kind === 0) return sign * b.good_max * rnd();
  if (kind === 1) return sign * (b.good_max + (b.marginal_max - b.good_max) * (0.05 + 0.9 * rnd()));
  if (kind === 2) return sign * (b.marginal_max * (1.001 + 0.2 * rnd()));
  return sign * ((b.gross_max ?? b.marginal_max * 2) * (1.01 + rnd()));
}
const cases = [];
const mk = (res, gross_guard, unverified) => ({ residuals: res, gross_guard, unverified });
const enc = (r) => (Number.isFinite(r.residual) ? r : { source: r.source, variable: r.variable, residual: null, nonfinite: Number.isNaN(r.residual) ? 'nan' : r.residual > 0 ? 'inf' : '-inf' });
// exhaustive over 0..4 scored variables x 4 kinds x unverified 0..3 x guard
const base = vars.filter((x) => x.s === 'hrrr').slice(0, 4);
function* combos(n) { const k = [0, 1, 2, 3]; const t = (i, acc) => (i === n ? [acc] : k.flatMap((x) => t(i + 1, [...acc, x]))); yield* t(0, []); }
for (let n = 0; n <= 4; n += 1) for (const kinds of combos(n)) for (const g of [false, true]) for (let u = 0; u <= 3; u += 1)
  cases.push(mk(kinds.map((kind, i) => ({ source: base[i].s, variable: base[i].v, residual: residualFor(base[i].b, kind) })), g, u));
// random over every source/variable, unknown pairs and non-finite residuals
for (let i = 0; i < 2500; i += 1) {
  const n = Math.floor(rnd() * 7);
  const res = [];
  for (let j = 0; j < n; j += 1) {
    const x = pick(vars);
    const r = rnd();
    if (r < 0.05) res.push({ source: 'nope', variable: x.v, residual: 99 });
    else if (r < 0.1) res.push({ source: x.s, variable: 'nope', residual: 99 });
    else if (r < 0.15) res.push({ source: x.s, variable: x.v, residual: pick([NaN, Infinity, -Infinity]) });
    else res.push({ source: x.s, variable: x.v, residual: residualFor(x.b, Math.floor(rnd() * 4)) });
  }
  cases.push(mk(res, rnd() < 0.5, rnd() < 0.6 ? 0 : 1 + Math.floor(rnd() * 2)));
}
const input = cases.map((c) => JSON.stringify({ ...c, residuals: c.residuals.map(enc) })).join('\n') + '\n';
const out = execFileSync(process.argv[2], { input, maxBuffer: 1 << 28 }).toString().trim().split('\n');
if (out.length !== cases.length) throw new Error('length mismatch');
const golden = cases.map((c, i) => [c.residuals.map((r) => [r.source, r.variable, Number.isFinite(r.residual) ? r.residual : String(r.residual)]), c.gross_guard ? 1 : 0, c.unverified, out[i]]);
fs.writeFileSync(__dirname + '/golden.json', JSON.stringify({ coreCommit: '65134a64', cases: golden }));
console.log(cases.length, 'cases', [...new Set(out)].join(','), Object.fromEntries(['good', 'degraded', 'outlier'].map((t) => [t, out.filter((x) => x === t).length])));
