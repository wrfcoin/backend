/**
 * Shared types for the runtime capability readiness model.
 *
 * Five-level readiness mode generalised from the bridge capability system
 * (see backend/routes/bridges.ts). Used by GET /api/capabilities and
 * GET /api/protocol/transition.
 */

export type CapabilityMode =
  | 'unavailable'
  | 'simulated'
  | 'local-manager'
  | 'production-verified'
  | 'degraded';

export interface CapabilityReadinessResult {
  capabilityId: string;
  mode: CapabilityMode;
  reason: string;
  reasonCode: string;
  updatedAt: string;
  signals: Record<string, unknown>;
}

export type TransitionPhase =
  | 'none'
  | 'planned'
  | 'simulation'
  | 'timelock'
  | 'compatibility-window'
  | 'finalization'
  | 'rollback';

export interface ProtocolTransitionProposal {
  id: string;
  title: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  targetModule: string;
  targetVersion: string;
  proposer: string;
}

export interface ProtocolTransitionTiming {
  phaseStartedAt: string;
  estimatedPhaseEndAt?: string;
  remainingSeconds?: number;
}

export interface ProtocolTransitionState {
  active: boolean;
  phase: TransitionPhase;
  proposal?: ProtocolTransitionProposal;
  timing?: ProtocolTransitionTiming;
  affectedModules: string[];
  message: string;
  gateRiskyActions: boolean;
  timestamp: string;
}
