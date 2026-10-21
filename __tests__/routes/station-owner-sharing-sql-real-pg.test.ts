/**
 * backend#1232: the owner/sharing query, executed as written against a real Postgres.
 * Skipped unless MOBILE_STATION_PG_URL names a server (same convention as the other *-real-pg tests;
 * CI's CT102 sets it). The repo has no in-process Postgres (no pg-mem / pglite).
 */
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { dropThrowawayDatabase } from '../helpers/throwaway-db';
import { STATION_OWNER_SHARING_SQL } from '../../server/routes/station-detail-routes.js';

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;

d('STATION_OWNER_SHARING_SQL on real Postgres', () => {
  const dbName = `stnshare_${process.pid}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  let admin: Pool;
  let raw: Pool;
  const A = '0xabc0000000000000000000000000000000000001';

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    raw = new Pool({ connectionString: u.toString(), max: 2 });
    await raw.query('CREATE TABLE weather_stations (id serial PRIMARY KEY, station_id text NOT NULL UNIQUE, owner_address text NOT NULL, is_active boolean DEFAULT true NOT NULL)');
    await raw.query(
      'INSERT INTO weather_stations (station_id, owner_address, is_active) VALUES ($1,$2,true),($3,$4,true),($5,$6,false),($7,$8,true)',
      ['s-solo', '0xdef0000000000000000000000000000000000002',
       's-a1', A, 's-a2-inactive', ` ${A.toUpperCase().replace('0X', '0x')} `, 's-a3', A.toUpperCase().replace('0X', '0x')],
    );
  });
  afterAll(async () => {
    try { await dropThrowawayDatabase(admin, dbName, [raw]); } finally { await admin?.end(); }
  });

  it('a lone owner counts 1', async () => {
    const r = await raw.query(STATION_OWNER_SHARING_SQL, ['s-solo']);
    expect(r.rows[0]).toEqual({ owner_address: '0xdef0000000000000000000000000000000000002', stations_sharing: 1 });
  });

  it('case and surrounding whitespace do not split one owner (active or not)', async () => {
    const r = await raw.query(STATION_OWNER_SHARING_SQL, ['s-a1']);
    expect(r.rows[0]).toEqual({ owner_address: A, stations_sharing: 3 });
    const padded = await raw.query(STATION_OWNER_SHARING_SQL, ['s-a2-inactive']);
    expect(padded.rows[0]).toEqual({ owner_address: A, stations_sharing: 3 });
  });

  it('an unknown station yields no row', async () => {
    expect((await raw.query(STATION_OWNER_SHARING_SQL, ['nope'])).rows).toEqual([]);
  });
});
