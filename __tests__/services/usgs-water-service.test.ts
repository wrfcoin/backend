import fs from 'fs';
import path from 'path';
import { UsgsWaterService } from '../../server/services/hydrology/usgs-water-service.js';

function fixture(name: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '../fixtures/hydrology', name),
    'utf8'
  );
}

describe('UsgsWaterService', () => {
  it('fetches and normalizes instantaneous values for known station 01646500', async () => {
    const ivPayload = JSON.parse(fixture('usgs-iv-sample.json'));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ivPayload,
      text: async () => '',
    }));

    const service = new UsgsWaterService({
      fetchFn,
      nowFn: () => new Date('2026-03-05T18:00:00Z'),
    });

    const observations = await service.fetchInstantaneousValues({
      siteNumbers: ['01646500'],
    });

    expect(observations).toHaveLength(1);
    expect(observations[0].category).toBe('Hydrological');
    expect(observations[0].station.siteNumber).toBe('01646500');
    expect(observations[0].metrics.streamflowCfs).toBe(12300);
    expect(observations[0].metrics.waterTemperatureC).toBe(7.5);

    const calledUrl = String(fetchFn.mock.calls[0][0]);
    expect(calledUrl.startsWith('https://waterservices.usgs.gov/nwis/iv/')).toBe(true);
    expect(calledUrl.includes('sites=01646500')).toBe(true);
  });

  it('fetches and normalizes daily values', async () => {
    const dvPayload = JSON.parse(fixture('usgs-dv-sample.json'));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => dvPayload,
      text: async () => '',
    }));

    const service = new UsgsWaterService({
      fetchFn,
      nowFn: () => new Date('2026-03-05T18:00:00Z'),
    });

    const observations = await service.fetchDailyValues({
      siteNumbers: ['01646500'],
    });

    expect(observations).toHaveLength(1);
    expect(observations[0].interval).toBe('DV');
    expect(observations[0].metrics.gageHeightFt).toBe(5.12);
  });

  it('discovers sites via USGS site service payload parsing', async () => {
    const sitesPayload = fixture('usgs-sites-sample.rdb');
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => sitesPayload,
    }));

    const service = new UsgsWaterService({ fetchFn });
    const result = await service.discoverSites({
      stateCode: '24',
      countyCode: '031',
    });

    expect(result.count).toBe(2);
    expect(result.sites[0].siteNumber).toBe('01646500');
    expect(result.sites[0].latitude).toBeCloseTo(39.27455, 4);
  });

  it('tracks request metrics and parse failures', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ value: { timeSeries: [] } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ value: {} }),
        text: async () => '',
      });

    const service = new UsgsWaterService({ fetchFn });
    await service.fetchInstantaneousValues({ siteNumbers: ['01646500'] });
    await expect(
      service.fetchDailyValues({ siteNumbers: ['01646500'] })
    ).rejects.toThrow('USGS payload missing value.timeSeries array');

    const metrics = service.getMetrics();
    expect(metrics.ivSuccesses).toBe(1);
    expect(metrics.dvFailures).toBe(1);
    expect(metrics.parseFailures).toBe(1);
  });

  it('dedupes exact repeats but accepts corrected value updates for same timestamp', async () => {
    const baseline = JSON.parse(fixture('usgs-iv-sample.json'));
    const corrected = JSON.parse(fixture('usgs-iv-sample.json'));
    corrected.value.timeSeries[0].values[0].value[0].value = '12400';

    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseline,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseline,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => corrected,
        text: async () => '',
      });

    const service = new UsgsWaterService({ fetchFn });

    const first = await service.fetchInstantaneousValues({ siteNumbers: ['01646500'] });
    const second = await service.fetchInstantaneousValues({ siteNumbers: ['01646500'] });
    const third = await service.fetchInstantaneousValues({ siteNumbers: ['01646500'] });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(1);
    expect(third[0].metrics.streamflowCfs).toBe(12400);
  });
});
