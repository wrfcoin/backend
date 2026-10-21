/**
 * backend#1250: chain → DB station backfill.
 *
 * The pool below models the `weather_stations` table semantics the backfill
 * relies on (station_id unique, ON CONFLICT DO NOTHING, guarded UPDATE), so the
 * tests exercise the write guards rather than string-matching SQL alone.
 */

import {
  SafeDiagnosticError,
  applyBackfill,
  nodeRegistrationFetcher,
  planBackfill,
  validateInput,
  redactOwner,
  type BackfillPool,
  type ChainStationRegistration,
  type FetchChainRegistration,
} from '../server/services/chain-station-backfill.js';

const CHAIN_OWNER = '0x7d29a4fb00000000000000000000000000000001';
const OTHER_OWNER = '0x5eaf842a8341cd38812a63de6b5dcc5103f071c0';

interface Row {
  station_id: string;
  owner_address: string;
  latitude: number | null;
  longitude: number | null;
  name?: string | null;
  location?: string;
  metadata?: unknown;
}

function tablePool(initial: Row[] = []): { pool: BackfillPool; rows: Map<string, Row>; writes: string[] } {
  const rows = new Map(initial.map((r) => [r.station_id, { ...r }]));
  const writes: string[] = [];
  const pool: BackfillPool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT owner_address, latitude, longitude FROM weather_stations')) {
        const r = rows.get(params[0] as string);
        return { rows: r ? [r] : [] };
      }
      if (sql.includes('INSERT INTO weather_stations')) {
        expect(sql).toContain('ON CONFLICT (station_id) DO NOTHING');
        expect(sql).toContain('$8::text::jsonb');
        const id = params[0] as string;
        if (rows.has(id)) return { rows: [], rowCount: 0 };
        rows.set(id, {
          station_id: id,
          owner_address: params[1] as string,
          location: params[2] as string,
          latitude: params[3] as number,
          longitude: params[4] as number,
          name: params[5] as string,
          metadata: JSON.parse(params[7] as string),
        });
        writes.push(`insert ${id}`);
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      if (sql.includes('UPDATE weather_stations')) {
        // Models the SQL faithfully: fill ONLY the NULL column(s) (#1251 review P1).
        expect(sql).toContain('latitude = COALESCE(latitude, $2)');
        expect(sql).toContain('longitude = COALESCE(longitude, $3)');
        const [id, lat, lon, owner] = params as [string, number, number, string];
        const r = rows.get(id);
        if (!r || (r.latitude !== null && r.longitude !== null) || r.owner_address.toLowerCase() !== owner.toLowerCase()) {
          return { rows: [], rowCount: 0 };
        }
        r.latitude = r.latitude ?? lat;
        r.longitude = r.longitude ?? lon;
        writes.push(`fill ${id}`);
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { pool, rows, writes };
}

function chain(regs: Record<string, Partial<ChainStationRegistration> | null | Error>): FetchChainRegistration {
  return async (id: string) => {
    const r = regs[id];
    if (r instanceof Error) throw r;
    if (r === null || r === undefined) return null;
    return {
      station_id: id,
      owner_address: CHAIN_OWNER,
      provenance_class: 'real',
      is_active: true,
      observed_at_height: 24380,
      ...r,
    } as ChainStationRegistration;
  };
}

const JON = { stationId: 'PWS-TEST-A', name: 'Test A', location: 'Town, ST', latitude: 10.123456, longitude: -20.987654, stationType: 'WS-5000' };

describe('backend#1250 chain station backfill', () => {
  test('inserts a chain-registered station with the CHAIN owner, then is idempotent', async () => {
    const { pool, rows, writes } = tablePool();
    const plan = await planBackfill([JON], chain({ 'PWS-TEST-A': {} }), pool);
    expect(plan.map((p) => p.action)).toEqual(['insert']);
    const res = await applyBackfill(plan, pool);
    expect(res[0].written).toBe(true);
    const row = rows.get('PWS-TEST-A')!;
    expect(row.owner_address).toBe(CHAIN_OWNER);
    expect(row.latitude).toBe(10.1); // W21: stored at 0.1 degree, as registerStation stores it
    expect(row.longitude).toBe(-21);
    expect(row.metadata).toMatchObject({ source: 'chain-backfill', provenanceClass: 'real', chainObservedAtHeight: 24380 });

    const again = await planBackfill([JON], chain({ 'PWS-TEST-A': {} }), pool);
    expect(again.map((p) => p.action)).toEqual(['noop']);
    await applyBackfill(again, pool);
    expect(writes).toEqual(['insert PWS-TEST-A']);
  });

  test('refuses an input that tries to carry its own owner', async () => {
    expect(validateInput({ ...JON, ownerAddress: OTHER_OWNER })).toMatch(/owner is read from the chain/);
    const { pool, writes } = tablePool();
    const plan = await planBackfill([{ ...JON, ownerAddress: OTHER_OWNER }], chain({ 'PWS-TEST-A': {} }), pool);
    expect(plan[0].action).toBe('refuse');
    await applyBackfill(plan, pool);
    expect(writes).toEqual([]);
  });

  test.each([
    ['not registered (404)', null, /not registered on chain/],
    ['inactive', { is_active: false }, /not active/],
    ['synthetic provenance', { provenance_class: 'synthetic' }, /not "real"/],
    ['malformed owner', { owner_address: 'wrf1abc' }, /not a 0x-40-hex/],
    ['node error', new SafeDiagnosticError('node answered HTTP 503'), /unreadable: node answered HTTP 503/],
  ])('refuses when the chain says %s', async (_label, reg, reason) => {
    const { pool, writes } = tablePool();
    const plan = await planBackfill([JON], chain({ 'PWS-TEST-A': reg as any }), pool);
    expect(plan[0].action).toBe('refuse');
    expect(plan[0].reason).toMatch(reason);
    await applyBackfill(plan, pool);
    expect(writes).toEqual([]);
  });

  test('never overwrites an existing row whose owner differs from the chain', async () => {
    const { pool, rows, writes } = tablePool([
      { station_id: 'PWS-TEST-A', owner_address: OTHER_OWNER, latitude: null, longitude: null },
    ]);
    const plan = await planBackfill([JON], chain({ 'PWS-TEST-A': {} }), pool);
    expect(plan[0].action).toBe('refuse');
    expect(plan[0].reason).toMatch(/differs from chain owner/);
    expect(plan[0].reason).not.toContain(OTHER_OWNER); // redacted
    await applyBackfill(plan, pool);
    expect(writes).toEqual([]);
    expect(rows.get('PWS-TEST-A')!.owner_address).toBe(OTHER_OWNER);
  });

  test('fills coordinates only for a same-owner row that has none (case-insensitive owner)', async () => {
    const { pool, rows } = tablePool([
      { station_id: 'PWS-TEST-A', owner_address: CHAIN_OWNER.toUpperCase().replace('0X', '0x'), latitude: null, longitude: null, name: 'kept' },
    ]);
    const plan = await planBackfill([JON], chain({ 'PWS-TEST-A': {} }), pool);
    expect(plan[0].action).toBe('fill-coordinates');
    const res = await applyBackfill(plan, pool);
    expect(res[0].written).toBe(true);
    expect(rows.get('PWS-TEST-A')).toMatchObject({ latitude: 10.1, longitude: -21, name: 'kept' });
  });

  test('a same-owner row with coordinates is left untouched (self-service registration wins)', async () => {
    const { pool, rows, writes } = tablePool([
      { station_id: 'PWS-TEST-A', owner_address: CHAIN_OWNER, latitude: 1.5, longitude: 2.5 },
    ]);
    const plan = await planBackfill([JON], chain({ 'PWS-TEST-A': {} }), pool);
    expect(plan[0].action).toBe('noop');
    await applyBackfill(plan, pool);
    expect(writes).toEqual([]);
    expect(rows.get('PWS-TEST-A')).toMatchObject({ latitude: 1.5, longitude: 2.5 });
  });

  test('a row registered between plan and apply is not clobbered', async () => {
    const { pool, rows } = tablePool();
    const plan = await planBackfill([JON], chain({ 'PWS-TEST-A': {} }), pool);
    expect(plan[0].action).toBe('insert');
    rows.set('PWS-TEST-A', { station_id: 'PWS-TEST-A', owner_address: OTHER_OWNER, latitude: 9, longitude: 9 });
    const res = await applyBackfill(plan, pool);
    expect(res[0].written).toBe(false);
    expect(rows.get('PWS-TEST-A')!.owner_address).toBe(OTHER_OWNER);
  });

  test.each([
    [{ ...JON, latitude: 91 }, /latitude/],
    [{ ...JON, longitude: Number.NaN }, /longitude/],
    [{ ...JON, latitude: 0, longitude: 0 }, /placeholder/],
    [{ ...JON, stationId: 'bad id with spaces' }, /stationId/],
    [{ ...JON, stationId: '../x' }, /stationId/],
    [{ ...JON, name: '' }, /name/],
  ])('rejects invalid input %#', (input, reason) => {
    expect(validateInput(input)).toMatch(reason);
  });

  test('duplicate stationIds in one input are refused after the first', async () => {
    const { pool } = tablePool();
    const plan = await planBackfill([JON, JON], chain({ 'PWS-TEST-A': {} }), pool);
    expect(plan.map((p) => p.action)).toEqual(['insert', 'refuse']);
  });

  test('plan reasons never contain a full owner address or coordinates', async () => {
    const { pool } = tablePool();
    const plan = await planBackfill([JON], chain({ 'PWS-TEST-A': {} }), pool);
    const text = plan.map((p) => p.reason).join('\n');
    expect(text).not.toContain(CHAIN_OWNER);
    expect(text).not.toContain('10.12');
    expect(redactOwner(CHAIN_OWNER)).toBe('0x7d29…');
  });

  describe('nodeRegistrationFetcher', () => {
    function fakeFetch(status: number, body: unknown) {
      const calls: Array<{ url: string; init: any }> = [];
      const impl = (async (url: string, init: any) => {
        calls.push({ url, init });
        return { status, ok: status >= 200 && status < 300, json: async () => body } as any;
      }) as unknown as typeof fetch;
      return { impl, calls };
    }

    test('sends the operator bearer and URL-encodes the station id', async () => {
      const { impl, calls } = fakeFetch(200, { station_id: 'A:B', owner_address: CHAIN_OWNER, provenance_class: 'real', is_active: true });
      const reg = await nodeRegistrationFetcher('http://node:8556/', 'tok', impl)('A:B');
      expect(reg?.owner_address).toBe(CHAIN_OWNER);
      expect(calls[0].url).toBe('http://node:8556/transactions/station/registrations/A%3AB');
      expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    });

    test('404 → null; other non-2xx → throws; {ok,data} envelope tolerated', async () => {
      expect(await nodeRegistrationFetcher('http://n', 't', fakeFetch(404, {}).impl)('X')).toBeNull();
      await expect(nodeRegistrationFetcher('http://n', 't', fakeFetch(401, {}).impl)('X')).rejects.toThrow(/HTTP 401/);
      const env = await nodeRegistrationFetcher('http://n', 't', fakeFetch(200, { ok: true, data: { station_id: 'X', owner_address: CHAIN_OWNER } }).impl)('X');
      expect(env?.station_id).toBe('X');
    });
  });
});
