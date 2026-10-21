import express from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createWeatherAlertsRouter } from '../../server/routes/weather-alerts-routes.js';
import { SevereWeatherResponseService } from '../../server/services/weather/severe-weather-response-service.js';

function fixture(name: string): any {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../fixtures/weather', name), 'utf8')
  );
}

describe('weather-alerts routes', () => {
  it('serves active/history alerts and supports manual polling', async () => {
    const locationA = fixture('nws-alerts-location-a.json');
    const locationB = fixture('nws-alerts-location-b.json');
    const updated = fixture('nws-alerts-updated.json');

    let phase = 0;
    const nwsApiService = {
      getAlerts: jest.fn(async (latitude: number) => {
        if (phase === 0) {
          return latitude > 35 ? locationA : locationB;
        }
        return updated;
      }),
    };

    let nowMs = Date.parse('2026-03-05T12:10:00Z');
    const service = new SevereWeatherResponseService({
      nwsApiService: nwsApiService as any,
      locations: [{ id: 'default', latitude: 39.82, longitude: -98.57 }],
      nowFn: () => new Date(nowMs),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createWeatherAlertsRouter(service));

    const firstPoll = await request(app)
      .post('/api/weather/alerts/poll')
      .send({
        locations: [
          { id: 'midwest', latitude: 41.88, longitude: -87.63 },
          { id: 'gulf', latitude: 29.76, longitude: -95.36 },
        ],
      });

    expect(firstPoll.status).toBe(201);
    expect(firstPoll.body.success).toBe(true);
    expect(firstPoll.body.summary.newAlerts).toBe(3);
    expect(firstPoll.body.summary.dedupedAlerts).toBe(3);

    const active = await request(app).get('/api/weather/alerts/active');
    expect(active.status).toBe(200);
    expect(active.body.success).toBe(true);
    expect(active.body.count).toBe(3);
    expect(active.body.alerts.some((alert: any) => alert.type === 'tornado')).toBe(true);
    expect(active.body.alerts.some((alert: any) => alert.severityClass === 'warning')).toBe(true);

    phase = 1;
    nowMs += 15 * 60 * 1000;

    const secondPoll = await request(app)
      .post('/api/weather/alerts/poll')
      .send({
        locations: [{ id: 'central', latitude: 39.82, longitude: -98.57 }],
      });

    expect(secondPoll.status).toBe(201);
    expect(secondPoll.body.summary.updatedAlerts).toBe(2);
    expect(secondPoll.body.summary.newAlerts).toBe(1);
    expect(secondPoll.body.summary.expiredAlerts).toBe(1);

    const history = await request(app).get('/api/weather/alerts/history?limit=20');
    expect(history.status).toBe(200);
    expect(history.body.success).toBe(true);
    expect(history.body.count).toBeGreaterThanOrEqual(7);
    expect(history.body.history.some((entry: any) => entry.lifecycle === 'new')).toBe(true);
    expect(history.body.history.some((entry: any) => entry.lifecycle === 'updated')).toBe(true);
    expect(history.body.history.some((entry: any) => entry.lifecycle === 'expired')).toBe(true);
  });

  it('rejects invalid poll payloads', async () => {
    const service = new SevereWeatherResponseService({
      nwsApiService: {
        getAlerts: async () => fixture('nws-alerts-empty.json'),
      } as any,
      locations: [{ latitude: 39.82, longitude: -98.57 }],
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createWeatherAlertsRouter(service));

    const response = await request(app)
      .post('/api/weather/alerts/poll')
      .send({
        locations: { latitude: 39.82, longitude: -98.57 },
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('maps NWS upstream failures to 502', async () => {
    const service = new SevereWeatherResponseService({
      nwsApiService: {
        getAlerts: async () => {
          throw new Error('upstream unavailable');
        },
      } as any,
      locations: [{ latitude: 39.82, longitude: -98.57 }],
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createWeatherAlertsRouter(service));

    const response = await request(app).post('/api/weather/alerts/poll').send({});
    expect(response.status).toBe(502);
    expect(response.body.success).toBe(false);
  });
});
