import fs from 'fs';
import path from 'path';
import { UsgsEarthquakeService } from '../../server/services/seismic/usgs-earthquake-service.js';

function fixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../fixtures/seismic', name), 'utf8');
}

describe('UsgsEarthquakeService', () => {
  it('polls and normalizes USGS GeoJSON feed events', async () => {
    const payload = JSON.parse(fixture('usgs-all-hour-sample.json'));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }));

    const service = new UsgsEarthquakeService({
      fetchFn,
      nowFn: () => new Date('2026-03-05T18:00:00Z'),
    });

    const result = await service.pollFeed({ feed: '4.5', window: 'day' });

    expect(result.rawEvents).toBe(2);
    expect(result.ingestedEvents).toBe(2);
    expect(result.duplicateEvents).toBe(0);
    expect(result.events[0].category).toBe('Seismic');
    expect(result.events[0].eventId).toBe('us7000abcd');
    expect(result.events[0].source).toBe('USGS');
    expect(result.events[0].magnitude).toBe(4.8);
    expect(result.events[0].location.depthKm).toBe(35.6);
    expect(result.events[0].feltReports).toBe(12);
    expect(result.events[0].maxIntensity).toBe(4.1);
    expect(result.events[0].tsunamiWarning).toBe(true);

    const calledUrl = String(fetchFn.mock.calls[0][0]);
    expect(calledUrl.endsWith('/4.5_day.geojson')).toBe(true);
  });

  it('dedupes by USGS event id across feed polls', async () => {
    const payload = JSON.parse(fixture('usgs-all-hour-sample.json'));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }));

    const service = new UsgsEarthquakeService({ fetchFn });
    const first = await service.pollFeed({ feed: 'all', window: 'hour' });
    const second = await service.pollFeed({ feed: 'all', window: 'hour' });

    expect(first.ingestedEvents).toBe(2);
    expect(first.duplicateEvents).toBe(0);
    expect(second.ingestedEvents).toBe(0);
    expect(second.duplicateEvents).toBe(2);

    const metrics = service.getMetrics();
    expect(metrics.ingestedEvents).toBe(2);
    expect(metrics.duplicateEvents).toBe(2);
  });

  it('counts parse failures for malformed features but still ingests valid records', async () => {
    const payload = JSON.parse(fixture('usgs-all-hour-malformed.json'));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }));

    const service = new UsgsEarthquakeService({ fetchFn });
    const result = await service.pollFeed({ feed: 'all', window: 'hour' });

    expect(result.rawEvents).toBe(2);
    expect(result.ingestedEvents).toBe(1);
    expect(result.events[0].eventId).toBe('ci7000good');
    expect(service.getMetrics().parseFailures).toBe(1);
  });

  it('tracks poll failure and parse failure when payload format is invalid', async () => {
    const payload = JSON.parse(fixture('usgs-invalid-payload.json'));
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }));

    const service = new UsgsEarthquakeService({ fetchFn });
    await expect(service.pollFeed({ feed: 'all', window: 'hour' })).rejects.toThrow(
      'USGS payload missing features array'
    );

    const metrics = service.getMetrics();
    expect(metrics.pollFailures).toBe(1);
    expect(metrics.parseFailures).toBe(1);
  });

  it('validates allowed feed and window values', async () => {
    const fetchFn = jest.fn();
    const service = new UsgsEarthquakeService({ fetchFn });

    await expect(service.pollFeed({ feed: 'bad-feed' as any })).rejects.toThrow(
      'feed must be one of'
    );
    await expect(service.pollFeed({ window: 'month' as any })).rejects.toThrow(
      'window must be one of'
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
