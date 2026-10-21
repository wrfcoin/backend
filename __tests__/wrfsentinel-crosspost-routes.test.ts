import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { createWrfsentinelCrossPostRouter } from '../server/routes/wrfsentinel-crosspost-routes.js';
import type {
  CrossPostCreateInput,
  CrossPostStore,
} from '../server/services/wrfsentinel-crosspost-store.js';

function createApp() {
  const create = jest.fn(
    async (input: CrossPostCreateInput) => ({
      ...input,
      id: 'crosspost-1',
      source: 'wrfsentinel' as const,
      sourceType: 'crisis_platform' as const,
      createdAt: '2026-07-29T10:00:00.000Z',
    })
  );
  const store: CrossPostStore = { create };
  const authenticate: RequestHandler = (req, res, next) => {
    const token = req.get('authorization');
    if (!token) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    (req as any).user = {
      userId: 'wrfsentinel-service',
      permissions:
        token === 'Bearer read-only' ? ['read'] : ['crosspost:write'],
    };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(createWrfsentinelCrossPostRouter({ authenticate, store }));
  return { app, create };
}

describe('wrfsentinel cross-post routes', () => {
  it('rejects an unauthenticated write without touching storage', async () => {
    const { app, create } = createApp();

    await request(app)
      .post('/v1/social-feed')
      .send({
        content: 'Flood warning',
        location: { lat: 47.6, lng: -122.3 },
      })
      .expect(401);

    expect(create).not.toHaveBeenCalled();
  });

  it('requires explicit write permission', async () => {
    const { app, create } = createApp();

    const response = await request(app)
      .post('/api/social/feed')
      .set('Authorization', 'Bearer read-only')
      .send({
        content: 'Flood warning',
        location: { lat: 47.6, lng: -122.3 },
      })
      .expect(403);

    expect(response.body.error.code).toBe('CROSSPOST_WRITE_FORBIDDEN');
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['/api/social/feed', '/v1/social-feed'])(
    'creates a social post through %s',
    async path => {
      const { app, create } = createApp();

      const response = await request(app)
        .post(path)
        .set('Authorization', 'Bearer writer')
        .set('Idempotency-Key', 'incident-42-social')
        .send({
          content: 'Flood warning for the lower valley',
          author: 'WrfSentinel',
          location: { lat: 0, lng: 0 },
          tags: ['flood', 'high'],
          severity: 'high',
          mediaUrls: ['https://example.com/flood.jpg'],
        })
        .expect(201);

      expect(response.body.id).toBe('crosspost-1');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'social',
          principal: 'wrfsentinel-service',
          author: 'WrfSentinel',
          idempotencyKey: 'incident-42-social',
          location: { lat: 0, lng: 0 },
        })
      );
    }
  );

  it.each(['/api/environment/reports', '/v1/reports'])(
    'creates an incident report through %s',
    async path => {
      const { app, create } = createApp();

      await request(app)
        .post(path)
        .set('Authorization', 'Bearer writer')
        .send({
          title: 'River flooding',
          summary: 'Water is above flood stage',
          content: 'Observed flooding across the lower valley.',
          author: 'WrfSentinel',
          category: 'incident',
          location: { lat: 47.6, lng: -122.3 },
          severity: 'critical',
          metrics: { incidentId: 42 },
          validFrom: '2026-07-29T09:00:00.000Z',
          validUntil: '2026-07-29T15:00:00.000Z',
        })
        .expect(201);

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'report',
          title: 'River flooding',
          category: 'incident',
          metrics: { incidentId: 42 },
        })
      );
    }
  );

  it('rejects invalid coordinates and non-HTTPS media references', async () => {
    const { app, create } = createApp();

    await request(app)
      .post('/v1/social-feed')
      .set('Authorization', 'Bearer writer')
      .send({
        content: 'Invalid incident',
        location: { lat: 91, lng: 0 },
      })
      .expect(400);
    await request(app)
      .post('/v1/social-feed')
      .set('Authorization', 'Bearer writer')
      .send({
        content: 'Invalid media',
        location: { lat: 10, lng: 10 },
        mediaUrls: ['http://example.com/not-secure.jpg'],
      })
      .expect(400);

    expect(create).not.toHaveBeenCalled();
  });
});
