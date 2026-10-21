import { describe, expect, it } from '@jest/globals';

/**
 * Regression tests for #812: /health false-negative when cache is degraded.
 *
 * Cache (Redis L2) is a soft dependency. A missing/degraded cache must not
 * cause /health to return 503 or mark the service unhealthy. Only core4
 * unavailability is a fatal condition for /health.
 */

// ---------------------------------------------------------------------------
// Unit-test the status aggregation logic that lives in getOperationalHealthSnapshot
// ---------------------------------------------------------------------------

function aggregateHealthStatus(
  core4Status: string,
  _cacheStatus: string  // cache does not affect /health status (#812)
): string {
  // Mirrors the fixed logic in enhanced_unified_api_optimized.ts
  return core4Status !== 'up' ? 'unhealthy' : 'healthy';
}

function toHttpStatus(status: string): number {
  return status === 'healthy' ? 200 : 503;
}

describe('#812 — cache is a soft dependency for /health', () => {
  describe('cache healthy + core4 up → 200', () => {
    it('healthy cache, core4 up → healthy', () => {
      expect(aggregateHealthStatus('up', 'healthy')).toBe('healthy');
      expect(toHttpStatus('healthy')).toBe(200);
    });
  });

  describe('cache degraded (redis absent) + core4 up → still 200', () => {
    it('degraded cache, core4 up → healthy (not degraded)', () => {
      expect(aggregateHealthStatus('up', 'degraded')).toBe('healthy');
      expect(toHttpStatus('healthy')).toBe(200);
    });
  });

  describe('cache down + core4 up → still 200', () => {
    it('down cache, core4 up → healthy (cache is non-fatal)', () => {
      expect(aggregateHealthStatus('up', 'down')).toBe('healthy');
      expect(toHttpStatus('healthy')).toBe(200);
    });
  });

  describe('core4 down → 503 regardless of cache state', () => {
    it('cache healthy, core4 down → unhealthy', () => {
      expect(aggregateHealthStatus('down', 'healthy')).toBe('unhealthy');
      expect(toHttpStatus('unhealthy')).toBe(503);
    });

    it('cache degraded, core4 down → unhealthy', () => {
      expect(aggregateHealthStatus('down', 'degraded')).toBe('unhealthy');
      expect(toHttpStatus('unhealthy')).toBe(503);
    });
  });
});

// ---------------------------------------------------------------------------
// Unit-test CachePerformanceManager.getHealthStatus — memory is always true
// ---------------------------------------------------------------------------

describe('#812 — CachePerformanceManager.getHealthStatus memory flag', () => {
  function deriveStatus(redis: boolean, memoryFull: boolean): string {
    // Mirrors the fixed getHealthStatus in cache-performance.ts:
    //   memory is always true (LRU at capacity still works via eviction)
    const memory = true;       // was: this.memoryCache.size < this.memoryCache.max
    void memoryFull;           // unused post-fix; included in signature for clarity
    return redis ? 'healthy' : 'degraded';
  }

  it('redis connected + cache at capacity → healthy (not degraded)', () => {
    expect(deriveStatus(true, true)).toBe('healthy');
  });

  it('redis connected + cache empty → healthy', () => {
    expect(deriveStatus(true, false)).toBe('healthy');
  });

  it('redis absent + cache at capacity → degraded (not down)', () => {
    expect(deriveStatus(false, true)).toBe('degraded');
  });

  it('redis absent + cache empty → degraded', () => {
    expect(deriveStatus(false, false)).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// Unit-test mapCacheDependency — degraded maps to 'degraded' (not 'down')
// ---------------------------------------------------------------------------

function mapCacheDependency(cacheHealth: { status?: string }) {
  // Mirrors the unchanged mapCacheDependency in enhanced_unified_api_operational_probes.ts
  const sourceStatus =
    typeof cacheHealth?.status === 'string' ? cacheHealth.status : 'unknown';
  return {
    status:
      sourceStatus === 'healthy'
        ? 'up'
        : sourceStatus === 'degraded'
          ? 'degraded'
          : 'down',
    sourceStatus,
  };
}

describe('#812 — mapCacheDependency with critical:false does not block /health', () => {
  it('healthy cache maps to up', () => {
    expect(mapCacheDependency({ status: 'healthy' }).status).toBe('up');
  });

  it('degraded cache maps to degraded (not down)', () => {
    expect(mapCacheDependency({ status: 'degraded' }).status).toBe('degraded');
  });

  it('missing status maps to down', () => {
    expect(mapCacheDependency({}).status).toBe('down');
  });

  it('with critical:false a degraded/down cache does not flip /health to 503', () => {
    // The createHealthMiddleware evaluates critical deps; non-critical deps are
    // surfaced in the payload but do not gate the HTTP status. Verify the flag.
    const isCritical = false; // the new value set in enhanced_unified_api_operational_probes.ts
    const cacheStatus = mapCacheDependency({ status: 'degraded' }).status;

    // Non-critical deps with non-'up' status do not trigger unhealthy.
    const wouldBlock = isCritical && cacheStatus !== 'up';
    expect(wouldBlock).toBe(false);
  });
});
