/**
 * Consolidated Users Schema
 * Simplified from 11 tables to 4 optimized tables
 * Maintains full user management, identity, reputation, and network functionality
 */

import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  decimal,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Table 1: Unified account management (replaces users, user_operations, smart_wallets)
export const accountsConsolidated = pgTable('accounts_consolidated', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 64 }).notNull().unique(),
  accountType: varchar('account_type', { length: 30 }).notNull(), // 'individual', 'organization', 'validator', 'developer'
  username: varchar('username', { length: 50 }).unique(),
  email: varchar('email', { length: 255 }),
  profileData: jsonb('profile_data').notNull(),
  walletAddresses: jsonb('wallet_addresses'), // array of associated wallet addresses
  smartWalletConfig: jsonb('smart_wallet_config'), // smart contract wallet configuration
  operationsHistory: jsonb('operations_history'), // embedded user operations history
  accountStatus: varchar('account_status', { length: 20 }).default('active'), // 'active', 'suspended', 'pending_verification', 'deactivated'
  verificationStatus: varchar('verification_status', { length: 20 }).default(
    'unverified'
  ), // 'unverified', 'pending', 'verified', 'rejected'
  verificationData: jsonb('verification_data'), // KYC and verification information
  preferences: jsonb('preferences'), // user preferences and settings
  securitySettings: jsonb('security_settings'), // security configuration
  lastLogin: timestamp('last_login'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  accountTypeIdx: index('idx_accounts_consolidated_type').on(table.accountType),
  accountStatusIdx: index('idx_accounts_consolidated_status').on(table.accountStatus),
  verificationStatusIdx: index('idx_accounts_consolidated_verification').on(table.verificationStatus),
}));

// Table 2: Unified identity and credentials (replaces decentralized_identities, verifiable_credentials)
export const identityConsolidated = pgTable('identity_consolidated', {
  id: serial('id').primaryKey(),
  identityId: varchar('identity_id', { length: 64 }).notNull().unique(),
  userId: varchar('user_id', { length: 64 }).notNull(),
  identityType: varchar('identity_type', { length: 30 }).notNull(), // 'did_document', 'verifiable_credential', 'identity_proof'
  didDocument: jsonb('did_document'), // complete DID document
  credentialType: varchar('credential_type', { length: 50 }), // for verifiable credentials
  credentialData: jsonb('credential_data'), // credential content and metadata
  issuerDid: varchar('issuer_did', { length: 255 }), // credential issuer DID
  holderDid: varchar('holder_did', { length: 255 }), // credential holder DID
  issuanceDate: timestamp('issuance_date'),
  expirationDate: timestamp('expiration_date'),
  revocationStatus: varchar('revocation_status', { length: 20 }).default(
    'active'
  ), // 'active', 'revoked', 'suspended', 'expired'
  verificationMethod: jsonb('verification_method'), // cryptographic verification data
  proofData: jsonb('proof_data'), // cryptographic proofs
  credentialSchema: varchar('credential_schema', { length: 255 }), // schema reference
  trustLevel: integer('trust_level').default(0), // calculated trust level
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_identity_consolidated_user').on(table.userId),
  identityTypeIdx: index('idx_identity_consolidated_type').on(table.identityType),
  revocationStatusIdx: index('idx_identity_consolidated_revocation').on(table.revocationStatus),
  holderDidIdx: index('idx_identity_consolidated_holder').on(table.holderDid),
}));

// Table 3: Unified reputation system (replaces reputation_events, reputation_rankings, reputation_scores)
export const reputationConsolidated = pgTable('reputation_consolidated', {
  id: serial('id').primaryKey(),
  reputationId: varchar('reputation_id', { length: 64 }).notNull().unique(),
  userId: varchar('user_id', { length: 64 }).notNull(),
  reputationType: varchar('reputation_type', { length: 30 }).notNull(), // 'event', 'score', 'ranking'
  eventType: varchar('event_type', { length: 50 }), // for reputation events
  eventDescription: text('event_description'),
  eventData: jsonb('event_data'), // event details and context
  scoreCategory: varchar('score_category', { length: 50 }), // 'governance', 'technical', 'community', 'financial'
  currentScore: decimal('current_score', { precision: 10, scale: 2 }), // current reputation score
  scoreHistory: jsonb('score_history'), // historical score changes
  rankingPosition: integer('ranking_position'), // current ranking position
  rankingCategory: varchar('ranking_category', { length: 50 }), // ranking category
  rankingData: jsonb('ranking_data'), // ranking calculation details
  calculationMethod: varchar('calculation_method', { length: 50 }), // how score was calculated
  scoreFactors: jsonb('score_factors'), // factors contributing to score
  peerRatings: jsonb('peer_ratings'), // ratings from other users
  activityMetrics: jsonb('activity_metrics'), // user activity measurements
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_reputation_consolidated_user').on(table.userId),
  reputationTypeIdx: index('idx_reputation_consolidated_type').on(table.reputationType),
  scoreCategoryIdx: index('idx_reputation_consolidated_score_category').on(table.scoreCategory),
}));

// Table 4: Unified network participation (replaces delegations, voting_power, node_peers)
export const networkConsolidated = pgTable('network_consolidated', {
  id: serial('id').primaryKey(),
  networkId: varchar('network_id', { length: 64 }).notNull().unique(),
  userId: varchar('user_id', { length: 64 }).notNull(),
  participationType: varchar('participation_type', { length: 30 }).notNull(), // 'delegation', 'voting_power', 'peer_relationship', 'validator_role'
  delegationData: jsonb('delegation_data'), // delegation relationships and power
  votingPower: decimal('voting_power', { precision: 20, scale: 8 }), // calculated voting power
  votingHistory: jsonb('voting_history'), // historical voting participation
  peerConnections: jsonb('peer_connections'), // network peer relationships
  nodeInformation: jsonb('node_information'), // node operation details
  networkRole: varchar('network_role', { length: 50 }), // 'validator', 'delegator', 'peer', 'observer'
  stakeAmount: decimal('stake_amount', { precision: 36, scale: 18 }), // staked tokens
  delegationRelationships: jsonb('delegation_relationships'), // who delegates to this user
  validatorPerformance: jsonb('validator_performance'), // validator performance metrics
  networkContributions: jsonb('network_contributions'), // contributions to network health
  slashingHistory: jsonb('slashing_history'), // any slashing events
  rewardsEarned: decimal('rewards_earned', { precision: 36, scale: 18 }), // network participation rewards
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_network_consolidated_user').on(table.userId),
  participationTypeIdx: index('idx_network_consolidated_participation').on(table.participationType),
  networkRoleIdx: index('idx_network_consolidated_role').on(table.networkRole),
  isActiveIdx: index('idx_network_consolidated_active').on(table.isActive),
}));

// Relations
export const accountsConsolidatedRelations = relations(
  accountsConsolidated,
  ({ one, many }) => ({
    identity: many(identityConsolidated),
    reputation: many(reputationConsolidated),
    networkParticipation: many(networkConsolidated),
  })
);

export const identityConsolidatedRelations = relations(
  identityConsolidated,
  ({ one }) => ({
    account: one(accountsConsolidated, {
      fields: [identityConsolidated.userId],
      references: [accountsConsolidated.userId],
    }),
  })
);

export const reputationConsolidatedRelations = relations(
  reputationConsolidated,
  ({ one }) => ({
    account: one(accountsConsolidated, {
      fields: [reputationConsolidated.userId],
      references: [accountsConsolidated.userId],
    }),
  })
);

export const networkConsolidatedRelations = relations(
  networkConsolidated,
  ({ one }) => ({
    account: one(accountsConsolidated, {
      fields: [networkConsolidated.userId],
      references: [accountsConsolidated.userId],
    }),
  })
);

// Export all consolidated Users tables
export const usersConsolidatedSchema = {
  accountsConsolidated,
  identityConsolidated,
  reputationConsolidated,
  networkConsolidated,
};
