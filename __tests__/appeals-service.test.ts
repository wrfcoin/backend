/**
 * Appeals Adjudication Service Tests
 *
 * Covers:
 * - Full appeal lifecycle (submit -> under_review -> adjudication_pending -> decided -> published)
 * - SLA deadline calculation and breach detection
 * - Round-robin reviewer assignment
 * - Invalid transition rejection
 * - Decision recording with reasoning and evidence
 * - Actor-class-agnostic handling (equal liability)
 *
 * Issue: backend#36
 */

import {
  AppealsService,
  Appeal,
  AppealPriority,
  ActorClass,
} from '../server/services/appeals-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): AppealsService {
  return new AppealsService();
}

function submitDefault(
  svc: AppealsService,
  overrides: Partial<Parameters<AppealsService['submitAppeal']>[0]> = {},
): Appeal {
  return svc.submitAppeal({
    sanctionId: 'SANC-001',
    offenseCode: 'OFF-100',
    severityTier: 'tier-2',
    appellantId: 'user-abc',
    actorClass: 'human',
    priority: 'standard',
    policyHashReference: 'sha256:abc123',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Submission tests
// ---------------------------------------------------------------------------

describe('AppealsService - Submission', () => {
  test('should submit an appeal with valid params', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);

    expect(appeal.id).toMatch(/^APL-\d{5}$/);
    expect(appeal.sanctionId).toBe('SANC-001');
    expect(appeal.offenseCode).toBe('OFF-100');
    expect(appeal.severityTier).toBe('tier-2');
    expect(appeal.appellantId).toBe('user-abc');
    expect(appeal.actorClass).toBe('human');
    expect(appeal.status).toBe('submitted');
    expect(appeal.priority).toBe('standard');
    expect(appeal.assignedReviewerId).toBeNull();
    expect(appeal.decision).toBeNull();
    expect(appeal.policyHashReference).toBe('sha256:abc123');
    expect(appeal.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(appeal.slaDeadline).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(appeal.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(appeal.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // SLA deadline should be in the future (standard = 7 days)
    const deadlineMs = new Date(appeal.slaDeadline).getTime();
    const submittedMs = new Date(appeal.submittedAt).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(deadlineMs - submittedMs).toBe(sevenDaysMs);
  });

  test('should reject appeal with invalid priority', () => {
    const svc = makeService();
    expect(() =>
      submitDefault(svc, { priority: 'emergency' as AppealPriority }),
    ).toThrow(/Invalid priority/);
  });

  test('should reject appeal with invalid actorClass', () => {
    const svc = makeService();
    expect(() =>
      submitDefault(svc, { actorClass: 'cyborg' as ActorClass }),
    ).toThrow(/Invalid actorClass/);
  });

  test('should reject appeal with missing required fields', () => {
    const svc = makeService();
    expect(() => submitDefault(svc, { sanctionId: '' })).toThrow(/sanctionId is required/);
    expect(() => submitDefault(svc, { appellantId: '' })).toThrow(/appellantId is required/);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle test
// ---------------------------------------------------------------------------

describe('AppealsService - Full Lifecycle', () => {
  test('should transition through full lifecycle: submitted -> under_review -> adjudication_pending -> upheld -> published', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);
    expect(appeal.status).toBe('submitted');

    // submitted -> under_review
    const r1 = svc.transitionStatus(appeal.id, 'under_review');
    expect(r1.status).toBe('under_review');

    // under_review -> adjudication_pending
    const r2 = svc.transitionStatus(appeal.id, 'adjudication_pending');
    expect(r2.status).toBe('adjudication_pending');

    // Record decision (adjudication_pending -> upheld)
    const r3 = svc.recordDecision(appeal.id, {
      verdict: 'upheld',
      reasoning: 'Original sanction was correctly applied.',
      evidenceReferences: ['EV-001', 'EV-002'],
      policyHashReference: 'sha256:policy-v3',
      decidedBy: 'reviewer-001',
    });
    expect(r3.status).toBe('upheld');
    expect(r3.decision).not.toBeNull();
    expect(r3.decision!.verdict).toBe('upheld');
    expect(r3.decision!.reasoning).toBe('Original sanction was correctly applied.');
    expect(r3.decision!.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // upheld -> published
    const r4 = svc.publishDecision(appeal.id);
    expect(r4.status).toBe('published');
  });

  test('should also support reversed and modified verdicts', () => {
    const svc = makeService();

    // reversed path
    const a1 = submitDefault(svc);
    svc.transitionStatus(a1.id, 'under_review');
    svc.transitionStatus(a1.id, 'adjudication_pending');
    svc.recordDecision(a1.id, {
      verdict: 'reversed',
      reasoning: 'Sanction was incorrectly applied.',
      evidenceReferences: [],
      policyHashReference: 'sha256:policy-v3',
      decidedBy: 'reviewer-002',
    });
    const published1 = svc.publishDecision(a1.id);
    expect(published1.status).toBe('published');
    expect(published1.decision!.verdict).toBe('reversed');

    // modified path
    const a2 = submitDefault(svc);
    svc.transitionStatus(a2.id, 'under_review');
    svc.transitionStatus(a2.id, 'adjudication_pending');
    svc.recordDecision(a2.id, {
      verdict: 'modified',
      reasoning: 'Sanction severity adjusted to tier-1.',
      evidenceReferences: ['EV-010'],
      policyHashReference: 'sha256:policy-v3',
      decidedBy: 'reviewer-003',
    });
    const published2 = svc.publishDecision(a2.id);
    expect(published2.status).toBe('published');
    expect(published2.decision!.verdict).toBe('modified');
  });
});

// ---------------------------------------------------------------------------
// SLA deadline tests
// ---------------------------------------------------------------------------

describe('AppealsService - SLA Deadlines', () => {
  test('should enforce SLA deadlines per priority', () => {
    const svc = makeService();

    const standardAppeal = submitDefault(svc, { priority: 'standard' });
    const urgentAppeal = submitDefault(svc, { priority: 'urgent' });
    const criticalAppeal = submitDefault(svc, { priority: 'critical' });

    const standardDelta =
      new Date(standardAppeal.slaDeadline).getTime() -
      new Date(standardAppeal.submittedAt).getTime();
    const urgentDelta =
      new Date(urgentAppeal.slaDeadline).getTime() -
      new Date(urgentAppeal.submittedAt).getTime();
    const criticalDelta =
      new Date(criticalAppeal.slaDeadline).getTime() -
      new Date(criticalAppeal.submittedAt).getTime();

    expect(standardDelta).toBe(7 * 24 * 60 * 60 * 1000); // 7 days
    expect(urgentDelta).toBe(48 * 60 * 60 * 1000);        // 48 hours
    expect(criticalDelta).toBe(24 * 60 * 60 * 1000);      // 24 hours

    // standard > urgent > critical
    expect(standardDelta).toBeGreaterThan(urgentDelta);
    expect(urgentDelta).toBeGreaterThan(criticalDelta);
  });

  test('should detect SLA breaches for past-deadline non-terminal appeals', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);

    // Manually backdate the SLA deadline to force a breach
    const internal = (svc as any).appeals.get(appeal.id);
    internal.slaDeadline = new Date(Date.now() - 1000).toISOString();

    const breaches = svc.checkSlaBreaches();
    expect(breaches).toHaveLength(1);
    expect(breaches[0].id).toBe(appeal.id);
  });

  test('should not flag terminal appeals as SLA breaches', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);

    // Move to published (terminal)
    svc.transitionStatus(appeal.id, 'under_review');
    svc.transitionStatus(appeal.id, 'adjudication_pending');
    svc.recordDecision(appeal.id, {
      verdict: 'upheld',
      reasoning: 'Correct.',
      evidenceReferences: [],
      policyHashReference: 'sha256:x',
      decidedBy: 'r1',
    });
    svc.publishDecision(appeal.id);

    // Backdate SLA
    const internal = (svc as any).appeals.get(appeal.id);
    internal.slaDeadline = new Date(Date.now() - 1000).toISOString();

    const breaches = svc.checkSlaBreaches();
    expect(breaches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reviewer assignment (round-robin)
// ---------------------------------------------------------------------------

describe('AppealsService - Reviewer Assignment', () => {
  test('should assign reviewer via round-robin', () => {
    const svc = makeService();
    svc.addReviewer('reviewer-A');
    svc.addReviewer('reviewer-B');
    svc.addReviewer('reviewer-C');

    const a1 = submitDefault(svc);
    const a2 = submitDefault(svc);
    const a3 = submitDefault(svc);
    const a4 = submitDefault(svc);

    const r1 = svc.assignReviewer(a1.id);
    const r2 = svc.assignReviewer(a2.id);
    const r3 = svc.assignReviewer(a3.id);
    const r4 = svc.assignReviewer(a4.id); // wraps around

    expect(r1.assignedReviewerId).toBe('reviewer-A');
    expect(r2.assignedReviewerId).toBe('reviewer-B');
    expect(r3.assignedReviewerId).toBe('reviewer-C');
    expect(r4.assignedReviewerId).toBe('reviewer-A'); // round-robin wraparound
  });

  test('should assign explicit reviewer when specified', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);
    const result = svc.assignReviewer(appeal.id, 'explicit-reviewer');
    expect(result.assignedReviewerId).toBe('explicit-reviewer');
  });

  test('should throw when no reviewers are in the pool', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);
    expect(() => svc.assignReviewer(appeal.id)).toThrow(/No reviewers available/);
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe('AppealsService - Invalid Transitions', () => {
  test('should reject invalid status transitions', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);

    // submitted -> published (skipping intermediate steps)
    expect(() => svc.transitionStatus(appeal.id, 'published')).toThrow(
      /Invalid status transition/,
    );

    // submitted -> adjudication_pending (must go through under_review first)
    expect(() => svc.transitionStatus(appeal.id, 'adjudication_pending')).toThrow(
      /Invalid status transition/,
    );

    // submitted -> upheld (cannot decide without adjudication)
    expect(() => svc.transitionStatus(appeal.id, 'upheld')).toThrow(
      /Invalid status transition/,
    );
  });

  test('should reject transition from published (terminal)', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);
    svc.transitionStatus(appeal.id, 'under_review');
    svc.transitionStatus(appeal.id, 'adjudication_pending');
    svc.recordDecision(appeal.id, {
      verdict: 'upheld',
      reasoning: 'Correct.',
      evidenceReferences: [],
      policyHashReference: 'sha256:x',
      decidedBy: 'r1',
    });
    svc.publishDecision(appeal.id);

    expect(() => svc.transitionStatus(appeal.id, 'submitted')).toThrow(
      /Invalid status transition/,
    );
  });

  test('should throw for non-existent appeal ID', () => {
    const svc = makeService();
    expect(() => svc.transitionStatus('APL-99999', 'under_review')).toThrow(/Appeal not found/);
  });

  test('should reject decision recording when not in adjudication_pending', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);
    // Still in submitted, not adjudication_pending
    expect(() =>
      svc.recordDecision(appeal.id, {
        verdict: 'upheld',
        reasoning: 'test',
        evidenceReferences: [],
        policyHashReference: 'hash',
        decidedBy: 'r1',
      }),
    ).toThrow(/expected "adjudication_pending"/);
  });
});

// ---------------------------------------------------------------------------
// Decision recording
// ---------------------------------------------------------------------------

describe('AppealsService - Decision Recording', () => {
  test('should record decision with reasoning and evidence', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);
    svc.transitionStatus(appeal.id, 'under_review');
    svc.transitionStatus(appeal.id, 'adjudication_pending');

    const result = svc.recordDecision(appeal.id, {
      verdict: 'reversed',
      reasoning: 'Evidence shows the sanction was applied in error.',
      evidenceReferences: ['EV-100', 'EV-101', 'EV-102'],
      policyHashReference: 'sha256:policy-v4',
      decidedBy: 'reviewer-007',
    });

    expect(result.decision).not.toBeNull();
    expect(result.decision!.verdict).toBe('reversed');
    expect(result.decision!.reasoning).toBe('Evidence shows the sanction was applied in error.');
    expect(result.decision!.evidenceReferences).toEqual(['EV-100', 'EV-101', 'EV-102']);
    expect(result.decision!.policyHashReference).toBe('sha256:policy-v4');
    expect(result.decision!.decidedBy).toBe('reviewer-007');
    expect(result.decision!.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.status).toBe('reversed');
  });

  test('should reject decision without reasoning', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);
    svc.transitionStatus(appeal.id, 'under_review');
    svc.transitionStatus(appeal.id, 'adjudication_pending');

    expect(() =>
      svc.recordDecision(appeal.id, {
        verdict: 'upheld',
        reasoning: '',
        evidenceReferences: [],
        policyHashReference: 'hash',
        decidedBy: 'r1',
      }),
    ).toThrow(/reasoning is required/);
  });

  test('should reject decision without decidedBy', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);
    svc.transitionStatus(appeal.id, 'under_review');
    svc.transitionStatus(appeal.id, 'adjudication_pending');

    expect(() =>
      svc.recordDecision(appeal.id, {
        verdict: 'upheld',
        reasoning: 'Some reason',
        evidenceReferences: [],
        policyHashReference: 'hash',
        decidedBy: '',
      }),
    ).toThrow(/decidedBy is required/);
  });
});

// ---------------------------------------------------------------------------
// Actor-class-agnostic behavior
// ---------------------------------------------------------------------------

describe('AppealsService - Actor-Class Agnosticism', () => {
  test('should be actor-class-agnostic in appeal handling', () => {
    const svc = makeService();
    const actorClasses: ActorClass[] = ['human', 'ai_agent', 'robot'];

    for (const actorClass of actorClasses) {
      const appeal = submitDefault(svc, { actorClass });
      expect(appeal.actorClass).toBe(actorClass);
      expect(appeal.status).toBe('submitted');

      // Full lifecycle should work identically for all actor classes
      svc.transitionStatus(appeal.id, 'under_review');
      svc.transitionStatus(appeal.id, 'adjudication_pending');
      svc.recordDecision(appeal.id, {
        verdict: 'reversed',
        reasoning: `Appeal by ${actorClass} found valid.`,
        evidenceReferences: ['EV-A'],
        policyHashReference: 'sha256:policy-v1',
        decidedBy: 'reviewer-X',
      });
      const published = svc.publishDecision(appeal.id);
      expect(published.status).toBe('published');
      expect(published.decision!.verdict).toBe('reversed');
    }
  });
});

// ---------------------------------------------------------------------------
// Query / listing
// ---------------------------------------------------------------------------

describe('AppealsService - Queries', () => {
  test('should list all appeals', () => {
    const svc = makeService();
    submitDefault(svc);
    submitDefault(svc);
    submitDefault(svc);

    const all = svc.listAppeals();
    expect(all).toHaveLength(3);
  });

  test('should filter by status', () => {
    const svc = makeService();
    const a1 = submitDefault(svc);
    submitDefault(svc);
    svc.transitionStatus(a1.id, 'under_review');

    const underReview = svc.listAppeals({ status: 'under_review' });
    expect(underReview).toHaveLength(1);
    expect(underReview[0].id).toBe(a1.id);
  });

  test('should filter by priority', () => {
    const svc = makeService();
    submitDefault(svc, { priority: 'standard' });
    submitDefault(svc, { priority: 'urgent' });
    submitDefault(svc, { priority: 'critical' });

    const urgent = svc.listAppeals({ priority: 'urgent' });
    expect(urgent).toHaveLength(1);
    expect(urgent[0].priority).toBe('urgent');
  });

  test('should return null for non-existent appeal', () => {
    const svc = makeService();
    expect(svc.getAppeal('APL-99999')).toBeNull();
  });

  test('should return a defensive copy (not internal reference)', () => {
    const svc = makeService();
    const appeal = submitDefault(svc);
    const fetched = svc.getAppeal(appeal.id)!;
    fetched.status = 'published' as any; // mutate the copy

    // Internal state should be unaffected
    const refetched = svc.getAppeal(appeal.id)!;
    expect(refetched.status).toBe('submitted');
  });
});
