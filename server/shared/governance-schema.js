/**
 * Governance Schema - JavaScript Version
 *
 * This file contains the schema definitions for the governance system in plain JavaScript,
 * matched to match the TypeScript definitions for compatibility.
 */

// Mock the table structure to match drizzle schema objects
const createTable = (name, columns) => ({
  name,
  columns,
});

// Define tables
const proposals = createTable('governance_proposals', {
  id: 'serial',
  title: 'text',
  description: 'text',
  proposalType: 'text',
  status: 'text',
  proposer: 'text',
  deposit: 'numeric',
  votingStartTime: 'timestamp',
  votingEndTime: 'timestamp',
  submitTime: 'timestamp',
  totalYes: 'numeric',
  totalNo: 'numeric',
  totalNoWithVeto: 'numeric',
  totalAbstain: 'numeric',
  parametersToChange: 'jsonb',
  hash: 'text',
  metadata: 'jsonb',
});

const votes = createTable('governance_votes', {
  id: 'serial',
  proposalId: 'integer',
  voter: 'text',
  voteOption: 'text',
  weight: 'numeric',
  timestamp: 'timestamp',
  metadata: 'jsonb',
});

const parameters = createTable('governance_parameters', {
  id: 'serial',
  name: 'text',
  value: 'text',
  dataType: 'text',
  description: 'text',
  minValue: 'text',
  maxValue: 'text',
  updatedAt: 'timestamp',
  active: 'boolean',
  metadata: 'jsonb',
});

const parameterHistory = createTable('governance_parameter_history', {
  id: 'serial',
  parameterId: 'integer',
  oldValue: 'text',
  newValue: 'text',
  changeTime: 'timestamp',
  reason: 'text',
  proposalId: 'integer',
  metadata: 'jsonb',
});

const delegations = createTable('governance_delegations', {
  id: 'serial',
  delegator: 'text',
  delegate: 'text',
  amount: 'numeric',
  createdAt: 'timestamp',
  active: 'boolean',
  metadata: 'jsonb',
});

const foundationMembers = createTable('governance_foundation_members', {
  id: 'serial',
  address: 'text',
  name: 'text',
  role: 'text',
  joinedAt: 'timestamp',
  vetoRights: 'boolean',
  vetoRightsExpiry: 'timestamp',
  active: 'boolean',
  metadata: 'jsonb',
});

const foundationActions = createTable('governance_foundation_actions', {
  id: 'serial',
  memberAddress: 'text',
  actionType: 'text',
  actionTime: 'timestamp',
  proposalId: 'integer',
  description: 'text',
  metadata: 'jsonb',
});

const governancePhaseTransitions = createTable('governance_phase_transitions', {
  id: 'serial',
  phase: 'text',
  description: 'text',
  startDate: 'timestamp',
  endDate: 'timestamp',
  foundationVetoEnabled: 'boolean',
  votingWeightConfig: 'jsonb',
  metadata: 'jsonb',
});

// Mock relations for compatibility
const proposalsRelations = () => ({});
const votesRelations = () => ({});
const parametersRelations = () => ({});
const parameterHistoryRelations = () => ({});

// Export everything
module.exports = {
  proposals,
  votes,
  parameters,
  parameterHistory,
  delegations,
  foundationMembers,
  foundationActions,
  governancePhaseTransitions,
  proposalsRelations,
  votesRelations,
  parametersRelations,
  parameterHistoryRelations,
};
