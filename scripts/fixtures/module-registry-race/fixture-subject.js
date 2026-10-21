/**
 * Fixture subject for scripts/detect-module-registry-race.mjs --self-test.
 *
 * The one thing that matters here is that `process.env.FLAG` is read in MODULE
 * TOP-LEVEL scope, so the value is snapshotted at require() time. That is what
 * conjunct C2 looks for; a lazy read inside `value()` would make the fixtures
 * order-independent and the self-test would then be asserting nothing.
 *
 * Not a test, and never loaded by the suite — jest's testMatch only picks up
 * *.test.ts / *.spec.ts.
 */
const FLAG = process.env.FLAG === 'true';

module.exports = { value: () => String(FLAG) };
