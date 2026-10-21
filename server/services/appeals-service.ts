/**
 * Appeals adjudication service -- implements backend#36.
 *
 * State machine: submitted -> under_review -> adjudication_pending -> decided -> published
 * SLA tracking: standard (7d), urgent (48h), critical (24h)
 * Equal liability: appeal eligibility is actor-class-agnostic.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppealStatus =
  | 'submitted'
  | 'under_review'
  | 'adjudication_pending'
  | 'upheld'
  | 'reversed'
  | 'modified'
  | 'published';

export type AppealPriority = 'standard' | 'urgent' | 'critical';
export type ActorClass = 'human' | 'ai_agent' | 'robot';

export interface AppealDecision {
  verdict: 'upheld' | 'reversed' | 'modified';
  reasoning: string;
  evidenceReferences: string[];
  policyHashReference: string;
  decidedAt: string;
  decidedBy: string;
}

export interface Appeal {
  id: string;
  sanctionId: string;
  offenseCode: string;
  severityTier: string;
  appellantId: string;
  actorClass: ActorClass;
  status: AppealStatus;
  priority: AppealPriority;
  assignedReviewerId: string | null;
  submittedAt: string;
  slaDeadline: string;
  decision: AppealDecision | null;
  policyHashReference: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppealOutcomePublicationEvent {
  appealId: string;
  sanctionId: string;
  verdict: 'upheld' | 'reversed' | 'modified';
  publishedAt: string;
  policyHashReference: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SLA deadlines in milliseconds per priority tier. */
const SLA_DEADLINES: Record<AppealPriority, number> = {
  standard: 7 * 24 * 60 * 60 * 1000, // 7 days
  urgent: 48 * 60 * 60 * 1000,       // 48 hours
  critical: 24 * 60 * 60 * 1000,     // 24 hours
};

/** Allowed status transitions. */
const VALID_TRANSITIONS: Record<AppealStatus, AppealStatus[]> = {
  submitted: ['under_review'],
  under_review: ['adjudication_pending'],
  adjudication_pending: ['upheld', 'reversed', 'modified'],
  upheld: ['published'],
  reversed: ['published'],
  modified: ['published'],
  published: [],
};

const VALID_PRIORITIES: ReadonlySet<string> = new Set<AppealPriority>([
  'standard',
  'urgent',
  'critical',
]);

const VALID_ACTOR_CLASSES: ReadonlySet<string> = new Set<ActorClass>([
  'human',
  'ai_agent',
  'robot',
]);

/** Terminal statuses that are no longer subject to SLA enforcement. */
const TERMINAL_STATUSES: ReadonlySet<AppealStatus> = new Set<AppealStatus>([
  'upheld',
  'reversed',
  'modified',
  'published',
]);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AppealsService {
  private appeals: Map<string, Appeal> = new Map();
  private publications: AppealOutcomePublicationEvent[] = [];
  private reviewerPool: string[] = [];
  private nextReviewerIndex = 0;
  private nextId = 1;

  // -----------------------------------------------------------------------
  // Reviewer pool management
  // -----------------------------------------------------------------------

  /** Register a reviewer in the round-robin pool. */
  addReviewer(reviewerId: string): void {
    if (!reviewerId || typeof reviewerId !== 'string') {
      throw new Error('reviewerId must be a non-empty string');
    }
    if (!this.reviewerPool.includes(reviewerId)) {
      this.reviewerPool.push(reviewerId);
    }
  }

  // -----------------------------------------------------------------------
  // Appeal submission
  // -----------------------------------------------------------------------

  /** Submit a new appeal. Returns the created Appeal record. */
  submitAppeal(params: {
    sanctionId: string;
    offenseCode: string;
    severityTier: string;
    appellantId: string;
    actorClass: ActorClass;
    priority: AppealPriority;
    policyHashReference: string;
  }): Appeal {
    // Validate required fields
    if (!params.sanctionId) throw new Error('sanctionId is required');
    if (!params.offenseCode) throw new Error('offenseCode is required');
    if (!params.severityTier) throw new Error('severityTier is required');
    if (!params.appellantId) throw new Error('appellantId is required');
    if (!params.policyHashReference) throw new Error('policyHashReference is required');

    if (!VALID_PRIORITIES.has(params.priority)) {
      throw new Error(
        `Invalid priority "${params.priority}". Must be one of: standard, urgent, critical`,
      );
    }
    if (!VALID_ACTOR_CLASSES.has(params.actorClass)) {
      throw new Error(
        `Invalid actorClass "${params.actorClass}". Must be one of: human, ai_agent, robot`,
      );
    }

    const now = new Date();
    const slaMs = SLA_DEADLINES[params.priority];
    const slaDeadline = new Date(now.getTime() + slaMs);

    const appeal: Appeal = {
      id: `APL-${String(this.nextId++).padStart(5, '0')}`,
      sanctionId: params.sanctionId,
      offenseCode: params.offenseCode,
      severityTier: params.severityTier,
      appellantId: params.appellantId,
      actorClass: params.actorClass,
      status: 'submitted',
      priority: params.priority,
      assignedReviewerId: null,
      submittedAt: now.toISOString(),
      slaDeadline: slaDeadline.toISOString(),
      decision: null,
      policyHashReference: params.policyHashReference,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.appeals.set(appeal.id, appeal);
    return { ...appeal };
  }

  // -----------------------------------------------------------------------
  // Reviewer assignment
  // -----------------------------------------------------------------------

  /**
   * Assign a reviewer to an appeal.
   * If `reviewerId` is omitted the next reviewer is chosen via round-robin.
   */
  assignReviewer(appealId: string, reviewerId?: string): Appeal {
    const appeal = this.getOrThrow(appealId);

    let assignee: string;
    if (reviewerId) {
      assignee = reviewerId;
    } else {
      if (this.reviewerPool.length === 0) {
        throw new Error('No reviewers available in the pool');
      }
      assignee = this.reviewerPool[this.nextReviewerIndex % this.reviewerPool.length];
      this.nextReviewerIndex++;
    }

    appeal.assignedReviewerId = assignee;
    appeal.updatedAt = new Date().toISOString();
    return { ...appeal };
  }

  // -----------------------------------------------------------------------
  // Status transitions
  // -----------------------------------------------------------------------

  /** Advance the appeal to `newStatus`, validating the transition is legal. */
  transitionStatus(appealId: string, newStatus: AppealStatus): Appeal {
    const appeal = this.getOrThrow(appealId);
    const allowed = VALID_TRANSITIONS[appeal.status];

    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(
        `Invalid status transition: "${appeal.status}" -> "${newStatus}". ` +
          `Allowed transitions from "${appeal.status}": [${(allowed || []).join(', ')}]`,
      );
    }

    appeal.status = newStatus;
    appeal.updatedAt = new Date().toISOString();
    return { ...appeal };
  }

  // -----------------------------------------------------------------------
  // Decision recording
  // -----------------------------------------------------------------------

  /**
   * Record a verdict on an appeal that is in `adjudication_pending` status.
   * Automatically transitions the appeal to the verdict status.
   */
  recordDecision(
    appealId: string,
    decision: Omit<AppealDecision, 'decidedAt'>,
  ): Appeal {
    const appeal = this.getOrThrow(appealId);

    if (appeal.status !== 'adjudication_pending') {
      throw new Error(
        `Cannot record decision: appeal "${appealId}" is in status "${appeal.status}", ` +
          `expected "adjudication_pending"`,
      );
    }

    const validVerdicts: Array<AppealDecision['verdict']> = ['upheld', 'reversed', 'modified'];
    if (!validVerdicts.includes(decision.verdict)) {
      throw new Error(
        `Invalid verdict "${decision.verdict}". Must be one of: upheld, reversed, modified`,
      );
    }
    if (!decision.reasoning) {
      throw new Error('Decision reasoning is required');
    }
    if (!decision.decidedBy) {
      throw new Error('decidedBy is required');
    }

    const now = new Date().toISOString();
    appeal.decision = {
      ...decision,
      decidedAt: now,
    };
    appeal.status = decision.verdict;
    appeal.updatedAt = now;

    return { ...appeal };
  }

  // -----------------------------------------------------------------------
  // Outcome publication
  // -----------------------------------------------------------------------

  /** Move a decided appeal to `published` status. */
  publishDecision(appealId: string): Appeal {
    const appeal = this.getOrThrow(appealId);

    const publishableStatuses: AppealStatus[] = ['upheld', 'reversed', 'modified'];
    if (!publishableStatuses.includes(appeal.status)) {
      throw new Error(
        `Cannot publish appeal "${appealId}": status is "${appeal.status}", ` +
          `expected one of: upheld, reversed, modified`,
      );
    }

    const publishedAt = new Date().toISOString();
    appeal.status = 'published';
    appeal.updatedAt = publishedAt;
    this.publications.push({
      appealId: appeal.id,
      sanctionId: appeal.sanctionId,
      verdict: appeal.decision?.verdict || 'modified',
      publishedAt,
      policyHashReference: appeal.policyHashReference,
    });
    return { ...appeal };
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Return a single appeal by ID, or null if not found. */
  getAppeal(appealId: string): Appeal | null {
    const appeal = this.appeals.get(appealId);
    return appeal ? { ...appeal } : null;
  }

  /** List appeals, optionally filtered by status and/or priority. */
  listAppeals(filters?: {
    status?: AppealStatus;
    priority?: AppealPriority;
  }): Appeal[] {
    let results = Array.from(this.appeals.values());

    if (filters?.status) {
      results = results.filter((a) => a.status === filters.status);
    }
    if (filters?.priority) {
      results = results.filter((a) => a.priority === filters.priority);
    }

    return results.map((a) => ({ ...a }));
  }

  /**
   * Return all appeals that have exceeded their SLA deadline
   * and are not yet in a terminal state.
   */
  checkSlaBreaches(): Appeal[] {
    const now = Date.now();
    return Array.from(this.appeals.values())
      .filter((a) => {
        if (TERMINAL_STATUSES.has(a.status)) return false;
        return new Date(a.slaDeadline).getTime() < now;
      })
      .map((a) => ({ ...a }));
  }

  /** Publication feed for downstream governance/event consumers. */
  listOutcomePublications(limit = 100): AppealOutcomePublicationEvent[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    return this.publications.slice(-safeLimit).reverse().map(item => ({ ...item }));
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private getOrThrow(appealId: string): Appeal {
    const appeal = this.appeals.get(appealId);
    if (!appeal) {
      throw new Error(`Appeal not found: "${appealId}"`);
    }
    return appeal;
  }
}
