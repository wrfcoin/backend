import type { ActiveSevereWeatherAlert } from './severe-weather-response-service.js';

export type NarrativeStyle = 'brief' | 'standard' | 'detailed';

export interface NarrativeRegionBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface NarrativeWeatherRequest {
  stationId?: string;
  regionBounds?: NarrativeRegionBounds;
  style?: NarrativeStyle;
  includeEnsembleSummary?: boolean;
  enhanceWithLlm?: boolean;
}

export interface WeatherConditionsSnapshot {
  stationId?: string;
  regionLabel?: string;
  observedAt: string;
  temperatureF: number;
  humidity: number;
  windMph: number;
  pressureMb?: number;
  precipitationInLastHour?: number;
  conditionText?: string;
}

export interface ShortTermOutlook {
  periodHours: number;
  expectedHighF: number;
  expectedLowF: number;
  precipitationChance: number;
  dominantConditions: string;
}

export interface EnsembleNarrativeSummary {
  topModel: string;
  topSkillScore: number;
  confidenceBand: string;
}

export interface NarrativeWeatherReport {
  generatedAt: string;
  style: NarrativeStyle;
  source: {
    stationId: string | null;
    regionBounds: NarrativeRegionBounds | null;
  };
  report: {
    currentConditions: string;
    shortTermOutlook: string;
    activeAlertHighlights: string;
    ensembleSummary?: string;
    fullText: string;
  };
  metadata: {
    llmEnhanced: boolean;
    deterministic: boolean;
    alertCount: number;
  };
}

interface WeatherDataProvider {
  getCurrentConditions(input: {
    stationId?: string;
    regionBounds?: NarrativeRegionBounds;
  }): Promise<WeatherConditionsSnapshot>;
}

interface ForecastDataProvider {
  getShortTermOutlook(input: {
    stationId?: string;
    regionBounds?: NarrativeRegionBounds;
  }): Promise<ShortTermOutlook>;
}

interface AlertsProvider {
  getActiveAlerts(input: {
    stationId?: string;
    regionBounds?: NarrativeRegionBounds;
  }): Promise<ActiveSevereWeatherAlert[]>;
}

interface EnsembleProvider {
  getTopSummary(input: {
    regionBounds?: NarrativeRegionBounds;
  }): Promise<EnsembleNarrativeSummary | null>;
}

interface LlmEnhancer {
  enhance(input: {
    style: NarrativeStyle;
    text: string;
  }): Promise<string>;
}

interface NarrativeWeatherReportServiceOptions {
  weatherProvider?: WeatherDataProvider;
  forecastProvider?: ForecastDataProvider;
  alertsProvider?: AlertsProvider;
  ensembleProvider?: EnsembleProvider;
  llmEnhancer?: LlmEnhancer;
  nowFn?: () => Date;
}

export class NarrativeWeatherReportService {
  private readonly weatherProvider: WeatherDataProvider;
  private readonly forecastProvider: ForecastDataProvider;
  private readonly alertsProvider: AlertsProvider;
  private readonly ensembleProvider?: EnsembleProvider;
  private readonly llmEnhancer?: LlmEnhancer;
  private readonly nowFn: () => Date;

  constructor(options: NarrativeWeatherReportServiceOptions = {}) {
    this.weatherProvider = options.weatherProvider || new DefaultWeatherProvider();
    this.forecastProvider = options.forecastProvider || new DefaultForecastProvider();
    this.alertsProvider = options.alertsProvider || new DefaultAlertsProvider();
    this.ensembleProvider = options.ensembleProvider;
    this.llmEnhancer = options.llmEnhancer;
    this.nowFn = options.nowFn || (() => new Date());
  }

  async generateReport(request: NarrativeWeatherRequest): Promise<NarrativeWeatherReport> {
    validateRequest(request);

    const style: NarrativeStyle = request.style || 'standard';
    const generatedAt = this.nowFn().toISOString();

    const [conditions, outlook, alerts, ensembleSummary] = await Promise.all([
      this.weatherProvider.getCurrentConditions({
        stationId: request.stationId,
        regionBounds: request.regionBounds,
      }),
      this.forecastProvider.getShortTermOutlook({
        stationId: request.stationId,
        regionBounds: request.regionBounds,
      }),
      this.alertsProvider.getActiveAlerts({
        stationId: request.stationId,
        regionBounds: request.regionBounds,
      }),
      request.includeEnsembleSummary && this.ensembleProvider
        ? this.ensembleProvider.getTopSummary({ regionBounds: request.regionBounds })
        : Promise.resolve(null),
    ]);

    const sections = {
      currentConditions: renderCurrentConditions(conditions),
      shortTermOutlook: renderOutlook(outlook),
      activeAlertHighlights: renderAlerts(alerts),
      ensembleSummary: ensembleSummary ? renderEnsembleSummary(ensembleSummary) : undefined,
    };

    const ordered = [
      sections.currentConditions,
      sections.shortTermOutlook,
      sections.activeAlertHighlights,
      sections.ensembleSummary,
    ].filter((entry): entry is string => Boolean(entry));

    const trimmed = trimByStyle(ordered, style);
    let fullText = trimmed.join(' ');
    let llmEnhanced = false;

    if (request.enhanceWithLlm && this.llmEnhancer) {
      try {
        fullText = await this.llmEnhancer.enhance({ style, text: fullText });
        llmEnhanced = true;
      } catch {
        llmEnhanced = false;
      }
    }

    return {
      generatedAt,
      style,
      source: {
        stationId: request.stationId || null,
        regionBounds: request.regionBounds || null,
      },
      report: {
        ...sections,
        fullText,
      },
      metadata: {
        llmEnhanced,
        deterministic: !llmEnhanced,
        alertCount: alerts.length,
      },
    };
  }
}

function validateRequest(request: NarrativeWeatherRequest): void {
  const hasStation = typeof request.stationId === 'string' && request.stationId.trim().length > 0;
  const hasRegion = Boolean(request.regionBounds);
  if (!hasStation && !hasRegion) {
    throw new Error('Either stationId or regionBounds is required');
  }

  if (request.style && !['brief', 'standard', 'detailed'].includes(request.style)) {
    throw new Error('style must be one of: brief, standard, detailed');
  }

  if (request.regionBounds) {
    const { north, south, east, west } = request.regionBounds;
    if (
      ![north, south, east, west].every(value => typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new Error('regionBounds must include finite north/south/east/west values');
    }
    if (north <= south || east <= west) {
      throw new Error('regionBounds must satisfy north > south and east > west');
    }
  }
}

function renderCurrentConditions(conditions: WeatherConditionsSnapshot): string {
  const temp = `${Math.round(conditions.temperatureF)}F`;
  const humidity = `${Math.round(conditions.humidity)}% humidity`;
  const wind = `${Math.round(conditions.windMph)} mph winds`;
  const conditionText = conditions.conditionText || 'mixed conditions';

  return `Current conditions near ${conditions.stationId || conditions.regionLabel || 'the selected region'} at ${isoToReadable(conditions.observedAt)} are ${conditionText} with ${temp}, ${humidity}, and ${wind}.`;
}

function renderOutlook(outlook: ShortTermOutlook): string {
  return `Over the next ${outlook.periodHours} hours, temperatures are expected between ${Math.round(outlook.expectedLowF)}F and ${Math.round(outlook.expectedHighF)}F with a ${Math.round(outlook.precipitationChance * 100)}% precipitation chance and predominantly ${outlook.dominantConditions.toLowerCase()} conditions.`;
}

function renderAlerts(alerts: ActiveSevereWeatherAlert[]): string {
  if (!alerts.length) {
    return 'No active severe weather alerts are currently in effect for this area.';
  }

  const highlights = alerts
    .slice(0, 3)
    .map(alert => `${alert.event} (${alert.severityClass})`)
    .join(', ');

  return `${alerts.length} active alert${alerts.length === 1 ? '' : 's'}: ${highlights}.`;
}

function renderEnsembleSummary(summary: EnsembleNarrativeSummary): string {
  return `Ensemble guidance is led by ${summary.topModel} (skill ${summary.topSkillScore.toFixed(3)}), indicating a ${summary.confidenceBand.toLowerCase()} confidence outlook.`;
}

function trimByStyle(paragraphs: string[], style: NarrativeStyle): string[] {
  if (style === 'brief') {
    return [paragraphs[0] || 'Weather conditions are stable.'];
  }

  if (style === 'standard') {
    return paragraphs.slice(0, 3);
  }

  return paragraphs;
}

function isoToReadable(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

class DefaultWeatherProvider implements WeatherDataProvider {
  async getCurrentConditions(input: {
    stationId?: string;
    regionBounds?: NarrativeRegionBounds;
  }): Promise<WeatherConditionsSnapshot> {
    const seed = computeSeed(input.stationId || JSON.stringify(input.regionBounds || {}));
    return {
      stationId: input.stationId,
      regionLabel: input.regionBounds ? 'requested region' : undefined,
      observedAt: new Date().toISOString(),
      temperatureF: 50 + (seed % 40),
      humidity: 35 + (seed % 50),
      windMph: 5 + (seed % 25),
      pressureMb: 1000 + (seed % 25),
      precipitationInLastHour: Number(((seed % 10) / 10).toFixed(2)),
      conditionText: seed % 2 === 0 ? 'partly cloudy skies' : 'scattered showers',
    };
  }
}

class DefaultForecastProvider implements ForecastDataProvider {
  async getShortTermOutlook(input: {
    stationId?: string;
    regionBounds?: NarrativeRegionBounds;
  }): Promise<ShortTermOutlook> {
    const seed = computeSeed(`forecast:${input.stationId || JSON.stringify(input.regionBounds || {})}`);
    const high = 62 + (seed % 20);
    const low = high - (8 + (seed % 6));
    return {
      periodHours: 24,
      expectedHighF: high,
      expectedLowF: low,
      precipitationChance: Number((((seed % 80) + 10) / 100).toFixed(2)),
      dominantConditions: seed % 3 === 0 ? 'Showers' : seed % 3 === 1 ? 'Cloudy' : 'Clear',
    };
  }
}

class DefaultAlertsProvider implements AlertsProvider {
  async getActiveAlerts(): Promise<ActiveSevereWeatherAlert[]> {
    return [];
  }
}

function computeSeed(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
