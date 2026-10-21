import {
  createSanctionsOrchestrationRouter,
} from '../server/routes/sanctions-orchestration-routes.js';
import {
  SanctionsOrchestrationService,
} from '../server/services/sanctions-orchestration-service.js';

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

describe('Sanctions Orchestration Routes', () => {
  let service: SanctionsOrchestrationService;
  let router: any;

  beforeEach(() => {
    service = new SanctionsOrchestrationService();
    router = createSanctionsOrchestrationRouter(service);
  });

  test('POST /cases creates lifecycle case', () => {
    const req = mockReq({}, {
      actorId: 'station-44',
      actorClass: 'robot',
      offenseCode: 'DATA-003',
      severityTier: 'critical',
      rationale: 'tampered payload signature',
      policyHashReference: 'sha256:policy-v3',
      policyVersion: 3,
      requestedBy: 'moderator-1',
      temporaryBanBlocks: 120,
      slashBps: 500,
      cooldownBlocks: 360,
    });
    const res = mockRes();

    getHandler(router, 'POST', '/cases')(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('proposed');
    expect(res.body.data.id).toMatch(/^SANC-ORCH-\d{6}$/);
  });

  test('POST /cases/:id/transitions executes ban/slash transition sequence', () => {
    const createRes = mockRes();
    getHandler(router, 'POST', '/cases')(
      mockReq({}, {
        actorId: 'agent-7',
        actorClass: 'ai_agent',
        offenseCode: 'ECON-002',
        severityTier: 'major',
        rationale: 'front-running cluster confirmed',
        policyHashReference: 'sha256:policy-v3',
        policyVersion: 3,
        requestedBy: 'moderator-2',
        temporaryBanBlocks: 40,
        slashBps: 300,
        cooldownBlocks: 80,
      }),
      createRes,
    );
    const caseId = createRes.body.data.id;

    const banRes = mockRes();
    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: caseId }, {
        action: 'activate_temporary_ban',
        requestedBy: 'moderator-2',
        currentBlock: 700,
      }),
      banRes,
    );

    expect(banRes.statusCode).toBe(200);
    expect(banRes.body.data.status).toBe('temporary_ban_active');

    const slashRes = mockRes();
    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: caseId }, {
        action: 'request_slash',
        requestedBy: 'moderator-2',
        slashTxReference: 'tx:0xabc123',
      }),
      slashRes,
    );

    expect(slashRes.statusCode).toBe(200);
    expect(slashRes.body.data.status).toBe('slashing_requested');
    expect(slashRes.body.data.slashRequest.status).toBe('executed');
  });

  test('GET /cases/:id/audit returns action-level audit trail', () => {
    const createRes = mockRes();
    getHandler(router, 'POST', '/cases')(
      mockReq({}, {
        actorId: 'human-12',
        actorClass: 'human',
        offenseCode: 'CONS-001',
        severityTier: 'critical',
        rationale: 'double-signing evidence confirmed',
        policyHashReference: 'sha256:policy-v3',
        policyVersion: 3,
        requestedBy: 'moderator-5',
        temporaryBanBlocks: 100,
        slashBps: 700,
        cooldownBlocks: 200,
      }),
      createRes,
    );
    const caseId = createRes.body.data.id;

    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: caseId }, {
        action: 'activate_temporary_ban',
        requestedBy: 'moderator-5',
        currentBlock: 10,
      }),
      mockRes(),
    );

    const auditRes = mockRes();
    getHandler(router, 'GET', '/cases/:id/audit')(mockReq({ id: caseId }), auditRes);

    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.body.success).toBe(true);
    expect(auditRes.body.count).toBe(2);
    expect(auditRes.body.data[0].eventType).toBe('case_created');
    expect(auditRes.body.data[1].action).toBe('activate_temporary_ban');
  });

  test('GET /metrics exposes sanction resolution and appeal transparency counters', () => {
    const createRes = mockRes();
    getHandler(router, 'POST', '/cases')(
      mockReq({}, {
        actorId: 'human-99',
        actorClass: 'human',
        offenseCode: 'DATA-002',
        severityTier: 'moderate',
        rationale: 'low-quality submissions persisted for 4 rounds',
        policyHashReference: 'sha256:policy-v3',
        policyVersion: 3,
        requestedBy: 'moderator-6',
        temporaryBanBlocks: 20,
        slashBps: 80,
        cooldownBlocks: 40,
      }),
      createRes,
    );
    const caseId = createRes.body.data.id;

    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: caseId }, {
        action: 'activate_temporary_ban',
        requestedBy: 'moderator-6',
        currentBlock: 100,
      }),
      mockRes(),
    );
    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: caseId }, {
        action: 'submit_appeal',
        requestedBy: 'participant-99',
      }),
      mockRes(),
    );
    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: caseId }, {
        action: 'begin_appeal_review',
        requestedBy: 'reviewer-6',
      }),
      mockRes(),
    );
    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: caseId }, {
        action: 'resolve_appeal_upheld',
        requestedBy: 'reviewer-6',
        reason: 'policy-conformant evidence retained',
      }),
      mockRes(),
    );
    getHandler(router, 'POST', '/cases/:id/transitions')(
      mockReq({ id: caseId }, {
        action: 'close_case',
        requestedBy: 'moderator-6',
      }),
      mockRes(),
    );

    const metricsRes = mockRes();
    getHandler(router, 'GET', '/metrics')(mockReq(), metricsRes);

    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.body.data.totalCases).toBe(1);
    expect(metricsRes.body.data.closedCases).toBe(1);
    expect(metricsRes.body.data.appealsSubmitted).toBe(1);
    expect(metricsRes.body.data.appealsResolved).toBe(1);
    expect(metricsRes.body.data.appealResolutionTransparency).toBe(1);
  });
});
