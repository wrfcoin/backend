import { createWeatherReportRouter } from '../../server/routes/weather-report-routes.js';
import { NarrativeWeatherReportService } from '../../server/services/weather/narrative-weather-report-service.js';

function mockReq(body: any = {}): any {
  return { body };
}

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

function getHandler(router: any, method: string, pathSuffix: string): Function {
  for (const layer of router.stack) {
    if (
      layer.route &&
      layer.route.path === pathSuffix &&
      layer.route.methods[method.toLowerCase()]
    ) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${pathSuffix}`);
}

describe('weather-report routes', () => {
  it('returns narrative report for station request', async () => {
    const service = new NarrativeWeatherReportService({
      weatherProvider: {
        getCurrentConditions: async () => ({
          stationId: 'KDEN',
          observedAt: '2026-03-05T12:00:00Z',
          temperatureF: 45,
          humidity: 55,
          windMph: 12,
          conditionText: 'cloudy',
        }),
      },
      forecastProvider: {
        getShortTermOutlook: async () => ({
          periodHours: 24,
          expectedHighF: 50,
          expectedLowF: 33,
          precipitationChance: 0.2,
          dominantConditions: 'Cloudy',
        }),
      },
      alertsProvider: {
        getActiveAlerts: async () => [],
      },
      nowFn: () => new Date('2026-03-05T12:00:00Z'),
    });

    const router = createWeatherReportRouter({ service });
    const response = mockRes();
    await getHandler(router, 'POST', '/weather/report/narrative')(
      mockReq({
        station_id: 'KDEN',
        style: 'brief',
      }),
      response
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.report.style).toBe('brief');
    expect(response.body.report.report.fullText).toContain('KDEN');
  });

  it('rejects malformed payload', async () => {
    const router = createWeatherReportRouter();
    const response = mockRes();
    await getHandler(router, 'POST', '/weather/report/narrative')(
      mockReq({
        style: 'brief',
      }),
      response
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('rejects invalid region bounds payloads', async () => {
    const router = createWeatherReportRouter();
    const response = mockRes();
    await getHandler(router, 'POST', '/weather/report/narrative')(
      mockReq({
        region_bounds: {
          north: 40,
          south: 42,
          east: -104,
          west: -106,
        },
        style: 'standard',
      }),
      response
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('regionBounds must satisfy north > south');
  });
});
