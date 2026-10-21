/**
 * Policy Audit Routes — human-readable sanction evidence endpoints.
 *
 * Exposes offense codes, reasons, timelines, and evidence artifacts
 * for moderation / sanction transparency.
 *
 * Routes:
 *   GET /api/sanctions/:id/reason       — Human-readable reason with offense code
 *   GET /api/sanctions/:id/evidence     — Evidence artifacts for a sanction
 *   GET /api/sanctions/:id/timeline     — Chronological event timeline
 *   GET /api/sanctions/:id/appeal-info  — Appeal eligibility, deadlines, instructions
 *   GET /api/sanctions/:id/risk-factors — Contributing risk factor breakdown
 *
 * Issues: backend#35
 */

import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { getOffenseByCode, type OffenseDefinition, type SeverityTier } from '../governance/offense-taxonomy.js';
import { AbuseRiskService, type RiskFactorDefinition } from '../services/abuse-risk-service.js';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface SanctionReasonResponse {
  sanctionId: string;
  offenseCode: string;
  offenseCategory: string;
  severity: string;
  humanReadableReason: string;
  slashBps: { min: number; max: number };
  suspensionBlocks: number;
  appealEligible: boolean;
  appealLink: string | null;
  policyHashReference: string;
  policyVersion: number;
}

export interface TimelineEvent {
  timestamp: string;
  eventType: 'offense_detected' | 'sanction_applied' | 'appeal_submitted' | 'appeal_decided' | 'sanction_lifted';
  description: string;
  blockNumber?: number;
  policyHash?: string;
}

export interface SanctionTimelineResponse {
  sanctionId: string;
  events: TimelineEvent[];
}

export interface EvidenceItem {
  id: string;
  type: 'transaction' | 'attestation' | 'quality_report' | 'validator_report';
  description: string;
  reference: string;
  timestamp: string;
  confidenceScore: number;
}

export interface SanctionEvidenceResponse {
  sanctionId: string;
  offenseCode: string;
  evidenceItems: EvidenceItem[];
}

export interface AppealInfoResponse {
  sanctionId: string;
  appealEligible: boolean;
  appealSubmitted: boolean;
  appealEndpoint: string;
  appealDeadline: string;
  slaTiers: {
    standard: string;
    urgent: string;
    critical: string;
  };
  instructions: string[];
}

export interface RiskFactorItem {
  key: string;
  category: string;
  weight: number;
  warnThreshold: number;
  highThreshold: number;
  triggered: boolean;
  humanReadableExplanation: string;
}

export interface SanctionRiskFactorsResponse {
  sanctionId: string;
  offenseCode: string;
  riskFactors: RiskFactorItem[];
}

// ---------------------------------------------------------------------------
// Slash basis-points schedule by severity tier
// ---------------------------------------------------------------------------

const SLASH_SCHEDULE: Record<SeverityTier, { min: number; max: number; suspensionBlocks: number }> = {
  minor:    { min: 0,    max: 50,   suspensionBlocks: 0 },
  moderate: { min: 50,   max: 200,  suspensionBlocks: 7200 },
  major:    { min: 200,  max: 1000, suspensionBlocks: 43200 },
  critical: { min: 1000, max: 5000, suspensionBlocks: 201600 },
};

// ---------------------------------------------------------------------------
// In-memory sanction store (demo / test)
// ---------------------------------------------------------------------------

export interface SanctionRecord {
  sanctionId: string;
  offenseCode: string;
  actorId: string;
  actorClass: 'human' | 'ai_agent' | 'robot';
  severity: SeverityTier;
  appealEligible: boolean;
  appealSubmitted: boolean;
  policyHash: string;
  policyVersion: number;
  events: TimelineEvent[];
  evidenceItems: EvidenceItem[];
}

export class SanctionStore {
  private sanctions: Map<string, SanctionRecord> = new Map();

  constructor() {
    this.seed();
  }

  /** Pre-populate with sample sanctions for demo/testing. */
  private seed(): void {
    const now = new Date();

    this.sanctions.set('SANC-001', {
      sanctionId: 'SANC-001',
      offenseCode: 'CONS-001',
      actorId: 'validator-0xabc123',
      actorClass: 'human',
      severity: 'critical',
      appealEligible: true,
      appealSubmitted: false,
      policyHash: 'sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      policyVersion: 3,
      events: [
        {
          timestamp: new Date(now.getTime() - 3600_000).toISOString(),
          eventType: 'offense_detected',
          description: 'Double-sign detected at block height 1,204,501. Conflicting signatures for blocks 0xfeed and 0xbeef.',
          blockNumber: 1204501,
          policyHash: 'sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        },
        {
          timestamp: new Date(now.getTime() - 3500_000).toISOString(),
          eventType: 'sanction_applied',
          description: 'Slash of 2500 bps applied; validator suspended for 201600 blocks.',
          blockNumber: 1204510,
        },
      ],
      evidenceItems: [
        {
          id: 'EV-001',
          type: 'validator_report',
          description: 'Conflicting block signatures captured by sentinel node.',
          reference: 'block:1204501:sig:0xfeed',
          timestamp: new Date(now.getTime() - 3600_000).toISOString(),
          confidenceScore: 0.97,
        },
        {
          id: 'EV-002',
          type: 'transaction',
          description: 'On-chain slash transaction executing penalty.',
          reference: 'tx:0xdeadbeef0001',
          timestamp: new Date(now.getTime() - 3500_000).toISOString(),
          confidenceScore: 1.0,
        },
      ],
    });

    this.sanctions.set('SANC-002', {
      sanctionId: 'SANC-002',
      offenseCode: 'DATA-002',
      actorId: 'station-wrf-42',
      actorClass: 'robot',
      severity: 'moderate',
      appealEligible: true,
      appealSubmitted: true,
      policyHash: 'sha256:b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6b2c3',
      policyVersion: 3,
      events: [
        {
          timestamp: new Date(now.getTime() - 7200_000).toISOString(),
          eventType: 'offense_detected',
          description: 'Quality score dropped below 0.4 threshold for 3 consecutive rounds.',
          blockNumber: 1203800,
        },
        {
          timestamp: new Date(now.getTime() - 7100_000).toISOString(),
          eventType: 'sanction_applied',
          description: 'Slash of 100 bps applied; station suspended for 7200 blocks.',
          blockNumber: 1203810,
        },
        {
          timestamp: new Date(now.getTime() - 5000_000).toISOString(),
          eventType: 'appeal_submitted',
          description: 'Appeal filed citing sensor calibration drift.',
          blockNumber: 1203900,
        },
      ],
      evidenceItems: [
        {
          id: 'EV-003',
          type: 'quality_report',
          description: 'Automated quality assessment showing 3 consecutive sub-threshold rounds.',
          reference: 'qr:round-4501:round-4503',
          timestamp: new Date(now.getTime() - 7200_000).toISOString(),
          confidenceScore: 0.82,
        },
      ],
    });

    this.sanctions.set('SANC-003', {
      sanctionId: 'SANC-003',
      offenseCode: 'ECON-002',
      actorId: 'agent-ml-trader-7',
      actorClass: 'ai_agent',
      severity: 'critical',
      appealEligible: false,
      appealSubmitted: false,
      policyHash: 'sha256:c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6c3d4c5',
      policyVersion: 3,
      events: [
        {
          timestamp: new Date(now.getTime() - 1800_000).toISOString(),
          eventType: 'offense_detected',
          description: 'Coordinated front-running pattern detected across 47 transactions.',
          blockNumber: 1204600,
        },
        {
          timestamp: new Date(now.getTime() - 1700_000).toISOString(),
          eventType: 'sanction_applied',
          description: 'Slash of 5000 bps applied; permanent suspension pending review.',
          blockNumber: 1204610,
        },
      ],
      evidenceItems: [
        {
          id: 'EV-004',
          type: 'transaction',
          description: 'Cluster of 47 front-running transactions with sub-block timing.',
          reference: 'tx:0xbadcafe0001..0xbadcafe0047',
          timestamp: new Date(now.getTime() - 1800_000).toISOString(),
          confidenceScore: 0.94,
        },
        {
          id: 'EV-005',
          type: 'attestation',
          description: 'MEV analysis oracle attestation confirming manipulation pattern.',
          reference: 'attestation:oracle-mev-01:round-4510',
          timestamp: new Date(now.getTime() - 1750_000).toISOString(),
          confidenceScore: 0.91,
        },
      ],
    });
  }

  get(sanctionId: string): SanctionRecord | undefined {
    return this.sanctions.get(sanctionId);
  }

  has(sanctionId: string): boolean {
    return this.sanctions.has(sanctionId);
  }

  set(record: SanctionRecord): void {
    this.sanctions.set(record.sanctionId, record);
  }
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createPolicyAuditRouter(store?: SanctionStore): Router {
  const router = Router();

  // All policy audit operations require authentication (#231)
  router.use(authenticateJWT);

  const sanctionStore = store ?? new SanctionStore();

  /**
   * GET /api/sanctions/:id/reason
   * Human-readable reason with offense code, description, severity, appeal link.
   */
  router.get('/:id/reason', (req: Request, res: Response) => {
    const { id } = req.params;
    const record = sanctionStore.get(id);

    if (!record) {
      res.status(404).json({
        success: false,
        error: `Sanction ${id} not found`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const offense = getOffenseByCode(record.offenseCode);
    if (!offense) {
      res.status(500).json({
        success: false,
        error: `Unknown offense code ${record.offenseCode}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const schedule = SLASH_SCHEDULE[record.severity];
    const appealLink = record.appealEligible
      ? `/api/sanctions/${id}/appeal`
      : null;

    const body: SanctionReasonResponse = {
      sanctionId: record.sanctionId,
      offenseCode: offense.code,
      offenseCategory: offense.category,
      severity: record.severity,
      humanReadableReason: offense.description,
      slashBps: { min: schedule.min, max: schedule.max },
      suspensionBlocks: schedule.suspensionBlocks,
      appealEligible: record.appealEligible,
      appealLink,
      policyHashReference: record.policyHash,
      policyVersion: record.policyVersion,
    };

    res.json({ success: true, data: body, timestamp: new Date().toISOString() });
  });

  /**
   * GET /api/sanctions/:id/timeline
   * Chronological event timeline for a sanction.
   */
  router.get('/:id/timeline', (req: Request, res: Response) => {
    const { id } = req.params;
    const record = sanctionStore.get(id);

    if (!record) {
      res.status(404).json({
        success: false,
        error: `Sanction ${id} not found`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const sorted = [...record.events].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const body: SanctionTimelineResponse = {
      sanctionId: record.sanctionId,
      events: sorted,
    };

    res.json({ success: true, data: body, timestamp: new Date().toISOString() });
  });

  /**
   * GET /api/sanctions/:id/evidence
   * Evidence artifacts for a sanction.
   */
  router.get('/:id/evidence', (req: Request, res: Response) => {
    const { id } = req.params;
    const record = sanctionStore.get(id);

    if (!record) {
      res.status(404).json({
        success: false,
        error: `Sanction ${id} not found`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const body: SanctionEvidenceResponse = {
      sanctionId: record.sanctionId,
      offenseCode: record.offenseCode,
      evidenceItems: record.evidenceItems,
    };

    res.json({ success: true, data: body, timestamp: new Date().toISOString() });
  });

  /**
   * GET /api/sanctions/:id/appeal-info
   * Appeal eligibility, deadlines, SLA tiers, and filing instructions.
   */
  router.get('/:id/appeal-info', (req: Request, res: Response) => {
    const { id } = req.params;
    const record = sanctionStore.get(id);

    if (!record) {
      res.status(404).json({
        success: false,
        error: `Sanction ${id} not found`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const now = new Date();
    // Default appeal window: 7 days from the earliest sanction_applied event
    const appliedEvent = record.events.find(e => e.eventType === 'sanction_applied');
    const sanctionAppliedAt = appliedEvent
      ? new Date(appliedEvent.timestamp)
      : now;
    const appealWindowMs = 7 * 24 * 60 * 60 * 1000;
    const appealDeadline = new Date(sanctionAppliedAt.getTime() + appealWindowMs);

    const body: AppealInfoResponse = {
      sanctionId: record.sanctionId,
      appealEligible: record.appealEligible,
      appealSubmitted: record.appealSubmitted,
      appealEndpoint: `/api/appeals`,
      appealDeadline: appealDeadline.toISOString(),
      slaTiers: {
        standard: '7 days',
        urgent: '48 hours',
        critical: '24 hours',
      },
      instructions: [
        `Submit a POST request to /api/appeals with your sanctionId "${record.sanctionId}" and supporting evidence.`,
        'Include a priority level: "standard" (7-day SLA), "urgent" (48-hour SLA), or "critical" (24-hour SLA).',
        'Attach evidence references that support your case (e.g., transaction hashes, attestation IDs).',
        `Appeals must be filed before the deadline: ${appealDeadline.toISOString()}.`,
        'A reviewer will be assigned automatically. You will be notified of the decision.',
      ],
    };

    res.json({ success: true, data: body, timestamp: new Date().toISOString() });
  });

  /**
   * GET /api/sanctions/:id/risk-factors
   * Contributing risk factors from the abuse-risk-service factor definitions.
   * Maps offense categories to relevant risk factor categories and returns
   * human-readable explanations for each factor.
   */
  router.get('/:id/risk-factors', (req: Request, res: Response) => {
    const { id } = req.params;
    const record = sanctionStore.get(id);

    if (!record) {
      res.status(404).json({
        success: false,
        error: `Sanction ${id} not found`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const offense = getOffenseByCode(record.offenseCode);
    if (!offense) {
      res.status(500).json({
        success: false,
        error: `Unknown offense code ${record.offenseCode}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Map offense categories to risk factor categories
    const categoryMapping: Record<string, string[]> = {
      data_integrity: ['spam'],
      consensus: ['spam', 'collusion'],
      oracle: ['collusion', 'manipulation'],
      governance: ['collusion', 'manipulation'],
      operational: ['spam'],
      economic: ['manipulation'],
    };

    const relevantCategories = categoryMapping[offense.category] || [];
    const riskService = new AbuseRiskService();
    const allFactors = riskService.getFactorDefinitions();

    const riskFactors: RiskFactorItem[] = allFactors.map((factor: RiskFactorDefinition) => ({
      key: factor.key,
      category: factor.category,
      weight: factor.weight,
      warnThreshold: factor.warnThreshold,
      highThreshold: factor.highThreshold,
      triggered: relevantCategories.includes(factor.category),
      humanReadableExplanation: factor.rationale,
    }));

    const body: SanctionRiskFactorsResponse = {
      sanctionId: record.sanctionId,
      offenseCode: record.offenseCode,
      riskFactors,
    };

    res.json({ success: true, data: body, timestamp: new Date().toISOString() });
  });

  return router;
}

// Default export for CommonJS mounting in routes/index.js
const defaultRouter = createPolicyAuditRouter();
export default defaultRouter;
