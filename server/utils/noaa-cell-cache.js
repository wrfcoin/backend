/**
 * In-process TTL + LRU cache with in-flight coalescing for NOAA NWS calls
 * (backend S2c).
 *
 * Why: anonymous GET /api/weather/{current,forecast}/<lat>,<lon> share ONE
 * NOAA budget (1000 requests/hour) with every other consumer, and /current
 * costs >= 3 upstream requests, /forecast 2. Keying on the 0.1 degree cell
 * (the same grid as utils/coordinate-grid.js) collapses all callers in a cell
 * onto one upstream fetch per TTL.
 *
 * Rules:
 *  - the key is derived ONLY from the gridded cell + request kind/params, and
 *    the upstream call is made at the cell centre, so one cell's data can
 *    never be served for another;
 *  - concurrent identical misses share a single upstream promise;
 *  - failures are never stored (the in-flight entry is dropped on settle), so
 *    the next request retries at once;
 *  - bounded: at most maxEntries values; least recently used is evicted.
 */

const { toStorageGrid } = require('./coordinate-grid');

// TTLs. NWS refreshes observations roughly hourly per station and hourly
// forecasts about hourly, the 12h-period forecast a few times a day, so these
// bound staleness well inside the source's own refresh cadence while cutting
// upstream load by 1-2 orders of magnitude.
const NOAA_TTL_MS = Object.freeze({
  current: 5 * 60 * 1000,
  hourlyForecast: 15 * 60 * 1000,
  dailyForecast: 30 * 60 * 1000,
  alerts: 5 * 60 * 1000,
  // /points/{lat},{lon} -> gridpoint metadata is static.
  gridPoint: 24 * 60 * 60 * 1000,
});

const DEFAULT_MAX_ENTRIES = 2000;

/** Round a coordinate pair onto the 0.1 degree grid (cell centre). */
function toCell(latitude, longitude) {
  return { latitude: toStorageGrid(latitude), longitude: toStorageGrid(longitude) };
}

/** Stable cache key: kind, gridded cell, then ordered params. */
function cellKey(kind, latitude, longitude, ...params) {
  const cell = toCell(latitude, longitude);
  return [kind, `${cell.latitude.toFixed(1)},${cell.longitude.toFixed(1)}`, ...params].join('|');
}

class TtlCache {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map(); // key -> { value, expiresAt }; insertion order = LRU order
    this.inflight = new Map(); // key -> Promise
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
  }

  /** Fresh value or undefined; a hit becomes most recently used. */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  /**
   * Resolve `key` from cache, else from one shared `loader()` call.
   * Returns { value, status } with status HIT | MISS | COALESCED
   * (MISS = this call started the upstream fetch).
   */
  async getOrLoad(key, ttlMs, loader) {
    const cached = this.get(key);
    if (cached !== undefined) return { value: cached, status: 'HIT' };

    const pending = this.inflight.get(key);
    if (pending) return { value: await pending, status: 'COALESCED' };

    const promise = (async () => {
      try {
        const value = await loader();
        // Failures throw out of here and are therefore never stored.
        if (value !== undefined) this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return { value: await promise, status: 'MISS' };
  }
}

module.exports = { TtlCache, NOAA_TTL_MS, DEFAULT_MAX_ENTRIES, toCell, cellKey };
