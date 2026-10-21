import express from 'express';
import request from 'supertest';
import reputationRouter from '../../server/routes/reputationRoutes.js';

describe('reputation routes', () => {
  it('records events, returns score and rankings', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/reputation', reputationRouter);

    const identity = '0x1234567890abcdef1234567890abcdef12345678';

    const event = await request(app)
      .post('/api/reputation/events')
      .send({
        identityDid: identity,
        role: 'collector',
        eventType: 'weather_submission',
        dataQuality: 92,
        uptime: 88,
        verificationAccuracy: 90,
        communityContribution: 70,
      });

    expect(event.status).toBe(201);
    expect(event.body.success).toBe(true);

    const score = await request(app)
      .get(`/api/reputation/identities/${identity}/score`);

    expect(score.status).toBe(200);
    expect(score.body.success).toBe(true);
    expect(score.body.reputation.tier).toBeDefined();

    const rankings = await request(app)
      .get('/api/reputation/rankings?page=1&limit=5');

    expect(rankings.status).toBe(200);
    expect(rankings.body.success).toBe(true);
    expect(Array.isArray(rankings.body.data)).toBe(true);
  });
});
