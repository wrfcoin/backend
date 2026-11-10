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
 * A station is exported only when ALL of this holds:
 *  - its proof is stored and the row is waiting (never `blocked`);
 *  - the station is active and still belongs to the wallet that signed;
 *  - its provider credentials are stored and ingestion is active;
 *  - its id is a neutral server-issued id (`pws-` + 16 hex), or the operator
 *    named it with --allow-id. A station id is public on chain for good, and
 *    older ids hold the name the owner typed;
 *  - it is REPORTING: a fresh read of the provider, made here with the
 *    station's stored credentials, shows a reading from the station's own
 *    device (the MAC bound to it) in the last 24 hours.
 * The first four are in the SQL, so a row that fails one never takes a place
 * in the batch window. Stations that are waiting but not exported are listed
 * with a fixed reason.
 *
 * Why the provider and not a table: nothing writes `weather_data` on the
 * deployed backend, and the chain knows nothing of a station before it is
 * registered. The collector reads a provider station the same way (core4
 * tests/security/lib/ambient-pipeline.cjs: GET /v1/devices with the station's
 * keys, the device picked by its exact MAC), so this checks what the collector
 * will later submit. One provider request per station, paced, 10 s timeout.
 * Credentials and provider payloads are never logged or printed; a provider
 * error, timeout or 429 never exports a station.
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
  RECENT_OBSERVATION_HOURS,
  WEBSITE_STATION_ID_RE,
  ownerAddressFromPubkey,
} from './website-station-chain-registration.js';

export const WEBSITE_EXPORT_VERSION = 'website_station_registration_export_v1';
/** What the chain record says the device is. Free text on chain; fixed here. */
export const WEBSITE_EXPORT_HARDWARE_MODEL = 'personal-weather-station';
/** A home station nobody has calibrated has earned no tier; raising it is a governance call. */
export const WEBSITE_EXPORT_DATA_QUALITY_TIER = 'unverified' as const;

/** Stored provider credentials, still encrypted. Never printed, never written to the artifact. */
export interface EncryptedProviderCredentials {
  encryptedApiKey: string;
  keyIv: string;
  keyTag: string;
  encryptedAppKey: string | null;
  appIv: string | null;
  appTag: string | null;
}

/**
 * `provider` = a fresh provider read showed a reading from the station's device in the last
 * 24 hours; `confirmed` = the caller saw exactly that in a look just before this export (see
 * --confirmed-reporting).
 */
export type ReportingSource = 'provider' | 'confirmed';

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
  /** The device this station is bound to, and its stored keys: used for the provider read only. */
  mac?: string | null;
  credentials?: EncryptedProviderCredentials | null;
  /** Set by resolveReporting. */
  reportingSource?: ReportingSource;
  lastObservationAgeMinutes?: number | null;
}

/** What the dry run shows per row: the source and the minutes since the last reading. Nothing else. */
export interface WebsiteExportEvidence {
  source: ReportingSource;
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

/** Deterministic: rows are ordered by station id, no clock is read. Credentials never reach the artifact. */
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
        source: row.reportingSource ?? 'provider',
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
 * Read-only. The oldest waiting stations that pass every rule the database can
 * check, first. Those rules are in the WHERE clause, so a row that fails one
 * never uses a place in the LIMIT window. Whether a station is REPORTING is
 * settled afterwards by a fresh provider read (resolveReporting), with the
 * device MAC and the stored (still encrypted) credentials selected here. $2 is
 * the operator's allow-list of ids that are not neutral server-issued ids,
 * comma-joined (a station id has no comma).
 */
export const SELECT_READY_WEBSITE_STATIONS_SQL = `SELECT r.station_id, r.owner_address, r.owner_pubkey, r.ownership_signature,
            w.owner_address AS station_owner_address, w.is_active, w.latitude, w.longitude,
            w.metadata->>'mac' AS mac,
            c.encrypted_api_key, c.key_iv, c.key_tag, c.encrypted_app_key, c.app_iv, c.app_tag
       FROM website_station_chain_registrations r
       JOIN weather_stations w ON w.station_id = r.station_id
       LEFT JOIN station_provider_credentials c ON c.station_id = w.station_id AND c.provider = 'ambient'
      WHERE r.status = 'db_only'
        AND w.is_active = true
        AND lower(w.owner_address) = r.owner_address
        AND w.latitude IS NOT NULL AND w.longitude IS NOT NULL
        AND ${ACTIVE_INGESTION_SQL}
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
/** How many waiting stations one export looks at when deciding who is reporting. */
export const CANDIDATE_WINDOW = 200;

export const REASON_STATION_REPORT = 'station_report: no reading from this station\'s device in the last 24 hours';
export const REASON_PROVIDER_UNREACHABLE = 'provider_unreachable: the provider could not be read for this station; not exported this run';

export async function selectReadyWebsiteRows(
  pool: WebsiteExportPool,
  limit: number,
  allowIds: string[] = [],
): Promise<WebsiteExportRow[]> {
  const res = await pool.query(SELECT_READY_WEBSITE_STATIONS_SQL, [limit, allowIds.join(',')]);
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  return (res.rows ?? []).map((r) => ({
    stationId: r.station_id,
    ownerAddress: r.owner_address,
    ownerPubkey: r.owner_pubkey,
    ownershipSignature: r.ownership_signature,
    stationOwnerAddress: r.station_owner_address,
    isActive: r.is_active === true,
    latitude: r.latitude === null || r.latitude === undefined ? null : Number(r.latitude),
    longitude: r.longitude === null || r.longitude === undefined ? null : Number(r.longitude),
    mac: text(r.mac),
    credentials: text(r.encrypted_api_key) && text(r.key_iv) && text(r.key_tag)
      ? {
        encryptedApiKey: r.encrypted_api_key, keyIv: r.key_iv, keyTag: r.key_tag,
        encryptedAppKey: text(r.encrypted_app_key), appIv: text(r.app_iv), appTag: text(r.app_tag),
      }
      : null,
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

/**
 * The outcome of one fresh provider read for one station.
 *  - fresh:       the station's device has a reading in the last 24 hours;
 *  - stale:       the device is there, its last reading is older (or it has none);
 *  - no_device:   the account answered, but the station's device (its MAC) is not on it;
 *  - unreachable: error, timeout, 429, a bad answer, or credentials that could not be read.
 */
export type ProviderCheck =
  | { kind: 'fresh'; ageMinutes: number }
  | { kind: 'stale' }
  | { kind: 'no_device' }
  | { kind: 'unreachable' };
export type ProviderChecker = (row: WebsiteExportRow) => Promise<ProviderCheck>;

/**
 * Settle who is reporting, oldest first, until `limit` stations are ready. One provider read per
 * station. A fresh reading from the station's own device: ready. A stale reading or a missing
 * device: stays waiting (`station_report`). Anything else, including no checker at all: stays
 * waiting (`provider_unreachable`). A station is never exported on an error. An id the caller
 * confirmed a moment ago is ready without a provider read.
 */
export async function resolveReporting(
  candidates: WebsiteExportRow[],
  limit: number,
  options: { providerCheck?: ProviderChecker; confirmed?: string[] } = {},
): Promise<{ ready: WebsiteExportRow[]; notReady: WebsiteSkippedRow[] }> {
  const ready: WebsiteExportRow[] = [];
  const notReady: WebsiteSkippedRow[] = [];
  const confirmed = new Set(options.confirmed ?? []);
  for (const row of candidates) {
    if (ready.length >= limit) break;
    if (confirmed.has(row.stationId)) {
      ready.push({ ...row, reportingSource: 'confirmed', lastObservationAgeMinutes: null });
      continue;
    }
    let seen: ProviderCheck = { kind: 'unreachable' };
    if (options.providerCheck) {
      try {
        seen = await options.providerCheck(row);
      } catch {
        seen = { kind: 'unreachable' };
      }
    }
    if (seen.kind === 'fresh' && Number.isFinite(seen.ageMinutes) && seen.ageMinutes >= 0) {
      ready.push({ ...row, reportingSource: 'provider', lastObservationAgeMinutes: seen.ageMinutes });
    } else if (seen.kind === 'stale' || seen.kind === 'no_device') {
      notReady.push({ stationId: row.stationId, reason: REASON_STATION_REPORT });
    } else {
      notReady.push({ stationId: row.stationId, reason: REASON_PROVIDER_UNREACHABLE });
    }
  }
  return { ready, notReady };
}

/** A MAC with separators and case removed (the same identity the registration uses). */
function canonicalMac(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^0-9a-f]/g, '') : '';
}

export const AMBIENT_DEVICES_URL = 'https://rt.ambientweather.net/v1/devices';
export const PROVIDER_TIMEOUT_MS = 10_000;
/** Ambient allows one request a second per key; this is also the pace between stations. */
export const DEFAULT_PROVIDER_MIN_INTERVAL_MS = 1_000;

export function resolveProviderMinIntervalMs(raw: string | undefined): number {
  const n = Number(raw);
  // Never faster than the provider's own limit, whatever the setting says.
  return Number.isFinite(n) && n >= DEFAULT_PROVIDER_MIN_INTERVAL_MS ? Math.floor(n) : DEFAULT_PROVIDER_MIN_INTERVAL_MS;
}

export type ProviderFetch = (
  url: string,
  init: { method: 'GET'; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * The provider check for Ambient stations: the same read the registration used to validate the
 * keys and the collector uses to fetch readings (GET /v1/devices with the station's own keys),
 * then the device picked by its exact MAC and the time of its last reading.
 *
 * One request per station; requests start at least `minIntervalMs` apart; each has a 10 s
 * timeout. Nothing is logged here, and nothing from the request (its URL carries the keys) or
 * from the answer leaves this function except the outcome and a whole number of minutes.
 */
export function ambientProviderChecker(deps: {
  fetchFn: ProviderFetch;
  /** Decrypts one stored credential; throws when it cannot. */
  decrypt: (value: { encrypted: string; iv: string; tag: string }) => string;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
  timeoutMs?: number;
}): ProviderChecker {
  const now = deps.now ?? Date.now;
  const minInterval = deps.minIntervalMs ?? DEFAULT_PROVIDER_MIN_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  let lastStart: number | null = null;
  return async (row) => {
    const mac = canonicalMac(row.mac);
    const stored = row.credentials;
    if (!mac || !stored || !stored.encryptedAppKey || !stored.appIv || !stored.appTag) return { kind: 'unreachable' };
    let apiKey: string;
    let appKey: string;
    try {
      apiKey = deps.decrypt({ encrypted: stored.encryptedApiKey, iv: stored.keyIv, tag: stored.keyTag });
      appKey = deps.decrypt({ encrypted: stored.encryptedAppKey, iv: stored.appIv, tag: stored.appTag });
    } catch {
      return { kind: 'unreachable' };
    }
    if (lastStart !== null) {
      const wait = lastStart + minInterval - now();
      if (wait > 0) await deps.sleep(wait);
    }
    lastStart = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let payload: unknown;
    try {
      const url = `${AMBIENT_DEVICES_URL}?applicationKey=${encodeURIComponent(appKey)}&apiKey=${encodeURIComponent(apiKey)}`;
      const res = await deps.fetchFn(url, { method: 'GET', signal: controller.signal });
      if (!res.ok) return { kind: 'unreachable' };
      payload = await res.json();
    } catch {
      // Error, timeout or abort. The message can carry the URL (and so the keys): it is dropped.
      return { kind: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(payload)) return { kind: 'unreachable' };
    const device = payload.find((d) => canonicalMac((d as { macAddress?: unknown } | null)?.macAddress) === mac) as
      | { lastData?: { dateutc?: unknown } }
      | undefined;
    if (!device) return { kind: 'no_device' };
    const stamp = Number(device.lastData?.dateutc);
    const at = now();
    if (!Number.isFinite(stamp) || stamp <= 0 || stamp > at + 5 * 60_000) return { kind: 'stale' };
    const ageMs = Math.max(0, at - stamp);
    if (ageMs > RECENT_OBSERVATION_HOURS * 3_600_000) return { kind: 'stale' };
    return { kind: 'fresh', ageMinutes: Math.floor(ageMs / 60_000) };
  };
}

// The same calibration the phone export uses: 21 complete rows fit under the
// node's 64 KiB artifact ceiling, 22 do not. The CLI still enforces real bytes.
export const MAX_WEBSITE_STATION_EXPORT_ROWS = 21;
export const MAX_WEBSITE_STATION_CLI_INPUT_BYTES = 64 * 1024;

export interface WebsiteExportCliDeps {
  pool: WebsiteExportPool;
  /** null = WRFCOIN_CHAIN_ID / WRFCOIN_NETWORK_ID are not set: the export refuses to run. */
  chain: { chainId: string; networkId: string } | null;
  /** The fresh provider read. Absent = nothing can be shown to be reporting. */
  providerCheck?: ProviderChecker;
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
  'usage: export-website-station-registrations.ts --out <file> --batch-id <id> [--limit <1-21>] [--allow-id <station id>]... [--confirmed-reporting <station id>]... [--cli-batch-out <file> --submitted-at <unix secs>]';

/**
 * Exit codes: 0 exported, 2 nothing to export, 1 usage or database/file error.
 * The artifact is written on exit 2 as well (with no stations), so the reasons
 * in `not_exported` reach the operator. Output names station ids, counts, the
 * evidence source and minutes only: never an owner, a key, a signature, a
 * coordinate, a credential or a reading. There is no flag that changes a
 * database row.
 */
export async function runWebsiteExportCli(argv: string[], deps: WebsiteExportCliDeps): Promise<number> {
  const known = new Set(['--out', '--batch-id', '--limit', '--cli-batch-out', '--submitted-at']);
  const values = new Map<string, string>();
  // Ids the operator chose to put on chain although they are not neutral ids.
  const allowIds: string[] = [];
  // Ids the caller saw reporting in a look just before this run (the batch tool's stamped
  // export, which must be quick): no provider read is made for them.
  const confirmedIds: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (name === '--allow-id' || name === '--confirmed-reporting') {
      const list = name === '--allow-id' ? allowIds : confirmedIds;
      if (value === undefined || !WEBSITE_STATION_ID_RE.test(value) || isReservedMobileStationId(value) || list.includes(value)) {
        deps.error(USAGE);
        return 1;
      }
      list.push(value);
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
    const candidates = await selectReadyWebsiteRows(deps.pool, CANDIDATE_WINDOW, allowIds);
    const notReady = await selectNotReadyWebsiteRows(deps.pool, allowIds);
    const reporting = await resolveReporting(candidates, limit, {
      providerCheck: deps.providerCheck, confirmed: confirmedIds,
    });
    const rows = reporting.ready;
    const { artifact, skipped } = buildWebsiteExportArtifact(rows, { chainId, networkId, batchId });
    artifact.not_exported = [...skipped, ...notReady, ...reporting.notReady];
    for (const s of artifact.not_exported) deps.error(`not exported ${s.stationId}: ${s.reason}`);
    let cliBatchData: string | undefined;
    if (cliBatchOut !== undefined && artifact.stations.length > 0) {
      cliBatchData = JSON.stringify(buildWebsiteCliBatch(artifact.stations, submittedAt as number), null, 2) + '\n';
      const bytes = Buffer.byteLength(cliBatchData, 'utf8');
      if (bytes > MAX_WEBSITE_STATION_CLI_INPUT_BYTES) {
        deps.error(`projected CLI input is ${bytes} bytes; maximum ${MAX_WEBSITE_STATION_CLI_INPUT_BYTES}. Use a smaller --limit; nothing written`);
        return 1;
      }
    }
    // The whole projection is validated before either file is written. The artifact is written
    // even with no stations, so the operator can read why each waiting station was left out.
    deps.writeFile(out, JSON.stringify(artifact, null, 2) + '\n');
    if (artifact.stations.length === 0) {
      deps.error(`nothing to export (${candidates.length} candidate row(s) read, ${artifact.not_exported.length} not exported); the reasons are in ${out}`);
      return 2;
    }
    if (cliBatchOut !== undefined && cliBatchData !== undefined) {
      deps.writeFile(cliBatchOut, cliBatchData);
      deps.log(`wrote ${artifact.stations.length} core4 CLI batch row(s) to ${cliBatchOut}`);
    }
    deps.log(`wrote ${artifact.stations.length} station(s) to ${out} (batch ${batchId}, chain ${chainId}/${networkId})`);
    for (const s of artifact.stations) {
      const age = s.evidence.last_observation_age_minutes;
      const seen = s.evidence.source === 'confirmed'
        ? 'reporting confirmed by the caller'
        : `last reading ${age === null ? 'unknown' : `${age} min ago`}`;
      deps.log(
        `station ${s.station_id}: source ${s.evidence.source}; ${seen}`
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
