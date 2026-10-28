import express from 'express';
import request from 'supertest';
jest.mock('../../server/middleware/auth', () => ({ authenticateJWT: (req: any, res: any, next: any) => req.headers.authorization === 'Bearer test-session' ? next() : res.sendStatus(401) }));
jest.mock('../../server/db', () => ({ pool: { query: jest.fn() } }));
import { pool } from '../../server/db';
import { createWeatherAlertsRouter } from '../../server/routes/weather-alerts-routes';
const app = express(); app.use('/api', createWeatherAlertsRouter());
const old = process.env.ALERT_ENGINE_SHADOW;
afterEach(() => { if (old === undefined) delete process.env.ALERT_ENGINE_SHADOW; else process.env.ALERT_ENGINE_SHADOW = old; jest.clearAllMocks(); });
test('shadow endpoint requires authentication', async () => {
  process.env.ALERT_ENGINE_SHADOW = '1';
  expect((await request(app).get('/api/weather/alerts/shadow')).status).toBe(401);
});
test('shadow endpoint defaults off without database reads', async () => {
  delete process.env.ALERT_ENGINE_SHADOW;
  expect((await request(app).get('/api/weather/alerts/shadow').set('Authorization', 'Bearer test-session')).status).toBe(404);
  expect(pool.query).not.toHaveBeenCalled();
});
test('enabled endpoint reads stored research events', async () => {
  process.env.ALERT_ENGINE_SHADOW = '1';
  (pool.query as jest.Mock).mockResolvedValue({ rows: [{ state: { events: [{ id: 'research-event', shadow: true }] } }] });
  const result = await request(app).get('/api/weather/alerts/shadow').set('Authorization', 'Bearer test-session');
  expect(result.status).toBe(200); expect(result.body).toEqual({ shadow: true, events: [{ id: 'research-event', shadow: true }] });
});
test('missing migration is unavailable, never empty success', async () => {
  process.env.ALERT_ENGINE_SHADOW = '1'; (pool.query as jest.Mock).mockRejectedValue(new Error('table absent'));
  expect((await request(app).get('/api/weather/alerts/shadow').set('Authorization', 'Bearer test-session')).status).toBe(503);
});
