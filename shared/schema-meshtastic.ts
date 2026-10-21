/**
 * Meshtastic Gateway Schema
 *
 * Database schema for LoRa mesh network integration with WRFCoin.
 * Supports weather observation collection, node management, and command distribution.
 */

import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  decimal,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * Table 1: Meshtastic Gateways
 * Registered gateway devices that bridge LoRa mesh to the backend.
 */
export const meshtasticGateways = pgTable(
  'meshtastic_gateways',
  {
    id: serial('id').primaryKey(),
    gatewayId: varchar('gateway_id', { length: 64 }).notNull().unique(),
    name: varchar('name', { length: 255 }),
    description: text('description'),
    apiKey: varchar('api_key', { length: 128 }).notNull(),
    apiKeyHash: varchar('api_key_hash', { length: 256 }),
    location: jsonb('location'), // { lat, lon, alt, address }
    config: jsonb('config'), // Gateway-specific configuration
    isActive: boolean('is_active').notNull().default(true),
    lastSeenAt: timestamp('last_seen_at'),
    registeredAt: timestamp('registered_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    gatewayIdIdx: index('meshtastic_gateways_gateway_id_idx').on(table.gatewayId),
    isActiveIdx: index('meshtastic_gateways_is_active_idx').on(table.isActive),
    lastSeenIdx: index('meshtastic_gateways_last_seen_idx').on(table.lastSeenAt),
  })
);

/**
 * Table 2: Meshtastic Nodes
 * LoRa mesh nodes that submit weather observations.
 */
export const meshtasticNodes = pgTable(
  'meshtastic_nodes',
  {
    id: serial('id').primaryKey(),
    meshtasticNodeId: varchar('meshtastic_node_id', { length: 64 }).notNull().unique(),
    wrfcoinAddress: varchar('wrfcoin_address', { length: 128 }),
    shortName: varchar('short_name', { length: 16 }),
    longName: varchar('long_name', { length: 255 }),
    hardwareModel: varchar('hardware_model', { length: 64 }),
    firmwareVersion: varchar('firmware_version', { length: 32 }),
    location: jsonb('location'), // { lat, lon, alt }
    deviceMetrics: jsonb('device_metrics'), // { batteryPct, voltage, uptimeSeconds, internalTempC }
    meshMetrics: jsonb('mesh_metrics'), // { neighborCount, avgRssi, avgSnr, relayedMessages }
    isRegistered: boolean('is_registered').notNull().default(false),
    registeredAt: timestamp('registered_at'),
    registrationSignature: text('registration_signature'), // Stored signature for audit/verification
    registrationNonce: integer('registration_nonce'), // Nonce used during registration to prevent replay
    lastObservationAt: timestamp('last_observation_at'),
    lastSeenAt: timestamp('last_seen_at'),
    reputationScore: decimal('reputation_score', { precision: 5, scale: 2 }),
    geoFenceGrid: varchar('geo_fence_grid', { length: 16 }),
    geoFenceStatus: varchar('geo_fence_status', { length: 32 }).notNull().default('clear'),
    geoFenceReason: text('geo_fence_reason'),
    geoFenceBurstCount: integer('geo_fence_burst_count').notNull().default(0),
    geoFenceWindowStartedAt: timestamp('geo_fence_window_started_at'),
    geoFenceTriggeredAt: timestamp('geo_fence_triggered_at'),
    geoFenceReviewedAt: timestamp('geo_fence_reviewed_at'),
    geoFenceReviewedBy: varchar('geo_fence_reviewed_by', { length: 128 }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    nodeIdIdx: index('meshtastic_nodes_node_id_idx').on(table.meshtasticNodeId),
    wrfcoinAddressIdx: index('meshtastic_nodes_wrfcoin_address_idx').on(table.wrfcoinAddress),
    lastObservationIdx: index('meshtastic_nodes_last_observation_idx').on(table.lastObservationAt),
    isRegisteredIdx: index('meshtastic_nodes_is_registered_idx').on(table.isRegistered),
    geoFenceGridIdx: index('meshtastic_nodes_geo_fence_grid_idx').on(table.geoFenceGrid),
    geoFenceStatusIdx: index('meshtastic_nodes_geo_fence_status_idx').on(table.geoFenceStatus),
  })
);

/**
 * Table 2b: Meshtastic Registration Nonces
 * Tracks used nonces to prevent replay attacks during node registration.
 */
export const meshtasticRegistrationNonces = pgTable(
  'meshtastic_registration_nonces',
  {
    id: serial('id').primaryKey(),
    wrfcoinAddress: varchar('wrfcoin_address', { length: 128 }).notNull(),
    nonce: integer('nonce').notNull(),
    usedAt: timestamp('used_at').notNull().defaultNow(),
  },
  table => ({
    addressNonceIdx: index('meshtastic_registration_nonces_address_nonce_idx').on(
      table.wrfcoinAddress,
      table.nonce
    ),
    // Compound unique constraint to ensure nonce can only be used once per address
    addressNonceUnique: uniqueIndex('meshtastic_registration_nonces_unique').on(
      table.wrfcoinAddress,
      table.nonce
    ),
  })
);

/**
 * Table 3: Meshtastic Observations
 * Weather and environmental observations received from mesh nodes.
 */
export const meshtasticObservations = pgTable(
  'meshtastic_observations',
  {
    id: serial('id').primaryKey(),
    observationId: varchar('observation_id', { length: 64 }).notNull().unique(),
    nodeId: integer('node_id').references(() => meshtasticNodes.id),
    gatewayId: integer('gateway_id').references(() => meshtasticGateways.id),
    meshtasticNodeId: varchar('meshtastic_node_id', { length: 64 }).notNull(),
    meshtasticGatewayId: varchar('meshtastic_gateway_id', { length: 64 }).notNull(),
    timestamp: timestamp('timestamp').notNull(),
    location: jsonb('location'), // { lat, lon, alt }
    environment: jsonb('environment'), // { temperatureC, humidityPct, pressureHpa, lightLux }
    airQuality: jsonb('air_quality'), // { pm2_5, pm10, vocIndex, co2EqPpm }
    deviceMetrics: jsonb('device_metrics'), // { batteryPct, uptimeSeconds }
    meshContext: jsonb('mesh_context'), // { rssi, snr, hopCount, neighborCount }
    qualityScore: integer('quality_score'), // 0-100
    validationStatus: varchar('validation_status', { length: 20 }).default('pending'), // pending, valid, invalid, suspicious
    validationDetails: jsonb('validation_details'),
    rawPayload: jsonb('raw_payload'),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    nodeIdIdx: index('meshtastic_observations_node_id_idx').on(table.nodeId),
    gatewayIdIdx: index('meshtastic_observations_gateway_id_idx').on(table.gatewayId),
    timestampIdx: index('meshtastic_observations_timestamp_idx').on(table.timestamp),
    meshtasticNodeIdIdx: index('meshtastic_observations_meshtastic_node_id_idx').on(
      table.meshtasticNodeId
    ),
    validationStatusIdx: index('meshtastic_observations_validation_status_idx').on(
      table.validationStatus
    ),
    receivedAtIdx: index('meshtastic_observations_received_at_idx').on(table.receivedAt),
  })
);

/**
 * Table 4: Meshtastic Commands
 * Commands queued for gateways to execute on mesh nodes.
 */
export const meshtasticCommands = pgTable(
  'meshtastic_commands',
  {
    id: serial('id').primaryKey(),
    commandId: varchar('command_id', { length: 64 }).notNull().unique(),
    gatewayId: varchar('gateway_id', { length: 64 }).notNull(),
    targetNodeId: varchar('target_node_id', { length: 64 }),
    kind: varchar('kind', { length: 32 }).notNull(), // 'sendLoRa', 'requestMetrics', 'requestEnvironment', 'ping'
    priority: integer('priority').default(5), // 1-10, higher is more urgent
    payload: jsonb('payload').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    executedAt: timestamp('executed_at'),
    result: jsonb('result'),
    status: varchar('status', { length: 20 }).default('pending'), // pending, sent, executed, expired, failed
    retryCount: integer('retry_count').default(0),
    maxRetries: integer('max_retries').default(3),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    gatewayIdIdx: index('meshtastic_commands_gateway_id_idx').on(table.gatewayId),
    statusIdx: index('meshtastic_commands_status_idx').on(table.status),
    expiresAtIdx: index('meshtastic_commands_expires_at_idx').on(table.expiresAt),
    targetNodeIdIdx: index('meshtastic_commands_target_node_id_idx').on(table.targetNodeId),
    priorityIdx: index('meshtastic_commands_priority_idx').on(table.priority),
  })
);

/**
 * Table 5: Meshtastic Transaction Nonces
 * Tracks used transaction nonces to prevent replay attacks (Task 109).
 */
export const meshtasticTxNonces = pgTable(
  'meshtastic_tx_nonces',
  {
    id: serial('id').primaryKey(),
    fromAddress: varchar('from_address', { length: 128 }).notNull(),
    nonce: integer('nonce').notNull(),
    txId: varchar('tx_id', { length: 128 }).notNull(),
    meshtasticNodeId: varchar('meshtastic_node_id', { length: 64 }),
    usedAt: timestamp('used_at').notNull().defaultNow(),
  },
  table => ({
    addressNonceIdx: index('meshtastic_tx_nonces_address_nonce_idx').on(
      table.fromAddress,
      table.nonce
    ),
    addressNonceUnique: uniqueIndex('meshtastic_tx_nonces_unique').on(
      table.fromAddress,
      table.nonce
    ),
    txIdIdx: index('meshtastic_tx_nonces_tx_id_idx').on(table.txId),
    usedAtIdx: index('meshtastic_tx_nonces_used_at_idx').on(table.usedAt),
  })
);

/**
 * Table 6: Meshtastic Transaction Chunks
 * Chunks of transactions being relayed over LoRa mesh.
 */
export const meshtasticTxChunks = pgTable(
  'meshtastic_tx_chunks',
  {
    id: serial('id').primaryKey(),
    txId: varchar('tx_id', { length: 128 }).notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    totalChunks: integer('total_chunks').notNull(),
    meshtasticNodeId: varchar('meshtastic_node_id', { length: 64 }).notNull(),
    gatewayId: varchar('gateway_id', { length: 64 }).notNull(),
    chunkData: text('chunk_data').notNull(), // Base64 encoded
    receivedAt: timestamp('received_at').notNull().defaultNow(),
    isComplete: boolean('is_complete').default(false),
    processedAt: timestamp('processed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    txIdIdx: index('meshtastic_tx_chunks_tx_id_idx').on(table.txId),
    txIdChunkIdx: index('meshtastic_tx_chunks_tx_id_chunk_idx').on(table.txId, table.chunkIndex),
    txIdChunkUnique: uniqueIndex('meshtastic_tx_chunks_tx_id_chunk_unique').on(
      table.txId,
      table.chunkIndex
    ),
    nodeIdIdx: index('meshtastic_tx_chunks_node_id_idx').on(table.meshtasticNodeId),
    isCompleteIdx: index('meshtastic_tx_chunks_is_complete_idx').on(table.isComplete),
  })
);

/**
 * Table 6: Meshtastic Reward Aggregations
 * Aggregated metrics and calculated rewards per node per time window.
 * Used for periodic reward distribution (Task 108).
 */
export const meshtasticRewardAggregations = pgTable(
  'meshtastic_reward_aggregations',
  {
    id: serial('id').primaryKey(),
    meshtasticNodeId: varchar('meshtastic_node_id', { length: 64 }).notNull(),
    wrfcoinAddress: varchar('wrfcoin_address', { length: 128 }),
    windowStart: timestamp('window_start').notNull(),
    windowEnd: timestamp('window_end').notNull(),
    windowType: varchar('window_type', { length: 10 }).notNull(), // '1h' or '24h'

    // Data reward metrics (from observations)
    observationCount: integer('observation_count').notNull().default(0),
    validObservationCount: integer('valid_observation_count').notNull().default(0),
    avgQualityScore: decimal('avg_quality_score', { precision: 5, scale: 2 }),
    uniqueHoursContributed: integer('unique_hours_contributed').default(0),
    spatialCoverageBonus: decimal('spatial_coverage_bonus', { precision: 5, scale: 2 }).default('0'),

    // Mesh reward metrics (from mesh activity)
    relayedMessages: integer('relayed_messages').default(0),
    uptimePercentage: decimal('uptime_percentage', { precision: 5, scale: 2 }),
    avgNeighborCount: decimal('avg_neighbor_count', { precision: 5, scale: 2 }),
    topologyImportanceScore: decimal('topology_importance_score', { precision: 5, scale: 2 }),

    // Calculated rewards (in WRF token units)
    dataReward: decimal('data_reward', { precision: 18, scale: 8 }).notNull().default('0'),
    meshReward: decimal('mesh_reward', { precision: 18, scale: 8 }).notNull().default('0'),
    totalReward: decimal('total_reward', { precision: 18, scale: 8 }).notNull().default('0'),

    // Distribution status
    status: varchar('status', { length: 20 }).default('pending'), // pending, distributed, capped, failed
    distributedAt: timestamp('distributed_at'),
    transactionId: varchar('transaction_id', { length: 128 }),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    nodeWindowIdx: index('meshtastic_reward_agg_node_window_idx').on(
      table.meshtasticNodeId,
      table.windowStart,
      table.windowType
    ),
    statusIdx: index('meshtastic_reward_agg_status_idx').on(table.status),
    windowTypeIdx: index('meshtastic_reward_agg_window_type_idx').on(table.windowType),
    addressIdx: index('meshtastic_reward_agg_address_idx').on(table.wrfcoinAddress),
  })
);

/**
 * Table 7: Meshtastic Reward Distributions
 * Individual distribution records linking rewards to wallet addresses.
 */
export const meshtasticRewardDistributions = pgTable(
  'meshtastic_reward_distributions',
  {
    id: serial('id').primaryKey(),
    aggregationId: integer('aggregation_id').references(() => meshtasticRewardAggregations.id),
    meshtasticNodeId: varchar('meshtastic_node_id', { length: 64 }).notNull(),
    wrfcoinAddress: varchar('wrfcoin_address', { length: 128 }).notNull(),
    amount: decimal('amount', { precision: 18, scale: 8 }).notNull(),
    rewardType: varchar('reward_type', { length: 20 }).notNull(), // 'data', 'mesh', 'combined'
    periodStart: timestamp('period_start').notNull(),
    periodEnd: timestamp('period_end').notNull(),
    transactionId: varchar('transaction_id', { length: 128 }),
    status: varchar('status', { length: 20 }).default('pending'), // pending, submitted, confirmed, failed
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    addressIdx: index('meshtastic_reward_dist_address_idx').on(table.wrfcoinAddress),
    statusIdx: index('meshtastic_reward_dist_status_idx').on(table.status),
    periodIdx: index('meshtastic_reward_dist_period_idx').on(table.periodStart, table.periodEnd),
    aggregationIdx: index('meshtastic_reward_dist_aggregation_idx').on(table.aggregationId),
  })
);

/**
 * Table 8: Meshtastic Reward Caps
 * Tracks cap enforcement for anti-gaming (daily, weekly, region limits).
 */
export const meshtasticRewardCaps = pgTable(
  'meshtastic_reward_caps',
  {
    id: serial('id').primaryKey(),
    meshtasticNodeId: varchar('meshtastic_node_id', { length: 64 }).notNull(),
    wrfcoinAddress: varchar('wrfcoin_address', { length: 128 }),
    capType: varchar('cap_type', { length: 20 }).notNull(), // 'daily', 'weekly', 'region'
    periodStart: timestamp('period_start').notNull(),
    periodEnd: timestamp('period_end').notNull(),
    totalEarned: decimal('total_earned', { precision: 18, scale: 8 }).notNull().default('0'),
    capLimit: decimal('cap_limit', { precision: 18, scale: 8 }).notNull(),
    isCapReached: boolean('is_cap_reached').default(false),
    region: varchar('region', { length: 64 }), // H3 region identifier for region caps
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    nodeCapIdx: index('meshtastic_caps_node_cap_idx').on(
      table.meshtasticNodeId,
      table.capType,
      table.periodStart
    ),
    regionCapIdx: index('meshtastic_caps_region_idx').on(table.region, table.capType, table.periodStart),
  })
);

// Relations
export const meshtasticGatewaysRelations = relations(meshtasticGateways, ({ many }) => ({
  observations: many(meshtasticObservations),
  commands: many(meshtasticCommands),
}));

export const meshtasticNodesRelations = relations(meshtasticNodes, ({ many }) => ({
  observations: many(meshtasticObservations),
}));

export const meshtasticObservationsRelations = relations(meshtasticObservations, ({ one }) => ({
  node: one(meshtasticNodes, {
    fields: [meshtasticObservations.nodeId],
    references: [meshtasticNodes.id],
  }),
  gateway: one(meshtasticGateways, {
    fields: [meshtasticObservations.gatewayId],
    references: [meshtasticGateways.id],
  }),
}));

// Type exports for TypeScript
export type MeshtasticGateway = typeof meshtasticGateways.$inferSelect;
export type NewMeshtasticGateway = typeof meshtasticGateways.$inferInsert;
export type MeshtasticNode = typeof meshtasticNodes.$inferSelect;
export type NewMeshtasticNode = typeof meshtasticNodes.$inferInsert;
export type MeshtasticRegistrationNonce = typeof meshtasticRegistrationNonces.$inferSelect;
export type NewMeshtasticRegistrationNonce = typeof meshtasticRegistrationNonces.$inferInsert;
export type MeshtasticObservation = typeof meshtasticObservations.$inferSelect;
export type NewMeshtasticObservation = typeof meshtasticObservations.$inferInsert;
export type MeshtasticCommand = typeof meshtasticCommands.$inferSelect;
export type NewMeshtasticCommand = typeof meshtasticCommands.$inferInsert;
export type MeshtasticTxNonce = typeof meshtasticTxNonces.$inferSelect;
export type NewMeshtasticTxNonce = typeof meshtasticTxNonces.$inferInsert;
export type MeshtasticTxChunk = typeof meshtasticTxChunks.$inferSelect;
export type NewMeshtasticTxChunk = typeof meshtasticTxChunks.$inferInsert;
export type MeshtasticRewardAggregation = typeof meshtasticRewardAggregations.$inferSelect;
export type NewMeshtasticRewardAggregation = typeof meshtasticRewardAggregations.$inferInsert;
export type MeshtasticRewardDistribution = typeof meshtasticRewardDistributions.$inferSelect;
export type NewMeshtasticRewardDistribution = typeof meshtasticRewardDistributions.$inferInsert;
export type MeshtasticRewardCap = typeof meshtasticRewardCaps.$inferSelect;
export type NewMeshtasticRewardCap = typeof meshtasticRewardCaps.$inferInsert;
