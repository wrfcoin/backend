/**
 * Sanctions orchestration service -- implements backend#33 and backend#40.
 *
 * - backend#33: deterministic sanction lifecycle state machine (ban/slash/cooldown/appeal)
 * - backend#40: parity guardrail that can halt sanction transitions on actor-class drift,
 *   with escalation and audited override support.
 */

import { OFFENSE_TAXONOMY } from '../governance/offense-taxonomy.js';
import {
  integrityThresholdCalibrationService,
} from './integrity-threshold-calibration-service.js';

export type ActorClass = 'human' | 'ai_agent' | 'robot';

export type SanctionLifecycleStatus =
  | 'proposed'
  | 'temporary_ban_active'
  | 'slashing_requested'
  | 'cooldown_active'
  | 'appeal_submitted'
  | 'appeal_under_review'
  | 'appeal_upheld'
  | 'appeal_reversed'
  | 'appeal_modified'
  | 'closed';

export type SanctionTransitionAction =
  | 'activate_temporary_ban'
  | 'request_slash'
  | 'start_cooldown'
  | 'submit_appeal'
  | 'begin_appeal_review'
  | 'resolve_appeal_upheld'
  | 'resolve_appeal_reversed'
  | 'resolve_appeal_modified'
  | 'close_case';

export interface GuardrailOverrideInput {
  approvedBy: string;
  reason: string;
  haltId?: string;
}

export interface SanctionTransitionInput {
  action: SanctionTransitionAction;
  requestedBy: string;
  currentBlock?: number;
  reason?: string;
  evidenceReferences?: string[];
  slashTxReference?: string;
  guardrailOverride?: GuardrailOverrideInput;
}

export interface SanctionCase {
  id: string;
  actorId: string;
  actorClass: ActorClass;
  offenseCode: string;
  severityTier: string;
  rationale: string;
  policyHashReference: string;
  policyVersion: number;
  requestedBy: string;
  temporaryBanBlocks: number;
  slashBps: number;
  cooldownBlocks: number;
  status: SanctionLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  temporaryBan: {
    startedAt: string | null;
    startedAtBlock: number | null;
    endsAtBlock: number | null;
  };
  slashRequest: {
    requestId: string | null;
    requestedAt: string | null;
    requestedBy: string | null;
    slashBps: number;
    status: 'not_requested' | 'pending' | 'executed' | 'cancelled';
    txReference: string | null;
  };
  cooldown: {
    startedAt: string | null;
    startedAtBlock: number | null;
    endsAtBlock: number | null;
    reason: string | null;
  };
  appeal: {
    appealId: string | null;
    status: 'none' | 'submitted' | 'under_review' | 'upheld' | 'reversed' | 'modified';
    submittedAt: string | null;
    decidedAt: string | null;
    decidedBy: string | null;
    decisionReason: string | null;
  };
}

export interface ParityGuardrailHalt {
  haltId: string;
  sanctionCaseId: string;
  action: SanctionTransitionAction;
  offenseCode: string;
  severityTier: string;
  actorClass: ActorClass;
  triggeredAt: string;
  triggeredBy: string;
  reason: string;
  metric: 'slashBps' | 'temporaryBanBlocks';
  relativeDelta: number;
  threshold: number;
  comparatorCount: number;
  escalationChannel: string;
  status: 'active' | 'overridden' | 'released';
  overrideBy: string | null;
  overrideReason: string | null;
  overrideAt: string | null;
}

export interface ParityGuardrailConfig {
  enabled: boolean;
  maxRelativeDelta: number | null; // null => derived from calibration config
  minComparableCases: number;
  escalationChannel: string;
}

export interface GuardrailState {
  config: ParityGuardrailConfig;
  effectiveMaxRelativeDelta: number;
  counters: {
    transitionAttempts: number;
    haltsTriggered: number;
    overridesApplied: number;
    falseHaltRate: number;
  };
  activeHalts: ParityGuardrailHalt[];
}

export interface SanctionAuditEvent {
  id: string;
  sanctionCaseId: string;
  eventType:
    | 'case_created'
    | 'transition_applied'
    | 'guardrail_halt'
    | 'guardrail_override'
    | 'guardrail_config_updated';
  action: string;
  fromStatus: SanctionLifecycleStatus | null;
  toStatus: SanctionLifecycleStatus;
  actorClass: ActorClass;
  requestedBy: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export class GuardrailHaltError extends Error {
  halt: ParityGuardrailHalt;

  constructor(halt: ParityGuardrailHalt) {
    super(`PARITY_GUARDRAIL_HALT: ${halt.haltId} (${halt.reason})`);
    this.name = 'GuardrailHaltError';
    this.halt = halt;
  }
}

const VALID_ACTOR_CLASSES: ReadonlySet<ActorClass> = new Set<ActorClass>([
  'human',
  'ai_agent',
  'robot',
]);

const ALLOWED_TRANSITIONS: Record<SanctionTransitionAction, SanctionLifecycleStatus[]> = {
  activate_temporary_ban: ['proposed'],
  request_slash: ['proposed', 'temporary_ban_active'],
  start_cooldown: ['temporary_ban_active', 'slashing_requested', 'appeal_upheld', 'appeal_modified'],
  submit_appeal: ['temporary_ban_active', 'slashing_requested', 'cooldown_active'],
  begin_appeal_review: ['appeal_submitted'],
  resolve_appeal_upheld: ['appeal_under_review'],
  resolve_appeal_reversed: ['appeal_under_review'],
  resolve_appeal_modified: ['appeal_under_review'],
  close_case: ['proposed', 'slashing_requested', 'cooldown_active', 'appeal_upheld', 'appeal_reversed', 'appeal_modified'],
};

const GUARDED_ACTIONS: ReadonlySet<SanctionTransitionAction> = new Set([
  'activate_temporary_ban',
  'request_slash',
  'start_cooldown',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function assertNonEmpty(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function assertPositiveInt(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function relativeDelta(values: number[]): number {
  if (values.length <= 1) return 0;
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max <= 0) return 0;
  return Number(((max - min) / max).toFixed(4));
}

export class SanctionsOrchestrationService {
  private sanctions: Map<string, SanctionCase> = new Map();
  private auditTrail: SanctionAuditEvent[] = [];
  private guardrailHalts: Map<string, ParityGuardrailHalt> = new Map();

  private guardrailConfig: ParityGuardrailConfig = {
    enabled: true,
    maxRelativeDelta: null,
    minComparableCases: 2,
    escalationChannel: 'sanctions-parity-review',
  };

  private nextCaseId = 1;
  private nextEventId = 1;
  private nextSlashRequestId = 1;
  private nextAppealId = 1;
  private nextHaltId = 1;

  private transitionAttempts = 0;
  private haltsTriggered = 0;
  private overridesApplied = 0;

  createSanctionCase(params: {
    actorId: string;
    actorClass: ActorClass;
    offenseCode: string;
    severityTier: string;
    rationale: string;
    policyHashReference: string;
    policyVersion: number;
    requestedBy: string;
    temporaryBanBlocks: number;
    slashBps: number;
    cooldownBlocks: number;
  }): SanctionCase {
    const actorId = assertNonEmpty('actorId', params.actorId);
    const offenseCode = assertNonEmpty('offenseCode', params.offenseCode);
    const severityTier = assertNonEmpty('severityTier', params.severityTier);
    const rationale = assertNonEmpty('rationale', params.rationale);
    const policyHashReference = assertNonEmpty('policyHashReference', params.policyHashReference);
    const requestedBy = assertNonEmpty('requestedBy', params.requestedBy);

    if (!VALID_ACTOR_CLASSES.has(params.actorClass)) {
      throw new Error('actorClass must be one of: human, ai_agent, robot');
    }

    const policyVersion = assertPositiveInt('policyVersion', params.policyVersion);
    const temporaryBanBlocks = assertPositiveInt('temporaryBanBlocks', params.temporaryBanBlocks);
    const slashBps = assertPositiveInt('slashBps', params.slashBps);
    const cooldownBlocks = assertPositiveInt('cooldownBlocks', params.cooldownBlocks);

    if (slashBps > 10_000) {
      throw new Error('slashBps must be <= 10000');
    }

    const timestamp = nowIso();
    const sanction: SanctionCase = {
      id: `SANC-ORCH-${String(this.nextCaseId++).padStart(6, '0')}`,
      actorId,
      actorClass: params.actorClass,
      offenseCode,
      severityTier,
      rationale,
      policyHashReference,
      policyVersion,
      requestedBy,
      temporaryBanBlocks,
      slashBps,
      cooldownBlocks,
      status: 'proposed',
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      temporaryBan: {
        startedAt: null,
        startedAtBlock: null,
        endsAtBlock: null,
      },
      slashRequest: {
        requestId: null,
        requestedAt: null,
        requestedBy: null,
        slashBps,
        status: 'not_requested',
        txReference: null,
      },
      cooldown: {
        startedAt: null,
        startedAtBlock: null,
        endsAtBlock: null,
        reason: null,
      },
      appeal: {
        appealId: null,
        status: 'none',
        submittedAt: null,
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
      },
    };

    this.sanctions.set(sanction.id, sanction);
    this.pushAuditEvent({
      sanctionCaseId: sanction.id,
      eventType: 'case_created',
      action: 'create_case',
      fromStatus: null,
      toStatus: sanction.status,
      actorClass: sanction.actorClass,
      requestedBy,
      metadata: {
        offenseCode,
        severityTier,
        policyVersion,
      },
    });

    return { ...sanction };
  }

  transitionSanctionCase(caseId: string, input: SanctionTransitionInput): SanctionCase {
    const sanction = this.getOrThrow(caseId);
    const action = input.action;
    const requestedBy = assertNonEmpty('requestedBy', input.requestedBy);

    const allowedFrom = ALLOWED_TRANSITIONS[action];
    if (!allowedFrom.includes(sanction.status)) {
      throw new Error(
        `Invalid transition action "${action}" from status "${sanction.status}". Allowed statuses: [${allowedFrom.join(', ')}]`,
      );
    }

    this.transitionAttempts += 1;
    this.enforceParityGuardrail(sanction, action, requestedBy, input.guardrailOverride);

    const fromStatus = sanction.status;
    const updatedAt = nowIso();

    switch (action) {
      case 'activate_temporary_ban': {
        sanction.status = 'temporary_ban_active';
        sanction.temporaryBan.startedAt = updatedAt;
        if (typeof input.currentBlock === 'number') {
          sanction.temporaryBan.startedAtBlock = input.currentBlock;
          sanction.temporaryBan.endsAtBlock = input.currentBlock + sanction.temporaryBanBlocks;
        }
        break;
      }

      case 'request_slash': {
        sanction.status = 'slashing_requested';
        sanction.slashRequest.requestId = `SLREQ-${String(this.nextSlashRequestId++).padStart(6, '0')}`;
        sanction.slashRequest.requestedAt = updatedAt;
        sanction.slashRequest.requestedBy = requestedBy;
        sanction.slashRequest.status = input.slashTxReference ? 'executed' : 'pending';
        sanction.slashRequest.txReference = input.slashTxReference || null;
        break;
      }

      case 'start_cooldown': {
        if (typeof input.currentBlock !== 'number' || !Number.isInteger(input.currentBlock) || input.currentBlock < 0) {
          throw new Error('start_cooldown requires currentBlock as a non-negative integer');
        }
        sanction.status = 'cooldown_active';
        sanction.cooldown.startedAt = updatedAt;
        sanction.cooldown.startedAtBlock = input.currentBlock;
        sanction.cooldown.endsAtBlock = input.currentBlock + sanction.cooldownBlocks;
        sanction.cooldown.reason = input.reason || null;
        break;
      }

      case 'submit_appeal': {
        sanction.status = 'appeal_submitted';
        sanction.appeal.appealId = `APL-SANC-${String(this.nextAppealId++).padStart(6, '0')}`;
        sanction.appeal.status = 'submitted';
        sanction.appeal.submittedAt = updatedAt;
        sanction.appeal.decisionReason = input.reason || null;
        sanction.appeal.decidedAt = null;
        sanction.appeal.decidedBy = null;
        break;
      }

      case 'begin_appeal_review': {
        if (sanction.appeal.status !== 'submitted') {
          throw new Error('Appeal must be submitted before it can move to review');
        }
        sanction.status = 'appeal_under_review';
        sanction.appeal.status = 'under_review';
        break;
      }

      case 'resolve_appeal_upheld': {
        sanction.status = 'appeal_upheld';
        sanction.appeal.status = 'upheld';
        sanction.appeal.decidedAt = updatedAt;
        sanction.appeal.decidedBy = requestedBy;
        sanction.appeal.decisionReason = input.reason || null;
        break;
      }

      case 'resolve_appeal_reversed': {
        sanction.status = 'appeal_reversed';
        sanction.appeal.status = 'reversed';
        sanction.appeal.decidedAt = updatedAt;
        sanction.appeal.decidedBy = requestedBy;
        sanction.appeal.decisionReason = input.reason || null;
        if (sanction.slashRequest.status === 'pending' || sanction.slashRequest.status === 'executed') {
          sanction.slashRequest.status = 'cancelled';
        }
        break;
      }

      case 'resolve_appeal_modified': {
        sanction.status = 'appeal_modified';
        sanction.appeal.status = 'modified';
        sanction.appeal.decidedAt = updatedAt;
        sanction.appeal.decidedBy = requestedBy;
        sanction.appeal.decisionReason = input.reason || null;
        break;
      }

      case 'close_case': {
        if (fromStatus === 'cooldown_active') {
          if (typeof input.currentBlock !== 'number' || !Number.isInteger(input.currentBlock) || input.currentBlock < 0) {
            throw new Error('close_case from cooldown_active requires currentBlock as a non-negative integer');
          }
          const cooldownEnd = sanction.cooldown.endsAtBlock;
          if (typeof cooldownEnd === 'number' && input.currentBlock < cooldownEnd) {
            throw new Error(
              `Cooldown window still active: currentBlock ${input.currentBlock} < endsAtBlock ${cooldownEnd}`,
            );
          }
        }

        sanction.status = 'closed';
        sanction.closedAt = updatedAt;
        break;
      }

      default: {
        const _exhaustive: never = action;
        throw new Error(`Unhandled transition action: ${_exhaustive}`);
      }
    }

    sanction.updatedAt = updatedAt;

    this.pushAuditEvent({
      sanctionCaseId: sanction.id,
      eventType: 'transition_applied',
      action,
      fromStatus,
      toStatus: sanction.status,
      actorClass: sanction.actorClass,
      requestedBy,
      metadata: {
        reason: input.reason || null,
        currentBlock: typeof input.currentBlock === 'number' ? input.currentBlock : null,
        evidenceReferences: input.evidenceReferences || [],
        slashTxReference: input.slashTxReference || null,
      },
    });

    return { ...sanction };
  }

  listSanctionCases(filters?: {
    status?: SanctionLifecycleStatus;
    actorClass?: ActorClass;
  }): SanctionCase[] {
    const values = Array.from(this.sanctions.values());
    return values.filter(item => {
      if (filters?.status && item.status !== filters.status) {
        return false;
      }
      if (filters?.actorClass && item.actorClass !== filters.actorClass) {
        return false;
      }
      return true;
    });
  }

  getSanctionCase(caseId: string): SanctionCase | null {
    return this.sanctions.get(caseId) || null;
  }

  listAuditTrail(caseId?: string): SanctionAuditEvent[] {
    if (!caseId) {
      return [...this.auditTrail];
    }
    return this.auditTrail.filter(event => event.sanctionCaseId === caseId);
  }

  listGuardrailHalts(filters?: {
    status?: ParityGuardrailHalt['status'];
    sanctionCaseId?: string;
  }): ParityGuardrailHalt[] {
    const values = Array.from(this.guardrailHalts.values());
    return values.filter(halt => {
      if (filters?.status && halt.status !== filters.status) return false;
      if (filters?.sanctionCaseId && halt.sanctionCaseId !== filters.sanctionCaseId) return false;
      return true;
    });
  }

  getGuardrailState(): GuardrailState {
    const activeHalts = this.listGuardrailHalts({ status: 'active' });
    const falseHaltRate = safeRate(this.overridesApplied, this.haltsTriggered);

    return {
      config: { ...this.guardrailConfig },
      effectiveMaxRelativeDelta: this.resolveEffectiveGuardrailThreshold(),
      counters: {
        transitionAttempts: this.transitionAttempts,
        haltsTriggered: this.haltsTriggered,
        overridesApplied: this.overridesApplied,
        falseHaltRate,
      },
      activeHalts,
    };
  }

  updateGuardrailConfig(input: {
    requestedBy: string;
    enabled?: boolean;
    maxRelativeDelta?: number | null;
    minComparableCases?: number;
    escalationChannel?: string;
    reason?: string;
  }): GuardrailState {
    const requestedBy = assertNonEmpty('requestedBy', input.requestedBy);

    if (typeof input.enabled === 'boolean') {
      this.guardrailConfig.enabled = input.enabled;
    }

    if (typeof input.maxRelativeDelta === 'number') {
      this.guardrailConfig.maxRelativeDelta = clamp(input.maxRelativeDelta, 0.01, 1);
    }

    if (input.maxRelativeDelta === null) {
      this.guardrailConfig.maxRelativeDelta = null;
    }

    if (typeof input.minComparableCases === 'number') {
      if (!Number.isInteger(input.minComparableCases) || input.minComparableCases < 1) {
        throw new Error('minComparableCases must be an integer >= 1');
      }
      this.guardrailConfig.minComparableCases = input.minComparableCases;
    }

    if (typeof input.escalationChannel === 'string') {
      this.guardrailConfig.escalationChannel = assertNonEmpty('escalationChannel', input.escalationChannel);
    }

    this.pushAuditEvent({
      sanctionCaseId: 'SYSTEM',
      eventType: 'guardrail_config_updated',
      action: 'update_guardrail_config',
      fromStatus: 'proposed',
      toStatus: 'proposed',
      actorClass: 'human',
      requestedBy,
      metadata: {
        reason: input.reason || null,
        config: { ...this.guardrailConfig },
        effectiveMaxRelativeDelta: this.resolveEffectiveGuardrailThreshold(),
      },
    });

    return this.getGuardrailState();
  }

  getMetrics(): {
    totalCases: number;
    openCases: number;
    closedCases: number;
    medianResolutionHours: number;
    appealsSubmitted: number;
    appealsResolved: number;
    appealResolutionTransparency: number;
    parityGuardrailTriggerRate: number;
    parityGuardrailFalseHaltRate: number;
  } {
    const cases = Array.from(this.sanctions.values());
    const closed = cases.filter(item => item.status === 'closed' && item.closedAt);
    const open = cases.length - closed.length;

    const resolutionHours = closed.map(item => {
      const start = new Date(item.createdAt).getTime();
      const end = new Date(item.closedAt as string).getTime();
      return (end - start) / (1000 * 60 * 60);
    });

    const appealsSubmitted = cases.filter(item => item.appeal.status !== 'none').length;
    const appealsResolved = cases.filter(item => ['upheld', 'reversed', 'modified'].includes(item.appeal.status)).length;

    const appealResolutionTransparency = appealsSubmitted === 0
      ? 1
      : Number((appealsResolved / appealsSubmitted).toFixed(4));

    return {
      totalCases: cases.length,
      openCases: open,
      closedCases: closed.length,
      medianResolutionHours: Number(median(resolutionHours).toFixed(4)),
      appealsSubmitted,
      appealsResolved,
      appealResolutionTransparency,
      parityGuardrailTriggerRate: safeRate(this.haltsTriggered, this.transitionAttempts),
      parityGuardrailFalseHaltRate: safeRate(this.overridesApplied, this.haltsTriggered),
    };
  }

  private enforceParityGuardrail(
    sanction: SanctionCase,
    action: SanctionTransitionAction,
    requestedBy: string,
    overrideInput?: GuardrailOverrideInput,
  ): void {
    if (!this.guardrailConfig.enabled) {
      return;
    }
    if (!GUARDED_ACTIONS.has(action)) {
      return;
    }

    const comparable = Array.from(this.sanctions.values()).filter(item =>
      item.id !== sanction.id
      && item.offenseCode === sanction.offenseCode
      && item.severityTier === sanction.severityTier
      && item.status !== 'proposed'
    );

    if (comparable.length < this.guardrailConfig.minComparableCases) {
      return;
    }

    const effectiveThreshold = this.resolveEffectiveGuardrailThreshold();

    const slashValues = [...comparable.map(item => item.slashBps), sanction.slashBps];
    const banValues = [...comparable.map(item => item.temporaryBanBlocks), sanction.temporaryBanBlocks];

    const slashGap = relativeDelta(slashValues);
    const banGap = relativeDelta(banValues);

    const metric = slashGap >= banGap ? 'slashBps' : 'temporaryBanBlocks';
    const gap = metric === 'slashBps' ? slashGap : banGap;

    if (gap <= effectiveThreshold) {
      return;
    }

    const halt = this.createGuardrailHalt({
      sanction,
      action,
      requestedBy,
      metric,
      relativeDelta: gap,
      threshold: effectiveThreshold,
      comparatorCount: comparable.length,
      reason: `${metric} parity drift ${gap.toFixed(4)} exceeded threshold ${effectiveThreshold.toFixed(4)}`,
    });

    if (overrideInput) {
      this.applyGuardrailOverride(halt, overrideInput, sanction);
      return;
    }

    this.pushAuditEvent({
      sanctionCaseId: sanction.id,
      eventType: 'guardrail_halt',
      action: `guardrail_halt_${action}`,
      fromStatus: sanction.status,
      toStatus: sanction.status,
      actorClass: sanction.actorClass,
      requestedBy,
      metadata: {
        haltId: halt.haltId,
        reason: halt.reason,
        metric: halt.metric,
        relativeDelta: halt.relativeDelta,
        threshold: halt.threshold,
        escalationChannel: halt.escalationChannel,
      },
    });

    throw new GuardrailHaltError(halt);
  }

  private applyGuardrailOverride(
    halt: ParityGuardrailHalt,
    overrideInput: GuardrailOverrideInput,
    sanction: SanctionCase,
  ): void {
    const approvedBy = assertNonEmpty('guardrailOverride.approvedBy', overrideInput.approvedBy);
    const reason = assertNonEmpty('guardrailOverride.reason', overrideInput.reason);

    if (overrideInput.haltId && overrideInput.haltId !== halt.haltId) {
      throw new Error(
        `guardrailOverride.haltId ${overrideInput.haltId} does not match active halt ${halt.haltId}`,
      );
    }

    halt.status = 'overridden';
    halt.overrideBy = approvedBy;
    halt.overrideReason = reason;
    halt.overrideAt = nowIso();
    this.guardrailHalts.set(halt.haltId, halt);
    this.overridesApplied += 1;

    this.pushAuditEvent({
      sanctionCaseId: sanction.id,
      eventType: 'guardrail_override',
      action: `guardrail_override_${halt.action}`,
      fromStatus: sanction.status,
      toStatus: sanction.status,
      actorClass: sanction.actorClass,
      requestedBy: approvedBy,
      metadata: {
        haltId: halt.haltId,
        reason,
        escalationChannel: halt.escalationChannel,
      },
    });
  }

  private createGuardrailHalt(input: {
    sanction: SanctionCase;
    action: SanctionTransitionAction;
    requestedBy: string;
    metric: 'slashBps' | 'temporaryBanBlocks';
    relativeDelta: number;
    threshold: number;
    comparatorCount: number;
    reason: string;
  }): ParityGuardrailHalt {
    const existing = this.listGuardrailHalts({
      status: 'active',
      sanctionCaseId: input.sanction.id,
    }).find(item => item.action === input.action);

    if (existing) {
      return existing;
    }

    const halt: ParityGuardrailHalt = {
      haltId: `HALT-${String(this.nextHaltId++).padStart(6, '0')}`,
      sanctionCaseId: input.sanction.id,
      action: input.action,
      offenseCode: input.sanction.offenseCode,
      severityTier: input.sanction.severityTier,
      actorClass: input.sanction.actorClass,
      triggeredAt: nowIso(),
      triggeredBy: input.requestedBy,
      reason: input.reason,
      metric: input.metric,
      relativeDelta: input.relativeDelta,
      threshold: input.threshold,
      comparatorCount: input.comparatorCount,
      escalationChannel: this.guardrailConfig.escalationChannel,
      status: 'active',
      overrideBy: null,
      overrideReason: null,
      overrideAt: null,
    };

    this.haltsTriggered += 1;
    this.guardrailHalts.set(halt.haltId, halt);
    return halt;
  }

  private resolveEffectiveGuardrailThreshold(): number {
    if (typeof this.guardrailConfig.maxRelativeDelta === 'number') {
      return clamp(this.guardrailConfig.maxRelativeDelta, 0.01, 1);
    }

    const calibration = integrityThresholdCalibrationService.getActiveConfig();
    return clamp(calibration.thresholds.targetActorClassParityGap, 0.01, 1);
  }

  private getOrThrow(caseId: string): SanctionCase {
    const sanction = this.sanctions.get(caseId);
    if (!sanction) {
      throw new Error(`Sanction case not found: ${caseId}`);
    }
    return sanction;
  }

  /**
   * Returns aggregated, privacy-safe integrity KPI data.
   * No individual case details, actor IDs, or PII are exposed.
   */
  getAggregatedIntegrityKpi(): {
    totalActiveSanctions: number;
    sanctionsByOffenseCategory: Record<string, number>;
    sanctionsByActorClass: Record<string, number>;
    appealRate: number;
    overturnRate: number;
  } {
    const cases = Array.from(this.sanctions.values());
    const activeCases = cases.filter(c => c.status !== 'closed');

    const sanctionsByOffenseCategory: Record<string, number> = {};
    const sanctionsByActorClass: Record<string, number> = {};

    for (const c of activeCases) {
      // Derive category from offense taxonomy (single source of truth)
      const offense = OFFENSE_TAXONOMY.find(o => o.code === c.offenseCode);
      const category = offense?.category || 'unknown';
      sanctionsByOffenseCategory[category] = (sanctionsByOffenseCategory[category] || 0) + 1;
      sanctionsByActorClass[c.actorClass] = (sanctionsByActorClass[c.actorClass] || 0) + 1;
    }

    const appealsSubmitted = cases.filter(c => c.appeal.status !== 'none').length;
    const appealsOverturned = cases.filter(c => c.appeal.status === 'reversed' || c.appeal.status === 'modified').length;

    return {
      totalActiveSanctions: activeCases.length,
      sanctionsByOffenseCategory,
      sanctionsByActorClass,
      appealRate: safeRate(appealsSubmitted, cases.length),
      overturnRate: safeRate(appealsOverturned, appealsSubmitted),
    };
  }

  private pushAuditEvent(event: Omit<SanctionAuditEvent, 'id' | 'timestamp'>): void {
    const record: SanctionAuditEvent = {
      ...event,
      id: `SAE-${String(this.nextEventId++).padStart(8, '0')}`,
      timestamp: nowIso(),
    };
    this.auditTrail.push(record);
  }
}

export const sanctionsOrchestrationService = new SanctionsOrchestrationService();
