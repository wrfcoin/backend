import {
  pgTable,
  text,
  varchar,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  doublePrecision,
  uuid,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enums for IoTeX integration
export const deviceTypeEnum = pgEnum('device_type', [
  'WEATHER_STATION',
  'AIR_QUALITY_MONITOR',
  'TEMPERATURE_SENSOR',
  'WIND_SENSOR',
  'RAINFALL_SENSOR',
  'HUMIDITY_SENSOR',
  'PRESSURE_SENSOR',
  'SOLAR_RADIATION_SENSOR',
  'MULTI_SENSOR',
  'OTHER',
]);

export const attestationStatusEnum = pgEnum('attestation_status', [
  'PENDING',
  'ATTESTING',
  'ATTESTED',
  'FAILED',
  'EXPIRED',
  'REVOKED',
]);

export const attestationTypeEnum = pgEnum('attestation_type', [
  'TEE',
  'TPM',
  'SECURE_ELEMENT',
  'IOTEX_SOVEREIGN',
]);

// IoTeX devices table
export const devices = pgTable('iotex_devices', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 256 }).notNull(),
  type: deviceTypeEnum('type').notNull(),
  attestationStatus: attestationStatusEnum('attestation_status')
    .notNull()
    .default('PENDING'),
  attestationType: attestationTypeEnum('attestation_type'),
  lastSeen: timestamp('last_seen'),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  geohash: varchar('geohash', { length: 12 }),
  geoFenceGrid: varchar('geo_fence_grid', { length: 16 }),
  geoFenceStatus: varchar('geo_fence_status', { length: 32 }).notNull().default('clear'),
  geoFenceReason: text('geo_fence_reason'),
  geoFenceBurstCount: integer('geo_fence_burst_count').notNull().default(0),
  geoFenceWindowStartedAt: timestamp('geo_fence_window_started_at'),
  geoFenceTriggeredAt: timestamp('geo_fence_triggered_at'),
  geoFenceReviewedAt: timestamp('geo_fence_reviewed_at'),
  geoFenceReviewedBy: varchar('geo_fence_reviewed_by', { length: 128 }),
  metadata: jsonb('metadata'),
  owner: varchar('owner', { length: 64 }),
  // backend#1240: a 32-byte ed25519 key as 64 lowercase hex (validated at registration; no
  // schema change). Older rows may hold free-form text: they can no longer verify.
  publicKey: text('public_key'),
  firmwareVersion: varchar('firmware_version', { length: 50 }),
  hardwareId: varchar('hardware_id', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, table => ({
  geoFenceGridIdx: index('iotex_devices_geo_fence_grid_idx').on(table.geoFenceGrid),
  geoFenceStatusIdx: index('iotex_devices_geo_fence_status_idx').on(table.geoFenceStatus),
}));

// Device data table for storing data submitted by devices
export const deviceData = pgTable('iotex_device_data', {
  id: uuid('id').primaryKey(),
  deviceId: varchar('device_id', { length: 64 })
    .notNull()
    .references(() => devices.id),
  data: jsonb('data').notNull(),
  timestamp: timestamp('timestamp').notNull(),
  verified: boolean('verified').notNull().default(false),
  signature: text('signature'),
  blockchainReference: varchar('blockchain_reference', { length: 100 }),
  transactionId: varchar('transaction_id', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, table => ({
  deviceTimestampIdx: index('iotex_device_data_device_id_timestamp_idx').on(table.deviceId, table.timestamp),
}));

// Attestation requests table
export const attestationRequests = pgTable('iotex_attestation_requests', {
  id: uuid('id').primaryKey(),
  deviceId: varchar('device_id', { length: 64 })
    .notNull()
    .references(() => devices.id),
  attestationType: attestationTypeEnum('attestation_type').notNull(),
  status: attestationStatusEnum('status').notNull().default('PENDING'),
  challenge: text('challenge').notNull(),
  response: jsonb('response'),
  metadata: jsonb('metadata'),
  expiresAt: timestamp('expires_at').notNull(),
  completedAt: timestamp('completed_at'),
  failedAt: timestamp('failed_at'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, table => ({
  deviceIdx: index('iotex_attestation_requests_device_id_idx').on(table.deviceId),
}));

// W3bstream publishers table
export const w3bstreamPublishers = pgTable('iotex_w3bstream_publishers', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 256 }).notNull(),
  type: deviceTypeEnum('type').notNull(),
  publicKey: text('public_key').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
  deviceId: varchar('device_id', { length: 64 }).references(() => devices.id),
  lastEventTimestamp: timestamp('last_event_timestamp'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// W3bstream events table
export const w3bstreamEvents = pgTable('iotex_w3bstream_events', {
  id: uuid('id').primaryKey(),
  publisherId: varchar('publisher_id', { length: 64 })
    .notNull()
    .references(() => w3bstreamPublishers.id),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  payload: jsonb('payload').notNull(),
  timestamp: timestamp('timestamp').notNull(),
  blockchainTx: varchar('blockchain_tx', { length: 100 }),
  verified: boolean('verified').notNull().default(false),
  deviceDataId: uuid('device_data_id').references(() => deviceData.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, table => ({
  publisherTimestampIdx: index('iotex_w3bstream_events_publisher_id_timestamp_idx').on(table.publisherId, table.timestamp),
}));

// Define relations
export const devicesRelations = relations(devices, ({ many }) => ({
  data: many(deviceData),
  attestationRequests: many(attestationRequests),
  publishers: many(w3bstreamPublishers),
}));

export const deviceDataRelations = relations(deviceData, ({ one }) => ({
  device: one(devices, {
    fields: [deviceData.deviceId],
    references: [devices.id],
  }),
}));

export const attestationRequestsRelations = relations(
  attestationRequests,
  ({ one }) => ({
    device: one(devices, {
      fields: [attestationRequests.deviceId],
      references: [devices.id],
    }),
  })
);

export const w3bstreamPublishersRelations = relations(
  w3bstreamPublishers,
  ({ one, many }) => ({
    device: one(devices, {
      fields: [w3bstreamPublishers.deviceId],
      references: [devices.id],
    }),
    events: many(w3bstreamEvents),
  })
);

export const w3bstreamEventsRelations = relations(
  w3bstreamEvents,
  ({ one }) => ({
    publisher: one(w3bstreamPublishers, {
      fields: [w3bstreamEvents.publisherId],
      references: [w3bstreamPublishers.id],
    }),
    deviceData: one(deviceData, {
      fields: [w3bstreamEvents.deviceDataId],
      references: [deviceData.id],
    }),
  })
);

// Export types
export type Device = typeof devices.$inferSelect;
export type InsertDevice = typeof devices.$inferInsert;

export type DeviceData = typeof deviceData.$inferSelect;
export type InsertDeviceData = typeof deviceData.$inferInsert;

export type AttestationRequest = typeof attestationRequests.$inferSelect;
export type InsertAttestationRequest = typeof attestationRequests.$inferInsert;

export type W3bstreamPublisher = typeof w3bstreamPublishers.$inferSelect;
export type InsertW3bstreamPublisher = typeof w3bstreamPublishers.$inferInsert;

export type W3bstreamEvent = typeof w3bstreamEvents.$inferSelect;
export type InsertW3bstreamEvent = typeof w3bstreamEvents.$inferInsert;
