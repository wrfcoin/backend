import {
  SanctionsOrchestrationService,
  type ActorClass,
} from '../server/services/sanctions-orchestration-service.js';

function createCase(service: SanctionsOrchestrationService, actorClass: ActorClass = 'human') {
  return service.createSanctionCase({
    actorId: `actor-${actorClass}`,
    actorClass,
    offenseCode: 'DATA-003',
    severityTier: 'critical',
    rationale: 'Fabricated sensor payloads with confidence > 0.95',
    policyHashReference: 'sha256:policy-v3',
    policyVersion: 3,
    requestedBy: 'moderator-1',
    temporaryBanBlocks: 120,
    slashBps: 600,
    cooldownBlocks: 300,
  });
}

describe('SanctionsOrchestrationService', () => {
  let service: SanctionsOrchestrationService;

  beforeEach(() => {
    service = new SanctionsOrchestrationService();
  });

  test('creates sanction case with proposed lifecycle status', () => {
    const created = createCase(service, 'ai_agent');

    expect(created.id).toMatch(/^SANC-ORCH-\d{6}$/);
    expect(created.status).toBe('proposed');
    expect(created.actorClass).toBe('ai_agent');
    expect(created.slashRequest.status).toBe('not_requested');

    const audit = service.listAuditTrail(created.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].eventType).toBe('case_created');
  });

  test('enforces lifecycle transitions for ban, slash, cooldown, appeal, and closure', () => {
    const created = createCase(service, 'human');

    const banActive = service.transitionSanctionCase(created.id, {
      action: 'activate_temporary_ban',
      requestedBy: 'moderator-2',
      currentBlock: 1000,
    });
    expect(banActive.status).toBe('temporary_ban_active');

    const slashRequested = service.transitionSanctionCase(created.id, {
      action: 'request_slash',
      requestedBy: 'moderator-2',
    });
    expect(slashRequested.status).toBe('slashing_requested');
    expect(slashRequested.slashRequest.status).toBe('pending');

    const cooldown = service.transitionSanctionCase(created.id, {
      action: 'start_cooldown',
      requestedBy: 'moderator-3',
      currentBlock: 1020,
      reason: 'cooldown after slashing request',
    });
    expect(cooldown.status).toBe('cooldown_active');
    expect(cooldown.cooldown.endsAtBlock).toBe(1320);

    const appealed = service.transitionSanctionCase(created.id, {
      action: 'submit_appeal',
      requestedBy: 'actor-human',
      reason: 'evidence includes stale station metadata',
    });
    expect(appealed.status).toBe('appeal_submitted');

    const underReview = service.transitionSanctionCase(created.id, {
      action: 'begin_appeal_review',
      requestedBy: 'reviewer-7',
    });
    expect(underReview.status).toBe('appeal_under_review');

    const resolved = service.transitionSanctionCase(created.id, {
      action: 'resolve_appeal_modified',
      requestedBy: 'reviewer-7',
      reason: 'slash reduced after calibration proof',
    });
    expect(resolved.status).toBe('appeal_modified');
    expect(resolved.appeal.status).toBe('modified');

    const closed = service.transitionSanctionCase(created.id, {
      action: 'close_case',
      requestedBy: 'moderator-4',
    });
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();

    const audit = service.listAuditTrail(created.id);
    expect(audit).toHaveLength(8);
    expect(audit[audit.length - 1].toStatus).toBe('closed');
  });

  test('blocks close while cooldown window is still active', () => {
    const created = createCase(service, 'robot');

    service.transitionSanctionCase(created.id, {
      action: 'activate_temporary_ban',
      requestedBy: 'moderator-2',
      currentBlock: 220,
    });

    service.transitionSanctionCase(created.id, {
      action: 'start_cooldown',
      requestedBy: 'moderator-2',
      currentBlock: 250,
    });

    expect(() =>
      service.transitionSanctionCase(created.id, {
        action: 'close_case',
        requestedBy: 'moderator-2',
        currentBlock: 400,
      }),
    ).toThrow(/Cooldown window still active/);

    const closed = service.transitionSanctionCase(created.id, {
      action: 'close_case',
      requestedBy: 'moderator-2',
      currentBlock: 550,
    });
    expect(closed.status).toBe('closed');
  });

  test('rejects invalid transition order', () => {
    const created = createCase(service, 'human');

    expect(() =>
      service.transitionSanctionCase(created.id, {
        action: 'begin_appeal_review',
        requestedBy: 'reviewer-1',
      }),
    ).toThrow(/Invalid transition action/);
  });

  test('applies actor-class-neutral lifecycle behavior', () => {
    const actorClasses: ActorClass[] = ['human', 'ai_agent', 'robot'];

    for (const actorClass of actorClasses) {
      const created = createCase(service, actorClass);
      const withBan = service.transitionSanctionCase(created.id, {
        action: 'activate_temporary_ban',
        requestedBy: `moderator-${actorClass}`,
        currentBlock: 10,
      });
      const withSlash = service.transitionSanctionCase(created.id, {
        action: 'request_slash',
        requestedBy: `moderator-${actorClass}`,
      });

      expect(withBan.status).toBe('temporary_ban_active');
      expect(withSlash.status).toBe('slashing_requested');
      expect(withSlash.slashRequest.slashBps).toBe(600);
    }
  });

  test('returns transparency metrics for sanction and appeal resolution', () => {
    const created = createCase(service);

    service.transitionSanctionCase(created.id, {
      action: 'activate_temporary_ban',
      requestedBy: 'moderator-5',
      currentBlock: 100,
    });
    service.transitionSanctionCase(created.id, {
      action: 'submit_appeal',
      requestedBy: 'actor-1',
    });
    service.transitionSanctionCase(created.id, {
      action: 'begin_appeal_review',
      requestedBy: 'reviewer-3',
    });
    service.transitionSanctionCase(created.id, {
      action: 'resolve_appeal_upheld',
      requestedBy: 'reviewer-3',
      reason: 'evidence confirms original sanction',
    });
    service.transitionSanctionCase(created.id, {
      action: 'close_case',
      requestedBy: 'moderator-5',
    });

    const metrics = service.getMetrics();
    expect(metrics.totalCases).toBe(1);
    expect(metrics.closedCases).toBe(1);
    expect(metrics.appealsSubmitted).toBe(1);
    expect(metrics.appealsResolved).toBe(1);
    expect(metrics.appealResolutionTransparency).toBe(1);
  });
});
