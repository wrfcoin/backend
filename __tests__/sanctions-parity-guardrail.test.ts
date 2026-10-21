import {
  GuardrailHaltError,
  SanctionsOrchestrationService,
} from '../server/services/sanctions-orchestration-service.js';
import {
  createSanctionsOrchestrationRouter,
} from '../server/routes/sanctions-orchestration-routes.js';

function createCase(service: SanctionsOrchestrationService, input: {
  actorId: string;
  actorClass: 'human' | 'ai_agent' | 'robot';
  slashBps: number;
  temporaryBanBlocks: number;
}) {
  return service.createSanctionCase({
    actorId: input.actorId,
    actorClass: input.actorClass,
    offenseCode: 'DATA-003',
    severityTier: 'critical',
    rationale: 'equivalent misconduct parity test',
    policyHashReference: 'sha256:policy-v4',
    policyVersion: 4,
    requestedBy: 'moderator-guardrail',
    temporaryBanBlocks: input.temporaryBanBlocks,
    slashBps: input.slashBps,
    cooldownBlocks: 300,
  });
}

function mockReq(params: Record<string, string> = {}, body: any = {}, query: any = {}): any {
  return { params, body, query };
}

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

function getHandler(router: any, method: string, pathSuffix: string): Function {
  for (const layer of router.stack) {
    if (
      layer.route &&
      layer.route.path === pathSuffix &&
      layer.route.methods[method.toLowerCase()]
    ) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${pathSuffix}`);
}

describe('Sanctions parity guardrail', () => {
  test('halts sanction transition when parity drift exceeds threshold', () => {
    const service = new SanctionsOrchestrationService();

    const human = createCase(service, {
      actorId: 'human-1',
      actorClass: 'human',
      slashBps: 300,
      temporaryBanBlocks: 120,
    });
    const ai = createCase(service, {
      actorId: 'ai-1',
      actorClass: 'ai_agent',
      slashBps: 300,
      temporaryBanBlocks: 120,
    });

    service.transitionSanctionCase(human.id, {
      action: 'activate_temporary_ban',
      requestedBy: 'moderator-1',
      currentBlock: 100,
    });
    service.transitionSanctionCase(ai.id, {
      action: 'activate_temporary_ban',
      requestedBy: 'moderator-1',
      currentBlock: 100,
    });

    const robot = createCase(service, {
      actorId: 'robot-1',
      actorClass: 'robot',
      slashBps: 950,
      temporaryBanBlocks: 120,
    });

    expect(() =>
      service.transitionSanctionCase(robot.id, {
        action: 'request_slash',
        requestedBy: 'moderator-2',
      }),
    ).toThrow(GuardrailHaltError);

    const state = service.getGuardrailState();
    expect(state.activeHalts.length).toBe(1);
    expect(state.activeHalts[0].sanctionCaseId).toBe(robot.id);
    expect(state.activeHalts[0].metric).toBe('slashBps');
  });

  test('allows transition with audited guardrail override', () => {
    const service = new SanctionsOrchestrationService();

    const human = createCase(service, {
      actorId: 'human-2',
      actorClass: 'human',
      slashBps: 280,
      temporaryBanBlocks: 90,
    });
    const ai = createCase(service, {
      actorId: 'ai-2',
      actorClass: 'ai_agent',
      slashBps: 280,
      temporaryBanBlocks: 90,
    });

    service.transitionSanctionCase(human.id, {
      action: 'activate_temporary_ban',
      requestedBy: 'moderator-3',
      currentBlock: 200,
    });
    service.transitionSanctionCase(ai.id, {
      action: 'activate_temporary_ban',
      requestedBy: 'moderator-3',
      currentBlock: 200,
    });

    const robot = createCase(service, {
      actorId: 'robot-2',
      actorClass: 'robot',
      slashBps: 900,
      temporaryBanBlocks: 90,
    });

    let haltId = '';
    try {
      service.transitionSanctionCase(robot.id, {
        action: 'request_slash',
        requestedBy: 'moderator-4',
      });
    } catch (error) {
      if (error instanceof GuardrailHaltError) {
        haltId = error.halt.haltId;
      }
    }

    const transitioned = service.transitionSanctionCase(robot.id, {
      action: 'request_slash',
      requestedBy: 'moderator-4',
      guardrailOverride: {
        approvedBy: 'policy-admin-1',
        reason: 'Manual parity review approved emergency enforcement.',
        haltId,
      },
    });

    expect(transitioned.status).toBe('slashing_requested');

    const audit = service.listAuditTrail(robot.id);
    expect(audit.some(event => event.eventType === 'guardrail_halt')).toBe(true);
    expect(audit.some(event => event.eventType === 'guardrail_override')).toBe(true);
  });

  test('route returns 409 payload for guardrail halt and exposes escalation path', () => {
    const service = new SanctionsOrchestrationService();
    const router = createSanctionsOrchestrationRouter(service);

    const create = (actorId: string, actorClass: 'human' | 'ai_agent' | 'robot', slashBps: number) => {
      const res = mockRes();
      getHandler(router, 'POST', '/cases')(
        mockReq({}, {
          actorId,
          actorClass,
          offenseCode: 'DATA-003',
          severityTier: 'critical',
          rationale: 'parity-route-test',
          policyHashReference: 'sha256:policy-v4',
          policyVersion: 4,
          requestedBy: 'moderator-route',
          temporaryBanBlocks: 100,
          slashBps,
          cooldownBlocks: 200,
        }),
        res,
      );
      return res.body.data.id;
    };

    const hId = create('human-route', 'human', 300);
    const aId = create('ai-route', 'ai_agent', 300);
    const rId = create('robot-route', 'robot', 900);

    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: hId }, { action: 'activate_temporary_ban', requestedBy: 'moderator-route', currentBlock: 300 }),
      mockRes(),
    );
    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: aId }, { action: 'activate_temporary_ban', requestedBy: 'moderator-route', currentBlock: 300 }),
      mockRes(),
    );

    const haltRes = mockRes();
    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: rId }, { action: 'request_slash', requestedBy: 'moderator-route' }),
      haltRes,
    );

    expect(haltRes.statusCode).toBe(409);
    expect(haltRes.body.code).toBe('PARITY_GUARDRAIL_HALT');
    expect(haltRes.body.halt).toHaveProperty('haltId');
    expect(haltRes.body.escalation).toHaveProperty('channel');
  });
});
