/**
 * Smoke tests for the top 5 most-imported backend services (#361).
 *
 * Services ranked by import frequency across server/ (rg analysis):
 *   1. sanctions-orchestration-service   (2 imports)
 *   2. reputation-scoring-engine         (2 imports)
 *   3. iso20022-error-handler            (2 imports)
 *   4. identity-governance-service       (2 imports)
 *   5. calibration-attestation-verifier  (self-contained, no DB)
 *
 * Each test covers: import, instantiate, call primary method, assert return shape.
 * No real DB or network connections are used.
 */

// ---------------------------------------------------------------------------
// 1. SanctionsOrchestrationService
// ---------------------------------------------------------------------------

jest.mock('../server/governance/offense-taxonomy.js', () => ({
  OFFENSE_TAXONOMY: {},
}));
jest.mock('../server/services/integrity-threshold-calibration-service.js', () => ({
  integrityThresholdCalibrationService: {
    getEffectiveMaxRelativeDelta: jest.fn().mockReturnValue(0.25),
    getConfig: jest.fn().mockResolvedValue({
      maxRelativeDeltaOverride: null,
      defaultMaxRelativeDelta: 0.25,
    }),
  },
}));

import {
  SanctionsOrchestrationService,
  type ActorClass,
} from '../server/services/sanctions-orchestration-service.js';

describe('SanctionsOrchestrationService — smoke', () => {
  let service: SanctionsOrchestrationService;

  beforeEach(() => {
    service = new SanctionsOrchestrationService();
  });

  it('is constructable and exposes createSanctionCase / transitionSanctionCase / getSanctionCase / listAuditTrail', () => {
    expect(service).toBeDefined();
    expect(typeof service.createSanctionCase).toBe('function');
    expect(typeof service.transitionSanctionCase).toBe('function');
    expect(typeof service.getSanctionCase).toBe('function');
    expect(typeof service.listAuditTrail).toBe('function');
  });

  it('createSanctionCase returns a SanctionCase with expected shape', () => {
    const actorClass: ActorClass = 'human';
    const result = service.createSanctionCase({
      actorId: 'node-001',
      actorClass,
      offenseCode: 'SPAM_BURST',
      severityTier: 'MINOR',
      rationale: 'Test offense',
      policyHashReference: '0xdeadbeef',
      policyVersion: 1,
      requestedBy: 'admin',
      temporaryBanBlocks: 100,
      slashBps: 50,
      cooldownBlocks: 200,
    });

    expect(result).toBeDefined();
    expect(typeof result.id).toBe('string');
    expect(result.actorClass).toBe('human');
    expect(result.status).toBe('proposed');
    expect(result.appeal).toBeDefined();
    expect(result.appeal.status).toBe('none');
  });

  it('getSanctionCase returns null for unknown id', () => {
    const result = service.getSanctionCase('nonexistent-id');
    expect(result).toBeNull();
  });

  it('listAuditTrail returns an array for any caseId', () => {
    const log = service.listAuditTrail('any-id');
    expect(Array.isArray(log)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. ReputationScoringEngine
// ---------------------------------------------------------------------------

import {
  ReputationScoringEngine,
  type ReputationSignal,
} from '../server/services/reputation/reputation-scoring-engine.js';

describe('ReputationScoringEngine — smoke', () => {
  let engine: ReputationScoringEngine;
  const TEST_ADDR = '0xTestAddress001';

  beforeEach(() => {
    engine = new ReputationScoringEngine();
  });

  it('is constructable and exposes recordSignal / getScore / getRankings / getEvents', () => {
    expect(engine).toBeDefined();
    expect(typeof engine.recordSignal).toBe('function');
    expect(typeof engine.getScore).toBe('function');
    expect(typeof engine.getRankings).toBe('function');
    expect(typeof engine.getEvents).toBe('function');
  });

  it('getScore returns a default record for unknown address', async () => {
    const record = await engine.getScore(TEST_ADDR);

    expect(record).toBeDefined();
    expect(record.address).toBe(TEST_ADDR);
    expect(record.compositeScore).toBe(0);
    expect(record.tier).toBe('Bronze');
    expect(record.bonusMultiplier).toBe(1);
    expect(Array.isArray(record.badges)).toBe(true);
    expect(Array.isArray(record.history)).toBe(true);
    expect(record.componentScores).toBeDefined();
    expect(typeof record.componentScores.dataQuality).toBe('number');
  });

  it('recordSignal updates compositeScore and returns updated record', async () => {
    const signal: ReputationSignal = {
      address: TEST_ADDR,
      role: 'collector',
      eventType: 'weather_submission',
      dataQuality: 80,
      uptime: 90,
      verificationAccuracy: 70,
      communityContribution: 50,
    };

    const record = await engine.recordSignal(signal);

    expect(record.address).toBe(TEST_ADDR);
    expect(record.role).toBe('collector');
    expect(record.compositeScore).toBeGreaterThan(0);
    expect(record.history.length).toBe(1);
    // Tier should reflect the computed score
    expect(['Bronze', 'Silver', 'Gold', 'Platinum']).toContain(record.tier);
    expect(record.bonusMultiplier).toBeGreaterThanOrEqual(1);
  });

  it('throws when address is missing', async () => {
    await expect(
      engine.recordSignal({ address: '', role: 'user', eventType: 'test' })
    ).rejects.toThrow();
  });

  it('getRankings returns paginated shape', async () => {
    const result = await engine.getRankings(1, 10);
    expect(result).toBeDefined();
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
    expect(typeof result.total).toBe('number');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('getEvents returns an array', async () => {
    const events = await engine.getEvents(TEST_ADDR);
    expect(Array.isArray(events)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. AppealsService
// ---------------------------------------------------------------------------

import {
  AppealsService,
  type ActorClass as AppealActorClass,
} from '../server/services/appeals-service.js';

describe('AppealsService — smoke', () => {
  let service: AppealsService;

  beforeEach(() => {
    service = new AppealsService();
  });

  it('is constructable and exposes submitAppeal / getAppeal / assignReviewer / recordDecision / publishDecision', () => {
    expect(service).toBeDefined();
    expect(typeof service.submitAppeal).toBe('function');
    expect(typeof service.getAppeal).toBe('function');
    expect(typeof service.assignReviewer).toBe('function');
    expect(typeof service.recordDecision).toBe('function');
    expect(typeof service.publishDecision).toBe('function');
  });

  it('submitAppeal returns an Appeal with correct initial shape', async () => {
    const appeal = service.submitAppeal({
      sanctionId: 'sanction-001',
      offenseCode: 'SPAM_BURST',
      severityTier: 'MINOR',
      appellantId: 'node-001',
      actorClass: 'human',
      priority: 'standard',
      policyHashReference: '0xpolicyhash',
    });

    expect(appeal).toBeDefined();
    expect(typeof appeal.id).toBe('string');
    expect(appeal.status).toBe('submitted');
    expect(appeal.actorClass).toBe('human');
    expect(appeal.decision).toBeNull();
    expect(typeof appeal.slaDeadline).toBe('string');
  });

  it('getAppeal returns null for unknown id', () => {
    const result = service.getAppeal('nonexistent-id');
    expect(result).toBeNull();
  });

  it('SLA deadline for urgent is set earlier than standard', () => {
    const standard = service.submitAppeal({
      sanctionId: 'sanction-002',
      offenseCode: 'TEST',
      severityTier: 'LOW',
      appellantId: 'node-002',
      actorClass: 'ai_agent',
      policyHashReference: '0xpolicyhash',
      priority: 'standard',
    });
    const urgent = service.submitAppeal({
      sanctionId: 'sanction-003',
      offenseCode: 'TEST',
      severityTier: 'LOW',
      appellantId: 'node-003',
      actorClass: 'ai_agent',
      policyHashReference: '0xpolicyhash',
      priority: 'urgent',
    });

    const stdDeadline = new Date(standard.slaDeadline).getTime();
    const urgDeadline = new Date(urgent.slaDeadline).getTime();
    expect(urgDeadline).toBeLessThan(stdDeadline);
  });
});

// ---------------------------------------------------------------------------
// 4. Identity Governance Service
// ---------------------------------------------------------------------------

import {
  evaluatePolicy,
  type PolicyAction,
  type PolicySubject,
} from '../server/services/identity-governance-service.js';

describe('Identity Governance Service — smoke', () => {
  it('evaluatePolicy returns ALLOW for authenticated admin with correct permissions', () => {
    const subject: PolicySubject = {
      authenticated: true,
      userId: 'admin-001',
      role: 'admin',
      permissions: ['identity:write', 'credential:issue', 'governance:write'],
    };

    const action: PolicyAction = 'credential:issue';
    // NOTE: evaluatePolicy(action, subject) — action comes first
    const decision = evaluatePolicy(action, subject);

    expect(decision).toBeDefined();
    expect(decision.verdict).toBe('ALLOW');
    expect(decision.action).toBe(action);
    expect(typeof decision.timestamp).toBe('string');
    expect(decision.reason).toBe('AUTHORIZED');
  });

  it('evaluatePolicy returns DENY for unauthenticated subject', () => {
    const subject: PolicySubject = { authenticated: false };
    const decision = evaluatePolicy('credential:issue', subject);

    expect(decision.verdict).toBe('DENY');
    expect(decision.reason).toBe('UNAUTHENTICATED');
  });

  it('evaluatePolicy returns DENY when role is missing required access', () => {
    const subject: PolicySubject = {
      authenticated: true,
      role: 'viewer',
      permissions: [],
    };

    const decision = evaluatePolicy('key_epoch:rotate', subject);

    expect(decision.verdict).toBe('DENY');
    expect(['INSUFFICIENT_ROLE', 'INSUFFICIENT_PERMISSION', 'SCOPE_RESTRICTED']).toContain(
      decision.reason
    );
  });

  it('decision timestamp is a valid ISO string', () => {
    const subject: PolicySubject = { authenticated: false };
    const decision = evaluatePolicy('credential:revoke', subject);
    expect(() => new Date(decision.timestamp)).not.toThrow();
    expect(new Date(decision.timestamp).toISOString()).toBe(decision.timestamp);
  });
});

// ---------------------------------------------------------------------------
// 5. CalibrationAttestationVerifierService
// ---------------------------------------------------------------------------

import {
  CalibrationAttestationVerifierService,
  InMemoryCalibrationAttestationArtifactResolver,
  CalibrationVerificationReasonCodes,
} from '../server/services/calibration-attestation-verifier.js';

describe('CalibrationAttestationVerifierService — smoke', () => {
  it('is constructable with no arguments', () => {
    const verifier = new CalibrationAttestationVerifierService();
    expect(verifier).toBeDefined();
    expect(typeof verifier.verifyCalibrationAttestation).toBe('function');
  });

  it('rejects an invalid CID (too short)', async () => {
    const resolver = new InMemoryCalibrationAttestationArtifactResolver();
    const verifier = new CalibrationAttestationVerifierService({ artifactResolver: resolver });

    const result = await verifier.verifyCalibrationAttestation({
      commitId: 'commit-abc123',
      stationId: 'STATION-001',
      calibrationAttestationCid: 'bad-cid',
    });

    expect(result).toBeDefined();
    expect(result.schemaVersion).toBe('calibration_attestation_verifier_summary/v1');
    expect(result.status).toBe('rejected');
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(typeof result.verificationId).toBe('string');
  });

  it('rejects when artifact is not found via resolver', async () => {
    const resolver = new InMemoryCalibrationAttestationArtifactResolver();
    // No fixtures registered — resolver will return null

    const verifier = new CalibrationAttestationVerifierService({ artifactResolver: resolver });

    const result = await verifier.verifyCalibrationAttestation({
      commitId: 'commit-abc123',
      stationId: 'STATION-001',
      calibrationAttestationCid: 'ipfs:QmValidLookingCidForTesting1234567890abcdef',
    });

    expect(result.status).toMatch(/rejected|error/);
    expect(Array.isArray(result.reasonCodes)).toBe(true);
  });

  it('InMemoryCalibrationAttestationArtifactResolver can register and retrieve fixtures', async () => {
    const resolver = new InMemoryCalibrationAttestationArtifactResolver();
    const cid = 'ipfs:QmTestFixture';
    const artifact = { schemaVersion: 'wrf-calibration-attestation/v1', artifactId: 'a1' };
    resolver.registerFixture(cid, artifact);
    const fetched = await resolver.fetchByCanonicalCid(cid);
    expect(fetched).toEqual(artifact);
  });

  it('CalibrationVerificationReasonCodes exports expected constants', () => {
    expect(CalibrationVerificationReasonCodes.OK).toBe('CAL_OK');
    expect(CalibrationVerificationReasonCodes.CID_INVALID).toBe('CAL_CID_INVALID');
    expect(CalibrationVerificationReasonCodes.ARTIFACT_NOT_FOUND).toBe('CAL_ARTIFACT_NOT_FOUND');
    expect(CalibrationVerificationReasonCodes.CERT_EXPIRED).toBe('CAL_CERT_EXPIRED');
  });
});
