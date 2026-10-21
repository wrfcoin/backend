import express from 'express';
import request from 'supertest';
import appealsRouter from '../../server/routes/appeals-routes.js';

describe('appeals routes', () => {
  it('runs adjudication lifecycle through publish', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/appeals', appealsRouter);

    const created = await request(app)
      .post('/api/appeals')
      .send({
        sanctionId: 'SANC-001',
        offenseCode: 'DATA-003',
        severityTier: 'critical',
        appellantId: 'did:wrf:alice',
        actorClass: 'human',
        priority: 'urgent',
        policyHashReference: 'sha256:policy-v1',
      });

    expect(created.status).toBe(201);
    const appealId = created.body.data.id;

    await request(app).post('/api/appeals/reviewers').send({ reviewerId: 'rev-1' });

    const assign = await request(app)
      .put(`/api/appeals/${appealId}/assign`)
      .send({ reviewerId: 'rev-1' });
    expect(assign.status).toBe(200);

    const toReview = await request(app)
      .put(`/api/appeals/${appealId}/transition`)
      .send({ status: 'under_review' });
    expect(toReview.status).toBe(200);

    const toPending = await request(app)
      .put(`/api/appeals/${appealId}/transition`)
      .send({ status: 'adjudication_pending' });
    expect(toPending.status).toBe(200);

    const decided = await request(app)
      .put(`/api/appeals/${appealId}/decide`)
      .send({
        verdict: 'modified',
        reasoning: 'Partial reversal after evidence review',
        evidenceReferences: ['attestation-1'],
        policyHashReference: 'sha256:policy-v1',
        decidedBy: 'rev-1',
      });
    expect(decided.status).toBe(200);

    const published = await request(app).post(`/api/appeals/${appealId}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe('published');

    const publicationFeed = await request(app).get('/api/appeals/publications');
    expect(publicationFeed.status).toBe(200);
    expect(publicationFeed.body.success).toBe(true);
    expect(publicationFeed.body.count).toBeGreaterThanOrEqual(1);
  });
});
