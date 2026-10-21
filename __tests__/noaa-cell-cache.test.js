/**
 * S2c: in-process NOAA cell cache (server/utils/noaa-cell-cache.js).
 */
const { TtlCache, NOAA_TTL_MS, cellKey, toCell } = require('../server/utils/noaa-cell-cache');

describe('noaa-cell-cache', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  describe('cell rounding', () => {
    it('shares a key within a 0.1 degree cell and splits across cells', () => {
      const a = cellKey('current', 37.41, -121.94);
      expect(cellKey('current', 37.44, -121.91)).toBe(a);
      expect(cellKey('current', 37.4123456, -121.9387)).toBe(a);
      expect(cellKey('current', 37.45, -121.94)).not.toBe(a);
      expect(cellKey('current', 37.41, -121.96)).not.toBe(a);
      expect(toCell(37.41, -121.94)).toEqual({ latitude: 37.4, longitude: -121.9 });
    });

    it('separates kinds and params in the same cell', () => {
      expect(cellKey('hourly', 37.4, -121.9, 24)).not.toBe(cellKey('hourly', 37.4, -121.9, 336));
      expect(cellKey('hourly', 37.4, -121.9, 24)).not.toBe(cellKey('daily', 37.4, -121.9, 24));
    });
  });

  describe('hit / miss / ttl', () => {
    it('loads once, then serves HIT until the TTL expires', async () => {
      const cache = new TtlCache();
      const loader = jest.fn(async () => ({ n: loader.mock.calls.length }));
      const first = await cache.getOrLoad('k', NOAA_TTL_MS.current, loader);
      expect(first.status).toBe('MISS');
      const second = await cache.getOrLoad('k', NOAA_TTL_MS.current, loader);
      expect(second.status).toBe('HIT');
      expect(second.value).toBe(first.value);
      expect(loader).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(NOAA_TTL_MS.current - 1);
      expect((await cache.getOrLoad('k', NOAA_TTL_MS.current, loader)).status).toBe('HIT');
      jest.advanceTimersByTime(1);
      const expired = await cache.getOrLoad('k', NOAA_TTL_MS.current, loader);
      expect(expired.status).toBe('MISS');
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('keeps the documented TTL ordering and a 24 h grid-point TTL', () => {
      expect(NOAA_TTL_MS.current).toBe(5 * 60 * 1000);
      expect(NOAA_TTL_MS.hourlyForecast).toBe(15 * 60 * 1000);
      expect(NOAA_TTL_MS.dailyForecast).toBeGreaterThanOrEqual(30 * 60 * 1000);
      expect(NOAA_TTL_MS.dailyForecast).toBeLessThanOrEqual(60 * 60 * 1000);
      expect(NOAA_TTL_MS.alerts).toBe(5 * 60 * 1000);
      expect(NOAA_TTL_MS.gridPoint).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe('coalescing', () => {
    it('shares one upstream call between concurrent identical misses', async () => {
      const cache = new TtlCache();
      let release;
      const gate = new Promise((r) => (release = r));
      const loader = jest.fn(async () => {
        await gate;
        return { ok: true };
      });
      const calls = Array.from({ length: 10 }, () => cache.getOrLoad('k', 1000, loader));
      release();
      const results = await Promise.all(calls);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(results.filter((r) => r.status === 'MISS')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'COALESCED')).toHaveLength(9);
      for (const r of results) expect(r.value).toBe(results[0].value);
    });

    it('does not coalesce different keys', async () => {
      const cache = new TtlCache();
      const loader = jest.fn(async () => 1);
      await Promise.all([cache.getOrLoad('a', 1000, loader), cache.getOrLoad('b', 1000, loader)]);
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });

  describe('errors', () => {
    it('does not cache a failure: every waiter rejects, the next call retries', async () => {
      const cache = new TtlCache();
      let release;
      const gate = new Promise((r) => (release = r));
      const loader = jest
        .fn()
        .mockImplementationOnce(async () => {
          await gate;
          throw new Error('NOAA 503');
        })
        .mockImplementation(async () => ({ ok: true }));
      const calls = [1, 2, 3].map(() => cache.getOrLoad('k', 1000, loader).catch((e) => e));
      release();
      const settled = await Promise.all(calls);
      expect(settled.every((e) => e instanceof Error && e.message === 'NOAA 503')).toBe(true);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(cache.size).toBe(0);

      const retry = await cache.getOrLoad('k', 1000, loader);
      expect(retry.status).toBe('MISS');
      expect(retry.value).toEqual({ ok: true });
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });

  describe('bounded size', () => {
    it('evicts the least recently used entry past maxEntries', async () => {
      const cache = new TtlCache({ maxEntries: 3 });
      for (const k of ['a', 'b', 'c']) await cache.getOrLoad(k, 1000, async () => k);
      expect(cache.get('a')).toBe('a'); // touch a: b is now oldest
      await cache.getOrLoad('d', 1000, async () => 'd');
      expect(cache.size).toBe(3);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('a')).toBe('a');
      expect(cache.get('c')).toBe('c');
      expect(cache.get('d')).toBe('d');
    });
  });
});
