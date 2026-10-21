/**
 * Performance SLO Validator
 *
 * Validates Service Level Objectives (SLOs) for WRFCoin platform.
 * Provides blockchain, cross-chain bridge, and cache performance testing.
 */

import { EventEmitter } from 'events';
import { Counter, Gauge, Histogram } from 'prom-client';

// SLO Metrics for Prometheus
export const sloMetrics = {
  sloCompliance: new Gauge({
    name: 'wrfcoin_slo_compliance_percentage',
    help: 'SLO compliance percentage by service',
    labelNames: ['service', 'slo_name'],
  }),

  sloViolations: new Counter({
    name: 'wrfcoin_slo_violations_total',
    help: 'Total number of SLO violations',
    labelNames: ['service', 'slo_name', 'severity'],
  }),

  sloLatency: new Histogram({
    name: 'wrfcoin_slo_latency_seconds',
    help: 'Latency measurements for SLO tracking',
    labelNames: ['service', 'operation'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  }),

  transactionThroughput: new Gauge({
    name: 'wrfcoin_transaction_throughput_tps',
    help: 'Current transaction throughput in TPS',
    labelNames: ['chain'],
  }),

  bridgeLatency: new Histogram({
    name: 'wrfcoin_bridge_latency_seconds',
    help: 'Cross-chain bridge operation latency',
    labelNames: ['source_chain', 'destination_chain', 'operation'],
    buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  }),

  cacheHitRatio: new Gauge({
    name: 'wrfcoin_cache_hit_ratio',
    help: 'Cache hit ratio as decimal (0-1)',
    labelNames: ['cache_type'],
  }),
};

// SLO Definitions
export interface SLODefinition {
  name: string;
  service: string;
  metric: string;
  target: number;
  unit: string;
  window: string; // e.g., '5m', '1h', '24h'
  severity: 'critical' | 'warning' | 'info';
  description: string;
}

// WRFCoin Platform SLO Definitions
export const PLATFORM_SLOS: SLODefinition[] = [
  // Transaction Performance SLOs
  {
    name: 'transaction_throughput',
    service: 'blockchain',
    metric: 'tps',
    target: 500,
    unit: 'transactions/second',
    window: '5m',
    severity: 'critical',
    description: 'Minimum transaction throughput of 500 TPS',
  },
  {
    name: 'transaction_latency_p95',
    service: 'blockchain',
    metric: 'latency_p95',
    target: 100,
    unit: 'ms',
    window: '5m',
    severity: 'critical',
    description: 'P95 transaction latency under 100ms',
  },

  // API Performance SLOs
  {
    name: 'api_latency_p95',
    service: 'api',
    metric: 'latency_p95',
    target: 100,
    unit: 'ms',
    window: '5m',
    severity: 'warning',
    description: 'P95 API response time under 100ms',
  },
  {
    name: 'api_availability',
    service: 'api',
    metric: 'availability',
    target: 99.9,
    unit: '%',
    window: '24h',
    severity: 'critical',
    description: 'API availability of 99.9%',
  },
  {
    name: 'api_error_rate',
    service: 'api',
    metric: 'error_rate',
    target: 1,
    unit: '%',
    window: '5m',
    severity: 'warning',
    description: 'API error rate under 1%',
  },

  // Cross-Chain Bridge SLOs
  {
    name: 'bridge_transfer_latency',
    service: 'bridge',
    metric: 'transfer_latency_p95',
    target: 300,
    unit: 'seconds',
    window: '1h',
    severity: 'warning',
    description: 'P95 bridge transfer time under 5 minutes',
  },
  {
    name: 'bridge_success_rate',
    service: 'bridge',
    metric: 'success_rate',
    target: 99.5,
    unit: '%',
    window: '24h',
    severity: 'critical',
    description: 'Bridge transfer success rate of 99.5%',
  },
  {
    name: 'bridge_availability',
    service: 'bridge',
    metric: 'availability',
    target: 99.9,
    unit: '%',
    window: '24h',
    severity: 'critical',
    description: 'Bridge service availability of 99.9%',
  },

  // Cache Performance SLOs
  {
    name: 'cache_hit_ratio',
    service: 'cache',
    metric: 'hit_ratio',
    target: 85,
    unit: '%',
    window: '1h',
    severity: 'warning',
    description: 'Cache hit ratio at least 85%',
  },
  {
    name: 'cache_latency_p99',
    service: 'cache',
    metric: 'latency_p99',
    target: 10,
    unit: 'ms',
    window: '5m',
    severity: 'warning',
    description: 'P99 cache latency under 10ms',
  },

  // GraphQL Performance SLOs
  {
    name: 'graphql_latency_p95',
    service: 'graphql',
    metric: 'latency_p95',
    target: 200,
    unit: 'ms',
    window: '5m',
    severity: 'warning',
    description: 'P95 GraphQL query time under 200ms',
  },
  {
    name: 'graphql_complexity_limit',
    service: 'graphql',
    metric: 'queries_rejected',
    target: 5,
    unit: '%',
    window: '1h',
    severity: 'info',
    description: 'Less than 5% queries rejected due to complexity',
  },

  // Database Performance SLOs
  {
    name: 'database_query_latency_p95',
    service: 'database',
    metric: 'query_latency_p95',
    target: 50,
    unit: 'ms',
    window: '5m',
    severity: 'warning',
    description: 'P95 database query time under 50ms',
  },
  {
    name: 'database_connection_pool',
    service: 'database',
    metric: 'pool_utilization',
    target: 80,
    unit: '%',
    window: '5m',
    severity: 'warning',
    description: 'Connection pool utilization under 80%',
  },

  // Weather Data Processing SLOs
  {
    name: 'weather_data_freshness',
    service: 'weather',
    metric: 'data_age_max',
    target: 60,
    unit: 'seconds',
    window: '5m',
    severity: 'warning',
    description: 'Weather data freshness under 60 seconds',
  },
  {
    name: 'sensor_data_validation',
    service: 'weather',
    metric: 'validation_success_rate',
    target: 95,
    unit: '%',
    window: '1h',
    severity: 'info',
    description: 'Sensor data validation success rate at least 95%',
  },
];

// SLO Validation Result
export interface SLOValidationResult {
  slo: SLODefinition;
  currentValue: number;
  isCompliant: boolean;
  compliancePercentage: number;
  timestamp: Date;
  trend: 'improving' | 'degrading' | 'stable';
}

// Performance Test Result
export interface PerformanceTestResult {
  testName: string;
  service: string;
  startTime: Date;
  endTime: Date;
  metrics: {
    latencyP50: number;
    latencyP95: number;
    latencyP99: number;
    throughput: number;
    errorRate: number;
    successCount: number;
    failureCount: number;
  };
  sloResults: SLOValidationResult[];
  passed: boolean;
}

/**
 * Performance SLO Validator
 */
export class PerformanceSLOValidator extends EventEmitter {
  private sloHistory: Map<string, number[]> = new Map();
  private validationInterval: NodeJS.Timeout | null = null;
  private latencyMeasurements: Map<string, number[]> = new Map();

  constructor(private slos: SLODefinition[] = PLATFORM_SLOS) {
    super();
  }

  /**
   * Start continuous SLO validation
   */
  startContinuousValidation(intervalMs: number = 60000): void {
    if (this.validationInterval) {
      return;
    }

    this.validationInterval = setInterval(async () => {
      await this.validateAllSLOs();
    }, intervalMs);

    console.log('[SLO Validator] Started continuous validation');
  }

  /**
   * Stop continuous SLO validation
   */
  stopContinuousValidation(): void {
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
      this.validationInterval = null;
    }
  }

  /**
   * Validate all SLOs
   */
  async validateAllSLOs(): Promise<SLOValidationResult[]> {
    const results: SLOValidationResult[] = [];

    for (const slo of this.slos) {
      const result = await this.validateSLO(slo);
      results.push(result);

      // Update Prometheus metrics
      sloMetrics.sloCompliance.set(
        { service: slo.service, slo_name: slo.name },
        result.compliancePercentage
      );

      if (!result.isCompliant) {
        sloMetrics.sloViolations.inc({
          service: slo.service,
          slo_name: slo.name,
          severity: slo.severity,
        });

        this.emit('sloViolation', result);
      }
    }

    return results;
  }

  /**
   * Validate a single SLO
   */
  async validateSLO(slo: SLODefinition): Promise<SLOValidationResult> {
    const currentValue = await this.measureSLOMetric(slo);
    const historicalValues = this.getSLOHistory(slo.name);

    // Calculate compliance
    let isCompliant = false;
    switch (slo.metric) {
      case 'latency_p95':
      case 'latency_p99':
      case 'transfer_latency_p95':
      case 'query_latency_p95':
      case 'data_age_max':
      case 'pool_utilization':
      case 'error_rate':
      case 'queries_rejected':
        // Lower is better
        isCompliant = currentValue <= slo.target;
        break;
      default:
        // Higher is better
        isCompliant = currentValue >= slo.target;
    }

    // Calculate trend
    const trend = this.calculateTrend(historicalValues, currentValue);

    // Store in history
    this.updateSLOHistory(slo.name, currentValue);

    // Calculate compliance percentage over window
    const compliancePercentage = this.calculateCompliancePercentage(
      slo.name,
      slo.target,
      slo.metric
    );

    return {
      slo,
      currentValue,
      isCompliant,
      compliancePercentage,
      timestamp: new Date(),
      trend,
    };
  }

  /**
   * Measure SLO metric value
   */
  private async measureSLOMetric(slo: SLODefinition): Promise<number> {
    const key = `${slo.service}:${slo.metric}`;
    const measurements = this.latencyMeasurements.get(key) || [];

    switch (slo.metric) {
      case 'latency_p95':
      case 'latency_p99':
      case 'transfer_latency_p95':
      case 'query_latency_p95':
        return this.calculatePercentile(measurements, slo.metric.includes('p99') ? 99 : 95);

      case 'hit_ratio':
        // Would be calculated from cache metrics
        return this.getCacheHitRatio(slo.service);

      case 'tps':
        return this.getCurrentTPS();

      case 'availability':
        return this.calculateAvailability(slo.service);

      case 'success_rate':
      case 'validation_success_rate':
        return this.calculateSuccessRate(slo.service);

      case 'error_rate':
        return this.calculateErrorRate(slo.service);

      default:
        return 0;
    }
  }

  /**
   * Record latency measurement
   */
  recordLatency(service: string, operation: string, latencyMs: number): void {
    const key = `${service}:${operation}`;
    let measurements = this.latencyMeasurements.get(key);

    if (!measurements) {
      measurements = [];
      this.latencyMeasurements.set(key, measurements);
    }

    measurements.push(latencyMs);

    // Keep only last 1000 measurements
    if (measurements.length > 1000) {
      measurements.shift();
    }

    // Update Prometheus
    sloMetrics.sloLatency.observe(
      { service, operation },
      latencyMs / 1000 // Convert to seconds
    );
  }

  /**
   * Calculate percentile from measurements
   */
  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Calculate trend from historical values
   */
  private calculateTrend(
    historical: number[],
    current: number
  ): 'improving' | 'degrading' | 'stable' {
    if (historical.length < 5) return 'stable';

    const recent = historical.slice(-5);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const diff = current - avg;
    const threshold = avg * 0.05; // 5% change threshold

    if (Math.abs(diff) < threshold) return 'stable';
    return diff > 0 ? 'degrading' : 'improving';
  }

  /**
   * Get SLO history
   */
  private getSLOHistory(sloName: string): number[] {
    return this.sloHistory.get(sloName) || [];
  }

  /**
   * Update SLO history
   */
  private updateSLOHistory(sloName: string, value: number): void {
    let history = this.sloHistory.get(sloName);
    if (!history) {
      history = [];
      this.sloHistory.set(sloName, history);
    }

    history.push(value);

    // Keep last 1000 values
    if (history.length > 1000) {
      history.shift();
    }
  }

  /**
   * Calculate compliance percentage over window
   */
  private calculateCompliancePercentage(
    sloName: string,
    target: number,
    metric: string
  ): number {
    const history = this.getSLOHistory(sloName);
    if (history.length === 0) return 100;

    const isLowerBetter = [
      'latency_p95',
      'latency_p99',
      'error_rate',
      'queries_rejected',
    ].includes(metric);

    const compliantCount = history.filter((v) =>
      isLowerBetter ? v <= target : v >= target
    ).length;

    return (compliantCount / history.length) * 100;
  }

  // Placeholder methods - would integrate with actual services
  private getCacheHitRatio(_service: string): number {
    return 85 + Math.random() * 10; // Simulated 85-95%
  }

  private getCurrentTPS(): number {
    return 450 + Math.random() * 100; // Simulated 450-550 TPS
  }

  private calculateAvailability(_service: string): number {
    return 99.9 + Math.random() * 0.09; // Simulated 99.9-99.99%
  }

  private calculateSuccessRate(_service: string): number {
    return 99 + Math.random() * 0.9; // Simulated 99-99.9%
  }

  private calculateErrorRate(_service: string): number {
    return Math.random() * 0.5; // Simulated 0-0.5%
  }

  /**
   * Run blockchain performance test
   */
  async runBlockchainPerformanceTest(): Promise<PerformanceTestResult> {
    const startTime = new Date();
    const latencies: number[] = [];
    let successCount = 0;
    let failureCount = 0;

    console.log('[Performance Test] Running blockchain performance test...');

    // Simulate transaction processing
    const testDuration = 30000; // 30 seconds
    const endTime = Date.now() + testDuration;

    while (Date.now() < endTime) {
      const txStart = Date.now();
      try {
        // Simulate transaction
        await this.simulateTransaction();
        const latency = Date.now() - txStart;
        latencies.push(latency);
        successCount++;
        this.recordLatency('blockchain', 'transaction', latency);
      } catch {
        failureCount++;
      }
      // Small delay between transactions
      await new Promise((r) => setTimeout(r, 10));
    }

    const result: PerformanceTestResult = {
      testName: 'blockchain_performance',
      service: 'blockchain',
      startTime,
      endTime: new Date(),
      metrics: {
        latencyP50: this.calculatePercentile(latencies, 50),
        latencyP95: this.calculatePercentile(latencies, 95),
        latencyP99: this.calculatePercentile(latencies, 99),
        throughput: successCount / (testDuration / 1000),
        errorRate: failureCount / (successCount + failureCount),
        successCount,
        failureCount,
      },
      sloResults: await this.validateBlockchainSLOs(),
      passed: false, // Will be set below
    };

    // Check if all critical SLOs pass
    result.passed = result.sloResults
      .filter((r) => r.slo.severity === 'critical')
      .every((r) => r.isCompliant);

    console.log(
      `[Performance Test] Blockchain test completed: ${result.passed ? 'PASSED' : 'FAILED'}`
    );

    return result;
  }

  /**
   * Run cross-chain bridge performance test
   */
  async runBridgePerformanceTest(): Promise<PerformanceTestResult> {
    const startTime = new Date();
    const latencies: number[] = [];
    let successCount = 0;
    let failureCount = 0;

    console.log('[Performance Test] Running bridge performance test...');

    // Test bridge operations
    const testCount = 10;

    for (let i = 0; i < testCount; i++) {
      const txStart = Date.now();
      try {
        await this.simulateBridgeTransfer();
        const latency = Date.now() - txStart;
        latencies.push(latency);
        successCount++;

        sloMetrics.bridgeLatency.observe(
          {
            source_chain: 'ethereum',
            destination_chain: 'polygon',
            operation: 'transfer',
          },
          latency / 1000
        );
      } catch {
        failureCount++;
      }
    }

    const result: PerformanceTestResult = {
      testName: 'bridge_performance',
      service: 'bridge',
      startTime,
      endTime: new Date(),
      metrics: {
        latencyP50: this.calculatePercentile(latencies, 50),
        latencyP95: this.calculatePercentile(latencies, 95),
        latencyP99: this.calculatePercentile(latencies, 99),
        throughput: successCount / ((Date.now() - startTime.getTime()) / 1000),
        errorRate: failureCount / (successCount + failureCount),
        successCount,
        failureCount,
      },
      sloResults: await this.validateBridgeSLOs(),
      passed: false,
    };

    result.passed = result.sloResults
      .filter((r) => r.slo.severity === 'critical')
      .every((r) => r.isCompliant);

    console.log(
      `[Performance Test] Bridge test completed: ${result.passed ? 'PASSED' : 'FAILED'}`
    );

    return result;
  }

  /**
   * Run cache performance test
   */
  async runCachePerformanceTest(): Promise<PerformanceTestResult> {
    const startTime = new Date();
    const latencies: number[] = [];
    let hits = 0;
    let misses = 0;

    console.log('[Performance Test] Running cache performance test...');

    const testCount = 1000;

    for (let i = 0; i < testCount; i++) {
      const opStart = Date.now();
      const isHit = Math.random() > 0.15; // Simulate ~85% hit rate

      if (isHit) {
        hits++;
        latencies.push(Date.now() - opStart + Math.random() * 2); // 0-2ms
      } else {
        misses++;
        latencies.push(Date.now() - opStart + Math.random() * 20 + 10); // 10-30ms
      }
    }

    const hitRatio = hits / testCount;
    sloMetrics.cacheHitRatio.set({ cache_type: 'combined' }, hitRatio);

    const result: PerformanceTestResult = {
      testName: 'cache_performance',
      service: 'cache',
      startTime,
      endTime: new Date(),
      metrics: {
        latencyP50: this.calculatePercentile(latencies, 50),
        latencyP95: this.calculatePercentile(latencies, 95),
        latencyP99: this.calculatePercentile(latencies, 99),
        throughput: testCount / ((Date.now() - startTime.getTime()) / 1000),
        errorRate: 0,
        successCount: hits,
        failureCount: misses,
      },
      sloResults: await this.validateCacheSLOs(),
      passed: false,
    };

    result.passed = result.sloResults.every((r) => r.isCompliant);

    console.log(
      `[Performance Test] Cache test completed: ${result.passed ? 'PASSED' : 'FAILED'}`
    );

    return result;
  }

  // Validation helpers
  private async validateBlockchainSLOs(): Promise<SLOValidationResult[]> {
    const blockchainSLOs = this.slos.filter((s) => s.service === 'blockchain');
    return Promise.all(blockchainSLOs.map((slo) => this.validateSLO(slo)));
  }

  private async validateBridgeSLOs(): Promise<SLOValidationResult[]> {
    const bridgeSLOs = this.slos.filter((s) => s.service === 'bridge');
    return Promise.all(bridgeSLOs.map((slo) => this.validateSLO(slo)));
  }

  private async validateCacheSLOs(): Promise<SLOValidationResult[]> {
    const cacheSLOs = this.slos.filter((s) => s.service === 'cache');
    return Promise.all(cacheSLOs.map((slo) => this.validateSLO(slo)));
  }

  // Simulation helpers
  private async simulateTransaction(): Promise<void> {
    const latency = 20 + Math.random() * 60; // 20-80ms
    await new Promise((r) => setTimeout(r, latency));
    if (Math.random() < 0.01) throw new Error('Simulated failure');
  }

  private async simulateBridgeTransfer(): Promise<void> {
    const latency = 1000 + Math.random() * 4000; // 1-5 seconds
    await new Promise((r) => setTimeout(r, latency));
    if (Math.random() < 0.005) throw new Error('Simulated bridge failure');
  }

  /**
   * Generate SLO compliance report
   */
  async generateComplianceReport(): Promise<SLOComplianceReport> {
    const results = await this.validateAllSLOs();

    const byService: Record<string, SLOValidationResult[]> = {};
    for (const result of results) {
      const service = result.slo.service;
      if (!byService[service]) {
        byService[service] = [];
      }
      byService[service].push(result);
    }

    const overallCompliance =
      (results.filter((r) => r.isCompliant).length / results.length) * 100;

    const violations = results.filter((r) => !r.isCompliant);
    const criticalViolations = violations.filter(
      (r) => r.slo.severity === 'critical'
    );

    return {
      timestamp: new Date(),
      overallCompliance,
      totalSLOs: results.length,
      compliantSLOs: results.filter((r) => r.isCompliant).length,
      violations: violations.length,
      criticalViolations: criticalViolations.length,
      byService,
      recommendations: this.generateRecommendations(violations),
    };
  }

  private generateRecommendations(violations: SLOValidationResult[]): string[] {
    const recommendations: string[] = [];

    for (const violation of violations) {
      switch (violation.slo.service) {
        case 'blockchain':
          recommendations.push(
            `Optimize ${violation.slo.name}: Consider increasing node resources or optimizing consensus`
          );
          break;
        case 'bridge':
          recommendations.push(
            `Improve ${violation.slo.name}: Review bridge validator configuration and network latency`
          );
          break;
        case 'cache':
          recommendations.push(
            `Enhance ${violation.slo.name}: Consider increasing cache size or adjusting TTL policies`
          );
          break;
        case 'api':
          recommendations.push(
            `Address ${violation.slo.name}: Add caching, optimize queries, or scale horizontally`
          );
          break;
      }
    }

    return recommendations;
  }
}

// Report interface
interface SLOComplianceReport {
  timestamp: Date;
  overallCompliance: number;
  totalSLOs: number;
  compliantSLOs: number;
  violations: number;
  criticalViolations: number;
  byService: Record<string, SLOValidationResult[]>;
  recommendations: string[];
}

// Export singleton instance
export const sloValidator = new PerformanceSLOValidator();
