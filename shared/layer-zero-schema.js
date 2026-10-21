/**
 * Wrfcoin LayerZero Database Schema
 *
 * This module defines the database schema for the LayerZero integration,
 * including tables for chains, messages, token transfers, adapter parameters, and relayers.
 */

const {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  json,
  jsonb,
  boolean,
  numeric,
} = require('drizzle-orm/pg-core');

/**
 * Chain configuration table
 * Stores information about supported chains for LayerZero integration
 */
const layerZeroChains = pgTable('layer_zero_chains', {
  id: serial('id').primaryKey(),
  chainId: integer('chain_id').notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 50 }).notNull(),
  rpc: varchar('rpc', { length: 255 }).notNull(),
  explorer: varchar('explorer', { length: 255 }),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  decimals: integer('decimals').notNull(),
  blockTime: numeric('block_time').notNull(),
  endpoint: varchar('endpoint', { length: 255 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  gasPrice: varchar('gas_price', { length: 50 }),
  networkId: integer('network_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at'),
});

/**
 * Cross-chain message table
 * Stores messages sent between chains
 */
const layerZeroMessages = pgTable('layer_zero_messages', {
  id: serial('id').primaryKey(),
  messageId: varchar('message_id', { length: 255 }).notNull().unique(),
  sourceChainId: integer('source_chain_id').notNull(),
  destinationChainId: integer('destination_chain_id').notNull(),
  sender: varchar('sender', { length: 255 }).notNull(),
  receiver: varchar('receiver', { length: 255 }).notNull(),
  payload: jsonb('payload'),
  messageType: varchar('message_type', { length: 50 }).notNull(),
  status: varchar('status', { length: 50 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at'),
  transactionHash: varchar('transaction_hash', { length: 255 }),
  errorMessage: text('error_message'),
  gasUsed: integer('gas_used'),
  adapterParams: jsonb('adapter_params'),
  verificationProof: text('verification_proof'),
});

/**
 * Cross-chain token transfer table
 * Stores token transfers between chains
 */
const layerZeroTokenTransfers = pgTable('layer_zero_token_transfers', {
  id: serial('id').primaryKey(),
  transferId: varchar('transfer_id', { length: 255 }).notNull().unique(),
  sourceChainId: integer('source_chain_id').notNull(),
  destinationChainId: integer('destination_chain_id').notNull(),
  tokenType: varchar('token_type', { length: 50 }).notNull(),
  tokenAddress: varchar('token_address', { length: 255 }),
  senderAddress: varchar('sender_address', { length: 255 }).notNull(),
  recipientAddress: varchar('recipient_address', { length: 255 }).notNull(),
  amount: varchar('amount', { length: 50 }).notNull(),
  tokenId: varchar('token_id', { length: 255 }),
  status: varchar('status', { length: 50 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  sourceTransactionHash: varchar('source_transaction_hash', { length: 255 }),
  destinationTransactionHash: varchar('destination_transaction_hash', {
    length: 255,
  }),
  errorMessage: text('error_message'),
  gasUsed: integer('gas_used'),
  fee: varchar('fee', { length: 50 }),
  verificationProof: text('verification_proof'),
});

/**
 * Adapter parameters table
 * Stores configuration for chain-specific adapters
 */
const layerZeroAdapterParams = pgTable('layer_zero_adapter_params', {
  id: serial('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  adapterType: varchar('adapter_type', { length: 50 }).notNull(),
  version: varchar('version', { length: 20 }).notNull(),
  defaultGasLimit: integer('default_gas_limit'),
  defaultGasPrice: varchar('default_gas_price', { length: 50 }),
  endpoint: varchar('endpoint', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at'),
  isActive: boolean('is_active').notNull().default(true),
  configuration: jsonb('configuration'),
});

/**
 * Relayer information table
 * Stores information about trusted relayers for cross-chain messages
 */
const layerZeroRelayers = pgTable('layer_zero_relayers', {
  id: serial('id').primaryKey(),
  relayerId: varchar('relayer_id', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  address: varchar('address', { length: 255 }).notNull(),
  supportedChains: jsonb('supported_chains').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  fee: numeric('fee'),
  reputation: integer('reputation'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at'),
});

module.exports = {
  layerZeroChains,
  layerZeroMessages,
  layerZeroTokenTransfers,
  layerZeroAdapterParams,
  layerZeroRelayers,
};
