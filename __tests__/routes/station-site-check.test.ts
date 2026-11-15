/**
 * Epic 8: "Has this station moved?" for the station's owner (GET /api/stations/:alias/site-check).
 * Stations, wallets and readings here are made up.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';
import { createStationOwnerInsightsRouter } from '../../server/routes/station-owner-insights-routes.js';
import { BEFORE_DAYS, RECENT_DAYS, checkSite, lastingStep, type Timed } from '../../server/services/station-site-check.js';
import type { CompareSample } from '../../server/services/station-compare-history.js';
import { stationAlias } from '../../server/utils/station-alias.js';

const NOW_S = 1_790_000_000;
const HOUR = 3600;
const DAY = 86_400;

/**
 * Hourly samples for 17 days. `at(hoursAgo)` gives our pressure and temperature; the reference stays at
 * 1010 hPa / 10 C. Returning `skip` leaves that hour out (station offline).
 */
function series(at: (hoursAgo: number) => { p?: number | null; t?: number | null; ref?: string; skip?: boolean }): CompareSample[] {
  const out: CompareSample[] = [];
  for (let h = 0; h < (BEFORE_DAYS + RECENT_DAYS) * 24; h += 1) {
    const mine = at(h);
    if (mine.skip) continue;
    // A little deterministic wobble so the scatter is not zero.
    const wobble = ((h * 7) % 5 - 2) * 0.1;
    out.push({
      observedAt: NOW_S - h * HOUR,
      temperatureC: mine.t === null ? null : (mine.t ?? 11) + wobble * 3,
      humidityPct: 60,
      pressureHpa: mine.p === null ? null : (mine.p ?? 1002) + wobble,
      nwsStation: mine.ref ?? 'KAAA',
      nwsTemperatureC: 10,
      nwsHumidityPct: 66,
      nwsBarometricHpa: 1010,
    });
  }
  return out;
}
const recentHours = RECENT_DAYS * 24;

describe('checkSite', () => {
  it('raises nothing for a steady station', () => {
    const r = checkSite(series(() => ({})), NOW_S);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.flags).toEqual([]);
    expect(r.reference).toEqual({ kind: 'nws', stationIdentifier: 'KAAA' });
  });

  it('flags a lasting pressure drop as "higher up", with a rounded height', () => {
    // Was 8 hPa under the reference, now 14 under: 6 hPa lower, about 50 m higher.
    const r = checkSite(series(h => ({ p: h < recentHours ? 996 : 1002 })), NOW_S);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0]).toMatchObject({ kind: 'pressure_offset_changed', approxHeightChangeM: 50, heightDirection: 'higher' });
    const flag = r.flags[0] as { shiftPercent: number; approxShiftHpa: number };
    expect(flag.shiftPercent).toBeCloseTo(-0.6, 1);
    expect(flag.approxShiftHpa).toBeCloseTo(-6, 0);
    // The answer says where the newer window starts, and no flag claims when the change began.
    expect(r.recentFrom % DAY).toBe(0);
    expect(JSON.stringify(r.flags)).not.toMatch(/since/);
  });

  it('flags a lasting pressure rise as "lower down"', () => {
    const r = checkSite(series(h => ({ p: h < recentHours ? 1006 : 1002 })), NOW_S);
    expect(r.status === 'ok' && r.flags[0]).toMatchObject({ kind: 'pressure_offset_changed', approxHeightChangeM: 30, heightDirection: 'lower' });
  });

  it('flags a lasting temperature change', () => {
    const r = checkSite(series(h => ({ t: h < recentHours ? 17 : 11 })), NOW_S);
    expect(r.status === 'ok' && r.flags).toEqual([expect.objectContaining({ kind: 'temperature_pattern_changed', shiftC: 6 })]);
  });

  it('ignores a small change, a short blip and weather that moves both stations', () => {
    // 2 hPa is under the 3 hPa floor.
    expect(checkSite(series(h => ({ p: h < recentHours ? 1000 : 1002 })), NOW_S)).toMatchObject({ status: 'ok', flags: [] });
    // Six odd hours inside the recent window do not move its median.
    expect(checkSite(series(h => ({ p: h < 6 ? 990 : 1002 })), NOW_S)).toMatchObject({ status: 'ok', flags: [] });
    // A storm: both stations drop by the same share (about 25 hPa), so the ratio is unchanged.
    const storm = series(() => ({})).map((s, i) => (i < recentHours
      ? { ...s, pressureHpa: (s.pressureHpa as number) * 0.975, nwsBarometricHpa: (s.nwsBarometricHpa as number) * 0.975 }
      : s));
    expect(checkSite(storm, NOW_S)).toMatchObject({ status: 'ok', flags: [] });
  });

  it('judges pressure by the ratio, so a reference reduced to sea level works the same', () => {
    // A station about 240 m up reads about 985 hPa while the reference says 1013. Normal weather swings both by the
    // same share. Then the station moves about 40 m higher: its share of the reference drops by about 0.5 %.
    const samples = series(() => ({})).map((s, i) => {
      const weather = 1 + 0.012 * Math.sin(i / 19);
      const share = i < recentHours ? 0.9722 * 0.9953 : 0.9722;
      return { ...s, nwsBarometricHpa: 1013 * weather, pressureHpa: 1013 * weather * share };
    });
    const r = checkSite(samples, NOW_S);
    expect(r.status === 'ok' && r.flags).toEqual([expect.objectContaining({ kind: 'pressure_offset_changed', heightDirection: 'higher', approxHeightChangeM: 40 })]);
    // The same weather with no move raises nothing: the ratio is steady.
    const steady = series(() => ({})).map((s, i) => {
      const weather = 1 + 0.012 * Math.sin(i / 19);
      return { ...s, nwsBarometricHpa: 1013 * weather, pressureHpa: 1013 * weather * 0.9722 };
    });
    expect(checkSite(steady, NOW_S)).toMatchObject({ status: 'ok', flags: [] });
  });

  it('compares like hours: a station back online for afternoons only is not read as a temperature change', () => {
    // Every day this station runs 5 C warmer than the reference from 12:00 to 23:00 UTC and 1 C warmer at night.
    const hourUtc = (h: number) => Math.floor(((NOW_S - h * HOUR) % DAY) / HOUR);
    const daily = (h: number) => (hourUtc(h) >= 12 ? 15 : 11);
    // It was offline at night for the last three days: only afternoon pairs are recent.
    const afternoonsOnly = series(h => (h < recentHours && hourUtc(h) < 12 ? { skip: true } : { t: daily(h) }));
    const r = checkSite(afternoonsOnly, NOW_S);
    expect(r.status).toBe('ok');
    expect(r.status === 'ok' && r.flags).toEqual([]);
    // The same recent hours, but really 6 C warmer than those hours used to be: flagged.
    const moved = series(h => (h < recentHours && hourUtc(h) < 12 ? { skip: true } : { t: daily(h) + (h < recentHours ? 6 : 0) }));
    expect(checkSite(moved, NOW_S)).toMatchObject({ status: 'ok', flags: [expect.objectContaining({ kind: 'temperature_pattern_changed', shiftC: 6 })] });
  });

  it('needs recent pairs on at least two different days', () => {
    // 14 recent pairs, all inside the last 14 hours of one UTC day, 6 C warmer.
    const endOfDay = NOW_S - (NOW_S % DAY) + DAY - 1;
    const base = series(() => ({})).map(s => ({ ...s, observedAt: s.observedAt + (endOfDay - NOW_S) }));
    const oneDay = base.filter((_, i) => i < 14 || i > recentHours).map((s, i) => (i < 14 ? { ...s, temperatureC: (s.temperatureC as number) + 6 } : s));
    expect(checkSite(oneDay, endOfDay)).toMatchObject({ status: 'ok', flags: [] });
  });

  it('does not mistake a change of NWS station for a move', () => {
    // The recent pairs are against another NWS station at another height: they are not used.
    const r = checkSite(series(h => (h < recentHours ? { p: 990, ref: 'KBBB' } : {})), NOW_S);
    expect(r.status).toBe('not_enough_data');
  });

  it('says not enough data without about 17 days of pairs', () => {
    expect(checkSite(series(() => ({})).slice(0, 100), NOW_S).status).toBe('not_enough_data');
    expect(checkSite([], NOW_S).status).toBe('not_enough_data');
    // No pressure on either side: nothing to judge, no flag, still an answer.
    expect(checkSite(series(() => ({ p: null })), NOW_S)).toMatchObject({ status: 'ok', flags: [] });
  });

  it('needs the change to be large next to the earlier scatter', () => {
    const timed = (values: number[], startHoursAgo: number): Timed[] => values.map((value, i) => ({ at: NOW_S - (startHoursAgo + i) * HOUR, value }));
    const noisyBefore = timed(Array.from({ length: 240 }, (_, i) => ((i * 37) % 21) - 10), 72); // spread of about +-10
    const recent = timed(Array.from({ length: 48 }, () => 4.5), 0);
    expect(lastingStep(noisyBefore, recent, 3, 3)).toBeNull();
    const steadyBefore = timed(Array.from({ length: 240 }, (_, i) => ((i % 3) - 1) * 0.2), 72);
    const step = lastingStep(steadyBefore, recent, 3, 3);
    expect(step).not.toBeNull();
    expect((step as { shift: number }).shift).toBeCloseTo(4.5, 0);
  });
});

describe('GET /api/stations/:alias/site-check', () => {
  const STATION = 'made-up-station-1';
  const ALIAS = stationAlias(STATION);
  const OWNER = '0x' + 'ab'.repeat(20);
  const now = () => NOW_S * 1000;

  function app(over: { enabled?: boolean; wallet?: string | null; samples?: CompareSample[] } = {}) {
    const sql: string[] = [];
    const db = {
      execute: jest.fn(async (text: string, params: unknown[] = []) => {
        sql.push(text);
        if (/owner_address/.test(text)) return { rows: params[0] === STATION ? [{ owner_address: OWNER }] : [] };
        if (/FROM station_compare_samples/.test(text)) {
          return { rows: (over.samples ?? []).map(s => ({
            observed_at: String(s.observedAt), temperature_c: s.temperatureC, humidity_pct: s.humidityPct, pressure_hpa: s.pressureHpa,
            nws_station: s.nwsStation, nws_temperature_c: s.nwsTemperatureC, nws_humidity_pct: s.nwsHumidityPct, nws_barometric_hpa: s.nwsBarometricHpa,
          })) };
        }
        return { rows: params[0] === ALIAS ? [{ station_id: STATION }] : [] };
      }),
    };
    const a = express();
    a.use('/api', createStationOwnerInsightsRouter({
      db, now,
      walletOf: () => (over.wallet === undefined ? OWNER : over.wallet),
      isOperator: () => false,
      historyEnabled: () => false,
      siteCheckEnabled: () => over.enabled ?? true,
    }));
    return { a, db, sql };
  }

  it('is 404 and reads nothing while the feature is off, whatever the history flag says', async () => {
    const { a, db } = app({ enabled: false });
    expect((await request(a).get(`/api/stations/${ALIAS}/site-check`)).status).toBe(404);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('gives the owner the flags, private and with no id, owner or coordinate', async () => {
    const { a } = app({ samples: series(h => ({ p: h < recentHours ? 996 : 1002 })) });
    const r = await request(a).get(`/api/stations/${ALIAS}/site-check`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.body.status).toBe('ok');
    expect(r.body.flags).toEqual([expect.objectContaining({ kind: 'pressure_offset_changed', heightDirection: 'higher', approxHeightChangeM: 50 })]);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(STATION);
    expect(text).not.toContain(OWNER);
    expect(text).not.toMatch(/latitude|longitude|owner_address|wallet/i);
  });

  it('refuses a visitor (401) and another wallet (403) without reading any sample', async () => {
    const samples = series(h => ({ p: h < recentHours ? 996 : 1002 }));
    const anon = app({ wallet: null, samples });
    expect((await request(anon.a).get(`/api/stations/${ALIAS}/site-check`)).status).toBe(401);
    const other = app({ wallet: '0x' + 'cd'.repeat(20), samples });
    const r = await request(other.a).get(`/api/stations/${ALIAS}/site-check`);
    expect(r.status).toBe(403);
    expect(r.body.flags).toBeUndefined();
    for (const used of [anon.sql, other.sql]) expect(used.some(q => /station_compare_samples/.test(q))).toBe(false);
  });

  it('says not enough data honestly', async () => {
    const { a } = app({ samples: [] });
    const r = await request(a).get(`/api/stations/${ALIAS}/site-check`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('not_enough_data');
  });
});
