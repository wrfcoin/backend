import fs from 'fs';
import path from 'path';
import { NrcsSoilService } from '../../server/services/soil/nrcs-soil-service.js';

function fixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../fixtures/soil', name), 'utf8');
}

describe('NrcsSoilService', () => {
  it('fetches and normalizes SCAN station observations for known station 2057:AL:SCAN', async () => {
    const scanPayload = JSON.parse(fixture('nrcs-scan-sample.json'));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => scanPayload,
    }));

    const service = new NrcsSoilService({
      fetchFn,
      nowFn: () => new Date('2026-03-05T18:00:00Z'),
    });

    const observations = await service.fetchScanObservations({
      stationTriplets: ['2057:AL:SCAN'],
      duration: 'HOURLY',
    });

    expect(observations).toHaveLength(1);
    expect(observations[0].category).toBe('Environmental');
    expect(observations[0].network).toBe('SCAN');
    expect(observations[0].station.triplet).toBe('2057:AL:SCAN');
    expect(observations[0].metrics.soilMoisturePct5cm).toBe(21.8);
    expect(observations[0].metrics.soilMoisturePct10cm).toBe(23.4);
    expect(observations[0].metrics.soilMoisturePct20cm).toBe(26.1);
    expect(observations[0].metrics.soilMoisturePct50cm).toBe(29.9);
    expect(observations[0].metrics.soilTemperatureC).toBe(15.2);
    expect(observations[0].metrics.precipitationMm).toBe(1.3);

    const calledUrl = String(fetchFn.mock.calls[0][0]);
    expect(calledUrl.startsWith('https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/observations?')).toBe(
      true
    );
    expect(calledUrl.includes('network=SCAN')).toBe(true);
    expect(calledUrl.includes('stationTriplets=2057%3AAL%3ASCAN')).toBe(true);
    expect(calledUrl.includes('duration=HOURLY')).toBe(true);
  });

  it('fetches and normalizes SNOTEL observations', async () => {
    const snotelPayload = JSON.parse(fixture('nrcs-snotel-sample.json'));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => snotelPayload,
    }));

    const service = new NrcsSoilService({
      fetchFn,
      nowFn: () => new Date('2026-03-05T18:00:00Z'),
    });

    const observations = await service.fetchSnotelObservations({
      stationTriplets: ['304:CA:SNTL'],
    });

    expect(observations).toHaveLength(1);
    expect(observations[0].network).toBe('SNOTEL');
    expect(observations[0].interval).toBe('DAILY');
    expect(observations[0].metrics.snowWaterEquivalentMm).toBe(412);
    expect(observations[0].metrics.snowDepthCm).toBe(141);
    expect(observations[0].metrics.precipitationMm).toBe(9.8);
    expect(observations[0].metrics.airTemperatureC).toBe(-3.1);
  });

  it('fetches station metadata with coordinates and elevation', async () => {
    const stationPayload = JSON.parse(fixture('nrcs-stations-sample.json'));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => stationPayload,
    }));

    const service = new NrcsSoilService({ fetchFn });
    const result = await service.fetchStations({ network: 'ALL' });

    expect(result.count).toBe(2);
    expect(result.stations[0].triplet).toBe('2057:AL:SCAN');
    expect(result.stations[0].latitude).toBeCloseTo(32.6012, 4);
    expect(result.stations[0].elevationMeters).toBeCloseTo(214.6, 2);
  });

  it('supports configurable station lists and polling intervals', async () => {
    const scanPayload = JSON.parse(fixture('nrcs-scan-sample.json'));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => scanPayload,
    }));

    const service = new NrcsSoilService({
      fetchFn,
      scanStationTriplets: ['2057:AL:SCAN'],
      snotelStationTriplets: ['304:CA:SNTL'],
      scanPollIntervalMs: 300000,
      snotelPollIntervalMs: 1800000,
    });

    const observations = await service.fetchScanObservations();
    expect(observations).toHaveLength(1);

    const calledUrl = String(fetchFn.mock.calls[0][0]);
    expect(calledUrl.includes('stationTriplets=2057%3AAL%3ASCAN')).toBe(true);

    const metrics = service.getMetrics();
    expect(metrics.scanPollIntervalMs).toBe(300000);
    expect(metrics.snotelPollIntervalMs).toBe(1800000);
    expect(metrics.configuredScanStations).toEqual(['2057:AL:SCAN']);
    expect(metrics.configuredSnotelStations).toEqual(['304:CA:SNTL']);
  });

  it('tracks success/failure metrics and parse failures', async () => {
    const scanPayload = JSON.parse(fixture('nrcs-scan-sample.json'));
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => scanPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ stations: [{ triplet: '304:CA:SNTL', observations: [{}] }] }),
      });

    const service = new NrcsSoilService({ fetchFn });
    await service.fetchScanObservations({ stationTriplets: ['2057:AL:SCAN'] });
    await expect(
      service.fetchSnotelObservations({ stationTriplets: ['304:CA:SNTL'] })
    ).resolves.toEqual([]);

    const metrics = service.getMetrics();
    expect(metrics.scanSuccesses).toBe(1);
    expect(metrics.snotelSuccesses).toBe(1);
    expect(metrics.parseFailures).toBeGreaterThan(0);
  });

  it('dedupes exact repeats but accepts corrected value updates', async () => {
    const baseline = JSON.parse(fixture('nrcs-scan-sample.json'));
    const corrected = JSON.parse(fixture('nrcs-scan-sample.json'));
    corrected.stations[0].observations[0].values['SMS:I-1'] = 22.2;

    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseline,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseline,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => corrected,
      });

    const service = new NrcsSoilService({
      fetchFn,
      scanStationTriplets: ['2057:AL:SCAN'],
    });

    const first = await service.fetchScanObservations();
    const second = await service.fetchScanObservations();
    const third = await service.fetchScanObservations();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(1);
    expect(third[0].metrics.soilMoisturePct5cm).toBe(22.2);
  });
});
