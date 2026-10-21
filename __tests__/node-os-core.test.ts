/**
 * #936 — /api/node-os 404s in production because server/routes/node-os-routes.js
 * requires ../../src/node_os/node_os_core, which does not exist in the repo.
 * safeMount catches the resolution failure and the mount is silently skipped.
 *
 * These tests pin the two properties that make the restored module useful:
 *   1. the route module can be required at all (this is what safeMount does), and
 *   2. the facade actually implements every method the router calls — a missing
 *      one is a runtime TypeError on a live endpoint, not a load-time failure,
 *      so it would survive a mount-only check.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const NodeOSCore = require('../src/node_os/node_os_core');

const REPO_ROOT = path.join(__dirname, '..');

describe('#936 node-os runtime module', () => {
  it('the route module resolves and exports a router', () => {
    const routeModule = require('../server/routes/node-os-routes');
    expect(routeModule).toBeDefined();
  });

  it('implements every method the router calls on it', () => {
    const routes = readFileSync(
      path.join(REPO_ROOT, 'server', 'routes', 'node-os-routes.js'),
      'utf8',
    );
    const called = [...new Set([...routes.matchAll(/nodeOS\.([a-zA-Z_]+)\(/g)].map((m) => m[1]))];
    expect(called.length).toBeGreaterThan(0);

    const instance = new NodeOSCore();
    const missing = called.filter((name) => typeof (instance as any)[name] !== 'function');
    expect(missing).toEqual([]);
  });

  it('reports an initialized runtime shape after initialize()', async () => {
    const instance = new NodeOSCore();
    await instance.initialize();
    const status = instance.getSystemStatus();
    expect(status).toMatchObject({ initialized: true });
  });
});
