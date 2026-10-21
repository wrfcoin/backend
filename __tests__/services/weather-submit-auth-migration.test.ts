import { shouldWarnAboutUnauthenticatedWeatherSubmit } from '../../server/services/weather-submit-auth-migration.js';

describe('weather submit auth migration detector (#932)', () => {
  it('warns when a station submits without an authorization header', () => {
    expect(shouldWarnAboutUnauthenticatedWeatherSubmit(undefined)).toBe(true);
    expect(shouldWarnAboutUnauthenticatedWeatherSubmit('   ')).toBe(true);
  });

  it('does not warn merely because a caller supplied an authorization header', () => {
    expect(shouldWarnAboutUnauthenticatedWeatherSubmit('Bearer station-token')).toBe(false);
  });
});


import {
  resolveWeatherSubmitAuthMode,
  evaluateWeatherSubmitAuth,
  sha256Hex,
} from '../../server/services/weather-submit-auth-migration.js';

describe('#932 WEATHER_SUBMIT_AUTH_MODE resolution', () => {
  it("defaults to 'off' (live collectors must not break on deploy)", () => {
    expect(resolveWeatherSubmitAuthMode(undefined)).toEqual({ mode: 'off' });
    expect(resolveWeatherSubmitAuthMode('')).toEqual({ mode: 'off' });
    expect(resolveWeatherSubmitAuthMode('off')).toEqual({ mode: 'off' });
  });

  it("recognises 'enforce' case-insensitively", () => {
    expect(resolveWeatherSubmitAuthMode('enforce').mode).toBe('enforce');
    expect(resolveWeatherSubmitAuthMode(' ENFORCE ').mode).toBe('enforce');
  });

  it('a typo is NOT silent: resolves off but reports the invalid value', () => {
    const r = resolveWeatherSubmitAuthMode('enfrce');
    expect(r.mode).toBe('off');
    expect(r.invalid).toBe('enfrce');
  });
});

describe('#932 submit-auth enforcement decisions', () => {
  const TOKEN = 'test-station-submit-token-fixture-not-a-secret';
  const HASH = sha256Hex(TOKEN);
  const CONTRIB = 'contributor-secret-token';

  const base = { mode: 'enforce' as const, stationTokenHash: HASH, contributorToken: CONTRIB };

  it('mode off: anonymous → warn; any header → allow (the #948 behavior, pinned)', () => {
    expect(
      evaluateWeatherSubmitAuth({ ...base, mode: 'off', authorization: undefined }).action
    ).toBe('warn');
    expect(
      evaluateWeatherSubmitAuth({ ...base, mode: 'off', authorization: 'Bearer whatever' }).action
    ).toBe('allow');
  });

  it('enforce: the station submit token is accepted (hash match)', () => {
    const d = evaluateWeatherSubmitAuth({ ...base, authorization: `Bearer ${TOKEN}` });
    expect(d).toEqual({ action: 'allow', via: 'station-token' });
  });

  it('enforce: the platform contributor token is accepted (N5 collector bridge)', () => {
    const d = evaluateWeatherSubmitAuth({ ...base, authorization: `Bearer ${CONTRIB}` });
    expect(d).toEqual({ action: 'allow', via: 'contributor-token' });
  });

  it('enforce: anonymous, non-bearer, empty-bearer, and wrong tokens are ALL rejected', () => {
    for (const authorization of [undefined, '', 'Basic xyz', 'Bearer ', 'Bearer wrong-token']) {
      const d = evaluateWeatherSubmitAuth({ ...base, authorization });
      expect(d.action).toBe('reject');
    }
  });

  it('enforce: a station with NO provisioned token rejects (station_has_no_token) rather than falling open', () => {
    const d = evaluateWeatherSubmitAuth({
      ...base,
      stationTokenHash: null,
      authorization: 'Bearer some-guess',
    });
    expect(d).toEqual({ action: 'reject', reason: 'station_has_no_token' });
  });

  it('enforce: an unset contributor token can never be matched by an empty guess', () => {
    const d = evaluateWeatherSubmitAuth({
      mode: 'enforce',
      stationTokenHash: null,
      contributorToken: undefined,
      authorization: 'Bearer ',
    });
    expect(d.action).toBe('reject');
  });
});

import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { resolveWeatherSubmitGate } from '../../server/services/weather-submit-auth-migration.js';

const ENTRYPOINT = nodePath.join(__dirname, '..', '..', 'server', 'enhanced_unified_api_optimized.ts');

describe('#932 route gate — the decision the submit route actually makes', () => {
  const TOKEN = 'station-submit-token-fixture';
  const HASH = sha256Hex(TOKEN);
  const neverCalled = async () => {
    throw new Error('lookup must not be called');
  };

  it('mode off + anonymous -> warn, and NO credential lookup happens', async () => {
    const g = await resolveWeatherSubmitGate({
      rawMode: 'off', authorization: undefined, stationId: 'pws-1',
      contributorToken: 'c', lookupStationTokenHash: neverCalled,
    });
    expect(g.action).toBe('warn');
    expect(g.status).toBeUndefined();
  });

  it('enforce + correct station token -> allow', async () => {
    const g = await resolveWeatherSubmitGate({
      rawMode: 'enforce', authorization: `Bearer ${TOKEN}`, stationId: 'pws-1',
      contributorToken: 'c', lookupStationTokenHash: async () => HASH,
    });
    expect(g.action).toBe('allow');
    expect(g.via).toBe('station-token');
  });

  it('enforce + anonymous -> reject 401 with the machine-readable code', async () => {
    const g = await resolveWeatherSubmitGate({
      rawMode: 'enforce', authorization: undefined, stationId: 'pws-1',
      contributorToken: 'c', lookupStationTokenHash: async () => HASH,
    });
    expect(g.action).toBe('reject');
    expect(g.status).toBe(401);
    expect(g.code).toBe('WEATHER_SUBMIT_AUTH_REQUIRED');
  });

  it('FAILS CLOSED: an unreadable credential store -> reject 503, never allow', async () => {
    const g = await resolveWeatherSubmitGate({
      rawMode: 'enforce', authorization: `Bearer ${TOKEN}`, stationId: 'pws-1',
      contributorToken: 'c',
      lookupStationTokenHash: async () => { throw new Error('db down'); },
    });
    expect(g.action).toBe('reject');
    expect(g.status).toBe(503);
    expect(g.code).toBe('WEATHER_SUBMIT_AUTH_UNAVAILABLE');
  });

  it('a typo’d mode runs OFF but reports itself for the route to log', async () => {
    const g = await resolveWeatherSubmitGate({
      rawMode: 'enfrce', authorization: undefined, stationId: 'pws-1',
      contributorToken: 'c', lookupStationTokenHash: neverCalled,
    });
    expect(g.mode).toBe('off');
    expect(g.invalidMode).toBe('enfrce');
  });
});

describe('#932 the route is BOUND to the gate (source contract)', () => {
  // Review (Alice, Opus 5) deleted the route's reject block and the whole
  // 2,645-test gate was byte-identical. These assertions fail on exactly that
  // mutation. Source-level because the entrypoint exports only its server, so
  // no test can drive handleRequest in-process.
  it('the submit route calls resolveWeatherSubmitGate', () => {
    const src = readFileSync(ENTRYPOINT, 'utf8');
    expect(src).toMatch(/import \{ resolveWeatherSubmitGate \} from '\.\/services\/weather-submit-auth-migration\.js'/);
    expect(src).toContain('await resolveWeatherSubmitGate({');
  });

  it('the route RETURNS on reject — a refusal cannot fall through to ingestion', () => {
    const src = readFileSync(ENTRYPOINT, 'utf8');
    const rejectBlock = src.match(/if \(submitGate\.action === 'reject'\)[\s\S]{0,600}?\n {8}\}/);
    expect(rejectBlock).not.toBeNull();
    expect(rejectBlock![0]).toContain('error(');
    expect(rejectBlock![0]).toMatch(/\n\s+return;/);
  });

  it('the reject branch precedes the ingestion call', () => {
    const src = readFileSync(ENTRYPOINT, 'utf8');
    const rejectAt = src.indexOf("if (submitGate.action === 'reject')");
    const ingestAt = src.indexOf("route: '/api/weather/submit',\n          payload:");
    expect(rejectAt).toBeGreaterThan(-1);
    if (ingestAt > -1) expect(rejectAt).toBeLessThan(ingestAt);
  });
});
