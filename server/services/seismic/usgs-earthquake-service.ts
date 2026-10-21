import crypto from 'crypto';
import {
  SeismicEvent,
  UsgsAlertLevel,
  UsgsEarthquakeFeed,
  UsgsEarthquakeMetrics,
  UsgsEarthquakePollResult,
  UsgsEarthquakeWindow,
} from './seismic-event-types.js';

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
}

type FetchLike = (url: string) => Promise<FetchResponse>;

interface UsgsEarthquakePollOptions {
  feed?: UsgsEarthquakeFeed;
  window?: UsgsEarthquakeWindow;
  period?: UsgsEarthquakeWindow;
}

interface UsgsEarthquakeServiceOptions {
  fetchFn?: FetchLike;
  nowFn?: () => Date;
  feedBaseUrl?: string;
  pollIntervalMs?: number;
  maxDedupeKeys?: number;
  maxRecentEvents?: number;
}

const DEFAULT_FEED_BASE_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';
const ALLOWED_FEEDS: UsgsEarthquakeFeed[] = ['significant', '4.5', '2.5', 'all'];
const ALLOWED_WINDOWS: UsgsEarthquakeWindow[] = ['hour', 'day', 'week'];

export class UsgsEarthquakeError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'UsgsEarthquakeError';
    this.statusCode = statusCode;
  }
}

export class UsgsEarthquakeValidationError extends UsgsEarthquakeError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'UsgsEarthquakeValidationError';
  }
}

export class UsgsEarthquakeUpstreamError extends UsgsEarthquakeError {
  readonly upstreamStatus?: number;

  constructor(message: string, statusCode = 502, upstreamStatus?: number) {
    super(message, statusCode);
    this.name = 'UsgsEarthquakeUpstreamError';
    this.upstreamStatus = upstreamStatus;
  }
}

export class UsgsEarthquakeService {
  private readonly fetchFn: FetchLike;
  private readonly nowFn: () => Date;
  private readonly feedBaseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly maxDedupeKeys: number;
  private readonly maxRecentEvents: number;

  private readonly dedupeKeys = new Set<string>();
  private readonly dedupeOrder: string[] = [];
  private recentEvents: SeismicEvent[] = [];

  private readonly metricsState = {
    pollAttempts: 0,
    pollSuccesses: 0,
    pollFailures: 0,
    parseFailures: 0,
    ingestedEvents: 0,
    duplicateEvents: 0,
    recentLatencyMs: null as number | null,
    lastPollAt: null as string | null,
    lastFeed: null as UsgsEarthquakeFeed | null,
    lastWindow: null as UsgsEarthquakeWindow | null,
  };

  constructor(options: UsgsEarthquakeServiceOptions = {}) {
    this.fetchFn = options.fetchFn || (fetch as unknown as FetchLike);
    this.nowFn = options.nowFn || (() => new Date());
    this.feedBaseUrl = options.feedBaseUrl || DEFAULT_FEED_BASE_URL;
    this.pollIntervalMs = options.pollIntervalMs || 5 * 60 * 1000;
    this.maxDedupeKeys = options.maxDedupeKeys || 50000;
    this.maxRecentEvents = options.maxRecentEvents || 5000;
  }

  async pollFeed(options: UsgsEarthquakePollOptions = {}): Promise<UsgsEarthquakePollResult> {
    const feed = resolveFeed(options.feed);
    const window = resolveWindow(options.window || options.period);
    const started = Date.now();

    this.metricsState.pollAttempts += 1;

    try {
      const sourceUrl = this.buildFeedUrl(feed, window);
      const payload = await this.fetchJson(sourceUrl);
      const parsed = this.normalizeFeedPayload(payload, {
        feed,
        window,
        sourceUrl,
      });

      this.recentEvents = [...parsed.events, ...this.recentEvents].slice(0, this.maxRecentEvents);
      this.metricsState.pollSuccesses += 1;
      this.metricsState.ingestedEvents += parsed.events.length;
      this.metricsState.duplicateEvents += parsed.duplicateEvents;
      this.metricsState.recentLatencyMs = Date.now() - started;
      this.metricsState.lastPollAt = this.nowFn().toISOString();
      this.metricsState.lastFeed = feed;
      this.metricsState.lastWindow = window;

      return {
        feed,
        window,
        pollIntervalMs: this.pollIntervalMs,
        rawEvents: parsed.rawEvents,
        ingestedEvents: parsed.events.length,
        duplicateEvents: parsed.duplicateEvents,
        events: parsed.events,
      };
    } catch (error) {
      this.metricsState.pollFailures += 1;
      if (error instanceof UsgsEarthquakeError) {
        throw error;
      }
      throw new UsgsEarthquakeUpstreamError('USGS earthquake feed polling failed');
    }
  }

  getRecentEvents(limit = 200): SeismicEvent[] {
    const capped = clampInt(limit, 1, this.maxRecentEvents, 200);
    return this.recentEvents.slice(0, capped);
  }

  getMetrics(): UsgsEarthquakeMetrics {
    return {
      pollIntervalMs: this.pollIntervalMs,
      pollAttempts: this.metricsState.pollAttempts,
      pollSuccesses: this.metricsState.pollSuccesses,
      pollFailures: this.metricsState.pollFailures,
      parseFailures: this.metricsState.parseFailures,
      ingestedEvents: this.metricsState.ingestedEvents,
      duplicateEvents: this.metricsState.duplicateEvents,
      recentLatencyMs: this.metricsState.recentLatencyMs,
      lastPollAt: this.metricsState.lastPollAt,
      lastFeed: this.metricsState.lastFeed,
      lastWindow: this.metricsState.lastWindow,
    };
  }

  private buildFeedUrl(feed: UsgsEarthquakeFeed, window: UsgsEarthquakeWindow): string {
    return `${this.feedBaseUrl}/${feed}_${window}.geojson`;
  }

  private async fetchJson(url: string): Promise<any> {
    const response = await this.fetchFn(url);
    if (!response.ok) {
      const mappedStatus = response.status === 429 ? 429 : 502;
      throw new UsgsEarthquakeUpstreamError(
        `USGS earthquake request failed with status ${response.status}`,
        mappedStatus,
        response.status
      );
    }

    try {
      return await response.json();
    } catch {
      this.metricsState.parseFailures += 1;
      throw new UsgsEarthquakeUpstreamError('USGS earthquake response JSON parsing failed');
    }
  }

  private normalizeFeedPayload(
    payload: any,
    context: {
      feed: UsgsEarthquakeFeed;
      window: UsgsEarthquakeWindow;
      sourceUrl: string;
    }
  ): {
    rawEvents: number;
    duplicateEvents: number;
    events: SeismicEvent[];
  } {
    const features = payload?.features;
    if (!Array.isArray(features)) {
      this.metricsState.parseFailures += 1;
      throw new UsgsEarthquakeUpstreamError('USGS payload missing features array');
    }

    const events: SeismicEvent[] = [];
    let duplicateEvents = 0;

    for (const feature of features) {
      const normalized = this.normalizeFeature(feature, context);
      if (!normalized) {
        this.metricsState.parseFailures += 1;
        continue;
      }

      if (this.dedupeKeys.has(normalized.dedupeKey)) {
        duplicateEvents += 1;
        continue;
      }

      this.pushDedupeKey(normalized.dedupeKey);
      events.push(normalized);
    }

    return {
      rawEvents: features.length,
      duplicateEvents,
      events,
    };
  }

  private normalizeFeature(
    feature: any,
    context: {
      feed: UsgsEarthquakeFeed;
      window: UsgsEarthquakeWindow;
      sourceUrl: string;
    }
  ): SeismicEvent | null {
    const eventId = normalizeString(feature?.id);
    const props = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates;

    if (!eventId || !Array.isArray(coordinates) || coordinates.length < 3) {
      return null;
    }

    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    const depthKm = Number(coordinates[2]);
    const magnitude = toRequiredNumber(props.mag);
    const occurredAt = toIsoTimestamp(props.time);

    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(depthKm) ||
      magnitude === null ||
      !occurredAt
    ) {
      return null;
    }

    const feltReports = toOptionalInteger(props.felt);
    const maxIntensity = toOptionalNumber(props.mmi);
    const alertLevel = normalizeAlertLevel(props.alert);
    const dedupeKey = eventId;

    return {
      observationId: `seis_${sha256Hex(eventId).slice(0, 16)}`,
      dedupeKey,
      category: 'Seismic',
      source: 'USGS',
      eventId,
      occurredAt,
      ingestedAt: this.nowFn().toISOString(),
      location: {
        latitude,
        longitude,
        depthKm,
        place: normalizeString(props.place) || undefined,
      },
      magnitude,
      magnitudeType: normalizeString(props.magType)?.toLowerCase() || undefined,
      feltReports: feltReports ?? undefined,
      maxIntensity: maxIntensity ?? undefined,
      tsunamiWarning: Number(props.tsunami) === 1,
      alertLevel: alertLevel || undefined,
      sourceMetadata: {
        endpoint: `/summary/${context.feed}_${context.window}.geojson`,
        sourceUrl: context.sourceUrl,
        feed: context.feed,
        window: context.window,
        detailUrl: normalizeString(props.detail) || undefined,
        eventUrl: normalizeString(props.url) || undefined,
        significance: toOptionalNumber(props.sig) ?? undefined,
        status: normalizeString(props.status) || undefined,
        updatedAt: toIsoTimestamp(props.updated) || undefined,
        title: normalizeString(props.title) || undefined,
        eventType: normalizeString(props.type) || undefined,
      },
    };
  }

  private pushDedupeKey(key: string): void {
    this.dedupeKeys.add(key);
    this.dedupeOrder.push(key);
    while (this.dedupeOrder.length > this.maxDedupeKeys) {
      const oldest = this.dedupeOrder.shift();
      if (oldest) {
        this.dedupeKeys.delete(oldest);
      }
    }
  }
}

function resolveFeed(feed: UsgsEarthquakePollOptions['feed']): UsgsEarthquakeFeed {
  if (!feed) {
    return 'all';
  }
  if (ALLOWED_FEEDS.includes(feed)) {
    return feed;
  }
  throw new UsgsEarthquakeValidationError(`feed must be one of: ${ALLOWED_FEEDS.join(', ')}`);
}

function resolveWindow(
  window: UsgsEarthquakePollOptions['window'] | UsgsEarthquakePollOptions['period']
): UsgsEarthquakeWindow {
  if (!window) {
    return 'hour';
  }
  if (ALLOWED_WINDOWS.includes(window)) {
    return window;
  }
  throw new UsgsEarthquakeValidationError(
    `window must be one of: ${ALLOWED_WINDOWS.join(', ')}`
  );
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(Number(value));
  return Math.min(max, Math.max(min, rounded));
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAlertLevel(value: unknown): UsgsAlertLevel | null {
  const normalized = normalizeString(value)?.toLowerCase();
  switch (normalized) {
    case 'green':
    case 'yellow':
    case 'orange':
    case 'red':
      return normalized;
    default:
      return null;
  }
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return null;
}

function toOptionalInteger(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function toRequiredNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function toOptionalNumber(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
