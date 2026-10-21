import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * Computational NFT Schema
 *
 * This file defines the database schema for computational NFTs and their
 * cross-chain capabilities in the Wrfcoin ecosystem.
 */

// Computational NFTs
export const computationalNfts = pgTable('computational_nfts', {
  id: serial('id').primaryKey(),
  tokenId: varchar('token_id', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  // Adding title field that maps to the same database column for compatibility
  title: varchar('title', { length: 255 }),
  description: text('description'),
  owner: varchar('owner', { length: 100 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),

  // Computational properties
  algorithm: varchar('algorithm', { length: 255 }),
  inputDatasetId: varchar('input_dataset_id', { length: 100 }),
  parametersJson: jsonb('parameters_json'),

  // Weather-specific properties
  forecastType: varchar('forecast_type', { length: 50 }),
  region: varchar('region', { length: 100 }),
  resolution: varchar('resolution', { length: 50 }),
  forecastHours: integer('forecast_hours'),

  // Metadata
  metadataUri: varchar('metadata_uri', { length: 255 }),
  imageUri: varchar('image_uri', { length: 255 }),

  // Original chain information
  originChain: varchar('origin_chain', { length: 50 }).notNull(),
  originContractAddress: varchar('origin_contract_address', { length: 100 }),
});

// NFT transfers across chains
export const nftChainTransfers = pgTable('nft_chain_transfers', {
  id: serial('id').primaryKey(),
  nftId: integer('nft_id')
    .notNull()
    .references(() => computationalNfts.id),
  sourceChain: varchar('source_chain', { length: 50 }).notNull(),
  destinationChain: varchar('destination_chain', { length: 50 }).notNull(),
  sourceAddress: varchar('source_address', { length: 100 }).notNull(),
  destinationAddress: varchar('destination_address', { length: 100 }).notNull(),
  bridgeProvider: varchar('bridge_provider', { length: 50 }).notNull(),
  sourceTxHash: varchar('source_tx_hash', { length: 100 }),
  destinationTxHash: varchar('destination_tx_hash', { length: 100 }),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  fee: varchar('fee', { length: 50 }),
  initiatedAt: timestamp('initiated_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
  errorMessage: text('error_message'),
});

// Computational NFT executions
export const nftExecutions = pgTable('nft_executions', {
  id: serial('id').primaryKey(),
  nftId: integer('nft_id')
    .notNull()
    .references(() => computationalNfts.id),
  executionChain: varchar('execution_chain', { length: 50 }).notNull(),
  computeProvider: varchar('compute_provider', { length: 50 }).notNull(),
  executionTxHash: varchar('execution_tx_hash', { length: 100 }),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  resultsJson: jsonb('results_json'),
  executionStartTime: timestamp('execution_start_time').defaultNow().notNull(),
  executionEndTime: timestamp('execution_end_time'),
  computationalCost: varchar('computational_cost', { length: 50 }),
  verified: boolean('verified').default(false),
  verificationMethod: varchar('verification_method', { length: 50 }),
});

// Storage records for computational results
export const nftStorageRecords = pgTable('nft_storage_records', {
  id: serial('id').primaryKey(),
  nftId: integer('nft_id')
    .notNull()
    .references(() => computationalNfts.id),
  executionId: integer('execution_id').references(() => nftExecutions.id),
  storageProvider: varchar('storage_provider', { length: 50 }).notNull(),
  storageChain: varchar('storage_chain', { length: 50 }),
  contentIdentifier: varchar('content_identifier', { length: 255 }).notNull(),
  contentType: varchar('content_type', { length: 100 }).notNull(),
  contentSize: integer('content_size'),
  storedAt: timestamp('stored_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at'),
  storageCost: varchar('storage_cost', { length: 50 }),
  accessPermissions: varchar('access_permissions', { length: 100 }).default(
    'public'
  ),
});

// Relationship definitions
export const computationalNftRelations = relations(
  computationalNfts,
  ({ many }) => ({
    transfers: many(nftChainTransfers),
    executions: many(nftExecutions),
    storageRecords: many(nftStorageRecords),
  })
);

export const nftChainTransferRelations = relations(
  nftChainTransfers,
  ({ one }) => ({
    nft: one(computationalNfts, {
      fields: [nftChainTransfers.nftId],
      references: [computationalNfts.id],
    }),
  })
);

export const nftExecutionRelations = relations(
  nftExecutions,
  ({ one, many }) => ({
    nft: one(computationalNfts, {
      fields: [nftExecutions.nftId],
      references: [computationalNfts.id],
    }),
    storageRecords: many(nftStorageRecords),
  })
);

export const nftStorageRecordRelations = relations(
  nftStorageRecords,
  ({ one }) => ({
    nft: one(computationalNfts, {
      fields: [nftStorageRecords.nftId],
      references: [computationalNfts.id],
    }),
    execution: one(nftExecutions, {
      fields: [nftStorageRecords.executionId],
      references: [nftExecutions.id],
    }),
  })
);

// Type exports
export type ComputationalNft = typeof computationalNfts.$inferSelect;
export type InsertComputationalNft = typeof computationalNfts.$inferInsert;

export type NftChainTransfer = typeof nftChainTransfers.$inferSelect;
export type InsertNftChainTransfer = typeof nftChainTransfers.$inferInsert;

export type NftExecution = typeof nftExecutions.$inferSelect;
export type InsertNftExecution = typeof nftExecutions.$inferInsert;

export type NftStorageRecord = typeof nftStorageRecords.$inferSelect;
export type InsertNftStorageRecord = typeof nftStorageRecords.$inferInsert;
