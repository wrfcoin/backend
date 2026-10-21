#!/usr/bin/env tsx
/**
 * Live-server integration smoke test — issue #791
 *
 * Hits the testnet-critical API paths against a running server and asserts:
 *  - Status is NOT 404 (route is mounted)
 *  - Status is NOT 500 (route is not crashing at the handler level)
 *
 * Expected statuses without auth: 401 or 400 (auth required, not 404).
 * commit/reveal return 400 (missing fields) when no body is sent.
 *
 * Gracefully skips all checks when the server is unreachable (ECONNREFUSED).
 *
 * Usage:
 *   BASE_URL=http://localhost:4001 npx tsx scripts/smoke-test-launch-paths.ts
 *
 * Exits 0 on pass or skip, 1 on failure.
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4001';

interface CheckResult {
  path: string;
  method: string;
  status: number | 'SKIP';
  ok: boolean;
  detail: string;
}

async function check(
  method: 'GET' | 'POST',
  urlPath: string,
  body?: Record<string, unknown>
): Promise<CheckResult> {
  const url = `${BASE_URL}${urlPath}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  let status: number;
  try {
    const res = await fetch(url, opts);
    status = res.status;
  } catch (err: unknown) {
    const isConnRefused =
      err instanceof Error &&
      (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed'));
    if (isConnRefused) {
      return { path: urlPath, method, status: 'SKIP', ok: true, detail: 'server unreachable — skipped' };
    }
    return { path: urlPath, method, status: 0, ok: false, detail: String(err) };
  }

  const is404 = status === 404;
  const is5xx = status >= 500;
  const ok = !is404 && !is5xx;
  const detail = is404
    ? 'FAIL: route returned 404 — likely missing from dist/ (regression #791)'
    : is5xx
    ? `WARN: server error ${status}`
    : `ok (${status})`;

  return { path: urlPath, method, status, ok, detail };
}

async function main() {
  console.log(`\nSmoke-testing launch-critical API paths against ${BASE_URL}\n`);

  const results: CheckResult[] = await Promise.all([
    // Oracle submit — needs auth → expect 401, not 404
    check('POST', '/api/oracle/submit-data', {}),

    // Weather routes — public health endpoint → 200; data → 401 without auth
    check('GET',  '/api/weather/health'),
    check('GET',  '/api/weather/stations'),
    check('GET',  '/api/weather/data/test-station'),

    // Wallet — needs auth → expect 401, not 404
    check('GET',  '/api/wallet/0xDeaDBeEf00000000000000000000000000000000'),

    // Earn loop — inline handlers in enhanced_unified_api_optimized.ts
    // Expect 400 (missing body fields) not 404
    check('POST', '/api/weather/commit',  {}),
    check('POST', '/api/weather/reveal',  {}),
  ]);

  let failed = 0;
  let skipped = 0;

  for (const r of results) {
    const icon = r.status === 'SKIP' ? '⏭' : r.ok ? '✓' : '✗';
    const statusStr = r.status === 'SKIP' ? 'SKIP' : String(r.status);
    console.log(`  ${icon}  ${r.method.padEnd(4)} ${r.path.padEnd(42)} ${statusStr.padStart(4)}  ${r.detail}`);
    if (!r.ok) failed++;
    if (r.status === 'SKIP') skipped++;
  }

  console.log('');

  if (skipped === results.length) {
    console.log('All checks skipped — server is not running.  Run the server first or set BASE_URL.');
    process.exit(0);
  }

  if (failed > 0) {
    console.error(`${failed} smoke check(s) FAILED — see above.`);
    process.exit(1);
  }

  console.log('All smoke checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
