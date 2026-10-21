import express from 'express';
import request from 'supertest';
import { createAbuseRiskRouter } from '../../server/routes/abuse-risk-routes.js';

describe('abuse risk routes', () => {
  it('assesses participant risk and records outcomes', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/integrity/risk', createAbuseRiskRouter());

    const assess = await request(app)
      .post('/api/integrity/risk/assess')
      .send({
        participantId: '0xabc123',
        actorClass: 'human',
        indicators: {
          spam_burst: 0.7,
          duplicate_payload: 0.4,
        },
      });

    expect(assess.status).toBe(201);
    expect(assess.body.success).toBe(true);
    const assessmentId = assess.body.data.assessmentId;

    const outcome = await request(app)
      .post(`/api/integrity/risk/${assessmentId}/outcome`)
      .send({ outcome: 'confirmed_abuse' });

    expect(outcome.status).toBe(200);
    expect(outcome.body.success).toBe(true);
    expect(outcome.body.data.metrics.totalAssessments).toBeGreaterThanOrEqual(1);
  });
});
