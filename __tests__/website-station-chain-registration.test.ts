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
  PROVIDER_CHECKS_PER_LIMIT,
  PROVIDER_MAX_BODY_BYTES,
  REASON_CREDENTIALS_INCOMPLETE,
  REASON_NOT_CHECKED,
  REASON_PROVIDER_UNREACHABLE,
  REASON_STATION_REPORT,
  ambientProviderChecker,
  cappedProviderFetch,
  resolveReporting,
  resolveProviderMinIntervalMs,
  buildWebsiteCliBatch,
  buildWebsiteExportArtifact,
  onTenthGrid,
  runWebsiteExportCli,
  type ProviderCheck,
  type ProviderChecker,
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
  ingestion?: boolean; credentials?: boolean; mac?: string | null;
  /** What a fresh provider read would show for this station (the harness's fake provider reads it). */
  provider?: ProviderCheck;
}
interface Reg {
  station_id: string; owner_address: string; owner_pubkey: string | null; ownership_signature: string | null;
  status: string; blocked_reason?: string | null;
}

/** In-memory stand-in for the tables, with each statement's rule written out in JS. */
function fakeDb(stations: Station[], regs: Reg[] = []) {
  const ws = new Map(stations.map((s) => [s.station_id, {
    is_active: true, latitude: 10.3, longitude: -20.7, ingestion: true, credentials: true,
    mac: 'aa:bb:cc:dd:ee:01', provider: { kind: 'fresh', ageMinutes: 12 } as ProviderCheck, ...s,
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
          ingestion_active: ingestionActive(s),
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
        const movable = r && (r.status === 'db_only' || r.status === 'on_chain' || (r.status === 'blocked' && r.blocked_reason !== reason));
        if (!r || !movable || (reason === 'station_id_taken_on_chain' ? same : !same)) return { rows: [], rowCount: 0 };
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
              mac: s.mac, encrypted_api_key: 'enc-api', key_iv: 'iv', key_tag: 'tag',
              encrypted_app_key: 'enc-app', app_iv: 'iv', app_tag: 'tag',
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
  /** The fake provider: answers from the station's `provider` field and records who was asked. */
  const asked: string[] = [];
  const providerCheck: ProviderChecker = async (row) => {
    asked.push(row.stationId);
    return ws.get(row.stationId)!.provider!;
  };
  return { pool, ws, reg, statements, providerCheck, asked };
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
    reportingSource: 'provider',
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
      evidence: { source: 'provider', last_observation_age_minutes: 12 },
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
    providerCheck: WebsiteExportCliDeps['providerCheck'] | null = db.providerCheck,
  ) {
    const files = new Map<string, string>();
    const out: string[] = [];
    const err: string[] = [];
    const deps: WebsiteExportCliDeps = {
      pool: db.pool as WebsiteExportCliDeps['pool'],
      chain,
      ...(providerCheck ? { providerCheck } : {}),
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
    // The export issued two statements, and both are reads.
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
    expect(printed).toContain(`station ${ID}: source provider; last reading 12 min ago`);
    expect(printed).not.toContain(w.address);
    expect(printed).not.toContain(w.publicKey);
    expect(printed).not.toMatch(/[0-9a-f]{64}/);
    expect(printed).not.toMatch(/-?\d+\.\d/);
  });

  it('a station that is not ready never takes a place in the batch: the ready one behind it is still exported', async () => {
    const blockers: Station[] = [
      { station_id: 'pws-00000000000000a1', owner_address: w.address, provider: { kind: 'stale' } },
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
      { stationId: 'pws-00000000000000a1', reason: REASON_STATION_REPORT },
    ]);
    expect(h.err.join('\n')).toContain(`not exported pws-00000000000000a1: ${REASON_STATION_REPORT}`);
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
    expect(allowed.out.join('\n')).toContain(`station ${NAMED}: source provider; last reading 12 min ago (allowed by --allow-id)`);
  });

  describe('reporting: a fresh provider read at export time', () => {
    const run = async (provider: ProviderCheck | Error, argv: string[] = []) => {
      const db = await dbWith([{ station_id: ID, owner_address: w.address, provider: provider instanceof Error ? undefined : provider }]);
      const check: ProviderChecker = provider instanceof Error
        ? async (row) => { db.asked.push(row.stationId); throw provider; }
        : db.providerCheck;
      const h = harness(db, CHAIN, check);
      const code = await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1', ...argv], h.deps);
      return { code, h, db, artifact: h.files.has('/x/a.json') ? JSON.parse(h.files.get('/x/a.json')!) : null };
    };

    it('a fresh reading: exported, and the evidence is the source and the minutes, nothing else', async () => {
      const { code, artifact, h, db } = await run({ kind: 'fresh', ageMinutes: 7 });
      expect(code).toBe(0);
      expect(db.asked).toEqual([ID]);
      expect(artifact.stations[0].evidence).toEqual({ source: 'provider', last_observation_age_minutes: 7 });
      expect(h.out.join('\n')).toContain(`station ${ID}: source provider; last reading 7 min ago`);
    });

    it('a stale reading, or the device missing from the account: stays waiting as station_report', async () => {
      for (const provider of [{ kind: 'stale' }, { kind: 'no_device' }] as ProviderCheck[]) {
        const { code, artifact, h, db } = await run(provider);
        expect(code).toBe(2);
        expect(artifact.stations).toEqual([]);
        expect(artifact.not_exported).toEqual([{ stationId: ID, reason: REASON_STATION_REPORT }]);
        expect(h.err.join('\n')).toContain(`not exported ${ID}: ${REASON_STATION_REPORT}`);
        expect(db.reg.get(ID)!.status).toBe('db_only');
      }
      expect(REASON_STATION_REPORT).toMatch(/^station_report: /);
    });

    it('a provider error, timeout or 429, or a checker that throws: never exported, reason provider_unreachable', async () => {
      for (const provider of [{ kind: 'unreachable' } as ProviderCheck, new Error('GET https://rt.example/v1/devices?apiKey=SECRETKEY failed')]) {
        const { code, artifact, h } = await run(provider);
        expect(code).toBe(2);
        expect(artifact.stations).toEqual([]);
        expect(artifact.not_exported).toEqual([{ stationId: ID, reason: REASON_PROVIDER_UNREACHABLE }]);
        expect([...h.out, ...h.err].join('\n')).not.toContain('SECRETKEY');
      }
      expect(REASON_PROVIDER_UNREACHABLE).toMatch(/^provider_unreachable: /);
    });

    it('no provider checker at all (no encryption key): nothing can be shown to be reporting', async () => {
      const db = await waitingDb();
      const h = harness(db, CHAIN, null);
      expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], h.deps)).toBe(2);
      expect(JSON.parse(h.files.get('/x/a.json')!).not_exported).toEqual([{ stationId: ID, reason: REASON_PROVIDER_UNREACHABLE }]);
    });

    it('one unreachable station does not stop the others; each station is asked once', async () => {
      const db = await dbWith([
        { station_id: 'pws-00000000000000c1', owner_address: w.address, provider: { kind: 'unreachable' } },
        { station_id: 'pws-00000000000000c2', owner_address: w.address, provider: { kind: 'fresh', ageMinutes: 3 } },
        { station_id: 'pws-00000000000000c3', owner_address: w.address, provider: { kind: 'stale' } },
        { station_id: ID, owner_address: w.address },
      ]);
      const h = harness(db);
      expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], h.deps)).toBe(0);
      const artifact = JSON.parse(h.files.get('/x/a.json')!);
      expect(artifact.stations.map((s: { station_id: string }) => s.station_id)).toEqual(['pws-00000000000000c2', ID]);
      expect(artifact.not_exported).toEqual([
        { stationId: 'pws-00000000000000c1', reason: REASON_PROVIDER_UNREACHABLE },
        { stationId: 'pws-00000000000000c3', reason: REASON_STATION_REPORT },
      ]);
      expect(db.asked).toEqual(['pws-00000000000000c1', 'pws-00000000000000c2', 'pws-00000000000000c3', ID]);
    });

    it('once the batch is full, no more stations are read from the provider', async () => {
      const db = await dbWith([
        { station_id: 'pws-00000000000000d1', owner_address: w.address },
        { station_id: 'pws-00000000000000d2', owner_address: w.address },
      ]);
      const h = harness(db);
      expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1', '--limit', '1'], h.deps)).toBe(0);
      expect(db.asked).toEqual(['pws-00000000000000d1']);
    });

    it('--confirmed-reporting: the caller saw it reporting a moment ago, so no provider read is made for it', async () => {
      const { code, artifact, h, db } = await run({ kind: 'unreachable' }, ['--confirmed-reporting', ID]);
      expect(code).toBe(0);
      expect(db.asked).toEqual([]);
      expect(artifact.stations[0].evidence).toEqual({ source: 'confirmed', last_observation_age_minutes: null });
      expect(h.out.join('\n')).toContain(`station ${ID}: source confirmed; reporting confirmed by the caller`);
      // It only waives the provider read: a station that fails another rule is still left out.
      const other = await dbWith([{ station_id: ID, owner_address: w.address, is_active: false }]);
      const again = harness(other);
      expect(await runWebsiteExportCli(['--out', '/x/b.json', '--batch-id', 'b2', '--confirmed-reporting', ID], again.deps)).toBe(2);
    });

    it('nothing ready still writes the artifact, so the reasons reach the operator (exit 2, no CLI batch)', async () => {
      const db = await dbWith([{ station_id: ID, owner_address: w.address, provider: { kind: 'stale' } }]);
      const h = harness(db);
      const code = await runWebsiteExportCli(
        ['--out', '/x/a.json', '--batch-id', 'b1', '--cli-batch-out', '/x/a-cli.json', '--submitted-at', '1800000000'], h.deps);
      expect(code).toBe(2);
      expect([...h.files.keys()]).toEqual(['/x/a.json']);
      const artifact = JSON.parse(h.files.get('/x/a.json')!);
      expect(artifact).toMatchObject({ version: WEBSITE_EXPORT_VERSION, chainId: '888', stations: [] });
      expect(artifact.not_exported).toEqual([{ stationId: ID, reason: REASON_STATION_REPORT }]);
      expect(h.err.join('\n')).toContain('the reasons are in /x/a.json');
    });
  });

  describe('the stamped export (inside the signing window) makes no provider read at all', () => {
    it('with --confirmed-reporting, forty stale and five unreachable stations ahead cost nothing: zero reads, only the confirmed ids', async () => {
      const ahead: Station[] = [
        ...Array.from({ length: 40 }, (_, i) => ({ station_id: `pws-0000000000001${String(i).padStart(3, '0')}`, owner_address: w.address, provider: { kind: 'stale' } as ProviderCheck })),
        ...Array.from({ length: 5 }, (_, i) => ({ station_id: `pws-0000000000002${String(i).padStart(3, '0')}`, owner_address: w.address, provider: { kind: 'unreachable' } as ProviderCheck })),
      ];
      const db = await dbWith([...ahead, { station_id: ID, owner_address: w.address }]);
      let calls = 0;
      const h = harness(db, CHAIN, async () => { calls += 1; throw new Error('the stamped export must not read a provider'); });
      const code = await runWebsiteExportCli(
        ['--out', '/x/a.json', '--batch-id', 'b1', '--cli-batch-out', '/x/a-cli.json', '--submitted-at', '1800000000', '--confirmed-reporting', ID], h.deps);
      expect(code).toBe(0);
      expect(calls).toBe(0);
      const artifact = JSON.parse(h.files.get('/x/a.json')!);
      expect(artifact.stations.map((s: { station_id: string }) => s.station_id)).toEqual([ID]);
      expect(artifact.stations[0].evidence).toEqual({ source: 'confirmed', last_observation_age_minutes: null });
      // The stations ahead are simply not part of this run: no reason is invented for them.
      expect(artifact.not_exported).toEqual([]);
      expect(JSON.parse(h.files.get('/x/a-cli.json')!)).toHaveLength(1);
    });

    it('only confirmed ids are ready, even when others would be fresh; a confirmed id that fails a database rule is still left out', async () => {
      const db = await dbWith([
        { station_id: 'pws-00000000000000e1', owner_address: w.address },
        { station_id: 'pws-00000000000000e2', owner_address: w.address },
        { station_id: 'pws-00000000000000e3', owner_address: w.address, is_active: false },
      ]);
      const h = harness(db);
      const code = await runWebsiteExportCli(
        ['--out', '/x/a.json', '--batch-id', 'b1', '--confirmed-reporting', 'pws-00000000000000e2', '--confirmed-reporting', 'pws-00000000000000e3'], h.deps);
      expect(code).toBe(0);
      expect(db.asked).toEqual([]);
      expect(JSON.parse(h.files.get('/x/a.json')!).stations.map((s: { station_id: string }) => s.station_id)).toEqual(['pws-00000000000000e2']);
    });
  });

  describe('the look is bounded: a check budget, a moving start, incomplete credentials, a deadline', () => {
    const many = (n: number, provider: ProviderCheck): Station[] =>
      Array.from({ length: n }, (_, i) => ({ station_id: `pws-0000000000003${String(i).padStart(3, '0')}`, owner_address: w.address, provider }));

    it('at most 3 provider reads per requested station; the rest are listed as not_checked', async () => {
      expect(PROVIDER_CHECKS_PER_LIMIT).toBe(3);
      const db = await dbWith(many(10, { kind: 'stale' }));
      const h = harness(db);
      expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1', '--limit', '2'], h.deps)).toBe(2);
      expect(db.asked).toHaveLength(6);
      const reasons = JSON.parse(h.files.get('/x/a.json')!).not_exported.map((s: { reason: string }) => s.reason);
      expect(reasons.filter((r: string) => r === REASON_STATION_REPORT)).toHaveLength(6);
      expect(reasons.filter((r: string) => r === REASON_NOT_CHECKED)).toHaveLength(4);
      expect(REASON_NOT_CHECKED).toMatch(/^not_checked: /);
    });

    it('the start moves on from run to run, so the same stale stations do not use up every look', async () => {
      const db = await dbWith([...many(9, { kind: 'stale' }), { station_id: ID, owner_address: w.address }]);
      const first = harness(db);
      first.deps.rotation = 0;
      expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1', '--limit', '1'], first.deps)).toBe(2);
      const firstAsked = [...db.asked];
      expect(firstAsked).toHaveLength(3);
      db.asked.length = 0;
      const later = harness(db);
      later.deps.rotation = 3;
      expect(await runWebsiteExportCli(['--out', '/x/b.json', '--batch-id', 'b2', '--limit', '1'], later.deps)).toBe(0);
      // Rotation 3 starts at station 9 of 10: the ready one is reached on the first read.
      expect(db.asked).toEqual([ID]);
      expect(db.asked.some((id) => firstAsked.includes(id))).toBe(false);
      // A queue that fits in the budget is always walked from the oldest.
      const small = await dbWith(many(2, { kind: 'stale' }));
      const h = harness(small);
      h.deps.rotation = 7;
      await runWebsiteExportCli(['--out', '/x/c.json', '--batch-id', 'b3', '--limit', '1'], h.deps);
      expect(small.asked).toEqual(['pws-0000000000003000', 'pws-0000000000003001']);
    });

    it('no bound device or no stored application key: its own reason, no provider read, and no budget used', async () => {
      const db = await dbWith([{ station_id: 'pws-00000000000000f1', owner_address: w.address, mac: null }, { station_id: ID, owner_address: w.address }]);
      const h = harness(db);
      expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1', '--limit', '1'], h.deps)).toBe(0);
      expect(db.asked).toEqual([ID]);
      expect(JSON.parse(h.files.get('/x/a.json')!).not_exported).toEqual([{ stationId: 'pws-00000000000000f1', reason: REASON_CREDENTIALS_INCOMPLETE }]);
      expect(REASON_CREDENTIALS_INCOMPLETE).toMatch(/^credentials_incomplete: /);

      const base = {
        stationId: ID, ownerAddress: w.address, ownerPubkey: w.publicKey, ownershipSignature: 'ab'.repeat(64),
        stationOwnerAddress: w.address, isActive: true, latitude: 10.3, longitude: -20.7, mac: 'aa:bb:cc:dd:ee:01',
      };
      const keys = { encryptedApiKey: 'a', keyIv: 'i', keyTag: 't', encryptedAppKey: 'b', appIv: 'i', appTag: 't' };
      let reads = 0;
      const providerCheck = async (): Promise<ProviderCheck> => { reads += 1; return { kind: 'fresh', ageMinutes: 1 }; };
      for (const row of [
        { ...base, credentials: { ...keys, encryptedAppKey: null } }, { ...base, credentials: { ...keys, appTag: null } },
        { ...base, credentials: null }, { ...base, mac: 'aa:bb', credentials: keys }, { ...base, mac: null, credentials: keys },
      ]) {
        const res = await resolveReporting([row], 1, { providerCheck });
        expect(res.notReady).toEqual([{ stationId: ID, reason: REASON_CREDENTIALS_INCOMPLETE }]);
        expect(res.checks).toBe(0);
      }
      expect(reads).toBe(0);
    });

    it('--not-after: past that time no provider read is started and nothing is written', async () => {
      const db = await dbWith(many(5, { kind: 'fresh', ageMinutes: 1 }));
      // Already past: no read, no file.
      const late = harness(db);
      late.deps.now = () => 1_800_000_000_000;
      expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1', '--not-after', '1800000000'], late.deps)).toBe(1);
      expect(db.asked).toEqual([]);
      expect(late.files.size).toBe(0);
      expect(late.err.join('\n')).toContain('the --not-after time passed before this export finished; nothing written');
      // Passing during the walk: the reads stop, and still nothing is written.
      let clock = 1_799_999_990_000;
      const during = harness(db, CHAIN, async (row) => { db.asked.push(row.stationId); clock += 6_000; return { kind: 'fresh', ageMinutes: 1 }; });
      during.deps.now = () => clock;
      expect(await runWebsiteExportCli(['--out', '/x/b.json', '--batch-id', 'b2', '--not-after', '1800000000'], during.deps)).toBe(1);
      expect(db.asked).toHaveLength(2);
      expect(during.files.size).toBe(0);
      // In time: written as usual.
      db.asked.length = 0;
      const ok = harness(db);
      ok.deps.now = () => 1_799_999_000_000;
      expect(await runWebsiteExportCli(['--out', '/x/c.json', '--batch-id', 'b3', '--not-after', '1800000000'], ok.deps)).toBe(0);
      for (const bad of ['0', '-5', 'soon', '1.5']) {
        expect(await runWebsiteExportCli(['--out', '/x/d.json', '--batch-id', 'b4', '--not-after', bad], harness(db).deps)).toBe(1);
      }
    });
  });

  describe('cappedProviderFetch (the body cap on the real fetch)', () => {
    const streamOf = (chunks: Uint8Array[]) => {
      let i = 0;
      const state = { cancelled: false, reads: 0 };
      return {
        state,
        body: { getReader: () => ({
          read: async () => { state.reads += 1; return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }; },
          cancel: async () => { state.cancelled = true; },
        }) },
      };
    };
    const init = { method: 'GET' as const, signal: new AbortController().signal, redirect: 'error' as const };

    it('passes the init through, and reads a small answer whole', async () => {
      const seen: unknown[] = [];
      const s = streamOf([Buffer.from('[{"a"'), Buffer.from(':1}]')]);
      const fetchFn = cappedProviderFetch(async (url, i) => { seen.push([url, i.redirect]); return { ok: true, status: 200, body: s.body }; });
      const res = await fetchFn('https://provider.example/x', init);
      expect(await res.text(100)).toBe('[{"a":1}]');
      expect(seen).toEqual([['https://provider.example/x', 'error']]);
    });

    it('a declared length over the cap is refused before reading; a stream is cancelled the moment it passes the cap', async () => {
      const declared = streamOf([Buffer.alloc(10)]);
      const a = await cappedProviderFetch(async () => ({ ok: true, status: 200, headers: { get: () => '5000' }, body: declared.body }))('u', init);
      await expect(a.text(100)).rejects.toThrow('too large');
      expect(declared.state.reads).toBe(0);

      const endless = streamOf(Array.from({ length: 50 }, () => Buffer.alloc(40)));
      const b = await cappedProviderFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, body: endless.body }))('u', init);
      await expect(b.text(100)).rejects.toThrow('too large');
      expect(endless.state.cancelled).toBe(true);
      expect(endless.state.reads).toBe(3);

      const noStream = await cappedProviderFetch(async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(101) }))('u', init);
      await expect(noStream.text(100)).rejects.toThrow('too large');
    });
  });

  describe('ambientProviderChecker (the provider read itself, with a fake provider)', () => {
    const NOW = 1_800_000_000_000;
    const MAC = 'AA:BB:CC:DD:EE:01';
    const row = (over: Partial<WebsiteExportRow> = {}): WebsiteExportRow => ({
      ...exportRowFor(), mac: 'aa-bb-cc-dd-ee-01',
      credentials: { encryptedApiKey: 'enc:APIKEYSECRET', keyIv: 'iv', keyTag: 'tag', encryptedAppKey: 'enc:APPKEYSECRET', appIv: 'iv', appTag: 'tag' },
      ...over,
    });
    const exportRowFor = () => ({
      stationId: ID, ownerAddress: w.address, ownerPubkey: w.publicKey, ownershipSignature: 'ab'.repeat(64),
      stationOwnerAddress: w.address, isActive: true, latitude: 10.3, longitude: -20.7,
    });
    const device = (minutesAgo: number | null, mac = MAC) => ({
      macAddress: mac, lastData: minutesAgo === null ? {} : { dateutc: NOW - minutesAgo * 60_000, tempf: 71.3, baromabsin: 29.1 },
      info: { name: 'Jane Doe back yard', coords: { coords: { lat: 44.98765, lon: -93.26543 } } },
    });
    function checker(answer: unknown, opts: { status?: number; throws?: Error; hang?: boolean; raw?: string } = {}) {
      const urls: string[] = [];
      const inits: Array<{ redirect?: string; method?: string }> = [];
      const caps: number[] = [];
      const sleeps: number[] = [];
      let clock = NOW;
      const check = ambientProviderChecker({
        fetchFn: async (url, init) => {
          urls.push(url);
          inits.push({ redirect: init.redirect, method: init.method });
          if (opts.throws) throw opts.throws;
          if (opts.hang) {
            await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
          }
          const status = opts.status ?? 200;
          return {
            ok: status >= 200 && status < 300,
            status,
            text: async (maxBytes: number) => {
              caps.push(maxBytes);
              const body = opts.raw ?? JSON.stringify(answer);
              if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new Error('provider answer too large');
              return body;
            },
          };
        },
        decrypt: (value) => {
          if (!value.encrypted.startsWith('enc:')) throw new Error('bad key');
          return value.encrypted.slice(4);
        },
        sleep: async (ms) => { sleeps.push(ms); clock += ms; },
        now: () => clock,
        timeoutMs: 25,
      });
      return { check, urls, sleeps, inits, caps, advance: (ms: number) => { clock += ms; } };
    }

    it('a fresh reading from the station\'s own device: fresh, with whole minutes; one request, with the stored keys', async () => {
      const c = checker([device(500, '11:22:33:44:55:66'), device(7)]);
      expect(await c.check(row())).toEqual({ kind: 'fresh', ageMinutes: 7 });
      expect(c.urls).toHaveLength(1);
      expect(c.urls[0]).toBe('https://rt.ambientweather.net/v1/devices?applicationKey=APPKEYSECRET&apiKey=APIKEYSECRET');
    });

    it('a stale reading (older than 24 hours), none at all, or one stamped in the future: stale', async () => {
      for (const d of [device(24 * 60 + 1), device(null), device(-30)]) {
        expect(await checker([d]).check(row())).toEqual({ kind: 'stale' });
      }
      // Exactly at the edge still counts.
      expect(await checker([device(24 * 60)]).check(row())).toEqual({ kind: 'fresh', ageMinutes: 1440 });
    });

    it('the wrong device: another device on the account being fresh does not count', async () => {
      expect(await checker([device(1, '11:22:33:44:55:66')]).check(row())).toEqual({ kind: 'no_device' });
      expect(await checker([]).check(row())).toEqual({ kind: 'no_device' });
    });

    it('an error, a timeout, a 429, another refusal or a bad answer: unreachable', async () => {
      expect(await checker(null, { throws: new Error('ECONNRESET https://rt…?apiKey=APIKEYSECRET') }).check(row())).toEqual({ kind: 'unreachable' });
      expect(await checker(null, { hang: true }).check(row())).toEqual({ kind: 'unreachable' });
      for (const status of [429, 401, 500]) {
        expect(await checker([device(1)], { status }).check(row())).toEqual({ kind: 'unreachable' });
      }
      expect(await checker({ error: 'nope' }).check(row())).toEqual({ kind: 'unreachable' });
    });

    it('missing device MAC, missing or undecryptable credentials: unreachable, and no request is made', async () => {
      for (const over of [
        { mac: null }, { credentials: null },
        { credentials: { encryptedApiKey: 'enc:a', keyIv: 'iv', keyTag: 'tag', encryptedAppKey: null, appIv: null, appTag: null } },
        { credentials: { encryptedApiKey: 'garbled', keyIv: 'iv', keyTag: 'tag', encryptedAppKey: 'enc:b', appIv: 'iv', appTag: 'tag' } },
      ] as Array<Partial<WebsiteExportRow>>) {
        const c = checker([device(1)]);
        expect(await c.check(row(over))).toEqual({ kind: 'unreachable' });
        expect(c.urls).toEqual([]);
      }
    });

    it('a redirect is never followed (the keys are in the query string), and at most 1 MB of the answer is read', async () => {
      const c = checker([device(7)]);
      await c.check(row());
      expect(c.inits).toEqual([{ redirect: 'error', method: 'GET' }]);
      expect(c.caps).toEqual([PROVIDER_MAX_BODY_BYTES]);
      expect(PROVIDER_MAX_BODY_BYTES).toBe(1024 * 1024);
      // An answer over the cap, or one that is not JSON, is a failed read.
      const big = checker(null, { raw: `[${' '.repeat(PROVIDER_MAX_BODY_BYTES)}]` });
      expect(await big.check(row())).toEqual({ kind: 'unreachable' });
      expect(await checker(null, { raw: '<html>moved</html>' }).check(row())).toEqual({ kind: 'unreachable' });
    });

    it('pacing: requests start at least a second apart, and only the missing time is waited', async () => {
      const c = checker([device(1)]);
      await c.check(row());
      expect(c.sleeps).toEqual([]);
      await c.check(row());
      expect(c.sleeps).toEqual([1000]);
      c.advance(400);
      await c.check(row());
      expect(c.sleeps).toEqual([1000, 600]);
      c.advance(5000);
      await c.check(row());
      expect(c.sleeps).toEqual([1000, 600]);
      expect(c.urls).toHaveLength(4);
    });

    it('the pace can be slowed by the setting but never made faster than one a second', () => {
      expect(resolveProviderMinIntervalMs(undefined)).toBe(1000);
      expect(resolveProviderMinIntervalMs('2500')).toBe(2500);
      for (const raw of ['0', '10', '-5', 'fast', '']) expect(resolveProviderMinIntervalMs(raw)).toBe(1000);
    });

    it('nothing of the provider answer or the keys reaches the result', async () => {
      const result = await checker([device(7)]).check(row());
      const text = JSON.stringify(result);
      for (const leak of ['SECRET', 'Jane', '44.98', '71.3', MAC]) expect(text).not.toContain(leak);
    });
  });

  it('a blocked station is never exported and never listed as waiting', async () => {
    const db = await waitingDb();
    await reconcileWebsiteStations(
      [{ station_id: ID, owner_address: wallet(32).address, provenance_class: 'real', is_active: true }], db.pool);
    expect(db.reg.get(ID)!.status).toBe('blocked');
    const h = harness(db);
    expect(await runWebsiteExportCli(['--out', '/x/a.json', '--batch-id', 'b1'], h.deps)).toBe(2);
    expect(JSON.parse(h.files.get('/x/a.json')!)).toMatchObject({ stations: [], not_exported: [] });
    expect(h.err.join('\n')).toContain('nothing to export (0 candidate row(s) read, 0 not exported)');
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
    expect(JSON.parse(h.files.get('/x/a.json')!).stations).toEqual([]);
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

  it('an earning station the chain transfers to another owner is blocked (so the collector roster drops it)', async () => {
    const db = await waitingDb();
    await run(db, [entry()]);
    expect(db.reg.get(ID)!.status).toBe('on_chain');
    expect((await run(db, [entry({ owner_address: other.address })])).websiteBlocked).toBe(1);
    expect(db.reg.get(ID)).toMatchObject({ status: 'blocked', blocked_reason: 'station_id_taken_on_chain' });
    expect((await state(db)).state).toBe('blocked');
  });

  it('an earning station the chain deactivates, or no longer shows as real, is blocked; live again under the same owner, it earns again', async () => {
    for (const over of [{ is_active: false }, { provenance_class: 'synthetic' }]) {
      const db = await waitingDb();
      await run(db, [entry()]);
      expect((await run(db, [entry(over)])).websiteBlocked).toBe(1);
      expect(db.reg.get(ID)).toMatchObject({ status: 'blocked', blocked_reason: 'chain_record_not_active' });
      expect((await run(db, [entry()])).websiteOnChain).toBe(1);
      expect(db.reg.get(ID)).toMatchObject({ status: 'on_chain', blocked_reason: null });
    }
  });

  it('a blocked station gets the reason that fits now; the same reason twice is not counted again', async () => {
    const db = await waitingDb();
    await run(db, [entry()]);
    await run(db, [entry({ is_active: false })]);
    expect((await run(db, [entry({ owner_address: other.address })])).websiteBlocked).toBe(1);
    expect(db.reg.get(ID)!.blocked_reason).toBe('station_id_taken_on_chain');
    expect((await run(db, [entry({ owner_address: other.address })])).websiteBlocked).toBe(0);
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
