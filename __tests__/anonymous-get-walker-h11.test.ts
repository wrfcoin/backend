/**
 * Backend H11: controls for the route walker and the harness environment, against REAL express
 * mounts (not strings) so a wrong enumeration cannot hide behind the live app's particular routes.
 */
import express from 'express';
import { describe, expect, it } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { enumerateGetRoutes, installMountTracking } = require('./fixtures/route-walker.cjs');
installMountTracking(express); // as the inventory preload does, before any app code mounts anything
import { CORE4_TEST_URL, concreteUrl, entrypointEnv } from './helpers/anonymous-get-harness';

function appWith(mount: (app: express.Express, router: express.Router) => void) {
  const app = express();
  const router = express.Router();
  router.get('/private', (_q, s) => { s.end(); });
  mount(app, router);
  return app;
}
const gets = (app: express.Express) => enumerateGetRoutes(app).filter((e: any) => e.kind === 'get').map((e: any) => e.path).sort();
const unsupported = (app: express.Express) => enumerateGetRoutes(app).filter((e: any) => e.kind === 'unsupported');

describe('route walker on real express mounts (H11)', () => {
  it('a router mounted at an ARRAY of paths yields every arm', () => {
    expect(gets(appWith((a, r) => a.use(['/alpha', '/beta'], r)))).toEqual(['/alpha/private', '/beta/private']);
  });

  it('a mount with a path parameter yields a template concreteUrl can instantiate', () => {
    const t = gets(appWith((a, r) => a.use('/projects/:projectId', r)));
    expect(t).toEqual(['/projects/:projectId/private']);
    expect(concreteUrl(t[0], () => 'x1')).toBe('/projects/x1/private');
  });

  it('several parameters and nested routers compose', () => {
    const inner = express.Router();
    inner.get('/leaf/:id', (_q, s) => { s.end(); });
    const app = appWith((a, r) => { r.use('/nested/:n', inner); a.use('/a/:x/b/:y', r); });
    expect(gets(app)).toEqual(['/a/:x/b/:y/nested/:n/leaf/:id', '/a/:x/b/:y/private']);
  });

  it('an array mount combined with a parameter yields the cross product', () => {
    expect(gets(appWith((a, r) => a.use(['/p/:id', '/q/:id'], r)))).toEqual(['/p/:id/private', '/q/:id/private']);
  });

  it('a wildcard mount becomes *', () => {
    expect(gets(appWith((a, r) => a.use('/star/*', r)))).toEqual(['/star/*/private']);
  });

  it('a mounted SUB-APP (express() mounted with use) is followed, including its parameters', () => {
    const child = express();
    child.get('/private', (_q, s) => { s.end(); });
    child.get('/item/:id', (_q, s) => { s.end(); });
    expect(gets(appWith((a) => a.use('/sol-c/sub', child)))).toEqual(['/sol-c/sub/item/:id', '/sol-c/sub/private']);
    const paramApp = express();
    paramApp.get('/x', (_q, s) => { s.end(); });
    expect(gets(appWith((a) => a.use('/tenant/:t', paramApp)))).toEqual(['/tenant/:t/x']);
  });

  it('a sub-app that was mounted without tracking is reported as unsupported, not dropped', () => {
    const child = express();
    child.get('/private', (_q, s) => { s.end(); });
    const app = express();
    app.use('/untracked', child);
    // strip the record the way an untracked mount would look
    const layer = (app as any)._router.stack.find((l: any) => l.name === 'mounted_app');
    delete layer.handle.__h11SubApp;
    expect(unsupported(app).length).toBe(1);
  });

  it('an optional route parameter yields BOTH arms; other optional syntax is unsupported', () => {
    const app = express();
    app.get('/sol-c/optional/:wallet?', (_q, s) => { s.end(); });
    expect(gets(app)).toEqual(['/sol-c/optional', '/sol-c/optional/:wallet']);
    const odd = express();
    odd.get('/ab?cd', (_q, s) => { s.end(); });
    expect(unsupported(odd).length).toBe(1);
  });

  it('shapes it cannot represent are reported as unsupported, not turned into URLs', () => {
    expect(unsupported(appWith((a, r) => a.use(/^\/re(gex)?/, r))).length).toBe(1);
    expect(unsupported(appWith((a, r) => a.use('/opt/:o?', r))).length).toBe(1);
    const app = express();
    app.get(/^\/route-regex$/, (_q, s) => { s.end(); });
    expect(unsupported(app).length).toBe(1);
  });

  it('a plain route on the app and a route with an optional segment', () => {
    const app = express();
    app.get('/plain', (_q, s) => { s.end(); });
    app.get(['/one', '/two'], (_q, s) => { s.end(); });
    expect(gets(app)).toEqual(['/one', '/plain', '/two']);
  });
});

describe('harness environment (H11)', () => {
  it('the production core4 resolver, given the harness env, resolves to the controlled endpoint', async () => {
    const env = entrypointEnv(4999, 'postgresql://127.0.0.1:59999/x', '/tmp/x');
    const keys = ['CORE4_API_URL', 'BLOCKCHAIN_NODE_URL', 'BLOCKCHAIN_SERVICE_URL', 'RUST_BLOCKCHAIN_URL', 'WRFCOIN_CORE4_URL'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      // an inherited legacy/real value must not survive into the child environment
      process.env.BLOCKCHAIN_NODE_URL = 'http://real-host.invalid:1';
      const inherited = entrypointEnv(4999, 'postgresql://127.0.0.1:59999/x', '/tmp/x');
      for (const k of keys) { if (inherited[k] === undefined) delete process.env[k]; else process.env[k] = inherited[k]; }
      const { getCore4BaseUrl } = await import('../shared/core4-route-client.js');
      expect(getCore4BaseUrl()).toBe(CORE4_TEST_URL);
      expect(env.CORE4_API_URL).toBe(CORE4_TEST_URL);
      expect(inherited.BLOCKCHAIN_NODE_URL).toBe('');
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });
});
