import {
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
  serial,
  numeric,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * Governance proposals table
 */
export const proposals = pgTable('governance_proposals', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  proposalType: text('proposal_type').notNull(), // TEXT, PARAMETER_CHANGE, UPGRADE, etc.
  status: text('status').notNull().default('DEPOSIT'), // DEPOSIT, VOTING, PASSED, REJECTED, VETOED
  proposer: text('proposer').notNull(),
  deposit: numeric('deposit').notNull(),
  votingStartTime: timestamp('voting_start_time'),
  votingEndTime: timestamp('voting_end_time'),
  submitTime: timestamp('submit_time').notNull().defaultNow(),
  totalYes: numeric('total_yes').default('0'),
  totalNo: numeric('total_no').default('0'),
  totalNoWithVeto: numeric('total_no_with_veto').default('0'),
  totalAbstain: numeric('total_abstain').default('0'),
  parametersToChange: jsonb('parameters_to_change'),
  hash: text('hash'),
  metadata: jsonb('metadata'),
});

/**
 * Votes on governance proposals
 */
export const votes = pgTable('governance_votes', {
  id: serial('id').primaryKey(),
  proposalId: integer('proposal_id')
    .notNull()
    .references(() => proposals.id),
  voter: text('voter').notNull(),
  voteOption: text('vote_option').notNull(), // YES, NO, NO_WITH_VETO, ABSTAIN
  weight: numeric('weight').notNull().default('1'),
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
  dataType: text('data_type').notNull(), // NUMBER, STRING, BOOLEAN, etc.
  description: text('description'),
  minValue: text('min_value'),
  maxValue: text('max_value'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  active: boolean('active').notNull().default(true),
  metadata: jsonb('metadata'),
});

/**
 * History of parameter changes
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
  role: text('role').notNull(), // DIRECTOR, TECHNICAL_CHAIR, etc.
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
  actionType: text('action_type').notNull(), // VETO, PARAMETER_CHANGE, etc.
  actionTime: timestamp('action_time').notNull().defaultNow(),
  proposalId: integer('proposal_id').references(() => proposals.id),
  description: text('description'),
  metadata: jsonb('metadata'),
});

/**
 * Governance phase transitions (Foundation control -> Full DAO)
 */
export const governancePhaseTransitions = pgTable(
  'governance_phase_transitions',
  {
    id: serial('id').primaryKey(),
    phase: text('phase').notNull(), // FOUNDATION_CONTROL, FULL_DAO
    description: text('description'),
    startDate: timestamp('start_date').notNull(),
    endDate: timestamp('end_date'),
    foundationVetoEnabled: boolean('foundation_veto_enabled')
      .notNull()
      .default(true),
    votingWeightConfig: jsonb('voting_weight_config').notNull(),
    metadata: jsonb('metadata'),
  }
);

// Relations
export const proposalsRelations = relations(proposals, ({ many }) => ({
  votes: many(votes),
  parameterHistory: many(parameterHistory),
  foundationActions: many(foundationActions),
}));

export const votesRelations = relations(votes, ({ one }) => ({
  proposal: one(proposals, {
    fields: [votes.proposalId],
    references: [proposals.id],
  }),
}));

export const parametersRelations = relations(parameters, ({ many }) => ({
  history: many(parameterHistory),
}));

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

// Types
export type Proposal = typeof proposals.$inferSelect;
export type InsertProposal = typeof proposals.$inferInsert;

export type Vote = typeof votes.$inferSelect;
export type InsertVote = typeof votes.$inferInsert;

export type Parameter = typeof parameters.$inferSelect;
export type InsertParameter = typeof parameters.$inferInsert;

export type ParameterHistory = typeof parameterHistory.$inferSelect;
export type InsertParameterHistory = typeof parameterHistory.$inferInsert;

export type Delegation = typeof delegations.$inferSelect;
export type InsertDelegation = typeof delegations.$inferInsert;

export type FoundationMember = typeof foundationMembers.$inferSelect;
export type InsertFoundationMember = typeof foundationMembers.$inferInsert;

export type FoundationAction = typeof foundationActions.$inferSelect;
export type InsertFoundationAction = typeof foundationActions.$inferInsert;

export type GovernancePhaseTransition =
  typeof governancePhaseTransitions.$inferSelect;
export type InsertGovernancePhaseTransition =
  typeof governancePhaseTransitions.$inferInsert;
