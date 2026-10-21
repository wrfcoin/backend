import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auditScript = path.join(repoRoot, 'scripts/audit-safe-mount-build.mjs');
const resultMarker = '__SAFE_MOUNT_BUILD_RESULT__';
const child = spawnSync(
  process.execPath,
  [auditScript, '--worker', './routes/sensor-ingest-routes', '/api/sensors'],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CI: 'true',
      JWT_SECRET: 'build-tier-audit-only-not-a-production-secret',
      ENCRYPTION_KEY: 'build-tier-audit-only-not-a-production-key',
      KEY_STORAGE_DIR: path.join(repoRoot, 'dist/.safe-mount-audit-keys'),
    },
  },
);

const resultLine = child.stdout
  .split('\n')
  .find((line) => line.startsWith(resultMarker));
assert.ok(resultLine, child.stderr || `sensor worker exited ${child.status}`);
const result = JSON.parse(resultLine.slice(resultMarker.length));
assert.equal(result.ok, true, result.error?.message);
assert.equal(result.modulePath, './routes/sensor-ingest-routes');
assert.equal(result.mountPath, '/api/sensors');
assert.equal(result.selectedPath, './routes/sensor-ingest-routes');
assert.ok(result.routePath);
assert.ok(result.requestPath);
assert.ok(result.layerCount > 0);

console.log('compiled sensor safe-mount route exports: PASS');
