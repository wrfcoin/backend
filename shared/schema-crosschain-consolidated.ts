/**
 * Consolidated CrossChain Schema
 * Simplified from 16 tables to 4 optimized tables
 * Supports all 13 bridge integrations in unified structure
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
  bigint,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Table 1: Unified protocol configurations (replaces cross_chain_bridges, axelar_chains, layer_zero_chains, layer_zero_adapter_params, layer_zero_relayers)
export const protocolsConsolidated = pgTable('protocols_consolidated', {
  id: serial('id').primaryKey(),
  protocolId: varchar('protocol_id', { length: 64 }).notNull().unique(),
  protocolType: varchar('protocol_type', { length: 20 }).notNull(), // 'axelar', 'layerzero', 'wormhole', 'stargate', 'synapse', 'hop', 'arbitrum_bridge', 'optimism_bridge', 'polygon_bridge', 'avalanche_bridge', 'bsc_bridge', 'fantom_bridge', 'harmony_bridge'
  protocolName: varchar('protocol_name', { length: 100 }).notNull(),
  chainId: integer('chain_id'),
  chainName: varchar('chain_name', { length: 50 }),
  endpointUrl: varchar('endpoint_url', { length: 255 }),
  contractAddress: varchar('contract_address', { length: 64 }),
  isActive: boolean('is_active').notNull().default(true),
  configuration: jsonb('configuration'),
  adapterParams: jsonb('adapter_params'),
  relayerConfig: jsonb('relayer_config'),
  feeStructure: jsonb('fee_structure'),
  supportedTokens: jsonb('supported_tokens'),
  gasLimits: jsonb('gas_limits'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  protocolTypeIdx: index('idx_protocols_consolidated_type').on(table.protocolType),
  isActiveIdx: index('idx_protocols_consolidated_active').on(table.isActive),
  chainIdIdx: index('idx_protocols_consolidated_chain').on(table.chainId),
}));

// Table 2: Unified cross-chain transfers (replaces bridge_transactions, cross_chain_transfers, axelar_transfers, layer_zero_token_transfers, wormhole_transfers, wormhole_nft_transfers)
export const transfersConsolidated = pgTable('transfers_consolidated', {
  id: serial('id').primaryKey(),
  transferId: varchar('transfer_id', { length: 64 }).notNull().unique(),
  protocolType: varchar('protocol_type', { length: 20 }).notNull(),
  transferType: varchar('transfer_type', { length: 20 }).notNull(), // 'token', 'nft', 'message'
  fromChainId: integer('from_chain_id').notNull(),
  toChainId: integer('to_chain_id').notNull(),
  fromAddress: varchar('from_address', { length: 64 }).notNull(),
  toAddress: varchar('to_address', { length: 64 }).notNull(),
  tokenAddress: varchar('token_address', { length: 64 }),
  tokenId: varchar('token_id', { length: 64 }), // for NFTs
  amount: decimal('amount', { precision: 36, scale: 18 }),
  feeAmount: decimal('fee_amount', { precision: 36, scale: 18 }),
  status: varchar('status', { length: 20 }).default('pending'), // 'pending', 'processing', 'completed', 'failed', 'refunded'
  transactionHash: varchar('transaction_hash', { length: 64 }),
  destinationHash: varchar('destination_hash', { length: 64 }),
  bridgeTransactionId: varchar('bridge_transaction_id', { length: 64 }),
  proofData: jsonb('proof_data'),
  metadata: jsonb('metadata'),
  initiatedAt: timestamp('initiated_at').notNull(),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  protocolTypeIdx: index('idx_transfers_consolidated_protocol').on(table.protocolType),
  fromAddressIdx: index('idx_transfers_consolidated_from').on(table.fromAddress),
  toAddressIdx: index('idx_transfers_consolidated_to').on(table.toAddress),
  statusIdx: index('idx_transfers_consolidated_status').on(table.status),
  initiatedAtIdx: index('idx_transfers_consolidated_initiated').on(table.initiatedAt),
  chainsIdx: index('idx_transfers_consolidated_chains').on(table.fromChainId, table.toChainId),
}));

// Table 3: Unified cross-chain messages (replaces axelar_messages, layer_zero_messages, wormhole_messages, wormhole_vaas)
export const messagesConsolidated = pgTable('messages_consolidated', {
  id: serial('id').primaryKey(),
  messageId: varchar('message_id', { length: 64 }).notNull().unique(),
  protocolType: varchar('protocol_type', { length: 20 }).notNull(),
  messageType: varchar('message_type', { length: 30 }).notNull(), // 'general_message', 'vaa', 'relay_message', 'adapter_params'
  fromChainId: integer('from_chain_id').notNull(),
  toChainId: integer('to_chain_id').notNull(),
  senderAddress: varchar('sender_address', { length: 64 }).notNull(),
  recipientAddress: varchar('recipient_address', { length: 64 }).notNull(),
  payload: jsonb('payload').notNull(),
  nonce: bigint('nonce', { mode: 'bigint' }),
  gasLimit: bigint('gas_limit', { mode: 'bigint' }),
  gasPrice: decimal('gas_price', { precision: 36, scale: 18 }),
  status: varchar('status', { length: 20 }).default('pending'), // 'pending', 'relayed', 'delivered', 'failed'
  signatureData: jsonb('signature_data'),
  proofData: jsonb('proof_data'),
  executionData: jsonb('execution_data'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  relayedAt: timestamp('relayed_at'),
  deliveredAt: timestamp('delivered_at'),
}, (table) => ({
  protocolTypeIdx: index('idx_messages_consolidated_protocol').on(table.protocolType),
  senderIdx: index('idx_messages_consolidated_sender').on(table.senderAddress),
  statusIdx: index('idx_messages_consolidated_status').on(table.status),
  createdAtIdx: index('idx_messages_consolidated_created').on(table.createdAt),
  chainsIdx: index('idx_messages_consolidated_chains').on(table.fromChainId, table.toChainId),
}));

// Table 4: Unified cross-chain token registry (replaces axelar_tokens and protocol-specific token configurations)
export const tokensConsolidated = pgTable('tokens_consolidated', {
  id: serial('id').primaryKey(),
  tokenId: varchar('token_id', { length: 64 }).notNull().unique(),
  protocolType: varchar('protocol_type', { length: 20 }).notNull(),
  symbol: varchar('symbol', { length: 20 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  decimals: integer('decimals').notNull(),
  isNative: boolean('is_native').default(false),
  originChainId: integer('origin_chain_id').notNull(),
  originAddress: varchar('origin_address', { length: 64 }).notNull(),
  tokenMappings: jsonb('token_mappings'), // chain_id -> contract_address mappings
  bridgeConfigs: jsonb('bridge_configs'), // protocol-specific bridge configurations
  metadata: jsonb('metadata'),
  isActive: boolean('is_active').default(true),
  totalSupply: decimal('total_supply', { precision: 36, scale: 18 }),
  circulatingSupply: decimal('circulating_supply', {
    precision: 36,
    scale: 18,
  }),
  bridgeLiquidity: jsonb('bridge_liquidity'), // per-chain liquidity data
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  protocolTypeIdx: index('idx_tokens_consolidated_protocol').on(table.protocolType),
  symbolIdx: index('idx_tokens_consolidated_symbol').on(table.symbol),
  isActiveIdx: index('idx_tokens_consolidated_active').on(table.isActive),
  originChainIdx: index('idx_tokens_consolidated_origin_chain').on(table.originChainId),
}));

// Relations
export const protocolsConsolidatedRelations = relations(
  protocolsConsolidated,
  ({ many }) => ({
    transfers: many(transfersConsolidated),
    messages: many(messagesConsolidated),
    tokens: many(tokensConsolidated),
  })
);

export const transfersConsolidatedRelations = relations(
  transfersConsolidated,
  ({ one }) => ({
    protocol: one(protocolsConsolidated, {
      fields: [transfersConsolidated.protocolType],
      references: [protocolsConsolidated.protocolType],
    }),
  })
);

export const messagesConsolidatedRelations = relations(
  messagesConsolidated,
  ({ one }) => ({
    protocol: one(protocolsConsolidated, {
      fields: [messagesConsolidated.protocolType],
      references: [protocolsConsolidated.protocolType],
    }),
  })
);

export const tokensConsolidatedRelations = relations(
  tokensConsolidated,
  ({ one, many }) => ({
    protocol: one(protocolsConsolidated, {
      fields: [tokensConsolidated.protocolType],
      references: [protocolsConsolidated.protocolType],
    }),
    transfers: many(transfersConsolidated),
  })
);

// Export all consolidated CrossChain tables
export const crosschainConsolidatedSchema = {
  protocolsConsolidated,
  transfersConsolidated,
  messagesConsolidated,
  tokensConsolidated,
};
