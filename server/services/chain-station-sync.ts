/**
 * Chain → `weather_stations` sync job (backend#1253; defect backend#1250).
 *
 * Periodically reads the node's Operator-gated station registry list
 * (`GET /transactions/station/registrations`, core4#3342) and writes the rows
 * the public contributor map needs, using exactly the one-shot backfill's rules
 * (`chain-station-backfill.ts`, #1251):
 *
 *  - owner always from the chain; a row with a different owner is never
 *    touched (reported as refused);
 *  - stations that are inactive or not `provenance_class: real` are refused;
 *  - a same-owner row gets NULL coordinates filled, and (owner ruling Q6,
 *    2026-09-27: the chain is authoritative) coordinates that differ from the
 *    chain registration are OVERWRITTEN — only when the stored owner equals
 *    the chain owner, guarded in SQL as well.
 *
 * Display labels come ONLY from an operator config map keyed by station id
 * (`STATION_CHAIN_SYNC_LABELS` JSON, or `STATION_CHAIN_SYNC_LABELS_FILE`).
 * Station ids can contain personal names, so a station with no configured
 * label is skipped, never titled after its id.
 *
 * Coordinates are stored at 0.1 degree only (owner ruling 2026-10-01, W21;
 * utils/coordinate-grid.js): a generic station gets the grid point of its chain
 * registration, a mobile station the centre of its registered cell. A sync never
 * writes a finer position, including over a row that is already on the grid.
 * The anonymous map projection keeps coarsening server-side (#1222/#1237). Logs
 * carry counts and station ids only — never an owner address or coordinates.
 *
 * OFF by default: `STATION_CHAIN_SYNC_ENABLED=true` to start it.
 */

import { readFileSync } from 'node:fs';
import { nodeHttpFetch } from '../../shared/core4-node-http.js';
import {
  SafeDiagnosticError,
  applyBackfill,
  planBackfill,
  type ApplyResult,
  type BackfillPlanItem,
  type BackfillPool,
  type ChainStationRegistration,
} from './chain-station-backfill.js';
import { isReservedMobileStationId } from '../../shared/mobile-station-messages.js';
import { cellCentreDegrees, toStorageGrid } from '../utils/coordinate-grid.js';

export interface ChainStationListEntry extends ChainStationRegistration {
  latitude: number;
  longitude: number;
  elevation_meters?: number | null;
}

export interface StationLabel {
  name: string;
  location?: string;
  stationType?: string;
}

export type StationLabelMap = Record<string, StationLabel>;

/** Only an allowlisted-shape error code (ENOENT, ECONNREFUSED, 28P01…), never a message. */
function safeCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : '';
}

/**
 * The only error text this job ever logs: a SafeDiagnosticError's fixed message,
 * or a fixed category plus a safe code. Driver, socket and parse messages can
 * carry coordinates and are withheld (#1251 review P2).
 */
export function safeErrorText(error: unknown): string {
  if (error instanceof SafeDiagnosticError) return error.message;
  return `database or node error${safeCode(error)} (details withheld)`;
}

export const DEFAULT_SYNC_INTERVAL_MS = 10 * 60_000;
export const MIN_SYNC_INTERVAL_MS = 60_000;
export const LIST_PAGE_LIMIT = 500;
export const MAX_LIST_PAGES = 200;

function idLabel(stationId: string): string {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(stationId) ? stationId : '<invalid id>';
}

/** Parse and validate the operator label map. Throws with a precise reason. */
export function parseLabelMap(raw: string): StationLabelMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SafeDiagnosticError('station label map is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SafeDiagnosticError('station label map must be a JSON object keyed by station id');
  }
  const out: StationLabelMap = {};
  for (const [stationId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      throw new SafeDiagnosticError(`label for ${idLabel(stationId)} must be an object`);
    }
    const v = value as Record<string, unknown>;
    if (typeof v.name !== 'string' || v.name.trim() === '') {
      throw new SafeDiagnosticError(`label for ${idLabel(stationId)} needs a non-empty name`);
    }
    if (v.location !== undefined && typeof v.location !== 'string') {
      throw new SafeDiagnosticError(`label for ${idLabel(stationId)}: location must be a string`);
    }
    if (v.stationType !== undefined && typeof v.stationType !== 'string') {
      throw new SafeDiagnosticError(`label for ${idLabel(stationId)}: stationType must be a string`);
    }
    out[stationId] = {
      name: v.name,
      ...(typeof v.location === 'string' ? { location: v.location } : {}),
      ...(typeof v.stationType === 'string' ? { stationType: v.stationType } : {}),
    };
  }
  return out;
}

/** Resolve the label map from env: inline JSON wins over a file path. */
export function labelMapFromEnv(env: NodeJS.ProcessEnv = process.env): StationLabelMap {
  if (env.STATION_CHAIN_SYNC_LABELS && env.STATION_CHAIN_SYNC_LABELS.trim() !== '') {
    return parseLabelMap(env.STATION_CHAIN_SYNC_LABELS);
  }
  if (env.STATION_CHAIN_SYNC_LABELS_FILE) {
    let raw: string;
    try {
      raw = readFileSync(env.STATION_CHAIN_SYNC_LABELS_FILE, 'utf8');
    } catch (error) {
      throw new SafeDiagnosticError(`station label map file unreadable${safeCode(error)}`);
    }
    return parseLabelMap(raw);
  }
  return {};
}

/**
 * Read the whole registry list, page by page. Fails closed: any non-2xx,
 * malformed page, or non-advancing cursor throws, and the caller writes nothing.
 */
/**
 * core4's own station-id rule (shared-protocol station_registry.rs
 * validate_station_id): non-empty, no whitespace anywhere, at most 128 BYTES.
 * Anything stricter (e.g. the backend's [A-Za-z0-9._:-] charset) is a
 * per-station refusal in planBackfill, never a whole-list rejection.
 */
function isCore4ValidStationId(id: unknown): id is string {
  // Rust's char::is_whitespace is the Unicode White_Space property, NOT JS \s:
  // \s also matches U+FEFF (not White_Space) and misses U+0085 (White_Space).
  return typeof id === 'string' && id.length > 0 && !/\p{White_Space}/u.test(id) && Buffer.byteLength(id, 'utf8') <= 128;
}

/**
 * Validate one station-list entry's required shape (#1254 review round 62).
 * Shape only: a WELL-FORMED inactive, synthetic, wrf-owned or backend-
 * unsupported-id station is valid here and is refused later by the
 * per-station policy (Opus review). Returns a fixed reason or null.
 */
export function stationListEntryProblem(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'an entry is not an object';
  const e = entry as Record<string, unknown>;
  if (!isCore4ValidStationId(e.station_id)) return 'an entry has an invalid station_id';
  // Shape only: the owner FORMAT (0x vs wrf) is a per-station policy refusal
  // in planBackfill (#1251), so one wrf-owned station cannot freeze the sync.
  if (typeof e.owner_address !== 'string' || e.owner_address === '') return 'an entry has an invalid owner_address';
  if (typeof e.provenance_class !== 'string' || e.provenance_class === '') return 'an entry has an invalid provenance_class';
  if (typeof e.is_active !== 'boolean') return 'an entry has a non-boolean is_active';
  const lat = e.latitude;
  const lon = e.longitude;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return 'an entry has an invalid latitude';
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return 'an entry has an invalid longitude';
  const elev = e.elevation_meters;
  if (elev !== undefined && elev !== null && (typeof elev !== 'number' || !Number.isFinite(elev))) {
    return 'an entry has an invalid elevation_meters';
  }
  return null;
}

/**
 * Validate a whole accumulated list: every entry well-formed and no station_id
 * twice. Throws a SafeDiagnosticError (fixed text) on the first problem.
 */
export function assertValidStationList(entries: unknown[]): asserts entries is ChainStationListEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const problem = stationListEntryProblem(entry);
    if (problem) throw new SafeDiagnosticError(`node station list rejected: ${problem}`);
    const id = (entry as ChainStationListEntry).station_id;
    if (seen.has(id)) throw new SafeDiagnosticError('node station list rejected: a station_id appears twice');
    seen.add(id);
  }
}

/**
 * Read the whole registry list, page by page, and return it only if EVERY
 * page's envelope and EVERY entry is well-formed (#1254 review round 62).
 * Fails closed with a fixed diagnostic on the first malformed page -- including
 * a malformed LATER page -- before any entry is returned, so a sync pass that
 * reads a bad list performs zero database writes.
 */
export async function fetchChainStationList(
  nodeUrl: string,
  operatorToken: string,
  fetchImpl: typeof fetch = nodeHttpFetch as unknown as typeof fetch
): Promise<ChainStationListEntry[]> {
  const base = nodeUrl.replace(/\/+$/, '');
  const all: unknown[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const qs = new URLSearchParams({ limit: String(LIST_PAGE_LIMIT) });
    if (after) qs.set('after', after);
    const res = await fetchImpl(`${base}/transactions/station/registrations?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${operatorToken}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new SafeDiagnosticError(`node station list answered HTTP ${Number(res.status)}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // A JSON.parse excerpt would echo response bytes (coordinates).
      throw new SafeDiagnosticError('node station list is not valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new SafeDiagnosticError('node station list rejected: the page is not an object');
    }
    const envelope = body as Record<string, unknown>;
    const data = (envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? envelope.data
      : envelope) as Record<string, unknown>;
    if (!Array.isArray(data.stations)) throw new SafeDiagnosticError('node station list has no stations array');
    if (typeof data.has_more !== 'boolean') {
      throw new SafeDiagnosticError('node station list rejected: has_more is missing or not a boolean');
    }
    if (data.has_more) {
      if (typeof data.next_cursor !== 'string' || data.next_cursor === '') {
        throw new SafeDiagnosticError('node station list rejected: has_more without a string next_cursor');
      }
    } else if (data.next_cursor !== undefined && data.next_cursor !== null && typeof data.next_cursor !== 'string') {
      throw new SafeDiagnosticError('node station list rejected: next_cursor is not a string');
    }
    for (const entry of data.stations) {
      const problem = stationListEntryProblem(entry);
      if (problem) throw new SafeDiagnosticError(`node station list rejected: ${problem}`);
    }
    all.push(...data.stations);
    if (!data.has_more) {
      assertValidStationList(all);
      return all;
    }
    const cursor = data.next_cursor as string;
    if (after !== null && cursor <= after) {
      throw new SafeDiagnosticError('node station list cursor did not advance');
    }
    after = cursor;
  }
  throw new SafeDiagnosticError(`node station list exceeded ${MAX_LIST_PAGES} pages`);
}

/**
 * Q6 overwrite: chain coordinates replace stored ones only for a row whose
 * owner equals the chain owner, and only when they actually differ (no write,
 * no updated_at churn, when they already match).
 */
export const OVERWRITE_COORDINATES_SQL = `UPDATE weather_stations
    SET latitude = $2, longitude = $3, updated_at = now()
  WHERE station_id = $1
    AND lower(owner_address) = lower($4)
    AND (latitude IS DISTINCT FROM $2::double precision OR longitude IS DISTINCT FROM $3::double precision)
  RETURNING station_id`;

/**
 * Mobile path (#1310). The generic backfill rules reserve the `mob-` prefix, so a
 * mobile station the operator batch put on chain is handled here instead, and
 * only when the backend already holds its registration. Guarded in SQL as well:
 * coordinates are written only to a row whose owner equals the chain owner, and
 * the status advances only from a registration with that same (lowercase) owner.
 */
export const MOBILE_FILL_COORDINATES_SQL = `UPDATE weather_stations
    SET latitude = $2, longitude = $3, updated_at = now()
  WHERE station_id = $1
    AND lower(owner_address) = lower($4)
  RETURNING station_id`;

export const MOBILE_MARK_ON_CHAIN_SQL = `UPDATE mobile_station_registrations
    SET status = 'on_chain', updated_at = now()
  WHERE station_id = $1
    AND owner_address = lower($2)
    AND status <> 'on_chain'
  RETURNING station_id`;

export interface MobileSyncResult {
  stationId: string;
  outcome: 'on_chain' | 'refused';
  reason: string;
}

function rowsAffected(res: { rowCount?: number | null; count?: number; rows?: any[] }): number {
  return typeof res.rowCount === 'number' ? res.rowCount : typeof res.count === 'number' ? res.count : (res.rows ?? []).length;
}

const CELL_HALF_WIDTH_E1 = 0.5; // 0.05 degrees, in tenths of a degree
const CELL_FLOAT_SLACK_E1 = 1e-6;

/** `tenths` is the registered cell centre (integer tenths of a degree). */
function withinRegisteredCell(degrees: number, tenths: unknown): boolean {
  const cell = Number(tenths);
  if (!Number.isInteger(cell) || !Number.isFinite(degrees)) return false;
  return Math.abs(degrees * 10 - cell) <= CELL_HALF_WIDTH_E1 + CELL_FLOAT_SLACK_E1;
}

async function syncOneMobileStation(entry: ChainStationListEntry, pool: BackfillPool): Promise<MobileSyncResult> {
  const stationId = entry.station_id;
  const refuse = (reason: string): MobileSyncResult => ({ stationId, outcome: 'refused', reason });

  if (entry.is_active !== true) return refuse('station is not active on chain');
  if (entry.provenance_class !== 'real') return refuse('chain provenance_class is not "real"');
  if (typeof entry.owner_address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(entry.owner_address)) {
    return refuse('chain owner_address is not a 0x-40-hex address');
  }

  // Exact id: a case/NFKC variant of a mob- id never matches a registration.
  const found = await pool.query(
    `SELECT station_id, owner_address, status, cell_lat_e1, cell_lon_e1 FROM mobile_station_registrations WHERE station_id = $1`,
    [stationId]
  );
  const reg = found.rows?.[0];
  if (!reg) return refuse('no mobile registration row for this station');
  if (String(reg.owner_address).toLowerCase() !== entry.owner_address.toLowerCase()) {
    return refuse('chain owner differs from the registered owner');
  }
  // Design §3.5 "no location beyond 0.1 degrees": the chain's coordinates must be
  // inside the registered cell, i.e. within +-0.05 degrees of its centre (the
  // export writes the centre, so an honest entry is exactly on it; half a cell
  // is the widest tolerance that still names the same cell). Never log the values.
  if (!withinRegisteredCell(entry.latitude, reg.cell_lat_e1) || !withinRegisteredCell(entry.longitude, reg.cell_lon_e1)) {
    return refuse('chain coordinates are outside the registered 0.1 degree cell');
  }

  // W21: what is stored is the registered cell centre, never the chain's point
  // inside the cell (the check above only proves the two name the same cell).
  const alreadyOnChain = reg.status === 'on_chain';
  const coords = await pool.query(alreadyOnChain ? OVERWRITE_COORDINATES_SQL : MOBILE_FILL_COORDINATES_SQL, [
    stationId,
    cellCentreDegrees(reg.cell_lat_e1),
    cellCentreDegrees(reg.cell_lon_e1),
    entry.owner_address,
  ]);
  if (!alreadyOnChain) {
    if (rowsAffected(coords) !== 1) {
      return refuse('no matching weather_stations row to fill');
    }
    const marked = await pool.query(MOBILE_MARK_ON_CHAIN_SQL, [stationId, entry.owner_address]);
    if (rowsAffected(marked) !== 1) {
      return refuse('registration changed concurrently; left unchanged (re-run to re-plan)');
    }
  }
  return { stationId, outcome: 'on_chain', reason: alreadyOnChain ? 'already on_chain; coordinates converged' : 'coordinates filled, status on_chain' };
}

export interface SyncSummary {
  chainStations: number;
  unlabelled: number;
  inserted: number;
  coordinatesFilled: number;
  coordinatesUpdated: number;
  unchanged: number;
  refused: number;
  notWritten: number;
  /** #1310: mob- stations advanced to (or confirmed) on_chain / refused. */
  mobileOnChain: number;
  mobileRefused: number;
  refusedIds: string[];
}

/**
 * One sync pass: list → join labels → the backfill's plan/apply rules.
 * Stations without a label are counted and skipped (never titled by id).
 */
export async function runStationSyncOnce(deps: {
  listStations: () => Promise<ChainStationListEntry[]>;
  labels: StationLabelMap;
  pool: BackfillPool;
}): Promise<SyncSummary & { plan: BackfillPlanItem[]; results: ApplyResult[]; mobile: MobileSyncResult[] }> {
  const chain: unknown[] = await deps.listStations();
  // Whole-list validation BEFORE any database access: one malformed entry
  // rejects the pass with zero writes (#1254 review round 62).
  assertValidStationList(chain);
  const byId = new Map<string, ChainStationListEntry>();
  for (const entry of chain) byId.set(entry.station_id, entry);

  const inputs: unknown[] = [];
  const mobileEntries: ChainStationListEntry[] = [];
  let unlabelled = 0;
  for (const [stationId, entry] of byId) {
    // The reserved prefix never goes through the generic path (no label needed
    // or used): it is handled below against the mobile registrations.
    if (isReservedMobileStationId(stationId)) {
      mobileEntries.push(entry);
      continue;
    }
    const label = Object.prototype.hasOwnProperty.call(deps.labels, stationId) ? deps.labels[stationId] : undefined;
    if (!label) {
      unlabelled += 1;
      continue;
    }
    inputs.push({
      stationId,
      name: label.name,
      ...(label.location !== undefined ? { location: label.location } : {}),
      ...(label.stationType !== undefined ? { stationType: label.stationType } : {}),
      latitude: entry.latitude,
      longitude: entry.longitude,
    });
  }

  // The registration each plan item checks is the SAME list entry the
  // coordinates came from: one consistent snapshot, no second read.
  const plan = await planBackfill(inputs, async (id) => byId.get(id) ?? null, deps.pool);
  const results = await applyBackfill(plan, deps.pool);

  // Q6: rows the backfill rules left alone because coordinates were already
  // present ("noop": same owner as the chain). Bring them to the chain's
  // coordinates. A refused row (different owner, synthetic, inactive) never
  // reaches this loop, and the SQL re-checks the owner.
  let coordinatesUpdated = 0;
  for (const item of plan) {
    if (item.action !== 'noop') continue;
    const entry = byId.get(item.stationId);
    if (!entry) continue;
    const res = await deps.pool.query(OVERWRITE_COORDINATES_SQL, [
      item.stationId,
      toStorageGrid(entry.latitude),
      toStorageGrid(entry.longitude),
      entry.owner_address,
    ]);
    const n = typeof res.rowCount === 'number' ? res.rowCount : typeof res.count === 'number' ? res.count : (res.rows ?? []).length;
    if (n === 1) coordinatesUpdated += 1;
  }

  const mobile: MobileSyncResult[] = [];
  for (const entry of mobileEntries) mobile.push(await syncOneMobileStation(entry, deps.pool));

  const summary: SyncSummary = {
    chainStations: byId.size,
    unlabelled,
    inserted: results.filter((r) => r.action === 'insert' && r.written).length,
    coordinatesFilled: results.filter((r) => r.action === 'fill-coordinates' && r.written).length,
    coordinatesUpdated,
    unchanged: plan.filter((p) => p.action === 'noop').length - coordinatesUpdated,
    refused: plan.filter((p) => p.action === 'refuse').length,
    notWritten: results.filter((r) => (r.action === 'insert' || r.action === 'fill-coordinates') && !r.written).length,
    mobileOnChain: mobile.filter((m) => m.outcome === 'on_chain').length,
    mobileRefused: mobile.filter((m) => m.outcome === 'refused').length,
    refusedIds: [
      ...plan.filter((p) => p.action === 'refuse').map((p) => p.stationId),
      ...mobile.filter((m) => m.outcome === 'refused').map((m) => idLabel(m.stationId)),
    ],
  };
  return { ...summary, plan, results, mobile };
}

export interface SyncLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface StartSyncOptions {
  env?: NodeJS.ProcessEnv;
  pool?: BackfillPool;
  logger?: SyncLogger;
  fetchImpl?: typeof fetch;
  setIntervalImpl?: typeof setInterval;
}

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncInFlight: Promise<unknown> | null = null;

/** Resolve the interval, clamped to at least MIN_SYNC_INTERVAL_MS. */
export function resolveSyncIntervalMs(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SYNC_INTERVAL_MS;
  return Math.max(MIN_SYNC_INTERVAL_MS, Math.floor(n));
}

/**
 * Start the periodic sync. Returns false (and does nothing) unless
 * STATION_CHAIN_SYNC_ENABLED=true and the node URL, operator token and label
 * map all resolve. One pass runs immediately; passes never overlap.
 */
export async function startChainStationSync(options: StartSyncOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const logger: SyncLogger = options.logger ?? {
    info: (m, meta) => console.log(m, meta ?? ''),
    warn: (m, meta) => console.warn(m, meta ?? ''),
  };
  if (env.STATION_CHAIN_SYNC_ENABLED !== 'true') return false;
  if (syncTimer) return true;

  const nodeUrl = env.CORE4_API_URL || env.BLOCKCHAIN_NODE_URL;
  const token = env.WRFCOIN_OPERATOR_TOKEN;
  if (!nodeUrl || !token) {
    logger.warn('Chain station sync not started: CORE4_API_URL and WRFCOIN_OPERATOR_TOKEN are required');
    return false;
  }
  let labels: StationLabelMap;
  try {
    labels = labelMapFromEnv(env);
  } catch (error) {
    logger.warn('Chain station sync not started: bad label map', { error: safeErrorText(error) });
    return false;
  }
  // An empty label map is valid: the mobile path (`mob-` stations -> on_chain, #1310)
  // needs no labels. Only labelled (PWS) sync is a no-op in that case.
  if (Object.keys(labels).length === 0) {
    logger.info('Chain station sync: no station labels configured; labelled sync covers 0 stations (mobile path only)');
  }

  let pool = options.pool;
  if (!pool) {
    const dbModule = await import('../../database/db.js');
    pool = (dbModule.pool ?? (dbModule as any).default?.pool) as BackfillPool | undefined;
    if (!pool) {
      logger.warn('Chain station sync not started: database pool unavailable');
      return false;
    }
  }
  const activePool = pool;
  const fetchImpl = options.fetchImpl ?? (nodeHttpFetch as unknown as typeof fetch);
  const intervalMs = resolveSyncIntervalMs(env.STATION_CHAIN_SYNC_INTERVAL_MS);

  const tick = () => {
    if (syncInFlight) return syncInFlight;
    syncInFlight = runStationSyncOnce({
      listStations: () => fetchChainStationList(nodeUrl, token, fetchImpl),
      labels,
      pool: activePool,
    })
      .then(({ plan: _plan, results: _results, mobile: _mobile, ...summary }) => {
        if (summary.refused > 0 || summary.notWritten > 0 || summary.mobileRefused > 0) {
          logger.warn('Chain station sync pass refused or skipped stations', { ...summary });
        } else {
          logger.info('Chain station sync pass complete', { ...summary });
        }
      })
      .catch((error) => {
        logger.warn('Chain station sync pass failed', { error: safeErrorText(error) });
      })
      .finally(() => {
        syncInFlight = null;
      });
    return syncInFlight;
  };

  const setIntervalImpl = options.setIntervalImpl ?? setInterval;
  syncTimer = setIntervalImpl(tick, intervalMs);
  (syncTimer as { unref?: () => void }).unref?.();
  logger.info('Chain station sync started', { intervalMs, labelledStations: Object.keys(labels).length });
  void tick();
  return true;
}

export async function stopChainStationSync(): Promise<void> {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (syncInFlight) await syncInFlight;
}
