/**
 * RTL-433 Data Ingestion Handler
 *
 * Processes rtl_433 JSON output from RF sensor devices.
 * Normalizes protocol-specific fields to WeatherObservation schema,
 * deduplicates, validates, and submits to the weather API.
 */

import type { Aedes, AedesPublishPacket } from 'aedes';
import type { Client } from 'aedes';
import { logger } from '../../utils/logger.js';
import type { SensorReading } from './types.js';

/**
 * Raw RTL-433 JSON from various RF weather devices.
 * Protocol detection and field mapping happens here.
 */
interface RTL433Reading {
  id?: number;
  model?: string;
  [key: string]: unknown;
}

/**
 * Normalized weather reading mapped to canonical schema.
 */
interface NormalizedWeatherReading {
  stationId: string;
  timestamp: number;
  temperature_c?: number;
  humidity_percent?: number;
  pressure_hpa?: number;
  wind_speed_ms?: number;
  wind_direction_deg?: number;
  precipitation_mm?: number;
  dewpoint_c?: number;
  source: 'rf-sdr';
  protocol: string;
  messageId?: number;
}

export class RTL433Handler {
  private deduplicationMap: Map<string, NormalizedWeatherReading> = new Map();
  private deduplicationWindowMs = 60_000; // 1 minute
  private stationGauge = new Map<string, { lat?: number; lon?: number; name?: string }>();

  constructor(private aedes: Aedes) {
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Listen on rtl_433/+/json topic
    this.aedes.on('publish', (packet: AedesPublishPacket, client: Client | null) => {
      if (!client) return;

      const topic = packet.topic;
      // Match rtl_433/{id}/json or similar patterns
      const match = topic.match(/^rtl_433\/[^/]+\/json$/i);
      if (match) {
        this.handleRTL433Data(packet, client).catch((err) => {
          logger.error('[RTL433] error processing reading', { err, topic });
        });
      }
    });
  }

  private async handleRTL433Data(
    packet: AedesPublishPacket,
    client: Client
  ): Promise<void> {
    let raw: RTL433Reading;
    try {
      raw = JSON.parse(packet.payload.toString()) as RTL433Reading;
    } catch (err) {
      logger.warn('[RTL433] malformed JSON', {
        clientId: client.id,
        topic: packet.topic,
      });
      return;
    }

    // Detect protocol and normalize
    const normalized = this.normalizeReading(raw);
    if (!normalized) {
      logger.warn('[RTL433] unsupported protocol or invalid data', { model: raw.model });
      return;
    }

    // Deduplicate
    const dedupeKey = `${normalized.stationId}:${normalized.timestamp}:${normalized.messageId || 0}`;
    if (this.isDuplicate(dedupeKey, normalized)) {
      logger.debug('[RTL433] duplicate reading, skipped', { dedupeKey });
      return;
    }

    // Validate physics constraints
    if (!this.validatePhysics(normalized)) {
      logger.warn('[RTL433] reading failed physics validation', { stationId: normalized.stationId });
      return;
    }

    // Ready to submit to backend
    logger.info('[RTL433] accepted reading', {
      stationId: normalized.stationId,
      protocol: normalized.protocol,
      temp: normalized.temperature_c,
      humidity: normalized.humidity_percent,
    });

    // Emit event for backend submission
    this.aedes.publish(
      {
        topic: `wrfcoin/weather/rtl433-ready`,
        payload: Buffer.from(JSON.stringify(normalized)),
        cmd: 'publish',
        qos: 0,
        dup: false,
        retain: false,
      } as AedesPublishPacket,
      () => {}
    );
  }

  /**
   * Detect protocol and normalize RTL-433 reading to canonical schema.
   * Supports: Acurite, Ambient Weather, Davis, Netatmo, Fine Offset.
   */
  private normalizeReading(raw: RTL433Reading): NormalizedWeatherReading | null {
    const model = (raw.model as string)?.toLowerCase() || '';
    const timestamp = Date.now(); // Use current time; RTL-433 may not include it

    // Station ID defaults to model+id
    const baseStationId = `rtl433-${model}-${raw.id || 'unknown'}`;

    // Protocol-specific normalization
    if (model.includes('acurite')) {
      return this.normalizeAcurite(raw, baseStationId, timestamp);
    } else if (model.includes('ambient') || model.includes('wh65')) {
      return this.normalizeAmbientWeather(raw, baseStationId, timestamp);
    } else if (model.includes('davis') || model.includes('vantage')) {
      return this.normalizeDavis(raw, baseStationId, timestamp);
    } else if (model.includes('netatmo') || model.includes('netatmo')) {
      return this.normalizeNetatmo(raw, baseStationId, timestamp);
    } else if (model.includes('fineoffset') || model.includes('wh1080')) {
      return this.normalizeFineOffset(raw, baseStationId, timestamp);
    }

    // Unsupported protocol
    return null;
  }

  /**
   * Acurite sensors (common RTL-433 protocol) — temperature, humidity, wind.
   * Raw fields: temp_c, humidity, wind_speed_kmh, wind_direction, etc.
   */
  private normalizeAcurite(
    raw: RTL433Reading,
    stationId: string,
    timestamp: number
  ): NormalizedWeatherReading | null {
    const temp = raw.temp_c as number | undefined;
    if (temp === undefined) return null; // Require at least temperature

    return {
      stationId,
      timestamp,
      temperature_c: temp,
      humidity_percent: (raw.humidity as number) || undefined,
      wind_speed_ms: raw.wind_speed_kmh ? ((raw.wind_speed_kmh as number) / 3.6) : undefined,
      wind_direction_deg: (raw.wind_direction as number) || undefined,
      source: 'rf-sdr',
      protocol: 'acurite',
      messageId: (raw.id as number) || undefined,
    };
  }

  /**
   * Ambient Weather sensors — temperature, humidity, wind, rain, pressure.
   * Raw fields: temp_c, humidity, windspeed_ms, wind_dir, rain_mm, pressure_hpa.
   */
  private normalizeAmbientWeather(
    raw: RTL433Reading,
    stationId: string,
    timestamp: number
  ): NormalizedWeatherReading | null {
    const temp = raw.temp_c as number | undefined;
    if (temp === undefined) return null;

    return {
      stationId,
      timestamp,
      temperature_c: temp,
      humidity_percent: (raw.humidity as number) || undefined,
      wind_speed_ms: (raw.windspeed_ms as number) || undefined,
      wind_direction_deg: (raw.wind_dir as number) || undefined,
      precipitation_mm: (raw.rain_mm as number) || undefined,
      pressure_hpa: (raw.pressure_hpa as number) || undefined,
      source: 'rf-sdr',
      protocol: 'ambient-weather',
      messageId: (raw.id as number) || undefined,
    };
  }

  /**
   * Davis weather sensors — temperature, humidity, wind, pressure, rain.
   * Raw fields: temp_c, humidity, windspeed_ms, wind_direction, pressure_hpa, rain_mm.
   */
  private normalizeDavis(
    raw: RTL433Reading,
    stationId: string,
    timestamp: number
  ): NormalizedWeatherReading | null {
    const temp = raw.temp_c as number | undefined;
    if (temp === undefined) return null;

    return {
      stationId,
      timestamp,
      temperature_c: temp,
      humidity_percent: (raw.humidity as number) || undefined,
      wind_speed_ms: (raw.windspeed_ms as number) || undefined,
      wind_direction_deg: (raw.wind_direction as number) || undefined,
      pressure_hpa: (raw.pressure_hpa as number) || undefined,
      precipitation_mm: (raw.rain_mm as number) || undefined,
      source: 'rf-sdr',
      protocol: 'davis',
      messageId: (raw.id as number) || undefined,
    };
  }

  /**
   * Netatmo sensors — temperature, humidity, pressure, CO2 (ignored).
   * Raw fields: temp_c, humidity, pressure_hpa.
   */
  private normalizeNetatmo(
    raw: RTL433Reading,
    stationId: string,
    timestamp: number
  ): NormalizedWeatherReading | null {
    const temp = raw.temp_c as number | undefined;
    if (temp === undefined) return null;

    return {
      stationId,
      timestamp,
      temperature_c: temp,
      humidity_percent: (raw.humidity as number) || undefined,
      pressure_hpa: (raw.pressure_hpa as number) || undefined,
      source: 'rf-sdr',
      protocol: 'netatmo',
      messageId: (raw.id as number) || undefined,
    };
  }

  /**
   * Fine Offset / WH1080 sensors — temperature, humidity, wind, rain, pressure.
   * Raw fields: temp_c, humidity, windspeed_ms, wind_dir, rain_mm, pressure_hpa.
   */
  private normalizeFineOffset(
    raw: RTL433Reading,
    stationId: string,
    timestamp: number
  ): NormalizedWeatherReading | null {
    const temp = raw.temp_c as number | undefined;
    if (temp === undefined) return null;

    return {
      stationId,
      timestamp,
      temperature_c: temp,
      humidity_percent: (raw.humidity as number) || undefined,
      wind_speed_ms: (raw.windspeed_ms as number) || undefined,
      wind_direction_deg: (raw.wind_dir as number) || undefined,
      precipitation_mm: (raw.rain_mm as number) || undefined,
      pressure_hpa: (raw.pressure_hpa as number) || undefined,
      source: 'rf-sdr',
      protocol: 'fine-offset',
      messageId: (raw.id as number) || undefined,
    };
  }

  /**
   * Check for duplicate readings within the deduplication window.
   * Same stationId + timestamp + messageId = duplicate.
   */
  private isDuplicate(
    key: string,
    reading: NormalizedWeatherReading
  ): boolean {
    const existing = this.deduplicationMap.get(key);
    if (!existing) {
      this.deduplicationMap.set(key, reading);
      return false;
    }

    // Check if still within deduplication window
    if (Date.now() - reading.timestamp < this.deduplicationWindowMs) {
      return true;
    }

    // Expired from window, replace with new reading
    this.deduplicationMap.set(key, reading);
    return false;
  }

  /**
   * Validate physics constraints for weather readings.
   * Ensures values are within reasonable real-world ranges.
   */
  private validatePhysics(reading: NormalizedWeatherReading): boolean {
    // Temperature: -89.2°C (Antarctica) to 70.7°C (Death Valley)
    if (reading.temperature_c !== undefined) {
      if (reading.temperature_c < -90 || reading.temperature_c > 75) {
        logger.warn('[RTL433] temperature out of range', {
          stationId: reading.stationId,
          temp: reading.temperature_c,
        });
        return false;
      }
    }

    // Humidity: 0-100%
    if (reading.humidity_percent !== undefined) {
      if (reading.humidity_percent < 0 || reading.humidity_percent > 100) {
        logger.warn('[RTL433] humidity out of range', {
          stationId: reading.stationId,
          humidity: reading.humidity_percent,
        });
        return false;
      }
    }

    // Pressure: 870-1085 hPa (sea level range)
    if (reading.pressure_hpa !== undefined) {
      if (reading.pressure_hpa < 850 || reading.pressure_hpa > 1100) {
        logger.warn('[RTL433] pressure out of range', {
          stationId: reading.stationId,
          pressure: reading.pressure_hpa,
        });
        return false;
      }
    }

    // Wind speed: 0-100 m/s (~360 km/h; hurricane force is ~80 m/s)
    if (reading.wind_speed_ms !== undefined) {
      if (reading.wind_speed_ms < 0 || reading.wind_speed_ms > 100) {
        logger.warn('[RTL433] wind speed out of range', {
          stationId: reading.stationId,
          windSpeed: reading.wind_speed_ms,
        });
        return false;
      }
    }

    // Wind direction: 0-360°
    if (reading.wind_direction_deg !== undefined) {
      if (reading.wind_direction_deg < 0 || reading.wind_direction_deg > 360) {
        logger.warn('[RTL433] wind direction out of range', {
          stationId: reading.stationId,
          windDir: reading.wind_direction_deg,
        });
        return false;
      }
    }

    // Precipitation: 0-1000 mm (reasonable daily rain)
    if (reading.precipitation_mm !== undefined) {
      if (reading.precipitation_mm < 0 || reading.precipitation_mm > 1000) {
        logger.warn('[RTL433] precipitation out of range', {
          stationId: reading.stationId,
          precip: reading.precipitation_mm,
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Register a station's location for enhanced identification.
   */
  registerStation(
    stationId: string,
    location?: { lat?: number; lon?: number; name?: string }
  ): void {
    if (location) {
      this.stationGauge.set(stationId, location);
    }
  }
}
