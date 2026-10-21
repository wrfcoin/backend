/**
 * Production-seam reachability probe for `/api/governance` (backend#935).
 *
 * Run as a **real Node subprocess**, never inside Jest. That is the entire
 * point of this file existing separately.
 *
 * Jest installs its own module registry and resolver, and this repo's config
 * maps `'^(\.{1,2}/.*)\.js$' -> '$1'` while listing `ts` ahead of `js` in
 * `moduleFileExtensions`. A `createRequire()` call made *inside* a Jest test
 * therefore still resolves through Jest, not through Node — so it happily loads
 * a compiled artifact that real Node refuses. Measured, not assumed: against an
 * identical `dist/`, the in-Jest probe reported the governance router loaded
 * while this subprocess reported
 *
 *   SyntaxError: The requested module '../server/utils/error-response.js'
 *   does not provide an export named 'default'
 *
 * which is the actual production failure. Testing the build through Jest's
 * resolver repeats, one level up, the same mistake as testing the source tree
 * and calling it production truth.
 *
 * Emits a single line of JSON on stdout so the caller need not parse prose.
 */

import { createRequire } from 'module';
import path from 'path';
import http from 'http';

const repoRoot = process.argv[2] ?? process.cwd();
const compiledEntry = path.resolve(repoRoot, 'dist/server/enhanced_unified_api_optimized.js');

function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

let router;
try {
  const requireFromEntry = createRequire(compiledEntry);
  const modulePath = './routes/governance-routes';

  // Mirror safeMount exactly: prefer the emitted .cjs, else the bare specifier.
  let mod;
  try {
    requireFromEntry.resolve(`${modulePath}.cjs`);
    mod = requireFromEntry(`${modulePath}.cjs`);
  } catch {
    mod = requireFromEntry(modulePath);
  }
  router = mod.default || mod.createRouter?.() || mod;
} catch (error) {
  // This is precisely what safeMount swallows into a warn, leaving the route
  // unmounted and every request under it answering 404.
  emit({
    loaded: false,
    error: `${error.constructor.name}: ${String(error.message).split('\n')[0]}`,
  });
}

let express;
try {
  express = (await import('express')).default;
} catch (error) {
  emit({ loaded: true, harnessError: `express unavailable: ${error.message}` });
}

const app = express();
app.use(express.json());
app.use('/api/governance', router);
// Stands in for "no route matched" — the observable symptom of a skipped mount.
app.use((_req, res) => res.status(404).json({ error: 'catch-all' }));

const server = app.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/governance/delegations' },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve({ status: res.statusCode, raw }));
        },
      );
      req.on('error', reject);
      req.setTimeout(15000, () => reject(new Error('probe request timed out')));
    });

    let parsed = null;
    try {
      parsed = JSON.parse(body.raw);
    } catch {
      /* leave null; the caller asserts on status plus whatever parsed */
    }
    emit({ loaded: true, status: body.status, body: parsed });
  } catch (error) {
    emit({ loaded: true, harnessError: error.message });
  }
});
