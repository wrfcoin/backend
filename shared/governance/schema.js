/**
 * Governance Schema for Wrfcoin
 *
 * This file defines the database schema for the governance system, including:
 * - Proposals: Core governance proposals
 * - Votes: Voting records with weighted voting
 * - Parameters: On-chain governance parameters
 * - Foundation: Wrfcoin Foundation governance structure with veto powers
 */

const {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  uuid,
} = require('drizzle-orm/pg-core');
const { relations } = require('drizzle-orm');

/**
 * Governance proposals
 */
const proposals = pgTable('governance_proposals', {
  id: serial('id').primaryKey(),
  uuid: uuid('uuid').notNull().defaultRandom(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  proposal_type: text('proposal_type').notNull(), // 'PARAMETER_CHANGE', 'TEXT', 'SOFTWARE_UPGRADE', etc.
  status: text('status').notNull().default('DEPOSIT_PERIOD'), // 'DEPOSIT_PERIOD', 'VOTING_PERIOD', 'PASSED', 'REJECTED', 'VETOED'
  proposer: text('proposer').notNull(),
  deposit_amount: numeric('deposit_amount').notNull().default('0'),
  deposit_threshold: numeric('deposit_threshold').notNull().default('1000'),
  voting_start_time: timestamp('voting_start_time'),
  voting_end_time: timestamp('voting_end_time'),
  submit_time: timestamp('submit_time').notNull().defaultNow(),
  yes_votes: numeric('yes_votes').notNull().default('0'),
  no_votes: numeric('no_votes').notNull().default('0'),
  abstain_votes: numeric('abstain_votes').notNull().default('0'),
  no_with_veto_votes: numeric('no_with_veto_votes').notNull().default('0'),
  total_votes: numeric('total_votes').notNull().default('0'),
  quorum_threshold: numeric('quorum_threshold').notNull().default('0.33'),
  pass_threshold: numeric('pass_threshold').notNull().default('0.5'),
  veto_threshold: numeric('veto_threshold').notNull().default('0.33'),
  parameter_changes: jsonb('parameter_changes'),
  software_upgrade: jsonb('software_upgrade'),
  vetoed_by: text('vetoed_by'),
  veto_reason: text('veto_reason'),
  executed_at: timestamp('executed_at'),
  metadata: jsonb('metadata'),
});

/**
 * Governance votes
 */
const votes = pgTable('governance_votes', {
  id: serial('id').primaryKey(),
  proposal_id: integer('proposal_id')
    .notNull()
    .references(() => proposals.id),
  voter: text('voter').notNull(),
  vote_option: text('vote_option').notNull(), // 'YES', 'NO', 'ABSTAIN', 'NO_WITH_VETO'
  token_amount: numeric('token_amount').notNull().default('0'),
  weight: numeric('weight').notNull().default('0'),
  achievement_bonus: numeric('achievement_bonus').default('0'),
  reputation_bonus: numeric('reputation_bonus').default('0'),
  voting_power: numeric('voting_power').notNull().default('0'),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

/**
 * Governance parameters
 */
const parameters = pgTable('governance_parameters', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  value: text('value').notNull(),
  data_type: text('data_type').notNull(), // 'STRING', 'NUMBER', 'BOOLEAN', 'JSON'
  description: text('description'),
  min_value: text('min_value'),
  max_value: text('max_value'),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
  is_active: boolean('is_active').notNull().default(true),
  updated_by_proposal: integer('updated_by_proposal').references(
    () => proposals.id
  ),
  metadata: jsonb('metadata'),
});

/**
 * Parameter history
 */
const parameterHistory = pgTable('governance_parameter_history', {
  id: serial('id').primaryKey(),
  parameter_id: integer('parameter_id')
    .notNull()
    .references(() => parameters.id),
  old_value: text('old_value').notNull(),
  new_value: text('new_value').notNull(),
  change_time: timestamp('change_time').notNull().defaultNow(),
  reason: text('reason'),
  proposal_id: integer('proposal_id').references(() => proposals.id),
  metadata: jsonb('metadata'),
});

/**
 * Voting delegations
 */
const delegations = pgTable('governance_delegations', {
  id: serial('id').primaryKey(),
  delegator: text('delegator').notNull(),
  delegate: text('delegate').notNull(),
  amount: numeric('amount').notNull().default('0'),
  created_at: timestamp('created_at').notNull().defaultNow(),
  is_active: boolean('is_active').notNull().default(true),
  metadata: jsonb('metadata'),
});

/**
 * Wrfcoin Foundation members
 */
const foundationMembers = pgTable('governance_foundation_members', {
  id: serial('id').primaryKey(),
  address: text('address').notNull().unique(),
  name: text('name').notNull(),
  role: text('role').notNull(), // 'DIRECTOR', 'TECHNICAL_CHAIR', etc.
  join_date: timestamp('join_date').notNull().defaultNow(),
  veto_rights: boolean('veto_rights').notNull().default(true),
  veto_rights_expiry: timestamp('veto_rights_expiry'),
  is_active: boolean('is_active').notNull().default(true),
  metadata: jsonb('metadata'),
});

/**
 * Record of foundation actions (especially vetoes)
 */
const foundationActions = pgTable('governance_foundation_actions', {
  id: serial('id').primaryKey(),
  member_address: text('member_address').notNull(),
  action_type: text('action_type').notNull(), // 'VETO', 'PARAMETER_CHANGE', etc.
  action_time: timestamp('action_time').notNull().defaultNow(),
  proposal_id: integer('proposal_id').references(() => proposals.id),
  description: text('description'),
  metadata: jsonb('metadata'),
});

/**
 * Node reputation for voting weight calculation
 */
const nodeReputation = pgTable('node_reputation', {
  id: serial('id').primaryKey(),
  address: text('address').notNull().unique(),
  reputation_score: numeric('reputation_score').notNull().default('0'),
  uptime_percentage: numeric('uptime_percentage').notNull().default('0'),
  validations_performed: integer('validations_performed').notNull().default(0),
  successful_validations: integer('successful_validations')
    .notNull()
    .default(0),
  data_contributions_count: integer('data_contributions_count')
    .notNull()
    .default(0),
  last_updated: timestamp('last_updated').notNull().defaultNow(),
  metadata: jsonb('metadata'),
});

// Export all schema elements
module.exports = {
  proposals,
  votes,
  parameters,
  parameterHistory,
  delegations,
  foundationMembers,
  foundationActions,
  nodeReputation,
};
