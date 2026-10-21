/**
 * backend#1288 story B5: operator export of db_only mobile registrations for the
 * on-chain batch ceremony. Synthetic wallets and cells only; no governance key.
 */
import crypto from 'node:crypto';
import {
  buildExportArtifact,
  selectDbOnlyRows,
  markRowsSubmitted,
  EXPORT_VERSION,
  type ExportRow,
} from '../server/services/mobile-station-export';
import {
  buildMobileStationRegistrationMessage,
  buildStationOwnershipMessage,
  deriveMobileStationId,
} from '../shared/mobile-station-messages';
import { verifyEd25519SignatureBytes } from '../server/routes/wallet-auth-service';
import { runExportCli, type ExportCliDeps } from '../server/services/mobile-station-export-cli';

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

function rowFor(w: ReturnType<typeof wallet>, over: Partial<ExportRow> = {}): ExportRow {
  const stationId = deriveMobileStationId(w.address);
  return {
    stationId,
    ownerAddress: w.address,
    ownerPubkey: w.publicKey,
    ownershipSignature: w.sign(buildStationOwnershipMessage({ ...CHAIN, stationId, ownerAddress: w.address })),
    cellLatE1: 123,
    cellLonE1: -456,
    deviceClass: 'phone-barometer',
    ...over,
  };
}

describe('buildExportArtifact (B5)', () => {
  it('emits everything the operator needs for build-registration, per station', () => {
    const w = wallet(41);
    const { artifact, skipped } = buildExportArtifact([rowFor(w)], { ...CHAIN, batchId: 'batch-1' });
    expect(skipped).toEqual([]);
    expect(artifact.version).toBe(EXPORT_VERSION);
    expect(artifact).toMatchObject({ chainId: '777', networkId: 'testnet', batchId: 'batch-1' });
    expect(artifact.stations).toHaveLength(1);
    expect(artifact.stations[0]).toEqual({
      station_id: deriveMobileStationId(w.address),
      owner_address: w.address,
      owner_pubkey: w.publicKey,
      owner_signature: expect.stringMatching(/^[0-9a-f]{128}$/),
      latitude: 12.3,
      longitude: -45.6,
      cell: { lat_e1: 123, lon_e1: -456 },
      hardware_model: 'phone-barometer',
      chain_id: '777',
      network_id: 'testnet',
      provenance_class: 'real',
      data_quality_tier: 'unverified',
    });
  });

  it('exports owner_signature as the PHONE\'s preimage-B signature: verifies under owner_pubkey over B, never over A', () => {
    const w = wallet(60);
    const stationId = deriveMobileStationId(w.address);
    const preimageA = buildMobileStationRegistrationMessage({
      ...CHAIN, stationId, ownerAddress: w.address, collectPubkey: 'ab'.repeat(32), latE1: 123, lonE1: -456, nonce: 'n'.repeat(16), expiresAt: 2_000_000_000,
    });
    const preimageB = buildStationOwnershipMessage({ ...CHAIN, stationId, ownerAddress: w.address });
    // Two different signatures exist per registration (A: registration, B: ownership); export carries B.
    const sigA = w.sign(preimageA);
    const sigB = w.sign(preimageB);
    expect(sigA).not.toBe(sigB);
    const { artifact, skipped } = buildExportArtifact(
      [rowFor(w, { ownershipSignature: sigB })],
      { ...CHAIN, batchId: 'b' }
    );
    expect(skipped).toEqual([]);
    const s = artifact.stations[0];
    expect(s.owner_signature).toBe(sigB);
    expect(verifyEd25519SignatureBytes(s.owner_pubkey, s.owner_signature, preimageB)).toBe(true);
    expect(verifyEd25519SignatureBytes(s.owner_pubkey, s.owner_signature, preimageA)).toBe(false);
    // Handing the exporter the A signature as the ownership signature is refused, not exported.
    const wrong = buildExportArtifact([rowFor(w, { ownershipSignature: sigA })], { ...CHAIN, batchId: 'b' });
    expect(wrong.artifact.stations).toEqual([]);
    expect(wrong.skipped).toHaveLength(1);
  });

  it('core4 golden vector: the exported signature is the one core4 produced over preimage B', () => {
    const golden = {
      publicKeyHex: 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
      ownerAddress: '0x791026e25cc1ba461167ffb5c6dc095c284bd92c',
      stationId: 'mob-0123456789abcdef0123456789abcdef',
      signatureHex:
        '4983b317ac64e109c15426fa4378452bd0053838a27e12608a4c1242280fd9c0b5fe97437f65bce97b8e24876ea81da33e8b9eae5f8ab173bbd8ebd597e4210a',
    };
    // The golden station id is not owner-derived, so the row check refuses it: assert the
    // signature primitive the export relies on, over the same builder, directly.
    const b = buildStationOwnershipMessage({ ...CHAIN, stationId: golden.stationId, ownerAddress: golden.ownerAddress });
    expect(verifyEd25519SignatureBytes(golden.publicKeyHex, golden.signatureHex, b)).toBe(true);
  });

  it('carries no governance key material and no field named like a private key', () => {
    const { artifact } = buildExportArtifact([rowFor(wallet(42))], { ...CHAIN, batchId: 'b' });
    expect(JSON.stringify(artifact)).not.toMatch(/governance|private|secret|seed/i);
  });

  it('skips (by id only) a row whose ownership signature does not verify', () => {
    const w = wallet(43);
    const bad = rowFor(w, { ownershipSignature: '00'.repeat(64) });
    const { artifact, skipped } = buildExportArtifact([bad], { ...CHAIN, batchId: 'b' });
    expect(artifact.stations).toEqual([]);
    expect(skipped).toEqual([{ stationId: bad.stationId, reason: 'ownership signature does not verify' }]);
  });

  it('skips a row signed for a different chain (preimage binds chain/network)', () => {
    const w = wallet(44);
    const { artifact, skipped } = buildExportArtifact([rowFor(w)], { chainId: '778', networkId: 'testnet', batchId: 'b' });
    expect(artifact.stations).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it('skips a row whose owner is not derived from its pubkey, or whose id is not the derived id', () => {
    const w = wallet(45);
    const other = wallet(46);
    const wrongOwner = buildExportArtifact([rowFor(w, { ownerAddress: other.address })], { ...CHAIN, batchId: 'b' });
    expect(wrongOwner.skipped).toHaveLength(1);
    const wrongId = buildExportArtifact([rowFor(w, { stationId: 'mob-' + 'f'.repeat(32) })], { ...CHAIN, batchId: 'b' });
    expect(wrongId.skipped).toHaveLength(1);
  });

  it('skips an off-grid cell', () => {
    const { skipped } = buildExportArtifact([rowFor(wallet(47), { cellLatE1: 901 })], { ...CHAIN, batchId: 'b' });
    expect(skipped).toHaveLength(1);
  });

  it('skips a non-phone device class', () => {
    const { skipped } = buildExportArtifact([rowFor(wallet(48), { deviceClass: 'reference-station' })], { ...CHAIN, batchId: 'b' });
    expect(skipped).toHaveLength(1);
  });

  it('is deterministic: same rows, same bytes, ordered by station id', () => {
    const rows = [rowFor(wallet(51)), rowFor(wallet(52)), rowFor(wallet(53))];
    const a = JSON.stringify(buildExportArtifact(rows, { ...CHAIN, batchId: 'b' }).artifact);
    const b = JSON.stringify(buildExportArtifact([...rows].reverse(), { ...CHAIN, batchId: 'b' }).artifact);
    expect(a).toBe(b);
    const ids = buildExportArtifact(rows, { ...CHAIN, batchId: 'b' }).artifact.stations.map((s) => s.station_id);
    expect(ids).toEqual([...ids].sort());
  });

  it('formats the degrees from integer tenths exactly (no float drift)', () => {
    const { artifact } = buildExportArtifact([rowFor(wallet(54), { cellLatE1: 7, cellLonE1: -3 })], { ...CHAIN, batchId: 'b' });
    expect(artifact.stations[0]).toMatchObject({ latitude: 0.7, longitude: -0.3 });
  });
});

describe('selectDbOnlyRows / markRowsSubmitted (B5)', () => {
  function pool() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    return {
      calls,
      pool: {
        query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          if (sql.startsWith('SELECT')) {
            return { rows: [{
              station_id: 'mob-x', owner_address: '0xabc', owner_pubkey: 'k', ownership_signature: 's',
              cell_lat_e1: 1, cell_lon_e1: 2, device_class: 'phone-barometer',
            }] };
          }
          return { rows: [], rowCount: params[0] && (params[0] as string[]).length };
        },
      },
    };
  }

  it("reads only status = 'db_only' rows, oldest first, bounded", async () => {
    const p = pool();
    const rows = await selectDbOnlyRows(p.pool, 50);
    expect(rows).toEqual([expect.objectContaining({ stationId: 'mob-x', cellLatE1: 1, cellLonE1: 2 })]);
    expect(p.calls[0].sql).toMatch(/status = 'db_only'/);
    expect(p.calls[0].sql).toMatch(/ORDER BY created_at, station_id/);
    expect(p.calls[0].params).toEqual([50]);
  });

  it("marks exactly the given ids submitted, only from db_only, stamping the batch id", async () => {
    const p = pool();
    const n = await markRowsSubmitted(p.pool, ['mob-x', 'mob-y'], 'batch-9');
    expect(n).toBe(2);
    const { sql, params } = p.calls[0];
    expect(sql).toMatch(/SET status = 'submitted'/);
    expect(sql).toMatch(/status = 'db_only'/);
    expect(params).toEqual([['mob-x', 'mob-y'], 'batch-9']);
  });

  it('marks nothing for an empty id list', async () => {
    const p = pool();
    expect(await markRowsSubmitted(p.pool, [], 'b')).toBe(0);
    expect(p.calls).toEqual([]);
  });
});

describe('export CLI: dry-run by default (B5)', () => {
  function harness(rows: ExportRow[]) {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const files = new Map<string, string>();
    const deps: ExportCliDeps = {
      pool: {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.startsWith('SELECT')) {
            return { rows: rows.map((r) => ({
              station_id: r.stationId, owner_address: r.ownerAddress, owner_pubkey: r.ownerPubkey,
              ownership_signature: r.ownershipSignature, cell_lat_e1: r.cellLatE1, cell_lon_e1: r.cellLonE1,
              device_class: r.deviceClass,
            })) };
          }
          writes.push({ sql, params });
          return { rows: [], rowCount: (params[0] as string[]).length };
        },
      },
      chain: CHAIN,
      writeFile: (path, data) => { files.set(path, data); },
      log: () => undefined,
      error: () => undefined,
    };
    return { deps, writes, files };
  }

  it('without --mark-submitted it writes the file and changes NO row', async () => {
    const h = harness([rowFor(wallet(61)), rowFor(wallet(62))]);
    const code = await runExportCli(['--out', '/x/batch.json', '--batch-id', 'b-dry'], h.deps);
    expect(code).toBe(0);
    expect(h.files.get('/x/batch.json')).toBeDefined();
    expect(h.writes).toEqual([]);
  });

  it('with --mark-submitted it marks exactly the exported ids, and not the skipped ones', async () => {
    const good = rowFor(wallet(63));
    const bad = rowFor(wallet(64), { ownershipSignature: '00'.repeat(64) });
    const h = harness([good, bad]);
    const code = await runExportCli(['--out', '/x/batch.json', '--batch-id', 'b-mark', '--mark-submitted'], h.deps);
    expect(code).toBe(0);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].sql).toMatch(/SET status = 'submitted'/);
    expect(h.writes[0].params).toEqual([[good.stationId], 'b-mark']);
  });

  it('marks nothing when the file cannot be written', async () => {
    const h = harness([rowFor(wallet(65))]);
    h.deps.writeFile = () => { throw Object.assign(new Error('nope'), { code: 'EEXIST' }); };
    const code = await runExportCli(['--out', '/x/batch.json', '--batch-id', 'b', '--mark-submitted'], h.deps);
    expect(code).toBe(1);
    expect(h.writes).toEqual([]);
  });
});
