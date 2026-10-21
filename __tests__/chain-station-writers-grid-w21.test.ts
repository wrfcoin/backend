/**
 * W21 (owner ruling 2026-10-01, frontend#437; residual of backend#1401): the chain
 * backfill and the chain sync never persist a station position finer than 0.1
 * degree. Generic stations get the grid point of the chain registration (insert,
 * NULL fill, Q6 overwrite); a mobile station gets the centre of its registered cell,
 * never the chain's point inside that cell (db_only fill, on_chain overwrite). A row
 * already on the grid is never replaced by a finer position. Real Postgres
 * (BACKFILL_TEST_PG_URL, as in CT102 CI). Obviously fake ids, owners and coordinates.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { applyBackfill, planBackfill, type BackfillPool } from '../server/services/chain-station-backfill.js';
import { runStationSyncOnce, type ChainStationListEntry } from '../server/services/chain-station-sync.js';
import { cellCentreDegrees, toStorageGrid } from '../server/utils/coordinate-grid.js';
import { deriveMobileStationId } from '../shared/mobile-station-messages';

const OWNER = '0x00000000000000000000000000000000000000a1';
const OWNER_B = '0x00000000000000000000000000000000000000b2';
const MOB = deriveMobileStationId(OWNER);
const MOB_B = deriveMobileStationId(OWNER_B);
const FINE = /10\.123456|20\.987654|10\.12\b|20\.98\b|10\.149|20\.951|10\.15\b|20\.95\b/;

describe('toStorageGrid / cellCentreDegrees (W21)', () => {
  it('one decimal; -0 never escapes; cell centres are exact tenths', () => {
    expect(toStorageGrid(10.123456)).toBe(10.1);
    expect(toStorageGrid(-20.987654)).toBe(-21);
    expect(toStorageGrid(10.16)).toBe(10.2);
    expect(Object.is(toStorageGrid(-0.04), 0)).toBe(true);
    expect(toStorageGrid(90)).toBe(90);
    expect(toStorageGrid(-180)).toBe(-180);
    expect(cellCentreDegrees(101)).toBe(10.1);
    expect(cellCentreDegrees(-210)).toBe(-21);
    expect(cellCentreDegrees('-3')).toBe(-0.3);
    expect(Object.is(cellCentreDegrees(-0), 0)).toBe(true);
  });
});

const PG_URL = process.env.BACKFILL_TEST_PG_URL;
const d = PG_URL ? describe : describe.skip;
if (!PG_URL && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('BACKFILL_TEST_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('the W21 chain-writer grid test would have been skipped');
  });
}

d('chain backfill and sync store 0.1 degree only, against real Postgres (W21)', () => {
  const schema = `w21_grid_${process.pid}`;
  let sql: ReturnType<typeof postgres>;
  let pool: BackfillPool;

  beforeAll(async () => {
    sql = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe(`CREATE TABLE weather_stations (
      station_id text NOT NULL UNIQUE, owner_address text NOT NULL, location text NOT NULL DEFAULT 'x',
      name text, latitude double precision, longitude double precision, metadata jsonb,
      station_type text, is_active boolean NOT NULL DEFAULT true,
      updated_at timestamp NOT NULL DEFAULT '2000-01-01')`);
    await sql.unsafe(`CREATE TABLE mobile_station_registrations (
      station_id text PRIMARY KEY, owner_address text NOT NULL, status text NOT NULL,
      cell_lat_e1 integer NOT NULL, cell_lon_e1 integer NOT NULL,
      updated_at timestamp NOT NULL DEFAULT '2000-01-01')`);
    pool = { query: async (text, params = []) => { const r = await sql.unsafe(text, params as any[]); return { rows: Array.from(r), count: r.count }; } };
  });
  afterAll(async () => {
    await sql?.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql?.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await sql.unsafe('TRUNCATE weather_stations, mobile_station_registrations');
  });

  const entry = (id: string, over: Partial<ChainStationListEntry> = {}): ChainStationListEntry => ({
    station_id: id,
    owner_address: OWNER,
    provenance_class: 'real',
    is_active: true,
    latitude: 10.123456,
    longitude: -20.987654,
    ...over,
  });
  const LABELS = { 'PWS-W21-A': { name: 'Fake W21 station A' }, 'PWS-W21-B': { name: 'Fake W21 station B' } };
  const sync = (entries: ChainStationListEntry[]) => runStationSyncOnce({ listStations: async () => entries, labels: LABELS, pool });
  const station = async (id: string) =>
    (await sql.unsafe(`SELECT latitude, longitude, updated_at FROM weather_stations WHERE station_id = $1`, [id]))[0];
  const everything = async () =>
    JSON.stringify([
      ...(await sql.unsafe(`SELECT * FROM weather_stations`)),
      ...(await sql.unsafe(`SELECT * FROM mobile_station_registrations`)),
    ]);

  it('generic sync: insert and NULL fill store the grid point', async () => {
    await sql.unsafe(`INSERT INTO weather_stations (station_id, owner_address, latitude, longitude) VALUES ('PWS-W21-B', $1, NULL, NULL)`, [OWNER]);
    const res = await sync([entry('PWS-W21-A'), entry('PWS-W21-B')]);
    expect(res).toMatchObject({ inserted: 1, coordinatesFilled: 1, refused: 0 });
    expect(await station('PWS-W21-A')).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(await station('PWS-W21-B')).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(await everything()).not.toMatch(FINE);
  });

  it('generic sync: a Q6 overwrite stores the grid point, and a legacy finer row converges to it', async () => {
    await sql.unsafe(`INSERT INTO weather_stations (station_id, owner_address, latitude, longitude) VALUES ('PWS-W21-A', $1, 1.5, 2.5), ('PWS-W21-B', $1, 10.123456, -20.987654)`, [OWNER]);
    const res = await sync([entry('PWS-W21-A'), entry('PWS-W21-B')]);
    expect(res).toMatchObject({ coordinatesUpdated: 2, unchanged: 0 });
    expect(await station('PWS-W21-A')).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(await station('PWS-W21-B')).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(await everything()).not.toMatch(FINE);
  });

  it('generic sync: a row already on the grid is never replaced by a finer position (no write, updated_at kept)', async () => {
    await sql.unsafe(`INSERT INTO weather_stations (station_id, owner_address, latitude, longitude) VALUES ('PWS-W21-A', $1, 10.1, -21)`, [OWNER]);
    const res = await sync([entry('PWS-W21-A')]);
    expect(res).toMatchObject({ coordinatesUpdated: 0, unchanged: 1 });
    const row = await station('PWS-W21-A');
    expect(row).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(new Date(row.updated_at).getUTCFullYear()).toBe(2000);
  });

  it('operator backfill: the plan and the stored row carry the grid point; the raw range is checked before rounding', async () => {
    const chainOk = async (id: string) => ({ station_id: id, owner_address: OWNER, provenance_class: 'real', is_active: true });
    const plan = await planBackfill(
      [
        { stationId: 'PWS-W21-A', name: 'Fake W21 station A', latitude: 10.123456, longitude: -20.987654 },
        { stationId: 'PWS-W21-B', name: 'Fake W21 station B', latitude: 90.04, longitude: 0.5 },
      ],
      chainOk,
      pool
    );
    expect(plan.map((p) => p.action)).toEqual(['insert', 'refuse']);
    expect(plan[0].row).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(JSON.stringify(plan)).not.toMatch(FINE);
    await applyBackfill(plan, pool);
    expect(await station('PWS-W21-A')).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(await station('PWS-W21-B')).toBeUndefined();
  });

  it('mobile sync: a db_only fill and an on_chain overwrite store the registered cell centre, not the chain point', async () => {
    // Cells (101, -210): the chain points 10.123456 / -20.987654 and 10.149 / -20.951 lie inside them.
    await sql.unsafe(
      `INSERT INTO mobile_station_registrations (station_id, owner_address, status, cell_lat_e1, cell_lon_e1)
       VALUES ($1, $2, 'db_only', 101, -210), ($3, $4, 'on_chain', 101, -210)`,
      [MOB, OWNER, MOB_B, OWNER_B]
    );
    await sql.unsafe(
      `INSERT INTO weather_stations (station_id, owner_address, latitude, longitude) VALUES ($1, $2, NULL, NULL), ($3, $4, 1.5, 2.5)`,
      [MOB, OWNER, MOB_B, OWNER_B]
    );
    const res = await sync([entry(MOB), entry(MOB_B, { owner_address: OWNER_B, latitude: 10.149, longitude: -20.951 })]);
    expect(res).toMatchObject({ mobileOnChain: 2, mobileRefused: 0 });
    expect(await station(MOB)).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(await station(MOB_B)).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(await everything()).not.toMatch(FINE);
  });

  it('mobile sync: a chain point on the cell edge stores the cell centre, not the neighbouring grid point', async () => {
    // 10.15 / -20.95 is inside cell (101, -210) by the membership rule, but its own
    // grid point is 10.2 / -20.9: the next cell. Only the centre names the signed cell.
    await sql.unsafe(
      `INSERT INTO mobile_station_registrations (station_id, owner_address, status, cell_lat_e1, cell_lon_e1) VALUES ($1, $2, 'db_only', 101, -210)`,
      [MOB, OWNER]
    );
    await sql.unsafe(`INSERT INTO weather_stations (station_id, owner_address, latitude, longitude) VALUES ($1, $2, NULL, NULL)`, [MOB, OWNER]);
    const res = await sync([entry(MOB, { latitude: 10.15, longitude: -20.95 })]);
    expect(res.mobileOnChain).toBe(1);
    expect(await station(MOB)).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(await everything()).not.toMatch(FINE);
  });

  it('mobile sync: a row already at the cell centre is not rewritten by a finer chain point', async () => {
    await sql.unsafe(
      `INSERT INTO mobile_station_registrations (station_id, owner_address, status, cell_lat_e1, cell_lon_e1) VALUES ($1, $2, 'on_chain', 101, -210)`,
      [MOB, OWNER]
    );
    await sql.unsafe(`INSERT INTO weather_stations (station_id, owner_address, latitude, longitude) VALUES ($1, $2, 10.1, -21)`, [MOB, OWNER]);
    const res = await sync([entry(MOB)]);
    expect(res.mobileOnChain).toBe(1);
    const row = await station(MOB);
    expect(row).toMatchObject({ latitude: 10.1, longitude: -21 });
    expect(new Date(row.updated_at).getUTCFullYear()).toBe(2000);
  });

  it('mobile sync: a chain point outside the registered cell is still refused and writes nothing', async () => {
    await sql.unsafe(
      `INSERT INTO mobile_station_registrations (station_id, owner_address, status, cell_lat_e1, cell_lon_e1) VALUES ($1, $2, 'db_only', 101, -210)`,
      [MOB, OWNER]
    );
    await sql.unsafe(`INSERT INTO weather_stations (station_id, owner_address, latitude, longitude) VALUES ($1, $2, NULL, NULL)`, [MOB, OWNER]);
    const res = await sync([entry(MOB, { latitude: 10.2, longitude: -21 })]);
    expect(res).toMatchObject({ mobileOnChain: 0, mobileRefused: 1 });
    expect(await station(MOB)).toMatchObject({ latitude: null, longitude: null });
  });
});
