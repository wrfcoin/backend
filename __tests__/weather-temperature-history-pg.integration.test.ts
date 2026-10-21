/**
 * Temperature history privacy + work-bound cases against a REAL PostgreSQL
 * (backend#1382 review). Skipped unless TEMPERATURE_HISTORY_PG_URL (or the CI
 * services' BACKFILL_TEST_PG_URL) points at a THROWAWAY database. The test
 * builds its own per-process schema (minimal users, drizzle/migrations/0002, then
 * 0027 after seeding legacy rows, each applied as written) and drops it afterwards. Run locally e.g.:
 *   docker run -d --rm -p 127.0.0.1:55439:5432 -e POSTGRES_PASSWORD=t postgres:15-alpine
 *   TEMPERATURE_HISTORY_PG_URL=postgres://postgres:t@127.0.0.1:55439/postgres npx jest ...
 * TEMPERATURE_HISTORY_REQUIRE_PG=1 turns a missing URL into a failure.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.mock('express-rate-limit', () => jest.fn(() => (_req: any, _res: any, next: any) => next()));
jest.mock('../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
}));

import { createWeatherTemperatureHistoryRouter } from '../server/routes/weather-temperature-history-routes.js';
import { RELEASE_SQL, getTemperatureHistory, type TransactionRunner } from '../server/services/temperature-history.js';

const url = process.env.TEMPERATURE_HISTORY_PG_URL || process.env.BACKFILL_TEST_PG_URL;
const d = url ? describe : describe.skip;

if (!url && process.env.TEMPERATURE_HISTORY_REQUIRE_PG === '1') {
  it('TEMPERATURE_HISTORY_PG_URL is required when TEMPERATURE_HISTORY_REQUIRE_PG=1', () => {
    throw new Error('real-Postgres temperature-history cases would have been skipped');
  });
}

const SCHEMA = `th_${crypto.randomBytes(6).toString('hex')}`;
const NOW = new Date('2026-09-30T15:30:00Z');
// Fabricated cell centre: latE1=400, lonE1=-1050 (cell 39.95..40.05, -105.05..-104.95)
const CELL = { latE1: 400, lonE1: -1050 };
const INSIDE = { lat: 40.049999, lon: -105.012345 };
let pool: Pool;
let seq = 0;

async function insert(day: string, hour: number, temperature: number, contributor: string | null, over: Record<string, unknown> = {}) {
  seq += 1;
  const submitted = `${day}T${String(hour).padStart(2, '0')}:${String((seq * 7) % 60).padStart(2, '0')}:00Z`;
  await pool.query(
    `INSERT INTO weather_submissions (station_id, latitude, longitude, temperature, quality_score, physics_violations, submitted_at, received_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)`,
    [
      contributor,
      over.lat ?? INSIDE.lat,
      over.lon ?? INSIDE.lon,
      temperature,
      over.quality ?? 100,
      over.violations ?? '[]',
      submitted,
      // Fixtures simulate the server clock: by default a row is received as it is submitted.
      over.received ?? submitted,
    ]
  );
}

async function fill(day: string, contributors: number, temperature: number, prefix = 'st') {
  for (let i = 0; i < contributors; i += 1) await insert(day, 6 + (i % 10), temperature, `${prefix}-${day}-${i}`);
}

const runner = (shown?: { timeout?: string }): TransactionRunner => async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await callback({
      execute: async (sql, params) => ({ rows: (await client.query(sql, params as any[])).rows }),
    });
    if (shown) shown.timeout = (await client.query('SHOW statement_timeout')).rows[0].statement_timeout;
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

const releases = async () => (await pool.query('SELECT * FROM weather_temperature_daily_release ORDER BY lat_e1, lon_e1, day')).rows;
const unrelease = (day: string) => pool.query('DELETE FROM weather_temperature_daily_release WHERE day = $1::date', [day]);
const history = (days: number, now = NOW) => getTemperatureHistory(runner(), { ...CELL, days }, now);
const dayOf = (h: Awaited<ReturnType<typeof history>>, date: string) => h.daily.find((x) => x.date === date);

d('temperature history against real PostgreSQL', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 4, options: `-c search_path=${SCHEMA}` });
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    await pool.query('CREATE TABLE users (id serial PRIMARY KEY)');
    const migration = fs.readFileSync(path.join(__dirname, '../drizzle/migrations/0002_sensor_ingest.sql'), 'utf8');
    await pool.query(migration);
    // Legacy rows exist BEFORE migration 0027: a normal past day (5 stations) and a
    // row whose client time is in the future.
    for (let i = 0; i < 5; i += 1) {
      await pool.query(
        `INSERT INTO weather_submissions (station_id, latitude, longitude, temperature, submitted_at)
         VALUES ($1, $2, $3, 12, '2026-09-10T08:00:00Z')`,
        [`legacy-${i}`, INSIDE.lat, INSIDE.lon]
      );
    }
    await pool.query(
      `INSERT INTO weather_submissions (station_id, latitude, longitude, temperature, submitted_at)
       VALUES ('legacy-future', $1, $2, 12, '2099-01-01T00:00:00Z')`,
      [INSIDE.lat, INSIDE.lon]
    );
    const migration27 = fs.readFileSync(path.join(__dirname, '../drizzle/migrations/0027_weather_submissions_received_at.sql'), 'utf8');
    await pool.query(migration27);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  it('suppresses a singleton day even when the window also holds an exposed day', async () => {
    await insert('2026-09-20', 10, 13.37, 'only-one');
    await fill('2026-09-21', 5, 10);
    const two = await history(14);
    expect(dayOf(two, '2026-09-20')).toEqual({ date: '2026-09-20', minC: null, maxC: null, meanC: null });
    expect(dayOf(two, '2026-09-21')).toMatchObject({ minC: 10, maxC: 10, meanC: 10 });
    expect(JSON.stringify(two)).not.toMatch(/13\.37|13\.5/);
  });

  it('suppresses a day with 4 distinct contributors and exposes one with 5', async () => {
    await fill('2026-09-22', 4, 11);
    await fill('2026-09-23', 5, 11);
    const out = await history(14);
    expect(dayOf(out, '2026-09-22')?.meanC).toBeNull();
    expect(dayOf(out, '2026-09-23')?.meanC).toBe(11);
  });

  it('counts DISTINCT contributors: many readings from one station do not expose a day', async () => {
    for (let i = 0; i < 12; i += 1) await insert('2026-09-19', 8 + (i % 10), 30 + i, 'one-chatty-station');
    const out = await history(14);
    expect(dayOf(out, '2026-09-19')?.meanC).toBeNull();
  });

  it('two-5+ subtraction: a sixth contributor cannot be recovered (frozen release, no exact counts, rounded values)', async () => {
    await fill('2026-09-24', 5, 10);
    const before = await history(14);
    await insert('2026-09-24', 12, 40, 'sixth');
    const after = await history(14);
    const b = dayOf(before, '2026-09-24')!;
    const a = dayOf(after, '2026-09-24')!;
    expect(b.meanC).toBe(10);
    expect(a).toEqual(b); // frozen at first release: the sixth contributor changes nothing
    // control: without the freeze the live aggregate WOULD have moved to (5*10 + 40) / 6 = 15
    await unrelease('2026-09-24');
    expect(dayOf(await history(14), '2026-09-24')?.meanC).toBe(15);
    await unrelease('2026-09-24');
    // no exact per-day counts exist to solve 6*15 - 5*10 = 40
    expect(JSON.stringify(after)).not.toMatch(/samples|hours|contributor/);
    expect(after.sampleCount % 10).toBe(0);
    expect(Object.keys(a).sort()).toEqual(['date', 'maxC', 'meanC', 'minC']);
  });

  it('a completed day reads identically in days=1, 2 and 14 windows (no window differencing)', async () => {
    const one = await history(1, new Date('2026-09-25T09:00:00Z'));
    const two = await history(2, new Date('2026-09-25T09:00:00Z'));
    const many = await history(14, new Date('2026-09-25T09:00:00Z'));
    expect(dayOf(two, '2026-09-24')).toEqual(dayOf(one, '2026-09-24'));
    expect(dayOf(many, '2026-09-24')).toEqual(dayOf(one, '2026-09-24'));
    expect(dayOf(many, '2026-09-23')).toEqual(dayOf(two, '2026-09-23') ?? dayOf(many, '2026-09-23'));
  });

  it('never exposes today, and rows today do not change any published day', async () => {
    await fill('2026-09-30', 7, 99);
    const out = await history(3);
    expect(out.daily.map((x) => x.date)).toEqual(['2026-09-27', '2026-09-28', '2026-09-29']);
    expect(out.window.to).toBe('2026-09-29');
    expect(out.sampleCount).toBe(0); // the 7 readings today are not counted either
    expect(JSON.stringify(out)).not.toMatch(/2026-09-30/);
  });

  it('applies the cell edges (39.95 in, 40.05 out), quality and physics filters in real SQL', async () => {
    const day = '2026-09-18';
    for (let i = 0; i < 5; i += 1) await insert(day, 9, 20, `edge-${i}`, { lat: i === 0 ? 39.95 : INSIDE.lat });
    await insert(day, 9, 50, 'out-lat', { lat: 40.05 });
    await insert(day, 9, 50, 'out-lon', { lon: -104.95 });
    await insert(day, 9, 50, 'bad-quality', { quality: 10 });
    await insert(day, 9, 50, 'bad-physics', { violations: '["dew point"]' });
    await insert(day, 9, 99, 'too-hot');
    await insert(day, 9, 50, null);
    const out = await history(14);
    expect(dayOf(out, day)).toMatchObject({ minC: 20, maxC: 20, meanC: 20 });
  });

  it('keeps an empty cell honest: null days, sampleCount 0', async () => {
    const out = await getTemperatureHistory(runner(), { latE1: 1, lonE1: 1, days: 3 }, NOW);
    expect(out.sampleCount).toBe(0);
    expect(out.daily.every((x) => x.meanC === null)).toBe(true);
  });

  it('a pre-cutoff write still pending at first publication can never change the released day once it commits', async () => {
    const day = '2026-09-08';
    await fill(day, 5, 10, 'pend-base');
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      // qualifies (received before the cutoff) but is uncommitted, so invisible to the first release
      await writer.query(
        `INSERT INTO weather_submissions (station_id, latitude, longitude, temperature, submitted_at, received_at)
         VALUES ('pending-writer', $1, $2, 40, '2026-09-08T12:00:00Z', '2026-09-08T12:00:01Z')`,
        [INSIDE.lat, INSIDE.lon]
      );
      const first = await history(30); // first publication of the day, while the write is pending
      expect(dayOf(first, day)).toMatchObject({ minC: 10, maxC: 10, meanC: 10 });
      await writer.query('COMMIT');
    } finally {
      writer.release();
    }
    const later = await history(30);
    expect(dayOf(later, day)).toEqual(dayOf(await history(1, new Date('2026-09-09T05:00:00Z')), day));
    expect(dayOf(later, day)).toMatchObject({ minC: 10, maxC: 10, meanC: 10 }); // not 40 / 15
    // control: a fresh release of the same day WOULD now include the committed write
    await unrelease(day);
    expect(dayOf(await history(30), day)).toMatchObject({ maxC: 40, meanC: 15 });
  });

  it('a pending write cannot turn a suppressed day into an exposed one either (and never the reverse)', async () => {
    const day = '2026-09-07';
    await fill(day, 4, 10, 'supp-base');
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO weather_submissions (station_id, latitude, longitude, temperature, submitted_at, received_at)
         VALUES ('pending-fifth', $1, $2, 10, '2026-09-07T12:00:00Z', '2026-09-07T12:00:01Z')`,
        [INSIDE.lat, INSIDE.lon]
      );
      expect(dayOf(await history(30), day)?.meanC).toBeNull();
      await writer.query('COMMIT');
    } finally {
      writer.release();
    }
    expect(dayOf(await history(30), day)?.meanC).toBeNull(); // the suppressed release is frozen as NULLs
    const row = (await releases()).find((r: any) => new Date(r.day).toISOString().startsWith(day));
    expect(row).toMatchObject({ min_c: null, max_c: null, mean_c: null, count_bucket: null });
  });

  it('concurrent first reads produce ONE release row per day and identical answers', async () => {
    const day = '2026-09-06';
    await fill(day, 6, 9, 'conc');
    const results = await Promise.all([1, 2, 3, 4].map(() => history(30)));
    for (const r of results) expect(dayOf(r, day)).toEqual(dayOf(results[0], day));
    const rows = (await releases()).filter((r: any) => new Date(r.day).toISOString().startsWith(day));
    expect(rows).toHaveLength(1);
    expect(dayOf(results[0], day)).toMatchObject({ minC: 9, maxC: 9, meanC: 9 });
  });

  it('a read that loses the race on an uncommitted first release keeps the first release (ON CONFLICT DO NOTHING), even if its own aggregate differs', async () => {
    const day = '2026-09-04';
    await fill(day, 5, 10, 'race');
    let releasedSignal!: () => void;
    const released = new Promise<void>((resolve) => { releasedSignal = resolve; });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const paused: TransactionRunner = async (callback) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await callback({
          execute: async (sql, params) => {
            const rows = (await client.query(sql, params as any[])).rows;
            if (sql === RELEASE_SQL) { releasedSignal(); await gate; } // first release inserted, NOT committed
            return { rows };
          },
        });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    };
    const first = getTemperatureHistory(paused, { ...CELL, days: 30 }, NOW);
    await released;
    await insert(day, 12, 40, 'race-sixth'); // committed while the first release is still open
    const second = history(30); // blocks on the primary key, its own aggregate would be 15
    await new Promise((resolve) => setTimeout(resolve, 300));
    open();
    const [a, b] = await Promise.all([first, second]);
    expect(dayOf(a, day)).toMatchObject({ meanC: 10 });
    expect(dayOf(b, day)).toEqual(dayOf(a, day));
    const rows = (await releases()).filter((r: any) => new Date(r.day).toISOString().startsWith(day));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].mean_c)).toBe(10);
  });

  it('stores exactly what is served: rounded to 0.5 C, count rounded down to a multiple of 10, no extra rows for empty days or cells', async () => {
    const day = '2026-09-05';
    for (let i = 0; i < 12; i += 1) await insert(day, 6 + (i % 10), 10.2 + (i % 2) * 0.04, `round-${i}`);
    await history(30);
    const row = (await releases()).find((r: any) => new Date(r.day).toISOString().startsWith(day));
    expect(Number(row.min_c)).toBe(10);
    expect(Number(row.max_c)).toBe(10);
    expect(Number(row.mean_c)).toBe(10);
    expect(row.count_bucket).toBe(10); // 12 readings -> 10
    expect(row.lat_e1).toBe(400);
    expect(row.lon_e1).toBe(-1050);
    // a cell with no data stores nothing (write amplification follows real data only)
    await getTemperatureHistory(runner(), { latE1: 5, lonE1: 5, days: 14 }, NOW);
    expect((await releases()).filter((r: any) => r.lat_e1 === 5)).toHaveLength(0);
    // released days of one cell never exceed the requested window
    expect((await releases()).filter((r: any) => r.lat_e1 === 400).length).toBeLessThanOrEqual(30);
  });

  it('the release table rejects partially NULL rows and out-of-range cells', async () => {
    await expect(pool.query(`INSERT INTO weather_temperature_daily_release (lat_e1, lon_e1, day, min_c) VALUES (1, 1, '2020-01-01', 1)`)).rejects.toThrow();
    await expect(pool.query(`INSERT INTO weather_temperature_daily_release (lat_e1, lon_e1, day) VALUES (901, 1, '2020-01-01')`)).rejects.toThrow();
  });

  it('migration 0027 backfilled legacy rows from reading time, never a future time, NOT NULL with a server default', async () => {
    const legacy = await pool.query(`SELECT station_id, submitted_at, received_at FROM weather_submissions WHERE station_id LIKE 'legacy-%' ORDER BY station_id`);
    for (const row of legacy.rows.filter((r: any) => r.station_id !== 'legacy-future')) {
      expect(new Date(row.received_at).toISOString()).toBe(new Date(row.submitted_at).toISOString());
    }
    const future = legacy.rows.find((r: any) => r.station_id === 'legacy-future');
    expect(new Date(future.received_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const col = await pool.query(
      `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'weather_submissions' AND column_name = 'received_at'`,
      [SCHEMA]
    );
    expect(col.rows[0].is_nullable).toBe('NO');
    expect(col.rows[0].column_default).toMatch(/now\(\)/);
    // legacy rows count toward their (published) day
    const out = await getTemperatureHistory(runner(), { ...CELL, days: 30 }, NOW);
    expect(dayOf(out, '2026-09-10')).toMatchObject({ minC: 12, maxC: 12, meanC: 12 });
  });

  it('a row that relies on the DEFAULT gets the server clock (now), so a backdated reading inserted today never counts toward a past day', async () => {
    const day = '2026-09-12';
    await fill(day, 5, 10);
    const before = await history(30);
    expect(dayOf(before, day)?.meanC).toBe(10);
    // Same column list as the real writers (no received_at): the default applies.
    await pool.query(
      `INSERT INTO weather_submissions (station_id, latitude, longitude, temperature, quality_score, physics_violations, submitted_at)
       VALUES ('late-default', $1, $2, 40, 100, '[]'::jsonb, '2026-09-12T10:00:00Z')`,
      [INSIDE.lat, INSIDE.lon]
    );
    const stored = await pool.query(`SELECT received_at FROM weather_submissions WHERE station_id = 'late-default'`);
    expect(Math.abs(new Date(stored.rows[0].received_at).getTime() - Date.now())).toBeLessThan(10_000);
    const after = await history(30);
    expect(dayOf(after, day)).toEqual(dayOf(before, day));
    expect(after.sampleCount).toBe(before.sampleCount);
  });

  it('a backdated row received after the cutoff cannot change a published day, however often it is read', async () => {
    const day = '2026-09-13';
    await fill(day, 5, 10);
    const first = await history(30);
    await insert(day, 12, 40, 'backdated', { received: '2026-09-15T00:00:00Z' }); // D_end + grace is 2026-09-14T02:00Z
    await insert(day, 13, 40, 'backdated-2', { received: '2026-09-14T02:00:01Z' }); // one second past the cutoff
    const second = await history(30);
    const third = await history(1, new Date('2026-09-14T09:00:00Z'));
    expect(dayOf(second, day)).toEqual(dayOf(first, day));
    expect(second.sampleCount).toBe(first.sampleCount);
    expect(dayOf(third, day)).toEqual(dayOf(first, day));
    expect(dayOf(first, day)?.meanC).toBe(10);
  });

  it('a row received exactly at the cutoff still counts (received_at <= D_end + 2 h)', async () => {
    const day = '2026-09-14';
    await fill(day, 4, 10);
    await insert(day, 23, 10, 'on-the-line', { received: '2026-09-15T02:00:00Z' });
    expect(dayOf(await history(30), day)?.meanC).toBe(10);
  });

  it('a day inside the grace window is not shown, and appears (unchanged) once the grace has passed', async () => {
    const day = '2026-09-16';
    await fill(day, 5, 7);
    const inGrace = await getTemperatureHistory(runner(), { ...CELL, days: 2 }, new Date('2026-09-17T01:59:59Z'));
    expect(inGrace.daily.map((x) => x.date)).toEqual(['2026-09-14', '2026-09-15']);
    expect(dayOf(inGrace, day)).toBeUndefined();
    const after = await getTemperatureHistory(runner(), { ...CELL, days: 2 }, new Date('2026-09-17T02:00:00Z'));
    expect(after.daily.map((x) => x.date)).toEqual(['2026-09-15', '2026-09-16']);
    expect(dayOf(after, day)).toMatchObject({ minC: 7, maxC: 7, meanC: 7 });
    const later = await getTemperatureHistory(runner(), { ...CELL, days: 10 }, new Date('2026-09-25T12:00:00Z'));
    expect(dayOf(later, day)).toEqual(dayOf(after, day));
  });

  it('sets a LOCAL statement_timeout of 5 s inside the transaction and does not leak it', async () => {
    const shown: { timeout?: string } = {};
    await getTemperatureHistory(runner(shown), { ...CELL, days: 1 }, NOW);
    expect(shown.timeout).toBe('5s');
    const client = await pool.connect();
    try {
      expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0');
    } finally {
      client.release();
    }
  });

  it('the database cancels a slow statement at the deadline (57014) and nothing later runs', async () => {
    const started: string[] = [];
    const slow: TransactionRunner = async (callback) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        return await callback({
          execute: async (sql, params) => {
            started.push(sql.slice(0, 40));
            if (/FROM weather_submissions/.test(sql)) {
              await client.query("SELECT set_config('statement_timeout', '100', true)");
              await client.query('SELECT pg_sleep(3)');
            }
            return { rows: (await client.query(sql, params as any[])).rows };
          },
        });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    const began = Date.now();
    await expect(getTemperatureHistory(slow, { ...CELL, days: 1 }, NOW)).rejects.toMatchObject({ code: '57014' });
    expect(Date.now() - began).toBeLessThan(2500);
    expect(started.filter((s) => /FROM weather_submissions|WITH eligible/.test(s))).toHaveLength(1);
  });

  it('the real router returns 503 on a database timeout and daily-only JSON otherwise', async () => {
    const app = express();
    app.use('/t', createWeatherTemperatureHistoryRouter(runner()));
    const ok = await request(app).get('/t?latE1=400&lonE1=-1050&days=14');
    expect(ok.status).toBe(200);
    expect(ok.body.hours).toBeUndefined();
    expect(JSON.stringify(ok.body)).not.toMatch(/"(samples|station|wallet|device|latitude|longitude)/);

    const timing: TransactionRunner = async () => {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    };
    const app2 = express();
    app2.use('/t', createWeatherTemperatureHistoryRouter(timing));
    expect((await request(app2).get('/t?latE1=400&lonE1=-1050')).status).toBe(503);
  });
});
