/**
 * Operator export of website stations that are waiting for their on-chain
 * registration. The companion of mobile-station-export.ts, for stations
 * connected on the website; the CLI wrapper is
 * scripts/export-website-station-registrations.ts.
 *
 * Nothing here signs anything, reads a governance key, or talks to the chain.
 * The artifact carries the OWNER's public proof (owner pubkey + the owner's
 * signature over core4's station ownership message) so the owner's batch can
 * assemble the StationRegistration.
 *
 * The export never changes a row. A station leaves the waiting list only when
 * the chain station sync sees it in the chain registry, so running the export
 * twice gives the same rows until then.
 *
 * A station is exported only when ALL of this holds, and the filter is in the
 * SQL, so a row that fails never takes a place in the batch window:
 *  - its proof is stored and the row is waiting (never `blocked`);
 *  - the station is active and still belongs to the wallet that signed;
 *  - its provider credentials are stored and ingestion is active;
 *  - it has at least one reading in the last 24 hours;
 *  - its id is a neutral server-issued id (`pws-` + 16 hex), or the operator
 *    named it with --allow-id. A station id is public on chain for good, and
 *    older ids hold the name the owner typed.
 * Stations that are waiting but not exported are listed with the reason.
 *
 * Coordinates leave here at 0.1 degree only (owner ruling: what goes on chain
 * is public forever). Every row is re-verified first; a row that fails is
 * skipped and reported by station id and a fixed reason only.
 */
import { buildStationOwnershipMessage, isReservedMobileStationId } from '../../shared/mobile-station-messages.js';
import { verifyEd25519SignatureBytes } from '../routes/wallet-auth-service.js';
import { toStorageGrid } from '../utils/coordinate-grid.js';
import {
  ACTIVE_INGESTION_SQL,
  NEUTRAL_STATION_ID_RE,
  OBSERVATIONS_24H_SQL,
  WEBSITE_STATION_ID_RE,
  ownerAddressFromPubkey,
} from './website-station-chain-registration.js';

export const WEBSITE_EXPORT_VERSION = 'website_station_registration_export_v1';
/** What the chain record says the device is. Free text on chain; fixed here. */
export const WEBSITE_EXPORT_HARDWARE_MODEL = 'personal-weather-station';
/** A home station nobody has calibrated has earned no tier; raising it is a governance call. */
export const WEBSITE_EXPORT_DATA_QUALITY_TIER = 'unverified' as const;

export interface WebsiteExportRow {
  stationId: string;
  ownerAddress: string;
  ownerPubkey: string;
  ownershipSignature: string;
  /** The owner on the weather_stations row; must equal ownerAddress. */
  stationOwnerAddress: string;
  isActive: boolean;
  latitude: number | null;
  longitude: number | null;
  /** Readings stored in the last 24 hours, and minutes since the newest one. */
  observations24h?: number;
  lastObservationAgeMinutes?: number | null;
}

/** What the dry run shows per row: how recently the station reported. Nothing personal. */
export interface WebsiteExportEvidence {
  observations_24h: number;
  last_observation_age_minutes: number | null;
}

export interface WebsiteExportStation {
  station_id: string;
  owner_address: string;
  owner_pubkey: string;
  owner_signature: string;
  /** The 0.1 degree grid point. Never finer. */
  latitude: number;
  longitude: number;
  hardware_model: typeof WEBSITE_EXPORT_HARDWARE_MODEL;
  chain_id: string;
  network_id: string;
  provenance_class: 'real';
  data_quality_tier: typeof WEBSITE_EXPORT_DATA_QUALITY_TIER;
  evidence: WebsiteExportEvidence;
}

/**
 * The exact row core4 `wrfcoin station build-registration --batch` accepts
 * (serde deny_unknown_fields): the same ten keys the phone export writes.
 */
export interface WebsiteCliBatchRow {
  station_id: string;
  owner_address: string;
  owner_pubkey: string;
  owner_signature: string;
  latitude: number;
  longitude: number;
  hardware_model: typeof WEBSITE_EXPORT_HARDWARE_MODEL;
  provenance_class: 'real';
  data_quality_tier: typeof WEBSITE_EXPORT_DATA_QUALITY_TIER;
  submitted_at: number;
}

export interface WebsiteExportArtifact {
  version: typeof WEBSITE_EXPORT_VERSION;
  chainId: string;
  networkId: string;
  batchId: string;
  stations: WebsiteExportStation[];
  /** Waiting stations that are NOT in this batch, by id and fixed reason only. */
  not_exported: WebsiteSkippedRow[];
}

export interface WebsiteSkippedRow {
  stationId: string;
  reason: string;
}

/** True only for a number that already sits on the 0.1 degree grid, inside `limit`. */
export function onTenthGrid(value: unknown, limit: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= limit &&
    Number((Math.round(value * 10) / 10).toFixed(1)) === value
  );
}

/** Degrees at 0.1, without float drift and never "-0". */
function gridPoint(value: number): number {
  return Number(toStorageGrid(value).toFixed(1)) + 0;
}

function rowProblem(row: WebsiteExportRow, chainId: string, networkId: string): string | null {
  if (typeof row.stationId !== 'string' || !WEBSITE_STATION_ID_RE.test(row.stationId)) return 'station id is not a website station id';
  if (isReservedMobileStationId(row.stationId)) return 'phone stations use the phone export';
  if (typeof row.ownerAddress !== 'string' || !/^0x[0-9a-f]{40}$/.test(row.ownerAddress)) return 'owner address is not a chain address';
  if (typeof row.stationOwnerAddress !== 'string' || row.stationOwnerAddress.trim().toLowerCase() !== row.ownerAddress) {
    return 'the station now belongs to a different owner';
  }
  if (row.isActive !== true) return 'station is not active';
  if (typeof row.ownerPubkey !== 'string' || !/^[0-9a-f]{64}$/.test(row.ownerPubkey)) return 'owner pubkey is not 32-byte hex';
  if (typeof row.ownershipSignature !== 'string' || !/^[0-9a-f]{128}$/.test(row.ownershipSignature)) {
    return 'ownership signature is not 64-byte hex';
  }
  if (
    typeof row.latitude !== 'number' || typeof row.longitude !== 'number' ||
    !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude) ||
    Math.abs(row.latitude) > 90 || Math.abs(row.longitude) > 180
  ) {
    return 'station has no usable position';
  }
  if (ownerAddressFromPubkey(row.ownerPubkey) !== row.ownerAddress) return 'owner is not derived from the owner pubkey';
  const message = buildStationOwnershipMessage({
    chainId, networkId, stationId: row.stationId, ownerAddress: row.ownerAddress,
  });
  if (!verifyEd25519SignatureBytes(row.ownerPubkey, row.ownershipSignature, message)) {
    return 'ownership signature does not verify';
  }
  return null;
}

/** Deterministic: rows are ordered by station id, no clock is read. */
export function buildWebsiteExportArtifact(
  rows: WebsiteExportRow[],
  opts: { chainId: string; networkId: string; batchId: string },
): { artifact: WebsiteExportArtifact; skipped: WebsiteSkippedRow[] } {
  const stations: WebsiteExportStation[] = [];
  const skipped: WebsiteSkippedRow[] = [];
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0))) {
    const problem = seen.has(row.stationId) ? 'station appears twice' : rowProblem(row, opts.chainId, opts.networkId);
    if (problem) {
      skipped.push({ stationId: WEBSITE_STATION_ID_RE.test(String(row.stationId)) ? row.stationId : '<invalid id>', reason: problem });
      continue;
    }
    seen.add(row.stationId);
    const latitude = gridPoint(row.latitude as number);
    const longitude = gridPoint(row.longitude as number);
    // Belt and braces: nothing finer than 0.1 degree is ever written.
    if (!onTenthGrid(latitude, 90) || !onTenthGrid(longitude, 180)) {
      skipped.push({ stationId: row.stationId, reason: 'position could not be put on the 0.1 degree grid' });
      continue;
    }
    stations.push({
      station_id: row.stationId,
      owner_address: row.ownerAddress,
      owner_pubkey: row.ownerPubkey,
      owner_signature: row.ownershipSignature,
      latitude,
      longitude,
      hardware_model: WEBSITE_EXPORT_HARDWARE_MODEL,
      chain_id: opts.chainId,
      network_id: opts.networkId,
      provenance_class: 'real',
      data_quality_tier: WEBSITE_EXPORT_DATA_QUALITY_TIER,
      evidence: {
        observations_24h: Number.isInteger(row.observations24h) ? (row.observations24h as number) : 0,
        last_observation_age_minutes:
          typeof row.lastObservationAgeMinutes === 'number' && Number.isFinite(row.lastObservationAgeMinutes)
            ? Math.max(0, Math.floor(row.lastObservationAgeMinutes))
            : null,
      },
    });
  }
  return {
    artifact: {
      version: WEBSITE_EXPORT_VERSION, chainId: opts.chainId, networkId: opts.networkId, batchId: opts.batchId,
      stations, not_exported: [],
    },
    skipped,
  };
}

/** Bare array, input order kept, only the keys core4 accepts. `submittedAt` comes from the operator. */
export function buildWebsiteCliBatch(stations: WebsiteExportStation[], submittedAt: number): WebsiteCliBatchRow[] {
  return stations.map((s) => ({
    station_id: s.station_id,
    owner_address: s.owner_address,
    owner_pubkey: s.owner_pubkey,
    owner_signature: s.owner_signature,
    latitude: s.latitude,
    longitude: s.longitude,
    hardware_model: s.hardware_model,
    provenance_class: s.provenance_class,
    data_quality_tier: s.data_quality_tier,
    submitted_at: submittedAt,
  }));
}

export interface WebsiteExportPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: any[]; rowCount?: number | null }>;
}

/**
 * Read-only. The oldest waiting stations that are READY, first. Every
 * eligibility rule is in the WHERE clause, so a row that fails one never uses
 * a place in the LIMIT window. $2 is the operator's allow-list of ids that are
 * not neutral server-issued ids, comma-joined (a station id has no comma).
 */
export const SELECT_READY_WEBSITE_STATIONS_SQL = `SELECT r.station_id, r.owner_address, r.owner_pubkey, r.ownership_signature,
            w.owner_address AS station_owner_address, w.is_active, w.latitude, w.longitude,
            ${OBSERVATIONS_24H_SQL} AS observations_24h,
            (SELECT floor(extract(epoch FROM (now() - max(d."timestamp"))) / 60)::int FROM weather_data d
              WHERE d.station_id = w.station_id AND d."timestamp" <= now()) AS last_observation_age_minutes
       FROM website_station_chain_registrations r
       JOIN weather_stations w ON w.station_id = r.station_id
      WHERE r.status = 'db_only'
        AND w.is_active = true
        AND lower(w.owner_address) = r.owner_address
        AND w.latitude IS NOT NULL AND w.longitude IS NOT NULL
        AND ${ACTIVE_INGESTION_SQL}
        AND ${OBSERVATIONS_24H_SQL} > 0
        AND (r.station_id ~ '^pws-[0-9a-f]{16}$' OR r.station_id = ANY(string_to_array($2::text, ',')))
      ORDER BY r.created_at, r.station_id
      LIMIT $1`;

/** Read-only. Waiting stations that are NOT ready, with the first rule each one fails. For the report only. */
export const SELECT_NOT_READY_WEBSITE_STATIONS_SQL = `SELECT station_id, reason FROM (
       SELECT r.station_id, r.created_at,
              CASE
                WHEN w.is_active IS NOT TRUE THEN 'station is not active'
                WHEN lower(w.owner_address) <> r.owner_address THEN 'the station now belongs to a different owner'
                WHEN w.latitude IS NULL OR w.longitude IS NULL THEN 'station has no usable position'
                WHEN NOT ${ACTIVE_INGESTION_SQL} THEN 'provider credentials are not verified or ingestion is not active'
                WHEN ${OBSERVATIONS_24H_SQL} = 0 THEN 'no reading in the last 24 hours'
                WHEN NOT (r.station_id ~ '^pws-[0-9a-f]{16}$' OR r.station_id = ANY(string_to_array($2::text, ',')))
                  THEN 'station id is not a neutral id (it may hold a name); pass --allow-id to include it'
              END AS reason
         FROM website_station_chain_registrations r
         JOIN weather_stations w ON w.station_id = r.station_id
        WHERE r.status = 'db_only') waiting
      WHERE reason IS NOT NULL
      ORDER BY created_at, station_id
      LIMIT $1`;

export const NOT_READY_REPORT_LIMIT = 200;

export async function selectReadyWebsiteRows(
  pool: WebsiteExportPool,
  limit: number,
  allowIds: string[] = [],
): Promise<WebsiteExportRow[]> {
  const res = await pool.query(SELECT_READY_WEBSITE_STATIONS_SQL, [limit, allowIds.join(',')]);
  return (res.rows ?? []).map((r) => ({
    stationId: r.station_id,
    ownerAddress: r.owner_address,
    ownerPubkey: r.owner_pubkey,
    ownershipSignature: r.ownership_signature,
    stationOwnerAddress: r.station_owner_address,
    isActive: r.is_active === true,
    latitude: r.latitude === null || r.latitude === undefined ? null : Number(r.latitude),
    longitude: r.longitude === null || r.longitude === undefined ? null : Number(r.longitude),
    observations24h: Number(r.observations_24h),
    lastObservationAgeMinutes:
      r.last_observation_age_minutes === null || r.last_observation_age_minutes === undefined
        ? null
        : Number(r.last_observation_age_minutes),
  }));
}

export async function selectNotReadyWebsiteRows(
  pool: WebsiteExportPool,
  allowIds: string[] = [],
): Promise<WebsiteSkippedRow[]> {
  const res = await pool.query(SELECT_NOT_READY_WEBSITE_STATIONS_SQL, [NOT_READY_REPORT_LIMIT, allowIds.join(',')]);
  return (res.rows ?? []).map((r) => ({
    stationId: WEBSITE_STATION_ID_RE.test(String(r.station_id)) ? String(r.station_id) : '<invalid id>',
    reason: String(r.reason),
  }));
}

// The same calibration the phone export uses: 21 complete rows fit under the
// node's 64 KiB artifact ceiling, 22 do not. The CLI still enforces real bytes.
export const MAX_WEBSITE_STATION_EXPORT_ROWS = 21;
export const MAX_WEBSITE_STATION_CLI_INPUT_BYTES = 64 * 1024;

export interface WebsiteExportCliDeps {
  pool: WebsiteExportPool;
  /** null = WRFCOIN_CHAIN_ID / WRFCOIN_NETWORK_ID are not set: the export refuses to run. */
  chain: { chainId: string; networkId: string } | null;
  /** Must fail if the file already exists (the wrapper passes flag 'wx'). */
  writeFile: (path: string, data: string) => void;
  log: (message: string) => void;
  error: (message: string) => void;
}

function safeCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : '';
}

const USAGE =
  'usage: export-website-station-registrations.ts --out <file> --batch-id <id> [--limit <1-21>] [--allow-id <station id>]... [--cli-batch-out <file> --submitted-at <unix secs>]';

/**
 * Exit codes: 0 exported, 2 nothing to export, 1 usage or database/file error.
 * Output names station ids and counts only: never an owner, a key, a signature
 * or a coordinate. There is no flag that changes a database row.
 */
export async function runWebsiteExportCli(argv: string[], deps: WebsiteExportCliDeps): Promise<number> {
  const known = new Set(['--out', '--batch-id', '--limit', '--cli-batch-out', '--submitted-at']);
  const values = new Map<string, string>();
  // Ids the operator chose to put on chain although they are not neutral ids.
  const allowIds: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (name === '--allow-id') {
      if (value === undefined || !WEBSITE_STATION_ID_RE.test(value) || isReservedMobileStationId(value) || allowIds.includes(value)) {
        deps.error(USAGE);
        return 1;
      }
      allowIds.push(value);
      continue;
    }
    if (!known.has(name) || values.has(name) || value === undefined || value.startsWith('--')) {
      deps.error(USAGE);
      return 1;
    }
    values.set(name, value);
  }
  if (!deps.chain) {
    deps.error('WRFCOIN_CHAIN_ID and WRFCOIN_NETWORK_ID must be set: this export never assumes a chain; nothing read or written');
    return 1;
  }
  const out = values.get('--out');
  const batchId = values.get('--batch-id');
  const cliBatchOut = values.get('--cli-batch-out');
  const submittedAtRaw = values.get('--submitted-at');
  const limit = Number(values.get('--limit') ?? MAX_WEBSITE_STATION_EXPORT_ROWS);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WEBSITE_STATION_EXPORT_ROWS) {
    deps.error(`--limit must be an integer from 1 to ${MAX_WEBSITE_STATION_EXPORT_ROWS}; split larger exports into separate batches`);
    return 1;
  }
  if (!out || !batchId || !/^[A-Za-z0-9._-]{1,64}$/.test(batchId)) {
    deps.error(USAGE);
    return 1;
  }
  const submittedAt = submittedAtRaw === undefined ? undefined : Number(submittedAtRaw);
  const cliFlagsOk =
    (cliBatchOut === undefined && submittedAtRaw === undefined) ||
    (cliBatchOut !== undefined &&
      cliBatchOut !== '' &&
      cliBatchOut !== out &&
      submittedAtRaw !== undefined &&
      /^[0-9]{1,15}$/.test(submittedAtRaw) &&
      Number.isSafeInteger(submittedAt) &&
      (submittedAt as number) > 0);
  if (!cliFlagsOk) {
    deps.error('--cli-batch-out <file> (different from --out) and --submitted-at <positive unix secs> must be given together');
    return 1;
  }
  try {
    const { chainId, networkId } = deps.chain;
    const rows = await selectReadyWebsiteRows(deps.pool, limit, allowIds);
    const notReady = await selectNotReadyWebsiteRows(deps.pool, allowIds);
    const { artifact, skipped } = buildWebsiteExportArtifact(rows, { chainId, networkId, batchId });
    artifact.not_exported = [...skipped, ...notReady];
    for (const s of artifact.not_exported) deps.error(`not exported ${s.stationId}: ${s.reason}`);
    if (artifact.stations.length === 0) {
      deps.error(`nothing to export (${rows.length} ready row(s) read, ${artifact.not_exported.length} not exported)`);
      return 2;
    }
    let cliBatchData: string | undefined;
    if (cliBatchOut !== undefined) {
      cliBatchData = JSON.stringify(buildWebsiteCliBatch(artifact.stations, submittedAt as number), null, 2) + '\n';
      const bytes = Buffer.byteLength(cliBatchData, 'utf8');
      if (bytes > MAX_WEBSITE_STATION_CLI_INPUT_BYTES) {
        deps.error(`projected CLI input is ${bytes} bytes; maximum ${MAX_WEBSITE_STATION_CLI_INPUT_BYTES}. Use a smaller --limit; nothing written`);
        return 1;
      }
    }
    // The whole projection is validated before either file is written.
    deps.writeFile(out, JSON.stringify(artifact, null, 2) + '\n');
    if (cliBatchOut !== undefined && cliBatchData !== undefined) {
      deps.writeFile(cliBatchOut, cliBatchData);
      deps.log(`wrote ${artifact.stations.length} core4 CLI batch row(s) to ${cliBatchOut}`);
    }
    deps.log(`wrote ${artifact.stations.length} station(s) to ${out} (batch ${batchId}, chain ${chainId}/${networkId})`);
    for (const s of artifact.stations) {
      const age = s.evidence.last_observation_age_minutes;
      deps.log(
        `station ${s.station_id}: ${s.evidence.observations_24h} reading(s) in 24 h, last ${age === null ? 'unknown' : `${age} min ago`}`
        + (NEUTRAL_STATION_ID_RE.test(s.station_id) ? '' : ' (allowed by --allow-id)'),
      );
    }
    deps.log('no rows changed: a station leaves the waiting list only when the chain shows it registered');
    return 0;
  } catch (error) {
    deps.error(`export failed: database or file error${safeCode(error)} (details withheld)`);
    return 1;
  }
}
