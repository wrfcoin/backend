/**
 * System Optimizer for Wrfcoin Backend
 * Implements performance optimizations and resource management
 */

const { appLogger } = require('../../utils/logger');

class SystemOptimizer {
  constructor() {
    this.optimizations = {
      memoryPool: new Map(),
      requestCache: new Map(),
      connectionPool: new Map(),
      garbageCollectionStats: [],
    };

    this.thresholds = {
      memoryWarning: 512 * 1024 * 1024, // 512MB
      memoryMaximum: 1024 * 1024 * 1024, // 1GB
      responseTimeTarget: 100, // 100ms
      maxConcurrentRequests: 1000,
    };

    this.startOptimizationLoop();
  }

  // Main optimization middleware
  middleware() {
    return (req, res, next) => {
      const requestId = this.generateRequestId();
      const startTime = process.hrtime.bigint();

      // Track request
      req.optimizationId = requestId;
      this.trackRequest(req, startTime);

      // Override res.end to capture metrics
      const originalEnd = res.end.bind(res);
      res.end = (chunk, encoding) => {
        const endTime = process.hrtime.bigint();
        const duration = Number(endTime - startTime) / 1000000; // Convert to ms

        this.recordRequestCompletion(requestId, duration, res.statusCode);
        return originalEnd(chunk, encoding);
      };

      next();
    };
  }

  trackRequest(req, startTime) {
    this.optimizations.requestCache.set(req.optimizationId, {
      method: req.method,
      path: req.path,
      startTime,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });
  }

  recordRequestCompletion(requestId, duration, statusCode) {
    const request = this.optimizations.requestCache.get(requestId);
    if (request) {
      request.duration = duration;
      request.statusCode = statusCode;
      request.completedAt = new Date();

      // Analyze performance
      if (duration > this.thresholds.responseTimeTarget) {
        this.handleSlowRequest(request);
      }

      // Clean up
      setTimeout(() => {
        this.optimizations.requestCache.delete(requestId);
      }, 60000); // Keep for 1 minute
    }
  }

  handleSlowRequest(request) {
    appLogger.warn('Slow request detected', {
      module: 'SystemOptimizer',
      method: request.method,
      path: request.path,
      duration: request.duration.toFixed(2)
    });

    // Implement optimization strategies
    if (request.path.startsWith('/api/')) {
      this.optimizeAPIEndpoint(request.path);
    }
  }

  optimizeAPIEndpoint(path) {
    // Add caching for frequently accessed endpoints
    const cacheKey = `endpoint:${path}`;
    const accessCount = this.optimizations.memoryPool.get(cacheKey) || 0;
    this.optimizations.memoryPool.set(cacheKey, accessCount + 1);

    // If endpoint is accessed frequently, suggest caching
    if (accessCount > 10) {
      appLogger.info('Frequent endpoint detected - Consider adding caching', {
        module: 'SystemOptimizer',
        path
      });
    }
  }

  // Memory optimization
  optimizeMemoryUsage() {
    const memUsage = process.memoryUsage();

    if (memUsage.heapUsed > this.thresholds.memoryWarning) {
      appLogger.warn('High memory usage', {
        module: 'SystemOptimizer',
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024)
      });

      // Trigger garbage collection if available
      if (global.gc) {
        const beforeGC = process.memoryUsage();
        global.gc();
        const afterGC = process.memoryUsage();

        this.optimizations.garbageCollectionStats.push({
          timestamp: new Date(),
          before: beforeGC,
          after: afterGC,
          freed: beforeGC.heapUsed - afterGC.heapUsed,
        });

        appLogger.info('GC completed', {
          module: 'SystemOptimizer',
          freedMB: Math.round((beforeGC.heapUsed - afterGC.heapUsed) / 1024 / 1024)
        });
      }

      // Clear old cache entries
      this.clearOldCacheEntries();
    }

    // Emergency memory cleanup
    if (memUsage.heapUsed > this.thresholds.memoryMaximum) {
      this.emergencyMemoryCleanup();
    }
  }

  clearOldCacheEntries() {
    const cutoff = Date.now() - 5 * 60 * 1000; // 5 minutes ago

    for (const [key, request] of this.optimizations.requestCache.entries()) {
      if (request.completedAt && request.completedAt.getTime() < cutoff) {
        this.optimizations.requestCache.delete(key);
      }
    }

    appLogger.info('Cleared old cache entries', { module: 'SystemOptimizer' });
  }

  emergencyMemoryCleanup() {
    appLogger.error('Emergency memory cleanup triggered', { module: 'SystemOptimizer' });

    // Clear all non-essential caches
    this.optimizations.requestCache.clear();
    this.optimizations.memoryPool.clear();

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    // Log emergency event
    appLogger.error('Emergency cleanup completed', {
      module: 'SystemOptimizer',
      currentMemoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
  }

  // Connection pool optimization
  optimizeConnectionPool() {
    const activeConnections = this.optimizations.connectionPool.size;

    if (activeConnections > this.thresholds.maxConcurrentRequests) {
      appLogger.warn('High connection count', { module: 'SystemOptimizer', activeConnections });

      // Implement connection throttling
      this.throttleConnections();
    }
  }

  throttleConnections() {
    // Remove oldest connections if over limit
    const connections = Array.from(
      this.optimizations.connectionPool.entries()
    ).sort((a, b) => a[1].lastActivity - b[1].lastActivity);

    const toRemove = connections.length - this.thresholds.maxConcurrentRequests;
    if (toRemove > 0) {
      for (let i = 0; i < toRemove; i++) {
        this.optimizations.connectionPool.delete(connections[i][0]);
      }
      appLogger.info('Throttled connections', { module: 'SystemOptimizer', count: toRemove });
    }
  }

  // Performance analysis
  analyzePerformance() {
    const recentRequests = Array.from(this.optimizations.requestCache.values())
      .filter(req => req.duration && req.completedAt)
      .slice(-100); // Last 100 requests

    if (recentRequests.length === 0) return null;

    const durations = recentRequests.map(req => req.duration);
    const avgDuration =
      durations.reduce((sum, d) => sum + d, 0) / durations.length;
    const maxDuration = Math.max(...durations);
    const minDuration = Math.min(...durations);

    const slowRequests = recentRequests.filter(
      req => req.duration > this.thresholds.responseTimeTarget
    );
    const errorRequests = recentRequests.filter(req => req.statusCode >= 400);

    return {
      totalRequests: recentRequests.length,
      averageResponseTime: Math.round(avgDuration * 100) / 100,
      minResponseTime: Math.round(minDuration * 100) / 100,
      maxResponseTime: Math.round(maxDuration * 100) / 100,
      slowRequestCount: slowRequests.length,
      errorRate:
        ((errorRequests.length / recentRequests.length) * 100).toFixed(2) + '%',
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
    };
  }

  // Main optimization loop
  startOptimizationLoop() {
    this.optimizationInterval = setInterval(() => {
      this.optimizeMemoryUsage();
      this.optimizeConnectionPool();

      // Periodic performance logging
      const performance = this.analyzePerformance();
      if (performance && performance.slowRequestCount > 5) {
        appLogger.info('Performance alert: slow requests detected', {
          module: 'SystemOptimizer',
          slowRequestCount: performance.slowRequestCount
        });
      }
    }, 30000); // Run every 30 seconds
  }

  stopOptimizationLoop() {
    if (this.optimizationInterval) {
      clearInterval(this.optimizationInterval);
    }
  }

  generateRequestId() {
    return (
      'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8)
    );
  }

  // Get optimization stats
  getOptimizationStats() {
    const performance = this.analyzePerformance();
    const memUsage = process.memoryUsage();

    return {
      performance,
      memory: {
        current: Math.round(memUsage.heapUsed / 1024 / 1024),
        total: Math.round(memUsage.heapTotal / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024),
        warningThreshold: Math.round(
          this.thresholds.memoryWarning / 1024 / 1024
        ),
        maximumThreshold: Math.round(
          this.thresholds.memoryMaximum / 1024 / 1024
        ),
      },
      connections: {
        active: this.optimizations.connectionPool.size,
        maximum: this.thresholds.maxConcurrentRequests,
      },
      cache: {
        requestCacheSize: this.optimizations.requestCache.size,
        memoryPoolSize: this.optimizations.memoryPool.size,
      },
      garbageCollection: {
        runs: this.optimizations.garbageCollectionStats.length,
        lastRun: this.optimizations.garbageCollectionStats.slice(-1)[0],
      },
    };
  }
}

module.exports = SystemOptimizer;
