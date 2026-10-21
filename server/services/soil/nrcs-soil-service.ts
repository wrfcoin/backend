import crypto from 'crypto';
import {
  NrcsEnvironmentalObservation,
  NrcsInterval,
  NrcsNetwork,
  NrcsSoilMetrics,
  NrcsSoilStation,
  NrcsStationDiscoveryResult,
} from './nrcs-soil-observation-types.js';

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
}

type FetchLike = (url: string) => Promise<FetchResponse>;

interface NrcsSoilServiceOptions {
  fetchFn?: FetchLike;
  nowFn?: () => Date;
  baseUrl?: string;
  scanStationTriplets?: string[];
  snotelStationTriplets?: string[];
  scanPollIntervalMs?: number;
  snotelPollIntervalMs?: number;
  courtesyDelayMs?: number;
  maxDedupeKeys?: number;
}

interface ObservationRequestOptions {
  stationTriplets?: string[];
  beginDate?: string;
  endDate?: string;
  duration?: NrcsInterval;
}

interface StationRequestOptions {
  network?: NrcsNetwork | 'ALL';
  stationTriplets?: string[];
}

const DEFAULT_BASE_URL = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1';
const DEFAULT_SCAN_POLL_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_SNOTEL_POLL_INTERVAL_MS = 60 * 60 * 1000;

export class NrcsSoilError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'NrcsSoilError';
    this.statusCode = statusCode;
  }
}

export class NrcsSoilValidationError extends NrcsSoilError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'NrcsSoilValidationError';
  }
}

export class NrcsSoilUpstreamError extends NrcsSoilError {
  readonly upstreamStatus?: number;

  constructor(message: string, statusCode = 502, upstreamStatus?: number) {
    super(message, statusCode);
    this.name = 'NrcsSoilUpstreamError';
    this.upstreamStatus = upstreamStatus;
  }
}

export class NrcsSoilService {
  private readonly fetchFn: FetchLike;
  private readonly nowFn: () => Date;
  private readonly baseUrl: string;
  private readonly scanStationTriplets: string[];
  private readonly snotelStationTriplets: string[];
  private readonly scanPollIntervalMs: number;
  private readonly snotelPollIntervalMs: number;
  private readonly courtesyDelayMs: number;
  private readonly maxDedupeKeys: number;

  private lastRequestAt = 0;
  private requestGate: Promise<void> = Promise.resolve();
  private readonly dedupeKeys = new Set<string>();
  private readonly dedupeOrder: string[] = [];

  private metricsState = {
    scanSuccesses: 0,
    scanFailures: 0,
    snotelSuccesses: 0,
    snotelFailures: 0,
    stationMetadataSuccesses: 0,
    stationMetadataFailures: 0,
    parseFailures: 0,
    recentLatencyMs: null as number | null,
  };

  constructor(options: NrcsSoilServiceOptions = {}) {
    this.fetchFn = options.fetchFn || (fetch as unknown as FetchLike);
    this.nowFn = options.nowFn || (() => new Date());
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.scanStationTriplets =
      options.scanStationTriplets || parseStationList(process.env.NRCS_SCAN_STATIONS);
    this.snotelStationTriplets =
      options.snotelStationTriplets || parseStationList(process.env.NRCS_SNOTEL_STATIONS);
    this.scanPollIntervalMs = options.scanPollIntervalMs || DEFAULT_SCAN_POLL_INTERVAL_MS;
    this.snotelPollIntervalMs = options.snotelPollIntervalMs || DEFAULT_SNOTEL_POLL_INTERVAL_MS;
    this.courtesyDelayMs = options.courtesyDelayMs || 250;
    this.maxDedupeKeys = options.maxDedupeKeys || 25000;
  }

  async fetchScanObservations(
    options: ObservationRequestOptions = {}
  ): Promise<NrcsEnvironmentalObservation[]> {
    return this.fetchObservations('SCAN', options);
  }

  async fetchSnotelObservations(
    options: ObservationRequestOptions = {}
  ): Promise<NrcsEnvironmentalObservation[]> {
    return this.fetchObservations('SNOTEL', options);
  }

  async fetchStations(options: StationRequestOptions = {}): Promise<NrcsStationDiscoveryResult> {
    const started = Date.now();

    try {
      const network = options.network || 'ALL';
      const stationTriplets = resolveStationTripletsForMetadata(
        network,
        options.stationTriplets,
        this.scanStationTriplets,
        this.snotelStationTriplets
      );
      const url = this.buildStationUrl(network, stationTriplets);
      const payload = await this.fetchJson(url);
      const stations = normalizeStations(payload, network, this.metricsState);

      this.metricsState.stationMetadataSuccesses += 1;
      this.metricsState.recentLatencyMs = Date.now() - started;
      return { stations, count: stations.length };
    } catch (error) {
      this.metricsState.stationMetadataFailures += 1;
      if (error instanceof NrcsSoilError) {
        throw error;
      }
      throw new NrcsSoilUpstreamError('NRCS station metadata request failed');
    }
  }

  getMetrics(): NrcsSoilMetrics {
    return {
      scanPollIntervalMs: this.scanPollIntervalMs,
      snotelPollIntervalMs: this.snotelPollIntervalMs,
      configuredScanStations: [...this.scanStationTriplets],
      configuredSnotelStations: [...this.snotelStationTriplets],
      scanSuccesses: this.metricsState.scanSuccesses,
      scanFailures: this.metricsState.scanFailures,
      snotelSuccesses: this.metricsState.snotelSuccesses,
      snotelFailures: this.metricsState.snotelFailures,
      stationMetadataSuccesses: this.metricsState.stationMetadataSuccesses,
      stationMetadataFailures: this.metricsState.stationMetadataFailures,
      parseFailures: this.metricsState.parseFailures,
      recentLatencyMs: this.metricsState.recentLatencyMs,
    };
  }

  private async fetchObservations(
    network: NrcsNetwork,
    options: ObservationRequestOptions
  ): Promise<NrcsEnvironmentalObservation[]> {
    validateObservationOptions(options);
    const started = Date.now();

    try {
      const stationTriplets = resolveStationTripletsForNetwork(
        network,
        options.stationTriplets,
        this.scanStationTriplets,
        this.snotelStationTriplets
      );
      const duration = options.duration || defaultDurationForNetwork(network);
      const url = this.buildObservationUrl(network, stationTriplets, duration, options);
      const payload = await this.fetchJson(url);
      const observations = normalizeObservations(
        payload,
        network,
        duration,
        network === 'SCAN' ? '/scan/' : '/snotel/',
        this.nowFn,
        this.metricsState,
        key => this.shouldDedupe(key),
        dedupeKey => this.pushDedupeKey(dedupeKey)
      );

      if (network === 'SCAN') {
        this.metricsState.scanSuccesses += 1;
      } else {
        this.metricsState.snotelSuccesses += 1;
      }
      this.metricsState.recentLatencyMs = Date.now() - started;
      return observations;
    } catch (error) {
      if (network === 'SCAN') {
        this.metricsState.scanFailures += 1;
      } else {
        this.metricsState.snotelFailures += 1;
      }

      if (error instanceof NrcsSoilError) {
        throw error;
      }
      throw new NrcsSoilUpstreamError(`NRCS ${network} request failed`);
    }
  }

  private buildObservationUrl(
    network: NrcsNetwork,
    stationTriplets: string[],
    duration: NrcsInterval,
    options: ObservationRequestOptions
  ): string {
    const params = new URLSearchParams({
      network,
      duration,
      stationTriplets: stationTriplets.join(','),
    });

    if (options.beginDate) {
      params.set('beginDate', options.beginDate);
    }
    if (options.endDate) {
      params.set('endDate', options.endDate);
    }

    return `${this.baseUrl}/observations?${params.toString()}`;
  }

  private buildStationUrl(network: NrcsNetwork | 'ALL', stationTriplets: string[]): string {
    const params = new URLSearchParams({ network });
    if (stationTriplets.length > 0) {
      params.set('stationTriplets', stationTriplets.join(','));
    }

    return `${this.baseUrl}/stations?${params.toString()}`;
  }

  private async fetchJson(url: string): Promise<any> {
    await this.enforceCourtesyDelay();
    const response = await this.fetchFn(url);
    if (!response.ok) {
      const mappedStatus = response.status === 429 ? 429 : 502;
      throw new NrcsSoilUpstreamError(
        `NRCS request failed with status ${response.status}`,
        mappedStatus,
        response.status
      );
    }

    try {
      return await response.json();
    } catch {
      this.metricsState.parseFailures += 1;
      throw new NrcsSoilUpstreamError('NRCS response JSON parsing failed');
    }
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

  private shouldDedupe(key: string): boolean {
    return this.dedupeKeys.has(key);
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

function validateObservationOptions(options: ObservationRequestOptions): void {
  if (options.stationTriplets) {
    validateStationTriplets(options.stationTriplets, 'stationTriplets');
  }

  if (options.duration && options.duration !== 'HOURLY' && options.duration !== 'DAILY') {
    throw new NrcsSoilValidationError('duration must be HOURLY or DAILY');
  }

  const begin = options.beginDate ? Date.parse(options.beginDate) : null;
  const end = options.endDate ? Date.parse(options.endDate) : null;
  if (options.beginDate && !Number.isFinite(begin)) {
    throw new NrcsSoilValidationError('beginDate must be a valid ISO timestamp');
  }
  if (options.endDate && !Number.isFinite(end)) {
    throw new NrcsSoilValidationError('endDate must be a valid ISO timestamp');
  }
  if (begin !== null && end !== null && begin > end) {
    throw new NrcsSoilValidationError('beginDate must be before or equal to endDate');
  }
}

function resolveStationTripletsForNetwork(
  network: NrcsNetwork,
  stationTriplets: string[] | undefined,
  configuredScanStations: string[],
  configuredSnotelStations: string[]
): string[] {
  if (stationTriplets) {
    validateStationTriplets(stationTriplets, 'stationTriplets');
    return stationTriplets;
  }

  const configured = network === 'SCAN' ? configuredScanStations : configuredSnotelStations;
  if (configured.length === 0) {
    throw new NrcsSoilValidationError(
      `No ${network} station list configured; provide stationTriplets in request or service options`
    );
  }

  return configured;
}

function resolveStationTripletsForMetadata(
  network: NrcsNetwork | 'ALL',
  stationTriplets: string[] | undefined,
  configuredScanStations: string[],
  configuredSnotelStations: string[]
): string[] {
  if (stationTriplets) {
    validateStationTriplets(stationTriplets, 'stationTriplets');
    return stationTriplets;
  }

  if (network === 'SCAN') {
    return [...configuredScanStations];
  }
  if (network === 'SNOTEL') {
    return [...configuredSnotelStations];
  }

  return Array.from(new Set([...configuredScanStations, ...configuredSnotelStations]));
}

function validateStationTriplets(values: string[], fieldName: string): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new NrcsSoilValidationError(`${fieldName} must be a non-empty string array`);
  }

  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new NrcsSoilValidationError(`${fieldName} contains an invalid station triplet`);
    }
  }
}

function defaultDurationForNetwork(network: NrcsNetwork): NrcsInterval {
  return network === 'SCAN' ? 'HOURLY' : 'DAILY';
}

function normalizeObservations(
  payload: any,
  network: NrcsNetwork,
  requestedDuration: NrcsInterval,
  endpointPath: string,
  nowFn: () => Date,
  metricsState: { parseFailures: number },
  shouldDedupe: (key: string) => boolean,
  rememberDedupe: (key: string) => void
): NrcsEnvironmentalObservation[] {
  const stationRecords = payload?.stations;
  if (!Array.isArray(stationRecords)) {
    metricsState.parseFailures += 1;
    throw new NrcsSoilUpstreamError('NRCS payload missing stations array');
  }

  const observations: NrcsEnvironmentalObservation[] = [];

  for (const stationRecord of stationRecords) {
    const station = parseStation(stationRecord, network, metricsState);
    if (!station) {
      continue;
    }

    const series = stationRecord?.observations;
    if (!Array.isArray(series)) {
      metricsState.parseFailures += 1;
      continue;
    }

    for (const point of series) {
      const observedAt = normalizeTimestamp(
        point?.timestamp || point?.dateTime || point?.observedAt
      );
      if (!observedAt) {
        metricsState.parseFailures += 1;
        continue;
      }

      const interval = normalizeInterval(point?.duration) || requestedDuration;
      const values =
        point?.values && typeof point.values === 'object'
          ? point.values
          : point?.metrics && typeof point.metrics === 'object'
            ? point.metrics
            : null;

      if (!values) {
        metricsState.parseFailures += 1;
        continue;
      }

      const normalizedMetrics =
        network === 'SCAN' ? normalizeScanMetrics(values) : normalizeSnotelMetrics(values);

      if (Object.keys(normalizedMetrics).length === 0) {
        metricsState.parseFailures += 1;
        continue;
      }

      const dedupeRaw = `${network}|${station.triplet}|${observedAt}|${stableMetricsString(normalizedMetrics)}`;
      const dedupeKey = sha256Hex(dedupeRaw);
      if (shouldDedupe(dedupeKey)) {
        continue;
      }
      rememberDedupe(dedupeKey);

      observations.push({
        observationId: `soil_${dedupeKey.slice(0, 16)}`,
        dedupeKey,
        category: 'Environmental',
        network,
        interval,
        observedAt,
        ingestedAt: nowFn().toISOString(),
        station,
        metrics: normalizedMetrics,
        sourceMetadata: {
          endpoint: endpointPath,
          elementCodes: Object.keys(values),
        },
      });
    }
  }

  return observations;
}

function normalizeStations(
  payload: any,
  fallbackNetwork: NrcsNetwork | 'ALL',
  metricsState: { parseFailures: number }
): NrcsSoilStation[] {
  const stationRecords = payload?.stations;
  if (!Array.isArray(stationRecords)) {
    metricsState.parseFailures += 1;
    throw new NrcsSoilUpstreamError('NRCS station payload missing stations array');
  }

  const stations: NrcsSoilStation[] = [];
  for (const stationRecord of stationRecords) {
    const resolvedNetwork =
      fallbackNetwork === 'ALL'
        ? normalizeNetwork(stationRecord?.network)
        : fallbackNetwork;
    if (!resolvedNetwork) {
      metricsState.parseFailures += 1;
      continue;
    }

    const station = parseStation(stationRecord, resolvedNetwork, metricsState);
    if (station) {
      stations.push(station);
    }
  }

  return stations;
}

function parseStation(
  stationRecord: any,
  fallbackNetwork: NrcsNetwork,
  metricsState: { parseFailures: number }
): NrcsSoilStation | null {
  const triplet = stationRecord?.triplet || stationRecord?.stationTriplet;
  const stationName = stationRecord?.stationName || stationRecord?.name;
  const latitude = Number(stationRecord?.latitude ?? stationRecord?.lat);
  const longitude = Number(stationRecord?.longitude ?? stationRecord?.lon);
  const elevationMeters = Number(stationRecord?.elevationMeters ?? stationRecord?.elevation);
  const network = normalizeNetwork(stationRecord?.network) || fallbackNetwork;

  if (
    typeof triplet !== 'string' ||
    triplet.trim().length === 0 ||
    typeof stationName !== 'string' ||
    stationName.trim().length === 0 ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(elevationMeters)
  ) {
    metricsState.parseFailures += 1;
    return null;
  }

  return {
    triplet: triplet.trim(),
    stationId: tripletToStationId(triplet),
    stationName: stationName.trim(),
    network,
    latitude,
    longitude,
    elevationMeters,
    stateCode: typeof stationRecord?.stateCode === 'string' ? stationRecord.stateCode : undefined,
    countyName:
      typeof stationRecord?.countyName === 'string' ? stationRecord.countyName : undefined,
  };
}

function normalizeScanMetrics(values: Record<string, unknown>): NrcsEnvironmentalObservation['metrics'] {
  const metrics: NrcsEnvironmentalObservation['metrics'] = {};

  assignMetric(metrics, 'soilMoisturePct5cm', values, ['soilMoisturePct5cm', 'SMS:I-1', 'SMS_5CM']);
  assignMetric(metrics, 'soilMoisturePct10cm', values, [
    'soilMoisturePct10cm',
    'SMS:I-2',
    'SMS_10CM',
  ]);
  assignMetric(metrics, 'soilMoisturePct20cm', values, [
    'soilMoisturePct20cm',
    'SMS:I-3',
    'SMS_20CM',
  ]);
  assignMetric(metrics, 'soilMoisturePct50cm', values, [
    'soilMoisturePct50cm',
    'SMS:I-4',
    'SMS_50CM',
  ]);
  assignMetric(metrics, 'soilTemperatureC', values, ['soilTemperatureC', 'STO:I-1', 'STO']);
  assignMetric(metrics, 'precipitationMm', values, ['precipitationMm', 'PREC', 'PRCP']);

  return metrics;
}

function normalizeSnotelMetrics(values: Record<string, unknown>): NrcsEnvironmentalObservation['metrics'] {
  const metrics: NrcsEnvironmentalObservation['metrics'] = {};

  assignMetric(metrics, 'snowWaterEquivalentMm', values, [
    'snowWaterEquivalentMm',
    'WTEQ',
    'SWE',
  ]);
  assignMetric(metrics, 'snowDepthCm', values, ['snowDepthCm', 'SNWD', 'SNOWDEPTH']);
  assignMetric(metrics, 'precipitationMm', values, ['precipitationMm', 'PREC', 'PRCP']);
  assignMetric(metrics, 'airTemperatureC', values, ['airTemperatureC', 'TAVG', 'TOBS']);

  return metrics;
}

function assignMetric(
  target: NrcsEnvironmentalObservation['metrics'],
  key: keyof NrcsEnvironmentalObservation['metrics'],
  values: Record<string, unknown>,
  sourceKeys: string[]
): void {
  for (const sourceKey of sourceKeys) {
    const candidate = values[sourceKey as keyof typeof values];
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) {
      target[key] = parsed;
      return;
    }
  }
}

function parseStationList(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  return raw
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

function normalizeNetwork(value: unknown): NrcsNetwork | null {
  if (value === 'SCAN') {
    return 'SCAN';
  }
  if (value === 'SNOTEL' || value === 'SNTL') {
    return 'SNOTEL';
  }
  return null;
}

function normalizeInterval(value: unknown): NrcsInterval | null {
  if (value === 'HOURLY') {
    return 'HOURLY';
  }
  if (value === 'DAILY') {
    return 'DAILY';
  }
  return null;
}

function normalizeTimestamp(rawTimestamp: unknown): string | null {
  if (typeof rawTimestamp !== 'string' || rawTimestamp.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(rawTimestamp);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function tripletToStationId(triplet: string): string {
  return triplet.split(':')[0] || triplet;
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function stableMetricsString(metrics: NrcsEnvironmentalObservation['metrics']): string {
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
