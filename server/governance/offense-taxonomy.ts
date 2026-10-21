/**
 * Canonical offense taxonomy — aligned with core4/docs/governance/offense-taxonomy.toml.
 * This is the TypeScript source of truth for offense codes and descriptions.
 *
 * Issues: backend#35
 */

export type OffenseCategory = 'data_integrity' | 'consensus' | 'oracle' | 'governance' | 'operational' | 'economic';
export type SeverityTier = 'minor' | 'moderate' | 'major' | 'critical';
export type ActorClass = 'human' | 'ai_agent' | 'robot';

export interface OffenseDefinition {
  code: string;
  name: string;
  category: OffenseCategory;
  defaultSeverity: SeverityTier;
  description: string;
}

export const OFFENSE_TAXONOMY: OffenseDefinition[] = [
  { code: 'DATA-001', name: 'DataInvalidReveal', category: 'data_integrity', defaultSeverity: 'major', description: 'All participants must submit valid reveals matching their commits. Invalid reveals undermine round integrity.' },
  { code: 'DATA-002', name: 'DataLowQuality', category: 'data_integrity', defaultSeverity: 'moderate', description: 'All participants must submit weather data meeting minimum quality thresholds. Repeated low-quality submissions trigger escalating sanctions.' },
  { code: 'DATA-003', name: 'DataFabrication', category: 'data_integrity', defaultSeverity: 'critical', description: 'All participants must submit authentic weather observations. Fabricated or forged data results in severe sanctions.' },
  { code: 'CONS-001', name: 'ConsensusDoubleSign', category: 'consensus', defaultSeverity: 'critical', description: 'Validators must not sign conflicting blocks at the same height. Double signing threatens chain finality.' },
  { code: 'CONS-002', name: 'ConsensusSurroundVote', category: 'consensus', defaultSeverity: 'critical', description: 'Validators must not cast votes that surround or are surrounded by their prior votes. Surround voting enables long-range attacks.' },
  { code: 'CONS-003', name: 'ConsensusDowntime', category: 'consensus', defaultSeverity: 'minor', description: 'Validators must maintain minimum uptime requirements. Extended downtime degrades network liveness.' },
  { code: 'CONS-004', name: 'ConsensusInvalidBlock', category: 'consensus', defaultSeverity: 'major', description: 'Validators must only propose blocks that pass all validity checks. Invalid block proposals waste network resources.' },
  { code: 'ORAC-001', name: 'OracleAttestationFraud', category: 'oracle', defaultSeverity: 'critical', description: 'Oracles must submit truthful attestations with valid signatures. Fraudulent attestations corrupt data integrity.' },
  { code: 'ORAC-002', name: 'OracleUnregistered', category: 'oracle', defaultSeverity: 'major', description: 'Oracles must be registered in the active oracle set before submitting attestations. Unregistered oracle activity is rejected.' },
  { code: 'ORAC-003', name: 'OracleDoubleAttestation', category: 'oracle', defaultSeverity: 'major', description: 'Oracles must submit at most one attestation per commit round. Double attestations can skew consensus outcomes.' },
  { code: 'GOVN-001', name: 'GovernanceVoteManipulation', category: 'governance', defaultSeverity: 'critical', description: 'All participants must cast votes reflecting genuine intent. Vote manipulation undermines democratic governance.' },
  { code: 'GOVN-002', name: 'GovernanceBribery', category: 'governance', defaultSeverity: 'critical', description: 'All participants must not offer or accept inducements for voting. Bribery corrupts governance outcomes.' },
  { code: 'OPER-001', name: 'OperationalRateLimitAbuse', category: 'operational', defaultSeverity: 'minor', description: 'All participants must respect published rate limits. Exceeding rate limits degrades service for other participants.' },
  { code: 'OPER-002', name: 'OperationalSpam', category: 'operational', defaultSeverity: 'moderate', description: 'All participants must not flood the network with low-value or duplicate transactions. Spam consumes shared resources.' },
  { code: 'ECON-001', name: 'EconomicWashTrading', category: 'economic', defaultSeverity: 'major', description: 'All participants must not execute self-trades to inflate volume or manipulate metrics. Wash trading distorts market signals.' },
  { code: 'ECON-002', name: 'EconomicMarketManipulation', category: 'economic', defaultSeverity: 'critical', description: 'All participants must not engage in coordinated price manipulation or front-running. Market manipulation harms all traders.' },
];

export function getOffenseByCode(code: string): OffenseDefinition | undefined {
  return OFFENSE_TAXONOMY.find(o => o.code === code);
}
