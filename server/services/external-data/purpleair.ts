/**
 * PurpleAir API Client
 *
 * Fetches air quality data from PurpleAir's community sensor network.
 * Used alongside OpenAQ for cross-validation of user-submitted weather data.
 * PurpleAir sensors are consumer-grade, so readings are weighted lower than
 * OpenAQ's regulatory-grade stations (30% vs 70%).
 *
 * backend#185: Integrate OpenAQ & PurpleAir Data Sources for Validation
 */

import { weatherLogger } from '../../utils/logger.js';

// ============================================================================
// Configuration
// ============================================================================

export interface PurpleAirConfig {
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  requestsPerMinute: number;
  requestTimeoutMs: number;
}

function loadConfig(): PurpleAirConfig {
  return {
    apiKey: process.env.PURPLEAIR_API_KEY || '',
    baseUrl: process.env.PURPLEAIR_BASE_URL || 'https://api.purpleair.com',
    enabled: process.env.PURPLEAIR_ENABLED === 'true',
    requestsPerMinute: parseInt(process.env.PURPLEAIR_REQUESTS_PER_MINUTE || '1', 10),
    requestTimeoutMs: parseInt(process.env.PURPLEAIR_REQUEST_TIMEOUT_MS || '15000', 10),
  };
}

// ============================================================================
// Geohash decoding
// ============================================================================

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface GeohashBounds {
  nwLat: number;
  nwLng: number;
  seLat: number;
  seLng: number;
  centerLat: number;
  centerLng: number;
}

/**
 * Decode a geohash string to its bounding box coordinates.
 * Inverse of encodeGeoFenceGrid() from iot-gateway-geofence-service.ts.
 */
export function decodeGeohashBounds(hash: string): GeohashBounds {
  let minLat = -90;
  let maxLat = 90;
  let minLon = -180;
  let maxLon = 180;
  let isLon = true;

  for (const char of hash.toLowerCase()) {
    const idx = GEOHASH_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid geohash character: '${char}'`);
    }

    // Each character encodes 5 bits
    for (let bit = 4; bit >= 0; bit--) {
      const bitValue = (idx >> bit) & 1;

      if (isLon) {
        const mid = (minLon + maxLon) / 2;
        if (bitValue) {
          minLon = mid;
        } else {
          maxLon = mid;
        }
      } else {
        const mid = (minLat + maxLat) / 2;
        if (bitValue) {
          minLat = mid;
        } else {
          maxLat = mid;
        }
      }

      isLon = !isLon;
    }
  }

  return {
    nwLat: maxLat,
    nwLng: minLon,
    seLat: minLat,
    seLng: maxLon,
    centerLat: (minLat + maxLat) / 2,
    centerLng: (minLon + maxLon) / 2,
  };
}

// ============================================================================
// Types
// ============================================================================

export interface PurpleAirSensor {
  sensorIndex: number;
  name: string;
  latitude: number;
  longitude: number;
  pm25: number;
  humidity: number | null;
  temperatureC: number | null;
  pressure: number | null;
  lastSeen: number;
}

export interface PurpleAirHealthStatus {
  status: 'healthy' | 'unhealthy' | 'disabled';
  enabled: boolean;
  requestsThisMinute: number;
  maxRequestsPerMinute: number;
  lastCheck: string;
  error?: string;
}

export interface PurpleAirPM25Result {
  pm25: number;
  sensorCount: number;
  avgDistanceMeters: number;
  measuredAt: string;
}

// ============================================================================
// Service
// ============================================================================

export class PurpleAirService {
  private config: PurpleAirConfig;
  private requestTimestamps: number[] = [];
  private lastError: string | null = null;

  constructor(config?: Partial<PurpleAirConfig>) {
    const defaults = loadConfig();
    this.config = { ...defaults, ...config };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  // --------------------------------------------------------------------------
  // Rate limiting (1 req/min for free tier)
  // --------------------------------------------------------------------------

  private checkRateLimit(): void {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 60_000);
    if (this.requestTimestamps.length >= this.config.requestsPerMinute) {
      throw new Error(
        `PurpleAir rate limit exceeded: ${this.requestTimestamps.length}/${this.config.requestsPerMinute} requests in the last minute`,
      );
    }
    this.requestTimestamps.push(now);
  }

  // --------------------------------------------------------------------------
  // Fetch with timeout
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
        throw new Error(`PurpleAir API request failed (HTTP ${response.status})`);
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`PurpleAir API request timed out after ${this.config.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // API methods
  // --------------------------------------------------------------------------

  async getSensorsInBounds(
    nwLat: number,
    nwLng: number,
    seLat: number,
    seLng: number,
  ): Promise<PurpleAirSensor[]> {
    if (!this.config.enabled) return [];

    try {
      const fields = 'name,latitude,longitude,pm2.5,humidity,temperature,pressure,last_seen';
      const url =
        `${this.config.baseUrl}/v1/sensors?fields=${fields}` +
        `&nwlng=${nwLng}&nwlat=${nwLat}&selng=${seLng}&selat=${seLat}`;

      const response = await this.fetchWithTimeout(url);
      const data = await response.json() as {
        fields?: string[];
        data?: any[][];
      };

      if (!data.fields || !data.data) return [];

      const fieldIndex = (name: string) => data.fields!.indexOf(name);

      return data.data.map((row: any[]) => {
        const tempF = row[fieldIndex('temperature')];
        return {
          sensorIndex: row[0], // sensor_index is always first
          name: row[fieldIndex('name')] || 'Unknown',
          latitude: row[fieldIndex('latitude')] ?? 0,
          longitude: row[fieldIndex('longitude')] ?? 0,
          pm25: row[fieldIndex('pm2.5')] ?? 0,
          humidity: row[fieldIndex('humidity')] ?? null,
          temperatureC: tempF != null ? fahrenheitToCelsius(tempF) : null,
          pressure: row[fieldIndex('pressure')] ?? null,
          lastSeen: row[fieldIndex('last_seen')] ?? 0,
        };
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      weatherLogger.warn('PurpleAir getSensorsInBounds failed', {
        nwLat,
        nwLng,
        seLat,
        seLng,
        error: this.lastError,
      });
      return [];
    }
  }

  async getSensorsForGeohash(geohash: string): Promise<PurpleAirSensor[]> {
    const bounds = decodeGeohashBounds(geohash);
    return this.getSensorsInBounds(bounds.nwLat, bounds.nwLng, bounds.seLat, bounds.seLng);
  }

  async getPM25ForArea(lat: number, lon: number): Promise<PurpleAirPM25Result | null> {
    if (!this.config.enabled) return null;

    try {
      // Create ~5km bounding box around the point
      // 1 degree latitude ≈ 111km, 1 degree longitude ≈ 111km * cos(lat)
      const latDelta = 5 / 111;
      const lonDelta = 5 / (111 * Math.cos((lat * Math.PI) / 180));

      const nwLat = lat + latDelta;
      const nwLng = lon - lonDelta;
      const seLat = lat - latDelta;
      const seLng = lon + lonDelta;

      const sensors = await this.getSensorsInBounds(nwLat, nwLng, seLat, seLng);
      if (sensors.length === 0) return null;

      // Filter out stale sensors (older than 2 hours)
      const twoHoursAgo = Date.now() / 1000 - 7200;
      const fresh = sensors.filter(s => s.lastSeen > twoHoursAgo);
      if (fresh.length === 0) return null;

      // Average PM2.5 across fresh sensors
      const totalPm25 = fresh.reduce((sum, s) => sum + s.pm25, 0);
      const avgPm25 = totalPm25 / fresh.length;

      // Average distance
      const totalDist = fresh.reduce((sum, s) => {
        return sum + haversineMeters(lat, lon, s.latitude, s.longitude);
      }, 0);
      const avgDist = totalDist / fresh.length;

      // Use most recent lastSeen as the measurement time
      const mostRecent = Math.max(...fresh.map(s => s.lastSeen));

      return {
        pm25: Math.round(avgPm25 * 100) / 100,
        sensorCount: fresh.length,
        avgDistanceMeters: Math.round(avgDist),
        measuredAt: new Date(mostRecent * 1000).toISOString(),
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      weatherLogger.warn('PurpleAir getPM25ForArea failed', {
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

  getHealthStatus(): PurpleAirHealthStatus {
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

// ============================================================================
// Utilities
// ============================================================================

function fahrenheitToCelsius(f: number): number {
  return Math.round(((f - 32) * 5) / 9 * 100) / 100;
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
