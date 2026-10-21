/**
 * Consolidated IoT Schema
 * Simplified from 15 tables to 5 optimized tables
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
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Table 1: Unified devices registry (replaces luftdaten_sensors, ttn_devices, ttn_sensors)
export const devicesConsolidated = pgTable('devices_consolidated', {
  id: serial('id').primaryKey(),
  deviceId: varchar('device_id', { length: 64 }).notNull().unique(),
  deviceType: varchar('device_type', { length: 20 }).notNull(), // 'luftdaten', 'ttn', 'foam', 'streamr', 'acurite'
  publicKeyHex: varchar('public_key_hex', { length: 128 }),
  name: varchar('name', { length: 255 }),
  description: text('description'),
  locationLat: decimal('location_lat', { precision: 10, scale: 8 }),
  locationLon: decimal('location_lon', { precision: 11, scale: 8 }),
  elevation: integer('elevation'),
  ownerAddress: varchar('owner_address', { length: 64 }),
  networkConfig: jsonb('network_config'),
  deviceMetadata: jsonb('device_metadata'),
  isActive: boolean('is_active').notNull().default(true),
  lastSeen: timestamp('last_seen'),
  decommissionedAt: timestamp('decommissioned_at'),
  registrationDate: timestamp('registration_date').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  deviceTypeIdx: index('idx_devices_consolidated_type').on(table.deviceType),
  ownerAddressIdx: index('idx_devices_consolidated_owner').on(table.ownerAddress),
  isActiveIdx: index('idx_devices_consolidated_active').on(table.isActive),
  lastSeenIdx: index('idx_devices_consolidated_last_seen').on(table.lastSeen),
  decommissionedAtIdx: index('idx_devices_consolidated_decommissioned').on(table.decommissionedAt),
}));

// Table 2: Unified measurements (replaces luftdaten_measurements, ttn_measurements, streamr_data_points)
export const measurementsConsolidated = pgTable('measurements_consolidated', {
  id: serial('id').primaryKey(),
  measurementId: varchar('measurement_id', { length: 64 }).notNull().unique(),
  deviceId: varchar('device_id', { length: 64 }).notNull(),
  deviceType: varchar('device_type', { length: 20 }).notNull(),
  measurementType: varchar('measurement_type', { length: 50 }).notNull(), // 'temperature', 'humidity', 'pressure', etc.
  value: decimal('value', { precision: 15, scale: 6 }).notNull(),
  unit: varchar('unit', { length: 20 }).notNull(),
  qualityScore: decimal('quality_score', { precision: 5, scale: 2 }),
  rawData: jsonb('raw_data'),
  locationLat: decimal('location_lat', { precision: 10, scale: 8 }),
  locationLon: decimal('location_lon', { precision: 11, scale: 8 }),
  measuredAt: timestamp('measured_at').notNull(),
  receivedAt: timestamp('received_at').notNull().defaultNow(),
  verified: boolean('verified').default(false),
  verificationScore: decimal('verification_score', { precision: 5, scale: 2 }),
}, (table) => ({
  deviceIdIdx: index('idx_measurements_consolidated_device').on(table.deviceId),
  measurementTypeIdx: index('idx_measurements_consolidated_type').on(table.measurementType),
  measuredAtIdx: index('idx_measurements_consolidated_measured').on(table.measuredAt),
  deviceMeasuredIdx: index('idx_measurements_consolidated_device_measured').on(table.deviceId, table.measuredAt),
}));

// Table 3: Unified submissions (replaces environmental_data_submissions, environmental_submissions, environmental_attestations, environmental_offset_proofs)
export const submissionsConsolidated = pgTable('submissions_consolidated', {
  id: serial('id').primaryKey(),
  submissionId: varchar('submission_id', { length: 64 }).notNull().unique(),
  submissionType: varchar('submission_type', { length: 30 }).notNull(), // 'reward_data', 'environmental', 'attestation', 'offset_proof'
  submitterAddress: varchar('submitter_address', { length: 64 }).notNull(),
  deviceId: varchar('device_id', { length: 64 }),
  dataPayload: jsonb('data_payload').notNull(),
  attestationData: jsonb('attestation_data'),
  verificationStatus: varchar('verification_status', { length: 20 }).default(
    'pending'
  ), // 'pending', 'verified', 'rejected'
  verifierAddress: varchar('verifier_address', { length: 64 }),
  verificationTimestamp: timestamp('verification_timestamp'),
  rewardAmount: decimal('reward_amount', { precision: 20, scale: 8 }),
  transactionId: varchar('transaction_id', { length: 64 }),
  blockHeight: integer('block_height'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  submitterIdx: index('idx_submissions_consolidated_submitter').on(table.submitterAddress),
  verificationIdx: index('idx_submissions_consolidated_verification').on(table.verificationStatus),
  deviceIdIdx: index('idx_submissions_consolidated_device').on(table.deviceId),
  submissionTypeIdx: index('idx_submissions_consolidated_type').on(table.submissionType),
}));

// Table 4: Network infrastructure (replaces foam_points, foam_device_verifications)
export const networkInfrastructure = pgTable('network_infrastructure', {
  id: serial('id').primaryKey(),
  infrastructureId: varchar('infrastructure_id', { length: 64 })
    .notNull()
    .unique(),
  infrastructureType: varchar('infrastructure_type', { length: 20 }).notNull(), // 'foam_point', 'verification_node', 'gateway'
  networkName: varchar('network_name', { length: 30 }).notNull(), // 'foam', 'ttn', 'helium'
  locationLat: decimal('location_lat', { precision: 10, scale: 8 }).notNull(),
  locationLon: decimal('location_lon', { precision: 11, scale: 8 }).notNull(),
  coverageRadius: integer('coverage_radius'), // in meters
  signalStrength: decimal('signal_strength', { precision: 5, scale: 2 }),
  verificationData: jsonb('verification_data'),
  status: varchar('status', { length: 20 }).default('active'), // 'active', 'inactive', 'maintenance'
  operatorAddress: varchar('operator_address', { length: 64 }),
  metadata: jsonb('metadata'),
  lastUpdated: timestamp('last_updated').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  networkNameIdx: index('idx_network_infra_network').on(table.networkName),
  statusIdx: index('idx_network_infra_status').on(table.status),
  operatorIdx: index('idx_network_infra_operator').on(table.operatorAddress),
  infraTypeIdx: index('idx_network_infra_type').on(table.infrastructureType),
}));

// Table 5: Streaming services (replaces streamr_products, streamr_streams, streamr_subscriptions)
export const streamingServices = pgTable('streaming_services', {
  id: serial('id').primaryKey(),
  serviceId: varchar('service_id', { length: 64 }).notNull().unique(),
  serviceType: varchar('service_type', { length: 20 }).notNull(), // 'stream', 'product', 'subscription'
  provider: varchar('provider', { length: 20 }).notNull(), // 'streamr', 'thegraph', 'chainlink'
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  dataSchema: jsonb('data_schema'),
  accessPermissions: jsonb('access_permissions'),
  pricingModel: jsonb('pricing_model'),
  subscriberAddress: varchar('subscriber_address', { length: 64 }),
  streamConfig: jsonb('stream_config'),
  isActive: boolean('is_active').default(true),
  subscriptionExpires: timestamp('subscription_expires'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  providerIdx: index('idx_streaming_services_provider').on(table.provider),
  serviceTypeIdx: index('idx_streaming_services_type').on(table.serviceType),
  isActiveIdx: index('idx_streaming_services_active').on(table.isActive),
}));

// Relations
export const devicesConsolidatedRelations = relations(
  devicesConsolidated,
  ({ many }) => ({
    measurements: many(measurementsConsolidated),
    submissions: many(submissionsConsolidated),
  })
);

export const measurementsConsolidatedRelations = relations(
  measurementsConsolidated,
  ({ one }) => ({
    device: one(devicesConsolidated, {
      fields: [measurementsConsolidated.deviceId],
      references: [devicesConsolidated.deviceId],
    }),
  })
);

export const submissionsConsolidatedRelations = relations(
  submissionsConsolidated,
  ({ one }) => ({
    device: one(devicesConsolidated, {
      fields: [submissionsConsolidated.deviceId],
      references: [devicesConsolidated.deviceId],
    }),
  })
);

// Export all consolidated IoT tables
export const iotConsolidatedSchema = {
  devicesConsolidated,
  measurementsConsolidated,
  submissionsConsolidated,
  networkInfrastructure,
  streamingServices,
};
