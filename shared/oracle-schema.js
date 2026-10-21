/**
 * Oracle Network Schema
 *
 * This file defines the database schema for the Climate Data Oracle Network
 * and related components.
 */

import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  varchar,
  json,
  doublePrecision,
  jsonb,
  uuid,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Create enums for oracle network
export const oracleRequestStatusEnum = pgEnum('oracle_request_status', [
  'PENDING', // Newly created, waiting to be processed
  'PROCESSING', // Being processed by the oracle network
  'COMPLETED', // Successfully completed
  'ERROR', // Error occurred during processing
  'CANCELLED', // Cancelled by the requester
]);

export const oracleResponseStatusEnum = pgEnum('oracle_response_status', [
  'READY', // Response is ready but not yet delivered
  'DELIVERED', // Response has been delivered to the requesting chain
  'ERROR', // Error occurred during delivery
  'EXPIRED', // Response expired before delivery
]);

export const oracleDataTypeEnum = pgEnum('oracle_data_type', [
  'TEMPERATURE', // Temperature data
  'PRECIPITATION', // Precipitation (rain, snow, etc.) data
  'HUMIDITY', // Humidity data
  'WIND', // Wind data (speed, direction)
  'PRESSURE', // Atmospheric pressure
  'AIR_QUALITY', // Air quality metrics
  'FORECAST', // Weather forecast
  'HISTORICAL', // Historical weather data
  'AGGREGATE', // Aggregated data from multiple sources
  'CLIMATE_IMPACT', // Climate impact metrics
]);

export const bridgeProviderEnum = pgEnum('bridge_provider', [
  'AXELAR', // Axelar Network bridge
  'LAYERZERO', // LayerZero bridge
  'WORMHOLE', // Wormhole bridge
  'HYPERLANE', // Hyperlane bridge
  'CUSTOM', // Custom implementation
]);

export const bridgeStatusEnum = pgEnum('bridge_status', [
  'ACTIVE', // Bridge is active and operational
  'INACTIVE', // Bridge is inactive but can be activated
  'PAUSED', // Bridge is temporarily paused
  'UPGRADING', // Bridge is being upgraded
  'FAILED', // Bridge has failed and needs maintenance
]);

// Oracle requests table
export const oracleRequests = pgTable('oracle_requests', {
  id: varchar('id', { length: 64 }).primaryKey(),
  dataType: oracleDataTypeEnum('data_type').notNull(),
  parameters: json('parameters').notNull(),
  sourceChain: varchar('source_chain', { length: 100 }),
  sourceAddress: varchar('source_address', { length: 100 }),
  callbackFunction: varchar('callback_function', { length: 100 }),
  requiredConfidence: doublePrecision('required_confidence').default(0.8),
  maxValidatorFee: doublePrecision('max_validator_fee'),
  deadline: timestamp('deadline'),
  status: oracleRequestStatusEnum('status').notNull().default('PENDING'),
  processedAt: timestamp('processed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  requestHash: varchar('request_hash', { length: 64 }),
  requestTxId: varchar('request_tx_id', { length: 100 }),
  error: text('error'),
  priority: integer('priority').default(1),
  requesterId: integer('requester_id'),
});

// Oracle responses table
export const oracleResponses = pgTable('oracle_responses', {
  id: varchar('id', { length: 64 }).primaryKey(),
  requestId: varchar('request_id', { length: 64 })
    .notNull()
    .references(() => oracleRequests.id),
  dataType: oracleDataTypeEnum('data_type').notNull(),
  data: json('data').notNull(),
  confidence: doublePrecision('confidence').notNull(),
  validatorCount: integer('validator_count').notNull(),
  timestamp: timestamp('timestamp').notNull(),
  respondedAt: timestamp('responded_at').notNull(),
  status: oracleResponseStatusEnum('status').notNull().default('READY'),
  sourceChain: varchar('source_chain', { length: 100 }),
  sourceAddress: varchar('source_address', { length: 100 }),
  deliveredAt: timestamp('delivered_at'),
  transactionHash: varchar('transaction_hash', { length: 100 }),
  hash: varchar('hash', { length: 64 }).notNull(),
  error: text('error'),
});

// Cross-chain bridges table
export const crossChainBridges = pgTable('cross_chain_bridges', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  provider: bridgeProviderEnum('provider').notNull(),
  sourceChain: varchar('source_chain', { length: 100 })
    .notNull()
    .default('wrfcoin'),
  targetChain: varchar('target_chain', { length: 100 }).notNull(),
  contractAddress: varchar('contract_address', { length: 100 }),
  providerApiKey: varchar('provider_api_key', { length: 255 }),
  status: bridgeStatusEnum('status').notNull().default('INACTIVE'),
  lastActive: timestamp('last_active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  config: json('config'),
  gasLimit: integer('gas_limit'),
  maxFeeAmount: doublePrecision('max_fee_amount'),
  securityLevel: integer('security_level').default(1),
  requiresApproval: boolean('requires_approval').default(false),
  approverRoles: text('approver_roles').array(),
});

// Validator participation in oracle requests
export const validatorOracleParticipation = pgTable('validator_oracle_participation', {
  id: serial('id').primaryKey(),
  validatorId: varchar('validator_id', { length: 64 }).notNull(),
  requestId: varchar('request_id', { length: 64 })
    .notNull()
    .references(() => oracleRequests.id),
  responseData: json('response_data'),
  confidence: doublePrecision('confidence'),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  signature: varchar('signature', { length: 255 }),
  accuracy: doublePrecision('accuracy'), // Filled after consensus reached
  rewardAmount: doublePrecision('reward_amount'),
  rewardTxId: varchar('reward_tx_id', { length: 100 }),
});

// Bridge transaction history
export const bridgeTransactions = pgTable('bridge_transactions', {
  id: serial('id').primaryKey(),
  bridgeId: integer('bridge_id')
    .notNull()
    .references(() => crossChainBridges.id),
  sourceChain: varchar('source_chain', { length: 100 }).notNull(),
  targetChain: varchar('target_chain', { length: 100 }).notNull(),
  sourceAddress: varchar('source_address', { length: 100 }),
  targetAddress: varchar('target_address', { length: 100 }),
  amount: doublePrecision('amount'),
  fee: doublePrecision('fee'),
  data: json('data'),
  sourceTxHash: varchar('source_tx_hash', { length: 100 }),
  targetTxHash: varchar('target_tx_hash', { length: 100 }),
  status: varchar('status', { length: 20 }).notNull(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  error: text('error'),
});

// Define relations
export const oracleRequestsRelations = relations(oracleRequests, ({ many }) => ({
  response: many(oracleResponses),
  validatorParticipation: many(validatorOracleParticipation),
}));

export const oracleResponsesRelations = relations(oracleResponses, ({ one }) => ({
  request: one(oracleRequests, {
    fields: [oracleResponses.requestId],
    references: [oracleRequests.id],
  }),
}));

export const crossChainBridgesRelations = relations(crossChainBridges, ({ many }) => ({
  transactions: many(bridgeTransactions),
}));

export const bridgeTransactionsRelations = relations(
  bridgeTransactions,
  ({ one }) => ({
    bridge: one(crossChainBridges, {
      fields: [bridgeTransactions.bridgeId],
      references: [crossChainBridges.id],
    }),
  })
);
