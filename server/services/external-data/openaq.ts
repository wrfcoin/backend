/**
 * OpenAQ v3 API Client
 *
 * Fetches air quality reference data from OpenAQ's network of regulatory-grade
 * monitoring stations. Used for async validation of user-submitted airQuality
 * values in the weather ingestion pipeline.
 *
 * backend#185: Integrate OpenAQ & PurpleAir Data Sources for Validation
 */

import { weatherLogger } from '../../utils/logger.js';

// ============================================================================
// Configuration
// ============================================================================

export interface OpenAQConfig {
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  requestsPerMinute: number;
  requestTimeoutMs: number;
  searchRadiusMeters: number;
}

function loadConfig(): OpenAQConfig {
  return {
    apiKey: process.env.OPENAQ_API_KEY || '',
    baseUrl: process.env.OPENAQ_BASE_URL || 'https://api.openaq.org/v3',
    enabled: process.env.OPENAQ_ENABLED === 'true',
    requestsPerMinute: parseInt(process.env.OPENAQ_REQUESTS_PER_MINUTE || '120', 10),
    requestTimeoutMs: parseInt(process.env.OPENAQ_REQUEST_TIMEOUT_MS || '15000', 10),
    searchRadiusMeters: parseInt(process.env.OPENAQ_RADIUS_KM || '25', 10) * 1000,
  };
}

// ============================================================================
// Types
// ============================================================================

export interface OpenAQLocation {
  id: number;
  name: string;
  coordinates: { latitude: number; longitude: number };
  country: string | null;
  parameters: OpenAQParameter[];
  lastUpdated: string | null;
  distance?: number;
}

export interface OpenAQParameter {
  id: number;
  name: string;
  unit: string;
  lastValue: number;
  lastUpdated: string;
}

export interface OpenAQMeasurement {
  locationId: number;
  parameter: string;
  value: number;
  unit: string;
  date: { utc: string; local: string };
}

export interface OpenAQHealthStatus {
  status: 'healthy' | 'unhealthy' | 'disabled';
  enabled: boolean;
  requestsThisMinute: number;
  maxRequestsPerMinute: number;
  lastCheck: string;
  error?: string;
}

export interface OpenAQPM25Result {
  pm25: number;
  stationId: number;
  stationName: string;
  distanceMeters: number;
  measuredAt: string;
}

// ============================================================================
// Service
// ============================================================================

export class OpenAQService {
  private config: OpenAQConfig;
  private requestTimestamps: number[] = [];
  private lastError: string | null = null;

  constructor(config?: Partial<OpenAQConfig>) {
    const defaults = loadConfig();
    this.config = { ...defaults, ...config };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  private checkRateLimit(): void {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 60_000);
    if (this.requestTimestamps.length >= this.config.requestsPerMinute) {
      throw new Error(
        `OpenAQ rate limit exceeded: ${this.requestTimestamps.length}/${this.config.requestsPerMinute} requests in the last minute`,
      );
    }
    this.requestTimestamps.push(now);
  }

  // --------------------------------------------------------------------------
  // Fetch with timeout (AbortController pattern from live-weather-fetcher.ts)
  // --------------------------------------------------------------------------

  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
  ): Promise<Response> {
    this.checkRateLimit();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(this.config.apiKey ? { 'X-API-Key': this.config.apiKey } : {}),
      ...(options.headers as Record<string, string> || {}),
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const statusMessage = this.mapStatusError(response.status);
        throw new Error(`OpenAQ API ${statusMessage} (HTTP ${response.status})`);
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OpenAQ API request timed out after ${this.config.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  private mapStatusError(status: number): string {
    switch (status) {
      case 401: return 'unauthorized — check OPENAQ_API_KEY';
      case 404: return 'location not found';
      case 429: return 'rate limited by upstream';
      case 500: return 'server error';
      case 503: return 'temporarily unavailable';
      default: return 'request failed';
    }
  }

  // --------------------------------------------------------------------------
  // API methods
  // --------------------------------------------------------------------------

  async findNearbyLocations(lat: number, lon: number): Promise<OpenAQLocation[]> {
    if (!this.config.enabled) return [];

    try {
      const url = `${this.config.baseUrl}/locations?coordinates=${lat},${lon}&radius=${this.config.searchRadiusMeters}&limit=10`;
      const response = await this.fetchWithTimeout(url);
      const data = await response.json() as { results?: any[] };

      if (!data.results || !Array.isArray(data.results)) return [];

      return data.results.map((loc: any) => ({
        id: loc.id,
        name: loc.name || 'Unknown',
        coordinates: {
          latitude: loc.coordinates?.latitude ?? lat,
          longitude: loc.coordinates?.longitude ?? lon,
        },
        country: loc.country?.code ?? null,
        parameters: (loc.parameters || []).map((p: any) => ({
          id: p.id,
          name: p.name || p.parameter,
          unit: p.unit,
          lastValue: p.lastValue ?? p.latest?.value ?? 0,
          lastUpdated: p.lastUpdated || p.latest?.datetime?.utc || '',
        })),
        lastUpdated: loc.lastUpdated || loc.datetimeLast?.utc || null,
        distance: loc.distance ?? undefined,
      }));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      weatherLogger.warn('OpenAQ findNearbyLocations failed', {
        lat,
        lon,
        error: this.lastError,
      });
      return [];
    }
  }

  async getLatestMeasurements(locationId: number): Promise<OpenAQMeasurement[]> {
    if (!this.config.enabled) return [];

    try {
      const url = `${this.config.baseUrl}/locations/${locationId}/latest`;
      const response = await this.fetchWithTimeout(url);
      const data = await response.json() as { results?: any[] };

      if (!data.results || !Array.isArray(data.results)) return [];

      return data.results.map((m: any) => ({
        locationId,
        parameter: m.parameter || m.name || '',
        value: m.value ?? m.lastValue ?? 0,
        unit: m.unit || '',
        date: {
          utc: m.date?.utc || m.datetime?.utc || m.lastUpdated || '',
          local: m.date?.local || m.datetime?.local || '',
        },
      }));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      weatherLogger.warn('OpenAQ getLatestMeasurements failed', {
        locationId,
        error: this.lastError,
      });
      return [];
    }
  }

  async getPM25ForArea(lat: number, lon: number): Promise<OpenAQPM25Result | null> {
    if (!this.config.enabled) return null;

    try {
      const locations = await this.findNearbyLocations(lat, lon);
      if (locations.length === 0) return null;

      // Sort by distance if available, otherwise use first
      const sorted = locations
        .filter(loc => loc.parameters.some(p => p.name === 'pm25' || p.name === 'pm2.5'))
        .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

      if (sorted.length === 0) return null;

      const closest = sorted[0];

      // Try inline parameter value first
      const pm25Param = closest.parameters.find(
        p => p.name === 'pm25' || p.name === 'pm2.5',
      );
      if (pm25Param && pm25Param.lastValue > 0) {
        return {
          pm25: pm25Param.lastValue,
          stationId: closest.id,
          stationName: closest.name,
          distanceMeters: closest.distance ?? 0,
          measuredAt: pm25Param.lastUpdated || closest.lastUpdated || new Date().toISOString(),
        };
      }

      // Fall back to latest measurements endpoint
      const measurements = await this.getLatestMeasurements(closest.id);
      const pm25Measurement = measurements.find(
        m => m.parameter === 'pm25' || m.parameter === 'pm2.5',
      );
      if (!pm25Measurement) return null;

      return {
        pm25: pm25Measurement.value,
        stationId: closest.id,
        stationName: closest.name,
        distanceMeters: closest.distance ?? 0,
        measuredAt: pm25Measurement.date.utc || new Date().toISOString(),
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      weatherLogger.warn('OpenAQ getPM25ForArea failed', {
        lat,
        lon,
        error: this.lastError,
      });
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  getHealthStatus(): OpenAQHealthStatus {
    const now = Date.now();
    const recentRequests = this.requestTimestamps.filter(t => now - t < 60_000);

    if (!this.config.enabled) {
      return {
        status: 'disabled',
        enabled: false,
        requestsThisMinute: 0,
        maxRequestsPerMinute: this.config.requestsPerMinute,
        lastCheck: new Date().toISOString(),
      };
    }

    return {
      status: this.lastError ? 'unhealthy' : 'healthy',
      enabled: true,
      requestsThisMinute: recentRequests.length,
      maxRequestsPerMinute: this.config.requestsPerMinute,
      lastCheck: new Date().toISOString(),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}
