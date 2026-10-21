/**
 * S2c: EnhancedWeatherController caches NOAA calls per 0.1 degree cell and the
 * NOAA service caches the static /points lookup. NOAA is mocked; no network.
 */
jest.mock('../server/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}), { virtual: true });

const mockGet = jest.fn();
jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: (...a) => mockGet(...a),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  })),
}));

const EnhancedWeatherController = require('../server/controllers/enhanced-weather-controller');
const NOAAWeatherService = require('../server/services/noaa-nws-api-service');
const { NOAA_TTL_MS } = require('../server/utils/noaa-cell-cache');

function makeRes() {
  const res = { headers: {} };
  res.set = (k, v) => ((res.headers[k] = v), res);
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}
const reqFor = (location, query = {}) => ({ params: { location }, query, headers: {} });

describe('S2c controller cache', () => {
  let controller;
  let svc;
  beforeEach(() => {
    jest.useFakeTimers({ now: 5_000_000 });
    controller = new EnhancedWeatherController();
    controller.noaaCache.clear();
    controller.useRealData = true;
    svc = controller.noaaWeatherService;
    svc.getCurrentObservations = jest.fn(async (lat, lon) => ({
      stale: false,
      temperature: { value: lat, unitCode: 'wmo:degC' },
      relativeHumidity: { value: 50, unitCode: 'wmo:percent' },
      timestamp: 't',
    }));
    svc.getHourlyForecast = jest.fn(async (lat, lon, n) => ({ location: { latitude: lat, longitude: lon }, periods: [n] }));
    svc.getForecast = jest.fn(async (lat, lon, n) => ({ location: { latitude: lat, longitude: lon }, periods: [n] }));
  });
  afterEach(() => jest.useRealTimers());

  it('current: same cell -> one upstream call, X-Cache MISS then HIT, shape unchanged', async () => {
    const r1 = makeRes();
    await controller.getCurrentObservations(reqFor('37.41,-121.94'), r1);
    const r2 = makeRes();
    await controller.getCurrentObservations(reqFor('37.44,-121.91'), r2);
    expect(svc.getCurrentObservations).toHaveBeenCalledTimes(1);
    expect(svc.getCurrentObservations.mock.calls[0].slice(0, 2)).toEqual([37.4, -121.9]);
    expect(r1.headers['X-Cache']).toBe('MISS');
    expect(r2.headers['X-Cache']).toBe('HIT');
    expect(Object.keys(r2.body).sort()).toEqual(['current', 'location', 'source', 'status', 'timestamp']);
    expect(r2.body.current.temperatureC).toBe(37.4);
  });

  it('current: a neighbouring cell (37.45) is a separate fetch and never gets the other cell data', async () => {
    const a = makeRes();
    const b = makeRes();
    await controller.getCurrentObservations(reqFor('37.41,-121.94'), a);
    await controller.getCurrentObservations(reqFor('37.45,-121.94'), b);
    expect(svc.getCurrentObservations).toHaveBeenCalledTimes(2);
    expect(a.body.current.temperatureC).toBe(37.4);
    expect(b.body.current.temperatureC).toBe(37.5);
  });

  it('current: TTL expiry refetches', async () => {
    await controller.getCurrentObservations(reqFor('37.4,-121.9'), makeRes());
    jest.advanceTimersByTime(NOAA_TTL_MS.current + 1);
    const r = makeRes();
    await controller.getCurrentObservations(reqFor('37.4,-121.9'), r);
    expect(svc.getCurrentObservations).toHaveBeenCalledTimes(2);
    expect(r.headers['X-Cache']).toBe('MISS');
  });

  it('current: 10 concurrent requests -> 1 upstream call', async () => {
    const res = await Promise.all(
      Array.from({ length: 10 }, () => {
        const r = makeRes();
        return controller.getCurrentObservations(reqFor('37.4,-121.9'), r).then(() => r);
      }),
    );
    expect(svc.getCurrentObservations).toHaveBeenCalledTimes(1);
    expect(res.every((r) => r.body.status === 'success')).toBe(true);
  });

  it('current: an upstream error is answered 500 and not cached', async () => {
    svc.getCurrentObservations.mockRejectedValueOnce(new Error('NOAA down'));
    const bad = makeRes();
    await controller.getCurrentObservations(reqFor('37.4,-121.9'), bad);
    expect(bad.statusCode).toBe(500);
    const ok = makeRes();
    await controller.getCurrentObservations(reqFor('37.4,-121.9'), ok);
    expect(ok.body.status).toBe('success');
    expect(svc.getCurrentObservations).toHaveBeenCalledTimes(2);
  });

  it('forecast: hourly days=1 / days=14 and daily are separate keys; each cached', async () => {
    const q = (extra) => reqFor('37.4,-121.9', extra);
    await controller.getWeatherForecast(q({ type: 'hourly', days: '1' }), makeRes());
    await controller.getWeatherForecast(q({ type: 'hourly', days: '1' }), makeRes());
    await controller.getWeatherForecast(q({ type: 'hourly', days: '14' }), makeRes());
    await controller.getWeatherForecast(q({ days: '14' }), makeRes());
    const hit = makeRes();
    await controller.getWeatherForecast(q({ days: '14' }), hit);
    expect(svc.getHourlyForecast).toHaveBeenCalledTimes(2);
    expect(svc.getHourlyForecast.mock.calls.map((c) => c[2])).toEqual([24, 336]);
    expect(svc.getForecast).toHaveBeenCalledTimes(1);
    expect(hit.headers['X-Cache']).toBe('HIT');
    expect(hit.body.forecast.periods).toEqual([14]);
  });

  it('forecast: hourly TTL (15 min) expires before daily TTL (30 min)', async () => {
    const q = (extra) => reqFor('37.4,-121.9', extra);
    await controller.getWeatherForecast(q({ type: 'hourly', days: '1' }), makeRes());
    await controller.getWeatherForecast(q({ days: '7' }), makeRes());
    jest.advanceTimersByTime(NOAA_TTL_MS.hourlyForecast + 1);
    await controller.getWeatherForecast(q({ type: 'hourly', days: '1' }), makeRes());
    await controller.getWeatherForecast(q({ days: '7' }), makeRes());
    expect(svc.getHourlyForecast).toHaveBeenCalledTimes(2);
    expect(svc.getForecast).toHaveBeenCalledTimes(1);
  });

  it('alerts: cached per cell', async () => {
    svc.getAlerts = jest.fn(async () => ({ alerts: [], count: 0 }));
    await controller.getWeatherAlerts(reqFor('37.41,-121.94'), makeRes());
    await controller.getWeatherAlerts(reqFor('37.44,-121.91'), makeRes());
    expect(svc.getAlerts).toHaveBeenCalledTimes(1);
  });
});

describe('S2c /points gridpoint cache', () => {
  beforeEach(() => {
    mockGet.mockReset();
    require('../server/services/noaa-nws-api-service').gridPointCache.clear();
  });

  it('calls /points once per point and coalesces concurrent lookups', async () => {
    mockGet.mockImplementation(async () => ({
      data: { properties: { gridId: 'MTR', gridX: 1, gridY: 2, forecast: 'f', forecastHourly: 'h', observationStations: 's' } },
    }));
    const a = new NOAAWeatherService();
    const b = new NOAAWeatherService();
    const [p1, p2] = await Promise.all([a.getGridPoint(37.4, -121.9), b.getGridPoint(37.4, -121.9)]);
    await a.getGridPoint(37.4, -121.9);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/points/37.4,-121.9');
    expect(p1).toBe(p2);
    await a.getGridPoint(37.5, -121.9);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed /points lookup', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({
      data: { properties: { gridId: 'MTR', gridX: 1, gridY: 2 } },
    });
    const svc = new NOAAWeatherService();
    await expect(svc.getGridPoint(37.4, -121.9)).rejects.toThrow('boom');
    await expect(svc.getGridPoint(37.4, -121.9)).resolves.toMatchObject({ gridId: 'MTR' });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid coordinates without an upstream call', async () => {
    const svc = new NOAAWeatherService();
    await expect(svc.getGridPoint(200, 0)).rejects.toThrow('Invalid coordinates');
    expect(mockGet).not.toHaveBeenCalled();
  });
});
