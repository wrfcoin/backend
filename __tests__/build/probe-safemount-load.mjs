/**
 * Production safeMount resolution probe — run in a FRESH node process.
 *
 * `dist/server/enhanced_unified_api_optimized.js` mounts routers with
 * `safeMount(path, modulePath)`, which resolves `modulePath` relative to itself
 * and swallows any load error so one bad router cannot stop boot. That swallow
 * is why an unloadable router is invisible: the process starts, health is
 * green, and every route under it 404s.
 *
 * This script reproduces exactly that resolution and load, and reports the
 * outcome on stdout as a single JSON line. A separate process is deliberate:
 *
 *   - it is the same cold-start shape production uses, with no Jest module
 *     registry, no moduleNameMapper, and no mocks in the way — the three things
 *     that hid this defect in the unit suite; and
 *   - loading the real router opens real handles (the rate limiter's Redis
 *     client), which would otherwise leak into the Jest worker.
 *
 * Usage: node probe-safemount-load.mjs <modulePath>   e.g. ./routes/pythia-routes
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const ENTRYPOINT = path.resolve('dist/server/enhanced_unified_api_optimized.js');
const modulePath = process.argv[2];

function emit(result) {
  process.stdout.write(`__PROBE__${JSON.stringify(result)}\n`);
  // Hard exit: the loaded router may hold open sockets (Redis), and this probe
  // has already produced its answer.
  process.exit(0);
}

const requireFromEntrypoint = createRequire(ENTRYPOINT);

let resolved;
try {
  resolved = requireFromEntrypoint.resolve(modulePath);
} catch (error) {
  emit({ outcome: 'RESOLVE_FAILURE', error: String(error.message).split('\n')[0] });
}

try {
  const mod = await import(`file://${resolved}`);
  const router = mod.default ?? mod;
  emit({
    outcome: 'LOAD_OK',
    resolved: path.relative(process.cwd(), resolved),
    routeCount: Array.isArray(router?.stack) ? router.stack.length : -1,
  });
} catch (error) {
  // This is precisely what production safeMount catches and discards.
  emit({
    outcome: 'SAFE_MOUNT_LOAD_FAILURE',
    resolved: path.relative(process.cwd(), resolved),
    error: `${error.constructor.name}: ${String(error.message).split('\n').join(' ')}`,
  });
}
