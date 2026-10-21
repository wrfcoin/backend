/**
 * Backend H11 (infra#1051 residual): a route inventory ratchet for anonymous GETs.
 *
 * Boots the live entrypoint, enumerates every GET route of the express app (plus the
 * inline handler's literal paths), asks each one anonymously, and classifies it:
 *   auth-required = 401/403; anonymous = anything else (200, 4xx validation, 5xx...).
 * The result must equal __tests__/fixtures/anonymous-get-baseline.json. A NEW anonymous
 * GET therefore fails CI until someone reads what it returns and adds it to the baseline
 * (and, if it touches per-station or per-address data, to the seeded leak audit in
 * anonymous-get-leaks-h11.test.ts). A route that became auth-required or vanished also
 * fails, so the baseline cannot rot. Regenerate with UPDATE_ANON_BASELINE=1.
 * The database is a dead port: this classifies AUTH behaviour, which runs before any query.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { bootLiveEntrypoint, concreteUrl, getRouteTemplates, inlineGetTemplates, unsupportedRoutes, type Booted } from './helpers/anonymous-get-harness';

const baselinePath = path.join(__dirname, 'fixtures/anonymous-get-baseline.json');

describe('anonymous GET route inventory (H11)', () => {
  let app: Booted;
  const classes: Record<string, 'anonymous' | 'auth-required'> = {};

  beforeAll(async () => {
    app = await bootLiveEntrypoint('postgresql://127.0.0.1:59999/h11_dead');
    const templates = [...getRouteTemplates(app.inventory), ...inlineGetTemplates()];
    for (const template of templates) {
      const url = concreteUrl(template, () => 'h11probe');
      let status = 0;
      try {
        status = (await app.get(url)).status;
      } catch {
        status = 599; // no answer in 8 s: not an auth refusal
      }
      classes[template] = status === 401 || status === 403 ? 'auth-required' : 'anonymous';
    }
  }, 240_000);

  afterAll(async () => { await app?.stop(); });

  it('every mount and route shape of the live app was enumerable (an unsupported shape fails instead of being probed as a malformed URL)', () => {
    expect(unsupportedRoutes(app.inventory)).toEqual([]);
  });

  it('the inventory is not empty and the mounted routers are the live ones', () => {
    expect(Object.keys(classes).length).toBeGreaterThan(150);
    expect(Object.keys(classes)).toEqual(expect.arrayContaining(['/api/weather/stations', '/api/wallet/:address', 'inline:/metrics']));
  });

  it('matches the reviewed baseline: no unclassified anonymous GET, no stale entry', () => {
    const anonymous = Object.keys(classes).filter((k) => classes[k] === 'anonymous').sort();
    const authRequired = Object.keys(classes).filter((k) => classes[k] === 'auth-required').sort();
    if (process.env.UPDATE_ANON_BASELINE === '1') {
      fs.writeFileSync(baselinePath, `${JSON.stringify({ anonymous, authRequired }, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as { anonymous: string[]; authRequired: string[] };
    const newAnonymous = anonymous.filter((r) => !baseline.anonymous.includes(r));
    const stale = [...baseline.anonymous, ...baseline.authRequired].filter((r) => !(r in classes));
    const nowOpen = baseline.authRequired.filter((r) => classes[r] === 'anonymous');
    const nowClosed = baseline.anonymous.filter((r) => classes[r] === 'auth-required');
    expect({ newAnonymous, nowOpen, nowClosed, stale }).toEqual({ newAnonymous: [], nowOpen: [], nowClosed: [], stale: [] });
  });
});
