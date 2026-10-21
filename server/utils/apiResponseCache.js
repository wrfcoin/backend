/**
 * API Response Cache for Wrfcoin Backend
 * Implements intelligent caching strategies for improved performance
 */

const LRU = require('lru-cache');

class ApiResponseCache {
  constructor(options = {}) {
    this.cache = new LRU({
      max: options.maxSize || 1000,
      ttl: options.defaultTTL || 300000, // 5 minutes
      updateAgeOnGet: true,
      updateAgeOnHas: true,
    });

    this.cachePolicies = new Map();
    this.hitStats = { hits: 0, misses: 0, total: 0 };

    // Setup default cache policies
    this.setupDefaultPolicies();
  }

  setupDefaultPolicies() {
    // Static data - cache for 1 hour
    this.setCachePolicy('/api/blockchain/status', {
      ttl: 3600000,
      staleWhileRevalidate: true,
    });
    this.setCachePolicy('/api/weather/stations', {
      ttl: 1800000,
      staleWhileRevalidate: true,
    });

    // Dynamic data - cache for 30 seconds
    this.setCachePolicy('/api/stats', { ttl: 30000, bypassOnError: true });
    this.setCachePolicy('/api/mining/stats', {
      ttl: 15000,
      bypassOnError: true,
    });

    // User-specific data - cache for 2 minutes
    this.setCachePolicy('/api/wallet/*', { ttl: 120000, userSpecific: true });
    this.setCachePolicy('/api/governance/votes/*', {
      ttl: 300000,
      userSpecific: true,
    });

    // Heavy computational data - cache for 10 minutes
    this.setCachePolicy('/api/computational/nfts', {
      ttl: 600000,
      staleWhileRevalidate: true,
    });
    this.setCachePolicy('/api/consensus/metrics', {
      ttl: 300000,
      staleWhileRevalidate: true,
    });
  }

  setCachePolicy(pattern, policy) {
    this.cachePolicies.set(pattern, {
      ttl: policy.ttl || 300000,
      staleWhileRevalidate: policy.staleWhileRevalidate || false,
      bypassOnError: policy.bypassOnError || false,
      userSpecific: policy.userSpecific || false,
      skipCache: policy.skipCache || false,
    });
  }

  getCacheKey(req) {
    const baseKey = `${req.method}:${req.path}`;
    const policy = this.findMatchingPolicy(req.path);

    if (policy && policy.userSpecific) {
      const userId = req.user?.id || req.headers['x-user-id'] || 'anonymous';
      return `${baseKey}:${userId}`;
    }

    // Include query parameters for GET requests
    if (req.method === 'GET' && Object.keys(req.query).length > 0) {
      const sortedQuery = Object.keys(req.query)
        .sort()
        .map(key => `${key}=${req.query[key]}`)
        .join('&');
      return `${baseKey}?${sortedQuery}`;
    }

    return baseKey;
  }

  findMatchingPolicy(path) {
    for (const [pattern, policy] of this.cachePolicies) {
      if (this.matchPattern(pattern, path)) {
        return policy;
      }
    }
    return null;
  }

  matchPattern(pattern, path) {
    if (pattern === path) return true;
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return path.startsWith(prefix);
    }
    return false;
  }

  middleware() {
    return (req, res, next) => {
      // Skip caching for non-GET requests by default
      if (req.method !== 'GET') {
        return next();
      }

      const policy = this.findMatchingPolicy(req.path);
      if (!policy || policy.skipCache) {
        return next();
      }

      const cacheKey = this.getCacheKey(req);
      const cached = this.cache.get(cacheKey);

      if (cached) {
        this.hitStats.hits++;
        this.hitStats.total++;

        // Check if stale and needs revalidation
        if (policy.staleWhileRevalidate && this.isStale(cached, policy.ttl)) {
          // Serve stale data immediately
          res.json(cached.data);

          // Revalidate in background
          setImmediate(() => this.revalidate(req, cacheKey, policy));
          return;
        }

        return res.json(cached.data);
      }

      // Cache miss - continue to handler
      this.hitStats.misses++;
      this.hitStats.total++;

      // Override res.json to cache the response
      const originalJson = res.json.bind(res);
      res.json = data => {
        if (res.statusCode === 200 && data) {
          this.cache.set(
            cacheKey,
            {
              data: data,
              timestamp: Date.now(),
              path: req.path,
            },
            { ttl: policy.ttl }
          );
        }
        return originalJson(data);
      };

      next();
    };
  }

  isStale(cached, ttl) {
    return Date.now() - cached.timestamp > ttl * 0.8; // 80% of TTL
  }

  async revalidate(req, cacheKey, policy) {
    try {
      // This would trigger a background refresh
      // For now, just log the revalidation attempt
      console.log(`Background revalidation triggered for ${req.path}`);
    } catch (error) {
      console.error('Cache revalidation failed:', error);
    }
  }

  invalidate(pattern) {
    const keysToDelete = [];

    for (const key of this.cache.keys()) {
      if (this.matchPattern(pattern, key)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => this.cache.delete(key));
    return keysToDelete.length;
  }

  invalidateByPath(path) {
    return this.invalidate(path);
  }

  invalidateUserCache(userId) {
    return this.invalidate(`*:${userId}`);
  }

  getStats() {
    return {
      size: this.cache.size,
      hitRate:
        this.hitStats.total > 0
          ? ((this.hitStats.hits / this.hitStats.total) * 100).toFixed(2) + '%'
          : '0%',
      hits: this.hitStats.hits,
      misses: this.hitStats.misses,
      total: this.hitStats.total,
      memoryUsage: this.cache.calculatedSize || 0,
    };
  }

  clear() {
    this.cache.clear();
    this.hitStats = { hits: 0, misses: 0, total: 0 };
  }
}

module.exports = ApiResponseCache;
