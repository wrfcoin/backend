/**
 * Chain → DB station backfill (backend#1250; companion of #1247).
 *
 * Why this exists: the public contributor map (`GET /api/weather/stations`,
 * `listRegisteredStations`) reads ONLY the `weather_stations` table, and the
 * only writer of that table is self-service registration (`registerStation`).
 * The stations that actually earn on chain 777 were registered on chain by the
 * genesis-cut ceremony (governance-signed `POST /transactions/station/registrations`
 * on the node), which never touches the backend DB — so the live table is empty
 * while the chain has real, active stations.
 *
 * This module plans, and optionally applies, the missing rows. Its rules:
 *
 *  - The OWNER always comes from the chain's canonical registration
 *    (`GET /transactions/station/registrations/:id`), never from the input.
 *    (The old `scripts/seed-jon-station.ts` hard-coded an owner that does not
 *    match the chain's registered owner.)
 *  - A station that is not registered, not active, or not `provenance_class:
 *    real` on chain is REFUSED.
 *  - Coordinates, display name and location label come from the operator's
 *    input file (the chain API does not expose coordinates). The raw values are
 *    range-checked, then only their 0.1 degree grid point is planned and stored,
 *    as self-service registration stores them (owner ruling 2026-10-01, W21;
 *    utils/coordinate-grid.js). The anonymous read path still coarsens
 *    server-side (backend#1222/#1237), unchanged.
 *  - It never overwrites an existing row: a row with a different owner is
 *    REFUSED (owner mismatch is reported, not repaired); a row with the same
 *    owner only gets coordinates filled where they are NULL; anything else is a
 *    no-op. Every write is guarded in SQL as well, so a concurrent registration
 *    between plan and apply cannot be clobbered.
 *  - Dry-run is the default; `apply` is an explicit, separate call.
 *  - Output never prints a full owner address or coordinates.
 */

import { nodeHttpFetch } from '../../shared/core4-node-http.js';
import { toStorageGrid } from '../utils/coordinate-grid.js';
import { isReservedMobileStationId } from '../../shared/mobile-station-messages.js';

export interface BackfillStationInput {
  stationId: string;
  name: string;
  location?: string;
  latitude: number;
  longitude: number;
  stationType?: string;
}

export interface ChainStationRegistration {
  station_id: string;
  owner_address: string;
  provenance_class: string;
  is_active: boolean;
  observed_at_height?: number;
}

/** `null` = the node answered 404 (not registered). Throws on any other failure. */
export type FetchChainRegistration = (stationId: string) => Promise<ChainStationRegistration | null>;

export interface BackfillPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: any[]; rowCount?: number | null; count?: number }>;
}

export type BackfillAction = 'insert' | 'fill-coordinates' | 'noop' | 'refuse';

export interface BackfillPlanItem {
  stationId: string;
  action: BackfillAction;
  reason: string;
  /** Present for insert / fill-coordinates only. */
  row?: {
    stationId: string;
    ownerAddress: string;
    name: string;
    location: string;
    latitude: number;
    longitude: number;
    stationType: string | null;
    provenanceClass: string;
    chainObservedAtHeight: number | null;
  };
}

const STATION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * An error whose message is a fixed, content-free diagnostic and therefore
 * safe to print. Anything else (a JSON.parse excerpt, a driver message, a
 * socket error) may echo input or response bytes — station coordinates — and
 * is reported only by a fixed category (backend#1251 review P2).
 */
export class SafeDiagnosticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeDiagnosticError';
  }
}

const KNOWN_PROVENANCE = new Set(['real', 'synthetic', 'unclassified', 'simulated', 'test']);
const OWNER_RE = /^0x[0-9a-fA-F]{40}$/;

export function redactOwner(owner: string): string {
  return typeof owner === 'string' && owner.length > 8 ? `${owner.slice(0, 6)}…` : '<invalid>';
}

/** Validate one operator-supplied input row. Returns an error string or null. */
export function validateInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'input row is not an object';
  const row = input as Record<string, unknown>;
  if (typeof row.stationId !== 'string' || !STATION_ID_RE.test(row.stationId)) {
    return 'stationId must match ' + STATION_ID_RE.source;
  }
  if (isReservedMobileStationId(row.stationId)) {
    return "stationId uses the reserved 'mob-' prefix (mobile registration only)";
  }
  if (typeof row.name !== 'string' || row.name.trim() === '' || row.name.length > 120) {
    return 'name must be a non-empty string of at most 120 chars';
  }
  if (row.location !== undefined && (typeof row.location !== 'string' || row.location.length > 200)) {
    return 'location, when given, must be a string of at most 200 chars';
  }
  if (row.stationType !== undefined && (typeof row.stationType !== 'string' || row.stationType.length > 120)) {
    return 'stationType, when given, must be a string of at most 120 chars';
  }
  const lat = row.latitude;
  const lon = row.longitude;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return 'latitude must be a finite number in [-90, 90]';
  }
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return 'longitude must be a finite number in [-180, 180]';
  }
  if (lat === 0 && lon === 0) return 'latitude/longitude 0,0 is a placeholder, not a location';
  if ('ownerAddress' in row || 'owner_address' in row) {
    return 'input must not carry an owner: the owner is read from the chain';
  }
  return null;
}

export async function planBackfill(
  inputs: unknown[],
  fetchRegistration: FetchChainRegistration,
  pool: BackfillPool
): Promise<BackfillPlanItem[]> {
  const plan: BackfillPlanItem[] = [];
  const seen = new Set<string>();
  for (const raw of inputs) {
    const invalid = validateInput(raw);
    const rawId = (raw as { stationId?: unknown })?.stationId;
    const label = typeof rawId === 'string' && STATION_ID_RE.test(rawId) ? rawId : '<invalid>';
    if (invalid) {
      plan.push({ stationId: label, action: 'refuse', reason: `invalid input: ${invalid}` });
      continue;
    }
    const input = raw as BackfillStationInput;
    if (seen.has(input.stationId)) {
      plan.push({ stationId: input.stationId, action: 'refuse', reason: 'duplicate stationId in input' });
      continue;
    }
    seen.add(input.stationId);

    let reg: ChainStationRegistration | null;
    try {
      reg = await fetchRegistration(input.stationId);
    } catch (error) {
      plan.push({
        stationId: input.stationId,
        action: 'refuse',
        reason: `chain registration unreadable: ${error instanceof SafeDiagnosticError ? error.message : 'network or response error (details withheld)'}`,
      });
      continue;
    }
    if (!reg) {
      plan.push({ stationId: input.stationId, action: 'refuse', reason: 'not registered on chain (404)' });
      continue;
    }
    if (reg.station_id !== input.stationId) {
      plan.push({ stationId: input.stationId, action: 'refuse', reason: 'chain answered for a different station_id' });
      continue;
    }
    if (typeof reg.owner_address !== 'string' || !OWNER_RE.test(reg.owner_address)) {
      plan.push({ stationId: input.stationId, action: 'refuse', reason: 'chain owner_address is not a 0x-40-hex address' });
      continue;
    }
    if (reg.is_active !== true) {
      plan.push({ stationId: input.stationId, action: 'refuse', reason: 'station is not active on chain' });
      continue;
    }
    if (reg.provenance_class !== 'real') {
      plan.push({
        stationId: input.stationId,
        action: 'refuse',
        reason: `chain provenance_class is ${typeof reg.provenance_class === 'string' && KNOWN_PROVENANCE.has(reg.provenance_class) ? JSON.stringify(reg.provenance_class) : '<unrecognized>'}, not "real"`,
      });
      continue;
    }

    const row = {
      stationId: input.stationId,
      ownerAddress: reg.owner_address,
      name: input.name.trim(),
      location: (input.location ?? input.name).trim(),
      latitude: toStorageGrid(input.latitude),
      longitude: toStorageGrid(input.longitude),
      stationType: input.stationType ?? null,
      provenanceClass: reg.provenance_class,
      chainObservedAtHeight:
        typeof reg.observed_at_height === 'number' && Number.isFinite(reg.observed_at_height)
          ? reg.observed_at_height
          : null,
    };

    const existing = await pool.query(
      `SELECT owner_address, latitude, longitude FROM weather_stations WHERE station_id = $1`,
      [input.stationId]
    );
    const current = existing.rows?.[0];
    if (!current) {
      plan.push({ stationId: input.stationId, action: 'insert', reason: `new row, owner ${redactOwner(reg.owner_address)} (from chain)`, row });
      continue;
    }
    if (String(current.owner_address).toLowerCase() !== reg.owner_address.toLowerCase()) {
      plan.push({
        stationId: input.stationId,
        action: 'refuse',
        reason: `existing row owner ${redactOwner(String(current.owner_address))} differs from chain owner ${redactOwner(reg.owner_address)}; not overwritten`,
      });
      continue;
    }
    if (current.latitude === null || current.latitude === undefined || current.longitude === null || current.longitude === undefined) {
      plan.push({ stationId: input.stationId, action: 'fill-coordinates', reason: 'existing row (owner matches chain) has no coordinates', row });
      continue;
    }
    plan.push({ stationId: input.stationId, action: 'noop', reason: 'row already present with coordinates; left unchanged' });
  }
  return plan;
}

export interface ApplyResult {
  stationId: string;
  action: BackfillAction;
  written: boolean;
  reason: string;
}

function affected(result: { rowCount?: number | null; count?: number; rows?: any[] }): number {
  if (typeof result.rowCount === 'number') return result.rowCount;
  if (typeof result.count === 'number') return result.count;
  return Array.isArray(result.rows) ? result.rows.length : 0;
}

/**
 * Apply the insert / fill-coordinates items of a plan. Every statement is
 * guarded so it only writes into the state the plan observed: an insert never
 * replaces a row (ON CONFLICT DO NOTHING), and a coordinate fill only touches a
 * row that still has a NULL coordinate and the chain owner, and it fills ONLY
 * the NULL column(s): `COALESCE(existing, new)` never replaces a coordinate
 * already present, including one written between plan and apply (#1251 review P1).
 */
export async function applyBackfill(plan: BackfillPlanItem[], pool: BackfillPool): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  for (const item of plan) {
    if ((item.action !== 'insert' && item.action !== 'fill-coordinates') || !item.row) {
      results.push({ stationId: item.stationId, action: item.action, written: false, reason: item.reason });
      continue;
    }
    const r = item.row;
    if (item.action === 'insert') {
      const metadata = JSON.stringify({
        source: 'chain-backfill',
        provenanceClass: r.provenanceClass,
        chainObservedAtHeight: r.chainObservedAtHeight,
        ...(r.stationType ? { hardware: r.stationType } : {}),
      });
      // `$8::text::jsonb`, not `$8::jsonb`: with a jsonb-typed parameter some
      // postgres.js client configurations JSON-encode the already-stringified
      // metadata a second time and store a jsonb *string* (verified against
      // postgres:15 with `postgres(url)`), which would leave `metadata->>'…'`
      // NULL. A text parameter cast server-side is an object for every client.
      const res = await pool.query(
        `INSERT INTO weather_stations
           (station_id, owner_address, location, latitude, longitude, name, station_type, is_active, metadata, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::text::jsonb, now())
         ON CONFLICT (station_id) DO NOTHING
         RETURNING station_id`,
        [r.stationId, r.ownerAddress, r.location, toStorageGrid(r.latitude), toStorageGrid(r.longitude), r.name, r.stationType, metadata]
      );
      const written = affected(res) === 1;
      results.push({
        stationId: item.stationId,
        action: item.action,
        written,
        reason: written ? 'inserted' : 'row appeared concurrently; left unchanged (re-run to re-plan)',
      });
      continue;
    }
    const res = await pool.query(
      `UPDATE weather_stations
          SET latitude = COALESCE(latitude, $2), longitude = COALESCE(longitude, $3), updated_at = now()
        WHERE station_id = $1
          AND (latitude IS NULL OR longitude IS NULL)
          AND lower(owner_address) = lower($4)
        RETURNING station_id`,
      [r.stationId, toStorageGrid(r.latitude), toStorageGrid(r.longitude), r.ownerAddress]
    );
    const written = affected(res) === 1;
    results.push({
      stationId: item.stationId,
      action: item.action,
      written,
      reason: written ? 'coordinates filled' : 'row changed concurrently; left unchanged (re-run to re-plan)',
    });
  }
  return results;
}

/** Build a FetchChainRegistration over the node's operator-gated canonical read. */
export function nodeRegistrationFetcher(
  nodeUrl: string,
  operatorToken: string,
  fetchImpl: typeof fetch = nodeHttpFetch as unknown as typeof fetch
): FetchChainRegistration {
  const base = nodeUrl.replace(/\/+$/, '');
  return async (stationId: string) => {
    const res = await fetchImpl(`${base}/transactions/station/registrations/${encodeURIComponent(stationId)}`, {
      headers: { Authorization: `Bearer ${operatorToken}`, Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new SafeDiagnosticError(`node answered HTTP ${Number(res.status)}`);
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new SafeDiagnosticError('node response is not valid JSON');
    }
    // The node answers the bare record; tolerate an {ok,data} envelope too.
    const record = (body && typeof body === 'object' && 'data' in body && body.data ? body.data : body) as ChainStationRegistration;
    return record;
  };
}
