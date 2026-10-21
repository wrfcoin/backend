/**
 * `--cli-batch-out`: ADDITIONALLY writes the exact input core4
 * `wrfcoin station build-registration --batch` accepts. core4's RegistrationRow
 * is serde deny_unknown_fields, so the projection must carry ONLY its keys.
 * Fixture coordinates are obviously fake (cell 100/200 tenths = 10.0/20.0).
 */
import crypto from 'node:crypto';
import * as exportBuilders from '../server/services/mobile-station-export';
import {
  buildCliBatch,
  buildExportArtifact,
  type ExportRow,
} from '../server/services/mobile-station-export';
import { runExportCli, type ExportCliDeps } from '../server/services/mobile-station-export-cli';
import { buildStationOwnershipMessage, deriveMobileStationId } from '../shared/mobile-station-messages';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function wallet(seed: number) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  const address = `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 40)}`;
  return { publicKey, address, sign: (m: Buffer) => crypto.sign(null, m, key).toString('hex') };
}
const CHAIN = { chainId: '777', networkId: 'testnet' };
const CORE4_KEYS = [
  'station_id', 'owner_address', 'owner_pubkey', 'owner_signature', 'latitude', 'longitude',
  'hardware_model', 'provenance_class', 'data_quality_tier', 'submitted_at',
];
function rowFor(w: ReturnType<typeof wallet>): ExportRow {
  const stationId = deriveMobileStationId(w.address);
  return {
    stationId, ownerAddress: w.address, ownerPubkey: w.publicKey,
    ownershipSignature: w.sign(buildStationOwnershipMessage({ ...CHAIN, stationId, ownerAddress: w.address })),
    cellLatE1: 100, cellLonE1: 200, deviceClass: 'phone-barometer',
  };
}

describe('buildCliBatch (pure projection)', () => {
  const rows = [rowFor(wallet(71)), rowFor(wallet(72)), rowFor(wallet(73))];
  const { artifact } = buildExportArtifact(rows, { ...CHAIN, batchId: 'b' });

  it('is a bare array with ONLY core4 RegistrationRow keys (no chain_id/network_id/cell)', () => {
    const batch = buildCliBatch(artifact.stations, 1790000000);
    expect(Array.isArray(batch)).toBe(true);
    for (const r of batch) {
      expect(Object.keys(r).sort()).toEqual([...CORE4_KEYS].sort());
      for (const k of ['chain_id', 'network_id', 'cell']) expect(r).not.toHaveProperty(k);
      expect(r.submitted_at).toBe(1790000000);
    }
  });

  it('preserves order and values, and is deterministic', () => {
    const a = buildCliBatch(artifact.stations, 5);
    expect(a.map((r) => r.station_id)).toEqual(artifact.stations.map((s) => s.station_id));
    expect(a[0]).toMatchObject({
      latitude: 10, longitude: 20, hardware_model: 'phone-barometer',
      provenance_class: 'real', data_quality_tier: 'unverified',
    });
    expect(JSON.stringify(buildCliBatch(artifact.stations, 5))).toBe(JSON.stringify(a));
  });
});

describe('export CLI --cli-batch-out', () => {
  function harness(rows: ExportRow[]) {
    const files = new Map<string, string>();
    const logs: string[] = [];
    const errs: string[] = [];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const deps: ExportCliDeps = {
      pool: {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          return sql.startsWith('SELECT')
            ? { rows: rows.map((r) => ({
                station_id: r.stationId, owner_address: r.ownerAddress, owner_pubkey: r.ownerPubkey,
                ownership_signature: r.ownershipSignature, cell_lat_e1: r.cellLatE1, cell_lon_e1: r.cellLonE1,
                device_class: r.deviceClass,
              })) }
            : { rows: [], rowCount: 0 };
        },
      },
      chain: CHAIN,
      writeFile: (path, data) => { files.set(path, data); },
      log: (m) => { logs.push(m); },
      error: (m) => { errs.push(m); },
    };
    return { deps, files, logs, errs, queries };
  }
  const base = ['--out', '/x/full.json', '--batch-id', 'b1'];

  it.each(['64', '1000', undefined])('refuses oversize or missing --limit %s before database or writes', async (limit) => {
    const h = harness([rowFor(wallet(81))]);
    const args = [...base, '--limit', ...(limit === undefined ? [] : [limit])];
    expect(await runExportCli(args, h.deps)).toBe(1);
    expect(h.queries).toEqual([]);
    expect(h.files.size).toBe(0);
    expect(h.errs.join('\n')).toContain('63');
  });

  it('defaults the real selection to the calibrated 21 rows', async () => {
    const h = harness([]);
    expect(await runExportCli(base, h.deps)).toBe(2);
    expect(h.queries[0].params).toEqual([21]);
  });

  it('permits 63 for full exports, but refuses 22 CLI rows before either file or marking', async () => {
    const rows = Array.from({ length: 22 }, (_, i) => rowFor(wallet(90 + i)));
    const full = harness(rows);
    expect(await runExportCli([...base, '--limit', '63'], full.deps)).toBe(0);
    expect(full.queries[0].params).toEqual([63]);
    const h = harness(rows);
    expect(await runExportCli([...base, '--limit', '22', '--cli-batch-out', '/x/cli.json', '--submitted-at', '1790000000', '--mark-submitted'], h.deps)).toBe(1);
    expect(h.files.size).toBe(0);
    expect(h.queries).toHaveLength(1);
    expect(h.errs.join('\n')).toContain('21');
  });

  it('exports a calibrated 21-row CLI batch and marks only after both writes', async () => {
    const h = harness(Array.from({ length: 21 }, (_, i) => rowFor(wallet(120 + i))));
    expect(await runExportCli([...base, '--cli-batch-out', '/x/cli.json', '--submitted-at', '1790000000', '--mark-submitted'], h.deps)).toBe(0);
    expect(JSON.parse(h.files.get('/x/cli.json')!)).toHaveLength(21);
    expect(h.queries).toHaveLength(2);
  });

  it('refuses an oversized UTF-8 projected CLI input before writes or marking', async () => {
    // Exercise the runtime guard against future projection/schema expansion.
    const original = exportBuilders.buildCliBatch;
    const projection = jest.spyOn(exportBuilders, 'buildCliBatch').mockImplementation((stations, timestamp) => {
      const batch = original(stations, timestamp);
      batch[0].hardware_model = '界'.repeat(23000);
      return batch;
    });
    try {
      const h = harness([rowFor(wallet(150))]);
      expect(await runExportCli([...base, '--cli-batch-out', '/x/cli.json', '--submitted-at', '1790000000', '--mark-submitted'], h.deps)).toBe(1);
      expect(h.files.size).toBe(0);
      expect(h.queries).toHaveLength(1);
      expect(h.errs.join('\n')).toContain('65536');
      expect(h.errs.join('\n')).not.toContain('界');
    } finally {
      projection.mockRestore();
    }
  });

  it('writes both files; the batch file is the bare array and the full artifact is unchanged', async () => {
    const h = harness([rowFor(wallet(74)), rowFor(wallet(75))]);
    const code = await runExportCli([...base, '--cli-batch-out', '/x/cli.json', '--submitted-at', '1790000000'], h.deps);
    expect(code).toBe(0);
    const batch = JSON.parse(h.files.get('/x/cli.json')!);
    expect(batch).toHaveLength(2);
    expect(Object.keys(batch[0]).sort()).toEqual([...CORE4_KEYS].sort());
    expect(batch[0].submitted_at).toBe(1790000000);
    expect(JSON.parse(h.files.get('/x/full.json')!).version).toBeDefined();
  });

  it('without --cli-batch-out nothing extra is written', async () => {
    const h = harness([rowFor(wallet(76))]);
    expect(await runExportCli(base, h.deps)).toBe(0);
    expect([...h.files.keys()]).toEqual(['/x/full.json']);
  });

  it.each([
    ['missing --submitted-at', ['--cli-batch-out', '/x/cli.json']],
    ['--submitted-at without --cli-batch-out', ['--submitted-at', '1790000000']],
    ['zero', ['--cli-batch-out', '/x/cli.json', '--submitted-at', '0']],
    ['negative', ['--cli-batch-out', '/x/cli.json', '--submitted-at', '-5']],
    ['fractional', ['--cli-batch-out', '/x/cli.json', '--submitted-at', '1.5']],
    ['non-numeric', ['--cli-batch-out', '/x/cli.json', '--submitted-at', 'now']],
    ['same file as --out', ['--cli-batch-out', '/x/full.json', '--submitted-at', '1790000000']],
  ])('usage error (%s): exit 1, nothing written', async (_l, extra) => {
    const h = harness([rowFor(wallet(77))]);
    expect(await runExportCli([...base, ...extra], h.deps)).toBe(1);
    expect(h.files.size).toBe(0);
  });

  it.each([
    ['trailing --cli-batch-out', [...['--mark-submitted'], '--cli-batch-out']],
    ['trailing --submitted-at', ['--mark-submitted', '--cli-batch-out', '/x/cli.json', '--submitted-at']],
    ['--cli-batch-out followed by another flag', ['--cli-batch-out', '--mark-submitted', '--submitted-at', '1790000000']],
    ['--submitted-at followed by another flag', ['--cli-batch-out', '/x/cli.json', '--submitted-at', '--mark-submitted']],
  ])('a present flag with no value (%s): exit 1, no SELECT, no write, no UPDATE', async (_l, extra) => {
    const h = harness([rowFor(wallet(80))]);
    const queries: string[] = [];
    const inner = h.deps.pool.query;
    h.deps.pool.query = async (sql: string, params?: unknown[]) => { queries.push(sql); return inner(sql, params); };
    expect(await runExportCli([...base, ...extra], h.deps)).toBe(1);
    expect(h.files.size).toBe(0);
    expect(queries).toEqual([]);
  });

  it('never prints coordinates or owner data to stdout/stderr', async () => {
    const w = wallet(78);
    const h = harness([rowFor(w)]);
    await runExportCli([...base, '--cli-batch-out', '/x/cli.json', '--submitted-at', '1790000000'], h.deps);
    const out = [...h.logs, ...h.errs].join('\n');
    expect(out).not.toContain(w.address);
    expect(out).not.toContain(w.publicKey);
    expect(out).not.toMatch(/\b10(\.0)?\b.*\b20(\.0)?\b/);
    expect(out).toContain('/x/cli.json');
  });

  it('a failed batch write (wx: file exists) exits 1 and marks nothing', async () => {
    const h = harness([rowFor(wallet(79))]);
    h.deps.writeFile = (path) => {
      if (path === '/x/cli.json') throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    };
    const code = await runExportCli([...base, '--cli-batch-out', '/x/cli.json', '--submitted-at', '1790000000', '--mark-submitted'], h.deps);
    expect(code).toBe(1);
  });
});
