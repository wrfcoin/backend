/**
 * Consolidated Governance Schema
 * Simplified from 13 tables to 4 optimized tables
 * Maintains full democratic governance and treasury functionality
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
  bigint,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Table 1: Unified proposals and voting (replaces governance_proposals, governance_votes, governance_delegations)
export const proposalsConsolidated = pgTable('proposals_consolidated', {
  id: serial('id').primaryKey(),
  proposalId: varchar('proposal_id', { length: 64 }).notNull().unique(),
  proposalType: varchar('proposal_type', { length: 30 }).notNull(), // 'protocol_change', 'treasury_allocation', 'foundation_action', 'parameter_update', 'integration_rule'
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  proposerAddress: varchar('proposer_address', { length: 64 }).notNull(),
  proposalData: jsonb('proposal_data').notNull(),
  votingStartTime: timestamp('voting_start_time').notNull(),
  votingEndTime: timestamp('voting_end_time').notNull(),
  executionTime: timestamp('execution_time'),
  status: varchar('status', { length: 20 }).default('pending'), // 'pending', 'active', 'passed', 'rejected', 'executed', 'cancelled'
  voteCountFor: bigint('vote_count_for', { mode: 'bigint' }).default(BigInt(0)),
  voteCountAgainst: bigint('vote_count_against', { mode: 'bigint' }).default(
    BigInt(0)
  ),
  voteCountAbstain: bigint('vote_count_abstain', { mode: 'bigint' }).default(
    BigInt(0)
  ),
  quorumRequired: decimal('quorum_required', {
    precision: 5,
    scale: 2,
  }).notNull(),
  majorityRequired: decimal('majority_required', {
    precision: 5,
    scale: 2,
  }).notNull(),
  votes: jsonb('votes'), // array of individual votes with delegations
  delegations: jsonb('delegations'), // current delegation mappings for this proposal
  executionResult: jsonb('execution_result'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  proposalTypeIdx: index('idx_proposals_consolidated_type').on(table.proposalType),
  statusIdx: index('idx_proposals_consolidated_status').on(table.status),
  proposerIdx: index('idx_proposals_consolidated_proposer').on(table.proposerAddress),
  votingStartIdx: index('idx_proposals_consolidated_voting_start').on(table.votingStartTime),
  votingEndIdx: index('idx_proposals_consolidated_voting_end').on(table.votingEndTime),
}));

// Table 2: Unified treasury and financial management (replaces governance_treasury_transactions, governance_budget_categories, governance_contributions, governance_rewards)
export const treasuryConsolidated = pgTable('treasury_consolidated', {
  id: serial('id').primaryKey(),
  transactionId: varchar('transaction_id', { length: 64 }).notNull().unique(),
  transactionType: varchar('transaction_type', { length: 30 }).notNull(), // 'treasury_transaction', 'budget_allocation', 'contribution', 'reward_distribution'
  category: varchar('category', { length: 50 }), // budget category or contribution type
  fromAddress: varchar('from_address', { length: 64 }),
  toAddress: varchar('to_address', { length: 64 }),
  tokenAddress: varchar('token_address', { length: 64 }).notNull(),
  amount: decimal('amount', { precision: 36, scale: 18 }).notNull(),
  usdValue: decimal('usd_value', { precision: 20, scale: 8 }),
  description: text('description'),
  proposalId: varchar('proposal_id', { length: 64 }), // link to governing proposal if applicable
  budgetData: jsonb('budget_data'), // budget category information
  contributionData: jsonb('contribution_data'), // contribution details and metrics
  rewardData: jsonb('reward_data'), // reward calculation and distribution details
  approvalStatus: varchar('approval_status', { length: 20 }).default('pending'), // 'pending', 'approved', 'executed', 'rejected'
  approverAddress: varchar('approver_address', { length: 64 }),
  transactionHash: varchar('transaction_hash', { length: 64 }),
  blockNumber: integer('block_number'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  executedAt: timestamp('executed_at'),
}, (table) => ({
  transactionTypeIdx: index('idx_treasury_consolidated_type').on(table.transactionType),
  categoryIdx: index('idx_treasury_consolidated_category').on(table.category),
  approvalStatusIdx: index('idx_treasury_consolidated_approval').on(table.approvalStatus),
  proposalIdx: index('idx_treasury_consolidated_proposal').on(table.proposalId),
  fromAddressIdx: index('idx_treasury_consolidated_from').on(table.fromAddress),
}));

// Table 3: Unified foundation management (replaces governance_foundation_members, governance_foundation_actions, governance_phase_transitions)
export const foundationConsolidated = pgTable('foundation_consolidated', {
  id: serial('id').primaryKey(),
  recordId: varchar('record_id', { length: 64 }).notNull().unique(),
  recordType: varchar('record_type', { length: 30 }).notNull(), // 'member', 'action', 'phase_transition'
  memberAddress: varchar('member_address', { length: 64 }),
  memberRole: varchar('member_role', { length: 50 }), // 'founder', 'council_member', 'advisor', 'technical_lead'
  memberPermissions: jsonb('member_permissions'),
  actionType: varchar('action_type', { length: 50 }), // 'appointment', 'removal', 'role_change', 'emergency_action', 'phase_transition'
  actionDescription: text('action_description'),
  actionData: jsonb('action_data'),
  phaseFrom: varchar('phase_from', { length: 30 }), // for phase transitions
  phaseTo: varchar('phase_to', { length: 30 }), // for phase transitions
  transitionCriteria: jsonb('transition_criteria'), // criteria met for phase transition
  requiresApproval: boolean('requires_approval').default(true),
  approvalStatus: varchar('approval_status', { length: 20 }).default('pending'),
  approvalVotes: jsonb('approval_votes'), // foundation member approval votes
  executedBy: varchar('executed_by', { length: 64 }),
  executionData: jsonb('execution_data'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  executedAt: timestamp('executed_at'),
  expiresAt: timestamp('expires_at'),
}, (table) => ({
  recordTypeIdx: index('idx_foundation_consolidated_type').on(table.recordType),
  memberAddressIdx: index('idx_foundation_consolidated_member').on(table.memberAddress),
  approvalStatusIdx: index('idx_foundation_consolidated_approval').on(table.approvalStatus),
}));

// Table 4: Unified parameters and integration rules (replaces governance_parameters, governance_parameter_history, integration_governance)
export const parametersConsolidated = pgTable('parameters_consolidated', {
  id: serial('id').primaryKey(),
  parameterId: varchar('parameter_id', { length: 64 }).notNull().unique(),
  parameterType: varchar('parameter_type', { length: 30 }).notNull(), // 'protocol_parameter', 'integration_rule', 'governance_setting'
  parameterCategory: varchar('parameter_category', { length: 50 }).notNull(), // 'consensus', 'economic', 'governance', 'integration', 'security'
  parameterName: varchar('parameter_name', { length: 100 }).notNull(),
  currentValue: jsonb('current_value').notNull(),
  parameterHistory: jsonb('parameter_history'), // array of historical values with timestamps
  integrationScope: varchar('integration_scope', { length: 50 }), // for integration-specific rules
  integrationData: jsonb('integration_data'), // integration-specific configuration
  validationRules: jsonb('validation_rules'), // validation criteria for parameter values
  changeRequirements: jsonb('change_requirements'), // voting requirements for changes
  lastChangedBy: varchar('last_changed_by', { length: 64 }),
  lastChangeProposal: varchar('last_change_proposal', { length: 64 }), // proposal that last changed this parameter
  emergencyOverrideAllowed: boolean('emergency_override_allowed').default(
    false
  ),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  parameterTypeIdx: index('idx_parameters_consolidated_type').on(table.parameterType),
  parameterCategoryIdx: index('idx_parameters_consolidated_category').on(table.parameterCategory),
  isActiveIdx: index('idx_parameters_consolidated_active').on(table.isActive),
}));

// Relations
export const proposalsConsolidatedRelations = relations(
  proposalsConsolidated,
  ({ many }) => ({
    treasuryTransactions: many(treasuryConsolidated),
    parameterChanges: many(parametersConsolidated),
  })
);

export const treasuryConsolidatedRelations = relations(
  treasuryConsolidated,
  ({ one }) => ({
    proposal: one(proposalsConsolidated, {
      fields: [treasuryConsolidated.proposalId],
      references: [proposalsConsolidated.proposalId],
    }),
  })
);

export const foundationConsolidatedRelations = relations(
  foundationConsolidated,
  ({ many }) => ({
    relatedProposals: many(proposalsConsolidated),
  })
);

export const parametersConsolidatedRelations = relations(
  parametersConsolidated,
  ({ one }) => ({
    lastChangeProposalRef: one(proposalsConsolidated, {
      fields: [parametersConsolidated.lastChangeProposal],
      references: [proposalsConsolidated.proposalId],
    }),
  })
);

// Export all consolidated Governance tables
export const governanceConsolidatedSchema = {
  proposalsConsolidated,
  treasuryConsolidated,
  foundationConsolidated,
  parametersConsolidated,
};
