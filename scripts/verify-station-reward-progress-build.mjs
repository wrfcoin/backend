/**
 * Production-artifact reachability proof for the station reward projection.
 *
 * The weather router is safeMounted. A source test can therefore pass while a
 * load error in dist/ is swallowed and the production endpoint falls through
 * to the catch-all. Resolve from the compiled entrypoint exactly as safeMount
 * does, then prove the emitted router contains the authenticated GET route and
 * handles its exact path before the catch-all.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';

const repoRoot = process.argv[2] ?? process.cwd();
const inspectOnly = process.argv.includes('--inspect-only');
const compiledEntry = path.resolve(repoRoot, 'dist/server/enhanced_unified_api_optimized.js');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const requireFromEntry = createRequire(compiledEntry);
let router;
try {
  const modulePath = './routes/weather-routes';
  let mod;
  try {
    requireFromEntry.resolve(`${modulePath}.cjs`);
    mod = requireFromEntry(`${modulePath}.cjs`);
  } catch {
    mod = requireFromEntry(modulePath);
  }
  router = mod.default || mod.createRouter?.() || mod;
} catch (error) {
  fail(`weather router did not load from the compiled entrypoint: ${error.constructor.name}: ${error.message}`);
}

const rewardLayer = router?.stack?.find((layer) => layer.route?.path === '/stations/:stationId/reward-progress');
if (!rewardLayer) {
  fail('compiled weather router has no station reward-progress route');
}
if (!rewardLayer.route.methods?.get) {
  fail('compiled station reward-progress route is not a GET');
}
if ((rewardLayer.route.stack?.length ?? 0) < 3) {
  fail('compiled station reward-progress route is missing limiter, authentication, or handler');
}

if (inspectOnly) {
  process.stdout.write(
    `${JSON.stringify({
      outcome: 'ROUTE_PRESENT',
      method: 'GET',
      path: rewardLayer.route.path,
      handlerCount: rewardLayer.route.stack.length,
    })}\n`
  );
  process.exit(0);
}

const express = requireFromEntry('express');
const app = express();
app.use((_req, res, next) => {
  res.set('x-reward-progress-router-seam', 'entered');
  next();
});
app.use('/api/weather', router);
app.use((_req, res) => res.status(404).json({ error: 'catch-all' }));

const server = app.listen(0, '127.0.0.1', async () => {
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      fail('compiled station reward-progress probe did not obtain a TCP port');
    }
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          method: 'OPTIONS',
          path: '/api/weather/stations/build-tier-probe/reward-progress',
        },
        (result) => {
          let raw = '';
          result.on('data', (chunk) => {
            raw += chunk;
          });
          result.on('end', () =>
            resolve({
              status: result.statusCode,
              headers: result.headers,
              raw,
            })
          );
        }
      );
      request.on('error', reject);
      request.setTimeout(15_000, () => reject(new Error('probe request timed out')));
      request.end();
    });
    if (response.headers['x-reward-progress-router-seam'] !== 'entered') {
      fail('request did not reach the compiled router seam');
    }
    if (response.status === 404 || response.raw.includes('"catch-all"')) {
      fail('compiled station reward-progress path fell through to the catch-all');
    }

    process.stdout.write(
      `${JSON.stringify({
        outcome: 'REACHABLE',
        method: 'GET',
        path: rewardLayer.route.path,
        handlerCount: rewardLayer.route.stack.length,
        probeStatus: response.status,
      })}\n`
    );
    server.close(() => process.exit(0));
  } catch (error) {
    server.close();
    fail(`compiled station reward-progress request failed: ${error.message}`);
  }
});

server.on('error', (error) => {
  fail(`compiled station reward-progress listener failed: ${error.message}`);
});
