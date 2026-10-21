/**
 * WRFCoin Data Flow Performance Monitor
 * Real-time monitoring and alerting for data flow performance and health
 */

const EventEmitter = require('events');
const { logger } = require('../utils/logger');
const { dataFlowValidator } = require('./data-flow-manager');
const { connectionPool } = require('../database/connection-pool');
const { cacheClient } = require('../cache/redis-client');

// Performance thresholds
const PERFORMANCE_THRESHOLDS = {
  // Latency thresholds (in milliseconds)
  validation: {
    warning: 100,
    critical: 500,
  },
  database: {
    warning: 200,
    critical: 1000,
  },
  cache: {
    warning: 50,
    critical: 200,
  },
  transformation: {
    warning: 150,
    critical: 750,
  },

  // Success rate thresholds (percentage)
  successRate: {
    warning: 95,
    critical: 90,
  },

  // Cache hit rate thresholds (percentage)
  cacheHitRate: {
    warning: 70,
    critical: 50,
  },

  // Queue depth thresholds
  queueDepth: {
    warning: 100,
    critical: 500,
  },

  // Error rate thresholds (per minute)
  errorRate: {
    warning: 10,
    critical: 50,
  },
};

// Alert types
const ALERT_TYPES = {
  PERFORMANCE_DEGRADATION: 'performance_degradation',
  HIGH_ERROR_RATE: 'high_error_rate',
  CACHE_PERFORMANCE: 'cache_performance',
  DATABASE_SLOWDOWN: 'database_slowdown',
  VALIDATION_FAILURES: 'validation_failures',
  QUEUE_BUILDUP: 'queue_buildup',
  SYSTEM_RECOVERY: 'system_recovery',
};

class DataFlowMonitor extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.startTime = Date.now();

    // Metrics storage
    this.metrics = {
      validation: {
        count: 0,
        errors: 0,
        totalTime: 0,
        recentLatencies: [],
      },
      database: {
        queries: 0,
        errors: 0,
        totalTime: 0,
        recentLatencies: [],
      },
      cache: {
        operations: 0,
        hits: 0,
        misses: 0,
        errors: 0,
        totalTime: 0,
        recentLatencies: [],
      },
      transformation: {
        count: 0,
        errors: 0,
        totalTime: 0,
        recentLatencies: [],
      },
    };

    // Alert state
    this.alertState = new Map();
    this.alertCooldowns = new Map();
    this.alertHistory = [];

    // Performance windows for analysis
    this.performanceWindows = {
      short: [], // 1 minute
      medium: [], // 5 minutes
      long: [], // 15 minutes
    };

    this.maxWindowSize = {
      short: 60,
      medium: 300,
      long: 900,
    };

    // Health indicators
    this.healthIndicators = {
      overall: 'healthy',
      validation: 'healthy',
      database: 'healthy',
      cache: 'healthy',
      transformation: 'healthy',
    };
  }

  /**
   * Start monitoring data flows
   */
  start() {
    if (this.isRunning) {
      logger.warn('Data flow monitor already running');
      return;
    }

    logger.info('Starting data flow monitor');
    this.isRunning = true;
    this.startTime = Date.now();

    // Set up event listeners
    this.setupEventListeners();

    // Start periodic tasks
    this.startPeriodicTasks();

    logger.info('Data flow monitor started successfully');
    this.emit('monitorStarted');
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping data flow monitor');
    this.isRunning = false;

    // Clear intervals
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
    }
    if (this.alertInterval) {
      clearInterval(this.alertInterval);
    }

    logger.info('Data flow monitor stopped');
    this.emit('monitorStopped');
  }

  /**
   * Set up event listeners for data flow components
   */
  setupEventListeners() {
    // Data flow validator events
    dataFlowValidator.on('validationComplete', validation => {
      this.recordValidationMetric(validation);
    });

    dataFlowValidator.on('validationError', validation => {
      this.recordValidationError(validation);
    });

    dataFlowValidator.on('transformationComplete', transformation => {
      this.recordTransformationMetric(transformation);
    });

    dataFlowValidator.on('transformationError', transformation => {
      this.recordTransformationError(transformation);
    });

    // Database connection pool events
    if (connectionPool) {
      connectionPool.on('queryExecuted', execution => {
        this.recordDatabaseMetric(execution);
      });

      connectionPool.on('queryError', execution => {
        this.recordDatabaseError(execution);
      });
    }

    // Cache client events
    if (cacheClient) {
      cacheClient.on('connected', () => {
        this.updateHealthIndicator('cache', 'healthy');
      });

      cacheClient.on('error', error => {
        this.updateHealthIndicator('cache', 'unhealthy');
        this.recordCacheError(error);
      });
    }
  }

  /**
   * Start periodic monitoring tasks
   */
  startPeriodicTasks() {
    // Collect metrics every 10 seconds
    this.metricsInterval = setInterval(() => {
      this.collectMetrics();
    }, 10000);

    // Health check every 30 seconds
    this.healthInterval = setInterval(() => {
      this.performHealthCheck();
    }, 30000);

    // Alert processing every 60 seconds
    this.alertInterval = setInterval(() => {
      this.processAlerts();
    }, 60000);
  }

  /**
   * Record validation performance metric
   */
  recordValidationMetric(validation) {
    const latency = validation.metrics?.validationTime || 0;

    this.metrics.validation.count++;
    this.metrics.validation.totalTime += latency;
    this.metrics.validation.recentLatencies.push({
      timestamp: Date.now(),
      latency: latency,
    });

    // Keep only recent latencies (last 5 minutes)
    this.trimLatencyHistory('validation');

    // Check for performance issues
    this.checkValidationPerformance(latency);
  }

  /**
   * Record validation error
   */
  recordValidationError(validation) {
    this.metrics.validation.errors++;

    logger.warn('Validation error recorded', {
      validationId: validation.id,
      schemaName: validation.schemaName,
      errorCount: validation.errors?.length || 0,
    });

    this.checkErrorRate('validation');
  }

  /**
   * Record transformation metric
   */
  recordTransformationMetric(transformation) {
    const latency = transformation.metrics?.transformationTime || 0;

    this.metrics.transformation.count++;
    this.metrics.transformation.totalTime += latency;
    this.metrics.transformation.recentLatencies.push({
      timestamp: Date.now(),
      latency: latency,
    });

    this.trimLatencyHistory('transformation');
    this.checkTransformationPerformance(latency);
  }

  /**
   * Record transformation error
   */
  recordTransformationError(transformation) {
    this.metrics.transformation.errors++;

    logger.warn('Transformation error recorded', {
      transformationId: transformation.id,
      errorCount: transformation.errors?.length || 0,
    });

    this.checkErrorRate('transformation');
  }

  /**
   * Record database performance metric
   */
  recordDatabaseMetric(execution) {
    const latency = execution.metrics?.executionTime || 0;

    this.metrics.database.queries++;
    this.metrics.database.totalTime += latency;
    this.metrics.database.recentLatencies.push({
      timestamp: Date.now(),
      latency: latency,
    });

    this.trimLatencyHistory('database');
    this.checkDatabasePerformance(latency);
  }

  /**
   * Record database error
   */
  recordDatabaseError(execution) {
    this.metrics.database.errors++;

    logger.warn('Database error recorded', {
      queryId: execution.id,
      error: execution.error?.message,
    });

    this.checkErrorRate('database');
  }

  /**
   * Record cache error
   */
  recordCacheError(error) {
    this.metrics.cache.errors++;

    logger.warn('Cache error recorded', {
      error: error.message,
    });

    this.checkErrorRate('cache');
  }

  /**
   * Collect comprehensive metrics
   */
  async collectMetrics() {
    try {
      const now = Date.now();

      // Collect validation statistics
      const validationStats = dataFlowValidator.getStatistics();

      // Collect database statistics
      let dbStats = {};
      if (connectionPool && connectionPool.getPoolStatistics) {
        dbStats = connectionPool.getPoolStatistics();
      }

      // Collect cache statistics
      let cacheStats = {};
      if (cacheClient && cacheClient.getStatistics) {
        cacheStats = await cacheClient.getStatistics();
      }

      // Calculate performance metrics
      const performanceSnapshot = {
        timestamp: now,
        validation: {
          avgLatency: this.calculateAverageLatency('validation'),
          successRate: this.calculateSuccessRate('validation'),
          opsPerSecond: this.calculateOpsPerSecond('validation'),
        },
        database: {
          avgLatency: this.calculateAverageLatency('database'),
          successRate: this.calculateSuccessRate('database'),
          opsPerSecond: this.calculateOpsPerSecond('database'),
          connectionPool: dbStats,
        },
        cache: {
          avgLatency: this.calculateAverageLatency('cache'),
          hitRate: cacheStats.performance?.hitRate || '0%',
          opsPerSecond: this.calculateOpsPerSecond('cache'),
          memoryUsage: cacheStats.redis?.usedMemory || 'unknown',
        },
        transformation: {
          avgLatency: this.calculateAverageLatency('transformation'),
          successRate: this.calculateSuccessRate('transformation'),
          opsPerSecond: this.calculateOpsPerSecond('transformation'),
        },
      };

      // Add to performance windows
      this.addToPerformanceWindows(performanceSnapshot);

      // Update health indicators based on performance
      this.updateHealthIndicators(performanceSnapshot);

      this.emit('metricsCollected', performanceSnapshot);
    } catch (error) {
      logger.error('Error collecting metrics', { error: error.message });
    }
  }

  /**
   * Perform comprehensive health check
   */
  async performHealthCheck() {
    const healthCheck = {
      timestamp: Date.now(),
      overall: 'healthy',
      components: {},
    };

    try {
      // Check validation component
      const validationHealth = this.checkComponentHealth('validation');
      healthCheck.components.validation = validationHealth;

      // Check database component
      const databaseHealth = this.checkComponentHealth('database');
      healthCheck.components.database = databaseHealth;

      // Check cache component
      const cacheHealth = this.checkComponentHealth('cache');
      healthCheck.components.cache = cacheHealth;

      // Check transformation component
      const transformationHealth = this.checkComponentHealth('transformation');
      healthCheck.components.transformation = transformationHealth;

      // Determine overall health
      const componentHealths = Object.values(healthCheck.components);
      if (componentHealths.some(h => h.status === 'critical')) {
        healthCheck.overall = 'critical';
      } else if (componentHealths.some(h => h.status === 'warning')) {
        healthCheck.overall = 'warning';
      } else {
        healthCheck.overall = 'healthy';
      }

      // Update health indicators
      this.healthIndicators.overall = healthCheck.overall;
      this.healthIndicators.validation = validationHealth.status;
      this.healthIndicators.database = databaseHealth.status;
      this.healthIndicators.cache = cacheHealth.status;
      this.healthIndicators.transformation = transformationHealth.status;

      this.emit('healthCheckCompleted', healthCheck);
    } catch (error) {
      logger.error('Health check failed', { error: error.message });
      healthCheck.overall = 'critical';
      healthCheck.error = error.message;
    }

    return healthCheck;
  }

  /**
   * Process alerts based on current metrics
   */
  processAlerts() {
    try {
      // Check for performance degradation
      this.checkPerformanceDegradation();

      // Check for high error rates
      this.checkHighErrorRates();

      // Check cache performance
      this.checkCachePerformance();

      // Check for queue buildup
      this.checkQueueBuildup();

      // Clean up old alerts
      this.cleanupAlerts();
    } catch (error) {
      logger.error('Alert processing failed', { error: error.message });
    }
  }

  /**
   * Get current monitoring status
   */
  getStatus() {
    const uptime = Date.now() - this.startTime;

    return {
      isRunning: this.isRunning,
      uptime: uptime,
      startTime: this.startTime,
      healthIndicators: this.healthIndicators,
      metrics: {
        validation: {
          ...this.metrics.validation,
          avgLatency: this.calculateAverageLatency('validation'),
          successRate: this.calculateSuccessRate('validation'),
        },
        database: {
          ...this.metrics.database,
          avgLatency: this.calculateAverageLatency('database'),
          successRate: this.calculateSuccessRate('database'),
        },
        cache: {
          ...this.metrics.cache,
          avgLatency: this.calculateAverageLatency('cache'),
        },
        transformation: {
          ...this.metrics.transformation,
          avgLatency: this.calculateAverageLatency('transformation'),
          successRate: this.calculateSuccessRate('transformation'),
        },
      },
      alerts: {
        active: Array.from(this.alertState.keys()),
        history: this.alertHistory.slice(-10), // Last 10 alerts
      },
    };
  }

  // Private helper methods
  trimLatencyHistory(component) {
    const cutoff = Date.now() - 5 * 60 * 1000; // 5 minutes
    this.metrics[component].recentLatencies = this.metrics[
      component
    ].recentLatencies.filter(entry => entry.timestamp > cutoff);
  }

  calculateAverageLatency(component) {
    const latencies = this.metrics[component].recentLatencies;
    if (latencies.length === 0) return 0;

    const sum = latencies.reduce((acc, entry) => acc + entry.latency, 0);
    return Math.round(sum / latencies.length);
  }

  calculateSuccessRate(component) {
    const total = this.metrics[component].count;
    const errors = this.metrics[component].errors;

    if (total === 0) return 100;
    return Math.round(((total - errors) / total) * 100);
  }

  calculateOpsPerSecond(component) {
    const uptime = (Date.now() - this.startTime) / 1000;
    const total = this.metrics[component].count;

    if (uptime === 0) return 0;
    return Math.round(total / uptime);
  }

  checkValidationPerformance(latency) {
    if (latency > PERFORMANCE_THRESHOLDS.validation.critical) {
      this.triggerAlert(
        ALERT_TYPES.PERFORMANCE_DEGRADATION,
        'critical',
        `Validation latency ${latency}ms exceeds critical threshold`
      );
    } else if (latency > PERFORMANCE_THRESHOLDS.validation.warning) {
      this.triggerAlert(
        ALERT_TYPES.PERFORMANCE_DEGRADATION,
        'warning',
        `Validation latency ${latency}ms exceeds warning threshold`
      );
    }
  }

  checkDatabasePerformance(latency) {
    if (latency > PERFORMANCE_THRESHOLDS.database.critical) {
      this.triggerAlert(
        ALERT_TYPES.DATABASE_SLOWDOWN,
        'critical',
        `Database query latency ${latency}ms exceeds critical threshold`
      );
    } else if (latency > PERFORMANCE_THRESHOLDS.database.warning) {
      this.triggerAlert(
        ALERT_TYPES.DATABASE_SLOWDOWN,
        'warning',
        `Database query latency ${latency}ms exceeds warning threshold`
      );
    }
  }

  checkTransformationPerformance(latency) {
    if (latency > PERFORMANCE_THRESHOLDS.transformation.critical) {
      this.triggerAlert(
        ALERT_TYPES.PERFORMANCE_DEGRADATION,
        'critical',
        `Transformation latency ${latency}ms exceeds critical threshold`
      );
    } else if (latency > PERFORMANCE_THRESHOLDS.transformation.warning) {
      this.triggerAlert(
        ALERT_TYPES.PERFORMANCE_DEGRADATION,
        'warning',
        `Transformation latency ${latency}ms exceeds warning threshold`
      );
    }
  }

  checkErrorRate(component) {
    const successRate = this.calculateSuccessRate(component);

    if (successRate < PERFORMANCE_THRESHOLDS.successRate.critical) {
      this.triggerAlert(
        ALERT_TYPES.HIGH_ERROR_RATE,
        'critical',
        `${component} success rate ${successRate}% is critically low`
      );
    } else if (successRate < PERFORMANCE_THRESHOLDS.successRate.warning) {
      this.triggerAlert(
        ALERT_TYPES.HIGH_ERROR_RATE,
        'warning',
        `${component} success rate ${successRate}% is below normal`
      );
    }
  }

  checkComponentHealth(component) {
    const avgLatency = this.calculateAverageLatency(component);
    const successRate = this.calculateSuccessRate(component);
    const thresholds =
      PERFORMANCE_THRESHOLDS[component] || PERFORMANCE_THRESHOLDS.validation;

    let status = 'healthy';
    const issues = [];

    if (avgLatency > thresholds.critical) {
      status = 'critical';
      issues.push(`High latency: ${avgLatency}ms`);
    } else if (avgLatency > thresholds.warning) {
      status = 'warning';
      issues.push(`Elevated latency: ${avgLatency}ms`);
    }

    if (successRate < PERFORMANCE_THRESHOLDS.successRate.critical) {
      status = 'critical';
      issues.push(`Low success rate: ${successRate}%`);
    } else if (successRate < PERFORMANCE_THRESHOLDS.successRate.warning) {
      if (status !== 'critical') status = 'warning';
      issues.push(`Reduced success rate: ${successRate}%`);
    }

    return {
      status,
      avgLatency,
      successRate,
      issues,
    };
  }

  triggerAlert(type, severity, message) {
    const alertKey = `${type}_${severity}`;

    // Check cooldown
    if (this.alertCooldowns.has(alertKey)) {
      const lastAlert = this.alertCooldowns.get(alertKey);
      const cooldownPeriod =
        severity === 'critical' ? 5 * 60 * 1000 : 15 * 60 * 1000; // 5min for critical, 15min for warning

      if (Date.now() - lastAlert < cooldownPeriod) {
        return; // Still in cooldown
      }
    }

    const alert = {
      id: crypto.randomUUID(),
      type,
      severity,
      message,
      timestamp: Date.now(),
      acknowledged: false,
    };

    this.alertState.set(alertKey, alert);
    this.alertCooldowns.set(alertKey, Date.now());
    this.alertHistory.push(alert);

    // Keep only last 100 alerts in history
    if (this.alertHistory.length > 100) {
      this.alertHistory.splice(0, this.alertHistory.length - 100);
    }

    logger.warn('Alert triggered', alert);
    this.emit('alertTriggered', alert);
  }

  updateHealthIndicator(component, status) {
    if (this.healthIndicators[component] !== status) {
      this.healthIndicators[component] = status;
      logger.info('Health indicator updated', { component, status });
      this.emit('healthIndicatorChanged', { component, status });
    }
  }

  addToPerformanceWindows(snapshot) {
    // Add to all windows
    this.performanceWindows.short.push(snapshot);
    this.performanceWindows.medium.push(snapshot);
    this.performanceWindows.long.push(snapshot);

    // Trim windows to max size
    Object.keys(this.performanceWindows).forEach(window => {
      const maxSize = this.maxWindowSize[window];
      if (this.performanceWindows[window].length > maxSize) {
        this.performanceWindows[window].splice(
          0,
          this.performanceWindows[window].length - maxSize
        );
      }
    });
  }

  updateHealthIndicators(snapshot) {
    // Update based on performance snapshot
    ['validation', 'database', 'cache', 'transformation'].forEach(component => {
      const metrics = snapshot[component];
      if (!metrics) return;

      let status = 'healthy';

      if (metrics.avgLatency > PERFORMANCE_THRESHOLDS[component]?.critical) {
        status = 'unhealthy';
      } else if (
        metrics.avgLatency > PERFORMANCE_THRESHOLDS[component]?.warning
      ) {
        status = 'degraded';
      }

      this.updateHealthIndicator(component, status);
    });
  }

  checkPerformanceDegradation() {
    // Check if performance has degraded compared to historical averages
    const recentWindow = this.performanceWindows.short.slice(-10); // Last 10 snapshots
    if (recentWindow.length < 5) return; // Need enough data

    const historicalWindow = this.performanceWindows.medium.slice(-50, -10); // Historical data
    if (historicalWindow.length < 20) return;

    ['validation', 'database', 'transformation'].forEach(component => {
      const recentAvg =
        recentWindow.reduce(
          (sum, s) => sum + (s[component]?.avgLatency || 0),
          0
        ) / recentWindow.length;
      const historicalAvg =
        historicalWindow.reduce(
          (sum, s) => sum + (s[component]?.avgLatency || 0),
          0
        ) / historicalWindow.length;

      if (recentAvg > historicalAvg * 1.5) {
        // 50% increase
        this.triggerAlert(
          ALERT_TYPES.PERFORMANCE_DEGRADATION,
          'warning',
          `${component} performance degraded: ${recentAvg}ms vs ${historicalAvg}ms historical average`
        );
      }
    });
  }

  checkHighErrorRates() {
    Object.keys(this.metrics).forEach(component => {
      const successRate = this.calculateSuccessRate(component);
      if (successRate < PERFORMANCE_THRESHOLDS.successRate.warning) {
        this.checkErrorRate(component);
      }
    });
  }

  checkCachePerformance() {
    // Implementation would check cache hit rates and performance
    // This is a placeholder for cache-specific monitoring
  }

  checkQueueBuildup() {
    // Implementation would check for queue buildup in various components
    // This is a placeholder for queue monitoring
  }

  cleanupAlerts() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours

    // Remove old alerts from history
    this.alertHistory = this.alertHistory.filter(
      alert => alert.timestamp > cutoff
    );

    // Clean up resolved alerts from active state
    for (const [key, alert] of this.alertState.entries()) {
      if (alert.timestamp < cutoff || alert.acknowledged) {
        this.alertState.delete(key);
      }
    }
  }
}

// Export singleton instance
const dataFlowMonitor = new DataFlowMonitor();

module.exports = {
  dataFlowMonitor,
  DataFlowMonitor,
  PERFORMANCE_THRESHOLDS,
  ALERT_TYPES,
};
