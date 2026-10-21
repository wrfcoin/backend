/**
 * Comprehensive Resilience Testing Scenarios
 * Tests circuit breakers, retries, fallbacks, and recovery mechanisms
 */

const axios = require('axios');

// Test configuration
const TEST_CONFIG = {
  apiGateway: 'http://localhost:4000',
  nftService: 'http://localhost:4002',
  userService: 'http://localhost:4003',
  timeout: 10000,
  retryDelay: 1000,
};

class ResilienceTestSuite {
  constructor() {
    this.results = {
      passed: 0,
      failed: 0,
      tests: [],
    };
  }

  async log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : '📝';
    console.log(`${prefix} [${timestamp}] ${message}`);
  }

  async test(name, testFn) {
    this.log(`Running test: ${name}`);
    try {
      const startTime = Date.now();
      const result = await testFn();
      const duration = Date.now() - startTime;

      this.results.passed++;
      this.results.tests.push({
        name,
        status: 'passed',
        duration,
        result,
      });

      this.log(`✅ ${name} - PASSED (${duration}ms)`, 'success');
      return result;
    } catch (error) {
      this.results.failed++;
      this.results.tests.push({
        name,
        status: 'failed',
        error: error.message,
      });

      this.log(`❌ ${name} - FAILED: ${error.message}`, 'error');
      throw error;
    }
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async makeRequest(url, options = {}) {
    try {
      const response = await axios({
        method: 'GET',
        timeout: TEST_CONFIG.timeout,
        ...options,
        url,
      });
      return response;
    } catch (error) {
      if (error.response) {
        return error.response;
      }
      throw error;
    }
  }

  // Test 1: Basic Health Checks
  async testHealthChecks() {
    await this.test('API Gateway Health Check', async () => {
      const response = await this.makeRequest(
        `${TEST_CONFIG.apiGateway}/health`
      );
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      return {
        status: response.status,
        healthy: response.data.data.status === 'healthy',
      };
    });

    await this.test('NFT Service Health Check', async () => {
      const response = await this.makeRequest(
        `${TEST_CONFIG.nftService}/health`
      );
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      return { status: response.status, service: response.data.service };
    });

    await this.test('User Service Health Check', async () => {
      const response = await this.makeRequest(
        `${TEST_CONFIG.userService}/health`
      );
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      return { status: response.status, service: response.data.service };
    });
  }

  // Test 2: Resilience Metrics
  async testResilienceMetrics() {
    await this.test('API Gateway Resilience Metrics', async () => {
      const response = await this.makeRequest(
        `${TEST_CONFIG.apiGateway}/resilience/metrics`
      );
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }

      const metrics = response.data;
      const hasServices = Object.keys(metrics.services || {}).length > 0;
      return {
        hasMetrics: hasServices,
        services: Object.keys(metrics.services || {}),
      };
    });

    await this.test('NFT Service Resilience Metrics', async () => {
      const response = await this.makeRequest(
        `${TEST_CONFIG.nftService}/resilience/metrics`
      );
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      return { status: response.status, timestamp: response.data.timestamp };
    });
  }

  // Test 3: NFT Service API with Resilience
  async testNFTServiceResilience() {
    await this.test('Get All NFTs with Resilience', async () => {
      const response = await this.makeRequest(
        `${TEST_CONFIG.apiGateway}/api/nft/marketplace`
      );

      // Should work even if degraded
      if (response.status !== 200 && response.status !== 206) {
        throw new Error(
          `Expected 200 or 206 (degraded), got ${response.status}`
        );
      }

      const data = response.data;
      const isDegraded = data._resilience && data._resilience.degraded;

      return {
        status: response.status,
        degraded: isDegraded,
        hasData: !!data.data,
        nftCount: data.data?.totalNFTs || 0,
      };
    });

    await this.test('Get NFT List with Pagination', async () => {
      const response = await this.makeRequest(
        `${TEST_CONFIG.apiGateway}/api/nft/nfts?page=1&limit=5`
      );

      if (response.status !== 200 && response.status !== 206) {
        throw new Error(
          `Expected 200 or 206 (degraded), got ${response.status}`
        );
      }

      const data = response.data;
      return {
        status: response.status,
        hasNFTs: Array.isArray(data.data?.nfts),
        nftCount: data.data?.nfts?.length || 0,
        degraded: data._resilience?.degraded || false,
      };
    });
  }

  // Test 4: Circuit Breaker Simulation
  async testCircuitBreakerBehavior() {
    await this.test('Circuit Breaker - Normal Operation', async () => {
      // Make several successful requests
      const requests = [];
      for (let i = 0; i < 5; i++) {
        requests.push(this.makeRequest(`${TEST_CONFIG.nftService}/health`));
      }

      const responses = await Promise.all(requests);
      const allSuccessful = responses.every(r => r.status === 200);

      if (!allSuccessful) {
        throw new Error('Not all requests were successful');
      }

      return { requestCount: 5, allSuccessful };
    });

    // Note: Testing actual circuit breaker opening would require
    // deliberately failing services, which is complex in this environment
    await this.test('Circuit Breaker - Status Check', async () => {
      const response = await this.makeRequest(
        `${TEST_CONFIG.apiGateway}/resilience/metrics`
      );

      if (response.status !== 200) {
        throw new Error(`Failed to get metrics: ${response.status}`);
      }

      const metrics = response.data.services || {};
      const circuitStates = Object.values(metrics)
        .map(m => m?.circuit?.state)
        .filter(Boolean);

      return {
        servicesWithCircuits: circuitStates.length,
        openCircuits: circuitStates.filter(state => state === 'OPEN').length,
        closedCircuits: circuitStates.filter(state => state === 'CLOSED')
          .length,
      };
    });
  }

  // Test 5: Fallback Mechanisms
  async testFallbackMechanisms() {
    await this.test('Fallback Response Handling', async () => {
      // Test how services handle degraded responses
      const response = await this.makeRequest(
        `${TEST_CONFIG.apiGateway}/api/nft/marketplace`
      );

      // Should always return a response, even if degraded
      if (!response.data) {
        throw new Error('No response data received');
      }

      const data = response.data;
      const hasData = !!(data.data || data.success);
      const isDegraded = !!(data._resilience?.degraded || data.degraded);

      return {
        hasData,
        isDegraded,
        statusCode: response.status,
        responseTime: response.headers['x-resilience-response-time'],
      };
    });
  }

  // Test 6: Error Handling
  async testErrorHandling() {
    await this.test('404 Handling', async () => {
      const response = await this.makeRequest(
        `${TEST_CONFIG.apiGateway}/api/nonexistent-endpoint`
      );

      if (response.status !== 404) {
        throw new Error(`Expected 404, got ${response.status}`);
      }

      return {
        status: response.status,
        hasErrorMessage: !!response.data?.error,
      };
    });

    await this.test('Invalid NFT ID Handling', async () => {
      const response = await this.makeRequest(
        `${TEST_CONFIG.apiGateway}/api/nft/nfts/invalid-id-12345`
      );

      // Should handle gracefully, either 404 or 200 with null data
      const isValidResponse =
        response.status === 404 ||
        (response.status === 200 && response.data?.data === null);

      if (!isValidResponse) {
        throw new Error(`Unexpected response: ${response.status}`);
      }

      return { status: response.status, handledGracefully: true };
    });
  }

  // Test 7: Performance Under Load
  async testPerformanceResilience() {
    await this.test('Concurrent Requests Handling', async () => {
      const concurrentRequests = 10;
      const requests = [];

      // Make concurrent requests to test resilience under load
      for (let i = 0; i < concurrentRequests; i++) {
        requests.push(this.makeRequest(`${TEST_CONFIG.nftService}/health`));
      }

      const startTime = Date.now();
      const responses = await Promise.all(requests);
      const totalTime = Date.now() - startTime;

      const successfulRequests = responses.filter(r => r.status === 200).length;
      const avgResponseTime = totalTime / concurrentRequests;

      return {
        totalRequests: concurrentRequests,
        successfulRequests,
        successRate: (successfulRequests / concurrentRequests) * 100,
        avgResponseTime,
        totalTime,
      };
    });
  }

  async runAllTests() {
    this.log('🚀 Starting Comprehensive Resilience Test Suite...');

    try {
      await this.testHealthChecks();
      await this.sleep(1000);

      await this.testResilienceMetrics();
      await this.sleep(1000);

      await this.testNFTServiceResilience();
      await this.sleep(1000);

      await this.testCircuitBreakerBehavior();
      await this.sleep(1000);

      await this.testFallbackMechanisms();
      await this.sleep(1000);

      await this.testErrorHandling();
      await this.sleep(1000);

      await this.testPerformanceResilience();
    } catch (error) {
      this.log(`Test suite encountered error: ${error.message}`, 'error');
    }

    this.printSummary();
  }

  printSummary() {
    this.log('📊 Test Summary:');
    console.log(`✅ Passed: ${this.results.passed}`);
    console.log(`❌ Failed: ${this.results.failed}`);
    console.log(
      `📈 Success Rate: ${((this.results.passed / (this.results.passed + this.results.failed)) * 100).toFixed(1)}%`
    );

    if (this.results.failed > 0) {
      this.log('Failed Tests:', 'error');
      this.results.tests
        .filter(t => t.status === 'failed')
        .forEach(t => console.log(`  - ${t.name}: ${t.error}`));
    }

    this.log('🎉 Resilience testing complete!');
  }
}

// Run the test suite
if (require.main === module) {
  const testSuite = new ResilienceTestSuite();
  testSuite.runAllTests().catch(console.error);
}

module.exports = ResilienceTestSuite;
