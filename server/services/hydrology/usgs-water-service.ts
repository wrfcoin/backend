import crypto from 'crypto';
import {
  HydrologicalObservation,
  HydrologicalSiteDiscoveryResult,
  UsgsHydrologyMetrics,
} from './hydrological-observation-types.js';

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}

type FetchLike = (url: string) => Promise<FetchResponse>;

interface UsgsWaterServiceOptions {
  fetchFn?: FetchLike;
  nowFn?: () => Date;
  baseUrl?: string;
  ivPollIntervalMs?: number;
  dvPollIntervalMs?: number;
  courtesyDelayMs?: number;
  maxDedupeKeys?: number;
}

interface WaterValueOptions {
  siteNumbers: string[];
  startTime?: string;
  endTime?: string;
  parameterCodes?: string[];
}

interface SiteDiscoveryOptions {
  stateCode?: string;
  countyCode?: string;
  boundingBox?: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  siteType?: string;
  maxSites?: number;
}

const DEFAULT_BASE_URL = 'https://waterservices.usgs.gov/nwis';
const DEFAULT_IV_CODES = ['00060', '00065', '00010', '00300'];
const DEFAULT_DV_CODES = ['00060', '00065', '00010'];

export class UsgsHydrologyError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'UsgsHydrologyError';
    this.statusCode = statusCode;
  }
}

export class UsgsHydrologyValidationError extends UsgsHydrologyError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'UsgsHydrologyValidationError';
  }
}

export class UsgsHydrologyUpstreamError extends UsgsHydrologyError {
  readonly upstreamStatus?: number;

  constructor(message: string, statusCode = 502, upstreamStatus?: number) {
    super(message, statusCode);
    this.name = 'UsgsHydrologyUpstreamError';
    this.upstreamStatus = upstreamStatus;
  }
}

export class UsgsWaterService {
  private readonly fetchFn: FetchLike;
  private readonly nowFn: () => Date;
  private readonly baseUrl: string;
  private readonly ivPollIntervalMs: number;
  private readonly dvPollIntervalMs: number;
  private readonly courtesyDelayMs: number;
  private readonly maxDedupeKeys: number;

  private lastRequestAt = 0;
  private readonly dedupeKeys = new Set<string>();
  private readonly dedupeOrder: string[] = [];
  private requestGate: Promise<void> = Promise.resolve();

  private metricsState = {
    ivSuccesses: 0,
    ivFailures: 0,
    dvSuccesses: 0,
    dvFailures: 0,
    siteDiscoverySuccesses: 0,
    siteDiscoveryFailures: 0,
    parseFailures: 0,
    recentLatencyMs: null as number | null,
  };

  constructor(options: UsgsWaterServiceOptions = {}) {
    this.fetchFn = options.fetchFn || (fetch as unknown as FetchLike);
    this.nowFn = options.nowFn || (() => new Date());
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.ivPollIntervalMs = options.ivPollIntervalMs || 15 * 60 * 1000;
    this.dvPollIntervalMs = options.dvPollIntervalMs || 60 * 60 * 1000;
    this.courtesyDelayMs = options.courtesyDelayMs || 250;
    this.maxDedupeKeys = options.maxDedupeKeys || 25000;
  }

  async fetchInstantaneousValues(
    options: WaterValueOptions
  ): Promise<HydrologicalObservation[]> {
    validateWaterValueOptions(options);
    const started = Date.now();

    try {
      const url = this.buildWaterValuesUrl('iv', options, options.parameterCodes || DEFAULT_IV_CODES);
      const payload = await this.fetchJson(url);
      const normalized = this.normalizeWaterValues(
        payload,
        'IV',
        '/iv/',
        options.parameterCodes || DEFAULT_IV_CODES
      );
      this.metricsState.ivSuccesses += 1;
      this.metricsState.recentLatencyMs = Date.now() - started;
      return normalized;
    } catch (error) {
      this.metricsState.ivFailures += 1;
      if (error instanceof UsgsHydrologyError) {
        throw error;
      }
      throw new UsgsHydrologyUpstreamError('USGS IV request failed');
    }
  }

  async fetchDailyValues(options: WaterValueOptions): Promise<HydrologicalObservation[]> {
    validateWaterValueOptions(options);
    const started = Date.now();

    try {
      const url = this.buildWaterValuesUrl('dv', options, options.parameterCodes || DEFAULT_DV_CODES);
      const payload = await this.fetchJson(url);
      const normalized = this.normalizeWaterValues(
        payload,
        'DV',
        '/dv/',
        options.parameterCodes || DEFAULT_DV_CODES
      );
      this.metricsState.dvSuccesses += 1;
      this.metricsState.recentLatencyMs = Date.now() - started;
      return normalized;
    } catch (error) {
      this.metricsState.dvFailures += 1;
      if (error instanceof UsgsHydrologyError) {
        throw error;
      }
      throw new UsgsHydrologyUpstreamError('USGS DV request failed');
    }
  }

  async discoverSites(options: SiteDiscoveryOptions): Promise<HydrologicalSiteDiscoveryResult> {
    validateSiteDiscoveryOptions(options);
    const started = Date.now();

    try {
      const url = this.buildSiteDiscoveryUrl(options);
      const rdbPayload = await this.fetchText(url);
      const sites = parseUsgsRdbSitePayload(rdbPayload, options.maxSites || 500);

      this.metricsState.siteDiscoverySuccesses += 1;
      this.metricsState.recentLatencyMs = Date.now() - started;
      return {
        sites,
        count: sites.length,
      };
    } catch (error) {
      this.metricsState.siteDiscoveryFailures += 1;
      if (error instanceof UsgsHydrologyError) {
        throw error;
      }
      throw new UsgsHydrologyUpstreamError('USGS site discovery failed');
    }
  }

  getMetrics(): UsgsHydrologyMetrics {
    return {
      ivPollIntervalMs: this.ivPollIntervalMs,
      dvPollIntervalMs: this.dvPollIntervalMs,
      ivSuccesses: this.metricsState.ivSuccesses,
      ivFailures: this.metricsState.ivFailures,
      dvSuccesses: this.metricsState.dvSuccesses,
      dvFailures: this.metricsState.dvFailures,
      siteDiscoverySuccesses: this.metricsState.siteDiscoverySuccesses,
      siteDiscoveryFailures: this.metricsState.siteDiscoveryFailures,
      parseFailures: this.metricsState.parseFailures,
      recentLatencyMs: this.metricsState.recentLatencyMs,
    };
  }

  private buildWaterValuesUrl(
    mode: 'iv' | 'dv',
    options: WaterValueOptions,
    parameterCodes: string[]
  ): string {
    const params = new URLSearchParams({
      format: 'json',
      sites: options.siteNumbers.join(','),
      parameterCd: parameterCodes.join(','),
      siteStatus: 'all',
    });

    if (options.startTime) {
      params.set(mode === 'iv' ? 'startDT' : 'startDT', options.startTime);
    }
    if (options.endTime) {
      params.set(mode === 'iv' ? 'endDT' : 'endDT', options.endTime);
    }

    return `${this.baseUrl}/${mode}/?${params.toString()}`;
  }

  private buildSiteDiscoveryUrl(options: SiteDiscoveryOptions): string {
    const params = new URLSearchParams({
      format: 'rdb',
      siteOutput: 'expanded',
      siteStatus: 'all',
      siteType: options.siteType || 'ST',
    });

    if (options.stateCode) {
      params.set('stateCd', options.stateCode);
    }
    if (options.countyCode) {
      params.set('countyCd', options.countyCode);
    }
    if (options.boundingBox) {
      params.set(
        'bBox',
        `${options.boundingBox.west},${options.boundingBox.south},${options.boundingBox.east},${options.boundingBox.north}`
      );
    }

    return `${this.baseUrl}/site/?${params.toString()}`;
  }

  private async fetchJson(url: string): Promise<any> {
    await this.enforceCourtesyDelay();
    const response = await this.fetchFn(url);
    if (!response.ok) {
      const mappedStatus = response.status === 429 ? 429 : 502;
      throw new UsgsHydrologyUpstreamError(
        `USGS request failed with status ${response.status}`,
        mappedStatus,
        response.status
      );
    }

    try {
      return await response.json();
    } catch {
      this.metricsState.parseFailures += 1;
      throw new UsgsHydrologyUpstreamError('USGS response JSON parsing failed');
    }
  }

  private async fetchText(url: string): Promise<string> {
    await this.enforceCourtesyDelay();
    const response = await this.fetchFn(url);
    if (!response.ok) {
      const mappedStatus = response.status === 429 ? 429 : 502;
      throw new UsgsHydrologyUpstreamError(
        `USGS request failed with status ${response.status}`,
        mappedStatus,
        response.status
      );
    }

    return response.text();
  }

  private async enforceCourtesyDelay(): Promise<void> {
    const nextGate = this.requestGate.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastRequestAt;
      if (elapsed < this.courtesyDelayMs) {
        await new Promise(resolve => setTimeout(resolve, this.courtesyDelayMs - elapsed));
      }
      this.lastRequestAt = Date.now();
    });
    this.requestGate = nextGate.catch(() => undefined);
    await nextGate;
  }

  private normalizeWaterValues(
    payload: any,
    interval: 'IV' | 'DV',
    endpointPath: string,
    parameterCodes: string[]
  ): HydrologicalObservation[] {
    const series = payload?.value?.timeSeries;
    if (!Array.isArray(series)) {
      this.metricsState.parseFailures += 1;
      throw new UsgsHydrologyUpstreamError('USGS payload missing value.timeSeries array');
    }

    const merged = new Map<string, HydrologicalObservation>();

    for (const timeSeries of series) {
      const siteNumber = timeSeries?.sourceInfo?.siteCode?.[0]?.value;
      const siteName = timeSeries?.sourceInfo?.siteName;
      const latitude = Number(
        timeSeries?.sourceInfo?.geoLocation?.geogLocation?.latitude
      );
      const longitude = Number(
        timeSeries?.sourceInfo?.geoLocation?.geogLocation?.longitude
      );
      const parameterCode = timeSeries?.variable?.variableCode?.[0]?.value;
      const values = timeSeries?.values?.[0]?.value;

      if (
        !siteNumber ||
        !siteName ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        !parameterCode ||
        !Array.isArray(values)
      ) {
        this.metricsState.parseFailures += 1;
        continue;
      }

      for (const point of values) {
        const timestamp = normalizeTimestamp(point?.dateTime);
        const rawValue = Number(point?.value);
        if (!timestamp || !Number.isFinite(rawValue)) {
          this.metricsState.parseFailures += 1;
          continue;
        }

        const mapKey = `${siteNumber}|${timestamp}`;
        let observation = merged.get(mapKey);
        if (!observation) {
          observation = {
            observationId: '',
            dedupeKey: '',
            category: 'Hydrological',
            interval,
            observedAt: timestamp,
            ingestedAt: this.nowFn().toISOString(),
            station: {
              siteNumber,
              siteName,
              latitude,
              longitude,
            },
            metrics: {},
            sourceMetadata: {
              endpoint: endpointPath,
              parameterCodes,
              qualifiers: Array.isArray(point?.qualifiers) ? point.qualifiers : undefined,
            },
          };
          merged.set(mapKey, observation);
        }

        applyParameterValue(observation, parameterCode, rawValue);
      }
    }

    const observations: HydrologicalObservation[] = [];
    for (const observation of merged.values()) {
      const dedupeRaw = `${observation.interval}|${observation.station.siteNumber}|${observation.observedAt}|${stableMetricsString(observation.metrics)}`;
      const dedupeKey = sha256Hex(dedupeRaw);
      if (this.dedupeKeys.has(dedupeKey)) {
        continue;
      }
      this.pushDedupeKey(dedupeKey);
      observation.dedupeKey = dedupeKey;
      observation.observationId = `hyd_${dedupeKey.slice(0, 16)}`;
      observations.push(observation);
    }

    return observations;
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

function validateWaterValueOptions(options: WaterValueOptions): void {
  if (!Array.isArray(options.siteNumbers) || options.siteNumbers.length === 0) {
    throw new UsgsHydrologyValidationError('siteNumbers must contain at least one USGS site ID');
  }

  for (const site of options.siteNumbers) {
    if (typeof site !== 'string' || site.trim().length === 0) {
      throw new UsgsHydrologyValidationError('siteNumbers contains an invalid site ID');
    }
  }

  if (options.parameterCodes) {
    if (!Array.isArray(options.parameterCodes) || options.parameterCodes.length === 0) {
      throw new UsgsHydrologyValidationError('parameterCodes must be a non-empty string array');
    }
    for (const code of options.parameterCodes) {
      if (typeof code !== 'string' || !/^\d{5}$/.test(code)) {
        throw new UsgsHydrologyValidationError('parameterCodes must use 5-digit USGS parameter IDs');
      }
    }
  }

  const start = options.startTime ? Date.parse(options.startTime) : null;
  const end = options.endTime ? Date.parse(options.endTime) : null;
  if (options.startTime && !Number.isFinite(start)) {
    throw new UsgsHydrologyValidationError('startTime must be a valid ISO timestamp');
  }
  if (options.endTime && !Number.isFinite(end)) {
    throw new UsgsHydrologyValidationError('endTime must be a valid ISO timestamp');
  }
  if (start !== null && end !== null && start > end) {
    throw new UsgsHydrologyValidationError('startTime must be before or equal to endTime');
  }
}

function validateSiteDiscoveryOptions(options: SiteDiscoveryOptions): void {
  const hasState = typeof options.stateCode === 'string' && options.stateCode.trim().length > 0;
  const hasCounty = typeof options.countyCode === 'string' && options.countyCode.trim().length > 0;
  const hasBbox = !!options.boundingBox;

  if (!hasState && !hasCounty && !hasBbox) {
    throw new UsgsHydrologyValidationError(
      'Provide at least one site filter: stateCode, countyCode, or boundingBox'
    );
  }

  if (options.boundingBox) {
    const { west, south, east, north } = options.boundingBox;
    if (
      !Number.isFinite(west) ||
      !Number.isFinite(south) ||
      !Number.isFinite(east) ||
      !Number.isFinite(north) ||
      east <= west ||
      north <= south
    ) {
      throw new UsgsHydrologyValidationError('boundingBox is invalid');
    }
  }
}

function parseUsgsRdbSitePayload(payload: string, maxSites: number): HydrologicalSiteDiscoveryResult['sites'] {
  const lines = payload
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

  if (lines.length < 2) {
    return [];
  }

  const header = lines[0].split('\t');
  const dataStartIndex = lines[1].match(/^[0-9]+s/) ? 2 : 1;

  const sites: HydrologicalSiteDiscoveryResult['sites'] = [];
  for (let index = dataStartIndex; index < lines.length; index++) {
    const columns = lines[index].split('\t');
    const record = buildRecord(header, columns);

    const siteNumber = record.site_no;
    const siteName = record.station_nm;
    const latitude = Number(record.dec_lat_va);
    const longitude = Number(record.dec_long_va);

    if (!siteNumber || !siteName || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    sites.push({
      siteNumber,
      siteName,
      latitude,
      longitude,
      stateCode: record.state_cd || undefined,
      countyCode: record.county_cd || undefined,
    });

    if (sites.length >= maxSites) {
      break;
    }
  }

  return sites;
}

function buildRecord(header: string[], values: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  header.forEach((field, index) => {
    record[field] = values[index] || '';
  });
  return record;
}

function normalizeTimestamp(rawTimestamp: string | undefined): string | null {
  if (!rawTimestamp || typeof rawTimestamp !== 'string') {
    return null;
  }

  const parsed = Date.parse(rawTimestamp);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function applyParameterValue(
  observation: HydrologicalObservation,
  parameterCode: string,
  value: number
): void {
  switch (parameterCode) {
    case '00060':
      observation.metrics.streamflowCfs = value;
      break;
    case '00065':
      observation.metrics.gageHeightFt = value;
      break;
    case '00010':
      observation.metrics.waterTemperatureC = value;
      break;
    case '00300':
      observation.metrics.dissolvedOxygenMgL = value;
      break;
    default:
      break;
  }
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function stableMetricsString(
  metrics: HydrologicalObservation['metrics']
): string {
  const keys = Object.keys(metrics).sort() as Array<keyof typeof metrics>;
  const ordered: Record<string, number> = {};
  for (const key of keys) {
    const value = metrics[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      ordered[key] = value;
    }
  }
  return JSON.stringify(ordered);
}
