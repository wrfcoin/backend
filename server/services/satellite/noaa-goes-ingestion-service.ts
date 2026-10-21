import crypto from 'crypto';
import {
  BoundingBox,
  SatelliteIngestionMetrics,
  SatelliteObservation,
} from './satellite-observation-types.js';

interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type FetchLike = (url: string) => Promise<FetchResponse>;

interface PollOptions {
  productFamily?: string;
  hoursBack?: number;
  maxKeys?: number;
}

interface BackfillOptions {
  productFamily?: string;
  startTime: string;
  endTime: string;
  maxKeysPerHour?: number;
  maxHours?: number;
}

interface IngestionSummary {
  mode: 'poll' | 'backfill';
  prefixesProcessed: number;
  rawRecords: number;
  ingestedRecords: number;
  duplicateRecords: number;
  observations: SatelliteObservation[];
}

interface NoaaGoesIngestionServiceOptions {
  fetchFn?: FetchLike;
  nowFn?: () => Date;
  bucketBaseUrl?: string;
  maxRecentObservations?: number;
  maxDedupeKeys?: number;
}

interface ParsedListingItem {
  key: string;
  lastModified: string;
  sizeBytes: number;
  eTag?: string;
}

const DEFAULT_BUCKET_BASE_URL = 'https://noaa-goes16.s3.amazonaws.com';

export class SatelliteIngestionError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'SatelliteIngestionError';
    this.statusCode = statusCode;
  }
}

export class SatelliteValidationError extends SatelliteIngestionError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'SatelliteValidationError';
  }
}

export class SatelliteUpstreamError extends SatelliteIngestionError {
  constructor(message: string) {
    super(message, 502);
    this.name = 'SatelliteUpstreamError';
  }
}

export class NoaaGoesIngestionService {
  private readonly fetchFn: FetchLike;
  private readonly nowFn: () => Date;
  private readonly bucketBaseUrl: string;
  private readonly maxRecentObservations: number;
  private readonly maxDedupeKeys: number;

  private readonly dedupeKeys = new Set<string>();
  private readonly dedupeOrder: string[] = [];
  private recentObservations: SatelliteObservation[] = [];

  private readonly metricsState = {
    pollAttempts: 0,
    pollSuccesses: 0,
    pollFailures: 0,
    backfillAttempts: 0,
    backfillSuccesses: 0,
    backfillFailures: 0,
    parseFailures: 0,
    ingestedRecords: 0,
    duplicateRecords: 0,
    lagSamples: [] as number[],
    pollLagSamples: [] as number[],
    backfillLagSamples: [] as number[],
  };

  constructor(options: NoaaGoesIngestionServiceOptions = {}) {
    this.fetchFn = options.fetchFn || (fetch as unknown as FetchLike);
    this.nowFn = options.nowFn || (() => new Date());
    this.bucketBaseUrl = options.bucketBaseUrl || DEFAULT_BUCKET_BASE_URL;
    this.maxRecentObservations = options.maxRecentObservations || 5000;
    this.maxDedupeKeys = options.maxDedupeKeys || 20000;
  }

  async pollLatest(options: PollOptions = {}): Promise<IngestionSummary> {
    const productFamily = options.productFamily || 'ABI-L2-CMIPF';
    const hoursBack = clampInt(options.hoursBack, 0, 168, 0);
    const maxKeys = clampInt(options.maxKeys, 1, 500, 50);

    this.metricsState.pollAttempts += 1;

    try {
      const targetTime = new Date(this.nowFn().getTime() - hoursBack * 60 * 60 * 1000);
      const prefix = buildHourlyPrefix(productFamily, targetTime);
      const result = await this.ingestPrefix(prefix, maxKeys, 'poll');

      this.metricsState.pollSuccesses += 1;
      return {
        mode: 'poll',
        prefixesProcessed: 1,
        ...result,
      };
    } catch (error) {
      this.metricsState.pollFailures += 1;
      if (error instanceof SatelliteIngestionError) {
        throw error;
      }
      throw new SatelliteUpstreamError('GOES poll ingestion failed');
    }
  }

  async backfill(options: BackfillOptions): Promise<IngestionSummary> {
    const productFamily = options.productFamily || 'ABI-L2-CMIPF';
    const maxKeysPerHour = clampInt(options.maxKeysPerHour, 1, 500, 100);
    const maxHours = clampInt(options.maxHours, 1, 240, 72);

    const start = new Date(options.startTime);
    const end = new Date(options.endTime);

    if (!isValidDate(start) || !isValidDate(end)) {
      throw new SatelliteValidationError(
        'startTime and endTime must be valid ISO timestamps'
      );
    }
    if (start > end) {
      throw new SatelliteValidationError('startTime must be before endTime');
    }

    this.metricsState.backfillAttempts += 1;

    const prefixes: string[] = [];
    let current = new Date(start);
    while (current <= end) {
      prefixes.push(buildHourlyPrefix(productFamily, current));
      current = new Date(current.getTime() + 60 * 60 * 1000);
      if (prefixes.length > maxHours) {
        throw new SatelliteValidationError(
          `Backfill window exceeds max supported hours (${maxHours})`
        );
      }
    }

    let rawRecords = 0;
    let ingestedRecords = 0;
    let duplicateRecords = 0;
    const observations: SatelliteObservation[] = [];

    try {
      for (const prefix of prefixes) {
        const result = await this.ingestPrefix(prefix, maxKeysPerHour, 'backfill');
        rawRecords += result.rawRecords;
        ingestedRecords += result.ingestedRecords;
        duplicateRecords += result.duplicateRecords;
        observations.push(...result.observations);
      }
      this.metricsState.backfillSuccesses += 1;
    } catch (error) {
      this.metricsState.backfillFailures += 1;
      if (error instanceof SatelliteIngestionError) {
        throw error;
      }
      throw new SatelliteUpstreamError('GOES backfill ingestion failed');
    }

    return {
      mode: 'backfill',
      prefixesProcessed: prefixes.length,
      rawRecords,
      ingestedRecords,
      duplicateRecords,
      observations,
    };
  }

  extractRegional(
    observations: SatelliteObservation[],
    bounds: BoundingBox
  ): SatelliteObservation[] {
    validateBoundingBox(bounds);
    return observations.filter(observation =>
      doBoundsOverlap(observation.coverageBounds, bounds)
    );
  }

  getRecentObservations(limit = 200): SatelliteObservation[] {
    const capped = clampInt(limit, 1, this.maxRecentObservations, 200);
    return this.recentObservations.slice(0, capped);
  }

  getMetrics(): SatelliteIngestionMetrics {
    const lagSamples = this.metricsState.lagSamples;
    const pollLagSamples = this.metricsState.pollLagSamples;
    const backfillLagSamples = this.metricsState.backfillLagSamples;
    const averageLagMs =
      lagSamples.length > 0
        ? Math.round(lagSamples.reduce((sum, value) => sum + value, 0) / lagSamples.length)
        : null;
    const pollAverageLagMs =
      pollLagSamples.length > 0
        ? Math.round(
            pollLagSamples.reduce((sum, value) => sum + value, 0) / pollLagSamples.length
          )
        : null;
    const backfillAverageLagMs =
      backfillLagSamples.length > 0
        ? Math.round(
            backfillLagSamples.reduce((sum, value) => sum + value, 0) /
              backfillLagSamples.length
          )
        : null;

    return {
      pollAttempts: this.metricsState.pollAttempts,
      pollSuccesses: this.metricsState.pollSuccesses,
      pollFailures: this.metricsState.pollFailures,
      backfillAttempts: this.metricsState.backfillAttempts,
      backfillSuccesses: this.metricsState.backfillSuccesses,
      backfillFailures: this.metricsState.backfillFailures,
      parseFailures: this.metricsState.parseFailures,
      ingestedRecords: this.metricsState.ingestedRecords,
      duplicateRecords: this.metricsState.duplicateRecords,
      recentLagMs: lagSamples.length > 0 ? lagSamples[lagSamples.length - 1] : null,
      averageLagMs,
      pollAverageLagMs,
      backfillAverageLagMs,
      successRate:
        this.metricsState.pollAttempts + this.metricsState.backfillAttempts > 0
          ? round(
              (this.metricsState.pollSuccesses + this.metricsState.backfillSuccesses) /
                (this.metricsState.pollAttempts + this.metricsState.backfillAttempts)
            )
          : 0,
    };
  }

  private async ingestPrefix(
    prefix: string,
    maxKeys: number,
    mode: 'poll' | 'backfill'
  ): Promise<{
    rawRecords: number;
    ingestedRecords: number;
    duplicateRecords: number;
    observations: SatelliteObservation[];
  }> {
    const listing = await this.fetchListing(prefix, maxKeys);

    const observations: SatelliteObservation[] = [];
    let duplicateRecords = 0;

    for (const item of listing) {
      const observation = this.normalizeItem(prefix, item);
      if (!observation) {
        this.metricsState.parseFailures += 1;
        continue;
      }

      if (this.dedupeKeys.has(observation.dedupeKey)) {
        duplicateRecords += 1;
        this.metricsState.duplicateRecords += 1;
        continue;
      }

      this.pushDedupeKey(observation.dedupeKey);
      observations.push(observation);
      this.metricsState.ingestedRecords += 1;

      const lagMs = Math.max(0, this.nowFn().getTime() - Date.parse(observation.observationTime));
      this.metricsState.lagSamples.push(lagMs);
      if (this.metricsState.lagSamples.length > 500) {
        this.metricsState.lagSamples.shift();
      }
      if (mode === 'poll') {
        this.metricsState.pollLagSamples.push(lagMs);
        if (this.metricsState.pollLagSamples.length > 500) {
          this.metricsState.pollLagSamples.shift();
        }
      } else {
        this.metricsState.backfillLagSamples.push(lagMs);
        if (this.metricsState.backfillLagSamples.length > 500) {
          this.metricsState.backfillLagSamples.shift();
        }
      }
    }

    this.recentObservations = [...observations, ...this.recentObservations].slice(
      0,
      this.maxRecentObservations
    );

    return {
      rawRecords: listing.length,
      ingestedRecords: observations.length,
      duplicateRecords,
      observations,
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

  private async fetchListing(prefix: string, maxKeys: number): Promise<ParsedListingItem[]> {
    const url = `${this.bucketBaseUrl}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
    const response = await this.fetchFn(url);
    if (!response.ok) {
      throw new SatelliteUpstreamError(
        `GOES listing fetch failed with status ${response.status}`
      );
    }

    const xml = await response.text();
    return parseS3ListingXml(xml);
  }

  private normalizeItem(prefix: string, item: ParsedListingItem): SatelliteObservation | null {
    if (!item.key || !item.lastModified) {
      return null;
    }

    const observationTime = extractObservationTime(item.key, item.lastModified);
    const regionTag = inferRegionTag(item.key);
    const coverageBounds = inferCoverageBounds(regionTag);

    const dedupeRaw = `NOAA|GOES-16|${item.key}|${item.lastModified}`;
    const dedupeKey = sha256Hex(dedupeRaw);

    return {
      observationId: `sat_${dedupeKey.slice(0, 16)}`,
      dedupeKey,
      sourceType: 'satellite',
      provider: 'NOAA',
      platform: 'GOES-16',
      productFamily: inferProductFamily(item.key),
      observationTime,
      ingestedAt: this.nowFn().toISOString(),
      regionTag,
      coverageBounds,
      sourceMetadata: {
        bucket: 'noaa-goes16',
        key: item.key,
        eTag: item.eTag,
        sizeBytes: item.sizeBytes,
        lastModified: item.lastModified,
        sourceUrl: `${this.bucketBaseUrl}/${item.key}`,
      },
      rawMetadata: {
        prefix,
        listingTimestamp: this.nowFn().toISOString(),
      },
    };
  }
}

function parseS3ListingXml(xml: string): ParsedListingItem[] {
  const contents = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g));
  return contents.map(match => {
    const block = match[1];
    return {
      key: extractXmlTag(block, 'Key') || '',
      lastModified: extractXmlTag(block, 'LastModified') || '',
      sizeBytes: Number(extractXmlTag(block, 'Size') || 0),
      eTag: sanitizeETag(extractXmlTag(block, 'ETag')),
    };
  });
}

function extractXmlTag(input: string, tagName: string): string | null {
  const match = input.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? decodeXmlEntities(match[1].trim()) : null;
}

function sanitizeETag(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/"/g, '');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function buildHourlyPrefix(productFamily: string, timestamp: Date): string {
  const year = timestamp.getUTCFullYear();
  const dayOfYear = dayOfYearUtc(timestamp);
  const hour = String(timestamp.getUTCHours()).padStart(2, '0');
  return `${productFamily}/${year}/${String(dayOfYear).padStart(3, '0')}/${hour}/`;
}

function dayOfYearUtc(timestamp: Date): number {
  const startOfYear = Date.UTC(timestamp.getUTCFullYear(), 0, 1);
  const now = Date.UTC(
    timestamp.getUTCFullYear(),
    timestamp.getUTCMonth(),
    timestamp.getUTCDate()
  );
  return Math.floor((now - startOfYear) / (24 * 60 * 60 * 1000)) + 1;
}

function extractObservationTime(key: string, fallbackIso: string): string {
  const match = key.match(/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/);
  if (!match) {
    return new Date(fallbackIso).toISOString();
  }

  const year = Number(match[1]);
  const dayOfYear = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);

  const januaryFirst = new Date(Date.UTC(year, 0, 1));
  const observation = new Date(
    januaryFirst.getTime() +
      (dayOfYear - 1) * 24 * 60 * 60 * 1000 +
      hour * 60 * 60 * 1000 +
      minute * 60 * 1000 +
      second * 1000
  );

  return observation.toISOString();
}

function inferProductFamily(key: string): string {
  const [first] = key.split('/');
  return first || 'unknown';
}

function inferRegionTag(key: string): 'full_disk' | 'conus' | 'mesoscale' | 'unknown' {
  if (key.includes('CMIPF')) {
    return 'full_disk';
  }
  if (key.includes('CMIPC') || key.includes('CONUS')) {
    return 'conus';
  }
  if (key.includes('MCMIPM') || key.includes('MESO')) {
    return 'mesoscale';
  }
  return 'unknown';
}

function inferCoverageBounds(regionTag: 'full_disk' | 'conus' | 'mesoscale' | 'unknown'): BoundingBox {
  switch (regionTag) {
    case 'full_disk':
      return { west: -180, south: -90, east: 180, north: 90 };
    case 'conus':
      return { west: -130, south: 20, east: -60, north: 55 };
    case 'mesoscale':
      return { west: -115, south: 25, east: -70, north: 50 };
    default:
      return { west: -180, south: -90, east: 180, north: 90 };
  }
}

function doBoundsOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

function validateBoundingBox(bounds: BoundingBox): void {
  if (
    !Number.isFinite(bounds.west) ||
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.east) ||
    !Number.isFinite(bounds.north)
  ) {
    throw new SatelliteValidationError('Bounding box values must be finite numbers');
  }
  if (bounds.east <= bounds.west || bounds.north <= bounds.south) {
    throw new SatelliteValidationError(
      'Bounding box must have east > west and north > south'
    );
  }
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
