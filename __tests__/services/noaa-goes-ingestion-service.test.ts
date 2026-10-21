import fs from 'fs';
import path from 'path';
import { NoaaGoesIngestionService } from '../../server/services/satellite/noaa-goes-ingestion-service.js';

function fixture(name: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '../fixtures/satellite', name),
    'utf8'
  );
}

describe('NoaaGoesIngestionService', () => {
  it('polls NOAA GOES listing, normalizes observations, and dedupes idempotently', async () => {
    const xml = fixture('noaa-goes-listing.xml');
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => xml,
    }));

    const service = new NoaaGoesIngestionService({
      fetchFn,
      nowFn: () => new Date('2026-03-05T12:30:00Z'),
    });

    const first = await service.pollLatest({ maxKeys: 5 });
    expect(first.rawRecords).toBe(2);
    expect(first.ingestedRecords).toBe(2);
    expect(first.duplicateRecords).toBe(0);
    expect(first.observations[0].sourceType).toBe('satellite');
    expect(first.observations[0].provider).toBe('NOAA');
    expect(first.observations[0].platform).toBe('GOES-16');
    expect(first.observations[0].productFamily).toBe('ABI-L2-CMIPF');
    expect(first.observations[0].coverageBounds.west).toBe(-180);

    const second = await service.pollLatest({ maxKeys: 5 });
    expect(second.ingestedRecords).toBe(0);
    expect(second.duplicateRecords).toBe(2);

    const metrics = service.getMetrics();
    expect(metrics.pollAttempts).toBe(2);
    expect(metrics.pollSuccesses).toBe(2);
    expect(metrics.duplicateRecords).toBe(2);
    expect(metrics.successRate).toBe(1);
  });

  it('supports bounded backfill over hourly prefixes', async () => {
    const xml = fixture('noaa-goes-listing.xml');
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => xml,
    }));

    const service = new NoaaGoesIngestionService({
      fetchFn,
      nowFn: () => new Date('2026-03-05T13:00:00Z'),
    });

    const result = await service.backfill({
      startTime: '2026-03-05T11:00:00Z',
      endTime: '2026-03-05T12:00:00Z',
      maxHours: 3,
      maxKeysPerHour: 5,
    });

    expect(result.prefixesProcessed).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.rawRecords).toBe(4);
    expect(result.ingestedRecords).toBe(2);
    expect(result.duplicateRecords).toBe(2);
  });

  it('extracts observations overlapping a requested bounding box', async () => {
    const xml = fixture('noaa-goes-listing.xml');
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => xml,
    }));

    const service = new NoaaGoesIngestionService({
      fetchFn,
      nowFn: () => new Date('2026-03-05T12:30:00Z'),
    });

    const result = await service.pollLatest({ maxKeys: 5 });
    const regional = service.extractRegional(result.observations, {
      west: -100,
      south: 30,
      east: -70,
      north: 45,
    });

    expect(regional).toHaveLength(2);
  });

  it('tracks parse failures and NOAA endpoint URL structure for integration sanity', async () => {
    const malformedXml = '<ListBucketResult><Contents><Key>bad</Key></Contents></ListBucketResult>';
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => malformedXml,
    }));

    const service = new NoaaGoesIngestionService({
      fetchFn,
      nowFn: () => new Date('2026-03-05T12:30:00Z'),
    });

    const result = await service.pollLatest({ productFamily: 'ABI-L2-CMIPF', maxKeys: 10 });
    expect(result.rawRecords).toBe(1);
    expect(result.ingestedRecords).toBe(0);

    const firstUrl = String(fetchFn.mock.calls[0][0]);
    expect(firstUrl.startsWith('https://noaa-goes16.s3.amazonaws.com/')).toBe(true);
    expect(firstUrl.includes('list-type=2')).toBe(true);
    expect(firstUrl.includes('prefix=ABI-L2-CMIPF')).toBe(true);

    const metrics = service.getMetrics();
    expect(metrics.parseFailures).toBe(1);
  });
});
