import { describe, it, expect, beforeEach } from '@jest/globals';

const express = require('express');
const request = require('supertest');

function expectCanonicalApiError(
  body: any,
  code: string,
  message: string,
) {
  expect(body).toMatchObject({
    success: false,
    error: {
      code,
      message,
    },
  });
  expect(typeof body.timestamp).toBe('string');
}

describe('Telemetry routes (#685)', () => {
  let app: any;
  let metricsRegistry: any;

  beforeEach(async () => {
    // Reset the shared metrics registry between tests so prior counter
    // values don't leak in. We re-import the module to get a fresh state.
    jest.resetModules();
    const metrics = await import('../server/utils/metrics.js');
    metricsRegistry = metrics.metricsRegistry;
    metrics.contributionFunnelCounter.reset();
    metrics.referralFunnelCounter.reset();
    metrics.pageViewCounter.reset();

    const { default: telemetryRoutes } = await import(
      '../server/routes/telemetry-routes.js'
    );

    app = express();
    app.use(express.json());
    app.use('/api/telemetry', telemetryRoutes);
  });

  describe('POST /api/telemetry/page-view', () => {
    it('increments wrfcoin_page_views_total with the supplied page label', async () => {
      const res = await request(app)
        .post('/api/telemetry/page-view')
        .send({ page: 'WeatherStreakPage', referrerType: 'organic' });

      expect(res.status).toBe(204);

      const dump = await metricsRegistry.metrics();
      expect(dump).toMatch(
        /wrfcoin_page_views_total\{[^}]*page="WeatherStreakPage"[^}]*\} 1/
      );
    });

    it('rejects invalid page labels to prevent cardinality blow-up', async () => {
      const res = await request(app)
        .post('/api/telemetry/page-view')
        .send({ page: 'evil page <script>' });

      expect(res.status).toBe(400);
      expectCanonicalApiError(
        res.body,
        'INVALID_PAGE_LABEL',
        'invalid page label',
      );
    });

    it('falls back to direct when referrerType is unknown', async () => {
      const res = await request(app)
        .post('/api/telemetry/page-view')
        .send({ page: 'OracleLeaderboardPage', referrerType: 'banana' });

      expect(res.status).toBe(204);

      const dump = await metricsRegistry.metrics();
      expect(dump).toMatch(/referrer_type="direct"/);
      expect(dump).not.toMatch(/referrer_type="banana"/);
    });
  });

  describe('POST /api/telemetry/funnel', () => {
    it('increments referral funnel for valid step', async () => {
      const res = await request(app)
        .post('/api/telemetry/funnel')
        .send({ funnel: 'referral', step: 'code_shared' });

      expect(res.status).toBe(204);
      const dump = await metricsRegistry.metrics();
      expect(dump).toMatch(
        /wrfcoin_referral_funnel_total\{[^}]*step="code_shared"[^}]*\} 1/
      );
    });

    it('rejects unknown referral steps', async () => {
      const res = await request(app)
        .post('/api/telemetry/funnel')
        .send({ funnel: 'referral', step: 'made_up_step' });

      expect(res.status).toBe(400);
      expectCanonicalApiError(
        res.body,
        'UNKNOWN_REFERRAL_STEP',
        'unknown referral step',
      );
    });

    it('increments contribution funnel for valid step', async () => {
      const res = await request(app)
        .post('/api/telemetry/funnel')
        .send({ funnel: 'contribution', step: 'wallet_created' });

      expect(res.status).toBe(204);
      const dump = await metricsRegistry.metrics();
      expect(dump).toMatch(
        /wrfcoin_contribution_funnel_total\{[^}]*step="wallet_created"[^}]*\} 1/
      );
    });

    it('rejects unknown funnel name', async () => {
      const res = await request(app)
        .post('/api/telemetry/funnel')
        .send({ funnel: 'mystery', step: 'x' });

      expect(res.status).toBe(400);
      expectCanonicalApiError(res.body, 'UNKNOWN_FUNNEL', 'unknown funnel');
    });

    it('rejects missing step or funnel', async () => {
      const res = await request(app).post('/api/telemetry/funnel').send({});
      expect(res.status).toBe(400);
      expectCanonicalApiError(
        res.body,
        'MISSING_FUNNEL_OR_STEP',
        'funnel and step required',
      );
    });

    it('rejects unknown contribution steps with the canonical envelope', async () => {
      const res = await request(app)
        .post('/api/telemetry/funnel')
        .send({ funnel: 'contribution', step: 'made_up_step' });

      expect(res.status).toBe(400);
      expectCanonicalApiError(
        res.body,
        'UNKNOWN_CONTRIBUTION_STEP',
        'unknown contribution step',
      );
    });
  });
});
