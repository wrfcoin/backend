/**
 * Meshtastic Observation Validation Service
 *
 * Implements the validation pipeline for weather observations from LoRa mesh nodes.
 * Handles schema validation, registration checks, spatial-temporal consistency,
 * and quality score calculation.
 */

import { eq, and, desc, gte, sql } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import {
  meshtasticNodes,
  meshtasticObservations,
  type MeshtasticNode,
} from './schema-meshtastic.js';
import { requiresManualReview, type GeoFenceReviewStatus } from './iot-gateway-geofence-service.js';

// ============================================================================
// Type Definitions
// ============================================================================

export interface ParsedObservation {
  nodeId: string;
  timestamp: Date;
  lat: number;
  lon: number;
  alt?: number;
  tmp?: number; // temperature in Celsius
  hum?: number; // humidity percentage
  prs?: number; // pressure in hPa
  bat?: number; // battery percentage
  lux?: number; // light in lux
  pm25?: number;
  pm10?: number;
  voc?: number;
  co2?: number;
}

export interface MeshContext {
  rssi?: number;
  snr?: number;
  hopCount?: number;
  neighborCount?: number;
}

export interface NodeInfo {
  nodeId: number;
  meshtasticNodeId: string;
  wrfcoinAddress: string | null;
  isRegistered: boolean;
  geoFenceStatus: GeoFenceReviewStatus;
  reputationScore: number;
  location: { lat: number; lon: number; alt?: number } | null;
}

export interface SchemaCheckResult {
  passed: boolean;
  errors: string[];
}

export interface RegistrationCheckResult {
  passed: boolean;
  isRegistered: boolean;
  wrfcoinAddress: string | null;
}

export interface SpatialCheckResult {
  passed: boolean;
  score: number;
  neighbors: number;
  avgNeighborTemp?: number;
  tempDeviation?: number;
}

export interface TemporalCheckResult {
  passed: boolean;
  score: number;
  previousObservationDelta: number | null;
  tempDelta?: number;
  maxAllowedDelta?: number;
}

export interface ValidationDetails {
  schemaValidation: SchemaCheckResult;
  registrationCheck: RegistrationCheckResult;
  spatialConsistency: SpatialCheckResult;
  temporalConsistency: TemporalCheckResult;
  meshContextScore: number;
}

export interface ValidationResult {
  isValid: boolean;
  qualityScore: number;
  validationStatus: 'valid' | 'invalid' | 'suspicious' | 'pending';
  details: ValidationDetails;
  nodeInfo: NodeInfo | null;
}

// ============================================================================
// Validation Service
// ============================================================================

export class MeshtasticValidationService {
  private db: NeonDatabase<any>;

  // Quality score weights (must sum to 1.0)
  private readonly QUALITY_WEIGHTS = {
    schemaValidity: 0.2,
    registrationStatus: 0.15,
    spatialConsistency: 0.25,
    temporalConsistency: 0.25,
    meshContext: 0.15,
  };

  // Thresholds for consistency checks
  private readonly TEMPORAL_MAX_DELTA_TEMP = 10; // Max 10C change per hour
  private readonly TEMPORAL_MAX_DELTA_PRESSURE = 5; // Max 5 hPa change per hour
  private readonly SPATIAL_MAX_NEIGHBOR_DISTANCE_KM = 50;
  private readonly SPATIAL_MIN_NEIGHBORS_FOR_CONSENSUS = 2;

  constructor(db: NeonDatabase<any>) {
    this.db = db;
  }

  /**
   * Main validation entry point.
   * Runs all validation checks and calculates quality score.
   */
  async validateObservation(
    observation: ParsedObservation,
    meshContext?: MeshContext
  ): Promise<ValidationResult> {
    // Step 1: Get or create node record
    const nodeInfo = await this.getOrCreateNode(observation.nodeId);

    // Step 2: Schema validation (physics-based)
    const schemaValidation = this.validatePhysics(observation);

    // Step 3: Registration check
    const registrationCheck: RegistrationCheckResult = {
      passed: nodeInfo.isRegistered,
      isRegistered: nodeInfo.isRegistered,
      wrfcoinAddress: nodeInfo.wrfcoinAddress,
    };

    // Step 4: Temporal consistency (compare with previous observations)
    const temporalConsistency = await this.checkTemporalConsistency(
      observation,
      observation.nodeId
    );

    // Step 5: Spatial consistency (compare with nearby nodes)
    const spatialConsistency = await this.checkSpatialConsistency(
      observation,
      nodeInfo.location || { lat: observation.lat, lon: observation.lon }
    );

    // Step 6: Mesh context score
    const meshContextScore = this.calculateMeshContextScore(meshContext);

    // Build validation details
    const details: ValidationDetails = {
      schemaValidation,
      registrationCheck,
      spatialConsistency,
      temporalConsistency,
      meshContextScore,
    };

    // Calculate overall quality score
    const qualityScore = this.calculateOverallQualityScore(details);

    // Determine validation status
    const validationStatus = this.determineValidationStatus(details, qualityScore, nodeInfo);

    return {
      isValid: validationStatus === 'valid',
      qualityScore,
      validationStatus,
      details,
      nodeInfo,
    };
  }

  /**
   * Get existing node or create a new unregistered node.
   * This handles the Task 111 dependency gracefully.
   */
  async getOrCreateNode(meshtasticNodeId: string): Promise<NodeInfo> {
    // Try to find existing node
    const existingNodes = await this.db
      .select()
      .from(meshtasticNodes)
      .where(eq(meshtasticNodes.meshtasticNodeId, meshtasticNodeId))
      .limit(1);

    let node: MeshtasticNode;

    if (existingNodes.length === 0) {
      // Auto-create as unregistered node
      const [newNode] = await this.db
        .insert(meshtasticNodes)
        .values({
          meshtasticNodeId,
          isRegistered: false,
          reputationScore: '50.00', // Starting reputation
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      node = newNode;
    } else {
      node = existingNodes[0];
    }

    // Update lastSeenAt
    await this.db
      .update(meshtasticNodes)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(meshtasticNodes.id, node.id));

    return {
      nodeId: node.id,
      meshtasticNodeId: node.meshtasticNodeId,
      wrfcoinAddress: node.wrfcoinAddress,
      isRegistered: node.isRegistered,
      geoFenceStatus: node.geoFenceStatus as GeoFenceReviewStatus,
      reputationScore: parseFloat(node.reputationScore || '50'),
      location: node.location as { lat: number; lon: number; alt?: number } | null,
    };
  }

  /**
   * Physics-based validation extending the Zod schema checks.
   * Validates cross-field relationships that can't be caught by simple range checks.
   */
  private validatePhysics(observation: ParsedObservation): SchemaCheckResult {
    const errors: string[] = [];

    // Altitude-pressure relationship (simplified barometric formula)
    if (observation.alt !== undefined && observation.prs !== undefined) {
      const expectedPressure =
        1013.25 * Math.pow(1 - (0.0065 * observation.alt) / 288.15, 5.255);
      const pressureDiff = Math.abs(observation.prs - expectedPressure);
      if (pressureDiff > 50) {
        errors.push(
          `Pressure ${observation.prs} hPa inconsistent with altitude ${observation.alt}m (expected ~${expectedPressure.toFixed(1)} hPa)`
        );
      }
    }

    // Temperature-humidity plausibility
    if (observation.tmp !== undefined && observation.hum !== undefined) {
      if (observation.tmp > 45 && observation.hum > 95) {
        errors.push(
          `Unlikely: high temperature (${observation.tmp}C) with very high humidity (${observation.hum}%)`
        );
      }
      if (observation.tmp < -30 && observation.hum > 80) {
        errors.push(
          `Unlikely: very low temperature (${observation.tmp}C) with high humidity (${observation.hum}%)`
        );
      }
    }

    // Air quality sanity checks
    if (observation.pm25 !== undefined && observation.pm10 !== undefined) {
      if (observation.pm25 > observation.pm10 * 1.2) {
        // PM2.5 should generally be <= PM10
        errors.push(
          `PM2.5 (${observation.pm25}) significantly higher than PM10 (${observation.pm10})`
        );
      }
    }

    // Location sanity check
    if (
      Math.abs(observation.lat) > 90 ||
      Math.abs(observation.lon) > 180
    ) {
      errors.push(
        `Invalid coordinates: lat=${observation.lat}, lon=${observation.lon}`
      );
    }

    return {
      passed: errors.length === 0,
      errors,
    };
  }

  /**
   * Check temporal consistency with previous observations from the same node.
   */
  private async checkTemporalConsistency(
    observation: ParsedObservation,
    meshtasticNodeId: string
  ): Promise<TemporalCheckResult> {
    // Get last valid observation from this node
    const lastObservations = await this.db
      .select()
      .from(meshtasticObservations)
      .where(
        and(
          eq(meshtasticObservations.meshtasticNodeId, meshtasticNodeId),
          eq(meshtasticObservations.validationStatus, 'valid')
        )
      )
      .orderBy(desc(meshtasticObservations.timestamp))
      .limit(1);

    if (lastObservations.length === 0) {
      // No historical data to compare - neutral score
      return { passed: true, score: 70, previousObservationDelta: null };
    }

    const lastObservation = lastObservations[0];
    const hoursDelta =
      (observation.timestamp.getTime() - lastObservation.timestamp.getTime()) /
      (1000 * 60 * 60);

    // Reject if timestamp is in the past relative to last observation
    if (hoursDelta <= 0) {
      return {
        passed: false,
        score: 0,
        previousObservationDelta: hoursDelta,
      };
    }

    // Compare temperature
    const lastEnv = lastObservation.environment as {
      temperatureC?: number;
      pressureHpa?: number;
    } | null;

    if (!lastEnv || observation.tmp === undefined) {
      return { passed: true, score: 70, previousObservationDelta: hoursDelta };
    }

    const tempDelta = Math.abs(
      observation.tmp - (lastEnv.temperatureC || 0)
    );
    const maxAllowedDelta = this.TEMPORAL_MAX_DELTA_TEMP * Math.max(hoursDelta, 1);

    let score = 100;
    let passed = true;

    if (tempDelta > maxAllowedDelta * 2) {
      score = 20;
      passed = false; // Extreme change - likely invalid
    } else if (tempDelta > maxAllowedDelta) {
      score = 50;
      passed = true; // Suspicious but not rejected
    } else if (tempDelta > maxAllowedDelta * 0.5) {
      score = 80;
    }

    return {
      passed,
      score,
      previousObservationDelta: hoursDelta,
      tempDelta,
      maxAllowedDelta,
    };
  }

  /**
   * Check spatial consistency with observations from nearby nodes.
   */
  private async checkSpatialConsistency(
    observation: ParsedObservation,
    nodeLocation: { lat: number; lon: number }
  ): Promise<SpatialCheckResult> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Find observations from nearby nodes in the last hour
    // Using Haversine formula for distance calculation
    const nearbyResult = await this.db.execute(sql`
      SELECT
        environment,
        timestamp,
        meshtastic_node_id,
        (
          6371 * acos(
            LEAST(1.0, GREATEST(-1.0,
              cos(radians(${nodeLocation.lat})) * cos(radians((location->>'lat')::float))
              * cos(radians((location->>'lon')::float) - radians(${nodeLocation.lon}))
              + sin(radians(${nodeLocation.lat})) * sin(radians((location->>'lat')::float))
            ))
          )
        ) as distance_km
      FROM meshtastic_observations
      WHERE timestamp > ${oneHourAgo}
        AND validation_status = 'valid'
        AND meshtastic_node_id != ${observation.nodeId}
        AND location IS NOT NULL
        AND location->>'lat' IS NOT NULL
        AND location->>'lon' IS NOT NULL
      ORDER BY distance_km
      LIMIT 20
    `);

    // Filter to neighbors within distance threshold
    const neighbors = (nearbyResult.rows as any[]).filter(
      (r) => r.distance_km !== null && r.distance_km < this.SPATIAL_MAX_NEIGHBOR_DISTANCE_KM
    );

    if (neighbors.length < this.SPATIAL_MIN_NEIGHBORS_FOR_CONSENSUS) {
      // No consensus possible - neutral score
      return { passed: true, score: 70, neighbors: 0 };
    }

    // Calculate temperature deviation from neighbors
    const neighborTemps = neighbors
      .map((r) => (r.environment as any)?.temperatureC)
      .filter((t): t is number => t !== undefined && t !== null);

    if (neighborTemps.length === 0 || observation.tmp === undefined) {
      return { passed: true, score: 70, neighbors: 0 };
    }

    const avgNeighborTemp =
      neighborTemps.reduce((a, b) => a + b, 0) / neighborTemps.length;
    const tempDeviation = Math.abs(observation.tmp - avgNeighborTemp);

    // Score based on deviation
    let score = 100;
    let passed = true;

    if (tempDeviation > 10) {
      score = 30;
      passed = false; // Significant deviation - likely invalid
    } else if (tempDeviation > 5) {
      score = 60;
    } else if (tempDeviation > 2) {
      score = 80;
    }

    return {
      passed,
      score,
      neighbors: neighborTemps.length,
      avgNeighborTemp,
      tempDeviation,
    };
  }

  /**
   * Calculate mesh context score based on signal quality and network topology.
   */
  private calculateMeshContextScore(meshContext?: MeshContext): number {
    if (!meshContext) return 50; // Neutral if no context

    let score = 50; // Base score

    // RSSI quality (-50 to -120 dBm, higher/less negative is better)
    if (meshContext.rssi !== undefined) {
      if (meshContext.rssi > -70) score += 20;
      else if (meshContext.rssi > -90) score += 10;
      else if (meshContext.rssi < -110) score -= 10;
    }

    // SNR quality (typical range -20 to +10 dB, higher is better)
    if (meshContext.snr !== undefined) {
      if (meshContext.snr > 5) score += 15;
      else if (meshContext.snr > 0) score += 10;
      else if (meshContext.snr < -10) score -= 10;
    }

    // Neighbor count (more neighbors = more reliable mesh position)
    if (meshContext.neighborCount !== undefined) {
      if (meshContext.neighborCount >= 5) score += 15;
      else if (meshContext.neighborCount >= 2) score += 10;
      else if (meshContext.neighborCount === 0) score -= 15;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate overall quality score from all validation components.
   */
  private calculateOverallQualityScore(details: ValidationDetails): number {
    let score = 0;

    // Schema validity (20%)
    score +=
      (details.schemaValidation.passed ? 100 : 0) *
      this.QUALITY_WEIGHTS.schemaValidity;

    // Registration status (15%) - registered nodes get full points, unregistered get 50%
    const registrationScore = details.registrationCheck.isRegistered ? 100 : 50;
    score += registrationScore * this.QUALITY_WEIGHTS.registrationStatus;

    // Spatial consistency (25%)
    score +=
      details.spatialConsistency.score * this.QUALITY_WEIGHTS.spatialConsistency;

    // Temporal consistency (25%)
    score +=
      details.temporalConsistency.score * this.QUALITY_WEIGHTS.temporalConsistency;

    // Mesh context (15%)
    score += details.meshContextScore * this.QUALITY_WEIGHTS.meshContext;

    return Math.round(score);
  }

  /**
   * Determine validation status based on validation details and quality score.
   */
  private determineValidationStatus(
    details: ValidationDetails,
    qualityScore: number,
    nodeInfo: NodeInfo
  ): 'valid' | 'invalid' | 'suspicious' | 'pending' {
    // Invalid if schema validation failed
    if (!details.schemaValidation.passed) {
      return 'invalid';
    }

    // Invalid if extreme temporal inconsistency (score = 0)
    if (details.temporalConsistency.score === 0) {
      return 'invalid';
    }

    // Invalid if extreme spatial inconsistency
    if (!details.spatialConsistency.passed && details.spatialConsistency.neighbors >= 3) {
      return 'invalid';
    }

    if (requiresManualReview(nodeInfo.geoFenceStatus)) {
      return 'suspicious';
    }

    // Suspicious if unregistered or low quality score
    if (!details.registrationCheck.isRegistered || qualityScore < 50) {
      return 'suspicious';
    }

    // Suspicious if moderate inconsistencies
    if (qualityScore < 70) {
      return 'suspicious';
    }

    return 'valid';
  }
}
