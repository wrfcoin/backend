/**
 * Meshtastic Observation Parser
 *
 * Parses compact LoRa observation format to enriched format.
 * Handles field expansion, timestamp normalization, and mesh context enrichment.
 */

import {
  type ObsBody,
  type EnrichedObservation,
  type MeshContext,
  obsBodySchema,
} from './meshtastic-payload-types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Expanded fields from compact observation body.
 */
export interface ExpandedFields {
  environment: {
    temperatureC?: number;
    humidityPct?: number;
    pressureHpa?: number;
    lightLux?: number;
  };
  airQuality?: {
    pm2_5?: number;
    pm10?: number;
    vocIndex?: number;
    co2EqPpm?: number;
  };
  deviceMetrics?: {
    batteryPct?: number;
    batteryVoltage?: number;
    uptimeSeconds?: number;
  };
  location: {
    lat?: number;
    lon?: number;
    alt?: number;
  };
  timestamp: Date;
}

/**
 * Parse result with optional validation errors.
 */
export interface ParseResult {
  success: boolean;
  observation?: EnrichedObservation;
  errors?: Array<{
    field: string;
    message: string;
  }>;
}

// ============================================================================
// Observation Parser
// ============================================================================

/**
 * Parser for compact LoRa observations to enriched format.
 */
export class ObservationParser {
  /**
   * Parse compact LoRa observation to enriched format.
   *
   * @param nodeId - Meshtastic node ID
   * @param body - Compact observation body
   * @param meshContext - Optional mesh network context
   * @param schemaVersion - Schema version from payload envelope
   * @returns Enriched observation with expanded fields
   */
  static parseCompact(
    nodeId: string,
    body: ObsBody,
    meshContext?: MeshContext,
    schemaVersion = 1
  ): EnrichedObservation {
    const expanded = this.expandKeys(body);

    // Validate that we have at least lat/lon for location
    const location = {
      lat: expanded.location.lat ?? 0,
      lon: expanded.location.lon ?? 0,
      alt: expanded.location.alt,
    };

    // Build enriched observation
    const observation: EnrichedObservation = {
      nodeId,
      timestamp: this.normalizeTimestamp(body.ts),
      location,
      environment: expanded.environment,
      schemaVersion,
    };

    // Add optional sections only if they have data
    if (this.hasAirQualityData(expanded.airQuality)) {
      observation.airQuality = expanded.airQuality;
    }

    if (this.hasDeviceMetrics(expanded.deviceMetrics)) {
      observation.deviceMetrics = expanded.deviceMetrics;
    }

    if (meshContext) {
      observation.meshContext = meshContext;
    }

    return observation;
  }

  /**
   * Parse with validation - returns result object instead of throwing.
   *
   * @param nodeId - Meshtastic node ID
   * @param body - Body to parse (will be validated)
   * @param meshContext - Optional mesh network context
   * @param schemaVersion - Schema version from payload envelope
   * @returns Parse result with observation or errors
   */
  static parseWithValidation(
    nodeId: string,
    body: unknown,
    meshContext?: MeshContext,
    schemaVersion = 1
  ): ParseResult {
    const validationResult = obsBodySchema.safeParse(body);

    if (!validationResult.success) {
      return {
        success: false,
        errors: validationResult.error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      };
    }

    // Type assertion is safe here because Zod validation ensures ts is present
    const observation = this.parseCompact(nodeId, validationResult.data as ObsBody, meshContext, schemaVersion);

    return {
      success: true,
      observation,
    };
  }

  /**
   * Expand compact field names to full field names.
   *
   * Field mappings:
   * - ts -> timestamp
   * - lat/lon/alt -> location
   * - tmp -> temperatureC
   * - hum -> humidityPct
   * - prs -> pressureHpa
   * - lux -> lightLux
   * - pm25 -> pm2_5
   * - pm10 -> pm10
   * - voc -> vocIndex
   * - co2 -> co2EqPpm
   * - bat -> batteryPct
   * - batV -> batteryVoltage
   * - upt -> uptimeSeconds
   *
   * @param compact - Compact observation body
   * @returns Expanded fields structure
   */
  static expandKeys(compact: ObsBody): ExpandedFields {
    return {
      environment: {
        temperatureC: compact.tmp,
        humidityPct: compact.hum,
        pressureHpa: compact.prs,
        lightLux: compact.lux,
      },
      airQuality: {
        pm2_5: compact.pm25,
        pm10: compact.pm10,
        vocIndex: compact.voc,
        co2EqPpm: compact.co2,
      },
      deviceMetrics: {
        batteryPct: compact.bat,
        batteryVoltage: compact.batV,
        uptimeSeconds: compact.upt,
      },
      location: {
        lat: compact.lat,
        lon: compact.lon,
        alt: compact.alt,
      },
      timestamp: new Date(compact.ts * 1000),
    };
  }

  /**
   * Convert Unix timestamp (seconds) to ISO 8601 string.
   *
   * @param ts - Unix timestamp in seconds
   * @returns ISO 8601 formatted timestamp string
   */
  static normalizeTimestamp(ts: number): string {
    return new Date(ts * 1000).toISOString();
  }

  /**
   * Convert ISO 8601 string to Unix timestamp (seconds).
   *
   * @param iso - ISO 8601 formatted timestamp string
   * @returns Unix timestamp in seconds
   */
  static toUnixTimestamp(iso: string): number {
    return Math.floor(new Date(iso).getTime() / 1000);
  }

  /**
   * Compact an enriched observation back to LoRa format.
   * Useful for re-transmitting or storing in compact form.
   *
   * @param observation - Enriched observation to compact
   * @returns Compact observation body
   */
  static compactKeys(observation: EnrichedObservation): ObsBody {
    const body: ObsBody = {
      ts: this.toUnixTimestamp(observation.timestamp),
    };

    // Location
    if (observation.location.lat !== undefined) body.lat = observation.location.lat;
    if (observation.location.lon !== undefined) body.lon = observation.location.lon;
    if (observation.location.alt !== undefined) body.alt = observation.location.alt;

    // Environment
    if (observation.environment.temperatureC !== undefined) body.tmp = observation.environment.temperatureC;
    if (observation.environment.humidityPct !== undefined) body.hum = observation.environment.humidityPct;
    if (observation.environment.pressureHpa !== undefined) body.prs = observation.environment.pressureHpa;
    if (observation.environment.lightLux !== undefined) body.lux = observation.environment.lightLux;

    // Air quality
    if (observation.airQuality?.pm2_5 !== undefined) body.pm25 = observation.airQuality.pm2_5;
    if (observation.airQuality?.pm10 !== undefined) body.pm10 = observation.airQuality.pm10;
    if (observation.airQuality?.vocIndex !== undefined) body.voc = observation.airQuality.vocIndex;
    if (observation.airQuality?.co2EqPpm !== undefined) body.co2 = observation.airQuality.co2EqPpm;

    // Device metrics
    if (observation.deviceMetrics?.batteryPct !== undefined) body.bat = observation.deviceMetrics.batteryPct;
    if (observation.deviceMetrics?.batteryVoltage !== undefined) body.batV = observation.deviceMetrics.batteryVoltage;
    if (observation.deviceMetrics?.uptimeSeconds !== undefined) body.upt = observation.deviceMetrics.uptimeSeconds;

    return body;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Check if air quality object has any data.
   */
  private static hasAirQualityData(
    airQuality?: ExpandedFields['airQuality']
  ): airQuality is NonNullable<ExpandedFields['airQuality']> {
    if (!airQuality) return false;
    return (
      airQuality.pm2_5 !== undefined ||
      airQuality.pm10 !== undefined ||
      airQuality.vocIndex !== undefined ||
      airQuality.co2EqPpm !== undefined
    );
  }

  /**
   * Check if device metrics object has any data.
   */
  private static hasDeviceMetrics(
    deviceMetrics?: ExpandedFields['deviceMetrics']
  ): deviceMetrics is NonNullable<ExpandedFields['deviceMetrics']> {
    if (!deviceMetrics) return false;
    return (
      deviceMetrics.batteryPct !== undefined ||
      deviceMetrics.batteryVoltage !== undefined ||
      deviceMetrics.uptimeSeconds !== undefined
    );
  }
}

// ============================================================================
// Convenience Exports
// ============================================================================

/**
 * Parse a WRFCoin observation payload body to enriched format.
 * Convenience wrapper around ObservationParser.parseCompact().
 *
 * @param nodeId - Meshtastic node ID
 * @param body - Compact observation body (validated)
 * @param meshContext - Optional mesh context
 * @returns Enriched observation
 */
export function parseWrfObservation(
  nodeId: string,
  body: ObsBody,
  meshContext?: MeshContext
): EnrichedObservation {
  return ObservationParser.parseCompact(nodeId, body, meshContext);
}

/**
 * Expand compact observation body fields.
 * Convenience wrapper around ObservationParser.expandKeys().
 *
 * @param body - Compact observation body
 * @returns Expanded fields structure
 */
export function expandObservationFields(body: ObsBody): ExpandedFields {
  return ObservationParser.expandKeys(body);
}
