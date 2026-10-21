/**
 * Operator export of `db_only` mobile registrations (backend#1288, story B5).
 * Design: docs/plans/2026-09-29-per-phone-station-registration-design.md §3.5 option A.
 *
 * Pure builders plus two tiny SQL helpers; the CLI wrapper is
 * scripts/export-mobile-station-registrations.ts. Nothing here signs anything or
 * touches a governance key: the artifact carries the PHONE's public proof
 * material (owner pubkey + its signature over core4's station-ownership preimage)
 * so the operator's ceremony can assemble the on-chain StationRegistration.
 *
 * Every row is re-verified before it is exported (derived id, owner-from-pubkey,
 * ownership signature under THIS chain/network, on-grid cell); a row that fails
 * is skipped and reported by station id and a fixed reason only.
 */
import { createHash } from 'node:crypto';
import {
  buildStationOwnershipMessage,
  deriveMobileStationId,
} from '../../shared/mobile-station-messages.js';
import { verifyEd25519SignatureBytes } from '../routes/wallet-auth-service.js';

export const EXPORT_VERSION = 'mobile_station_registration_export_v1';
export const EXPORT_DEVICE_CLASS = 'phone-barometer';
export const EXPORT_DATA_QUALITY_TIER = 'unverified' as const;

export interface ExportRow {
  stationId: string;
  ownerAddress: string;
  ownerPubkey: string;
  ownershipSignature: string;
  cellLatE1: number;
  cellLonE1: number;
  deviceClass: string;
}

/**
 * One registration, shaped so `wrfcoin-cli station build-registration --batch`
 * (core4#3383) can consume it directly: snake_case, chain/network per row.
 */
export interface ExportStation {
  station_id: string;
  owner_address: string;
  owner_pubkey: string;
  owner_signature: string;
  /** The cell's grid point in degrees (integer tenths / 10). */
  latitude: number;
  longitude: number;
  cell: { lat_e1: number; lon_e1: number };
  hardware_model: string;
  chain_id: string;
  network_id: string;
  /** Proposed class; the operator's review is what actually authorises `real`. */
  provenance_class: 'real';
  /**
   * Explicit, so a `--batch` consumer never falls back to the CLI's `gold` default
   * (core4 tools/cli/WrfcoinCLI/src/commands/station.rs:95). An uncalibrated phone
   * barometer has not earned any tier: `unverified` is core4's own enum default
   * (shared-protocol/src/station_registry.rs:75-79). A tier change is a governance call.
   */
  data_quality_tier: typeof EXPORT_DATA_QUALITY_TIER;
}

/**
 * The exact row shape core4 `wrfcoin station build-registration --batch` accepts
 * (tools/cli/WrfcoinCLI/src/commands/station.rs `RegistrationRow`, serde
 * deny_unknown_fields): NO chain_id/network_id/cell keys.
 */
export interface CliBatchRow {
  station_id: string;
  owner_address: string;
  owner_pubkey: string;
  owner_signature: string;
  latitude: number;
  longitude: number;
  hardware_model: string;
  provenance_class: 'real';
  data_quality_tier: typeof EXPORT_DATA_QUALITY_TIER;
  submitted_at: number;
}

/**
 * Pure projection of export stations to the core4 CLI batch input: a bare array,
 * input order preserved, only the keys core4 accepts. `submittedAt` is supplied
 * by the operator (no clock read here) so the output is deterministic.
 */
export function buildCliBatch(stations: ExportStation[], submittedAt: number): CliBatchRow[] {
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

export interface ExportArtifact {
  version: typeof EXPORT_VERSION;
  chainId: string;
  networkId: string;
  batchId: string;
  stations: ExportStation[];
}

export interface SkippedRow {
  stationId: string;
  reason: string;
}

function ownerFromPubkey(pubkeyHex: string): string {
  return `0x${createHash('sha3-256').update(Buffer.from(pubkeyHex, 'hex')).digest('hex').slice(0, 40)}`;
}

/** Integer tenths -> degrees without float drift (7 -> 0.7, -3 -> -0.3). */
function tenthsToDegrees(tenths: number): number {
  return Number((tenths / 10).toFixed(1));
}

function rowProblem(row: ExportRow, chainId: string, networkId: string): string | null {
  if (row.deviceClass !== EXPORT_DEVICE_CLASS) return 'device class is not phone-barometer';
  if (!/^[0-9a-f]{64}$/.test(row.ownerPubkey)) return 'owner pubkey is not 32-byte hex';
  if (!/^[0-9a-f]{128}$/.test(row.ownershipSignature)) return 'ownership signature is not 64-byte hex';
  if (
    !Number.isInteger(row.cellLatE1) || !Number.isInteger(row.cellLonE1) ||
    row.cellLatE1 < -900 || row.cellLatE1 > 900 || row.cellLonE1 < -1800 || row.cellLonE1 > 1800
  ) {
    return 'cell is off the 0.1 degree grid';
  }
  if (ownerFromPubkey(row.ownerPubkey) !== row.ownerAddress) return 'owner is not derived from the owner pubkey';
  let derived: string;
  try {
    derived = deriveMobileStationId(row.ownerAddress);
  } catch {
    return 'owner address is not a chain address';
  }
  if (derived !== row.stationId) return 'station id is not the id derived from the owner';
  const message = buildStationOwnershipMessage({
    chainId, networkId, stationId: row.stationId, ownerAddress: row.ownerAddress,
  });
  if (!verifyEd25519SignatureBytes(row.ownerPubkey, row.ownershipSignature, message)) {
    return 'ownership signature does not verify';
  }
  return null;
}

/** Deterministic: rows are ordered by station id, no clock is read. */
export function buildExportArtifact(
  rows: ExportRow[],
  opts: { chainId: string; networkId: string; batchId: string }
): { artifact: ExportArtifact; skipped: SkippedRow[] } {
  const stations: ExportStation[] = [];
  const skipped: SkippedRow[] = [];
  for (const row of [...rows].sort((a, b) => (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0))) {
    const problem = rowProblem(row, opts.chainId, opts.networkId);
    if (problem) {
      skipped.push({ stationId: row.stationId, reason: problem });
      continue;
    }
    stations.push({
      station_id: row.stationId,
      owner_address: row.ownerAddress,
      owner_pubkey: row.ownerPubkey,
      owner_signature: row.ownershipSignature,
      latitude: tenthsToDegrees(row.cellLatE1),
      longitude: tenthsToDegrees(row.cellLonE1),
      cell: { lat_e1: row.cellLatE1, lon_e1: row.cellLonE1 },
      hardware_model: EXPORT_DEVICE_CLASS,
      chain_id: opts.chainId,
      network_id: opts.networkId,
      provenance_class: 'real',
      data_quality_tier: EXPORT_DATA_QUALITY_TIER,
    });
  }
  return {
    artifact: { version: EXPORT_VERSION, chainId: opts.chainId, networkId: opts.networkId, batchId: opts.batchId, stations },
    skipped,
  };
}

export interface ExportPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: any[]; rowCount?: number | null }>;
}

export async function selectDbOnlyRows(pool: ExportPool, limit: number): Promise<ExportRow[]> {
  const res = await pool.query(
    `SELECT station_id, owner_address, owner_pubkey, ownership_signature, cell_lat_e1, cell_lon_e1, device_class
       FROM mobile_station_registrations
      WHERE status = 'db_only'
      ORDER BY created_at, station_id
      LIMIT $1`,
    [limit]
  );
  return (res.rows ?? []).map((r) => ({
    stationId: r.station_id,
    ownerAddress: r.owner_address,
    ownerPubkey: r.owner_pubkey,
    ownershipSignature: r.ownership_signature,
    cellLatE1: Number(r.cell_lat_e1),
    cellLonE1: Number(r.cell_lon_e1),
    deviceClass: r.device_class,
  }));
}

/** db_only -> submitted for exactly these ids; a row that moved meanwhile is left alone. */
export async function markRowsSubmitted(pool: ExportPool, stationIds: string[], batchId: string): Promise<number> {
  if (stationIds.length === 0) return 0;
  const res = await pool.query(
    `UPDATE mobile_station_registrations
        SET status = 'submitted', governance_batch_id = $2, updated_at = now()
      WHERE station_id = ANY($1::text[]) AND status = 'db_only'`,
    [stationIds, batchId]
  );
  return typeof res.rowCount === 'number' ? res.rowCount : 0;
}
