/**
 * Load Testing Framework for Wrfcoin Core
 * Comprehensive performance testing and stress analysis
 */

const EventEmitter = require('events');

class LoadTestingFramework extends EventEmitter {
  constructor(options = {}) {
    super();

    this.config = {
      maxConcurrentUsers: options.maxConcurrentUsers || 1000,
      testDuration: options.testDuration || 60000, // 60 seconds
      rampUpTime: options.rampUpTime || 10000, // 10 seconds
      thinkTime: options.thinkTime || 1000, // 1 second between requests
      timeoutThreshold: options.timeoutThreshold || 30000,
      errorThreshold: options.errorThreshold || 0.05, // 5% error rate
      responseTimeThreshold: options.responseTimeThreshold || 2000,
      ...options,
    };

    this.testResults = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      timeoutRequests: 0,
      responseTimes: [],
      errorRates: [],
      throughput: [],
      systemMetrics: [],
    };

    this.activeUsers = 0;
    this.isRunning = false;
    this.startTime = null;
  }

  // Execute comprehensive load test
  async executeLoadTest(testConfig) {
    this.isRunning = true;
    this.startTime = Date.now();

    const results = {
      testId: this.generateTestId(),
      config: { ...this.config, ...testConfig },
      phases: [],
      summary: {},
      recommendations: [],
    };

    try {
      this.emit('test:started', {
        testId: results.testId,
        config: results.config,
      });

      // Phase 1: Baseline Performance Test
      const baselineResults = await this.runBaselineTest();
      results.phases.push({
        name: 'baseline',
        ...baselineResults,
      });

      // Phase 2: Gradual Load Increase
      const rampUpResults = await this.runRampUpTest();
      results.phases.push({
        name: 'ramp_up',
        ...rampUpResults,
      });

      // Phase 3: Sustained Load Test
      const sustainedResults = await this.runSustainedLoadTest();
      results.phases.push({
        name: 'sustained',
        ...sustainedResults,
      });

      // Phase 4: Spike Test
      const spikeResults = await this.runSpikeTest();
      results.phases.push({
        name: 'spike',
        ...spikeResults,
      });

      // Phase 5: Stress Test
      const stressResults = await this.runStressTest();
      results.phases.push({
        name: 'stress',
        ...stressResults,
      });

      // Generate comprehensive summary
      results.summary = this.generateTestSummary(results.phases);
      results.recommendations = this.generateRecommendations(results);

      this.emit('test:completed', results);
      return results;
    } catch (error) {
      this.emit('test:error', { error: error.message, testId: results.testId });
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  // Phase 1: Baseline Performance Test
  async runBaselineTest() {
    const results = {
      phase: 'baseline',
      duration: 30000, // 30 seconds
      users: 10,
      metrics: {},
    };

    this.emit('phase:started', { phase: 'baseline' });

    const startTime = Date.now();
    const requests = [];

    // Simulate 10 concurrent users for 30 seconds
    for (let i = 0; i < 10; i++) {
      requests.push(this.simulateUserSession(30000));
    }

    const userResults = await Promise.all(requests);
    results.metrics = this.aggregateMetrics(userResults);
    results.duration = Date.now() - startTime;

    this.emit('phase:completed', { phase: 'baseline', results });
    return results;
  }

  // Phase 2: Gradual Load Increase
  async runRampUpTest() {
    const results = {
      phase: 'ramp_up',
      duration: 60000, // 60 seconds
      maxUsers: 100,
      metrics: {},
    };

    this.emit('phase:started', { phase: 'ramp_up' });

    const startTime = Date.now();
    const requests = [];
    const rampUpInterval = 600; // Add user every 600ms

    // Gradually increase users from 1 to 100 over 60 seconds
    for (let i = 0; i < 100; i++) {
      setTimeout(() => {
        requests.push(this.simulateUserSession(60000 - i * rampUpInterval));
      }, i * rampUpInterval);
    }

    // Wait for ramp-up completion
    await new Promise(resolve => setTimeout(resolve, 60000));

    const userResults = await Promise.all(requests);
    results.metrics = this.aggregateMetrics(userResults);
    results.duration = Date.now() - startTime;

    this.emit('phase:completed', { phase: 'ramp_up', results });
    return results;
  }

  // Phase 3: Sustained Load Test
  async runSustainedLoadTest() {
    const results = {
      phase: 'sustained',
      duration: 120000, // 2 minutes
      users: 200,
      metrics: {},
    };

    this.emit('phase:started', { phase: 'sustained' });

    const startTime = Date.now();
    const requests = [];

    // Maintain 200 concurrent users for 2 minutes
    for (let i = 0; i < 200; i++) {
      requests.push(this.simulateUserSession(120000));
    }

    const userResults = await Promise.all(requests);
    results.metrics = this.aggregateMetrics(userResults);
    results.duration = Date.now() - startTime;

    this.emit('phase:completed', { phase: 'sustained', results });
    return results;
  }

  // Phase 4: Spike Test
  async runSpikeTest() {
    const results = {
      phase: 'spike',
      duration: 90000, // 1.5 minutes
      users: 500,
      metrics: {},
    };

    this.emit('phase:started', { phase: 'spike' });

    const startTime = Date.now();
    const requests = [];

    // Sudden spike to 500 users
    for (let i = 0; i < 500; i++) {
      requests.push(this.simulateUserSession(90000));
    }

    const userResults = await Promise.all(requests);
    results.metrics = this.aggregateMetrics(userResults);
    results.duration = Date.now() - startTime;

    this.emit('phase:completed', { phase: 'spike', results });
    return results;
  }

  // Phase 5: Stress Test
  async runStressTest() {
    const results = {
      phase: 'stress',
      duration: 180000, // 3 minutes
      users: 1000,
      metrics: {},
    };

    this.emit('phase:started', { phase: 'stress' });

    const startTime = Date.now();
    const requests = [];

    // Maximum load: 1000 concurrent users
    for (let i = 0; i < 1000; i++) {
      requests.push(this.simulateUserSession(180000));
    }

    const userResults = await Promise.all(requests);
    results.metrics = this.aggregateMetrics(userResults);
    results.duration = Date.now() - startTime;

    this.emit('phase:completed', { phase: 'stress', results });
    return results;
  }

  // Simulate individual user session
  async simulateUserSession(duration) {
    const sessionResults = {
      requests: 0,
      successful: 0,
      failed: 0,
      timeouts: 0,
      responseTimes: [],
      errors: [],
    };

    const endTime = Date.now() + duration;

    while (Date.now() < endTime && this.isRunning) {
      try {
        const requestResult = await this.simulateRequest();
        sessionResults.requests++;

        if (requestResult.success) {
          sessionResults.successful++;
          sessionResults.responseTimes.push(requestResult.responseTime);
        } else if (requestResult.timeout) {
          sessionResults.timeouts++;
        } else {
          sessionResults.failed++;
          sessionResults.errors.push(requestResult.error);
        }

        // Think time between requests
        await new Promise(resolve =>
          setTimeout(resolve, this.config.thinkTime)
        );
      } catch (error) {
        sessionResults.failed++;
        sessionResults.errors.push(error.message);
      }
    }

    return sessionResults;
  }

  // Simulate individual HTTP request
  async simulateRequest() {
    const startTime = Date.now();

    return new Promise(resolve => {
      // Simulate network latency and processing time
      const processingTime = this.generateRealisticResponseTime();

      setTimeout(() => {
        const responseTime = Date.now() - startTime;

        // Simulate various outcomes based on load
        const outcome = this.determineRequestOutcome(responseTime);

        resolve({
          success: outcome === 'success',
          timeout: outcome === 'timeout',
          error: outcome === 'error' ? 'Server Error' : null,
          responseTime,
          timestamp: Date.now(),
        });
      }, processingTime);
    });
  }

  // Generate realistic response times based on system load
  generateRealisticResponseTime() {
    const baseTime = 100; // Base response time in ms
    const loadFactor = Math.min(this.activeUsers / 100, 5); // Load multiplier
    const randomVariation = Math.random() * 200; // Random variation

    return Math.floor(baseTime + baseTime * loadFactor + randomVariation);
  }

  // Determine request outcome based on response time and system state
  determineRequestOutcome(responseTime) {
    // Simulate increasing error rates under high load
    const errorProbability = Math.min((this.activeUsers / 1000) * 0.1, 0.2);
    const timeoutProbability =
      responseTime > this.config.timeoutThreshold ? 0.3 : 0.01;

    const random = Math.random();

    if (random < timeoutProbability) {
      return 'timeout';
    } else if (random < errorProbability + timeoutProbability) {
      return 'error';
    }

    return 'success';
  }

  // Aggregate metrics from multiple user sessions
  aggregateMetrics(userResults) {
    const aggregated = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      timeoutRequests: 0,
      responseTimes: [],
      errorRate: 0,
      throughput: 0,
      averageResponseTime: 0,
      p95ResponseTime: 0,
      p99ResponseTime: 0,
    };

    // Combine all user session results
    for (const session of userResults) {
      aggregated.totalRequests += session.requests;
      aggregated.successfulRequests += session.successful;
      aggregated.failedRequests += session.failed;
      aggregated.timeoutRequests += session.timeouts;
      aggregated.responseTimes.push(...session.responseTimes);
    }

    // Calculate derived metrics
    aggregated.errorRate =
      aggregated.totalRequests > 0
        ? (aggregated.failedRequests + aggregated.timeoutRequests) /
          aggregated.totalRequests
        : 0;

    if (aggregated.responseTimes.length > 0) {
      aggregated.responseTimes.sort((a, b) => a - b);
      aggregated.averageResponseTime =
        aggregated.responseTimes.reduce((sum, time) => sum + time, 0) /
        aggregated.responseTimes.length;
      aggregated.p95ResponseTime = this.calculatePercentile(
        aggregated.responseTimes,
        95
      );
      aggregated.p99ResponseTime = this.calculatePercentile(
        aggregated.responseTimes,
        99
      );
    }

    return aggregated;
  }

  // Calculate percentile value
  calculatePercentile(sortedArray, percentile) {
    if (sortedArray.length === 0) return 0;

    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, Math.min(index, sortedArray.length - 1))];
  }

  // Generate comprehensive test summary
  generateTestSummary(phases) {
    const summary = {
      overallPerformance: 'good',
      totalRequests: 0,
      totalSuccessful: 0,
      totalFailed: 0,
      overallErrorRate: 0,
      bestPhase: null,
      worstPhase: null,
      performanceGrade: 'A',
    };

    let bestErrorRate = 1;
    let worstErrorRate = 0;

    for (const phase of phases) {
      summary.totalRequests += phase.metrics.totalRequests || 0;
      summary.totalSuccessful += phase.metrics.successfulRequests || 0;
      summary.totalFailed += phase.metrics.failedRequests || 0;

      const errorRate = phase.metrics.errorRate || 0;

      if (errorRate < bestErrorRate) {
        bestErrorRate = errorRate;
        summary.bestPhase = phase.phase;
      }

      if (errorRate > worstErrorRate) {
        worstErrorRate = errorRate;
        summary.worstPhase = phase.phase;
      }
    }

    summary.overallErrorRate =
      summary.totalRequests > 0
        ? summary.totalFailed / summary.totalRequests
        : 0;

    // Determine performance grade
    if (summary.overallErrorRate < 0.01) {
      summary.performanceGrade = 'A+';
      summary.overallPerformance = 'excellent';
    } else if (summary.overallErrorRate < 0.05) {
      summary.performanceGrade = 'A';
      summary.overallPerformance = 'good';
    } else if (summary.overallErrorRate < 0.1) {
      summary.performanceGrade = 'B';
      summary.overallPerformance = 'acceptable';
    } else {
      summary.performanceGrade = 'C';
      summary.overallPerformance = 'needs_improvement';
    }

    return summary;
  }

  // Generate performance recommendations
  generateRecommendations(testResults) {
    const recommendations = [];
    const summary = testResults.summary;

    if (summary.overallErrorRate > 0.05) {
      recommendations.push({
        priority: 'high',
        category: 'reliability',
        issue: 'High error rate detected',
        recommendation: 'Investigate server stability and error handling',
        impact: 'critical',
      });
    }

    // Check for performance degradation in stress phases
    const stressPhase = testResults.phases.find(p => p.phase === 'stress');
    if (
      stressPhase &&
      stressPhase.metrics.averageResponseTime >
        this.config.responseTimeThreshold
    ) {
      recommendations.push({
        priority: 'medium',
        category: 'performance',
        issue: 'Slow response times under high load',
        recommendation: 'Consider scaling infrastructure or optimizing code',
        impact: 'moderate',
      });
    }

    // Check spike test results
    const spikePhase = testResults.phases.find(p => p.phase === 'spike');
    if (spikePhase && spikePhase.metrics.errorRate > 0.1) {
      recommendations.push({
        priority: 'medium',
        category: 'scalability',
        issue: 'Poor handling of traffic spikes',
        recommendation: 'Implement auto-scaling or load balancing',
        impact: 'moderate',
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        priority: 'low',
        category: 'optimization',
        issue: 'System performing well',
        recommendation: 'Monitor for continuous improvement opportunities',
        impact: 'low',
      });
    }

    return recommendations;
  }

  // Generate unique test ID
  generateTestId() {
    return `load_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Get current test status
  getTestStatus() {
    return {
      isRunning: this.isRunning,
      activeUsers: this.activeUsers,
      startTime: this.startTime,
      currentDuration: this.startTime ? Date.now() - this.startTime : 0,
      testResults: this.testResults,
    };
  }

  // Stop running test
  stopTest() {
    this.isRunning = false;
    this.emit('test:stopped', { timestamp: new Date().toISOString() });
  }

  // Quick performance check
  async quickPerformanceCheck() {
    const startTime = Date.now();
    const results = {
      testType: 'quick_check',
      duration: 10000, // 10 seconds
      users: 50,
      passed: false,
      metrics: {},
    };

    this.emit('quick_test:started');

    const requests = [];
    for (let i = 0; i < 50; i++) {
      requests.push(this.simulateUserSession(10000));
    }

    const userResults = await Promise.all(requests);
    results.metrics = this.aggregateMetrics(userResults);
    results.duration = Date.now() - startTime;

    // Determine if quick test passed
    results.passed =
      results.metrics.errorRate < 0.05 &&
      results.metrics.averageResponseTime < 2000;

    this.emit('quick_test:completed', results);
    return results;
  }
}

module.exports = LoadTestingFramework;
