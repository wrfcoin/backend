/**
 * backend#1310: chain-station-sync accepts an on-chain `mob-` station only when
 * a mobile_station_registrations row exists for that id AND the chain owner
 * equals the registered owner (case-normalised); then it fills coordinates and
 * advances the row to `on_chain`. Synthetic ids/owners/coordinates only.
 */
import { runStationSyncOnce, type ChainStationListEntry } from '../server/services/chain-station-sync.js';
import type { BackfillPool } from '../server/services/chain-station-backfill.js';
import { deriveMobileStationId } from '../shared/mobile-station-messages';

const OWNER = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const MOB = deriveMobileStationId(OWNER);

interface Reg { station_id: string; owner_address: string; status: string; cell_lat_e1?: number; cell_lon_e1?: number }
interface Ws { station_id: string; owner_address: string; latitude: number | null; longitude: number | null }

function fakePool(regs: Reg[], stations: Ws[]) {
  // Default cell (123, -456) is the one chainEntry()'s 12.3 / -45.6 sits at the centre of.
  const regMap = new Map(regs.map((r) => [r.station_id, { cell_lat_e1: 123, cell_lon_e1: -456, ...r }]));
  const wsMap = new Map(stations.map((s) => [s.station_id, { ...s }]));
  const statements: string[] = [];
  const pool: BackfillPool = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      if (sql.includes('FROM mobile_station_registrations')) {
        const r = regMap.get(params[0] as string);
        return { rows: r ? [r] : [] };
      }
      if (sql.includes('UPDATE mobile_station_registrations')) {
        const [id, owner] = params as [string, string];
        const r = regMap.get(id);
        if (!r || r.owner_address !== owner.toLowerCase() || r.status === 'on_chain') return { rows: [], rowCount: 0 };
        r.status = 'on_chain';
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      if (sql.includes('UPDATE weather_stations')) {
        const [id, lat, lon, owner] = params as [string, number, number, string];
        const s = wsMap.get(id);
        if (!s || s.owner_address.toLowerCase() !== owner.toLowerCase()) return { rows: [], rowCount: 0 };
        if (sql.includes('IS DISTINCT FROM') && s.latitude === lat && s.longitude === lon) return { rows: [], rowCount: 0 };
        s.latitude = lat;
        s.longitude = lon;
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      // Generic backfill path must never see a mob- id.
      if (sql.includes('weather_stations')) {
        const s = wsMap.get(params[0] as string);
        return { rows: s ? [s] : [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { pool, regMap, wsMap, statements };
}

const chainEntry = (over: Partial<ChainStationListEntry> = {}): ChainStationListEntry => ({
  station_id: MOB,
  owner_address: OWNER,
  provenance_class: 'real',
  is_active: true,
  latitude: 12.3,
  longitude: -45.6,
  ...over,
});

const run = (pool: BackfillPool, entries: ChainStationListEntry[]) =>
  runStationSyncOnce({ listStations: async () => entries, labels: {}, pool });

describe('chain-station-sync: mobile-aware path (#1310)', () => {
  it('accepts a registered mob- station whose owner matches: fills coordinates, sets on_chain (no label needed)', async () => {
    const { pool, regMap, wsMap } = fakePool(
      [{ station_id: MOB, owner_address: OWNER, status: 'submitted' }],
      [{ station_id: MOB, owner_address: OWNER, latitude: null, longitude: null }]
    );
    const out = await run(pool, [chainEntry()]);
    expect(wsMap.get(MOB)).toMatchObject({ latitude: 12.3, longitude: -45.6 });
    expect(regMap.get(MOB)!.status).toBe('on_chain');
    expect(out.mobileOnChain).toBe(1);
    expect(out.mobileRefused).toBe(0);
    expect(out.unlabelled).toBe(0);
  });

  it('matches the owner case-insensitively', async () => {
    const { pool, regMap } = fakePool(
      [{ station_id: MOB, owner_address: OWNER, status: 'db_only' }],
      [{ station_id: MOB, owner_address: OWNER, latitude: null, longitude: null }]
    );
    await run(pool, [chainEntry({ owner_address: OWNER.replace('a1', 'A1').replace('0x', '0x') })]);
    expect(regMap.get(MOB)!.status).toBe('on_chain');
  });

  it('refuses an owner mismatch: nothing written, id logged only', async () => {
    const { pool, regMap, wsMap } = fakePool(
      [{ station_id: MOB, owner_address: OWNER, status: 'db_only' }],
      [{ station_id: MOB, owner_address: OWNER, latitude: null, longitude: null }]
    );
    const out = await run(pool, [chainEntry({ owner_address: OTHER })]);
    expect(regMap.get(MOB)!.status).toBe('db_only');
    expect(wsMap.get(MOB)!.latitude).toBeNull();
    expect(out.mobileOnChain).toBe(0);
    expect(out.mobileRefused).toBe(1);
    expect(out.refusedIds).toContain(MOB);
    const text = JSON.stringify(out.mobile);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain('12.3');
  });

  it.each([
    ['latitude one cell away', { latitude: 12.4 }],
    ['longitude one cell away', { longitude: -45.7 }],
    ['latitude just past half a cell', { latitude: 12.36 }],
    ['a different hemisphere', { latitude: -12.3 }],
  ])('refuses chain coordinates outside the registered cell (%s): nothing written, id only', async (_n, over) => {
    const { pool, regMap, wsMap } = fakePool(
      [{ station_id: MOB, owner_address: OWNER, status: 'submitted' }],
      [{ station_id: MOB, owner_address: OWNER, latitude: null, longitude: null }]
    );
    const out = await run(pool, [chainEntry(over)]);
    expect(regMap.get(MOB)!.status).toBe('submitted');
    expect(wsMap.get(MOB)!.latitude).toBeNull();
    expect(out.mobileOnChain).toBe(0);
    expect(out.mobileRefused).toBe(1);
    expect(out.refusedIds).toContain(MOB);
    const text = JSON.stringify(out.mobile);
    for (const leaked of ['12.4', '-45.7', '12.36', '-12.3', '123', '-456']) expect(text).not.toContain(leaked);
  });

  it('accepts coordinates anywhere within +-0.05 degrees of the cell centre', async () => {
    const { pool, regMap } = fakePool(
      [{ station_id: MOB, owner_address: OWNER, status: 'submitted' }],
      [{ station_id: MOB, owner_address: OWNER, latitude: null, longitude: null }]
    );
    const out = await run(pool, [chainEntry({ latitude: 12.34, longitude: -45.64 })]);
    expect(out.mobileOnChain).toBe(1);
    expect(regMap.get(MOB)!.status).toBe('on_chain');
  });

  it('refuses a registration row whose stored cell is not an integer (fail closed)', async () => {
    const { pool } = fakePool(
      [{ station_id: MOB, owner_address: OWNER, status: 'submitted', cell_lat_e1: undefined as any }],
      [{ station_id: MOB, owner_address: OWNER, latitude: null, longitude: null }]
    );
    // spread order puts the default first, so undefined overrides it
    const out = await run(pool, [chainEntry()]);
    expect(out.mobileRefused).toBe(1);
  });

  it('refuses a mob- station with no registration row (nothing written)', async () => {
    const { pool, wsMap, statements } = fakePool([], []);
    const out = await run(pool, [chainEntry()]);
    expect(out.mobileRefused).toBe(1);
    expect(out.refusedIds).toContain(MOB);
    expect(wsMap.size).toBe(0);
    expect(statements.filter((s) => /^\s*(UPDATE|INSERT)/i.test(s))).toEqual([]);
  });

  it('refuses a case-variant id (exact id match only)', async () => {
    const upper = MOB.toUpperCase();
    const { pool } = fakePool([{ station_id: MOB, owner_address: OWNER, status: 'db_only' }], []);
    const out = await run(pool, [chainEntry({ station_id: upper })]);
    expect(out.mobileOnChain).toBe(0);
    expect(out.mobileRefused).toBe(1);
  });

  it('refuses an inactive or non-real chain station and leaves the row db_only', async () => {
    for (const over of [{ is_active: false }, { provenance_class: 'synthetic' }]) {
      const { pool, regMap } = fakePool(
        [{ station_id: MOB, owner_address: OWNER, status: 'db_only' }],
        [{ station_id: MOB, owner_address: OWNER, latitude: null, longitude: null }]
      );
      const out = await run(pool, [chainEntry(over)]);
      expect(out.mobileRefused).toBe(1);
      expect(regMap.get(MOB)!.status).toBe('db_only');
    }
  });

  it('refuses when there is no weather_stations guard row for the registration', async () => {
    const { pool, regMap } = fakePool([{ station_id: MOB, owner_address: OWNER, status: 'db_only' }], []);
    const out = await run(pool, [chainEntry()]);
    expect(out.mobileRefused).toBe(1);
    expect(regMap.get(MOB)!.status).toBe('db_only');
  });

  it('a registered station already on_chain converges on chain coordinates and stays on_chain', async () => {
    const { pool, regMap, wsMap } = fakePool(
      [{ station_id: MOB, owner_address: OWNER, status: 'on_chain' }],
      [{ station_id: MOB, owner_address: OWNER, latitude: 1, longitude: 2 }]
    );
    const out = await run(pool, [chainEntry()]);
    expect(wsMap.get(MOB)).toMatchObject({ latitude: 12.3, longitude: -45.6 });
    expect(regMap.get(MOB)!.status).toBe('on_chain');
    expect(out.mobileRefused).toBe(0);
  });

  it('does not disturb non-mobile stations in the same pass', async () => {
    const { pool } = fakePool(
      [{ station_id: MOB, owner_address: OWNER, status: 'db_only' }],
      [{ station_id: MOB, owner_address: OWNER, latitude: null, longitude: null }]
    );
    const other: ChainStationListEntry = { ...chainEntry(), station_id: 'PWS-EXAMPLE-1', owner_address: OTHER };
    const out = await run(pool, [chainEntry(), other]);
    expect(out.unlabelled).toBe(1); // the non-mobile station, no label configured
    expect(out.mobileOnChain).toBe(1);
  });
});
