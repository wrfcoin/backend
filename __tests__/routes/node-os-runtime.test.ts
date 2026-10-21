/**
 * #936 follow-through — exercise the mounted /api/node-os router over HTTP.
 *
 * #988's suites pin (a) that the route module resolves and (b) that the facade
 * implements every method the router calls. This adds the piece the #988
 * review explicitly listed as not-pinned: an actual mounted-endpoint exercise,
 * so a facade method that exists but returns a broken shape is caught.
 *
 * Ported from noah's #965 (his lane is at 0% budget; the block was the one
 * piece of #965 that #988 did not carry — the facade itself is byte-identical
 * between the two).
 *
 * What this does NOT pin: the other node-os endpoints (status only), and the
 * auth middleware's negative paths (covered by its own suites).
 */
import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..', '..');

describe('runtime /api/node-os behavior on mounted router (#936)', () => {
  const ROUTE_PATH = path.join(REPO_ROOT, 'server', 'routes', 'node-os-routes.js');

  function buildNodeOsApp() {
    process.env.RPC_API_KEY = 'node-os-api-key';
    process.env.ADMIN_TOKEN = 'node-os-admin-token';

    const app = express();
    app.use(express.json());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const routeModule = require(ROUTE_PATH);
    app.use('/api/node-os', routeModule.default || routeModule);
    return app;
  }

  it('serves /api/node-os/status with 200 and an initialized runtime shape', async () => {
    const app = buildNodeOsApp();
    const res = await request(app)
      .get('/api/node-os/status')
      .set('x-api-key', 'node-os-api-key')
      .set('x-admin-token', 'node-os-admin-token');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        initialized: true,
      },
    });
    expect(typeof res.body.timestamp).toBe('number');
  });
});
