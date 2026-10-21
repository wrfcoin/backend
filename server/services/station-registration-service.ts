/**
 * Station Registration Service (backend#788)
 *
 * Pure, dependency-injected business logic for self-service weather-station
 * onboarding. The Express route layer (server/routes/weather-routes.js) wires
 * the real pool / fetch / crypto in; tests inject mocks.
 *
 * SECURITY:
 * - Provider API keys are validated against the live provider before storage.
 * - Keys are encrypted at rest (AES-256-GCM) with API_KEY_ENCRYPTION_KEY.
 * - Plaintext keys are NEVER logged.
 */

import { normalizeOwnerAddress } from './owner-address.js';
import { isReservedMobileStationId } from '../../shared/mobile-station-messages.js';
import { encryptData, decryptData, type EncryptionResult } from '../utils/crypto.js';

// Minimal pg.Pool-like surface used by this service.
export interface QueryablePool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface AmbientDevice {
  name: string;
  mac: string;
  latitude: number | null;
  longitude: number | null;
}

export interface VerifyKeyResult {
  valid: boolean;
  devices: AmbientDevice[];
  status?: number;
  emptyAccount?: boolean;
}

export interface RegisterStationInput {
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  location?: unknown;
  provider?: unknown;
  ambientApiKey?: unknown;
  ambientAppKey?: unknown;
  hardware?: unknown;
  mac?: unknown;
  stationId?: unknown;
  /**
   * Optional hardware-root public key (smart-contracts#161 uniqueness
   * contract): 64-hex ed25519. When present it is strictly validated and
   * enforced unique across stations at admission — one hardware root, one
   * station identity, mirroring the on-chain rule before it exists. Optional
   * because the live fleet is cloud-pulled consumer hardware with no
   * device-held root; those stations register without one and simply are not
   * chain-accruing identities under #161.
   */
  hardwarePubkey?: unknown;
  /**
   * Optional operator elevation override, metres above sea level of the
   * SENSOR (core4#3285). When present it wins over the DEM lookup and is used
   * exactly as given — sensor height is NOT added to it. Accepted as
   * `elevation_meters` (the core4 StationRegistrationPayload spelling) or
   * `elevationMeters`.
   */
  elevation_meters?: unknown;
  elevationMeters?: unknown;
  /**
   * Optional sensor height above ground, metres (core4#3285). Added to the
   * USGS DEM ground elevation when no override is given. Defaults to 0.
   * Accepted as `sensor_height_m` or `sensorHeightM`.
   */
  sensor_height_m?: unknown;
  sensorHeightM?: unknown;
  /**
   * What the station's reported `pressure_hpa` IS (core4#3285):
   * `absolute` = station pressure at the sensor (e.g. an Ambient station whose
   * relative pressure equals absolute), `relative` = a sea-level-adjusted value
   * (Ambient `baromrelin` with an owner offset). The reference shadow scorer
   * forwards the elevation to oracle-reference only for `absolute`, and skips
   * the pressure residual when the kind is unknown. Accepted as
   * `pressure_kind` or `pressureKind`.
   */
  pressure_kind?: unknown;
  pressureKind?: unknown;
}

export interface RegisterStationDeps {
  pool: QueryablePool;
  fetchFn: FetchLike;
  encryptionKey: string;
}

export interface RegisterStationOptions {
  /**
   * Set when the request carried a valid admin override (X-Admin-Token). When
   * true, an existing station may be reassigned to a different owner; otherwise
   * a station-id conflict with a different owner is rejected (see #789).
   */
  isAdminOverride?: boolean;
  /**
   * Raw MAX_STATIONS_PER_OWNER env value (#589). Parsed by
   * resolveMaxStationsPerOwner: malformed values fall back to the default
   * rather than widening to Infinity — a deploy-manifest typo must not
   * silently remove the registration cap.
   */
  maxStationsPerOwner?: unknown;
}

/**
 * Per-owner registration cap (#589): the concrete answer to "what stops someone
 * registering 10,000 stations?". Registration already requires a wallet JWT and
 * a live-validated provider key; this bounds how far one wallet can stretch
 * those. Default deliberately small — a real household fleet is single digits;
 * raising it is an env change, not a code change. `0` freezes registration.
 */
export const DEFAULT_MAX_STATIONS_PER_OWNER = 10;

export function resolveMaxStationsPerOwner(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_MAX_STATIONS_PER_OWNER;
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return DEFAULT_MAX_STATIONS_PER_OWNER;
  }
  return n;
}

export interface RegisterStationResult {
  status: number;
  body: Record<string, unknown>;
}

const AMBIENT_DEVICES_URL = 'https://rt.ambientweather.net/v1/devices';

/**
 * Providers the platform recognises for self-service registration (#847).
 *
 * `ambient` has a fully-wired ingestion path: its API keys are validated live
 * against the Ambient Weather API, encrypted at rest, and pulled by the
 * multi-tenant collector (core4#1732). It is the only provider whose data
 * actively flows on-chain today.
 *
 * The remaining providers have data-format converters in
 * shared/weather-station-protocol.js but NO live ingestion backend yet (no
 * collector pull, no key-validation endpoint). They are accepted so the
 * station appears on the contributor map and the owner can complete setup, but
 * they are registered in a clearly "pending" state — we do NOT pretend their
 * data is flowing and we do NOT validate or store provider keys for them.
 */
/** A MAC with separators (':', '-', none) and case removed: the identity of one device. */
export function canonicalMac(value: string): string {
  return value.toLowerCase().replace(/[^0-9a-f]/g, '');
}

export const LIVE_INGESTION_PROVIDERS = ['ambient'] as const;
export const PENDING_INGESTION_PROVIDERS = ['acurite', 'davis', 'netatmo', 'ecowitt', 'tempest'] as const;
export const SUPPORTED_PROVIDERS: readonly string[] = [
  ...LIVE_INGESTION_PROVIDERS,
  ...PENDING_INGESTION_PROVIDERS,
];

export function isSupportedProvider(provider: string): boolean {
  return SUPPORTED_PROVIDERS.includes(provider);
}

export function isLiveIngestionProvider(provider: string): boolean {
  return (LIVE_INGESTION_PROVIDERS as readonly string[]).includes(provider);
}

export function slug(name: string): string {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'station';
}

/**
 * Validate an Ambient Weather key pair by calling the devices API.
 * Returns the (sanitized) device list on success. Never logs the keys.
 */
export async function verifyAmbientKey(
  fetchFn: FetchLike,
  apiKey: string,
  appKey: string
): Promise<VerifyKeyResult> {
  const url = `${AMBIENT_DEVICES_URL}?applicationKey=${encodeURIComponent(appKey)}&apiKey=${encodeURIComponent(apiKey)}`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, { method: 'GET' });
  } catch {
    return { valid: false, devices: [], status: 0 };
  }

  if (!res.ok) {
    return { valid: false, devices: [], status: res.status };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { valid: false, devices: [], status: res.status };
  }

  if (!Array.isArray(payload)) {
    return { valid: false, devices: [], status: res.status };
  }
  if (payload.length === 0) {
    return { valid: false, devices: [], status: res.status, emptyAccount: true };
  }

  const devices: AmbientDevice[] = payload.map((d) => {
    const dev = (d ?? {}) as Record<string, unknown>;
    const info = (dev.info ?? {}) as Record<string, unknown>;
    const coords = (info.coords ?? {}) as Record<string, unknown>;
    const inner = (coords.coords ?? {}) as Record<string, unknown>;
    return {
      name: typeof info.name === 'string' ? info.name : String(dev.macAddress ?? 'Ambient Device'),
      mac: typeof dev.macAddress === 'string' ? dev.macAddress : '',
      latitude: typeof inner.lat === 'number' ? inner.lat : null,
      longitude: typeof inner.lon === 'number' ? inner.lon : null,
    };
  });

  return { valid: true, devices, status: res.status };
}

export { normalizeOwnerAddress };

// ---------------------------------------------------------------------------
// Station elevation (core4#3285)
// ---------------------------------------------------------------------------

/**
 * USGS Elevation Point Query Service. Free and public, no API key. Returns
 * ground elevation from the 3DEP DEM; `value` arrives as a string.
 */
export const USGS_EPQS_URL = 'https://epqs.nationalmap.gov/v1/json';
export const DEM_LOOKUP_TIMEOUT_MS = 5_000;

/** Plausible sensor elevation bounds (Dead Sea shore to above Everest). */
export const MIN_ELEVATION_M = -450;
export const MAX_ELEVATION_M = 9_000;
/** A mast taller than this is a typo, not a weather station. */
export const MAX_SENSOR_HEIGHT_M = 100;

export type ElevationSource = 'operator_override' | 'usgs_epqs_dem';

export interface StationElevation {
  /** Sensor elevation ASL in metres, or null when it could not be established. */
  elevationM: number | null;
  source: ElevationSource | null;
  /** DEM ground elevation (only for source === 'usgs_epqs_dem'). */
  demGroundElevationM?: number;
  /** Sensor height added to the DEM ground elevation. */
  sensorHeightM?: number;
  /** Why no elevation was recorded (only when elevationM is null). */
  unavailableReason?: string;
}

/** Round to centimetres so the stored value is stable across float noise. */
function roundCm(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * "Not provided": undefined, null, or an empty / whitespace-only string. An
 * empty form field for an optional override means "no override" (the DEM path
 * runs); it is never read as 0.
 */
function isNotProvided(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function pickDefined(a: unknown, b: unknown): unknown {
  return isNotProvided(a) ? b : a;
}

export const PRESSURE_KINDS = ['absolute', 'relative'] as const;
export type PressureKind = (typeof PRESSURE_KINDS)[number];

// Plain (non-discriminated) shape: this package compiles without
// strictNullChecks, where boolean-literal unions do not narrow.
interface ParsedOptional {
  value: number | null;
  error?: string;
}

function parseOptionalNumber(raw: unknown, field: string, min: number, max: number): ParsedOptional {
  if (isNotProvided(raw)) return { value: null };
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!isFiniteNumber(n) || n < min || n > max) {
    return { value: null, error: `${field} must be a number in [${min}, ${max}]` };
  }
  return { value: n };
}

export interface DemLookupResult {
  /** DEM ground elevation in metres, or null on any failure. */
  groundElevationM: number | null;
  /** Failure reason when groundElevationM is null. */
  reason?: string;
}

/**
 * Look up DEM ground elevation at a point. Returns null on ANY failure —
 * unreachable service, timeout, non-2xx, non-JSON, missing/no-data value.
 * The caller then registers WITHOUT an elevation: a guessed elevation would
 * become a wrong sea-level pressure (~0.12 hPa per metre), and a station with
 * no elevation is simply paired exactly as today.
 */
export async function lookupDemElevation(
  fetchFn: FetchLike,
  latitude: number,
  longitude: number,
  timeoutMs: number = DEM_LOOKUP_TIMEOUT_MS
): Promise<DemLookupResult> {
  const url =
    `${USGS_EPQS_URL}?x=${encodeURIComponent(String(longitude))}` +
    `&y=${encodeURIComponent(String(latitude))}&units=Meters&wkid=4326&includeDate=false`;
  // The timer ABORTS the request (no orphaned background fetch) and also
  // rejects the race, so a fetch implementation that ignores the signal still
  // cannot hang registration.
  const controller = new globalThis.AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    const res = await Promise.race([
      fetchFn(url, { method: 'GET', signal: controller.signal }),
      timeout,
    ]);
    if (!res.ok) return { groundElevationM: null, reason: `dem_http_${res.status}` };
    const body = (await Promise.race([res.json(), timeout])) as Record<string, unknown> | null;
    const raw = body && typeof body === 'object' ? body.value : undefined;
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    // EPQS reports no-data as -1000000; anything outside the plausible band
    // is treated the same way.
    if (!isFiniteNumber(value) || value < MIN_ELEVATION_M || value > MAX_ELEVATION_M) {
      return { groundElevationM: null, reason: 'dem_no_data' };
    }
    return { groundElevationM: value };
  } catch (error) {
    return {
      groundElevationM: null,
      reason:
        (error as Error)?.message === 'timeout' || controller.signal.aborted
          ? 'dem_timeout'
          : 'dem_unreachable',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve the sensor elevation for a registration (core4#3285 owner ruling):
 * operator override wins; otherwise USGS DEM ground elevation + sensor height;
 * DEM failure => no elevation, never a guess.
 */
export async function resolveStationElevation(
  fetchFn: FetchLike,
  latitude: number,
  longitude: number,
  overrideM: number | null,
  sensorHeightM: number | null,
  timeoutMs: number = DEM_LOOKUP_TIMEOUT_MS
): Promise<StationElevation> {
  if (overrideM !== null) {
    return { elevationM: roundCm(overrideM), source: 'operator_override' };
  }
  const dem = await lookupDemElevation(fetchFn, latitude, longitude, timeoutMs);
  if (dem.groundElevationM === null) {
    return { elevationM: null, source: null, unavailableReason: dem.reason };
  }
  const height = sensorHeightM ?? 0;
  const elevationM = roundCm(dem.groundElevationM + height);
  if (elevationM > MAX_ELEVATION_M) {
    return { elevationM: null, source: null, unavailableReason: 'dem_no_data' };
  }
  return {
    elevationM,
    source: 'usgs_epqs_dem',
    demGroundElevationM: roundCm(dem.groundElevationM),
    sensorHeightM: height,
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The registration grid: 0.1 degree (~11 km), the public and phone grid. */
export const REGISTRATION_COORDINATE_DECIMALS = 1;
export function toRegistrationGrid(value: number): number {
  const factor = 10 ** REGISTRATION_COORDINATE_DECIMALS;
  // `+ 0` turns -0 into 0, so a value just below zero is not stored as "-0".
  return Math.round(value * factor) / factor + 0;
}

/**
 * Core registration logic. Returns a {status, body} envelope; the route maps it
 * straight to res.status(status).json(body).
 */
export async function registerStation(
  input: RegisterStationInput,
  rawOwnerAddress: string,
  deps: RegisterStationDeps,
  randomHex: (bytes: number) => string,
  options: RegisterStationOptions = {}
): Promise<RegisterStationResult> {
  const { pool, fetchFn, encryptionKey } = deps;
  const isAdminOverride = options.isAdminOverride === true;
  // Case-insensitive owner identity: lock key, conflict check, cap count and
  // the written row all use the lowercased form.
  const ownerAddress = normalizeOwnerAddress(rawOwnerAddress);

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const inputLatitude = typeof input.latitude === 'string' ? Number(input.latitude) : input.latitude;
  const inputLongitude = typeof input.longitude === 'string' ? Number(input.longitude) : input.longitude;
  const provider = typeof input.provider === 'string' && input.provider ? input.provider : 'ambient';
  const location = typeof input.location === 'string' && input.location.trim() ? input.location.trim() : null;
  const hardware = typeof input.hardware === 'string' ? input.hardware : null;
  const mac = typeof input.mac === 'string' && input.mac.trim() ? input.mac.trim().toLowerCase() : null;
  const ambientApiKey = typeof input.ambientApiKey === 'string' ? input.ambientApiKey : '';
  const ambientAppKey = typeof input.ambientAppKey === 'string' ? input.ambientAppKey : '';
  const hardwarePubkeyRaw = input.hardwarePubkey;
  const elevationOverride = parseOptionalNumber(
    pickDefined(input.elevation_meters, input.elevationMeters),
    'elevation_meters',
    MIN_ELEVATION_M,
    MAX_ELEVATION_M
  );
  const sensorHeight = parseOptionalNumber(
    pickDefined(input.sensor_height_m, input.sensorHeightM),
    'sensor_height_m',
    0,
    MAX_SENSOR_HEIGHT_M
  );
  const pressureKindRaw = pickDefined(input.pressure_kind, input.pressureKind);

  // --- validation ---
  if (!name) {
    return { status: 400, body: { error: 'INVALID_REQUEST', message: 'name is required' } };
  }
  if (!isFiniteNumber(inputLatitude) || inputLatitude < -90 || inputLatitude > 90) {
    return { status: 400, body: { error: 'INVALID_REQUEST', message: 'latitude must be in [-90, 90]' } };
  }
  if (!isFiniteNumber(inputLongitude) || inputLongitude < -180 || inputLongitude > 180) {
    return { status: 400, body: { error: 'INVALID_REQUEST', message: 'longitude must be in [-180, 180]' } };
  }
  // W20 (owner ruling 2026-10-01, frontend#437): a registered position is kept
  // at 0.1 degree, like the phones. Anything finer is rounded here, before it
  // is stored, labelled or sent to the DEM lookup, so no exact position is
  // kept or forwarded whatever the client sent.
  const latitude = toRegistrationGrid(inputLatitude);
  const longitude = toRegistrationGrid(inputLongitude);
  if (!isSupportedProvider(provider)) {
    return {
      status: 400,
      body: {
        error: 'UNSUPPORTED_PROVIDER',
        message: `unsupported provider '${provider}'; supported providers are: ${SUPPORTED_PROVIDERS.join(', ')}`,
        supportedProviders: [...SUPPORTED_PROVIDERS],
      },
    };
  }
  // Elevation inputs (core4#3285): rejected, never coerced — a wrong elevation
  // becomes a wrong sea-level pressure.
  if (elevationOverride.error) {
    return { status: 400, body: { error: 'INVALID_ELEVATION', message: elevationOverride.error } };
  }
  if (sensorHeight.error) {
    return { status: 400, body: { error: 'INVALID_SENSOR_HEIGHT', message: sensorHeight.error } };
  }
  let pressureKind: PressureKind | null = null;
  if (!isNotProvided(pressureKindRaw)) {
    if (typeof pressureKindRaw !== 'string' || !(PRESSURE_KINDS as readonly string[]).includes(pressureKindRaw)) {
      return {
        status: 400,
        body: { error: 'INVALID_PRESSURE_KIND', message: `pressure_kind must be one of: ${PRESSURE_KINDS.join(', ')}` },
      };
    }
    pressureKind = pressureKindRaw as PressureKind;
  }
  // Hardware root (smart-contracts#161): strictly validated when present —
  // reject, never coerce. A malformed root registered today becomes a chain
  // identity that can never bind tomorrow.
  let hardwarePubkey: string | null = null;
  if (hardwarePubkeyRaw !== undefined && hardwarePubkeyRaw !== null && hardwarePubkeyRaw !== '') {
    if (typeof hardwarePubkeyRaw !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hardwarePubkeyRaw)) {
      return {
        status: 400,
        body: {
          error: 'INVALID_HARDWARE_PUBKEY',
          message: 'hardwarePubkey must be a 64-hex-character ed25519 public key',
        },
      };
    }
    hardwarePubkey = hardwarePubkeyRaw.toLowerCase();
  }

  // The `mob-` prefix belongs to the mobile registration service (#1288 review
  // P2-1): its ids are a pure function of a public wallet address, so letting
  // this path mint one would let anyone squat another wallet's station id.
  if (isReservedMobileStationId(input.stationId)) {
    return {
      status: 400,
      body: { error: 'STATION_ID_RESERVED', message: "stationId may not start with the reserved prefix 'mob-'" },
    };
  }

  const liveIngestion = isLiveIngestionProvider(provider);
  if (!liveIngestion && mac) return {
    status: 422,
    body: { error: 'MAC_PROVIDER_UNVERIFIED', message: 'This provider cannot verify a device MAC; omit it for pending registration' },
  };

  // --- validate the provider key against the live API (never logged) ---
  // Key validation + encrypted storage is only performed for providers with a
  // wired live-ingestion path (currently only 'ambient'). For pending
  // providers we deliberately do NOT validate or store keys, so we never imply
  // a data flow that does not yet exist (#847).
  const macMismatch = (): RegisterStationResult => ({
    status: 422,
    body: { error: 'AMBIENT_MAC_NOT_ON_ACCOUNT', message: 'The station MAC must belong to the validated Ambient account' },
  });
  let verifiedDevices: AmbientDevice[] | null = null;
  let encryptedKey: EncryptionResult | null = null;
  let encryptedApp: EncryptionResult | null = null;
  if (liveIngestion && ambientApiKey) {
    const verify = await verifyAmbientKey(fetchFn, ambientApiKey, ambientAppKey);
    if (!verify.valid) {
      if (mac && verify.emptyAccount) return macMismatch();
      return { status: 400, body: { error: 'INVALID_AMBIENT_KEY', message: 'Ambient Weather key validation failed' } };
    }
    verifiedDevices = verify.devices;
    encryptedKey = encryptData(ambientApiKey, encryptionKey);
    if (ambientAppKey) {
      encryptedApp = encryptData(ambientAppKey, encryptionKey);
    }
  }

  const ownsMac = (value: string): boolean => Boolean(verifiedDevices?.some(device => canonicalMac(device.mac) === canonicalMac(value)));
  if (liveIngestion && mac && !ownsMac(mac)) return macMismatch();

  // --- station elevation (core4#3285) ---
  // Resolved here, BEFORE the advisory lock below, so the lock is never held
  // across the DEM network call. Failure registers without an elevation.
  const elevation = await resolveStationElevation(
    fetchFn,
    latitude,
    longitude,
    elevationOverride.value,
    sensorHeight.value
  );

  const stationId = (typeof input.stationId === 'string' && input.stationId.trim())
    ? input.stationId.trim()
    : `pws-${slug(name)}-${randomHex(3)}`;

  const resolvedLocation = location || `${latitude},${longitude}`;
  const stationType = hardware || 'personal_weather_station';
  // ingestionStatus is honest about whether data actually flows for this
  // provider yet: 'active' only for wired providers, 'pending' otherwise (#847).
  const ingestionStatus = liveIngestion ? 'active' : 'pending';
  // `elevation_m` is the key the reference shadow scorer already reads
  // (reference-shadow-scorer.ts metadataElevation) and the collector roster
  // contract already names; it is written only when established. All four
  // elevation keys are written together (DEM keys null for an override) so a
  // metadata merge on re-registration never leaves a stale DEM value beside
  // an operator override.
  const elevationMetadata: Record<string, unknown> =
    elevation.elevationM === null
      ? {}
      : {
          elevation_m: elevation.elevationM,
          elevation_source: elevation.source,
          dem_ground_elevation_m: elevation.demGroundElevationM ?? null,
          sensor_height_m: elevation.sensorHeightM ?? null,
        };
  // --- serialize the guarded section (review finding on PR #1000) ---
  // Every check below is read-then-write; under concurrency N callers all read
  // the pre-write state and all pass — measured in review: 25 concurrent
  // registrations from one wallet against a cap of 10 produced 25 stations,
  // 0 refusals. A per-owner advisory lock closes that gap. It is taken FIRST,
  // before any other statement in the section, for consistent lock ordering
  // (the #994 lesson), and AFTER the provider-key network validation above so
  // the lock is never held across a network call.
  //
  // REQUIRES the caller to run this function on a single connection inside a
  // transaction (the route does BEGIN/COMMIT on a checked-out client) —
  // pg_advisory_xact_lock on autocommit pool queries releases at statement end
  // and serializes nothing. Cross-owner races (same hardware root, different
  // owners) are NOT serialized by this per-owner key: the structural guard for
  // that is the partial unique index in
  // drizzle/manual/589-station-admission-hardening.sql, surfaced as a clean
  // 409 by the 23505 handling on the insert below.
  await pool.query(`SELECT pg_advisory_xact_lock(589, hashtext($1))`, [ownerAddress]);

  // --- ownership-conflict guard (#789) ---
  // POST /api/weather/data authorizes submissions by (station_id, owner_address),
  // so silently rewriting owner_address on a station-id conflict would let any
  // authenticated user hijack another contributor's station. Reject the conflict
  // unless the existing owner already matches the requester (idempotent
  // re-register / update) or a valid admin override is in use.
  const existing = await pool.query(
    `SELECT owner_address FROM weather_stations WHERE station_id = $1 LIMIT 1`,
    [stationId]
  );
  const existingOwnerRaw = existing.rows && existing.rows.length > 0
    ? (existing.rows[0].owner_address as string | null | undefined)
    : undefined;
  // Compare in canonical form so a pre-existing mixed-case row still matches
  // its owner (idempotent re-register / key rotation keeps working).
  const existingOwner = typeof existingOwnerRaw === 'string'
    ? normalizeOwnerAddress(existingOwnerRaw)
    : existingOwnerRaw;
  if (
    existingOwner !== undefined &&
    existingOwner !== null &&
    existingOwner !== ownerAddress &&
    !isAdminOverride
  ) {
    return {
      status: 409,
      body: {
        error: 'STATION_ID_TAKEN',
        message: 'A station with this stationId is already registered to a different owner',
      },
    };
  }

  // MAC admission (#1261). The per-owner lock above serializes same-owner
  // edits; this separate namespace serializes the same MAC across owners.
  // Both locks remain held until the route commits/rolls back on its single
  // checked-out connection. No provider/DEM request happens under these locks.
  // One MAC = one active station (owner ruling 2026-09-27, #1267 review P2-1):
  // like HARDWARE_ROOT_TAKEN, any OTHER station_id holding the MAC refuses,
  // including the caller's own; re-binding the same station stays idempotent.
  let effectiveMac = mac;
  let retainedProvider = 'ambient';
  if (liveIngestion && !effectiveMac && existing.rows.length > 0) {
    const stored = await pool.query(`SELECT metadata FROM weather_stations WHERE station_id = $1 LIMIT 1`, [stationId]);
    const metadata = stored.rows[0]?.metadata as Record<string, unknown> | undefined;
    if (typeof metadata?.mac === 'string' && metadata.mac.trim()) effectiveMac = metadata.mac.trim().toLowerCase();
    if (typeof metadata?.provider === 'string') retainedProvider = metadata.provider.trim().toLowerCase();
  }
  // Credentials identify a physical device even when an older caller omits
  // mac. Bind an unambiguous one-device account; never pick the first device
  // from a multi-device account. A retained MAC takes precedence on updates.
  if (liveIngestion && ambientApiKey && !effectiveMac) {
    const accountMacs = [...new Set((verifiedDevices ?? []).map(device => device.mac.trim().toLowerCase()).filter(Boolean))];
    if (accountMacs.length !== 1) return {
      status: 422,
      body: { error: 'AMBIENT_MAC_REQUIRED', message: 'Select a MAC from the Ambient account device list' },
    };
    effectiveMac = accountMacs[0];
  }
  // Omitting mac must not allow a new key to take over the retained device.
  // A metadata-only same-owner update without new credentials retains the
  // prior validation; supplying a key always revalidates the retained MAC.
  if (liveIngestion && effectiveMac && (ambientApiKey || retainedProvider !== 'ambient') && !ownsMac(effectiveMac)) return macMismatch();
  if (effectiveMac) {
    try {
      // #1272: every spelling of one device ('aa:bb:..', 'AA-BB-..', 'aabb..') shares one lock
      // and one uniqueness key, and a legacy row tagged 'Ambient' still reserves its MAC.
      const macKey = canonicalMac(effectiveMac);
      await pool.query(`SELECT pg_advisory_xact_lock(1261, hashtext($1))`, [macKey]);
      const held = await pool.query(
        `SELECT station_id FROM weather_stations
          WHERE regexp_replace(lower(btrim(metadata->>'mac')), '[^0-9a-f]', '', 'g') = $1 AND is_active = true
            AND lower(btrim(COALESCE(metadata->>'provider', 'ambient'))) = 'ambient'
            AND station_id <> $2 LIMIT 1`,
        [macKey, stationId]
      );
      if (held.rows.length > 0) return {
        status: 409,
        body: { error: 'MAC_TAKEN', message: 'This MAC is already bound to another active station (one MAC, one active station)' },
      };
    } catch {
      return { status: 503, body: { error: 'SERVICE_UNAVAILABLE', message: 'MAC ownership could not be verified; registration refused (fail closed)' } };
    }
  }

  // Only keys this request actually establishes. The upsert MERGES this into
  // the existing row's metadata (new keys win), so a re-registration that
  // omits mac / hardware / hardwarePubkey / elevation / pressure_kind keeps
  // the stored values instead of erasing them — in particular the
  // smart-contracts#161 hardware root.
  const metadata = JSON.stringify({
    ...(effectiveMac !== null ? { mac: effectiveMac } : {}),
    ...(hardware !== null ? { hardware } : {}),
    provider,
    ingestionStatus,
    ...(hardwarePubkey ? { hardwarePubkey } : {}),
    ...elevationMetadata,
    ...(pressureKind ? { pressure_kind: pressureKind } : {}),
  });

  // --- hardware-root uniqueness (#161 admission mirror) ---
  // One hardware root, one station identity — enforced here before the chain
  // exists to enforce it. The chain remains the final authority on earning;
  // this mirror just refuses to create the ambiguity in the first place.
  // Fails CLOSED on an unreadable check, same rationale as the cap below.
  if (hardwarePubkey) {
    let rootHolder: string | undefined;
    try {
      const held = await pool.query(
        `SELECT station_id FROM weather_stations
          WHERE metadata->>'hardwarePubkey' = $1 LIMIT 1`,
        [hardwarePubkey]
      );
      rootHolder = held.rows && held.rows.length > 0
        ? String(held.rows[0].station_id)
        : undefined;
    } catch {
      return {
        status: 503,
        body: {
          error: 'SERVICE_UNAVAILABLE',
          message: 'Hardware-root uniqueness could not be verified; registration refused (fail closed)',
        },
      };
    }
    if (rootHolder !== undefined && rootHolder !== stationId) {
      return {
        status: 409,
        body: {
          error: 'HARDWARE_ROOT_TAKEN',
          message: 'This hardware root is already bound to another station (one root, one identity — smart-contracts#161)',
        },
      };
    }
  }

  // --- per-owner registration cap (#589) ---
  // Counted only for genuinely NEW station ids: re-registering/updating a
  // station this owner already holds must keep working at the cap, or a capped
  // owner could never rotate a provider key. Admin override bypasses (it exists
  // to migrate pre-existing contributors). Fails CLOSED: if the count cannot be
  // read, registration is refused — an unreadable cap and an exhausted cap are
  // indistinguishable, and only one answer is safe on a public write surface.
  const isUpdateOfOwnStation = existingOwner !== undefined && existingOwner === ownerAddress;
  if (!isUpdateOfOwnStation && !isAdminOverride) {
    const cap = resolveMaxStationsPerOwner(options.maxStationsPerOwner);
    let ownedCount: number;
    try {
      const owned = await pool.query(
        `SELECT COUNT(*)::int AS n FROM weather_stations WHERE lower(owner_address) = $1`,
        [ownerAddress]
      );
      ownedCount = Number(owned.rows?.[0]?.n);
    } catch {
      ownedCount = NaN;
    }
    if (!Number.isFinite(ownedCount)) {
      return {
        status: 503,
        body: {
          error: 'SERVICE_UNAVAILABLE',
          message: 'Station cap could not be verified; registration refused (fail closed)',
        },
      };
    }
    if (ownedCount >= cap) {
      return {
        status: 429,
        body: {
          error: 'STATION_LIMIT_REACHED',
          message: `This wallet already has ${ownedCount} registered stations (limit ${cap}); contact the operators to raise it`,
        },
      };
    }
  }

  // --- upsert the station row ---
  try {
    await pool.query(
      `INSERT INTO weather_stations
         (station_id, owner_address, location, latitude, longitude, name, station_type, is_active, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb, now())
       ON CONFLICT (station_id) DO UPDATE SET
         owner_address = EXCLUDED.owner_address,
         location = EXCLUDED.location,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         name = EXCLUDED.name,
         station_type = EXCLUDED.station_type,
         is_active = true,
         metadata = ${METADATA_UPSERT_SQL},
         updated_at = now()`,
      [stationId, ownerAddress, resolvedLocation, latitude, longitude, name, stationType, metadata]
    );
  } catch (insertError) {
    // The partial unique index on metadata->>'hardwarePubkey' is the
    // STRUCTURAL root-uniqueness guard — the app-level check above cannot see
    // a concurrent same-root registration by a DIFFERENT owner (different
    // advisory-lock key). The database can. Surface it as the same 409.
    const code = (insertError as { code?: string })?.code;
    if (code === '23505') {
      return {
        status: 409,
        body: {
          error: 'HARDWARE_ROOT_TAKEN',
          message: 'This hardware root is already bound to another station (one root, one identity — smart-contracts#161)',
        },
      };
    }
    throw insertError;
  }

  // --- upsert encrypted provider credentials (if a key was supplied) ---
  if (encryptedKey) {
    await pool.query(
      `INSERT INTO station_provider_credentials
         (station_id, provider, encrypted_api_key, key_iv, key_tag, encrypted_app_key, app_iv, app_tag, rotated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (station_id, provider) DO UPDATE SET
         encrypted_api_key = EXCLUDED.encrypted_api_key,
         key_iv = EXCLUDED.key_iv,
         key_tag = EXCLUDED.key_tag,
         encrypted_app_key = EXCLUDED.encrypted_app_key,
         app_iv = EXCLUDED.app_iv,
         app_tag = EXCLUDED.app_tag,
         rotated_at = now()`,
      [
        stationId,
        provider,
        encryptedKey.encrypted,
        encryptedKey.iv,
        encryptedKey.tag,
        encryptedApp ? encryptedApp.encrypted : null,
        encryptedApp ? encryptedApp.iv : null,
        encryptedApp ? encryptedApp.tag : null,
      ]
    );
  }

  return {
    status: 201,
    body: {
      success: true,
      stationId,
      ownerAddress,
      provider,
      ingestionStatus,
      // core4#3285: the value an operator carries into the governance-signed
      // on-chain StationRegistrationPayload.elevation_meters. null = not
      // established (DEM unavailable): register on-chain without one.
      ...(pressureKind ? { pressureKind } : {}),
      elevation: {
        elevationMeters: elevation.elevationM,
        source: elevation.source,
        ...(elevation.demGroundElevationM === undefined
          ? {}
          : { demGroundElevationM: elevation.demGroundElevationM, sensorHeightM: elevation.sensorHeightM }),
        ...(elevation.unavailableReason ? { unavailableReason: elevation.unavailableReason } : {}),
      },
      ...(liveIngestion
        ? {}
        : {
            message:
              `Station registered for provider '${provider}'. Live data ingestion for this ` +
              'provider is not yet wired up; the station will appear on the contributor map ' +
              "in a 'pending' state until ingestion is enabled.",
          }),
    },
  };
}

/**
 * Metadata on re-registration (core4#3285). The existing metadata is MERGED
 * with the new keys (new keys win), so a request that omits mac / hardware /
 * hardwarePubkey / pressure_kind keeps them.
 *
 * Exception: the elevation is a property of the SITE. When the coordinates
 * change and this request established no elevation (no override and no DEM
 * success, so EXCLUDED.metadata has no `elevation_m`), the four elevation
 * keys are written as JSON null. Keeping the old site's elevation at the new
 * coordinates would be a guess, which the owner ruling forbids. A same-site
 * re-registration during a DEM outage keeps the stored (real) elevation.
 * Coordinates are double precision and compared exactly, in the same
 * statement as the write, so there is no read-then-write gap.
 */
export const METADATA_UPSERT_SQL = `CASE
           WHEN (weather_stations.latitude IS DISTINCT FROM EXCLUDED.latitude
                 OR weather_stations.longitude IS DISTINCT FROM EXCLUDED.longitude)
                AND NOT (EXCLUDED.metadata ? 'elevation_m')
           THEN COALESCE(weather_stations.metadata, '{}'::jsonb)
                || '{"elevation_m": null, "elevation_source": null, "dem_ground_elevation_m": null, "sensor_height_m": null}'::jsonb
                || EXCLUDED.metadata
           ELSE COALESCE(weather_stations.metadata, '{}'::jsonb) || EXCLUDED.metadata
         END`;

/** Default page size for the public station list; also the hard cap ceiling. */
export const STATIONS_DEFAULT_LIMIT = 200;
export const STATIONS_MAX_LIMIT = 500;

/** A station is live only when an actual observation is at most 15 minutes old. */
export const STATION_LIVE_WINDOW_MS = 15 * 60_000;

function observationFreshness(raw: unknown, now: number) {
  const observedAt = raw instanceof Date ? raw.getTime() : typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(observedAt) || observedAt > now) {
    return { status: 'registered', lastDataUpdate: null };
  }
  return {
    status: now - observedAt <= STATION_LIVE_WINDOW_MS ? 'live' : 'stale',
    lastDataUpdate: new Date(observedAt).toISOString(),
  };
}


export interface ListStationsOptions {
  /** Max rows to return. Clamped to [1, STATIONS_MAX_LIMIT]. */
  limit?: number;
  /** Keyset cursor: return stations whose station_id sorts after this value. */
  after?: string | null;
  /**
   * backend#1280: epoch ms of a station's newest chain observation, or null.
   * `fetch: false` must answer from cache only. Nothing on testnet writes
   * `weather_data` (collectors submit to the node), so without this every
   * station reads `registered`. See chain-station-tail.ts.
   */
  chainLastSeen?: (stationId: string, options?: { fetch?: boolean }) => Promise<number | null>;
}

/** Stations per list request allowed to trigger a core4 read; the rest use cached chain knowledge. */
export const STATIONS_CHAIN_FETCH_MAX = 25;
const STATIONS_CHAIN_CONCURRENCY = 4;
/** A slow core4 must not hold the public list: after this, cached knowledge only. */
export const STATIONS_CHAIN_BUDGET_MS = 3_000;

async function chainLastSeenFor(
  stationIds: string[],
  chainLastSeen: NonNullable<ListStationsOptions['chainLastSeen']>
): Promise<Map<string, number>> {
  const seen = new Map<string, number>();
  const cachedOnly = async (id: string) => {
    try {
      const ms = await chainLastSeen(id, { fetch: false });
      if (typeof ms === 'number' && Number.isFinite(ms)) seen.set(id, ms);
    } catch {
      // Degrade to the database answer.
    }
  };
  const fetchable = stationIds.slice(0, STATIONS_CHAIN_FETCH_MAX);
  let next = 0;
  const worker = async () => {
    while (next < fetchable.length) {
      const id = fetchable[next++];
      try {
        const ms = await chainLastSeen(id);
        if (typeof ms === 'number' && Number.isFinite(ms)) seen.set(id, ms);
      } catch {
        // Degrade to the database answer.
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(STATIONS_CHAIN_CONCURRENCY, fetchable.length) }, worker)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STATIONS_CHAIN_BUDGET_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  await Promise.all(stationIds.filter((id) => !seen.has(id)).map(cachedOnly));
  return seen;
}

function laterObservation(dbRaw: unknown, chainMs: number | undefined): unknown {
  if (chainMs === undefined) return dbRaw;
  const dbMs = dbRaw instanceof Date ? dbRaw.getTime() : typeof dbRaw === 'string' ? Date.parse(dbRaw) : NaN;
  return Number.isFinite(dbMs) && dbMs >= chainMs ? dbRaw : new Date(chainMs);
}

export interface ListStationsPage {
  stations: Array<Record<string, unknown>>;
  /** station_id to pass as `after` for the next page, or null when exhausted. */
  nextCursor: string | null;
  hasMore: boolean;
}

function clampLimit(raw: number | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return STATIONS_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(n), STATIONS_MAX_LIMIT);
}

/**
 * List registered contributor stations for the public map (no coords query).
 *
 * #885: this endpoint is public and hit by launch-time map polling. An unbounded
 * SELECT can hold a connection for the full table scan and exhaust the 20-conn
 * pool. Bound every query with a LIMIT and expose keyset (station_id) pagination
 * so the client pages instead of pulling the whole table in one shot.
 */
export async function listRegisteredStations(
  pool: QueryablePool,
  options: ListStationsOptions = {}
): Promise<ListStationsPage> {
  const limit = clampLimit(options.limit);
  const params: unknown[] = [];
  let where = 'WHERE latitude IS NOT NULL';
  if (options.after !== undefined && options.after !== null && options.after !== '') {
    params.push(options.after);
    where += ` AND station_id > $${params.length}`;
  }
  // Fetch one extra row to detect whether another page exists.
  params.push(limit + 1);
  const result = await pool.query(
    `SELECT station_id, name, owner_address, location, latitude, longitude, is_active, quality_score, total_rewards,
            (SELECT MAX(timestamp) FROM weather_data
              WHERE weather_data.station_id = weather_stations.station_id
                AND timestamp <= CURRENT_TIMESTAMP) AS last_data_update
       FROM weather_stations
      ${where}
      ORDER BY station_id ASC
      LIMIT $${params.length}`,
    params
  );
  const rows = result.rows || [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const chainSeen = options.chainLastSeen
    ? await chainLastSeenFor(page.map((row) => String(row.station_id)), options.chainLastSeen)
    : new Map<string, number>();
  const now = Date.now();
  const stations = page.map((row) => ({
    id: row.station_id,
    stationId: row.station_id,
    name: row.name,
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    location: row.location,
    ...observationFreshness(laterObservation(row.last_data_update, chainSeen.get(String(row.station_id))), now),
    isActive: Boolean(row.is_active),
    qualityScore: row.quality_score === null || row.quality_score === undefined ? null : Number(row.quality_score),
    totalRewards: row.total_rewards ?? '0',
    ownerAddress: row.owner_address,
  }));
  const nextCursor = hasMore && page.length > 0 ? String(page[page.length - 1].station_id) : null;
  return { stations, nextCursor, hasMore };
}

function rosterElevation(metadata: unknown): { elevation_m?: number } {
  let meta = metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return {};
    }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const value = (meta as Record<string, unknown>).elevation_m;
  return isFiniteNumber(value) ? { elevation_m: value } : {};
}

/**
 * Decrypted provider credentials for the multi-tenant collector (core4#1732).
 * Keys are decrypted server-side; the collector never holds the encryption key.
 */
export async function listStationCredentials(
  pool: QueryablePool,
  encryptionKey: string
): Promise<Array<Record<string, unknown>>> {
  const result = await pool.query(
    `SELECT c.station_id, c.provider,
            c.encrypted_api_key, c.key_iv, c.key_tag,
            c.encrypted_app_key, c.app_iv, c.app_tag,
            s.owner_address, s.latitude, s.longitude, s.metadata
       FROM station_provider_credentials c
       JOIN weather_stations s ON s.station_id = c.station_id`
  );

  const out: Array<Record<string, unknown>> = [];
  for (const row of result.rows || []) {
    let apiKey: string | null = null;
    let appKey: string | null = null;
    try {
      apiKey = decryptData(
        {
          encrypted: String(row.encrypted_api_key),
          iv: String(row.key_iv),
          tag: String(row.key_tag),
        },
        encryptionKey
      );
    } catch {
      // Skip rows we cannot decrypt (e.g. key rotation mismatch) rather than leak.
      continue;
    }
    if (row.encrypted_app_key && row.app_iv && row.app_tag) {
      try {
        appKey = decryptData(
          {
            encrypted: String(row.encrypted_app_key),
            iv: String(row.app_iv),
            tag: String(row.app_tag),
          },
          encryptionKey
        );
      } catch {
        appKey = null;
      }
    }
    out.push({
      stationId: row.station_id,
      ownerAddress: row.owner_address,
      provider: row.provider,
      apiKey,
      appKey,
      latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
      longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
      // core4#3285: the roster contract's `elevation_m?` — present only when
      // registration established one; absent means "no elevation", never 220.
      ...rosterElevation(row.metadata),
    });
  }
  return out;
}
