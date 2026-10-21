/**
 * Tests for operator-quality-routes (backend#287).
 *
 * Uses an injected mock DB executor — no live database or auth required.
 */

import express from 'express';
import request from 'supertest';

// Mock auth middleware before importing the router.
jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { createOperatorQualityRouter } from '../../server/routes/operator-quality-routes.js';

type Row = Record<string, unknown>;

function makeDb(responses: { rows: Row[] }[]) {
  let call = 0;
  return {
    execute: jest.fn(async (_sql: string, _params?: unknown[]) => {
      return responses[call++] ?? { rows: [] };
    }),
  };
}

function makeApp(db: { execute: jest.Mock }) {
  const app = express();
  app.use(express.json());
  app.use('/api/quality', createOperatorQualityRouter(db as any));
  return app;
}

const VALID_ADDR = '0xaBcD1234567890aBcD1234567890aBcD12345678';

describe('GET /api/quality/my-events', () => {
  it('returns 400 for missing address', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/quality/my-events');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/address/i);
  });

  it('returns 400 for invalid wallet address', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/quality/my-events?address=not-a-wallet');
    expect(res.status).toBe(400);
  });

  it('returns empty results when no rejections', async () => {
    const db = makeDb([
      { rows: [] }, // no rejections query
      {
        rows: [{ accepted: 10, rejected: 0, avg_score: 100 }],
      }, // summary
    ]);
    const app = makeApp(db);
    const res = await request(app).get(`/api/quality/my-events?address=${VALID_ADDR}`);
    expect(res.status).toBe(200);
    expect(res.body.recent_rejections).toHaveLength(0);
    expect(res.body.quality_summary['last_24h_accepted']).toBe(10);
    expect(res.body.quality_summary['last_24h_rejected']).toBe(0);
    expect(res.body.quality_summary.quality_score).toBeCloseTo(1.0);
    expect(res.body.quality_summary.quality_band).toBe('high');
  });

  it('returns human-readable rejection reason for TemperatureOutOfRange', async () => {
    const violation = { type: 'TemperatureOutOfRange', valueC: 150, min: -89.2, max: 56.7 };
    const db = makeDb([
      {
        rows: [
          {
            submitted_at: '2026-03-23T14:30:00Z',
            device_id: 'WS-5000',
            quality_score: 80,
            physics_violations: [violation],
          },
        ],
      },
      { rows: [{ accepted: 5, rejected: 1, avg_score: 80 }] },
    ]);
    const app = makeApp(db);
    const res = await request(app).get(`/api/quality/my-events?address=${VALID_ADDR}`);
    expect(res.status).toBe(200);
    expect(res.body.recent_rejections).toHaveLength(1);
    const rej = res.body.recent_rejections[0];
    expect(rej.station).toBe('WS-5000');
    expect(rej.reason).toContain('Temperature');
    expect(rej.reason).toContain('150');
    expect(rej.suggestion).toBeTruthy();
    expect(rej.violation_type).toBe('TemperatureOutOfRange');
  });

  it('flattens multiple violations from a single submission', async () => {
    const violations = [
      { type: 'TemperatureOutOfRange', valueC: 150, min: -89.2, max: 56.7 },
      { type: 'HumidityOutOfRange', valuePct: 120, min: 0, max: 100 },
    ];
    const db = makeDb([
      {
        rows: [
          {
            submitted_at: '2026-03-23T14:30:00Z',
            device_id: 'WS-001',
            quality_score: 60,
            physics_violations: violations,
          },
        ],
      },
      { rows: [{ accepted: 10, rejected: 1, avg_score: 60 }] },
    ]);
    const app = makeApp(db);
    const res = await request(app).get(`/api/quality/my-events?address=${VALID_ADDR}`);
    expect(res.status).toBe(200);
    // One submission with 2 violations -> 2 rejection entries
    expect(res.body.recent_rejections).toHaveLength(2);
  });

  it('handles physics_violations stored as JSON string', async () => {
    const db = makeDb([
      {
        rows: [
          {
            submitted_at: '2026-03-23T14:30:00Z',
            device_id: 'WS-002',
            quality_score: 80,
            physics_violations: JSON.stringify([
              { type: 'WindSpeedExceedsMaximum', valueMs: 200, max: 113 },
            ]),
          },
        ],
      },
      { rows: [{ accepted: 3, rejected: 1, avg_score: 80 }] },
    ]);
    const app = makeApp(db);
    const res = await request(app).get(`/api/quality/my-events?address=${VALID_ADDR}`);
    expect(res.status).toBe(200);
    expect(res.body.recent_rejections[0].violation_type).toBe('WindSpeedExceedsMaximum');
  });

  it('returns 500 on database error', async () => {
    const db = { execute: jest.fn().mockRejectedValue(new Error('db down')) };
    const app = makeApp(db as any);
    const res = await request(app).get(`/api/quality/my-events?address=${VALID_ADDR}`);
    expect(res.status).toBe(500);
  });
});

describe('GET /api/quality/station-summary/:deviceId', () => {
  it('returns 400 for missing address', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/quality/station-summary/WS-001');
    expect(res.status).toBe(400);
  });

  it('returns summary for a valid device', async () => {
    const db = makeDb([
      {
        rows: [
          {
            total: 100,
            accepted: 97,
            rejected: 3,
            avg_score: 97,
            first_submission: '2026-03-22T00:00:00Z',
            last_submission: '2026-03-23T23:59:59Z',
          },
        ],
      },
    ]);
    const app = makeApp(db);
    const res = await request(app).get(
      `/api/quality/station-summary/WS-001?address=${VALID_ADDR}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.station).toBe('WS-001');
    expect(res.body.total_submissions).toBe(100);
    expect(res.body.accepted).toBe(97);
    expect(res.body.rejected).toBe(3);
    expect(res.body.acceptance_rate).toBeCloseTo(0.97);
    expect(res.body.quality_band).toBe('high');
  });

  it('returns null acceptance_rate when no submissions', async () => {
    const db = makeDb([
      { rows: [{ total: 0, accepted: 0, rejected: 0, avg_score: null }] },
    ]);
    const app = makeApp(db);
    const res = await request(app).get(
      `/api/quality/station-summary/WS-empty?address=${VALID_ADDR}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.acceptance_rate).toBeNull();
    expect(res.body.quality_band).toBeNull();
  });
});
