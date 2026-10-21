/**
 * Governance Schema for Wrfcoin
 *
 * This file defines the database schema for the governance system, including:
 * - Proposals: Core governance proposals
 * - Votes: Voting records with weighted voting
 * - Parameters: On-chain governance parameters
 * - Foundation: Wrfcoin Foundation governance structure with veto powers
 */

import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * Governance proposals
 */
export const proposals = pgTable('governance_proposals', {
  id: serial('id').primaryKey(),
  uuid: uuid('uuid').notNull().defaultRandom(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  proposalType: text('proposal_type').notNull(), // 'PARAMETER_CHANGE', 'TEXT', 'SOFTWARE_UPGRADE', etc.
  status: text('status').notNull().default('DEPOSIT_PERIOD'), // 'DEPOSIT_PERIOD', 'VOTING_PERIOD', 'PASSED', 'REJECTED', 'VETOED'
  proposer: text('proposer').notNull(),
  depositAmount: numeric('deposit_amount').notNull().default('0'),
  depositThreshold: numeric('deposit_threshold').notNull().default('1000'),
  votingStartTime: timestamp('voting_start_time'),
  votingEndTime: timestamp('voting_end_time'),
  submitTime: timestamp('submit_time').notNull().defaultNow(),
  yesVotes: numeric('yes_votes').notNull().default('0'),
  noVotes: numeric('no_votes').notNull().default('0'),
  abstainVotes: numeric('abstain_votes').notNull().default('0'),
  noWithVetoVotes: numeric('no_with_veto_votes').notNull().default('0'),
  totalVotes: numeric('total_votes').notNull().default('0'),
  quorumThreshold: numeric('quorum_threshold').notNull().default('0.33'),
  passThreshold: numeric('pass_threshold').notNull().default('0.5'),
  vetoThreshold: numeric('veto_threshold').notNull().default('0.33'),
  parameterChanges: jsonb('parameter_changes'),
  softwareUpgrade: jsonb('software_upgrade'),
  vetoedBy: text('vetoed_by'),
  vetoReason: text('veto_reason'),
  executedAt: timestamp('executed_at'),
  metadata: jsonb('metadata'),
});

/**
 * Governance votes
 */
export const votes = pgTable('governance_votes', {
  id: serial('id').primaryKey(),
  proposalId: integer('proposal_id')
    .notNull()
    .references(() => proposals.id),
  voter: text('voter').notNull(),
  voteOption: text('vote_option').notNull(), // 'YES', 'NO', 'ABSTAIN', 'NO_WITH_VETO'
  tokenAmount: numeric('token_amount').notNull().default('0'),
  weight: numeric('weight').notNull().default('0'),
  achievementBonus: numeric('achievement_bonus').default('0'),
  reputationBonus: numeric('reputation_bonus').default('0'),
  votingPower: numeric('voting_power').notNull().default('0'),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

/**
 * Governance parameters
 */
export const parameters = pgTable('governance_parameters', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  value: text('value').notNull(),
  dataType: text('data_type').notNull(), // 'STRING', 'NUMBER', 'BOOLEAN', 'JSON'
  description: text('description'),
  minValue: text('min_value'),
  maxValue: text('max_value'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  active: boolean('active').notNull().default(true),
  updatedByProposal: integer('updated_by_proposal').references(
    () => proposals.id
  ),
  metadata: jsonb('metadata'),
});

/**
 * Parameter history
 */
export const parameterHistory = pgTable('governance_parameter_history', {
  id: serial('id').primaryKey(),
  parameterId: integer('parameter_id')
    .notNull()
    .references(() => parameters.id),
  oldValue: text('old_value').notNull(),
  newValue: text('new_value').notNull(),
  changeTime: timestamp('change_time').notNull().defaultNow(),
  reason: text('reason'),
  proposalId: integer('proposal_id').references(() => proposals.id),
  metadata: jsonb('metadata'),
});

/**
 * Voting delegations
 */
export const delegations = pgTable('governance_delegations', {
  id: serial('id').primaryKey(),
  delegator: text('delegator').notNull(),
  delegate: text('delegate').notNull(),
  amount: numeric('amount').notNull().default('0'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  active: boolean('active').notNull().default(true),
  metadata: jsonb('metadata'),
});

/**
 * Wrfcoin Foundation members
 */
export const foundationMembers = pgTable('governance_foundation_members', {
  id: serial('id').primaryKey(),
  address: text('address').notNull().unique(),
  name: text('name').notNull(),
  role: text('role').notNull(), // 'DIRECTOR', 'TECHNICAL_CHAIR', etc.
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
  vetoRights: boolean('veto_rights').notNull().default(true),
  vetoRightsExpiry: timestamp('veto_rights_expiry'),
  active: boolean('active').notNull().default(true),
  metadata: jsonb('metadata'),
});

/**
 * Record of foundation actions (especially vetoes)
 */
export const foundationActions = pgTable('governance_foundation_actions', {
  id: serial('id').primaryKey(),
  memberAddress: text('member_address').notNull(),
  actionType: text('action_type').notNull(), // 'VETO', 'PARAMETER_CHANGE', etc.
  actionTime: timestamp('action_time').notNull().defaultNow(),
  proposalId: integer('proposal_id').references(() => proposals.id),
  description: text('description'),
  metadata: jsonb('metadata'),
});

/**
 * Node reputation for voting weight calculation
 */
export const nodeReputation = pgTable('node_reputation', {
  id: serial('id').primaryKey(),
  address: text('address').notNull().unique(),
  reputationScore: numeric('reputation_score').notNull().default('0'),
  uptimePercentage: numeric('uptime_percentage').notNull().default('0'),
  validationsPerformed: integer('validations_performed').notNull().default(0),
  successfulValidations: integer('successful_validations').notNull().default(0),
  dataContributionsCount: integer('data_contributions_count')
    .notNull()
    .default(0),
  lastUpdated: timestamp('last_updated').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

/**
 * Governance schema relations
 */

// Proposal relations
export const proposalRelations = relations(proposals, ({ many }) => ({
  votes: many(votes),
  updatedParameters: many(parameters),
  foundationActions: many(foundationActions),
}));

// Vote relations
export const voteRelations = relations(votes, ({ one }) => ({
  proposal: one(proposals, {
    fields: [votes.proposalId],
    references: [proposals.id],
  }),
}));

// Parameter relations
export const parameterRelations = relations(parameters, ({ many, one }) => ({
  history: many(parameterHistory),
  updatedByProposal: one(proposals, {
    fields: [parameters.updatedByProposal],
    references: [proposals.id],
  }),
}));

// Parameter history relations
export const parameterHistoryRelations = relations(
  parameterHistory,
  ({ one }) => ({
    parameter: one(parameters, {
      fields: [parameterHistory.parameterId],
      references: [parameters.id],
    }),
    proposal: one(proposals, {
      fields: [parameterHistory.proposalId],
      references: [proposals.id],
    }),
  })
);

// Foundation action relations
export const foundationActionRelations = relations(
  foundationActions,
  ({ one }) => ({
    proposal: one(proposals, {
      fields: [foundationActions.proposalId],
      references: [proposals.id],
    }),
  })
);
