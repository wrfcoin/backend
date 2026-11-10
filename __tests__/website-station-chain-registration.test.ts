/**
 * Website stations: the owner's ownership proof, the operator export for the
 * on-chain registration batch, and the reconcile that marks a station earning
 * (or blocked) only from what the chain registry shows. Made-up wallets,
 * stations and positions only; no governance key anywhere.
 *
 * The pool here is an in-memory model keyed on the service's own SQL constants.
 * The statements themselves run against real PostgreSQL in
 * website-station-chain-registration-pg.integration.test.ts.
 */
import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import {
  ADOPT_WEBSITE_STATION_ON_CHAIN_SQL,
  MARK_BLOCKED_SQL,
  MARK_REGISTERED_ON_CHAIN_SQL,
  NEUTRAL_STATION_ID_RE,
  OWNED_STATION_SQL,
  UPSERT_OWNERSHIP_PROOF_SQL,
  getChainRegistrationStatus,
  newNeutralStationId,
  reconcileWebsiteStations,
  resolveWebsiteStationChain,
  submitOwnershipProof,
  websiteStationChainRegistrationEnabled,
  type ChainRegistrationPool,
} from '../server/services/website-station-chain-registration';
import {
  SELECT_NOT_READY_WEBSITE_STATIONS_SQL,
  SELECT_READY_WEBSITE_STATIONS_SQL,
  WEBSITE_EXPORT_VERSION,
  REASON_CHAIN_READ_FAILED,
  REASON_NO_READING,
  REASON_RATE_LIMITED,
  buildWebsiteCliBatch,
  buildWebsiteExportArtifact,
  chainTailEvidence,
  onTenthGrid,
  runWebsiteExportCli,
  type ChainEvidence,
  type WebsiteExportCliDeps,
  type WebsiteExportRow,
} from '../server/services/website-station-export';
import { buildStationOwnershipMessage } from '../shared/mobile-station-messages';
import { runStationSyncOnce, type ChainStationListEntry } from '../server/services/chain-station-sync';

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

const CHAIN = { chainId: '888', networkId: 'testnet' };
const proofFor = (w: ReturnType<typeof wallet>, stationId: string, chain = CHAIN) => ({
  owner_pubkey: w.publicKey,
  owner_signature: w.sign(buildStationOwnershipMessage({ ...chain, stationId, ownerAddress: w.address })),
});

// A made-up position that is deliberately off the 0.1 degree grid, computed so
// no fine coordinate is written down anywhere.
const OFF_GRID_LAT = 10 + 1 / 3;
const OFF_GRID_LON = -(20 + 2 / 3);

const NEUTRAL = 'pws-0123456789abcdef';
const NEUTRAL_2 = 'pws-fedcba9876543210';
const NAMED = 'pws-fixture-garden-a1b2c3';

interface Station {
  station_id: string; owner_address: string; is_active?: boolean; latitude?: number | null; longitude?: number | null;
  ingestion?: boolean; credentials?: boolean; observations24h?: number; lastAgeMinutes?: number | null;
}
interface Reg {
  station_id: string; owner_address: string; owner_pubkey: string | null; ownership_signature: string | null;
  status: string; blocked_reason?: string | null;
}

/** In-memory stand-in for the tables, with each statement's rule written out in JS. */
function fakeDb(stations: Station[], regs: Reg[] = []) {
  const ws = new Map(stations.map((s) => [s.station_id, {
    is_active: true, latitude: 10.3, longitude: -20.7, ingestion: true, credentials: true, observations24h: 3,
    lastAgeMinutes: 12, ...s,
  }]));
  const reg = new Map(regs.map((r) => [r.station_id, { blocked_reason: null, ...r }]));
  const statements: string[] = [];
  const ingestionActive = (s: Station) => s.ingestion === true && s.credentials === true;
  const notReadyReason = (r: Reg, allow: string[]): string | null => {
    const s = ws.get(r.station_id)!;
    if (s.is_active !== true) return 'station is not active';
    if (s.owner_address.toLowerCase() !== r.owner_address) return 'the station now belongs to a different owner';
    if (s.latitude == null || s.longitude == null) return 'station has no usable position';
    if (!ingestionActive(s)) return 'provider credentials are not verified or ingestion is not active';
    if (!NEUTRAL_STATION_ID_RE.test(r.station_id) && !allow.includes(r.station_id)) {
      return 'station id is not a neutral id (it may hold a name); pass --allow-id to include it';
    }
    return null;
  };
  const pool: ChainRegistrationPool = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      if (sql === OWNED_STATION_SQL) {
        const [id, owner] = params as [string, string];
        const s = ws.get(id);
        if (!s || s.owner_address.toLowerCase() !== owner) return { rows: [] };
        const r = reg.get(id);
        const mine = r && r.owner_address === owner ? r : undefined;
        return { rows: [{
          station_id: id, status: mine?.status ?? null, blocked_reason: mine?.blocked_reason ?? null,
          ingestion_active: ingestionActive(s), observations_24h: s.observations24h,
        }] };
      }
      if (sql === UPSERT_OWNERSHIP_PROOF_SQL) {
        const [id, owner, pubkey, signature] = params as string[];
        const current = reg.get(id);
        if (current && !(current.owner_address !== owner || current.status === 'db_only')) return { rows: [], rowCount: 0 };
        reg.set(id, { station_id: id, owner_address: owner, owner_pubkey: pubkey, ownership_signature: signature, status: 'db_only', blocked_reason: null });
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      if (sql === MARK_REGISTERED_ON_CHAIN_SQL) {
        const [id, owner] = params as [string, string];
        const r = reg.get(id);
        if (!r || r.owner_address !== owner.toLowerCase() || r.status === 'on_chain') return { rows: [], rowCount: 0 };
        r.status = 'on_chain'; r.blocked_reason = null;
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      if (sql === MARK_BLOCKED_SQL) {
        const [id, owner, reason] = params as [string, string, string];
        const r = reg.get(id);
        const same = r?.owner_address === owner.toLowerCase();
        if (!r || r.status !== 'db_only' || (reason === 'station_id_taken_on_chain' ? same : !same)) return { rows: [], rowCount: 0 };
        r.status = 'blocked'; r.blocked_reason = reason;
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      if (sql === ADOPT_WEBSITE_STATION_ON_CHAIN_SQL) {
        const [id, owner] = params as [string, string];
        const s = ws.get(id);
        if (!s || s.owner_address.toLowerCase() !== owner.toLowerCase() || !s.credentials || reg.has(id)) return { rows: [], rowCount: 0 };
        reg.set(id, { station_id: id, owner_address: owner.toLowerCase(), owner_pubkey: null, ownership_signature: null, status: 'on_chain', blocked_reason: null });
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      if (sql === SELECT_READY_WEBSITE_STATIONS_SQL) {
        const [limit, allowRaw] = params as [number, string];
        const allow = allowRaw ? allowRaw.split(',') : [];
        const rows = [...reg.values()]
          .filter((r) => r.status === 'db_only' && ws.has(r.station_id) && notReadyReason(r, allow) === null)
          .slice(0, limit)
          .map((r) => {
            const s = ws.get(r.station_id)!;
            return {
              station_id: r.station_id, owner_address: r.owner_address, owner_pubkey: r.owner_pubkey,
              ownership_signature: r.ownership_signature, station_owner_address: s.owner_address,
              is_active: s.is_active, latitude: s.latitude, longitude: s.longitude,
              observations_24h: s.observations24h,
              last_observation_age_minutes: s.observations24h ? s.lastAgeMinutes : null,
            };
          });
        return { rows, rowCount: rows.length };
      }
      if (sql === SELECT_NOT_READY_WEBSITE_STATIONS_SQL) {
        const allowRaw = params[1] as string;
        const allow = allowRaw ? allowRaw.split(',') : [];
        const rows = [...reg.values()]
          .filter((r) => r.status === 'db_only' && ws.has(r.station_id))
          .map((r) => ({ station_id: r.station_id, reason: notReadyReason(r, allow) }))
          .filter((r) => r.reason !== null);
        return { rows, rowCount: rows.length };
      }
      // Anything else (the generic sync's own statements) finds nothing and writes nothing.
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool, ws, reg, statements };
}

describe('configuration', () => {
  it('the switch is off unless set to exactly "true"', () => {
    expect(websiteStationChainRegistrationEnabled({})).toBe(false);
    expect(websiteStationChainRegistrationEnabled({ WEBSITE_STATION_CHAIN_REGISTRATION_ENABLED: '1' })).toBe(false);
    expect(websiteStationChainRegistrationEnabled({ WEBSITE_STATION_CHAIN_REGISTRATION_ENABLED: 'true' })).toBe(true);
  });

  it('there is no default chain: both ids must be set and well formed', () => {
    expect(resolveWebsiteStationChain({})).toBeNull();
    expect(resolveWebsiteStationChain({ WRFCOIN_CHAIN_ID: '888' })).toBeNull();
    expect(resolveWebsiteStationChain({ WRFCOIN_NETWORK_ID: 'testnet' })).toBeNull();
    expect(resolveWebsiteStationChain({ WRFCOIN_CHAIN_ID: ' ', WRFCOIN_NETWORK_ID: 'testnet' })).toBeNull();
    expect(resolveWebsiteStationChain({ WRFCOIN_CHAIN_ID: '0x378', WRFCOIN_NETWORK_ID: 'testnet' })).toBeNull();
    expect(resolveWebsiteStationChain({ WRFCOIN_CHAIN_ID: '888', WRFCOIN_NETWORK_ID: 'test net' })).toBeNull();
    expect(resolveWebsiteStationChain({ WRFCOIN_CHAIN_ID: ' 888 ', WRFCOIN_NETWORK_ID: 'testnet' }))
      .toEqual({ chainId: '888', networkId: 'testnet' });
  });

  it('a server-issued station id is pws- plus 16 random hex, with nothing else in it', () => {
    const a = newNeutralStationId();
    expect(a).toMatch(/^pws-[0-9a-f]{16}$/);
    expect(NEUTRAL_STATION_ID_RE.test(a)).toBe(true);
    expect(newNeutralStationId()).not.toBe(a);
    expect(NEUTRAL_STATION_ID_RE.test(NAMED)).toBe(false);
  });
});

describe('submitOwnershipProof', () => {
  const w = wallet(11);
  const ID = NEUTRAL;
  const waiting = (waitingFor: string) => ({ state: 'waiting', stationId: ID, ...CHAIN, waitingFor });

  it('stores a valid proof and reports waiting, with the chain it was checked against; the station is not earning', async () => {
    const db = fakeDb([{ station_id: ID, owner_address: w.address }]);
    const res = await submitOwnershipProof(db.pool, w.address, ID, proofFor(w, ID), CHAIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chainRegistration: waiting('batch') });
    expect(db.reg.get(ID)).toMatchObject({ status: 'db_only', owner_address: w.address, owner_pubkey: w.publicKey });
    expect(await getChainRegistrationStatus(db.pool, ID, w.address, CHAIN)).toEqual(waiting('batch'));
  });

  it('is idempotent: the same proof twice leaves one waiting row', async () => {
    const db = fakeDb([{ station_id: ID, owner_address: w.address }]);
    const first = await submitOwnershipProof(db.pool, w.address, ID, proofFor(w, ID), CHAIN);
    const second = await submitOwnershipProof(db.pool, w.address.toUpperCase().replace('0X', '0x'), ID, proofFor(w, ID), CHAIN);
    expect(second).toEqual(first);
    expect(db.reg.size).toBe(1);
  });

  it('says needs_owner_signature, and which chain to sign for, before any proof', async () => {
    const db = fakeDb([{ station_id: ID, owner_address: w.address }]);
    expect(await getChainRegistrationStatus(db.pool, ID, w.address, CHAIN))
      .toEqual({ state: 'needs_owner_signature', stationId: ID, ...CHAIN });
  });

  it('a waiting station says what it is waiting for', async () => {
    for (const [over, waitingFor] of [
      [{ observations24h: 0 }, 'station_report'],
      [{ ingestion: false }, 'station_report'],
      [{ credentials: false }, 'station_report'],
      [{}, 'batch'],
    ] as Array<[Partial<Station>, string]>) {
      const db = fakeDb([{ station_id: ID, owner_address: w.address, ...over }]);
      await submitOwnershipProof(db.pool, w.address, ID, proofFor(w, ID), CHAIN);
      expect(await getChainRegistrationStatus(db.pool, ID, w.address, CHAIN)).toEqual(waiting(waitingFor));
    }
    // An older id that may hold a name waits for the operator's deliberate choice.
    const db = fakeDb([{ station_id: NAMED, owner_address: w.address }]);
    await submitOwnershipProof(db.pool, w.address, NAMED, proofFor(w, NAMED), CHAIN);
    expect((await getChainRegistrationStatus(db.pool, NAMED, w.address, CHAIN))!.waitingFor).toBe('operator_review');
  });

  it('a station whose readings are only on the chain is not told to "report": the chain tail counts', async () => {
    const NOW = 1_800_000_000_000;
    const db = fakeDb([{ station_id: ID, owner_address: w.address, observations24h: 0 }]);
    await submitOwnershipProof(db.pool, w.address, ID, proofFor(w, ID), CHAIN);
    const at = (last: number | null | Error) => getChainRegistrationStatus(db.pool, ID, w.address, CHAIN, {
      now: () => NOW,
      chainLastSeenMs: async () => { if (last instanceof Error) throw last; return last; },
    });
    expect((await at(NOW - 10 * 60_000))!.waitingFor).toBe('batch');
    // Nothing on chain, older than 24 hours, stamped in the future, or a failed read: still waiting to report.
    for (const last of [null, NOW - 25 * 3_600_000, NOW + 60_000, new Error('node down')]) {
      expect((await at(last))!.waitingFor).toBe('station_report');
    }
    // Ingestion not active is not something a chain reading can waive, and the chain is not asked.
    const off = fakeDb([{ station_id: ID, owner_address: w.address, observations24h: 0, ingestion: false }]);
    await submitOwnershipProof(off.pool, w.address, ID, proofFor(w, ID), CHAIN);
    const asked = jest.fn(async () => NOW);
    expect((await getChainRegistrationStatus(off.pool, ID, w.address, CHAIN, { now: () => NOW, chainLastSeenMs: asked }))!.waitingFor)
      .toBe('station_report');
    expect(asked).not.toHaveBeenCalled();
    // A station with database readings never costs a node read either.
    const fine = fakeDb([{ station_id: ID, owner_address: w.address }]);
    await submitOwnershipProof(fine.pool, w.address, ID, proofFor(w, ID), CHAIN);
    await getChainRegistrationStatus(fine.pool, ID, w.address, CHAIN, { chainLastSeenMs: asked });
    expect(asked).not.toHaveBeenCalled();
  });

  it('answers the same 404 for an unknown station and for somebody else\'s station, and stores nothing', async () => {
    const other = wallet(12);
    const db = fakeDb([{ station_id: ID, owner_address: other.address }]);
    const notMine = await submitOwnershipProof(db.pool, w.address, ID, proofFor(w, ID), CHAIN);
    const unknown = await submitOwnershipProof(db.pool, w.address, NEUTRAL_2, proofFor(w, NEUTRAL_2), CHAIN);
    expect(notMine.status).toBe(404);
    expect(unknown).toEqual(notMine);
    expect(db.reg.size).toBe(0);
    expect(await getChainRegistrationStatus(db.pool, ID, w.address, CHAIN)).toBeNull();
  });

  it('refuses a key that is not the logged-in wallet (a passkey wallet cannot sign this today)', async () => {
    const other = wallet(13);
    const db = fakeDb([{ station_id: ID, owner_address: w.address }]);
    const res = await submitOwnershipProof(db.pool, w.address, ID, proofFor(other, ID), CHAIN);
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe('OWNER_KEY_NOT_THIS_WALLET');
    expect(db.reg.size).toBe(0);
  });

  it('refuses a signature for another station, another chain, or garbage, and names the chain it expected', async () => {
    const db = fakeDb([{ station_id: ID, owner_address: w.address }]);
    for (const proof of [
      proofFor(w, NEUTRAL_2),
      proofFor(w, ID, { chainId: '777', networkId: 'testnet' }),
      proofFor(w, ID, { chainId: '888', networkId: 'mainnet' }),
      { owner_pubkey: w.publicKey, owner_signature: '00'.repeat(64) },
    ]) {
      const res = await submitOwnershipProof(db.pool, w.address, ID, proof, CHAIN);
      expect(res.status).toBe(400);
      const error = res.body.error as { code: string; message: string };
      expect(error.code).toBe('OWNERSHIP_SIGNATURE_INVALID');
      expect(error.message).toContain('chain 888 (testnet)');
    }
    expect(db.reg.size).toBe(0);
  });

  it('refuses malformed input, a phone station id and a missing wallet before any query', async () => {
    const db = fakeDb([{ station_id: ID, owner_address: w.address }]);
    expect((await submitOwnershipProof(db.pool, w.address, ID, {}, CHAIN)).status).toBe(400);
    expect((await submitOwnershipProof(db.pool, w.address, ID, { owner_pubkey: 'zz', owner_signature: 'zz' }, CHAIN)).status).toBe(400);
    expect((await submitOwnershipProof(db.pool, w.address, 'mob-' + 'a'.repeat(32), proofFor(w, ID), CHAIN)).status).toBe(400);
    expect((await submitOwnershipProof(db.pool, w.address, 'bad id!', proofFor(w, ID), CHAIN)).status).toBe(400);
    expect((await submitOwnershipProof(db.pool, undefined, ID, proofFor(w, ID), CHAIN)).status).toBe(401);
    expect(db.statements).toEqual([]);
  });

  it('never moves an earning or a blocked station: a proof for either changes nothing', async () => {
    for (const [status, blocked_reason, state] of [
      ['on_chain', null, 'earning'],
      ['blocked', 'station_id_taken_on_chain', 'blocked'],
    ] as Array<[string, string | null, string]>) {
      const db = fakeDb(
        [{ station_id: ID, owner_address: w.address }],
        [{ station_id: ID, owner_address: w.address, owner_pubkey: null, ownership_signature: null, status, blocked_reason }],
      );
      const res = await submitOwnershipProof(db.pool, w.address, ID, proofFor(w, ID), CHAIN);
      expect((res.body.chainRegistration as { state: string }).state).toBe(state);
      expect(db.reg.get(ID)).toMatchObject({ status, owner_pubkey: null });
      expect(db.statements).not.toContain(UPSERT_OWNERSHIP_PROOF_SQL);
    }
  });

  it('no request can set earning or blocked: only the reconcile statements write those', async () => {
    const db = fakeDb([{ station_id: ID, owner_address: w.address }]);
    await submitOwnershipProof(db.pool, w.address, ID, { ...proofFor(w, ID), status: 'on_chain', state: 'earning' }, CHAIN);
    expect(db.reg.get(ID)!.status).toBe('db_only');
    for (const sql of [MARK_REGISTERED_ON_CHAIN_SQL, MARK_BLOCKED_SQL, ADOPT_WEBSITE_STATION_ON_CHAIN_SQL]) {
      expect(db.statements).not.toContain(sql);
    }
  });

  it('after the station changes owner, the new owner never reads the old owner\'s progress and can sign afresh', async () => {
    const old = wallet(14);
    const db = fakeDb(
      [{ station_id: ID, owner_address: w.address }],
      [{ station_id: ID, owner_address: old.address, owner_pubkey: old.publicKey, ownership_signature: 'ab'.repeat(64), status: 'on_chain' }],
    );
    expect((await getChainRegistrationStatus(db.pool, ID, w.address, CHAIN))!.state).toBe('needs_owner_signature');
    const res = await submitOwnershipProof(db.pool, w.address, ID, proofFor(w, ID), CHAIN);
    expect((res.body.chainRegistration as { state: string }).state).toBe('waiting');
    expect(db.reg.get(ID)).toMatchObject({ owner_address: w.address, owner_pubkey: w.publicKey, status: 'db_only' });
  });
});

function exportRow(w: ReturnType<typeof wallet>, stationId: string, over: Partial<WebsiteExportRow> = {}): WebsiteExportRow {
  return {
    stationId,
    ownerAddress: w.address,
    ownerPubkey: w.publicKey,
    ownershipSignature: proofFor(w, stationId).owner_signature,
    stationOwnerAddress: w.address,
    isActive: true,
    latitude: 10.3,
    longitude: -20.7,
    observations24h: 3,
    lastObservationAgeMinutes: 12,
    ...over,
  };
}

describe('buildWebsiteExportArtifact', () => {
  const w = wallet(21);
  const ID = NEUTRAL;

  it('emits what the batch needs, per station, in the phone export\'s shape, plus how recently it reported', () => {
    const { artifact, skipped } = buildWebsiteExportArtifact([exportRow(w, ID)], { ...CHAIN, batchId: 'batch-1' });
    expect(skipped).toEqual([]);
    expect(artifact).toMatchObject({ version: WEBSITE_EXPORT_VERSION, chainId: '888', networkId: 'testnet', batchId: 'batch-1' });
    expect(artifact.stations).toEqual([{
      station_id: ID,
      owner_address: w.address,
      owner_pubkey: w.publicKey,
      owner_signature: expect.stringMatching(/^[0-9a-f]{128}$/),
      latitude: 10.3,
      longitude: -20.7,
      hardware_model: 'personal-weather-station',
      chain_id: '888',
      network_id: 'testnet',
      provenance_class: 'real',
      data_quality_tier: 'unverified',
      evidence: { source: 'db', observations_24h: 3, last_observation_age_minutes: 12 },
    }]);
  });

  it('writes only the 0.1 degree grid point, whatever the stored position is', () => {
    const { artifact, skipped } = buildWebsiteExportArtifact(
      [exportRow(w, ID, { latitude: OFF_GRID_LAT, longitude: OFF_GRID_LON })],
      { ...CHAIN, batchId: 'b' },
    );
    expect(skipped).toEqual([]);
    const s = artifact.stations[0];
    expect(s.latitude).toBe(10.3);
    expect(s.longitude).toBe(-20.7);
    expect(onTenthGrid(s.latitude, 90) && onTenthGrid(s.longitude, 180)).toBe(true);
    // No digit beyond the first decimal anywhere in the artifact's positions.
    expect(JSON.stringify([s.latitude, s.longitude])).toBe('[10.3,-20.7]');
    expect(onTenthGrid(OFF_GRID_LAT, 90)).toBe(false);
  });

  it('never writes "-0" for a position just below zero', () => {
    const { artifact } = buildWebsiteExportArtifact(
      [exportRow(w, ID, { latitude: -1 / 300, longitude: 1 / 300 })],
      { ...CHAIN, batchId: 'b' },
    );
    expect(JSON.stringify([artifact.stations[0].latitude, artifact.stations[0].longitude])).toBe('[0,0]');
  });

  it('the CLI batch row has exactly the ten keys core4 accepts: no chain, cell or evidence keys', () => {
    const { artifact } = buildWebsiteExportArtifact([exportRow(w, ID)], { ...CHAIN, batchId: 'b' });
    const rows = buildWebsiteCliBatch(artifact.stations, 1_800_000_000);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'data_quality_tier', 'hardware_model', 'latitude', 'longitude', 'owner_address', 'owner_pubkey',
      'owner_signature', 'provenance_class', 'station_id', 'submitted_at',
    ]);
    expect(rows[0].submitted_at).toBe(1_800_000_000);
  });

  it('carries no governance key material and no field named like a private key', () => {
    const { artifact } = buildWebsiteExportArtifact([exportRow(w, ID)], { ...CHAIN, batchId: 'b' });
    expect(JSON.stringify(artifact)).not.toMatch(/governance|private|secret|seed|mnemonic/i);
  });

  it('re-checks every row and skips, by id and a fixed reason only, one that must not be signed', () => {
    const other = wallet(22);
    const cases: Array<[Partial<WebsiteExportRow>, string]> = [
      [{ ownershipSignature: '00'.repeat(64) }, 'ownership signature does not verify'],
      [{ stationOwnerAddress: other.address }, 'the station now belongs to a different owner'],
      [{ isActive: false }, 'station is not active'],
      [{ latitude: null }, 'station has no usable position'],
      [{ longitude: 181 }, 'station has no usable position'],
      [{ ownerPubkey: other.publicKey }, 'owner is not derived from the owner pubkey'],
    ];
    for (const [over, reason] of cases) {
      const { artifact, skipped } = buildWebsiteExportArtifact([exportRow(w, ID, over)], { ...CHAIN, batchId: 'b' });
      expect(artifact.stations).toEqual([]);
      expect(skipped).toEqual([{ stationId: ID, reason }]);
    }
    const phone = 'mob-' + 'a'.repeat(32);
    expect(buildWebsiteExportArtifact([exportRow(w, phone)], { ...CHAIN, batchId: 'b' }).skipped)
      .toEqual([{ stationId: phone, reason: 'phone stations use the phone export' }]);
    // Signed for another chain: the preimage binds chain and network.
    expect(buildWebsiteExportArtifact([exportRow(w, ID)], { chainId: '777', networkId: 'testnet', batchId: 'b' }).skipped)
      .toHaveLength(1);
  });

  it('orders by station id and drops a duplicate', () => {
    const { artifact, skipped } = buildWebsiteExportArtifact(
      [exportRow(w, NEUTRAL_2), exportRow(w, NEUTRAL), exportRow(w, NEUTRAL)],
      { ...CHAIN, batchId: 'b' },
    );
    expect(artifact.stations.map((s) => s.station_id)).toEqual([NEUTRAL, NEUTRAL_2]);
    expect(skipped).toEqual([{ stationId: NEUTRAL, reason: 'station appears twice' }]);
  });
});

describe('runWebsiteExportCli', () => {
  const w = wallet(31);
  const ID = NEUTRAL;

  function harness(
    db: ReturnType<typeof fakeDb>,
    chain: WebsiteExportCliDeps['chain'] = CHAIN,
    chainEvidence?: WebsiteExportCliDeps['chainEvidence'],
  ) {
    const files = new Map<string, string>();
    const out: string[] = [];
    const err: string[] = [];
    const deps: WebsiteExportCliDeps = {
      pool: db.pool as WebsiteExportCliDeps['pool'],
      chain,
      chainEvidence,
      writeFile: (path, data) => {
        if (files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        files.set(path, data);
      },
      log: (m) => out.push(m),
      error: (m) => err.push(m),
    };
    return { files, out, err, deps };
  }

  async function dbWith(stations: Station[]) {
    const db = fakeDb(stations.map((s) => ({ latitude: OFF_GRID_LAT, longitude: OFF_GRID_LON, ...s })));
    for (const s of stations) {
      await submitOwnershipProof(db.pool, w.address, s.station_id, proofFor(w, s.station_id), CHAIN);
    }
    return db;
  }
  const waitingDb = () => dbWith([{ station_id: ID, owner_address: w.address }]);

  it('exports the ready station at 0.1 degree and changes no row; a second run gives the same rows', async () => {
    const db = await waitingDb();
    const before = JSON.stringify([...db.reg.values()]);
    const statementsBefore = db.statements.length;
    const h = harness(db);
    const code = await runWebsiteExportCli(
      ['--out', '/x/a.json', '--batch-id', 'b1', '--cli-batch-out', '/x/a-cli.json', '--submitted-at', '1800000000'], h.deps);
    expect(code).toBe(0);
    const artifact = JSON.parse(h.files.get('/x/a.json')!);
    const batch = JSON.parse(h.files.get('/x/a-cli.json')!);
    expect(artifact.stations).toHaveLength(1);
    expect(artifact.not_exported).toEqual([]);
    expect(batch).toEqual([expect.objectContaining({ station_id: ID, latitude: 10.3, longitude: -20.7, submitted_at: 1800000000 })]);
    expect(JSON.stringify([...db.reg.values()])).toBe(before);
    // The export issued two statements, both reads (and no node read: the database had a reading).
    const issued = db.statements.slice(statementsBefore);
    expect(issued).toEqual([SELECT_READY_WEBSITE_STATIONS_SQL, SELECT_NOT_READY_WEBSITE_STATIONS_SQL]);
    for (const sql of issued) {
      expect(sql).toMatch(/^SELECT /);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }

    const again = harness(db);
    expect(await runWebsiteExportCli(['--out', '/x/b.json', '--batch-id', 'b2'], again.deps)).toBe(0);
    expect(JSON.parse(again.files.get('/x/b.json')!).stations).toEqual(artifact.stations);
  });

  it('prints ids, counts and how recently each station reported: no owner, key, signature or position', async () => {
    const db = await waitingDb();
    const h = harness(db);
    await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], h.deps);
    const printed = [...h.out, ...h.err].join('\n');
    expect(printed).toContain(`station ${ID}: source db; 3 reading(s) in 24 h, last 12 min ago`);
    expect(printed).not.toContain(w.address);
    expect(printed).not.toContain(w.publicKey);
    expect(printed).not.toMatch(/[0-9a-f]{64}/);
    expect(printed).not.toMatch(/-?\d+\.\d/);
  });

  it('a station that is not ready never takes a place in the batch: the ready one behind it is still exported', async () => {
    const blockers: Station[] = [
      { station_id: 'pws-00000000000000a1', owner_address: w.address, observations24h: 0 },
      { station_id: 'pws-00000000000000a2', owner_address: w.address, ingestion: false },
      { station_id: 'pws-00000000000000a3', owner_address: w.address, credentials: false },
      { station_id: 'pws-00000000000000a4', owner_address: w.address, is_active: false },
    ];
    const db = await dbWith([...blockers, { station_id: ID, owner_address: w.address }]);
    const h = harness(db);
    expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1', '--limit', '1'], h.deps)).toBe(0);
    const artifact = JSON.parse(h.files.get('/x/a.json')!);
    expect(artifact.stations.map((s: { station_id: string }) => s.station_id)).toEqual([ID]);
    expect(artifact.not_exported).toEqual([
      { stationId: 'pws-00000000000000a2', reason: 'provider credentials are not verified or ingestion is not active' },
      { stationId: 'pws-00000000000000a3', reason: 'provider credentials are not verified or ingestion is not active' },
      { stationId: 'pws-00000000000000a4', reason: 'station is not active' },
      { stationId: 'pws-00000000000000a1', reason: REASON_NO_READING },
    ]);
    expect(h.err.join('\n')).toContain(`not exported pws-00000000000000a1: ${REASON_NO_READING}`);
  });

  it('an id that may hold a name is exported only when the operator names it with --allow-id', async () => {
    const db = await dbWith([{ station_id: NAMED, owner_address: w.address }, { station_id: ID, owner_address: w.address }]);
    const without = harness(db);
    expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], without.deps)).toBe(0);
    const first = JSON.parse(without.files.get('/x/a.json')!);
    expect(first.stations.map((s: { station_id: string }) => s.station_id)).toEqual([ID]);
    expect(first.not_exported).toEqual([{
      stationId: NAMED, reason: 'station id is not a neutral id (it may hold a name); pass --allow-id to include it',
    }]);

    const allowed = harness(db);
    expect(await runWebsiteExportCli(['--out', '/x/b.json', '--batch-id', 'b2', '--allow-id', NAMED], allowed.deps)).toBe(0);
    const second = JSON.parse(allowed.files.get('/x/b.json')!);
    expect(second.stations.map((s: { station_id: string }) => s.station_id).sort()).toEqual([ID, NAMED].sort());
    expect(second.not_exported).toEqual([]);
    expect(allowed.out.join('\n')).toContain(`station ${NAMED}: source db; 3 reading(s) in 24 h, last 12 min ago (allowed by --allow-id)`);
  });

  describe('reporting: the database or the chain tail', () => {
    const SILENT = 'pws-00000000000000b1';
    const silentDb = () => dbWith([{ station_id: SILENT, owner_address: w.address, observations24h: 0 }]);
    const run = async (chainEvidence: WebsiteExportCliDeps['chainEvidence'] | undefined, argv: string[] = []) => {
      const db = await silentDb();
      const h = harness(db, CHAIN, chainEvidence);
      const code = await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1', ...argv], h.deps);
      return { code, h, db, artifact: h.files.has('/x/a.json') ? JSON.parse(h.files.get('/x/a.json')!) : null };
    };

    it('source db: a reading in the database is enough, and the node is never asked', async () => {
      const asked = jest.fn(async (): Promise<ChainEvidence> => ({ kind: 'error' }));
      const db = await waitingDb();
      const h = harness(db, CHAIN, asked);
      expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], h.deps)).toBe(0);
      expect(JSON.parse(h.files.get('/x/a.json')!).stations[0].evidence)
        .toEqual({ source: 'db', observations_24h: 3, last_observation_age_minutes: 12 });
      expect(asked).not.toHaveBeenCalled();
    });

    it('source chain: nothing in the database, a reading in the chain tail: exported, and the line says so', async () => {
      const asked = jest.fn(async (): Promise<ChainEvidence> => ({ kind: 'ok', count: 5, lastAgeMinutes: 4 }));
      const { code, h, artifact } = await run(asked);
      expect(code).toBe(0);
      expect(asked).toHaveBeenCalledWith(SILENT);
      expect(artifact.stations[0].evidence).toEqual({ source: 'chain', observations_24h: 5, last_observation_age_minutes: 4 });
      expect(h.out.join('\n')).toContain(`station ${SILENT}: source chain; 5 reading(s) in the chain tail, last 4 min ago`);
    });

    it('source none: nothing in the database and nothing in the chain tail: stays waiting, with the reason', async () => {
      const { code, h, artifact } = await run(async () => ({ kind: 'ok', count: 0, lastAgeMinutes: null }));
      expect(code).toBe(2);
      expect(artifact).toBeNull();
      expect(h.err.join('\n')).toContain(`not exported ${SILENT}: ${REASON_NO_READING}`);
      expect(REASON_NO_READING).toContain('source none');
    });

    it('a node read that fails, or throws, never exports the station', async () => {
      for (const reader of [
        async (): Promise<ChainEvidence> => ({ kind: 'error' }),
        async (): Promise<ChainEvidence> => { throw new Error('socket hang up at 10.0.0.9'); },
      ]) {
        const { code, h, artifact, db } = await run(reader);
        expect(code).toBe(2);
        expect(artifact).toBeNull();
        expect(h.err.join('\n')).toContain(`not exported ${SILENT}: ${REASON_CHAIN_READ_FAILED}`);
        expect(h.err.join('\n')).not.toContain('10.0.0.9');
        expect(db.reg.get(SILENT)!.status).toBe('db_only');
      }
    });

    it('no chain reader at all: only the database counts', async () => {
      const { code, h } = await run(undefined);
      expect(code).toBe(2);
      expect(h.err.join('\n')).toContain(REASON_NO_READING);
    });

    it('a 429 stops every further node read; stations with database readings are still exported', async () => {
      const stations: Station[] = [
        { station_id: 'pws-00000000000000c1', owner_address: w.address, observations24h: 0 },
        { station_id: 'pws-00000000000000c2', owner_address: w.address, observations24h: 0 },
        { station_id: 'pws-00000000000000c3', owner_address: w.address, observations24h: 0 },
        { station_id: ID, owner_address: w.address },
      ];
      const db = await dbWith(stations);
      const asked = jest.fn(async (id: string): Promise<ChainEvidence> =>
        (id.endsWith('c1') ? { kind: 'ok', count: 2, lastAgeMinutes: 9 } : { kind: 'rate_limited' }));
      const h = harness(db, CHAIN, asked);
      expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], h.deps)).toBe(0);
      const artifact = JSON.parse(h.files.get('/x/a.json')!);
      expect(artifact.stations.map((s: { station_id: string; evidence: { source: string } }) => [s.station_id, s.evidence.source]))
        .toEqual([['pws-00000000000000c1', 'chain'], [ID, 'db']]);
      // c2 got the 429; c3 was never asked.
      expect(asked.mock.calls.map((c) => c[0])).toEqual(['pws-00000000000000c1', 'pws-00000000000000c2']);
      expect(artifact.not_exported).toEqual([
        { stationId: 'pws-00000000000000c2', reason: REASON_RATE_LIMITED },
        { stationId: 'pws-00000000000000c3', reason: REASON_RATE_LIMITED },
      ]);
    });

    it('once the batch is full, no more stations are looked up', async () => {
      const db = await dbWith([
        { station_id: 'pws-00000000000000d1', owner_address: w.address, observations24h: 0 },
        { station_id: 'pws-00000000000000d2', owner_address: w.address, observations24h: 0 },
      ]);
      const asked = jest.fn(async (): Promise<ChainEvidence> => ({ kind: 'ok', count: 1, lastAgeMinutes: 1 }));
      const h = harness(db, CHAIN, asked);
      expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1', '--limit', '1'], h.deps)).toBe(0);
      expect(asked).toHaveBeenCalledTimes(1);
    });

    it('--confirmed-reporting: the caller saw it reporting a moment ago, so no node read is made for it', async () => {
      const asked = jest.fn(async (): Promise<ChainEvidence> => ({ kind: 'error' }));
      const { code, artifact, h } = await run(asked, ['--confirmed-reporting', SILENT]);
      expect(code).toBe(0);
      expect(asked).not.toHaveBeenCalled();
      expect(artifact.stations[0].evidence).toEqual({ source: 'confirmed', observations_24h: 0, last_observation_age_minutes: null });
      expect(h.out.join('\n')).toContain(`station ${SILENT}: source confirmed; reporting confirmed by the caller`);
      // It only waives the reading: a station that fails another rule is still left out.
      const other = await dbWith([{ station_id: SILENT, owner_address: w.address, observations24h: 0, is_active: false }]);
      const again = harness(other, CHAIN, asked);
      expect(await runWebsiteExportCli(['--out', '/x/b.json', '--batch-id', 'b2', '--confirmed-reporting', SILENT], again.deps)).toBe(2);
    });
  });

  describe('chainTailEvidence (the paced look at the node)', () => {
    const NOW = 1_800_000_000_000;
    const secs = (minutesAgo: number) => (NOW - minutesAgo * 60_000) / 1000;
    function reader(read: unknown, calls = 2) {
      let pending = 0;
      const sleep = jest.fn(async () => undefined);
      const evidence = chainTailEvidence({
        latest: async () => { pending += calls; return read as never; },
        takeCallCount: () => { const n = pending; pending = 0; return n; },
        sleep, now: () => NOW,
      });
      return { evidence, sleep };
    }

    it('counts readings stamped in the last 24 hours and reports the newest; future and older stamps do not count', async () => {
      const { evidence, sleep } = reader({ kind: 'ok', complete: true, items: [
        { observed_at: secs(7) }, { observed_at: secs(90) }, { observed_at: secs(25 * 60) }, { observed_at: secs(-5) }, { observed_at: 'x' },
      ] });
      expect(await evidence('pws-x')).toEqual({ kind: 'ok', count: 2, lastAgeMinutes: 7 });
      // Two node calls at 3 s each: about 20 calls a minute.
      expect(sleep).toHaveBeenCalledWith(6_000);
    });

    it('a complete walk with nothing found is "none"; a walk cut short with nothing found is an error', async () => {
      expect(await reader({ kind: 'ok', complete: true, items: [] }).evidence('pws-x')).toEqual({ kind: 'ok', count: 0, lastAgeMinutes: null });
      expect(await reader({ kind: 'ok', complete: false, items: [] }).evidence('pws-x')).toEqual({ kind: 'error' });
    });

    it('429 is rate_limited (and it does not wait); any other refusal or outage is an error', async () => {
      const limited = reader({ kind: 'rejected', status: 429 });
      expect(await limited.evidence('pws-x')).toEqual({ kind: 'rate_limited' });
      expect(limited.sleep).not.toHaveBeenCalled();
      for (const read of [{ kind: 'rejected', status: 400 }, { kind: 'unavailable' }, { kind: 'mismatch' }]) {
        expect(await reader(read).evidence('pws-x')).toEqual({ kind: 'error' });
      }
      const throwing = chainTailEvidence({
        latest: async () => { throw new Error('boom'); }, takeCallCount: () => 0, sleep: async () => undefined,
      });
      expect(await throwing('pws-x')).toEqual({ kind: 'error' });
    });
  });

  it('a blocked station is never exported and never listed as waiting', async () => {
    const db = await waitingDb();
    await reconcileWebsiteStations(
      [{ station_id: ID, owner_address: wallet(32).address, provenance_class: 'real', is_active: true }], db.pool);
    expect(db.reg.get(ID)!.status).toBe('blocked');
    const h = harness(db);
    expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], h.deps)).toBe(2);
    expect(h.files.size).toBe(0);
    expect(h.err.join('\n')).toContain('nothing to export (0 ready row(s) read, 0 not exported)');
  });

  it('refuses to run with no chain configured, before any read', async () => {
    const db = await waitingDb();
    const before = db.statements.length;
    const h = harness(db, null);
    expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('WRFCOIN_CHAIN_ID and WRFCOIN_NETWORK_ID must be set');
    expect(db.statements.length).toBe(before);
    expect(h.files.size).toBe(0);
  });

  it('has no flag that marks rows: --mark-submitted is a usage error and nothing is written', async () => {
    const db = await waitingDb();
    const h = harness(db);
    expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1', '--mark-submitted'], h.deps)).toBe(1);
    expect(h.files.size).toBe(0);
    expect(db.reg.get(ID)!.status).toBe('db_only');
  });

  it('exits 2 when nothing is ready, and once the chain shows the station it is no longer exported', async () => {
    const db = await waitingDb();
    await reconcileWebsiteStations(
      [{ station_id: ID, owner_address: w.address, provenance_class: 'real', is_active: true }], db.pool);
    const h = harness(db);
    expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], h.deps)).toBe(2);
    expect(h.files.size).toBe(0);
  });

  it('refuses bad arguments and never overwrites a file', async () => {
    const db = await waitingDb();
    for (const argv of [
      ['--batch-id', 'b1'],
      ['--out', '/x/a.json', '--batch-id', 'bad id'],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--limit', '22'],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--limit'],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--cli-batch-out', '/x/a.json', '--submitted-at', '5'],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--submitted-at', '5'],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--cli-batch-out', '/x/c.json'],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--allow-id', 'bad,id'],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--allow-id', 'mob-' + '0'.repeat(32)],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--allow-id', NAMED, '--allow-id', NAMED],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--allow-id'],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--confirmed-reporting', 'bad,id'],
      ['--out', '/x/a.json', '--batch-id', 'b1', '--confirmed-reporting', ID, '--confirmed-reporting', ID],
    ]) {
      expect(await runWebsiteExportCli(argv, harness(db).deps)).toBe(1);
    }
    const h = harness(db);
    h.files.set('/x/a.json', 'keep');
    expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], h.deps)).toBe(1);
    expect(h.files.get('/x/a.json')).toBe('keep');
    expect(h.err.join('\n')).toContain('details withheld');
  });
});

describe('reconcile: earning and blocked come only from the chain registry', () => {
  const w = wallet(41);
  const other = wallet(42);
  const ID = NEUTRAL;
  const entry = (over: Partial<ChainStationListEntry> = {}): ChainStationListEntry => ({
    station_id: ID, owner_address: w.address, provenance_class: 'real', is_active: true,
    latitude: 10.3, longitude: -20.7, ...over,
  });
  const run = (db: ReturnType<typeof fakeDb>, entries: ChainStationListEntry[], websiteStations = true) =>
    runStationSyncOnce({ listStations: async () => entries, labels: {}, pool: db.pool as any, websiteStations });

  async function waitingDb(over: Partial<Station> = {}) {
    const db = fakeDb([{ station_id: ID, owner_address: w.address, ...over }]);
    await submitOwnershipProof(db.pool, w.address, ID, proofFor(w, ID), CHAIN);
    return db;
  }
  const state = async (db: ReturnType<typeof fakeDb>) => (await getChainRegistrationStatus(db.pool, ID, w.address, CHAIN))!;

  it('flips waiting to earning when the registry shows the station active, real and owned by the same wallet', async () => {
    const db = await waitingDb();
    const out = await run(db, [entry()]);
    expect(out).toMatchObject({ websiteOnChain: 1, websiteBlocked: 0, websiteFailed: 0 });
    expect(await state(db)).toEqual({ state: 'earning', stationId: ID, ...CHAIN });
    // A second pass has nothing new to mark.
    expect((await run(db, [entry()])).websiteOnChain).toBe(0);
  });

  it('stays waiting while the registry does not list the station', async () => {
    const db = await waitingDb();
    expect(await run(db, [])).toMatchObject({ websiteOnChain: 0, websiteBlocked: 0 });
    expect(db.reg.get(ID)!.status).toBe('db_only');
  });

  it('blocks a waiting station whose id the chain already has under another owner, and says why', async () => {
    const db = await waitingDb();
    const out = await run(db, [entry({ owner_address: other.address })]);
    expect(out).toMatchObject({ websiteOnChain: 0, websiteBlocked: 1 });
    expect(await state(db)).toEqual({ state: 'blocked', stationId: ID, ...CHAIN, blockedReason: 'station_id_taken_on_chain' });
    // Blocked is settled: a later pass does not count it again.
    expect((await run(db, [entry({ owner_address: other.address })])).websiteBlocked).toBe(0);
  });

  it('blocks a waiting station the chain shows under the same owner but inactive or not real', async () => {
    for (const over of [{ is_active: false }, { provenance_class: 'synthetic' }]) {
      const db = await waitingDb();
      expect(await run(db, [entry(over)])).toMatchObject({ websiteOnChain: 0, websiteBlocked: 1 });
      expect(await state(db)).toMatchObject({ state: 'blocked', blockedReason: 'chain_record_not_active' });
    }
  });

  it('a station blocked as inactive becomes earning if the chain later shows it active for the same owner', async () => {
    const db = await waitingDb();
    await run(db, [entry({ is_active: false })]);
    expect((await run(db, [entry()])).websiteOnChain).toBe(1);
    expect((await state(db)).state).toBe('earning');
  });

  it('never downgrades an earning station', async () => {
    const db = await waitingDb();
    await run(db, [entry()]);
    await run(db, [entry({ owner_address: other.address })]);
    await run(db, [entry({ is_active: false })]);
    expect(db.reg.get(ID)!.status).toBe('on_chain');
  });

  it('matches the chain owner case-insensitively', async () => {
    const db = await waitingDb();
    await run(db, [entry({ owner_address: '0x' + w.address.slice(2).toUpperCase() })]);
    expect(db.reg.get(ID)!.status).toBe('on_chain');
  });

  it('records a website station that was registered on chain before any proof was stored', async () => {
    const db = fakeDb([{ station_id: ID, owner_address: w.address }]);
    expect((await run(db, [entry()])).websiteOnChain).toBe(1);
    expect(db.reg.get(ID)).toMatchObject({ status: 'on_chain', owner_pubkey: null, ownership_signature: null });
  });

  it('leaves alone a station the operator back-filled from the chain (no provider credentials)', async () => {
    const db = fakeDb([{ station_id: ID, owner_address: w.address, credentials: false }]);
    expect((await run(db, [entry()])).websiteOnChain).toBe(0);
    expect(db.reg.size).toBe(0);
  });

  it('ignores a chain station the backend has no row for', async () => {
    const db = fakeDb([]);
    expect((await run(db, [entry()])).websiteOnChain).toBe(0);
    expect(db.reg.size).toBe(0);
  });

  it('does nothing and adds no summary field when the switch is off', async () => {
    const db = await waitingDb();
    const out = await run(db, [entry()], false);
    expect('websiteOnChain' in out).toBe(false);
    expect('websiteBlocked' in out).toBe(false);
    expect(db.reg.get(ID)!.status).toBe('db_only');
  });

  it('one entry that fails does not stop the others, and a missing table does not fail the pass', async () => {
    const db = await waitingDb();
    const inner = db.pool.query;
    const flaky = {
      query: async (sql: string, params: unknown[] = []) => {
        if (params[0] === 'pws-00000000000000ff' && sql === MARK_BLOCKED_SQL) {
          throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
        }
        return inner(sql, params);
      },
    };
    const out = await runStationSyncOnce({
      listStations: async () => [entry({ station_id: 'pws-00000000000000ff' }), entry()],
      labels: {}, pool: flaky as any, websiteStations: true,
    });
    expect(out).toMatchObject({ websiteOnChain: 1, websiteFailed: 1 });
    expect(db.reg.get(ID)!.status).toBe('on_chain');
  });
});
