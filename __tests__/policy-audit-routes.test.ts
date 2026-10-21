/**
 * Policy Audit Routes — unit tests
 *
 * Tests the sanction reason, timeline, and evidence endpoints
 * using direct service-layer calls (no HTTP server required).
 *
 * Issues: backend#35
 */

import {
  SanctionStore,
  createPolicyAuditRouter,
  SanctionReasonResponse,
  SanctionTimelineResponse,
  SanctionEvidenceResponse,
  AppealInfoResponse,
  SanctionRiskFactorsResponse,
  SanctionRecord,
} from '../server/routes/policy-audit-routes.js';
import { getOffenseByCode, OFFENSE_TAXONOMY } from '../server/governance/offense-taxonomy.js';

// ---------------------------------------------------------------------------
// Helpers — lightweight mock Express req/res
// ---------------------------------------------------------------------------

function mockReq(params: Record<string, string> = {}): any {
  return { params };
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

/**
 * Extract route handler from the router by method + path suffix.
 * Express Router stores layers with regexp routes; we match on the path.
 */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Policy Audit Routes', () => {
  let store: SanctionStore;
  let router: any;

  beforeEach(() => {
    store = new SanctionStore(); // seeded with SANC-001, SANC-002, SANC-003
    router = createPolicyAuditRouter(store);
  });

  // -------------------------------------------------------------------------
  // 1. GET /reason returns aligned offense code and description
  // -------------------------------------------------------------------------
  test('GET /reason returns aligned offense code and description', () => {
    const req = mockReq({ id: 'SANC-001' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/reason');
    handler(req, res);

    expect(res.statusCode).toBe(200);
    const data: SanctionReasonResponse = res.body.data;
    expect(data.offenseCode).toBe('CONS-001');
    expect(data.offenseCategory).toBe('consensus');
    expect(data.severity).toBe('critical');

    // Verify the description matches the taxonomy
    const offense = getOffenseByCode('CONS-001');
    expect(offense).toBeDefined();
    expect(data.humanReadableReason).toBe(offense!.description);
  });

  // -------------------------------------------------------------------------
  // 2. GET /reason returns 404 for non-existent sanction
  // -------------------------------------------------------------------------
  test('GET /reason returns 404 for non-existent sanction', () => {
    const req = mockReq({ id: 'SANC-NONEXISTENT' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/reason');
    handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('SANC-NONEXISTENT');
  });

  // -------------------------------------------------------------------------
  // 3. GET /reason includes appeal link when eligible
  // -------------------------------------------------------------------------
  test('GET /reason includes appeal link when eligible and null when not', () => {
    // SANC-001 is appeal-eligible
    const req1 = mockReq({ id: 'SANC-001' });
    const res1 = mockRes();
    getHandler(router, 'GET', '/:id/reason')(req1, res1);
    expect(res1.body.data.appealEligible).toBe(true);
    expect(res1.body.data.appealLink).toBe('/api/sanctions/SANC-001/appeal');

    // SANC-003 is not appeal-eligible
    const req2 = mockReq({ id: 'SANC-003' });
    const res2 = mockRes();
    getHandler(router, 'GET', '/:id/reason')(req2, res2);
    expect(res2.body.data.appealEligible).toBe(false);
    expect(res2.body.data.appealLink).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. GET /timeline returns events in chronological order
  // -------------------------------------------------------------------------
  test('GET /timeline returns events in chronological order', () => {
    const req = mockReq({ id: 'SANC-002' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/timeline');
    handler(req, res);

    expect(res.statusCode).toBe(200);
    const data: SanctionTimelineResponse = res.body.data;
    expect(data.sanctionId).toBe('SANC-002');
    expect(data.events.length).toBeGreaterThanOrEqual(2);

    // Verify chronological order
    for (let i = 1; i < data.events.length; i++) {
      const prev = new Date(data.events[i - 1].timestamp).getTime();
      const curr = new Date(data.events[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }

    // SANC-002 has an appeal_submitted event
    const eventTypes = data.events.map(e => e.eventType);
    expect(eventTypes).toContain('offense_detected');
    expect(eventTypes).toContain('sanction_applied');
    expect(eventTypes).toContain('appeal_submitted');
  });

  // -------------------------------------------------------------------------
  // 5. GET /evidence returns typed evidence items
  // -------------------------------------------------------------------------
  test('GET /evidence returns typed evidence items', () => {
    const req = mockReq({ id: 'SANC-003' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/evidence');
    handler(req, res);

    expect(res.statusCode).toBe(200);
    const data: SanctionEvidenceResponse = res.body.data;
    expect(data.sanctionId).toBe('SANC-003');
    expect(data.offenseCode).toBe('ECON-002');
    expect(data.evidenceItems.length).toBe(2);

    // Each item must have required fields and a valid type
    const validTypes = ['transaction', 'attestation', 'quality_report', 'validator_report'];
    for (const item of data.evidenceItems) {
      expect(item.id).toBeTruthy();
      expect(validTypes).toContain(item.type);
      expect(item.description).toBeTruthy();
      expect(item.reference).toBeTruthy();
      expect(item.timestamp).toBeTruthy();
    }
  });

  // -------------------------------------------------------------------------
  // 6. GET /reason includes policy hash reference
  // -------------------------------------------------------------------------
  test('GET /reason includes policy hash reference and version', () => {
    const req = mockReq({ id: 'SANC-001' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/reason');
    handler(req, res);

    const data: SanctionReasonResponse = res.body.data;
    expect(data.policyHashReference).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(data.policyVersion).toBe(3);
    expect(typeof data.policyVersion).toBe('number');
  });

  // -------------------------------------------------------------------------
  // 7. GET /evidence includes confidence scores
  // -------------------------------------------------------------------------
  test('GET /evidence includes confidence scores on each item', () => {
    const req = mockReq({ id: 'SANC-001' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/evidence');
    handler(req, res);

    expect(res.statusCode).toBe(200);
    const data: SanctionEvidenceResponse = res.body.data;
    for (const item of data.evidenceItems) {
      expect(typeof item.confidenceScore).toBe('number');
      expect(item.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(item.confidenceScore).toBeLessThanOrEqual(1);
    }
  });

  // -------------------------------------------------------------------------
  // 8. GET /appeal-info returns appeal eligibility and instructions
  // -------------------------------------------------------------------------
  test('GET /appeal-info returns eligibility and instructions for eligible sanction', () => {
    const req = mockReq({ id: 'SANC-001' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/appeal-info');
    handler(req, res);

    expect(res.statusCode).toBe(200);
    const data: AppealInfoResponse = res.body.data;
    expect(data.sanctionId).toBe('SANC-001');
    expect(data.appealEligible).toBe(true);
    expect(data.appealSubmitted).toBe(false);
    expect(data.appealEndpoint).toBe('/api/appeals');
    expect(data.appealDeadline).toBeTruthy();
    expect(data.slaTiers.standard).toBe('7 days');
    expect(data.slaTiers.urgent).toBe('48 hours');
    expect(data.slaTiers.critical).toBe('24 hours');
    expect(data.instructions.length).toBeGreaterThanOrEqual(3);
  });

  test('GET /appeal-info shows appealSubmitted=true for SANC-002', () => {
    const req = mockReq({ id: 'SANC-002' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/appeal-info');
    handler(req, res);

    expect(res.statusCode).toBe(200);
    const data: AppealInfoResponse = res.body.data;
    expect(data.appealSubmitted).toBe(true);
  });

  test('GET /appeal-info returns 404 for non-existent sanction', () => {
    const req = mockReq({ id: 'SANC-NONEXISTENT' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/appeal-info');
    handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 9. GET /risk-factors returns contributing risk factors
  // -------------------------------------------------------------------------
  test('GET /risk-factors returns risk factor breakdown', () => {
    const req = mockReq({ id: 'SANC-003' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/risk-factors');
    handler(req, res);

    expect(res.statusCode).toBe(200);
    const data: SanctionRiskFactorsResponse = res.body.data;
    expect(data.sanctionId).toBe('SANC-003');
    expect(data.offenseCode).toBe('ECON-002');
    expect(data.riskFactors.length).toBe(9); // 9 risk factors from abuse-risk-service

    // ECON-002 is economic/manipulation — manipulation factors should be triggered
    const manipulationFactors = data.riskFactors.filter(f => f.category === 'manipulation');
    for (const factor of manipulationFactors) {
      expect(factor.triggered).toBe(true);
    }

    // Each factor must have required fields
    for (const factor of data.riskFactors) {
      expect(factor.key).toBeTruthy();
      expect(typeof factor.weight).toBe('number');
      expect(typeof factor.warnThreshold).toBe('number');
      expect(typeof factor.highThreshold).toBe('number');
      expect(typeof factor.triggered).toBe('boolean');
      expect(factor.humanReadableExplanation).toBeTruthy();
    }
  });

  test('GET /risk-factors returns 404 for non-existent sanction', () => {
    const req = mockReq({ id: 'SANC-NONEXISTENT' });
    const res = mockRes();

    const handler = getHandler(router, 'GET', '/:id/risk-factors');
    handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
