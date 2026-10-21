import express from 'express';
import request from 'supertest';
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (req: any, res: any, next: () => void) => {
    if (req.get('authorization') === 'Bearer resilience-route-test-token') {
      req.user = { id: 'resilience-tester' };
      next();
      return;
    }

    res.status(401).json({
      success: false,
      error: {
        code: 'NO_TOKEN',
        message: 'Access token is required',
      },
    });
  },
}));

import resilienceRoutes from '../../routes/resilience.js';

describe('resilience routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/resilience', resilienceRoutes);

  function authorized(req: request.Test) {
    return req.set('Authorization', 'Bearer resilience-route-test-token');
  }

  it('returns participation compliance payload', async () => {
    const res = await request(app).get('/api/resilience/participation/compliance');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('privacySafeTelemetry', true);
  });

  it('creates and transitions synthetic incidents', async () => {
    const created = await authorized(
      request(app).post('/api/resilience/incidents/synthetic')
    ).send({
      campaignType: 'astroturf',
      severity: 'critical',
      actorClass: 'human',
      summary: 'coordinated campaign',
    });

    expect(created.status).toBe(201);
    const incidentId = created.body.data.id;

    const transitioned = await authorized(
      request(app).post(
        `/api/resilience/incidents/synthetic/${incidentId}/transition`
      )
    )
      .send({ state: 'quarantined', note: 'automated containment' });

    expect(transitioned.status).toBe(200);
    expect(transitioned.body.data.state).toBe('quarantined');
  });

  it('rejects resilience writes without authentication', async () => {
    const res = await request(app)
      .post('/api/resilience/incidents/synthetic')
      .send({
        campaignType: 'astroturf',
        severity: 'critical',
        actorClass: 'human',
        summary: 'coordinated campaign',
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toHaveProperty('code', 'NO_TOKEN');
  });

  it('exposes permissionless health aggregate', async () => {
    const res = await request(app).get('/api/resilience/permissionless/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('participation');
    expect(res.body.data).toHaveProperty('relay');
  });

  it('accepts forecast coverage snapshots and exposes KPI endpoint set', async () => {
    const snapshot = await authorized(
      request(app).post('/api/resilience/kpi/forecast-coverage/snapshots')
    )
      .send({
        domain: 'soil',
        reportCount: 14,
        confidenceScore: 0.81,
      });
    expect(snapshot.status).toBe(201);

    const coverage = await request(app).get('/api/resilience/kpi/forecast-coverage');
    expect(coverage.status).toBe(200);
    expect(coverage.body.data).toHaveProperty('privacySafeTelemetry', true);
    expect(coverage.body.data).toHaveProperty('requiredDomains');

    const integrity = await request(app).get('/api/resilience/kpi/actor-integrity');
    expect(integrity.status).toBe(200);
    expect(integrity.body.data).toHaveProperty('sybilReports');

    const sanctions = await request(app).get('/api/resilience/kpi/sanctions-parity');
    expect(sanctions.status).toBe(200);
    expect(sanctions.body.data).toHaveProperty('actorNeutrality');

    const accessibility = await request(app).get('/api/resilience/kpi/participation-accessibility');
    expect(accessibility.status).toBe(200);
    expect(accessibility.body.data).toHaveProperty('relayAvailabilityPercent');
  });

  it('returns alignment summary for rubric rescoring without raw identifiers', async () => {
    const res = await request(app).get('/api/resilience/kpi/alignment-summary');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('privacySafeTelemetry', true);
    expect(res.body.data).toHaveProperty('kpis');
    expect(res.body.data).toHaveProperty('rubricMapping');
    expect(JSON.stringify(res.body.data)).not.toContain('participant-');
  });
});
