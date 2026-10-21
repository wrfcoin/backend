const NOAAWeatherService = require('../noaa-nws-api-service');

export type SevereAlertType =
  | 'tornado'
  | 'wildfire_red_flag'
  | 'flood'
  | 'hurricane'
  | 'winter_storm'
  | 'other';

export type SevereAlertSeverityClass =
  | 'warning'
  | 'watch'
  | 'advisory'
  | 'statement'
  | 'unknown';

export type SevereWeatherAlertLifecycle = 'new' | 'updated' | 'expired';

export interface AlertPollLocation {
  id?: string;
  latitude: number;
  longitude: number;
}

interface NwsAlertPayload {
  alerts?: any[];
  count?: number;
  generated?: string;
}

interface NwsAlertClient {
  getAlerts(latitude: number, longitude: number): Promise<NwsAlertPayload>;
}

export interface ClassifiedSevereWeatherAlert {
  id: string;
  event: string;
  type: SevereAlertType;
  severityClass: SevereAlertSeverityClass;
  sourceSeverity: string | null;
  areaDesc: string;
  affectedZones: string[];
  geocode: Record<string, string[]>;
  sent: string | null;
  effective: string | null;
  onset: string | null;
  expires: string | null;
  ends: string | null;
  status: string | null;
  messageType: string | null;
  category: string | null;
  certainty: string | null;
  urgency: string | null;
  sender: string | null;
  senderName: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  response: string | null;
  parameters: Record<string, unknown>;
  references: unknown[];
  sourceLocations: string[];
}

export interface ActiveSevereWeatherAlert extends ClassifiedSevereWeatherAlert {
  firstSeenAt: string;
  lastSeenAt: string;
  lastUpdatedAt: string;
}

export interface SevereWeatherAlertHistoryEntry {
  id: string;
  lifecycle: SevereWeatherAlertLifecycle;
  recordedAt: string;
  alert: ActiveSevereWeatherAlert;
}

export interface SevereWeatherAlertEvent {
  type: SevereWeatherAlertLifecycle;
  timestamp: string;
  alert: ActiveSevereWeatherAlert;
}

export interface SevereWeatherPollSummary {
  polledAt: string;
  polledLocations: AlertPollLocation[];
  fetchedAlerts: number;
  dedupedAlerts: number;
  newAlerts: number;
  updatedAlerts: number;
  expiredAlerts: number;
  activeCount: number;
  historyCount: number;
}

type AlertEventPublisher = (event: SevereWeatherAlertEvent) => void | Promise<void>;

interface SevereWeatherResponseServiceOptions {
  nwsApiService?: NwsAlertClient;
  locations?: AlertPollLocation[];
  pollIntervalMs?: number;
  publisher?: AlertEventPublisher;
  historyLimit?: number;
  nowFn?: () => Date;
}

const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_HISTORY_LIMIT = 2000;
const DEFAULT_LOCATIONS: AlertPollLocation[] = [
  { id: 'us-default', latitude: 39.8283, longitude: -98.5795 },
];

const WARNING_PATTERN = /\bwarning\b/i;
const WATCH_PATTERN = /\bwatch\b/i;
const ADVISORY_PATTERN = /\badvisory\b/i;
const STATEMENT_PATTERN = /\bstatement\b/i;

export class SevereWeatherResponseError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'SevereWeatherResponseError';
    this.statusCode = statusCode;
  }
}

export class SevereWeatherResponseValidationError extends SevereWeatherResponseError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'SevereWeatherResponseValidationError';
  }
}

export class SevereWeatherResponseUpstreamError extends SevereWeatherResponseError {
  constructor(message: string) {
    super(message, 502);
    this.name = 'SevereWeatherResponseUpstreamError';
  }
}

export function mapSevereWeatherResponseErrorStatus(error: unknown): number {
  if (error instanceof SevereWeatherResponseError) {
    return error.statusCode;
  }
  return 500;
}

export class SevereWeatherResponseService {
  private readonly nwsApiService: NwsAlertClient;
  private locations: AlertPollLocation[];
  private readonly pollIntervalMs: number;
  private readonly historyLimit: number;
  private readonly nowFn: () => Date;
  private readonly publisher?: AlertEventPublisher;

  private readonly activeAlerts = new Map<string, ActiveSevereWeatherAlert>();
  private readonly activeSignatures = new Map<string, string>();
  private readonly history: SevereWeatherAlertHistoryEntry[] = [];
  private readonly callbacks = new Set<AlertEventPublisher>();
  private persistenceHandle: Promise<{ db: any; schema: any } | null> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private inFlightPoll: Promise<SevereWeatherPollSummary> | null = null;
  private lastPollAt: string | null = null;

  constructor(options: SevereWeatherResponseServiceOptions = {}) {
    this.nwsApiService = options.nwsApiService || new NOAAWeatherService();
    this.locations = validateLocations(options.locations || DEFAULT_LOCATIONS);
    this.pollIntervalMs =
      Number.isFinite(options.pollIntervalMs) && (options.pollIntervalMs || 0) > 0
        ? Number(options.pollIntervalMs)
        : DEFAULT_POLL_INTERVAL_MS;
    this.historyLimit =
      Number.isFinite(options.historyLimit) && (options.historyLimit || 0) > 0
        ? Math.floor(Number(options.historyLimit))
        : DEFAULT_HISTORY_LIMIT;
    this.publisher = options.publisher;
    this.nowFn = options.nowFn || (() => new Date());
  }

  startPolling(): void {
    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.pollNow().catch(() => undefined);
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    if (!this.pollTimer) {
      return;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  isPolling(): boolean {
    return this.pollTimer !== null;
  }

  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  getLastPollAt(): string | null {
    return this.lastPollAt;
  }

  setLocations(locations: AlertPollLocation[]): void {
    this.locations = validateLocations(locations);
  }

  onEvent(callback: AlertEventPublisher): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  getActiveAlerts(): ActiveSevereWeatherAlert[] {
    return Array.from(this.activeAlerts.values()).sort(compareActiveAlerts);
  }

  getAlertHistory(limit = 200): SevereWeatherAlertHistoryEntry[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 200;
    return this.history.slice(-safeLimit).reverse();
  }

  async pollNow(locationsOverride?: AlertPollLocation[]): Promise<SevereWeatherPollSummary> {
    if (this.inFlightPoll) {
      return this.inFlightPoll;
    }

    const run = this.performPoll(locationsOverride).finally(() => {
      this.inFlightPoll = null;
    });
    this.inFlightPoll = run;
    return run;
  }

  private async performPoll(
    locationsOverride?: AlertPollLocation[]
  ): Promise<SevereWeatherPollSummary> {
    const now = this.nowFn();
    const nowIso = now.toISOString();
    const locations = validateLocations(locationsOverride || this.locations);
    const dedupedIncoming = new Map<string, ClassifiedSevereWeatherAlert>();

    let fetchedAlerts = 0;
    for (const location of locations) {
      let payload: NwsAlertPayload;
      try {
        payload = await this.nwsApiService.getAlerts(location.latitude, location.longitude);
      } catch {
        throw new SevereWeatherResponseUpstreamError('Failed to fetch NOAA NWS alerts');
      }

      const incomingAlerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
      fetchedAlerts += incomingAlerts.length;

      for (const rawAlert of incomingAlerts) {
        const normalized = normalizeNwsAlert(rawAlert, location);
        if (!normalized) {
          continue;
        }
        const existing = dedupedIncoming.get(normalized.id);
        if (existing) {
          dedupedIncoming.set(normalized.id, mergeAlerts(existing, normalized));
        } else {
          dedupedIncoming.set(normalized.id, normalized);
        }
      }
    }

    const events: SevereWeatherAlertEvent[] = [];
    let newAlerts = 0;
    let updatedAlerts = 0;
    const seenIds = new Set<string>();

    for (const alert of dedupedIncoming.values()) {
      seenIds.add(alert.id);
      if (hasExpired(alert.expires, now)) {
        continue;
      }

      const nextSignature = computeAlertSignature(alert);
      const existing = this.activeAlerts.get(alert.id);
      if (!existing) {
        const activated: ActiveSevereWeatherAlert = {
          ...alert,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          lastUpdatedAt: nowIso,
        };
        this.activeAlerts.set(alert.id, activated);
        this.activeSignatures.set(alert.id, nextSignature);
        newAlerts += 1;
        events.push({
          type: 'new',
          timestamp: nowIso,
          alert: activated,
        });
        continue;
      }

      const changed = this.activeSignatures.get(alert.id) !== nextSignature;
      const updated: ActiveSevereWeatherAlert = {
        ...existing,
        ...alert,
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: nowIso,
        lastUpdatedAt: changed ? nowIso : existing.lastUpdatedAt,
      };
      this.activeAlerts.set(alert.id, updated);
      this.activeSignatures.set(alert.id, nextSignature);

      if (changed) {
        updatedAlerts += 1;
        events.push({
          type: 'updated',
          timestamp: nowIso,
          alert: updated,
        });
      }
    }

    let expiredAlerts = 0;
    for (const [id, alert] of Array.from(this.activeAlerts.entries())) {
      if (seenIds.has(id) && !hasExpired(alert.expires, now)) {
        continue;
      }
      const expired: ActiveSevereWeatherAlert = {
        ...alert,
        lastSeenAt: nowIso,
        lastUpdatedAt: nowIso,
      };
      this.activeAlerts.delete(id);
      this.activeSignatures.delete(id);
      expiredAlerts += 1;
      events.push({
        type: 'expired',
        timestamp: nowIso,
        alert: expired,
      });
    }

    for (const event of events) {
      await this.recordHistory(event);
      await this.emit(event);
    }

    this.lastPollAt = nowIso;
    return {
      polledAt: nowIso,
      polledLocations: locations,
      fetchedAlerts,
      dedupedAlerts: dedupedIncoming.size,
      newAlerts,
      updatedAlerts,
      expiredAlerts,
      activeCount: this.activeAlerts.size,
      historyCount: this.history.length,
    };
  }

  private async recordHistory(event: SevereWeatherAlertEvent): Promise<void> {
    const entry: SevereWeatherAlertHistoryEntry = {
      id: event.alert.id,
      lifecycle: event.type,
      recordedAt: event.timestamp,
      alert: {
        ...event.alert,
        affectedZones: [...event.alert.affectedZones],
        geocode: cloneGeocode(event.alert.geocode),
        references: [...event.alert.references],
        sourceLocations: [...event.alert.sourceLocations],
      },
    };

    this.history.push(entry);

    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }

    await this.persistHistoryEntry(entry);
  }

  private async emit(event: SevereWeatherAlertEvent): Promise<void> {
    if (this.publisher) {
      await Promise.resolve(this.publisher(event));
    }
    for (const callback of this.callbacks) {
      await Promise.resolve(callback(event));
    }
  }

  private async getPersistenceHandle(): Promise<{ db: any; schema: any } | null> {
    if (this.persistenceHandle) {
      return this.persistenceHandle;
    }

    this.persistenceHandle = (async () => {
      if (!process.env.DATABASE_URL) {
        return null;
      }

      try {
        const dbModule = await import('../../db.js');
        const schema = await import('../../../shared/schema.js');
        return { db: dbModule.db, schema };
      } catch {
        return null;
      }
    })();

    return this.persistenceHandle;
  }

  private async persistHistoryEntry(entry: SevereWeatherAlertHistoryEntry): Promise<void> {
    const handle = await this.getPersistenceHandle();
    if (!handle) {
      return;
    }

    try {
      const payload = {
        alertId: entry.id,
        alertType: entry.alert.type,
        severity: entry.alert.severityClass,
        status: entry.lifecycle,
        areaDesc: entry.alert.areaDesc,
        zoneIds: entry.alert.affectedZones,
        payload: entry.alert,
        issuedAt: entry.alert.sent ? new Date(entry.alert.sent) : null,
        effectiveAt: entry.alert.effective ? new Date(entry.alert.effective) : null,
        expiresAt: entry.alert.expires ? new Date(entry.alert.expires) : null,
        updatedAt: new Date(entry.recordedAt),
      };

      await handle.db
        .insert(handle.schema.weatherAlertHistory)
        .values(payload)
        .onConflictDoUpdate({
          target: handle.schema.weatherAlertHistory.alertId,
          set: payload,
        });
    } catch {
      // History remains in-memory even if persistence fails.
    }
  }
}

export function classifyAlertType(input: {
  event?: string | null;
  headline?: string | null;
  description?: string | null;
}): SevereAlertType {
  const haystack = `${input.event || ''} ${input.headline || ''} ${input.description || ''}`
    .toLowerCase()
    .trim();

  if (haystack.includes('tornado')) {
    return 'tornado';
  }

  if (
    haystack.includes('red flag') ||
    haystack.includes('wildfire') ||
    haystack.includes('fire weather')
  ) {
    return 'wildfire_red_flag';
  }

  if (haystack.includes('flood')) {
    return 'flood';
  }

  if (
    haystack.includes('hurricane') ||
    haystack.includes('tropical storm') ||
    haystack.includes('typhoon')
  ) {
    return 'hurricane';
  }

  if (
    haystack.includes('winter storm') ||
    haystack.includes('blizzard') ||
    haystack.includes('ice storm') ||
    haystack.includes('snow squall') ||
    haystack.includes('wind chill')
  ) {
    return 'winter_storm';
  }

  return 'other';
}

export function classifyAlertSeverity(input: {
  event?: string | null;
  headline?: string | null;
  severity?: string | null;
}): SevereAlertSeverityClass {
  const haystack = `${input.event || ''} ${input.headline || ''}`;
  if (WARNING_PATTERN.test(haystack)) {
    return 'warning';
  }
  if (WATCH_PATTERN.test(haystack)) {
    return 'watch';
  }
  if (ADVISORY_PATTERN.test(haystack)) {
    return 'advisory';
  }
  if (STATEMENT_PATTERN.test(haystack)) {
    return 'statement';
  }

  const normalizedSeverity = String(input.severity || '')
    .toLowerCase()
    .trim();
  if (normalizedSeverity === 'extreme' || normalizedSeverity === 'severe') {
    return 'warning';
  }
  if (normalizedSeverity === 'moderate') {
    return 'watch';
  }
  return 'unknown';
}

function normalizeNwsAlert(
  rawAlert: any,
  location: AlertPollLocation
): ClassifiedSevereWeatherAlert | null {
  const id = toNonEmptyString(rawAlert?.id);
  if (!id) {
    return null;
  }

  const sourceLocationId = toNonEmptyString(location.id) || `${location.latitude},${location.longitude}`;
  const event = toNonEmptyString(rawAlert?.event) || 'Unknown Event';
  const headline = toNullableString(rawAlert?.headline);
  const description = toNullableString(rawAlert?.description);

  return {
    id,
    event,
    type: classifyAlertType({
      event,
      headline,
      description,
    }),
    severityClass: classifyAlertSeverity({
      event,
      headline,
      severity: toNullableString(rawAlert?.severity),
    }),
    sourceSeverity: toNullableString(rawAlert?.severity),
    areaDesc: toNonEmptyString(rawAlert?.areaDesc) || '',
    affectedZones: uniqueStringArray(rawAlert?.affectedZones),
    geocode: normalizeGeocode(rawAlert?.geocode),
    sent: toIsoOrNull(rawAlert?.sent),
    effective: toIsoOrNull(rawAlert?.effective),
    onset: toIsoOrNull(rawAlert?.onset),
    expires: toIsoOrNull(rawAlert?.expires),
    ends: toIsoOrNull(rawAlert?.ends),
    status: toNullableString(rawAlert?.status),
    messageType: toNullableString(rawAlert?.messageType),
    category: toNullableString(rawAlert?.category),
    certainty: toNullableString(rawAlert?.certainty),
    urgency: toNullableString(rawAlert?.urgency),
    sender: toNullableString(rawAlert?.sender),
    senderName: toNullableString(rawAlert?.senderName),
    headline,
    description,
    instruction: toNullableString(rawAlert?.instruction),
    response: toNullableString(rawAlert?.response),
    parameters:
      rawAlert?.parameters && typeof rawAlert.parameters === 'object'
        ? { ...rawAlert.parameters }
        : {},
    references: Array.isArray(rawAlert?.references) ? rawAlert.references : [],
    sourceLocations: [sourceLocationId],
  };
}

function mergeAlerts(
  left: ClassifiedSevereWeatherAlert,
  right: ClassifiedSevereWeatherAlert
): ClassifiedSevereWeatherAlert {
  const mergedGeocode = cloneGeocode(left.geocode);
  for (const [key, values] of Object.entries(right.geocode)) {
    mergedGeocode[key] = uniqueStringArray([...(mergedGeocode[key] || []), ...values]);
  }

  return {
    ...left,
    ...right,
    areaDesc: joinUniqueStrings(left.areaDesc, right.areaDesc),
    affectedZones: uniqueStringArray([...left.affectedZones, ...right.affectedZones]),
    geocode: mergedGeocode,
    references: dedupeUnknownArray([...left.references, ...right.references]),
    sourceLocations: uniqueStringArray([...left.sourceLocations, ...right.sourceLocations]),
  };
}

function dedupeUnknownArray(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const deduped: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function compareActiveAlerts(a: ActiveSevereWeatherAlert, b: ActiveSevereWeatherAlert): number {
  const rankDiff = severityRank(b.severityClass) - severityRank(a.severityClass);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  return b.lastSeenAt.localeCompare(a.lastSeenAt);
}

function severityRank(value: SevereAlertSeverityClass): number {
  switch (value) {
    case 'warning':
      return 5;
    case 'watch':
      return 4;
    case 'advisory':
      return 3;
    case 'statement':
      return 2;
    default:
      return 1;
  }
}

function validateLocations(locations: AlertPollLocation[]): AlertPollLocation[] {
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new SevereWeatherResponseValidationError('At least one poll location is required');
  }

  const sanitized = locations.map((location, idx) => {
    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new SevereWeatherResponseValidationError(
        `locations[${idx}].latitude must be a valid value between -90 and 90`
      );
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new SevereWeatherResponseValidationError(
        `locations[${idx}].longitude must be a valid value between -180 and 180`
      );
    }
    const id = toNullableString(location?.id);
    return { id: id || undefined, latitude, longitude };
  });

  return sanitized;
}

function computeAlertSignature(alert: ClassifiedSevereWeatherAlert): string {
  const orderedGeocode: Record<string, string[]> = {};
  for (const key of Object.keys(alert.geocode).sort()) {
    orderedGeocode[key] = [...alert.geocode[key]].sort();
  }

  const payload = {
    id: alert.id,
    event: alert.event,
    type: alert.type,
    severityClass: alert.severityClass,
    sourceSeverity: alert.sourceSeverity,
    areaDesc: alert.areaDesc,
    affectedZones: [...alert.affectedZones].sort(),
    geocode: orderedGeocode,
    sent: alert.sent,
    effective: alert.effective,
    onset: alert.onset,
    expires: alert.expires,
    ends: alert.ends,
    status: alert.status,
    messageType: alert.messageType,
    category: alert.category,
    certainty: alert.certainty,
    urgency: alert.urgency,
    sender: alert.sender,
    senderName: alert.senderName,
    headline: alert.headline,
    description: alert.description,
    instruction: alert.instruction,
    response: alert.response,
    parameters: alert.parameters,
    references: alert.references,
  };

  return JSON.stringify(payload);
}

function normalizeGeocode(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const normalized: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    normalized[key] = uniqueStringArray(raw);
  }
  return normalized;
}

function cloneGeocode(value: Record<string, string[]>): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(value)) {
    next[key] = [...list];
  }
  return next;
}

function uniqueStringArray(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const next = toNonEmptyString(item);
    if (!next || seen.has(next)) {
      continue;
    }
    seen.add(next);
    out.push(next);
  }
  return out;
}

function joinUniqueStrings(left: string, right: string): string {
  return uniqueStringArray([left, right]).join('; ');
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNullableString(value: unknown): string | null {
  return toNonEmptyString(value);
}

function toIsoOrNull(value: unknown): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function hasExpired(expiresIso: string | null, now: Date): boolean {
  if (!expiresIso) {
    return false;
  }
  return new Date(expiresIso).getTime() <= now.getTime();
}
