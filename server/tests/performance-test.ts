import axios from 'axios';
import { performance } from 'perf_hooks';

interface TestResult {
  endpoint: string;
  method: string;
  avgResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  successRate: number;
  cacheHitRate: number;
  totalRequests: number;
  requestsPerSecond: number;
}

interface LoadTestConfig {
  baseUrl: string;
  concurrency: number;
  duration: number; // in seconds
  endpoints: Array<{
    path: string;
    method: 'GET' | 'POST';
    weight: number; // probability weight
    body?: any;
  }>;
}

class PerformanceTester {
  private config: LoadTestConfig;
  private results: Map<string, TestResult> = new Map();
  private isRunning = false;

  constructor(config: LoadTestConfig) {
    this.config = config;
  }

  async runLoadTest(): Promise<Map<string, TestResult>> {
    console.log('Starting load test...');
    console.log(`Base URL: ${this.config.baseUrl}`);
    console.log(`Concurrency: ${this.config.concurrency}`);
    console.log(`Duration: ${this.config.duration}s`);
    console.log(`Endpoints: ${this.config.endpoints.length}`);

    this.isRunning = true;
    const startTime = performance.now();
    const endTime = startTime + this.config.duration * 1000;

    // Initialize results
    this.config.endpoints.forEach(endpoint => {
      const key = `${endpoint.method} ${endpoint.path}`;
      this.results.set(key, {
        endpoint: endpoint.path,
        method: endpoint.method,
        avgResponseTime: 0,
        minResponseTime: Infinity,
        maxResponseTime: 0,
        successRate: 0,
        cacheHitRate: 0,
        totalRequests: 0,
        requestsPerSecond: 0,
      });
    });

    // Start concurrent workers
    const workers = Array.from({ length: this.config.concurrency }, () =>
      this.worker(endTime)
    );

    await Promise.all(workers);

    this.isRunning = false;
    const totalDuration = (performance.now() - startTime) / 1000;

    // Calculate final metrics
    this.results.forEach((result, key) => {
      if (result.totalRequests > 0) {
        result.requestsPerSecond = result.totalRequests / totalDuration;
      }
    });

    return this.results;
  }

  private async worker(endTime: number): Promise<void> {
    const responseTimes: Map<string, number[]> = new Map();
    const successCounts: Map<string, number> = new Map();
    const cacheHits: Map<string, number> = new Map();
    const totalRequests: Map<string, number> = new Map();

    // Initialize tracking maps
    this.config.endpoints.forEach(endpoint => {
      const key = `${endpoint.method} ${endpoint.path}`;
      responseTimes.set(key, []);
      successCounts.set(key, 0);
      cacheHits.set(key, 0);
      totalRequests.set(key, 0);
    });

    while (performance.now() < endTime && this.isRunning) {
      try {
        // Select random endpoint based on weights
        const endpoint = this.selectRandomEndpoint();
        const key = `${endpoint.method} ${endpoint.path}`;

        const requestStart = performance.now();

        try {
          const response = await axios({
            method: endpoint.method,
            url: `${this.config.baseUrl}${endpoint.path}`,
            data: endpoint.body,
            timeout: 10000, // 10 second timeout
          });

          const responseTime = performance.now() - requestStart;

          // Track metrics
          responseTimes.get(key)?.push(responseTime);

          if (response.status >= 200 && response.status < 300) {
            successCounts.set(key, (successCounts.get(key) || 0) + 1);
          }

          // Check for cache hit
          if (response.headers['x-cache'] === 'HIT') {
            cacheHits.set(key, (cacheHits.get(key) || 0) + 1);
          }

          totalRequests.set(key, (totalRequests.get(key) || 0) + 1);
        } catch (error) {
          const responseTime = performance.now() - requestStart;
          responseTimes.get(key)?.push(responseTime);
          totalRequests.set(key, (totalRequests.get(key) || 0) + 1);
        }

        // Small delay to prevent overwhelming
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch (error) {
        console.error('Worker error:', error);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Update results
    this.config.endpoints.forEach(endpoint => {
      const key = `${endpoint.method} ${endpoint.path}`;
      const times = responseTimes.get(key) || [];
      const successes = successCounts.get(key) || 0;
      const hits = cacheHits.get(key) || 0;
      const total = totalRequests.get(key) || 0;

      if (times.length > 0) {
        const result = this.results.get(key)!;
        result.avgResponseTime =
          times.reduce((a, b) => a + b, 0) / times.length;
        result.minResponseTime = Math.min(result.minResponseTime, ...times);
        result.maxResponseTime = Math.max(result.maxResponseTime, ...times);
        result.totalRequests += total;
        result.successRate = total > 0 ? successes / total : 0;
        result.cacheHitRate = total > 0 ? hits / total : 0;
      }
    });
  }

  private selectRandomEndpoint() {
    const totalWeight = this.config.endpoints.reduce(
      (sum, ep) => sum + ep.weight,
      0
    );
    let random = Math.random() * totalWeight;

    for (const endpoint of this.config.endpoints) {
      random -= endpoint.weight;
      if (random <= 0) {
        return endpoint;
      }
    }

    return this.config.endpoints[0]; // fallback
  }

  printResults(): void {
    console.log('\n=== PERFORMANCE TEST RESULTS ===\n');

    let totalRequests = 0;
    let totalResponseTime = 0;

    this.results.forEach((result, key) => {
      if (result.totalRequests > 0) {
        console.log(`${key}:`);
        console.log(`  Total Requests: ${result.totalRequests}`);
        console.log(
          `  Avg Response Time: ${result.avgResponseTime.toFixed(2)}ms`
        );
        console.log(
          `  Min Response Time: ${result.minResponseTime.toFixed(2)}ms`
        );
        console.log(
          `  Max Response Time: ${result.maxResponseTime.toFixed(2)}ms`
        );
        console.log(
          `  Success Rate: ${(result.successRate * 100).toFixed(2)}%`
        );
        console.log(
          `  Cache Hit Rate: ${(result.cacheHitRate * 100).toFixed(2)}%`
        );
        console.log(`  Requests/sec: ${result.requestsPerSecond.toFixed(2)}`);
        console.log('');

        totalRequests += result.totalRequests;
        totalResponseTime += result.avgResponseTime;
      }
    });

    const avgResponseTime = totalResponseTime / this.results.size;
    console.log('=== SUMMARY ===');
    console.log(`Total Requests: ${totalRequests}`);
    console.log(`Average Response Time: ${avgResponseTime.toFixed(2)}ms`);
    console.log(
      `Target < 100ms: ${avgResponseTime < 100 ? '✅ PASS' : '❌ FAIL'}`
    );
  }

  async testCachePerformance(): Promise<void> {
    console.log('\n=== CACHE PERFORMANCE TEST ===\n');

    const endpoint = '/api/stats';
    const url = `${this.config.baseUrl}${endpoint}`;

    console.log('Testing cache miss (first request)...');
    const firstStart = performance.now();
    const firstResponse = await axios.get(url);
    const firstTime = performance.now() - firstStart;
    console.log(
      `First request: ${firstTime.toFixed(2)}ms (Cache: ${firstResponse.headers['x-cache'] || 'MISS'})`
    );

    console.log('Testing cache hit (second request)...');
    const secondStart = performance.now();
    const secondResponse = await axios.get(url);
    const secondTime = performance.now() - secondStart;
    console.log(
      `Second request: ${secondTime.toFixed(2)}ms (Cache: ${secondResponse.headers['x-cache'] || 'MISS'})`
    );

    const speedup = ((firstTime - secondTime) / firstTime) * 100;
    console.log(`Cache speedup: ${speedup.toFixed(2)}%`);

    if (speedup > 50) {
      console.log('✅ Cache is providing significant performance improvement');
    } else {
      console.log('❌ Cache performance improvement is minimal');
    }
  }

  async getSystemMetrics(): Promise<any> {
    try {
      const response = await axios.get(
        `${this.config.baseUrl}/api/performance/metrics`
      );
      return response.data;
    } catch (error) {
      console.error('Failed to get system metrics:', error);
      return null;
    }
  }

  async getHealthStatus(): Promise<any> {
    try {
      const response = await axios.get(`${this.config.baseUrl}/api/health`);
      return response.data;
    } catch (error) {
      console.error('Failed to get health status:', error);
      return null;
    }
  }
}

// Main test execution
async function runPerformanceTest() {
  const config: LoadTestConfig = {
    baseUrl: 'http://localhost:3001',
    concurrency: 10,
    duration: 60, // 1 minute test
    endpoints: [
      { path: '/api/stats', method: 'GET', weight: 30 },
      { path: '/api/blockchain/status', method: 'GET', weight: 25 },
      { path: '/api/mining/stats', method: 'GET', weight: 20 },
      { path: '/api/nft/marketplace', method: 'GET', weight: 15 },
      { path: '/api/security/metrics', method: 'GET', weight: 10 },
      { path: '/api/currency/rates', method: 'GET', weight: 10 },
      {
        path: '/api/currency/convert?from=WRF&to=USD&amount=100',
        method: 'GET',
        weight: 5,
      },
    ],
  };

  const tester = new PerformanceTester(config);

  try {
    console.log('Checking server health...');
    const health = await tester.getHealthStatus();
    if (health) {
      console.log('Server health:', health.data);
    }

    // Test cache performance
    await tester.testCachePerformance();

    // Run load test
    console.log('\nStarting load test...');
    await tester.runLoadTest();

    // Print results
    tester.printResults();

    // Get final metrics
    console.log('\n=== FINAL SYSTEM METRICS ===');
    const metrics = await tester.getSystemMetrics();
    if (metrics) {
      console.log(JSON.stringify(metrics.data, null, 2));
    }
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}

// Run the test if this file is executed directly
if (require.main === module) {
  runPerformanceTest()
    .then(() => {
      console.log('\nPerformance test completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('Performance test failed:', error);
      process.exit(1);
    });
}

export { PerformanceTester, LoadTestConfig, TestResult };
