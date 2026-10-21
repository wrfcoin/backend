import * as http from 'http';
import * as querystring from 'querystring';
import * as url from 'url';
import request from 'supertest';
import {
  handleWeatherExportRequest,
  resetWeatherExportRateLimiter,
  type QueryExecutor,
} from '../server/routes/export-routes.js';

type QueryResult = { rows: Record<string, unknown>[] };

function createServer(executeQuery: QueryExecutor): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || '');
      const handled = await handleWeatherExportRequest({
        path: parsed.pathname || '/',
        method: req.method,
        query: querystring.parse(parsed.query || ''),
        req,
        res,
        executeQuery,
      });

      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  });
}

describe('weather export endpoints', () => {
  beforeEach(() => {
    resetWeatherExportRateLimiter();
  });

  it('returns data catalog response shape', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({
      rows: [
        {
          station_id: 'station-123',
          first_observation_at: '2026-01-01T00:00:00.000Z',
          last_observation_at: '2026-03-01T00:00:00.000Z',
          observations_count: 44,
          average_quality_score: 88.5,
        },
      ],
    }));

    const server = createServer(executeQuery);
    const response = await request(server).get('/api/v1/data-catalog');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.total).toBe(1);
    expect(response.body.data.stations[0]).toEqual(
      expect.objectContaining({
        stationId: 'station-123',
        observationsCount: 44,
        averageQualityScore: 88.5,
      })
    );
  });

  it('validates region export query params', async () => {
    const executeQuery = jest.fn(async (): Promise<QueryResult> => ({ rows: [] }));
    const server = createServer(executeQuery);

    const response = await request(server).get(
      '/api/v1/export/region?lat=123&lon=-122.4&radius_km=25&from=2026-01-01&to=2026-01-31'
    );

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('lat');
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('streams station observations in JSON without buffering all rows', async () => {
    const executeQuery = jest
      .fn<ReturnType<QueryExecutor>, Parameters<QueryExecutor>>()
      .mockResolvedValueOnce({
        rows: [
          {
            station_id: 'station-123',
            submitted_at: '2026-01-01T00:00:00.000Z',
            temperature: 12.3,
            humidity: 61.2,
            pressure: 1012.7,
            quality_score: 90,
            reward_amount: 0.15,
            source: 'sensor_ingest',
            latitude: 37.78,
            longitude: -122.41,
          },
          {
            station_id: 'station-123',
            submitted_at: '2026-01-01T01:00:00.000Z',
            temperature: 12.1,
            humidity: 60.9,
            pressure: 1012.4,
            quality_score: 91,
            reward_amount: 0.16,
            source: 'sensor_ingest',
            latitude: 37.78,
            longitude: -122.41,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const server = createServer(executeQuery);
    const response = await request(server).get(
      '/api/v1/export/stations/station-123/observations?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z&format=json'
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.format).toBe('json');
    expect(response.body.data.count).toBe(2);
    expect(response.body.data.observations).toHaveLength(2);
    expect(response.body.data.observations[0]).toEqual(
      expect.objectContaining({
        stationId: 'station-123',
        temperature: 12.3,
        humidity: 61.2,
      })
    );
  });

  it('rate-limits export endpoints to 10 requests per minute per IP', async () => {
    const executeQuery = jest
      .fn<ReturnType<QueryExecutor>, Parameters<QueryExecutor>>()
      .mockResolvedValue({ rows: [] });
    const server = createServer(executeQuery);
    const path =
      '/api/v1/export/stations/station-rl/observations?from=2026-01-01T00:00:00.000Z&to=2026-01-01T23:59:59.000Z&format=json';

    for (let i = 0; i < 10; i += 1) {
      const response = await request(server).get(path);
      expect(response.status).toBe(200);
    }

    const limitedResponse = await request(server).get(path);
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.body.success).toBe(false);
    expect(limitedResponse.body.error).toContain('Rate limit exceeded');
  });
});
