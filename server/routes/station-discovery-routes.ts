import { normalizeOwnerAddress } from '../services/owner-address.js';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ParsedUrlQuery } from 'querystring';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import net from 'node:net';

export type QueryExecutor = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface HandleStationDiscoveryRequestInput {
  path: string;
  method?: string;
  query: ParsedUrlQuery;
  req: IncomingMessage;
  res: ServerResponse;
  body?: unknown;
  executeQuery: QueryExecutor;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type StationType = 'ecowitt' | 'ambient' | 'davis';

interface StationConnectionDetails {
  host?: string;
  ip?: string;
  apiKey?: string;
  applicationKey?: string;
  stationUuid?: string;
}

interface StationDiscoveryBody {
  localSubnet?: string;
  ecowittHosts?: string[];
  ambient?: {
    apiKey?: string;
    applicationKey?: string;
  };
  davis?: {
    apiKey?: string;
  };
}

interface StationProvisionBody {
  stationType?: string;
  stationId?: string;
  ownerAddress?: string;
  pollingIntervalSeconds?: number;
  model?: string;
  macAddress?: string;
  firmwareVersion?: string;
  connection?: StationConnectionDetails;
}

interface DiscoveredStation {
  stationId: string;
  stationType: StationType;
  source: 'local-network' | 'ambient-cloud' | 'davis-cloud';
  model: string | null;
  macAddress: string | null;
  firmwareVersion: string | null;
  connection: {
    host?: string;
    stationUuid?: string;
  };
  discoveredAt: string;
}

const DISCOVERY_RATE_LIMIT_WINDOW_MS = 60_000;
const DISCOVERY_RATE_LIMIT_MAX = 1;
const DISCOVERY_RATE_LIMIT_CLEANUP_INTERVAL_MS = 300_000;
const DISCOVERY_RATE_LIMIT_MAX_BUCKETS = 10_000;
const ECOWITT_DISCOVERY_CONCURRENCY = 4;
const DEFAULT_DISCOVERY_POLL_SECONDS = 60;
const STATUS_ONLINE_THRESHOLD_MS = 30 * 60 * 1000;
const STATUS_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const ECOWITT_DISCOVERY_MAX_REDIRECTS = 5;
const ECOWITT_DISCOVERY_SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

const discoveryRateLimiter = new Map<string, { count: number; resetAt: number }>();

const discoveryRateLimiterCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of discoveryRateLimiter) {
    if (now >= bucket.resetAt) {
      discoveryRateLimiter.delete(ip);
    }
  }
}, DISCOVERY_RATE_LIMIT_CLEANUP_INTERVAL_MS);
discoveryRateLimiterCleanupTimer.unref?.();

export function resetStationDiscoveryRateLimiter(): void {
  discoveryRateLimiter.clear();
}

function normalizeString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function normalizeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {}
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function cleanupDiscoveryRateLimiter(now: number): void {
  if (discoveryRateLimiter.size > DISCOVERY_RATE_LIMIT_MAX_BUCKETS) {
    for (const [ip, bucket] of discoveryRateLimiter) {
      if (now >= bucket.resetAt) {
        discoveryRateLimiter.delete(ip);
      }
    }
  }
}

function consumeDiscoveryRateLimit(
  ip: string,
  now: () => number
): { allowed: boolean; retryAfterSeconds: number } {
  const current = now();
  cleanupDiscoveryRateLimiter(current);
  const bucket = discoveryRateLimiter.get(ip);

  if (!bucket || current >= bucket.resetAt) {
    discoveryRateLimiter.set(ip, {
      count: 1,
      resetAt: current + DISCOVERY_RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= DISCOVERY_RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - current) / 1000)),
    };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function getHeaderValue(
  req: IncomingMessage,
  headerName: string
): string | null {
  const value = req.headers[headerName.toLowerCase()];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    const trimmed = value[0].trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = getHeaderValue(req, 'authorization');
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
    return null;
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return token.length ? token : null;
}

function secureTokenMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function getConfiguredOperatorTokens(): string[] {
  return [
    process.env.WRFCOIN_OPERATOR_TOKEN,
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN,
  ]
    .map((value) => (value || '').trim())
    .filter((value) => value.length > 0);
}

function getOperatorCandidateTokens(req: IncomingMessage): string[] {
  const candidates = [
    getHeaderValue(req, 'x-wrfcoin-operator-token'),
    getHeaderValue(req, 'x-operator-token'),
    getHeaderValue(req, 'x-contributor-token'),
    extractBearerToken(req),
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(candidates));
}

function getStationCandidateTokens(req: IncomingMessage): string[] {
  const candidates = [
    getHeaderValue(req, 'x-station-auth-token'),
    extractBearerToken(req),
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(candidates));
}

function hasValidOperatorToken(req: IncomingMessage): boolean {
  const configuredTokens = getConfiguredOperatorTokens();
  if (!configuredTokens.length) {
    return false;
  }

  const provided = getOperatorCandidateTokens(req);
  return provided.some((candidate) =>
    configuredTokens.some((expected) => secureTokenMatch(candidate, expected))
  );
}

/**
 * Operator-ONLY credential check: accepts `WRFCOIN_OPERATOR_TOKEN` and nothing
 * else.
 *
 * `hasValidOperatorToken` above deliberately also accepts
 * `WRFCOIN_CONTRIBUTOR_TOKEN` — correct for provisioning and per-station
 * mutation, where a contributor is entitled to register and manage a device.
 * It is the wrong gate for a *global read* of every station's owner and
 * hardware identity: a contributor credential (presented as a bearer token or
 * on `x-contributor-token`) would otherwise buy fleet-wide ownerAddress /
 * model / MAC / firmware visibility and an `?ownerAddress=` per-address probe
 * — exactly the backend#1113 hazard the status endpoint was hardened against.
 *
 * Mirrors `isOperatorRequest` in server/routes/weather-routes.js, the sibling
 * public station-list read hardened by the same issue. Comparison is
 * constant-time via the file-local `secureTokenMatch`.
 */
function hasValidOperatorOnlyToken(req: IncomingMessage): boolean {
  const operatorToken = (process.env.WRFCOIN_OPERATOR_TOKEN || '').trim();
  if (!operatorToken) {
    return false;
  }

  // `x-contributor-token` is intentionally absent from this list: it is the
  // header a contributor credential travels on, and this decision is
  // operator-only. A contributor token presented on any other channel still
  // fails, because it is never compared against anything but the operator
  // token.
  const candidates = [
    getHeaderValue(req, 'x-wrfcoin-operator-token'),
    getHeaderValue(req, 'x-operator-token'),
    extractBearerToken(req),
  ].filter((value): value is string => Boolean(value));

  return candidates.some((candidate) => secureTokenMatch(candidate, operatorToken));
}

async function hasValidStationToken(
  req: IncomingMessage,
  stationId: string,
  executeQuery: QueryExecutor
): Promise<boolean> {
  const candidates = getStationCandidateTokens(req);
  if (!candidates.length) {
    return false;
  }

  for (const candidate of candidates) {
    const hashed = hashToken(candidate);
    const result = await executeQuery(
      `SELECT 1
       FROM devices_consolidated
       WHERE device_id = $1
         AND COALESCE(network_config->>'authTokenHash', '') = $2
       LIMIT 1`,
      [stationId, hashed]
    );
    if (result.rows.length > 0) {
      return true;
    }
  }

  return false;
}

function sanitizeStationId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

function toStationType(raw: unknown): StationType | null {
  const value = String(raw || '').toLowerCase();
  if (value === 'ecowitt' || value === 'ambient' || value === 'davis') {
    return value;
  }
  return null;
}

function readBody<T>(body: unknown): T {
  if (!body || typeof body !== 'object') {
    return {} as T;
  }
  return body as T;
}

function inferSubnetPrefix(rawSubnet: string): string | null {
  const value = rawSubnet.trim();
  const subnetMatch = value.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})(?:\.\d{1,3})?(?:\/\d{1,2})?$/);
  if (!subnetMatch) {
    return null;
  }
  const parts = subnetMatch[1].split('.').map(Number);
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  return subnetMatch[1];
}

/**
 * Validate that a host string refers to a private LAN address.
 * Accepts only RFC-1918 IPv4 addresses and link-local (169.254.x.x is
 * explicitly REJECTED because it is used for cloud metadata endpoints).
 * Hostnames are not permitted — callers must supply numeric IPs so we can
 * reason about the destination without async DNS resolution.
 */
export function isLanHost(host: string): boolean {
  if (net.isIP(host) !== 4) {
    return false;
  }

  const [a, b] = host.split('.').map((value) => Number(value));
  if (
    Number.isNaN(a) ||
    Number.isNaN(b) ||
    a < 0 ||
    a > 255 ||
    b < 0 ||
    b > 255
  ) {
    return false;
  }
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  return false;
}

export function collectEcowittTargets(body: StationDiscoveryBody): string[] {
  const hasEcowittHostInput = Array.isArray(body.ecowittHosts);
  const explicitHosts = hasEcowittHostInput
    ? body.ecowittHosts
        .map((host) => String(host || '').trim())
        .filter((host) => host.length > 0)
        .filter(isLanHost) // SSRF guard: only LAN addresses permitted
    : [];

  if (explicitHosts.length > 0) {
    return Array.from(new Set(explicitHosts)).slice(0, 16);
  }
  if (hasEcowittHostInput) {
    return [];
  }

  if (body.localSubnet) {
    const prefix = inferSubnetPrefix(body.localSubnet);
    if (prefix) {
      const candidates = [
        `${prefix}.1`, `${prefix}.10`, `${prefix}.20`, `${prefix}.50`, `${prefix}.100`,
      ];
      // Filter generated addresses through the same LAN guard as explicit hosts.
      return candidates.filter(isLanHost);
    }
  }

  const fromEnv = (process.env.STATION_DISCOVERY_ECOWITT_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0 && isLanHost(host));
  if (fromEnv.length > 0) {
    return Array.from(new Set(fromEnv)).slice(0, 16);
  }

  return ['192.168.4.1', '192.168.1.10'];
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  timeoutMs: number,
  options?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
        ...(typeof options?.headers === 'object' && options?.headers !== null
          ? options.headers
          : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export function isAllowedEcowittUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!ECOWITT_DISCOVERY_SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
      return false;
    }
    return isLanHost(parsed.hostname);
  } catch {
    return false;
  }
}

export async function fetchWithRedirects(
  fetchImpl: typeof fetch,
  input: string,
  timeoutMs: number,
  remainingRedirects: number = ECOWITT_DISCOVERY_MAX_REDIRECTS,
  isAllowedUrl: (url: string) => boolean = isAllowedEcowittUrl
): Promise<Response> {
  if (!isAllowedUrl(input)) {
    throw new Error('Unreachable host blocked by allowlist');
  }

  let currentUrl = new URL(input);
  const visited = new Set<string>();
  let redirectsLeft = remainingRedirects;

  while (true) {
    const requestKey = currentUrl.toString();
    if (visited.has(requestKey)) {
      throw new Error('Redirect loop detected');
    }
    visited.add(requestKey);

    const response = await fetchWithTimeout(fetchImpl, requestKey, timeoutMs, {
      redirect: 'manual',
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const nextLocation = response.headers.get('location');
    if (!nextLocation || redirectsLeft <= 0) {
      throw new Error('Unreachable redirect sequence');
    }

    const nextUrl = new URL(nextLocation, currentUrl);
    if (!isAllowedUrl(nextUrl.toString())) {
      throw new Error('Redirect target blocked by allowlist');
    }

    redirectsLeft -= 1;
    currentUrl = nextUrl;
  }
}

function extractEcowittMetadata(payload: Record<string, unknown>): {
  model: string | null;
  macAddress: string | null;
  firmwareVersion: string | null;
} {
  const mac =
    normalizeString(payload.mac) ||
    normalizeString(payload.macAddress) ||
    normalizeString(payload.mac_addr);

  const model =
    normalizeString(payload.model) ||
    normalizeString(payload.stationtype) ||
    normalizeString(payload.stationType) ||
    normalizeString(payload.deviceType);

  const firmware =
    normalizeString(payload.firmware) ||
    normalizeString(payload.firmwareVersion) ||
    normalizeString(payload.version) ||
    normalizeString(payload.fwVersion);

  return {
    model,
    macAddress: mac,
    firmwareVersion: firmware,
  };
}

async function probeEcowittHost(
  host: string,
  fetchImpl: typeof fetch
): Promise<DiscoveredStation | null> {
  const endpoints = ['/get_livedata_info', '/api/v1/device/info', '/'];

  for (const endpoint of endpoints) {
    const url = `http://${host}${endpoint}`;
    try {
      const response = await fetchWithRedirects(fetchImpl, url, 3500);
      if (!response.ok) {
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      let payload: Record<string, unknown> | null = null;

      if (contentType.includes('application/json')) {
        payload = (await response.json()) as Record<string, unknown>;
      } else {
        const text = await response.text();
        const normalized = text.toLowerCase();
        const looksLikeEcowitt =
          normalized.includes('ecowitt') ||
          normalized.includes('gw1000') ||
          normalized.includes('gw1100');
        if (!looksLikeEcowitt && endpoint === '/') {
          continue;
        }
        payload = {
          model: looksLikeEcowitt ? 'Ecowitt Gateway' : null,
          macAddress: null,
          firmwareVersion: null,
        };
      }

      const metadata = extractEcowittMetadata(payload || {});
      const stationId = sanitizeStationId(
        `ecowitt-${metadata.macAddress || host}`
      );

      return {
        stationId: stationId || `ecowitt-${host.replace(/[^0-9a-z]/gi, '')}`,
        stationType: 'ecowitt',
        source: 'local-network',
        model: metadata.model,
        macAddress: metadata.macAddress,
        firmwareVersion: metadata.firmwareVersion,
        connection: { host },
        discoveredAt: new Date().toISOString(),
      };
    } catch {
      // Continue probing additional endpoints/hosts.
    }
  }

  return null;
}

async function discoverEcowittStations(
  body: StationDiscoveryBody,
  fetchImpl: typeof fetch
): Promise<DiscoveredStation[]> {
  const hosts = collectEcowittTargets(body);
  if (!hosts.length) {
    return [];
  }

  const discovered: DiscoveredStation[] = [];
  const seenStationIds = new Set<string>();
  const concurrency = Math.max(
    1,
    Math.min(ECOWITT_DISCOVERY_CONCURRENCY, hosts.length)
  );
  let cursor = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < hosts.length) {
      const host = hosts[cursor];
      cursor += 1;

      const station = await probeEcowittHost(host, fetchImpl);
      if (station && !seenStationIds.has(station.stationId)) {
        seenStationIds.add(station.stationId);
        discovered.push(station);
      }
    }
  });

  await Promise.allSettled(workers);
  return discovered;
}

function redactConnection(
  stationType: StationType,
  connection: StationConnectionDetails | undefined
): { host?: string; stationUuid?: string } {
  if (!connection) {
    return {};
  }

  if (stationType === 'ecowitt') {
    return { host: connection.host || connection.ip };
  }
  if (stationType === 'ambient') {
    return { stationUuid: connection.stationUuid };
  }
  return { stationUuid: connection.stationUuid };
}

async function discoverAmbientStations(
  body: StationDiscoveryBody,
  fetchImpl: typeof fetch
): Promise<DiscoveredStation[]> {
  const apiKey = body.ambient?.apiKey;
  const applicationKey = body.ambient?.applicationKey;
  if (!apiKey || !applicationKey) {
    return [];
  }

  const endpoint =
    `https://rt.ambientweather.net/v1/devices?apiKey=${encodeURIComponent(apiKey)}` +
    `&applicationKey=${encodeURIComponent(applicationKey)}`;

  try {
    const response = await fetchWithTimeout(fetchImpl, endpoint, 5000);
    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    const devices = Array.isArray(payload)
      ? payload
      : payload && Array.isArray((payload as Record<string, unknown>).devices)
      ? ((payload as Record<string, unknown>).devices as Record<string, unknown>[])
      : [];

    return devices.map((device) => {
      const info = (device.info as Record<string, unknown> | undefined) || {};
      const mac =
        normalizeString(device.macAddress) ||
        normalizeString(info.macAddress) ||
        normalizeString(info.mac);

      const stationId = sanitizeStationId(
        `ambient-${mac || normalizeString(info.name) || randomBytes(4).toString('hex')}`
      );

      return {
        stationId,
        stationType: 'ambient',
        source: 'ambient-cloud',
        model: normalizeString(info.model) || normalizeString(device.model),
        macAddress: mac,
        firmwareVersion:
          normalizeString(info.firmwareVersion) ||
          normalizeString(device.firmwareVersion),
        connection: {
          stationUuid:
            normalizeString(device.macAddress) || normalizeString(device.id) || undefined,
        },
        discoveredAt: new Date().toISOString(),
      };
    });
  } catch {
    return [];
  }
}

async function discoverDavisStations(
  body: StationDiscoveryBody,
  fetchImpl: typeof fetch
): Promise<DiscoveredStation[]> {
  const apiKey = body.davis?.apiKey;
  if (!apiKey) {
    return [];
  }

  const endpoint = `https://api.weatherlink.com/v2/stations?api-key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetchWithTimeout(fetchImpl, endpoint, 5000);
    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const stations = Array.isArray(payload.stations)
      ? (payload.stations as Record<string, unknown>[])
      : Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>[])
      : [];

    return stations.map((station) => {
      const stationUuid =
        normalizeString(station.station_id_uuid) ||
        normalizeString(station.station_uuid) ||
        normalizeString(station.stationId);

      const stationId = sanitizeStationId(
        `davis-${stationUuid || normalizeString(station.station_name) || randomBytes(4).toString('hex')}`
      );

      return {
        stationId,
        stationType: 'davis',
        source: 'davis-cloud',
        model:
          normalizeString(station.station_type) ||
          normalizeString(station.model) ||
          'Davis WeatherLink',
        macAddress: normalizeString(station.mac_address),
        firmwareVersion: normalizeString(station.firmware_version),
        connection: {
          stationUuid: stationUuid || undefined,
        },
        discoveredAt: new Date().toISOString(),
      };
    });
  } catch {
    return [];
  }
}

async function handleDiscovery(
  input: HandleStationDiscoveryRequestInput,
  fetchImpl: typeof fetch,
  now: () => number
): Promise<void> {
  const body = readBody<StationDiscoveryBody>(input.body);

  const rateLimit = consumeDiscoveryRateLimit(getClientIp(input.req), now);
  if (!rateLimit.allowed) {
    writeJson(
      input.res,
      429,
      {
        success: false,
        error: 'Rate limit exceeded: max 1 discovery scan per minute per IP',
        timestamp: new Date().toISOString(),
      },
      { 'Retry-After': String(rateLimit.retryAfterSeconds) }
    );
    return;
  }

  const [ecowittStations, ambientStations, davisStations] = await Promise.all([
    discoverEcowittStations(body, fetchImpl),
    discoverAmbientStations(body, fetchImpl),
    discoverDavisStations(body, fetchImpl),
  ]);

  const discoveredStations = [...ecowittStations, ...ambientStations, ...davisStations];

  writeJson(input.res, 200, {
    success: true,
    data: {
      discoveredStations,
      total: discoveredStations.length,
      totalsByType: {
        ecowitt: ecowittStations.length,
        ambient: ambientStations.length,
        davis: davisStations.length,
      },
      scannedAt: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  });
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function isProvisioningAuthorized(req: IncomingMessage): boolean {
  // Fail-closed: require at least one WRFCOIN_OPERATOR_TOKEN or
  // WRFCOIN_CONTRIBUTOR_TOKEN to be configured.  Returning true when no
  // tokens are set was a fail-open condition that allowed unauthenticated
  // provisioning on any deployment that hadn't set these env vars yet.
  return hasValidOperatorToken(req);
}

async function isStationMutationAuthorized(
  req: IncomingMessage,
  stationId: string,
  executeQuery: QueryExecutor
): Promise<boolean> {
  if (hasValidOperatorToken(req)) {
    return true;
  }
  return hasValidStationToken(req, stationId, executeQuery);
}

function validateProvisionPayload(payload: StationProvisionBody): {
  stationType: StationType;
  ownerAddress: string;
  connection: StationConnectionDetails;
  stationId: string;
  pollingIntervalSeconds: number;
  model: string | null;
  macAddress: string | null;
  firmwareVersion: string | null;
} | { error: string } {
  const stationType = toStationType(payload.stationType);
  if (!stationType) {
    return { error: 'stationType must be one of: ecowitt, ambient, davis' };
  }

  // backend#1210: accept either case, store the canonical lowercase owner.
  const ownerAddress = String(payload.ownerAddress || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    return { error: 'ownerAddress must be a valid 0x-prefixed wallet address' };
  }

  const connection =
    payload.connection && typeof payload.connection === 'object'
      ? payload.connection
      : {};

  if (stationType === 'ecowitt' && !connection.host && !connection.ip) {
    return { error: 'ecowitt provisioning requires connection.host or connection.ip' };
  }

  if (stationType === 'ambient') {
    if (!connection.apiKey || !connection.applicationKey) {
      return {
        error: 'ambient provisioning requires connection.apiKey and connection.applicationKey',
      };
    }
  }

  if (stationType === 'davis' && !connection.apiKey) {
    return { error: 'davis provisioning requires connection.apiKey' };
  }

  const pollingIntervalSeconds = Number.isFinite(payload.pollingIntervalSeconds)
    ? Math.max(15, Math.min(3600, Number(payload.pollingIntervalSeconds)))
    : DEFAULT_DISCOVERY_POLL_SECONDS;

  const candidateId =
    payload.stationId ||
    `${stationType}-${connection.host || connection.ip || connection.stationUuid || randomBytes(4).toString('hex')}`;
  const stationId = sanitizeStationId(candidateId);
  if (!stationId) {
    return { error: 'stationId could not be derived from payload' };
  }

  return {
    stationType,
    ownerAddress: normalizeOwnerAddress(ownerAddress),
    connection,
    stationId,
    pollingIntervalSeconds,
    model: normalizeString(payload.model),
    macAddress: normalizeString(payload.macAddress),
    firmwareVersion: normalizeString(payload.firmwareVersion),
  };
}

async function handleProvision(input: HandleStationDiscoveryRequestInput): Promise<void> {
  const body = readBody<StationProvisionBody>(input.body);

  // Fail-closed (#823): distinguish mis-configured service (no token in env) from
  // mis-authenticated client (token configured but not provided / wrong).
  const configuredTokens = getConfiguredOperatorTokens();
  if (!configuredTokens.length) {
    writeJson(input.res, 503, {
      success: false,
      error: 'Service unavailable: operator token not configured on this node',
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (!isProvisioningAuthorized(input.req)) {
    writeJson(input.res, 401, {
      success: false,
      error:
        'Unauthorized: provide a valid operator token via Authorization Bearer or x-wrfcoin-operator-token',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const validated = validateProvisionPayload(body);
  if ('error' in validated) {
    writeJson(input.res, 400, {
      success: false,
      error: validated.error,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const token = randomBytes(24).toString('hex');
  const tokenHash = hashToken(token);

  const networkConfig = {
    connection: validated.connection,
    pollingIntervalSeconds: validated.pollingIntervalSeconds,
    authTokenHash: tokenHash,
    provisionedBy: 'station-discovery-api',
    provisionedAt: new Date().toISOString(),
  };

  const deviceMetadata = {
    manufacturer: validated.stationType,
    model: validated.model,
    macAddress: validated.macAddress,
    firmwareVersion: validated.firmwareVersion,
    source: 'station-auto-discovery',
  };

  const result = await input.executeQuery(
    `INSERT INTO devices_consolidated (
       device_id,
       device_type,
       owner_address,
       network_config,
       device_metadata,
       decommissioned_at,
       is_active,
       last_seen,
       updated_at
     )
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NULL, TRUE, NOW(), NOW())
     ON CONFLICT (device_id)
     DO UPDATE SET
       device_type = EXCLUDED.device_type,
       owner_address = EXCLUDED.owner_address,
       network_config = EXCLUDED.network_config,
       device_metadata = EXCLUDED.device_metadata,
       decommissioned_at = NULL,
       is_active = TRUE,
       updated_at = NOW()
     RETURNING device_id, device_type, owner_address, created_at, updated_at`,
    [
      validated.stationId,
      validated.stationType,
      validated.ownerAddress,
      JSON.stringify(networkConfig),
      JSON.stringify(deviceMetadata),
    ]
  );

  const row = result.rows[0] || {};

  writeJson(input.res, 200, {
    success: true,
    data: {
      stationId: normalizeString(row.device_id) || validated.stationId,
      stationType: normalizeString(row.device_type) || validated.stationType,
      ownerAddress: normalizeString(row.owner_address) || validated.ownerAddress,
      pollingIntervalSeconds: validated.pollingIntervalSeconds,
      authToken: token,
      tokenType: 'Bearer',
      tokenIssuedAt: new Date().toISOString(),
      connection: redactConnection(validated.stationType, validated.connection),
      status: 'provisioned',
    },
    timestamp: new Date().toISOString(),
  });
}

function deriveConnectionStatus(lastReadingAt: string | null): 'online' | 'stale' | 'offline' | 'never_seen' {
  if (!lastReadingAt) {
    return 'never_seen';
  }

  const parsed = new Date(lastReadingAt);
  if (Number.isNaN(parsed.getTime())) {
    return 'offline';
  }

  const ageMs = Date.now() - parsed.getTime();
  if (ageMs <= STATUS_ONLINE_THRESHOLD_MS) {
    return 'online';
  }
  if (ageMs <= STATUS_STALE_THRESHOLD_MS) {
    return 'stale';
  }
  return 'offline';
}

function parseStationIdFromPath(rawStationId: string): string | null {
  const decoded = decodeURIComponent(rawStationId || '').trim();
  const stationId = sanitizeStationId(decoded);
  return stationId || null;
}

async function handleVerify(
  input: HandleStationDiscoveryRequestInput,
  stationId: string
): Promise<void> {
  const authorized = await isStationMutationAuthorized(
    input.req,
    stationId,
    input.executeQuery
  );
  if (!authorized) {
    writeJson(input.res, 401, {
      success: false,
      error:
        'Unauthorized: provide operator token or station auth token to verify this station',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const stationLookup = await input.executeQuery(
    `SELECT device_id, device_type, is_active
     FROM devices_consolidated
     WHERE device_id = $1
       AND device_type IN ('ecowitt', 'ambient', 'davis')
     LIMIT 1`,
    [stationId]
  );

  if (!stationLookup.rows.length) {
    writeJson(input.res, 404, {
      success: false,
      error: 'Station not found',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const readings = await input.executeQuery(
    `SELECT
       COUNT(*)::int AS total_readings,
       COUNT(*) FILTER (
         WHERE (
           temperature IS NOT NULL OR
           humidity IS NOT NULL OR
           pressure IS NOT NULL OR
           wind_speed IS NOT NULL OR
           rainfall IS NOT NULL
         )
       )::int AS valid_readings,
       MIN(submitted_at) AS first_reading_at,
       MAX(submitted_at) AS last_reading_at
     FROM weather_submissions
     WHERE COALESCE(station_id, device_id) = $1`,
    [stationId]
  );

  const summary = readings.rows[0] || {};
  const totalReadings = Number(summary.total_readings || 0);
  const validReadings = Number(summary.valid_readings || 0);
  const firstReadingAt = normalizeDate(summary.first_reading_at);
  const lastReadingAt = normalizeDate(summary.last_reading_at);

  const verificationStatus: 'verified' | 'pending' | 'failed' =
    validReadings > 0 ? 'verified' : totalReadings > 0 ? 'failed' : 'pending';

  const updateResult = await input.executeQuery(
    `UPDATE devices_consolidated
     SET
       is_active = CASE WHEN $2::text = 'verified' THEN TRUE ELSE is_active END,
       decommissioned_at = CASE WHEN $2::text = 'verified' THEN NULL ELSE decommissioned_at END,
       device_metadata = COALESCE(device_metadata, '{}'::jsonb) || jsonb_build_object(
         'verificationStatus', $2::text,
         'verificationCheckedAt', NOW(),
         'firstReadingAt', $3::timestamptz,
         'lastReadingAt', $4::timestamptz,
         'validReadingCount', $5::int,
         'totalReadingCount', $6::int
       ),
       updated_at = NOW()
     WHERE device_id = $1
     RETURNING device_id, device_type, is_active, updated_at`,
    [
      stationId,
      verificationStatus,
      firstReadingAt,
      lastReadingAt,
      validReadings,
      totalReadings,
    ]
  );

  const updated = updateResult.rows[0] || {};

  writeJson(input.res, 200, {
    success: true,
    data: {
      stationId: normalizeString(updated.device_id) || stationId,
      stationType: normalizeString(updated.device_type),
      verificationStatus,
      verificationTimestamp: normalizeDate(updated.updated_at) || new Date().toISOString(),
      totalReadings,
      validReadings,
      firstReadingAt,
      lastReadingAt,
      isActive: Boolean(updated.is_active),
    },
    timestamp: new Date().toISOString(),
  });
}

async function handleDecommission(
  input: HandleStationDiscoveryRequestInput,
  stationId: string
): Promise<void> {
  const operatorAuthorized = hasValidOperatorToken(input.req);
  const stationAuthorized = operatorAuthorized
    ? false
    : await hasValidStationToken(input.req, stationId, input.executeQuery);

  if (!operatorAuthorized && !stationAuthorized) {
    writeJson(input.res, 401, {
      success: false,
      error:
        'Unauthorized: provide operator token or station auth token to decommission this station',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const payload = readBody<{ reason?: unknown }>(input.body);
  const reason = normalizeString(payload.reason) || 'manual_decommission';
  const actor = operatorAuthorized ? 'operator_token' : 'station_token';

  const result = await input.executeQuery(
    `WITH updated AS (
       UPDATE devices_consolidated d
       SET
         is_active = FALSE,
         decommissioned_at = NOW(),
         network_config = COALESCE(d.network_config, '{}'::jsonb) || jsonb_build_object(
           'decommissionedAt', NOW(),
           'decommissionedBy', $3::text,
           'decommissionReason', $2::text
         ),
         updated_at = NOW()
       WHERE d.device_id = $1
         AND d.device_type IN ('ecowitt', 'ambient', 'davis')
       RETURNING
         d.device_id,
         d.device_type,
         d.owner_address,
         d.is_active,
         d.decommissioned_at
     )
     SELECT
       updated.device_id,
       updated.device_type,
       updated.owner_address,
       updated.is_active,
       updated.decommissioned_at,
       MAX(ws.submitted_at) AS last_reading_at,
       COUNT(*)::int AS total_readings,
       AVG(ws.quality_score) FILTER (
         WHERE ws.submitted_at >= NOW() - INTERVAL '24 hours'
       ) AS avg_quality_score_24h
     FROM updated
     LEFT JOIN weather_submissions ws
       ON COALESCE(ws.station_id, ws.device_id) = updated.device_id
     GROUP BY
       updated.device_id,
       updated.device_type,
       updated.owner_address,
       updated.is_active,
       updated.decommissioned_at`,
    [stationId, reason, actor]
  );

  if (!result.rows.length) {
    writeJson(input.res, 404, {
      success: false,
      error: 'Station not found',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const row = result.rows[0];
  writeJson(input.res, 200, {
    success: true,
    data: {
      stationId: normalizeString(row.device_id),
      stationType: normalizeString(row.device_type),
      ownerAddress: normalizeString(row.owner_address),
      status: 'decommissioned',
      isActive: Boolean(row.is_active),
      decommissionedAt: normalizeDate(row.decommissioned_at),
      decommissionedBy: actor,
      reason,
      finalStatus: {
        totalReadings: normalizeNumber(row.total_readings),
        lastReadingAt: normalizeDate(row.last_reading_at),
        averageQualityScore24h: normalizeNumber(row.avg_quality_score_24h),
      },
    },
    timestamp: new Date().toISOString(),
  });
}

async function handleStatus(input: HandleStationDiscoveryRequestInput): Promise<void> {
  // backend#1113: this list is otherwise fully unauthenticated. Only an
  // operator-token caller gets per-device owner/hardware identity; an
  // anonymous caller gets connection/quality telemetry only. The
  // ?ownerAddress= filter is an operator lookup tool (find one owner's
  // devices) — it must not double as a public per-address probe, so it is
  // ignored entirely for anonymous callers rather than merely masked in the
  // response (an anonymous caller could otherwise still learn whether an
  // address owns any station from the result being empty or not).
  // Operator-ONLY (backend#1115 review): `hasValidOperatorToken` also accepts
  // WRFCOIN_CONTRIBUTOR_TOKEN, which would hand a contributor credential
  // global owner/hardware visibility and the per-address filter. This read is
  // gated on WRFCOIN_OPERATOR_TOKEN alone; the provisioning/mutation helper's
  // semantics elsewhere in this file are unchanged.
  const isOperator = hasValidOperatorOnlyToken(input.req);
  const ownerAddressRaw = input.query.ownerAddress;
  const ownerAddress = isOperator && typeof ownerAddressRaw === 'string' ? ownerAddressRaw : null;

  const result = await input.executeQuery(
    `SELECT
       d.device_id,
       d.device_type,
       d.owner_address,
       d.device_metadata,
       d.network_config,
       MAX(ws.submitted_at) AS last_reading_at,
       AVG(ws.quality_score) FILTER (
         WHERE ws.submitted_at >= NOW() - INTERVAL '24 hours'
       ) AS avg_quality_score,
       COUNT(*) FILTER (
         WHERE ws.submitted_at >= NOW() - INTERVAL '24 hours'
       ) AS readings_24h
     FROM devices_consolidated d
     LEFT JOIN weather_submissions ws
       ON COALESCE(ws.station_id, ws.device_id) = d.device_id
     WHERE d.device_type IN ('ecowitt', 'ambient', 'davis')
       AND ($1::text IS NULL OR lower(d.owner_address) = lower($1))
     GROUP BY d.device_id, d.device_type, d.owner_address, d.device_metadata, d.network_config
     ORDER BY d.updated_at DESC
     LIMIT 500`,
    [ownerAddress]
  );

  const stations = result.rows.map((row) => {
    const lastReadingAt = normalizeDate(row.last_reading_at);
    const connectionStatus = deriveConnectionStatus(lastReadingAt);
    const avgQuality = normalizeNumber(row.avg_quality_score);
    const metadata =
      row.device_metadata && typeof row.device_metadata === 'object'
        ? (row.device_metadata as Record<string, unknown>)
        : {};

    return {
      stationId: normalizeString(row.device_id),
      stationType: normalizeString(row.device_type),
      ...(isOperator
        ? {
            ownerAddress: normalizeString(row.owner_address),
            model: normalizeString(metadata.model),
            macAddress: normalizeString(metadata.macAddress),
            firmwareVersion: normalizeString(metadata.firmwareVersion),
          }
        : {}),
      lastReadingAt,
      connectionStatus,
      dataFlowing: connectionStatus === 'online' || connectionStatus === 'stale',
      dataQualityScore24h: avgQuality,
      readings24h: normalizeNumber(row.readings_24h),
    };
  });

  const summary = {
    total: stations.length,
    online: stations.filter((station) => station.connectionStatus === 'online').length,
    stale: stations.filter((station) => station.connectionStatus === 'stale').length,
    offline: stations.filter((station) => station.connectionStatus === 'offline').length,
    neverSeen: stations.filter((station) => station.connectionStatus === 'never_seen').length,
  };

  writeJson(input.res, 200, {
    success: true,
    data: {
      stations,
      summary,
      asOf: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  });
}

export async function handleStationDiscoveryRequest(
  input: HandleStationDiscoveryRequestInput
): Promise<boolean> {
  const method = (input.method || '').toUpperCase();
  const verifyMatch = input.path.match(/^\/api\/v1\/stations\/([^/]+)\/verify$/);
  const deleteMatch = input.path.match(/^\/api\/v1\/stations\/([^/]+)$/);

  if (method === 'POST' && input.path === '/api/v1/stations/discover') {
    const fetchImpl = input.fetchImpl || fetch;
    const now = input.now || Date.now;
    await handleDiscovery(input, fetchImpl, now);
    return true;
  }

  if (method === 'POST' && input.path === '/api/v1/stations/provision') {
    await handleProvision(input);
    return true;
  }

  if (method === 'GET' && input.path === '/api/v1/stations/status') {
    await handleStatus(input);
    return true;
  }

  if (method === 'POST' && verifyMatch) {
    const stationId = parseStationIdFromPath(verifyMatch[1]);
    if (!stationId) {
      writeJson(input.res, 400, {
        success: false,
        error: 'Invalid station id',
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    await handleVerify(input, stationId);
    return true;
  }

  if (
    method === 'DELETE' &&
    deleteMatch &&
    input.path !== '/api/v1/stations/discover' &&
    input.path !== '/api/v1/stations/provision' &&
    input.path !== '/api/v1/stations/status'
  ) {
    const stationId = parseStationIdFromPath(deleteMatch[1]);
    if (!stationId) {
      writeJson(input.res, 400, {
        success: false,
        error: 'Invalid station id',
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    await handleDecommission(input, stationId);
    return true;
  }

  return false;
}
