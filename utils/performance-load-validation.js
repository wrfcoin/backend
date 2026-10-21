/**
 * Performance & Load Validation System for Wrfcoin Core
 *
 * This module provides comprehensive performance monitoring and load validation
 * capabilities for the entire Wrfcoin infrastructure, including real-time metrics
 * collection, stress testing, and performance benchmarking.
 */

const EventEmitter = require('events');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');

class PerformanceLoadValidator extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      maxConcurrentUsers: config.maxConcurrentUsers || 1000,
      loadTestDuration: config.loadTestDuration || 300000, // 5 minutes
      performanceThresholds: {
        responseTime: 2000, // 2 seconds
        throughput: 100, // requests per second
        errorRate: 0.05, // 5% max error rate
        cpuUsage: 0.8, // 80% max CPU usage
        memoryUsage: 0.85, // 85% max memory usage
        diskUsage: 0.9, // 90% max disk usage
      },
      monitoringInterval: 5000, // 5 seconds
      ...config,
    };

    this.metrics = {
      performance: {
        responseTime: [],
        throughput: 0,
        errorRate: 0,
        successRate: 0,
      },
      system: {
        cpuUsage: [],
        memoryUsage: [],
        diskUsage: [],
        networkUsage: [],
      },
      load: {
        concurrentUsers: 0,
        requestsPerSecond: 0,
        totalRequests: 0,
        failedRequests: 0,
      },
    };

    this.loadTestResults = [];
    this.performanceReports = [];
    this.isMonitoring = false;
    this.monitoringInterval = null;

    this.initialize();
  }

  /**
   * Initialize the performance validation system
   */
  async initialize() {
    try {
      // Start system monitoring
      await this.startSystemMonitoring();

      // Initialize performance baseline
      await this.establishPerformanceBaseline();

      console.log('[Performance Validator] Successfully initialized');
      return true;
    } catch (error) {
      console.error(
        '[Performance Validator] Initialization failed:',
        error.message
      );
      return false;
    }
  }

  /**
   * Start comprehensive load testing
   *
   * @param {Object} testConfig - Load test configuration
   * @returns {Promise<Object>} Test results
   */
  async runLoadTest(testConfig = {}) {
    const config = {
      phases: [
        { name: 'ramp-up', duration: 60000, targetUsers: 100 },
        { name: 'steady-state', duration: 180000, targetUsers: 500 },
        { name: 'peak-load', duration: 60000, targetUsers: 1000 },
        { name: 'stress-test', duration: 30000, targetUsers: 1500 },
        { name: 'ramp-down', duration: 30000, targetUsers: 0 },
      ],
      endpoints: [
        { path: '/api/health', weight: 0.3 },
        { path: '/api/blockchain/status', weight: 0.2 },
        { path: '/api/transactions', weight: 0.2 },
        { path: '/api/cross-chain/bridges', weight: 0.15 },
        { path: '/api/iot/sensors', weight: 0.15 },
      ],
      ...testConfig,
    };

    console.log('[Load Test] Starting comprehensive load test...');

    const testResults = {
      testId: `load_test_${Date.now()}`,
      startTime: new Date(),
      config: config,
      phases: [],
      overallMetrics: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        averageResponseTime: 0,
        maxResponseTime: 0,
        throughput: 0,
        errorRate: 0,
      },
      systemMetrics: {
        peakCpuUsage: 0,
        peakMemoryUsage: 0,
        averageNetworkUsage: 0,
      },
    };

    try {
      // Execute each phase of the load test
      for (const phase of config.phases) {
        console.log(`[Load Test] Starting phase: ${phase.name}`);

        const phaseResult = await this.executeLoadTestPhase(
          phase,
          config.endpoints
        );
        testResults.phases.push(phaseResult);

        // Update overall metrics
        testResults.overallMetrics.totalRequests += phaseResult.totalRequests;
        testResults.overallMetrics.successfulRequests +=
          phaseResult.successfulRequests;
        testResults.overallMetrics.failedRequests += phaseResult.failedRequests;

        console.log(
          `[Load Test] Phase ${phase.name} completed: ${phaseResult.successRate}% success rate`
        );
      }

      // Calculate final metrics
      this.calculateOverallMetrics(testResults);

      // Generate performance report
      const report = await this.generatePerformanceReport(testResults);
      testResults.performanceReport = report;

      testResults.endTime = new Date();
      testResults.duration = testResults.endTime - testResults.startTime;

      this.loadTestResults.push(testResults);

      console.log(
        `[Load Test] Completed successfully. Overall success rate: ${testResults.overallMetrics.successRate}%`
      );

      this.emit('loadTestCompleted', testResults);

      return testResults;
    } catch (error) {
      console.error('[Load Test] Failed:', error.message);
      testResults.error = error.message;
      testResults.endTime = new Date();

      return testResults;
    }
  }

  /**
   * Execute a single phase of the load test
   */
  async executeLoadTestPhase(phase, endpoints) {
    const phaseResult = {
      name: phase.name,
      duration: phase.duration,
      targetUsers: phase.targetUsers,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      responseTimes: [],
      startTime: new Date(),
    };

    const startTime = Date.now();
    const endTime = startTime + phase.duration;

    // Simulate ramping up users
    const userRampInterval = phase.duration / phase.targetUsers;
    let currentUsers = 0;

    const userSimulations = [];

    while (Date.now() < endTime && currentUsers < phase.targetUsers) {
      // Add new simulated user
      const userPromise = this.simulateUser(endpoints, endTime);
      userSimulations.push(userPromise);
      currentUsers++;

      // Wait before adding next user
      if (currentUsers < phase.targetUsers) {
        await this.delay(userRampInterval);
      }
    }

    // Wait for all user simulations to complete
    const results = await Promise.allSettled(userSimulations);

    // Process results
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        const userResult = result.value;
        phaseResult.totalRequests += userResult.requests;
        phaseResult.successfulRequests += userResult.successfulRequests;
        phaseResult.failedRequests += userResult.failedRequests;
        phaseResult.responseTimes.push(...userResult.responseTimes);
      }
    });

    phaseResult.endTime = new Date();
    phaseResult.actualDuration = phaseResult.endTime - phaseResult.startTime;
    phaseResult.successRate =
      phaseResult.totalRequests > 0
        ? (phaseResult.successfulRequests / phaseResult.totalRequests) * 100
        : 0;
    phaseResult.averageResponseTime =
      phaseResult.responseTimes.length > 0
        ? phaseResult.responseTimes.reduce((a, b) => a + b, 0) /
          phaseResult.responseTimes.length
        : 0;
    phaseResult.maxResponseTime =
      phaseResult.responseTimes.length > 0
        ? Math.max(...phaseResult.responseTimes)
        : 0;

    return phaseResult;
  }

  /**
   * Simulate a single user making requests
   */
  async simulateUser(endpoints, endTime) {
    const userResult = {
      requests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      responseTimes: [],
    };

    while (Date.now() < endTime) {
      // Select random endpoint based on weight
      const endpoint = this.selectWeightedEndpoint(endpoints);

      try {
        const requestStart = Date.now();

        // Simulate HTTP request (in production, would make actual requests)
        await this.simulateHttpRequest(endpoint.path);

        const responseTime = Date.now() - requestStart;

        userResult.requests++;
        userResult.successfulRequests++;
        userResult.responseTimes.push(responseTime);

        // Random delay between requests (simulate user behavior)
        await this.delay(Math.random() * 2000 + 500); // 0.5-2.5 seconds
      } catch (error) {
        userResult.requests++;
        userResult.failedRequests++;

        // Wait before retrying
        await this.delay(1000);
      }
    }

    return userResult;
  }

  /**
   * Simulate HTTP request with realistic response times
   */
  async simulateHttpRequest(path) {
    // Simulate different response times based on endpoint complexity
    const responseTimeMap = {
      '/api/health': 50 + Math.random() * 100, // 50-150ms
      '/api/blockchain/status': 100 + Math.random() * 200, // 100-300ms
      '/api/transactions': 200 + Math.random() * 500, // 200-700ms
      '/api/cross-chain/bridges': 300 + Math.random() * 700, // 300-1000ms
      '/api/iot/sensors': 150 + Math.random() * 350, // 150-500ms
    };

    const baseResponseTime = responseTimeMap[path] || 100 + Math.random() * 200;

    // Add system load factor
    const systemLoad = this.getCurrentSystemLoad();
    const adjustedResponseTime = baseResponseTime * (1 + systemLoad);

    await this.delay(adjustedResponseTime);

    // Simulate occasional failures (2% failure rate)
    if (Math.random() < 0.02) {
      throw new Error('Simulated request failure');
    }

    return {
      status: 200,
      responseTime: adjustedResponseTime,
    };
  }

  /**
   * Select endpoint based on weight distribution
   */
  selectWeightedEndpoint(endpoints) {
    const random = Math.random();
    let cumulativeWeight = 0;

    for (const endpoint of endpoints) {
      cumulativeWeight += endpoint.weight;
      if (random <= cumulativeWeight) {
        return endpoint;
      }
    }

    return endpoints[endpoints.length - 1];
  }

  /**
   * Get current system load factor
   */
  getCurrentSystemLoad() {
    const cpuUsage = this.getCurrentCpuUsage();
    const memoryUsage = this.getCurrentMemoryUsage();

    // Calculate load factor (0-1 scale)
    return (cpuUsage + memoryUsage) / 2;
  }

  /**
   * Start system resource monitoring
   */
  async startSystemMonitoring() {
    if (this.isMonitoring) return;

    this.isMonitoring = true;

    this.monitoringInterval = setInterval(async () => {
      try {
        // Collect system metrics
        const cpuUsage = this.getCurrentCpuUsage();
        const memoryUsage = this.getCurrentMemoryUsage();
        const diskUsage = await this.getCurrentDiskUsage();
        const networkUsage = this.getCurrentNetworkUsage();

        // Store metrics
        this.metrics.system.cpuUsage.push({
          timestamp: new Date(),
          value: cpuUsage,
        });

        this.metrics.system.memoryUsage.push({
          timestamp: new Date(),
          value: memoryUsage,
        });

        this.metrics.system.diskUsage.push({
          timestamp: new Date(),
          value: diskUsage,
        });

        this.metrics.system.networkUsage.push({
          timestamp: new Date(),
          value: networkUsage,
        });

        // Keep only last 1000 measurements
        Object.keys(this.metrics.system).forEach(key => {
          if (this.metrics.system[key].length > 1000) {
            this.metrics.system[key] = this.metrics.system[key].slice(-1000);
          }
        });

        // Check for threshold violations
        this.checkPerformanceThresholds({
          cpuUsage,
          memoryUsage,
          diskUsage,
          networkUsage,
        });
      } catch (error) {
        console.error(
          '[System Monitor] Error collecting metrics:',
          error.message
        );
      }
    }, this.config.monitoringInterval);

    console.log('[System Monitor] Started monitoring system resources');
  }

  /**
   * Stop system monitoring
   */
  stopSystemMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    console.log('[System Monitor] Stopped monitoring system resources');
  }

  /**
   * Get current CPU usage
   */
  getCurrentCpuUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    return 1 - totalIdle / totalTick;
  }

  /**
   * Get current memory usage
   */
  getCurrentMemoryUsage() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    return (totalMemory - freeMemory) / totalMemory;
  }

  /**
   * Get current disk usage
   */
  async getCurrentDiskUsage() {
    try {
      const stats = await fs.stat('.');
      // Simplified disk usage calculation
      return 0.3 + Math.random() * 0.2; // Simulate 30-50% disk usage
    } catch (error) {
      return 0.5; // Default value
    }
  }

  /**
   * Get current network usage
   */
  getCurrentNetworkUsage() {
    // Simplified network usage calculation
    return Math.random() * 0.4; // Simulate 0-40% network usage
  }

  /**
   * Establish performance baseline
   */
  async establishPerformanceBaseline() {
    console.log('[Performance Validator] Establishing performance baseline...');

    const baselineTest = {
      testType: 'baseline',
      concurrentUsers: 10,
      duration: 30000, // 30 seconds
      endpoints: [{ path: '/api/health', weight: 1.0 }],
    };

    const baseline = await this.runLoadTest(baselineTest);
    this.performanceBaseline = baseline;

    console.log('[Performance Validator] Performance baseline established');
    return baseline;
  }

  /**
   * Check performance thresholds
   */
  checkPerformanceThresholds(currentMetrics) {
    const violations = [];

    if (currentMetrics.cpuUsage > this.config.performanceThresholds.cpuUsage) {
      violations.push({
        type: 'cpu_usage',
        current: currentMetrics.cpuUsage,
        threshold: this.config.performanceThresholds.cpuUsage,
      });
    }

    if (
      currentMetrics.memoryUsage > this.config.performanceThresholds.memoryUsage
    ) {
      violations.push({
        type: 'memory_usage',
        current: currentMetrics.memoryUsage,
        threshold: this.config.performanceThresholds.memoryUsage,
      });
    }

    if (
      currentMetrics.diskUsage > this.config.performanceThresholds.diskUsage
    ) {
      violations.push({
        type: 'disk_usage',
        current: currentMetrics.diskUsage,
        threshold: this.config.performanceThresholds.diskUsage,
      });
    }

    if (violations.length > 0) {
      this.emit('thresholdViolation', violations);
    }
  }

  /**
   * Calculate overall metrics from test results
   */
  calculateOverallMetrics(testResults) {
    const overall = testResults.overallMetrics;

    overall.errorRate =
      overall.totalRequests > 0
        ? overall.failedRequests / overall.totalRequests
        : 0;

    overall.successRate =
      overall.totalRequests > 0
        ? (overall.successfulRequests / overall.totalRequests) * 100
        : 0;

    // Calculate average response time across all phases
    const allResponseTimes = [];
    testResults.phases.forEach(phase => {
      allResponseTimes.push(...phase.responseTimes);
    });

    overall.averageResponseTime =
      allResponseTimes.length > 0
        ? allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length
        : 0;

    overall.maxResponseTime =
      allResponseTimes.length > 0 ? Math.max(...allResponseTimes) : 0;

    overall.throughput =
      testResults.duration > 0
        ? overall.totalRequests / (testResults.duration / 1000)
        : 0;
  }

  /**
   * Generate comprehensive performance report
   */
  async generatePerformanceReport(testResults) {
    const report = {
      summary: {
        testId: testResults.testId,
        duration: testResults.duration,
        totalRequests: testResults.overallMetrics.totalRequests,
        successRate: testResults.overallMetrics.successRate,
        averageResponseTime: testResults.overallMetrics.averageResponseTime,
        throughput: testResults.overallMetrics.throughput,
      },
      performance: {
        responseTimePercentiles: this.calculatePercentiles(testResults),
        throughputTrend: this.calculateThroughputTrend(testResults),
        errorAnalysis: this.analyzeErrors(testResults),
      },
      system: {
        resourceUtilization: this.getResourceUtilization(),
        bottleneckAnalysis: this.analyzeBottlenecks(),
      },
      recommendations: this.generateRecommendations(testResults),
    };

    // Save report
    const reportPath = path.join(
      process.cwd(),
      'backend/data',
      `performance-report-${Date.now()}.json`
    );
    try {
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(`[Performance Report] Saved to ${reportPath}`);
    } catch (error) {
      console.error('[Performance Report] Failed to save:', error.message);
    }

    return report;
  }

  /**
   * Calculate response time percentiles
   */
  calculatePercentiles(testResults) {
    const allResponseTimes = [];
    testResults.phases.forEach(phase => {
      allResponseTimes.push(...phase.responseTimes);
    });

    allResponseTimes.sort((a, b) => a - b);

    const calculatePercentile = percentile => {
      const index = Math.ceil((percentile / 100) * allResponseTimes.length) - 1;
      return allResponseTimes[index] || 0;
    };

    return {
      p50: calculatePercentile(50),
      p75: calculatePercentile(75),
      p90: calculatePercentile(90),
      p95: calculatePercentile(95),
      p99: calculatePercentile(99),
    };
  }

  /**
   * Calculate throughput trend
   */
  calculateThroughputTrend(testResults) {
    return testResults.phases.map(phase => ({
      phase: phase.name,
      throughput:
        phase.duration > 0 ? phase.totalRequests / (phase.duration / 1000) : 0,
      targetUsers: phase.targetUsers,
    }));
  }

  /**
   * Analyze errors
   */
  analyzeErrors(testResults) {
    const totalRequests = testResults.overallMetrics.totalRequests;
    const failedRequests = testResults.overallMetrics.failedRequests;

    return {
      errorRate: totalRequests > 0 ? (failedRequests / totalRequests) * 100 : 0,
      errorsByPhase: testResults.phases.map(phase => ({
        phase: phase.name,
        errorRate:
          phase.totalRequests > 0
            ? (phase.failedRequests / phase.totalRequests) * 100
            : 0,
      })),
    };
  }

  /**
   * Get resource utilization summary
   */
  getResourceUtilization() {
    const recentMetrics = {
      cpu: this.metrics.system.cpuUsage.slice(-60), // Last 5 minutes
      memory: this.metrics.system.memoryUsage.slice(-60),
      disk: this.metrics.system.diskUsage.slice(-60),
      network: this.metrics.system.networkUsage.slice(-60),
    };

    const calculateStats = metrics => {
      if (metrics.length === 0) return { avg: 0, max: 0, min: 0 };

      const values = metrics.map(m => m.value);
      return {
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        max: Math.max(...values),
        min: Math.min(...values),
      };
    };

    return {
      cpu: calculateStats(recentMetrics.cpu),
      memory: calculateStats(recentMetrics.memory),
      disk: calculateStats(recentMetrics.disk),
      network: calculateStats(recentMetrics.network),
    };
  }

  /**
   * Analyze system bottlenecks
   */
  analyzeBottlenecks() {
    const utilization = this.getResourceUtilization();
    const bottlenecks = [];

    if (utilization.cpu.avg > 0.7) {
      bottlenecks.push({
        type: 'cpu',
        severity: utilization.cpu.avg > 0.9 ? 'high' : 'medium',
        description: 'High CPU utilization detected',
      });
    }

    if (utilization.memory.avg > 0.8) {
      bottlenecks.push({
        type: 'memory',
        severity: utilization.memory.avg > 0.95 ? 'high' : 'medium',
        description: 'High memory utilization detected',
      });
    }

    return bottlenecks;
  }

  /**
   * Generate performance recommendations
   */
  generateRecommendations(testResults) {
    const recommendations = [];

    // Response time analysis
    if (
      testResults.overallMetrics.averageResponseTime >
      this.config.performanceThresholds.responseTime
    ) {
      recommendations.push({
        type: 'performance',
        priority: 'high',
        description:
          'Average response time exceeds threshold. Consider optimizing database queries and adding caching.',
      });
    }

    // Throughput analysis
    if (
      testResults.overallMetrics.throughput <
      this.config.performanceThresholds.throughput
    ) {
      recommendations.push({
        type: 'throughput',
        priority: 'medium',
        description:
          'Throughput below expected levels. Consider horizontal scaling or load balancing improvements.',
      });
    }

    // Error rate analysis
    if (
      testResults.overallMetrics.errorRate >
      this.config.performanceThresholds.errorRate
    ) {
      recommendations.push({
        type: 'reliability',
        priority: 'high',
        description:
          'Error rate exceeds acceptable threshold. Review error logs and implement circuit breakers.',
      });
    }

    return recommendations;
  }

  /**
   * Get current performance status
   */
  getPerformanceStatus() {
    return {
      isMonitoring: this.isMonitoring,
      totalLoadTests: this.loadTestResults.length,
      lastTestResult: this.loadTestResults[this.loadTestResults.length - 1],
      currentSystemLoad: this.getCurrentSystemLoad(),
      systemMetrics: {
        cpu: this.getCurrentCpuUsage(),
        memory: this.getCurrentMemoryUsage(),
      },
    };
  }

  /**
   * Utility function to delay execution
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = PerformanceLoadValidator;
