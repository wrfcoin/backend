#!/usr/bin/env node
/**
 * Build-tier audit for every route loaded through safeMount (#937).
 *
 * The source/Jest resolver cannot prove that an emitted ESM router can load
 * its CommonJS dependencies under package.json's "type": "module". This
 * script anchors createRequire() at the real production entrypoint, isolates
 * every router in its own process, mounts it, and sends OPTIONS to a concrete
 * route path. Known failures are an explicit ratchet: a new failure and an
 * unexpected repair both fail CI until the inventory is reviewed.
 *
 * Run after `npm run build`:
 *   node scripts/audit-safe-mount-build.mjs --assert
 *   node scripts/audit-safe-mount-build.mjs --json
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const sourceEntrypoint = path.join(
  repoRoot,
  'server/enhanced_unified_api_optimized.ts',
);
const builtEntrypoint = path.join(
  repoRoot,
  'dist/server/enhanced_unified_api_optimized.js',
);
const resultMarker = '__SAFE_MOUNT_BUILD_RESULT__';
const catchAllMarker = '__SAFE_MOUNT_BUILD_CATCH_ALL__';
const reachedHeader = 'x-safe-mount-build-reached';
// 47, not 46. The required LayerZero router is mounted at /api/layer-zero so
// its repaired handlers are reachable through the production entrypoint.
// Before this addition, this constant was already stale on `main`: running this gate at
// b7bf2dbd (its own merge commit) reports "expected 45, found 46" with no
// changes applied, and `grep -cE "^\\s*safeMount\\('[^']+',\\s*'[^']+'\\);"` on
// main's entrypoint counts 46. Corrected to the measured reality (#935).
// 53, not 55: backend#1154 retired the two OpenForis mounts
// (./routes/openforis-routes, ./routes/openforis-health) along with the
// fabricated surface they served.
// 52: backend#1181 retired the fabricated MCP context mount.
// 51: backend#1156 retired the fabricated Model Context mount.
// 50: backend#1157 retired the mock AI provider mount.
// 51: backend#1179 mounts the fail-closed DeFi simulator proxy.
// 52: backend#1178 mounts /api/referrals (wallet-auth mutators, no payout).
// 53: explorer B1 mounts the public cached /api/explorer summary (./routes/explorer-routes).
// 54: backend#1382 mounts /api/weather/temperature-history (JWT, daily cell aggregates).
// 55: B2 adds the default-OFF /api/earnings read router; every compiled mount is still probed.
// 56: core4#3604 A4 adds the default-OFF /api/forecasters read router (./routes/forecasters-routes).
// 57: self-serve bond-grant proxy.
// 58: backend-archive#1495 mounts the default-OFF /api/transport/email observation gateway.
// 59: backend#21's passkey send router reaches the deployed entrypoint (./routes/wallet-passkey-send-gate).
// 60: owner ruling 2026-10-28 (b) mounts the default-OFF /api/public/balance read.
const expectedMountCount = 60;

// Removed by #935/#937 — each of these now PASSES this gate, and the gate
// itself instructed the removal ("known failures now pass; remove their
// ratchet entries"). A ratchet that keeps excusing a fixed route stops being a
// ratchet.
//   ./routes/governance-routes  -> REACHABLE (200)
//   ./routes/onboarding-routes  -> REACHABLE (200)
//   ./routes/privacyRoutes      -> REACHABLE (401)
//   ./routes/weather-alerts-routes -> REACHABLE (401)
//   ./routes/weather-report-routes -> REACHABLE (401)
//   ./routes/sms-observation-gateway-routes -> REACHABLE (200)
//   ./routes/wormhole-transfer-routes -> REACHABLE (401)
// The first three were `esm-imports-cjs-as-js`: the build emitted a .cjs shim but
// only repointed require() specifiers, never ESM `import ... from './x.js'`.
// The four #937 routes were emitted ESM invoking an ambient require() that does
// not exist under type:module. The uniform build repair now installs a
// file-anchored createRequire and redirects relative calls to existing shims.
// backend#1154 retired ./routes/openforis-routes entirely, so its
// fail-closed-missing-secret ratchet entry is gone, not fixed-and-removed
// like the #935/#937 routes above.
const knownBrokenMounts = new Map([]);
const authRequiredMounts = new Set(['./routes/layer-zero-routes']);

function errorDetails(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || null,
    message: error?.message || String(error),
  };
}

function emitWorkerResult(result, exitCode) {
  process.stdout.write(`${resultMarker}${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

function parseMounts() {
  const source = readFileSync(sourceEntrypoint, 'utf8');
  return [
    ...source.matchAll(/^\s*safeMount\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\);/gm),
  ].map((match) => ({
    mountPath: match[1],
    modulePath: match[2],
  }));
}

function firstConcreteRoutePath(router) {
  for (const layer of router.stack || []) {
    const routePath = layer?.route?.path;
    if (typeof routePath === 'string') {
      return routePath;
    }
    if (Array.isArray(routePath)) {
      const concrete = routePath.find(
        (candidate) => typeof candidate === 'string',
      );
      if (concrete) return concrete;
    }
  }
  return null;
}

function fillRouteParameters(routePath) {
  return routePath
    .replace(/:([A-Za-z0-9_]+)(?:\([^)]*\))?[?+*]?/g, 'build-tier-probe')
    .replace(/\*/g, 'build-tier-probe');
}

function requestPathFor(mountPath, routePath) {
  const child = fillRouteParameters(routePath);
  const joined = `${mountPath.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}`;
  return joined || '/';
}

async function runWorker(modulePath, mountPath) {
  const productionRequire = createRequire(builtEntrypoint);
  const cjsModulePath = `${modulePath}.cjs`;
  let cjsFailure = null;
  let selectedPath = cjsModulePath;

  try {
    let mod;
    try {
      productionRequire.resolve(cjsModulePath);
      mod = productionRequire(cjsModulePath);
    } catch (error) {
      cjsFailure = errorDetails(error);
      selectedPath = modulePath;
      mod = productionRequire(modulePath);
    }

    const router = mod.default || mod.createRouter?.() || mod;
    if (typeof router !== 'function') {
      throw new TypeError(
        `router export is ${router === null ? 'null' : typeof router}`,
      );
    }

    const routePath = firstConcreteRoutePath(router);
    if (!routePath) {
      throw new Error(
        'router has no concrete route path for reachability probe',
      );
    }

    const express = productionRequire('express');
    const request = productionRequire('supertest');
    const app = express();
    app.use(
      mountPath,
      (_req, res, next) => {
        res.setHeader(reachedHeader, modulePath);
        next();
      },
      router,
    );
    app.use((_req, res) => res.status(404).json({ error: catchAllMarker }));

    const requestPath = requestPathFor(mountPath, routePath);
    const response = await request(app)
      .options(requestPath)
      .timeout({ response: 5_000, deadline: 7_000 });

    if (response.headers[reachedHeader] !== modulePath) {
      throw new Error(
        `representative path never entered router: ${requestPath}`,
      );
    }
    if (response.body?.error === catchAllMarker) {
      throw new Error(
        `representative path fell through to catch-all: ${requestPath}`,
      );
    }

    emitWorkerResult(
      {
        ok: true,
        modulePath,
        mountPath,
        selectedPath,
        routePath,
        requestPath,
        status: response.status,
        layerCount: Array.isArray(router.stack) ? router.stack.length : null,
        cjsFailure,
      },
      0,
    );
  } catch (error) {
    emitWorkerResult(
      {
        ok: false,
        modulePath,
        mountPath,
        selectedPath,
        error: errorDetails(error),
        cjsFailure,
      },
      1,
    );
  }
}

function runProbe(mount) {
  const child = spawnSync(
    process.execPath,
    [scriptPath, '--worker', mount.modulePath, mount.mountPath],
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
    ?.split('\n')
    .find((line) => line.startsWith(resultMarker));
  if (resultLine) {
    return JSON.parse(resultLine.slice(resultMarker.length));
  }

  return {
    ok: false,
    ...mount,
    selectedPath: null,
    error: {
      name: child.error?.name || 'ProbeFailure',
      code: child.error?.code || null,
      message:
        child.error?.message ||
        child.stderr?.trim() ||
        `worker exited ${child.status}`,
    },
    cjsFailure: null,
  };
}

function combinedFailureText(result) {
  return [
    result.cjsFailure?.name,
    result.cjsFailure?.code,
    result.cjsFailure?.message,
    result.error?.name,
    result.error?.code,
    result.error?.message,
  ]
    .filter(Boolean)
    .join('\n');
}

function auditResults() {
  const mounts = parseMounts();
  const results = mounts.map(runProbe);
  const loaded = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);

  const unexpectedFailures = failed.filter((result) => {
    const known = knownBrokenMounts.get(result.modulePath);
    return !known || !known.pattern.test(combinedFailureText(result));
  });
  // Keep this ratchet active: a known failure that starts passing must fail
  // the audit until its stale inventory entry is deliberately removed.
  const unexpectedPasses = loaded.filter((result) =>
    knownBrokenMounts.has(result.modulePath),
  );
  const missingKnownMounts = [...knownBrokenMounts.keys()].filter(
    (modulePath) => !results.some((result) => result.modulePath === modulePath),
  );
  const authenticationBypasses = loaded.filter(
    (result) =>
      authRequiredMounts.has(result.modulePath) && result.status !== 401,
  );

  return {
    sourceEntrypoint,
    builtEntrypoint,
    expectedMountCount,
    total: results.length,
    loaded: loaded.length,
    failed: failed.length,
    knownBroken: knownBrokenMounts.size,
    unexpectedFailures,
    unexpectedPasses,
    missingKnownMounts,
    authenticationBypasses,
    results: results.map((result) => {
      const known = knownBrokenMounts.get(result.modulePath);
      return known
        ? {
            ...result,
            expectedFailure: {
              issue: known.issue,
              kind: known.kind,
            },
          }
        : result;
    }),
  };
}

function printTable(audit) {
  console.log(
    `safeMount build-tier audit: ${audit.loaded}/${audit.total} reachable; ` +
      `${audit.failed} expected failures`,
  );
  console.log('| Mount | Module | Result | Representative probe |');
  console.log('|---|---|---|---|');
  for (const result of audit.results) {
    if (result.ok) {
      console.log(
        `| \`${result.mountPath}\` | \`${result.modulePath}\` | ` +
          `REACHABLE (${result.status}) | \`OPTIONS ${result.requestPath}\` |`,
      );
      continue;
    }
    const failure = result.expectedFailure
      ? `KNOWN FAIL ${result.expectedFailure.issue}: ${result.expectedFailure.kind}`
      : `UNEXPECTED FAIL: ${result.error?.message}`;
    console.log(
      `| \`${result.mountPath}\` | \`${result.modulePath}\` | ${failure} | — |`,
    );
  }
}

function assertAudit(audit) {
  const errors = [];
  if (!existsSync(builtEntrypoint)) {
    errors.push(`missing production build: ${builtEntrypoint}`);
  }
  if (audit.total !== expectedMountCount) {
    errors.push(
      `safeMount inventory changed: expected ${expectedMountCount}, found ${audit.total}`,
    );
  }
  if (audit.unexpectedFailures.length) {
    errors.push(
      `unexpected failures: ${audit.unexpectedFailures
        .map((result) => result.modulePath)
        .join(', ')}`,
    );
  }
  if (audit.unexpectedPasses.length) {
    errors.push(
      `known failures now pass; remove their ratchet entries: ${audit.unexpectedPasses
        .map((result) => result.modulePath)
        .join(', ')}`,
    );
  }
  if (audit.missingKnownMounts.length) {
    errors.push(
      `known failure entries are no longer mounted: ${audit.missingKnownMounts.join(', ')}`,
    );
  }
  if (audit.authenticationBypasses.length) {
    errors.push(
      `authentication-required routes did not reject the unauthenticated probe: ${audit.authenticationBypasses
        .map((result) => result.modulePath)
        .join(', ')}`,
    );
  }
  if (audit.failed !== knownBrokenMounts.size) {
    errors.push(
      `failure count drifted: expected ${knownBrokenMounts.size}, found ${audit.failed}`,
    );
  }

  if (errors.length) {
    console.error('\nBUILD_TIER_SAFE_MOUNT_GATE_FAILED');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nBUILD_TIER_SAFE_MOUNT_GATE_OK total=${audit.total} ` +
        `reachable=${audit.loaded} known_broken=${audit.failed}`,
    );
  }
}

if (process.argv[2] === '--worker') {
  await runWorker(process.argv[3], process.argv[4]);
} else {
  if (!existsSync(builtEntrypoint)) {
    console.error(`Missing production build: ${builtEntrypoint}`);
    console.error('Run `npm run build` before this audit.');
    process.exit(2);
  }

  const audit = auditResults();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(audit, null, 2));
  } else {
    printTable(audit);
  }
  if (process.argv.includes('--assert')) {
    assertAudit(audit);
  }
}
