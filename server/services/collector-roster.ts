/**
 * The provider collector's roster, for website stations that are REGISTERED ON
 * CHAIN.
 *
 * The collector reads each contributor's provider account with that
 * contributor's own keys and submits the readings to the node. Its roster was a
 * hand-kept file, so a station connected on the website was never collected.
 * This builds the roster from what the backend already stores and checked.
 *
 * Who is on it: a website station whose registration row is `on_chain` (the
 * chain station sync is the only writer of that, and moves the row to
 * `blocked` when the chain shows the station transferred, deactivated or not
 * real), whose station row is active, has ingestion active and still belongs
 * to the wallet that signed, with a bound device (MAC), a
 * position, and both provider keys readable. A station that is deactivated,
 * blocked or changes owner is not returned by the next read.
 *
 * What an entry holds is what the collector's roster check requires
 * (core4 tests/security/lib/ambient-roster-verifier.cjs): provider, stationId,
 * ownerAddress, mac, model, consentStatus, coarseMetadataStatus, bindingRef,
 * plus the two keys and the position. The position is the 0.1 degree grid
 * point and is ALWAYS present: without one the collector falls back to the
 * provider's own, precise, coordinates. No station name is sent.
 *
 * This is the most sensitive read the backend has: it returns DECRYPTED
 * provider keys. It is OFF by default (`COLLECTOR_ROSTER_ENABLED=true`), the
 * route in front of it takes the operator token only, and nothing here logs a
 * key, a provider answer or an error message that could hold one.
 */
import { decryptData } from '../utils/crypto.js';

type Env = Record<string, string | undefined>;

export const COLLECTOR_ROSTER_VERSION = 'collector_roster_v1';
/** More stations than this is not a roster this route should hand to one caller. */
export const MAX_COLLECTOR_ROSTER_ENTRIES = 500;
/** The model sent when the owner picked no hardware: the chain record's hardware_model. */
export const DEFAULT_ROSTER_MODEL = 'personal-weather-station';

export function collectorRosterEnabled(env: Env = process.env): boolean {
  return env.COLLECTOR_ROSTER_ENABLED === 'true';
}

export interface CollectorRosterPool {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

export interface CollectorRosterEntry {
  provider: 'ambient';
  stationId: string;
  ownerAddress: string;
  /** The device this station is bound to: AA:BB:CC:DD:EE:FF. */
  mac: string;
  model: string;
  consentStatus: 'approved';
  coarseMetadataStatus: 'approved';
  /** A label for where the keys came from. Never key material. */
  bindingRef: string;
  apiKey: string;
  appKey: string;
  /** The 0.1 degree grid point. Never finer, never absent. */
  latitude: number;
  longitude: number;
  elevation_m?: number;
}

export interface CollectorRoster {
  version: typeof COLLECTOR_ROSTER_VERSION;
  stations: CollectorRosterEntry[];
  /** Stations that are on chain but could not be put on the roster. A count only. */
  skipped: number;
}

/**
 * Read-only. `on_chain`, active, still the signer's, with ambient credentials.
 * Ordered so a full page is stable; one row more than the cap is read so the
 * caller can tell a full roster from a cut one.
 */
export const COLLECTOR_ROSTER_SQL = `SELECT r.station_id, r.owner_address,
            w.latitude, w.longitude, w.metadata,
            c.encrypted_api_key, c.key_iv, c.key_tag, c.encrypted_app_key, c.app_iv, c.app_tag
       FROM website_station_chain_registrations r
       JOIN weather_stations w ON w.station_id = r.station_id
       JOIN station_provider_credentials c ON c.station_id = w.station_id AND c.provider = 'ambient'
      WHERE r.status = 'on_chain'
        AND w.is_active = true
        AND w.metadata->>'ingestionStatus' = 'active'
        AND lower(w.owner_address) = r.owner_address
      ORDER BY r.station_id
      LIMIT $1`;

const STATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OWNER_RE = /^0x[0-9a-f]{40}$/;

function metadataOf(raw: unknown): Record<string, unknown> {
  let meta = raw;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return {};
    }
  }
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

/** AA:BB:CC:DD:EE:FF from any spelling of twelve hex digits, else null. */
export function rosterMac(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || /[^0-9a-f:\-. ]/i.test(value.trim())) return null;
  return hex.toUpperCase().match(/.{2}/g)!.join(':');
}

function rosterModel(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_ROSTER_MODEL;
  const model = value.trim();
  // Printable ASCII only: this string is compared and logged by the collector.
  return model.length > 0 && model.length <= 128 && /^[\x20-\x7e]+$/.test(model) ? model : DEFAULT_ROSTER_MODEL;
}

/** Degrees at 0.1, without float drift and never "-0"; null when there is no usable value. */
function gridPoint(value: unknown, limit: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return Number((Math.round(n * 10) / 10).toFixed(1)) + 0;
}

function decryptOrNull(encrypted: unknown, iv: unknown, tag: unknown, encryptionKey: string): string | null {
  if (typeof encrypted !== 'string' || typeof iv !== 'string' || typeof tag !== 'string') return null;
  try {
    const plain = decryptData({ encrypted, iv, tag }, encryptionKey);
    return typeof plain === 'string' && plain.length > 0 ? plain : null;
  } catch {
    // The error is dropped on purpose: nothing about a key is logged or returned.
    return null;
  }
}

/**
 * Build the roster. A row that cannot be turned into a complete entry is left
 * out and counted; it never fails the read and never shows up half-filled.
 * Throws only if the database read itself fails.
 */
export async function listCollectorRoster(pool: CollectorRosterPool, encryptionKey: string): Promise<CollectorRoster> {
  const result = await pool.query(COLLECTOR_ROSTER_SQL, [MAX_COLLECTOR_ROSTER_ENTRIES + 1]);
  const rows = (result.rows || []).slice(0, MAX_COLLECTOR_ROSTER_ENTRIES);
  let skipped = (result.rows || []).length - rows.length;
  const stations: CollectorRosterEntry[] = [];
  const seenMacs = new Set<string>();
  for (const row of rows) {
    const stationId = typeof row.station_id === 'string' ? row.station_id : '';
    const ownerAddress = typeof row.owner_address === 'string' ? row.owner_address : '';
    const meta = metadataOf(row.metadata);
    const mac = rosterMac(meta.mac);
    const latitude = gridPoint(row.latitude, 90);
    const longitude = gridPoint(row.longitude, 180);
    const apiKey = decryptOrNull(row.encrypted_api_key, row.key_iv, row.key_tag, encryptionKey);
    const appKey = decryptOrNull(row.encrypted_app_key, row.app_iv, row.app_tag, encryptionKey);
    if (
      !STATION_ID_RE.test(stationId) || !OWNER_RE.test(ownerAddress) || mac === null ||
      latitude === null || longitude === null || apiKey === null || appKey === null ||
      // One device, one station: a second station on the same device is never sent.
      seenMacs.has(mac)
    ) {
      skipped += 1;
      continue;
    }
    seenMacs.add(mac);
    // Rounded to 10 m: the roster carries no detail finer than the collector needs.
    const elevation = meta.elevation_m;
    stations.push({
      provider: 'ambient',
      stationId,
      ownerAddress,
      mac,
      model: rosterModel(meta.hardware),
      consentStatus: 'approved',
      coarseMetadataStatus: 'approved',
      bindingRef: `backend:website-station:${stationId}`,
      apiKey,
      appKey,
      latitude,
      longitude,
      ...(typeof elevation === 'number' && Number.isFinite(elevation) ? { elevation_m: Math.round(elevation / 10) * 10 + 0 } : {}),
    });
  }
  return { version: COLLECTOR_ROSTER_VERSION, stations, skipped };
}
