/**
 * Meshtastic Database Helper Functions
 *
 * Provides utility functions for querying meshtastic-related database tables.
 * Used by the validation service and admin endpoints.
 */

import { eq, and, desc, gte, sql, inArray } from 'drizzle-orm';
import { db } from '../database/db.js';
import {
  meshtasticNodes,
  meshtasticGateways,
  meshtasticObservations,
  meshtasticRegistrationNonces,
  type MeshtasticNode,
  type MeshtasticGateway,
  type MeshtasticObservation,
} from './schema-meshtastic.js';
import type {
  GeoFenceLocation,
  GeoFenceReviewStatus,
} from './iot-gateway-geofence-service.js';

// ============================================================================
// Node Helpers
// ============================================================================

/**
 * Find a node by its database ID.
 */
export async function findNodeById(nodeId: number): Promise<MeshtasticNode | null> {
  const nodes = await db
    .select()
    .from(meshtasticNodes)
    .where(eq(meshtasticNodes.id, nodeId))
    .limit(1);
  return nodes[0] || null;
}

/**
 * Find a node by its Meshtastic node ID.
 */
export async function findNodeByMeshtasticId(
  meshtasticNodeId: string
): Promise<MeshtasticNode | null> {
  const nodes = await db
    .select()
    .from(meshtasticNodes)
    .where(eq(meshtasticNodes.meshtasticNodeId, meshtasticNodeId))
    .limit(1);
  return nodes[0] || null;
}

/**
 * Get all registered nodes.
 */
export async function getRegisteredNodes(): Promise<MeshtasticNode[]> {
  return db
    .select()
    .from(meshtasticNodes)
    .where(eq(meshtasticNodes.isRegistered, true))
    .orderBy(desc(meshtasticNodes.lastSeenAt));
}

// ============================================================================
// Node Registration Lookup Helpers (Task 111)
// ============================================================================

/**
 * Registration info returned from lookup functions.
 */
export interface RegisteredNodeInfo {
  wrfcoinAddress: string;
  isRegistered: true;
  registeredAt: Date;
  meshtasticNodeId: string;
  hardwareModel: string | null;
  firmwareVersion: string | null;
  geoFenceStatus: GeoFenceReviewStatus;
  geoFenceGrid: string | null;
  geoFenceBurstCount: number;
}

export class RegistrationNonceAlreadyUsedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationNonceAlreadyUsedError';
  }
}

function resolveGeoFenceStatusForUpdate(
  existingStatus: GeoFenceReviewStatus | null,
  incomingStatus: GeoFenceReviewStatus | undefined,
): GeoFenceReviewStatus {
  const baseline = existingStatus ?? 'clear';
  if (!incomingStatus) {
    return baseline;
  }

  // Never downgrade an explicit hold/rejection via self re-registration.
  if (baseline === 'rejected' && incomingStatus !== 'rejected') {
    return 'rejected';
  }
  if (
    baseline === 'manual_review_required' &&
    (incomingStatus === 'clear' || incomingStatus === 'approved')
  ) {
    return 'manual_review_required';
  }

  return incomingStatus;
}

/**
 * Get registered node by Meshtastic ID.
 * Returns null if node doesn't exist or isn't registered.
 */
export async function getRegisteredNode(
  meshtasticNodeId: string
): Promise<RegisteredNodeInfo | null> {
  const nodes = await db
    .select()
    .from(meshtasticNodes)
    .where(
      and(
        eq(meshtasticNodes.meshtasticNodeId, meshtasticNodeId),
        eq(meshtasticNodes.isRegistered, true)
      )
    )
    .limit(1);

  if (nodes.length === 0 || !nodes[0].wrfcoinAddress || !nodes[0].registeredAt) {
    return null;
  }

  const node = nodes[0];
  return {
    wrfcoinAddress: node.wrfcoinAddress!,
    isRegistered: true,
    registeredAt: node.registeredAt!,
    meshtasticNodeId: node.meshtasticNodeId,
    hardwareModel: node.hardwareModel,
    firmwareVersion: node.firmwareVersion,
    geoFenceStatus: node.geoFenceStatus as GeoFenceReviewStatus,
    geoFenceGrid: node.geoFenceGrid,
    geoFenceBurstCount: node.geoFenceBurstCount,
  };
}

/**
 * Get WRFCoin address for a node (returns null if unregistered).
 */
export async function getNodeWrfcoinAddress(
  meshtasticNodeId: string
): Promise<string | null> {
  const nodes = await db
    .select({ wrfcoinAddress: meshtasticNodes.wrfcoinAddress })
    .from(meshtasticNodes)
    .where(
      and(
        eq(meshtasticNodes.meshtasticNodeId, meshtasticNodeId),
        eq(meshtasticNodes.isRegistered, true)
      )
    )
    .limit(1);

  return nodes[0]?.wrfcoinAddress || null;
}

/**
 * Batch lookup for multiple nodes (for batch processing).
 * Returns a Map of meshtasticNodeId -> wrfcoinAddress.
 * Only includes registered nodes with valid addresses.
 */
export async function getNodeAddresses(
  nodeIds: string[]
): Promise<Map<string, string>> {
  if (nodeIds.length === 0) {
    return new Map();
  }

  const nodes = await db
    .select({
      meshtasticNodeId: meshtasticNodes.meshtasticNodeId,
      wrfcoinAddress: meshtasticNodes.wrfcoinAddress,
    })
    .from(meshtasticNodes)
    .where(
      and(
        inArray(meshtasticNodes.meshtasticNodeId, nodeIds),
        eq(meshtasticNodes.isRegistered, true)
      )
    );

  const addressMap = new Map<string, string>();
  for (const node of nodes) {
    if (node.wrfcoinAddress) {
      addressMap.set(node.meshtasticNodeId, node.wrfcoinAddress);
    }
  }

  return addressMap;
}

/**
 * Register or update a node's WRFCoin address.
 * Creates the node if it doesn't exist.
 */
export async function registerNode(params: {
  meshtasticNodeId: string;
  wrfcoinAddress: string;
  signature: string;
  nonce: number;
  location?: GeoFenceLocation | null;
  geoFenceGrid?: string | null;
  geoFenceStatus?: GeoFenceReviewStatus;
  geoFenceReason?: string | null;
  geoFenceBurstCount?: number;
  geoFenceWindowStartedAt?: Date | null;
  geoFenceTriggeredAt?: Date | null;
  metadata?: {
    hardwareModel?: string;
    firmwareVersion?: string;
    shortName?: string;
    longName?: string;
  };
}): Promise<{
  node: MeshtasticNode;
  isNew: boolean;
}> {
  const {
    meshtasticNodeId,
    wrfcoinAddress,
    signature,
    nonce,
    location,
    geoFenceGrid,
    geoFenceStatus,
    geoFenceReason,
    geoFenceBurstCount,
    geoFenceWindowStartedAt,
    geoFenceTriggeredAt,
    metadata,
  } = params;
  const normalizedAddress = wrfcoinAddress.toLowerCase();

  // Check if node exists
  const existingNodes = await db
    .select()
    .from(meshtasticNodes)
    .where(eq(meshtasticNodes.meshtasticNodeId, meshtasticNodeId))
    .limit(1);

  const now = new Date();
  let node: MeshtasticNode;
  let isNew: boolean;

  if (existingNodes.length === 0) {
    // Create new node
    const [newNode] = await db
      .insert(meshtasticNodes)
        .values({
          meshtasticNodeId,
          wrfcoinAddress: normalizedAddress,
          isRegistered: true,
          registeredAt: now,
          registrationSignature: signature,
          registrationNonce: nonce,
          hardwareModel: metadata?.hardwareModel,
          firmwareVersion: metadata?.firmwareVersion,
          shortName: metadata?.shortName,
          longName: metadata?.longName,
          location: location || null,
          geoFenceGrid: geoFenceGrid || null,
          geoFenceStatus: geoFenceStatus || 'clear',
          geoFenceReason: geoFenceReason || null,
          geoFenceBurstCount: geoFenceBurstCount ?? 0,
          geoFenceWindowStartedAt: geoFenceWindowStartedAt || null,
          geoFenceTriggeredAt: geoFenceTriggeredAt || null,
          reputationScore: '50.00', // Starting reputation
          metadata: metadata || null,
          createdAt: now,
          updatedAt: now,
        })
      .returning();
    node = newNode;
    isNew = true;
  } else {
    // Update existing node
    const existingGeoFenceStatus = existingNodes[0].geoFenceStatus as GeoFenceReviewStatus | null;
    const resolvedGeoFenceStatus = resolveGeoFenceStatusForUpdate(
      existingGeoFenceStatus,
      geoFenceStatus
    );
    const preserveExistingGeoFenceDetails =
      resolvedGeoFenceStatus === existingGeoFenceStatus && geoFenceStatus !== resolvedGeoFenceStatus;

    const [updatedNode] = await db
      .update(meshtasticNodes)
        .set({
          wrfcoinAddress: normalizedAddress,
          isRegistered: true,
          registeredAt: now,
          registrationSignature: signature,
          registrationNonce: nonce,
          hardwareModel: metadata?.hardwareModel || existingNodes[0].hardwareModel,
          firmwareVersion: metadata?.firmwareVersion || existingNodes[0].firmwareVersion,
          shortName: metadata?.shortName || existingNodes[0].shortName,
          longName: metadata?.longName || existingNodes[0].longName,
          location: location || existingNodes[0].location,
          geoFenceGrid: geoFenceGrid || existingNodes[0].geoFenceGrid,
          geoFenceStatus: resolvedGeoFenceStatus,
          geoFenceReason: preserveExistingGeoFenceDetails
            ? existingNodes[0].geoFenceReason
            : geoFenceReason || existingNodes[0].geoFenceReason,
          geoFenceBurstCount: preserveExistingGeoFenceDetails
            ? existingNodes[0].geoFenceBurstCount
            : geoFenceBurstCount ?? existingNodes[0].geoFenceBurstCount,
          geoFenceWindowStartedAt:
            preserveExistingGeoFenceDetails
              ? existingNodes[0].geoFenceWindowStartedAt
              : geoFenceWindowStartedAt || existingNodes[0].geoFenceWindowStartedAt,
          geoFenceTriggeredAt: preserveExistingGeoFenceDetails
            ? existingNodes[0].geoFenceTriggeredAt
            : geoFenceTriggeredAt || existingNodes[0].geoFenceTriggeredAt,
          metadata: metadata
            ? { ...((existingNodes[0].metadata as object) || {}), ...metadata }
            : existingNodes[0].metadata,
          updatedAt: now,
        })
      .where(eq(meshtasticNodes.meshtasticNodeId, meshtasticNodeId))
      .returning();
    node = updatedNode;
    isNew = false;
  }

  return { node, isNew };
}

export async function setMeshtasticNodeGeoFenceReview(params: {
  meshtasticNodeId: string;
  status: GeoFenceReviewStatus;
  reviewedBy: string;
  reason?: string | null;
}): Promise<MeshtasticNode | null> {
  const [node] = await db
    .update(meshtasticNodes)
    .set({
      geoFenceStatus: params.status,
      geoFenceReason: params.reason ?? null,
      geoFenceReviewedBy: params.reviewedBy,
      geoFenceReviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(meshtasticNodes.meshtasticNodeId, params.meshtasticNodeId))
    .returning();

  return node || null;
}

// ============================================================================
// Registration Nonce Helpers (Replay Attack Prevention)
// ============================================================================

/**
 * Check if a nonce has been used for a given WRFCoin address.
 */
export async function isNonceUsed(
  wrfcoinAddress: string,
  nonce: number
): Promise<boolean> {
  const normalizedAddress = wrfcoinAddress.toLowerCase();
  const existing = await db
    .select({ id: meshtasticRegistrationNonces.id })
    .from(meshtasticRegistrationNonces)
    .where(
      and(
        eq(meshtasticRegistrationNonces.wrfcoinAddress, normalizedAddress),
        eq(meshtasticRegistrationNonces.nonce, nonce)
      )
    )
    .limit(1);

  return existing.length > 0;
}

/**
 * Mark a nonce as used for a given WRFCoin address.
 */
export async function markNonceUsed(
  wrfcoinAddress: string,
  nonce: number
): Promise<void> {
  const normalizedAddress = wrfcoinAddress.toLowerCase();
  try {
    await db.insert(meshtasticRegistrationNonces).values({
      wrfcoinAddress: normalizedAddress,
      nonce,
      usedAt: new Date(),
    });
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === '23505') {
      throw new RegistrationNonceAlreadyUsedError(
        `Nonce ${nonce} already used for address ${normalizedAddress}`
      );
    }
    throw error;
  }
}

/**
 * Clean up old nonces (older than specified hours).
 * Call periodically to prevent the nonce table from growing indefinitely.
 */
export async function cleanupOldNonces(maxAgeHours: number = 24): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

  const result = await db.execute(sql`
    DELETE FROM meshtastic_registration_nonces
    WHERE used_at < ${cutoff}
    RETURNING id
  `);

  return result.count || 0;
}

/**
 * Update a node's reputation score.
 */
export async function updateNodeReputationScore(
  nodeId: number,
  newScore: number
): Promise<void> {
  await db
    .update(meshtasticNodes)
    .set({
      reputationScore: newScore.toFixed(2),
      updatedAt: new Date(),
    })
    .where(eq(meshtasticNodes.id, nodeId));
}

/**
 * Update a node's location from an observation.
 */
export async function updateNodeLocation(
  nodeId: number,
  location: { lat: number; lon: number; alt?: number }
): Promise<void> {
  await db
    .update(meshtasticNodes)
    .set({
      location,
      updatedAt: new Date(),
    })
    .where(eq(meshtasticNodes.id, nodeId));
}

// ============================================================================
// Gateway Helpers
// ============================================================================

/**
 * Find a gateway by its gateway ID string.
 */
export async function findGatewayById(
  gatewayId: string
): Promise<MeshtasticGateway | null> {
  const gateways = await db
    .select()
    .from(meshtasticGateways)
    .where(eq(meshtasticGateways.gatewayId, gatewayId))
    .limit(1);
  return gateways[0] || null;
}

/**
 * Update a gateway's last seen timestamp.
 */
export async function updateGatewayLastSeen(gatewayId: string): Promise<void> {
  await db
    .update(meshtasticGateways)
    .set({ lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(meshtasticGateways.gatewayId, gatewayId));
}

// ============================================================================
// Observation Helpers
// ============================================================================

/**
 * Get recent observations for a specific node.
 */
export async function getRecentObservationsForNode(
  meshtasticNodeId: string,
  hours: number = 24,
  limit: number = 100
): Promise<MeshtasticObservation[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return db
    .select()
    .from(meshtasticObservations)
    .where(
      and(
        eq(meshtasticObservations.meshtasticNodeId, meshtasticNodeId),
        gte(meshtasticObservations.timestamp, since)
      )
    )
    .orderBy(desc(meshtasticObservations.timestamp))
    .limit(limit);
}

/**
 * Get observation statistics for a node over a time period.
 */
export interface ObservationStats {
  count: number;
  avgQuality: number | null;
  minQuality: number | null;
  maxQuality: number | null;
  validCount: number;
  invalidCount: number;
  suspiciousCount: number;
  pendingCount: number;
}

export async function getObservationStats(
  meshtasticNodeId: string,
  hours: number = 24
): Promise<ObservationStats> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const result = await db.execute(sql`
    SELECT
      COUNT(*)::int as count,
      AVG(quality_score) as avg_quality,
      MIN(quality_score) as min_quality,
      MAX(quality_score) as max_quality,
      COUNT(CASE WHEN validation_status = 'valid' THEN 1 END)::int as valid_count,
      COUNT(CASE WHEN validation_status = 'invalid' THEN 1 END)::int as invalid_count,
      COUNT(CASE WHEN validation_status = 'suspicious' THEN 1 END)::int as suspicious_count,
      COUNT(CASE WHEN validation_status = 'pending' THEN 1 END)::int as pending_count
    FROM meshtastic_observations
    WHERE meshtastic_node_id = ${meshtasticNodeId}
      AND timestamp >= ${since}
  `);

  const row = result[0] as any;
  return {
    count: row?.count || 0,
    avgQuality: row?.avg_quality ? parseFloat(row.avg_quality) : null,
    minQuality: row?.min_quality,
    maxQuality: row?.max_quality,
    validCount: row?.valid_count || 0,
    invalidCount: row?.invalid_count || 0,
    suspiciousCount: row?.suspicious_count || 0,
    pendingCount: row?.pending_count || 0,
  };
}

/**
 * Get the last N observations across all nodes (for admin dashboard).
 */
export async function getLatestObservations(
  limit: number = 50
): Promise<MeshtasticObservation[]> {
  return db
    .select()
    .from(meshtasticObservations)
    .orderBy(desc(meshtasticObservations.receivedAt))
    .limit(limit);
}

/**
 * Count observations by validation status.
 */
export interface StatusCounts {
  valid: number;
  invalid: number;
  suspicious: number;
  pending: number;
  total: number;
}

export async function getObservationStatusCounts(
  hours: number = 24
): Promise<StatusCounts> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const result = await db.execute(sql`
    SELECT
      validation_status,
      COUNT(*)::int as count
    FROM meshtastic_observations
    WHERE timestamp >= ${since}
    GROUP BY validation_status
  `);

  const counts: StatusCounts = {
    valid: 0,
    invalid: 0,
    suspicious: 0,
    pending: 0,
    total: 0,
  };

  for (const row of result as any[]) {
    const status = row.validation_status as keyof StatusCounts;
    if (status in counts) {
      counts[status] = row.count;
    }
    counts.total += row.count;
  }

  return counts;
}

/**
 * Get validation issue distribution for a node.
 */
export async function getValidationIssues(
  meshtasticNodeId: string,
  hours: number = 24
): Promise<Record<string, number>> {
  const observations = await getRecentObservationsForNode(
    meshtasticNodeId,
    hours,
    100
  );

  const issues: Record<string, number> = {};

  for (const obs of observations) {
    const details = obs.validationDetails as {
      schemaValidation?: { errors?: string[] };
    } | null;

    if (details?.schemaValidation?.errors) {
      for (const error of details.schemaValidation.errors) {
        issues[error] = (issues[error] || 0) + 1;
      }
    }
  }

  return issues;
}

// ============================================================================
// Aggregate Queries
// ============================================================================

/**
 * Get node activity summary for the dashboard.
 */
export interface NodeActivitySummary {
  totalNodes: number;
  registeredNodes: number;
  activeNodes24h: number;
  totalObservations24h: number;
  avgQuality24h: number | null;
}

export async function getNodeActivitySummary(): Promise<NodeActivitySummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const result = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM meshtastic_nodes) as total_nodes,
      (SELECT COUNT(*)::int FROM meshtastic_nodes WHERE is_registered = true) as registered_nodes,
      (SELECT COUNT(DISTINCT meshtastic_node_id)::int FROM meshtastic_observations WHERE timestamp >= ${since}) as active_nodes_24h,
      (SELECT COUNT(*)::int FROM meshtastic_observations WHERE timestamp >= ${since}) as total_observations_24h,
      (SELECT AVG(quality_score) FROM meshtastic_observations WHERE timestamp >= ${since}) as avg_quality_24h
  `);

  const row = result[0] as any;
  return {
    totalNodes: row?.total_nodes || 0,
    registeredNodes: row?.registered_nodes || 0,
    activeNodes24h: row?.active_nodes_24h || 0,
    totalObservations24h: row?.total_observations_24h || 0,
    avgQuality24h: row?.avg_quality_24h ? parseFloat(row.avg_quality_24h) : null,
  };
}

/**
 * Get geographic distribution of observations.
 */
export interface GeoCluster {
  lat: number;
  lon: number;
  count: number;
  avgQuality: number;
}

export async function getObservationGeoDistribution(
  hours: number = 24,
  gridSize: number = 1 // Degrees for clustering
): Promise<GeoCluster[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const result = await db.execute(sql`
    SELECT
      ROUND((location->>'lat')::float / ${gridSize}) * ${gridSize} as lat_cluster,
      ROUND((location->>'lon')::float / ${gridSize}) * ${gridSize} as lon_cluster,
      COUNT(*)::int as count,
      AVG(quality_score) as avg_quality
    FROM meshtastic_observations
    WHERE timestamp >= ${since}
      AND location IS NOT NULL
      AND location->>'lat' IS NOT NULL
      AND location->>'lon' IS NOT NULL
    GROUP BY lat_cluster, lon_cluster
    ORDER BY count DESC
    LIMIT 100
  `);

  return (result as any[]).map((row) => ({
    lat: parseFloat(row.lat_cluster),
    lon: parseFloat(row.lon_cluster),
    count: row.count,
    avgQuality: row.avg_quality ? parseFloat(row.avg_quality) : 0,
  }));
}
