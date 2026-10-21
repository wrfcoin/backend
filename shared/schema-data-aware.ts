/**
 * Database Schema for Data-Aware Blocks
 *
 * This file extends the main database schema to support data-aware blocks
 * specialized for meteorological and computational data.
 */

import {
  pgTable,
  text,
  integer,
  boolean,
  json,
  timestamp,
  serial,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import {
  DataBlockType,
  DataStorageProvider,
  GeoReferenceSystem,
} from './data-aware-block.js';

// Create enums for the database
export const dataBlockTypeEnum = pgEnum('data_block_type', [
  'weather_forecast',
  'climate_simulation',
  'air_quality',
  'sensor_collection',
  'computational_result',
]);

export const dataStorageProviderEnum = pgEnum('data_storage_provider', [
  'ipfs',
  'filecoin',
  'arweave',
  'storj',
  'local',
]);

export const geoReferenceSystemEnum = pgEnum('geo_reference_system', [
  'wgs84',
  'utm',
  'mgrs',
  'osgb36',
  'lambert',
  'custom',
]);

export const reviewStatusEnum = pgEnum('review_status', [
  'unreviewed',
  'peer_reviewed',
  'validated',
]);

export const verificationStatusEnum = pgEnum('verification_status', [
  'pending',
  'partial',
  'verified',
]);

// Data-aware blocks table
export const dataAwareBlocks = pgTable('data_aware_blocks', {
  id: serial('id').primaryKey(),
  block_id: text('block_id').notNull().unique(),
  parent_block_id: text('parent_block_id').notNull(),
  data_type: dataBlockTypeEnum('data_type').notNull(),
  creator_address: text('creator_address').notNull(),
  creation_timestamp: timestamp('creation_timestamp').notNull(),
  version: integer('version').notNull(),
  hash: text('hash').notNull(),
  signature: text('signature').notNull(),
  nonce: integer('nonce').notNull(),
  timestamp: timestamp('timestamp').notNull(),
  difficulty: integer('difficulty').notNull(),
  size_bytes: integer('size_bytes').notNull(),

  // Store JSON representations of complex data
  forecast_metadata: json('forecast_metadata').notNull(),
  sensor_data: json('sensor_data'),
  storage: json('storage').notNull(),
  access: json('access').notNull(),
  pruning: json('pruning').notNull(),
  transactions: json('transactions').notNull(), // Array of transaction IDs
  data_summary: json('data_summary'),
  extensions: json('extensions').notNull(),
});

// Checkpoint blocks table that extends data_aware_blocks
export const checkpointBlocks = pgTable('checkpoint_blocks', {
  id: serial('id').primaryKey(),
  data_aware_block_id: integer('data_aware_block_id')
    .notNull()
    .references(() => dataAwareBlocks.id),
  checkpoint_level: integer('checkpoint_level').notNull(),
  period_start: timestamp('period_start').notNull(),
  period_end: timestamp('period_end').notNull(),
  system_state_hash: text('system_state_hash').notNull(),
  summarized_blocks: json('summarized_blocks').notNull(), // Array of block IDs
  rollup_transactions: json('rollup_transactions').notNull(), // Array of high-value transaction IDs
});

// Forecast parameter definitions
export const forecastParameters = pgTable('forecast_parameters', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  unit: text('unit').notNull(),
  scale_factor: integer('scale_factor'),
  offset: integer('offset'),
  precision: integer('precision'),
  min_value: integer('min_value'),
  max_value: integer('max_value'),
  description: text('description'),
});

// Sensor devices table
export const sensorDevices = pgTable('sensor_devices', {
  id: serial('id').primaryKey(),
  device_id: text('device_id').notNull().unique(),
  owner_address: text('owner_address').notNull(),
  device_type: text('device_type').notNull(),
  name: text('name').notNull(),
  location_lat: text('location_lat').notNull(),
  location_lon: text('location_lon').notNull(),
  elevation: integer('elevation'),
  active: boolean('active').notNull().default(true),
  registration_date: timestamp('registration_date').notNull(),
  last_submission: timestamp('last_submission'),
  metadata: json('metadata'),
});

// Sensor submissions table
export const sensorSubmissions = pgTable('sensor_submissions', {
  id: serial('id').primaryKey(),
  submission_id: text('submission_id').notNull().unique(),
  device_id: text('device_id')
    .notNull()
    .references(() => sensorDevices.device_id),
  block_id: text('block_id').references(() => dataAwareBlocks.block_id),
  submission_hash: text('submission_hash').notNull(),
  submission_timestamp: timestamp('submission_timestamp').notNull(),
  data: json('data').notNull(),
  verified: boolean('verified').notNull().default(false),
  verification_timestamp: timestamp('verification_timestamp'),
  verifier_address: text('verifier_address'),
});

// Node types for different roles
export const nodeTypeEnum = pgEnum('node_type', [
  'validator',
  'data_submission',
  'forecast_compute',
  'file_storage',
  'light_client',
]);

// Nodes table
export const nodes = pgTable('nodes', {
  id: serial('id').primaryKey(),
  node_id: text('node_id').notNull().unique(),
  node_type: nodeTypeEnum('node_type').notNull(),
  owner_address: text('owner_address').notNull(),
  name: text('name').notNull(),
  ip_address: text('ip_address'),
  port: integer('port'),
  registration_date: timestamp('registration_date').notNull(),
  last_seen: timestamp('last_seen').notNull(),
  stake_amount: integer('stake_amount').notNull().default(0),
  reputation_score: integer('reputation_score').notNull().default(100),
  capabilities: json('capabilities').notNull(),
  is_active: boolean('is_active').notNull().default(true),
});

// Define table relationships
export const dataAwareBlocksRelations = relations(
  dataAwareBlocks,
  ({ many, one }) => ({
    checkpointBlock: one(checkpointBlocks, {
      fields: [dataAwareBlocks.id],
      references: [checkpointBlocks.data_aware_block_id],
    }),
    sensorSubmissions: many(sensorSubmissions),
  })
);

export const sensorDevicesRelations = relations(sensorDevices, ({ many }) => ({
  submissions: many(sensorSubmissions),
}));

export const sensorSubmissionsRelations = relations(
  sensorSubmissions,
  ({ one }) => ({
    device: one(sensorDevices, {
      fields: [sensorSubmissions.device_id],
      references: [sensorDevices.device_id],
    }),
    block: one(dataAwareBlocks, {
      fields: [sensorSubmissions.block_id],
      references: [dataAwareBlocks.block_id],
    }),
  })
);
