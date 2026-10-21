/**
 * Test Automation Framework for Task 67 Integration Tests
 * Provides test orchestration, parallel execution, and reporting
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { performance } = require('perf_hooks');

class TestAutomation {
  constructor(config = {}) {
    this.config = {
      testTimeout: 120000, // 2 minutes
      maxConcurrency: 4,
      retryAttempts: 2,
      outputDir: './test-results',
      coverageThreshold: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
      ...config,
    };

    this.testSuites = [
      {
        name: 'comprehensive',
        file: 'task67-comprehensive.integration.test.js',
        timeout: 180000,
        priority: 1,
      },
      {
        name: 'service-communication',
        file: 'service-communication.integration.test.js',
        timeout: 120000,
        priority: 2,
      },
      {
        name: 'performance-validation',
        file: 'performance-validation.integration.test.js',
        timeout: 300000,
        priority: 3,
      },
      {
        name: 'security-integration',
        file: 'security-integration.test.js',
        timeout: 150000,
        priority: 4,
      },
    ];

    this.results = {
      suites: [],
      summary: {},
      coverage: {},
      performance: {},
    };
  }

  async runAllTests() {
    console.log('🚀 Starting Task 67 Integration Test Automation');
    console.log(`Configuration: ${JSON.stringify(this.config, null, 2)}`);

    const startTime = performance.now();

    try {
      // Setup test environment
      await this.setupTestEnvironment();

      // Run test suites
      await this.executeTestSuites();

      // Generate reports
      await this.generateReports();

      const duration = performance.now() - startTime;
      this.results.summary.totalDuration = duration;

      console.log('✅ All integration tests completed');
      console.log(`Total duration: ${(duration / 1000).toFixed(2)}s`);

      return this.results;
    } catch (error) {
      console.error('❌ Test automation failed:', error);
      throw error;
    } finally {
      await this.cleanupTestEnvironment();
    }
  }

  async setupTestEnvironment() {
    console.log('🔧 Setting up test environment...');

    // Create output directory
    await fs.mkdir(this.config.outputDir, { recursive: true });

    // Check dependencies
    await this.checkDependencies();

    // Setup test database
    await this.setupTestDatabase();

    // Setup mock services
    await this.setupMockServices();

    console.log('✅ Test environment ready');
  }

  async checkDependencies() {
    const requiredServices = [
      { name: 'PostgreSQL', check: () => this.checkPostgreSQL() },
      { name: 'Redis', check: () => this.checkRedis() },
      { name: 'Node.js', check: () => this.checkNodeJS() },
    ];

    for (const service of requiredServices) {
      try {
        await service.check();
        console.log(`✅ ${service.name} is available`);
      } catch (error) {
        console.warn(`⚠️  ${service.name} check failed:`, error.message);
      }
    }
  }

  async checkPostgreSQL() {
    const { Pool } = require('pg');
    const db = new Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ||
        'postgresql://localhost:5432/wrfcoin_test',
      max: 1,
      connectionTimeoutMillis: 5000,
    });

    try {
      await db.query('SELECT 1');
      await db.end();
    } catch (error) {
      throw new Error(`PostgreSQL connection failed: ${error.message}`);
    }
  }

  async checkRedis() {
    const Redis = require('ioredis');
    const redis = new Redis(
      process.env.TEST_REDIS_URL || 'redis://localhost:6379/1',
      {
        connectTimeout: 5000,
        lazyConnect: true,
      }
    );

    try {
      await redis.connect();
      await redis.ping();
      await redis.quit();
    } catch (error) {
      throw new Error(`Redis connection failed: ${error.message}`);
    }
  }

  async checkNodeJS() {
    const version = process.version;
    const majorVersion = parseInt(version.slice(1).split('.')[0]);

    if (majorVersion < 18) {
      throw new Error(
        `Node.js version ${version} is too old. Minimum required: 18.x`
      );
    }
  }

  async setupTestDatabase() {
    console.log('🗄️  Setting up test database...');

    const { Pool } = require('pg');
    const db = new Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ||
        'postgresql://localhost:5432/wrfcoin_test',
      max: 5,
    });

    try {
      // Create test tables if they don't exist
      await db.query(`
        CREATE TABLE IF NOT EXISTS test_table (
          id TEXT PRIMARY KEY,
          data TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS cache_test (
          key TEXT PRIMARY KEY,
          data TEXT,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS sync_test (
          key TEXT PRIMARY KEY,
          data TEXT,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS test_performance (
          id TEXT PRIMARY KEY,
          data TEXT,
          timestamp TIMESTAMP DEFAULT NOW()
        )
      `);

      console.log('✅ Test database schema ready');
    } finally {
      await db.end();
    }
  }

  async setupMockServices() {
    console.log('🎭 Setting up mock services...');

    // This would setup mock services for testing
    // For now, we'll just log the setup
    console.log('✅ Mock services ready');
  }

  async executeTestSuites() {
    console.log('🧪 Executing test suites...');

    // Sort test suites by priority
    const sortedSuites = [...this.testSuites].sort(
      (a, b) => a.priority - b.priority
    );

    if (this.config.maxConcurrency === 1) {
      // Sequential execution
      for (const suite of sortedSuites) {
        await this.runTestSuite(suite);
      }
    } else {
      // Parallel execution with concurrency limit
      await this.runTestSuitesParallel(sortedSuites);
    }
  }

  async runTestSuitesParallel(suites) {
    const chunks = [];
    for (let i = 0; i < suites.length; i += this.config.maxConcurrency) {
      chunks.push(suites.slice(i, i + this.config.maxConcurrency));
    }

    for (const chunk of chunks) {
      const promises = chunk.map(suite => this.runTestSuite(suite));
      await Promise.allSettled(promises);
    }
  }

  async runTestSuite(suite) {
    console.log(`🏃 Running ${suite.name} test suite...`);

    const startTime = performance.now();
    let attempt = 0;
    let lastError;

    while (attempt <= this.config.retryAttempts) {
      try {
        const result = await this.executeJestSuite(suite);

        const duration = performance.now() - startTime;
        result.duration = duration;
        result.attempts = attempt + 1;

        this.results.suites.push(result);

        console.log(
          `✅ ${suite.name} completed in ${(duration / 1000).toFixed(2)}s`
        );
        return result;
      } catch (error) {
        lastError = error;
        attempt++;

        if (attempt <= this.config.retryAttempts) {
          console.log(
            `⚠️  ${suite.name} failed (attempt ${attempt}), retrying...`
          );
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
        }
      }
    }

    // All attempts failed
    const duration = performance.now() - startTime;
    const failedResult = {
      name: suite.name,
      status: 'failed',
      error: lastError.message,
      duration,
      attempts: attempt,
    };

    this.results.suites.push(failedResult);
    console.log(`❌ ${suite.name} failed after ${attempt} attempts`);

    return failedResult;
  }

  async executeJestSuite(suite) {
    return new Promise((resolve, reject) => {
      const jestConfig = path.join(__dirname, 'jest.integration.config.js');
      const testFile = path.join(__dirname, suite.file);

      const args = [
        '--config',
        jestConfig,
        '--testPathPattern',
        testFile,
        '--verbose',
        '--forceExit',
        '--detectOpenHandles',
        '--runInBand', // Force sequential execution within each suite
      ];

      if (this.config.coverage) {
        args.push('--coverage');
        args.push(
          '--coverageDirectory',
          path.join(this.config.outputDir, 'coverage', suite.name)
        );
      }

      const jest = spawn('npx', ['jest', ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LOG_LEVEL: 'error',
        },
        timeout: suite.timeout,
      });

      let stdout = '';
      let stderr = '';

      jest.stdout.on('data', data => {
        stdout += data.toString();
      });

      jest.stderr.on('data', data => {
        stderr += data.toString();
      });

      jest.on('close', code => {
        const result = {
          name: suite.name,
          status: code === 0 ? 'passed' : 'failed',
          exitCode: code,
          stdout,
          stderr,
        };

        if (code === 0) {
          // Parse Jest output for test results
          result.testResults = this.parseJestOutput(stdout);
          resolve(result);
        } else {
          result.error = `Jest exited with code ${code}`;
          reject(new Error(result.error));
        }
      });

      jest.on('error', error => {
        reject(new Error(`Jest process error: ${error.message}`));
      });

      // Handle timeout
      setTimeout(() => {
        jest.kill('SIGKILL');
        reject(
          new Error(
            `Test suite ${suite.name} timed out after ${suite.timeout}ms`
          )
        );
      }, suite.timeout);
    });
  }

  parseJestOutput(output) {
    const results = {
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
    };

    // Parse Jest summary
    const summaryMatch = output.match(
      /Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/
    );
    if (summaryMatch) {
      results.failed = parseInt(summaryMatch[1]);
      results.passed = parseInt(summaryMatch[2]);
      results.tests = parseInt(summaryMatch[3]);
    }

    // Parse duration
    const durationMatch = output.match(/Time:\s+([\d.]+)\s*s/);
    if (durationMatch) {
      results.duration = parseFloat(durationMatch[1]) * 1000; // Convert to ms
    }

    return results;
  }

  async generateReports() {
    console.log('📊 Generating test reports...');

    await Promise.all([
      this.generateSummaryReport(),
      this.generateDetailedReport(),
      this.generateCoverageReport(),
      this.generatePerformanceReport(),
      this.generateJUnitReport(),
    ]);

    console.log('✅ Test reports generated');
  }

  async generateSummaryReport() {
    const summary = this.calculateSummary();
    this.results.summary = summary;

    const report = {
      timestamp: new Date().toISOString(),
      summary,
      suites: this.results.suites.map(suite => ({
        name: suite.name,
        status: suite.status,
        duration: suite.duration,
        tests: suite.testResults,
      })),
    };

    await fs.writeFile(
      path.join(this.config.outputDir, 'summary.json'),
      JSON.stringify(report, null, 2)
    );

    // Also create a human-readable summary
    const textSummary = this.generateTextSummary(summary);
    await fs.writeFile(
      path.join(this.config.outputDir, 'summary.txt'),
      textSummary
    );
  }

  calculateSummary() {
    const passed = this.results.suites.filter(
      s => s.status === 'passed'
    ).length;
    const failed = this.results.suites.filter(
      s => s.status === 'failed'
    ).length;
    const total = this.results.suites.length;

    const totalTests = this.results.suites.reduce(
      (sum, suite) => sum + (suite.testResults?.tests || 0),
      0
    );

    const passedTests = this.results.suites.reduce(
      (sum, suite) => sum + (suite.testResults?.passed || 0),
      0
    );

    const failedTests = this.results.suites.reduce(
      (sum, suite) => sum + (suite.testResults?.failed || 0),
      0
    );

    return {
      suites: { total, passed, failed, successRate: (passed / total) * 100 },
      tests: {
        total: totalTests,
        passed: passedTests,
        failed: failedTests,
        successRate: (passedTests / totalTests) * 100,
      },
      duration: this.results.summary.totalDuration || 0,
    };
  }

  generateTextSummary(summary) {
    return `
Task 67 Integration Tests Summary
=================================

Execution Time: ${new Date().toLocaleString()}
Total Duration: ${(summary.duration / 1000).toFixed(2)}s

Test Suites:
- Total: ${summary.suites.total}
- Passed: ${summary.suites.passed}
- Failed: ${summary.suites.failed}
- Success Rate: ${summary.suites.successRate.toFixed(2)}%

Individual Tests:
- Total: ${summary.tests.total}
- Passed: ${summary.tests.passed}
- Failed: ${summary.tests.failed}
- Success Rate: ${summary.tests.successRate.toFixed(2)}%

Suite Details:
${this.results.suites
  .map(
    suite =>
      `- ${suite.name}: ${suite.status} (${(suite.duration / 1000).toFixed(2)}s)`
  )
  .join('\n')}

${summary.suites.failed > 0 ? '❌ Some tests failed. Check detailed reports for more information.' : '✅ All tests passed!'}
    `.trim();
  }

  async generateDetailedReport() {
    const detailedReport = {
      timestamp: new Date().toISOString(),
      configuration: this.config,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        memory: process.memoryUsage(),
      },
      results: this.results,
    };

    await fs.writeFile(
      path.join(this.config.outputDir, 'detailed-report.json'),
      JSON.stringify(detailedReport, null, 2)
    );
  }

  async generateCoverageReport() {
    // Coverage reports are generated by Jest
    // We'll create a summary of coverage data
    const coverageSummary = {
      timestamp: new Date().toISOString(),
      threshold: this.config.coverageThreshold,
      message: 'Coverage reports generated by Jest in coverage/ directory',
    };

    await fs.writeFile(
      path.join(this.config.outputDir, 'coverage-summary.json'),
      JSON.stringify(coverageSummary, null, 2)
    );
  }

  async generatePerformanceReport() {
    const performanceData = this.results.suites.map(suite => ({
      suite: suite.name,
      duration: suite.duration,
      testsPerSecond: suite.testResults
        ? suite.testResults.tests / (suite.duration / 1000)
        : 0,
      status: suite.status,
    }));

    const performanceReport = {
      timestamp: new Date().toISOString(),
      totalDuration: this.results.summary.totalDuration,
      suitePerformance: performanceData,
      averageSuiteDuration:
        performanceData.reduce((sum, s) => sum + s.duration, 0) /
        performanceData.length,
    };

    await fs.writeFile(
      path.join(this.config.outputDir, 'performance-report.json'),
      JSON.stringify(performanceReport, null, 2)
    );
  }

  async generateJUnitReport() {
    // Generate JUnit XML for CI/CD integration
    const junitXml = this.generateJUnitXML();

    await fs.writeFile(path.join(this.config.outputDir, 'junit.xml'), junitXml);
  }

  generateJUnitXML() {
    const totalTests = this.results.suites.reduce(
      (sum, suite) => sum + (suite.testResults?.tests || 0),
      0
    );

    const totalFailures = this.results.suites.reduce(
      (sum, suite) => sum + (suite.testResults?.failed || 0),
      0
    );

    const totalDuration = (this.results.summary.totalDuration || 0) / 1000;

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Task67IntegrationTests" tests="${totalTests}" failures="${totalFailures}" time="${totalDuration}">
`;

    for (const suite of this.results.suites) {
      const suiteDuration = (suite.duration || 0) / 1000;
      const suiteTests = suite.testResults?.tests || 1;
      const suiteFailures =
        suite.testResults?.failed || (suite.status === 'failed' ? 1 : 0);

      xml += `  <testsuite name="${suite.name}" tests="${suiteTests}" failures="${suiteFailures}" time="${suiteDuration}">
`;

      if (suite.status === 'failed') {
        xml += `    <testcase name="${suite.name}" time="${suiteDuration}">
      <failure message="${suite.error || 'Test suite failed'}">${suite.stderr || ''}</failure>
    </testcase>
`;
      } else {
        xml += `    <testcase name="${suite.name}" time="${suiteDuration}"/>
`;
      }

      xml += '  </testsuite>\n';
    }

    xml += '</testsuites>\n';
    return xml;
  }

  async cleanupTestEnvironment() {
    console.log('🧹 Cleaning up test environment...');

    try {
      // Cleanup test data
      await this.cleanupTestData();

      // Stop mock services
      await this.stopMockServices();

      console.log('✅ Test environment cleaned up');
    } catch (error) {
      console.warn('⚠️  Cleanup warning:', error.message);
    }
  }

  async cleanupTestData() {
    const { Pool } = require('pg');
    const db = new Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ||
        'postgresql://localhost:5432/wrfcoin_test',
      max: 5,
    });

    try {
      await db.query("DELETE FROM test_table WHERE id LIKE 'test_%'");
      await db.query("DELETE FROM cache_test WHERE key LIKE 'test_%'");
      await db.query("DELETE FROM sync_test WHERE key LIKE 'test_%'");
      await db.query(
        "DELETE FROM test_performance WHERE id LIKE 'perf_test_%'"
      );
    } finally {
      await db.end();
    }
  }

  async stopMockServices() {
    // Stop any mock services that were started
    // For now, this is a placeholder
  }
}

// CLI execution
if (require.main === module) {
  const automation = new TestAutomation({
    coverage: process.argv.includes('--coverage'),
    maxConcurrency: process.env.TEST_CONCURRENCY
      ? parseInt(process.env.TEST_CONCURRENCY)
      : 2,
    outputDir: process.env.TEST_OUTPUT_DIR || './test-results',
  });

  automation
    .runAllTests()
    .then(results => {
      console.log('\n📈 Test Results Summary:');
      console.log(
        `✅ Suites passed: ${results.summary.suites.passed}/${results.summary.suites.total}`
      );
      console.log(
        `✅ Tests passed: ${results.summary.tests.passed}/${results.summary.tests.total}`
      );
      console.log(
        `⏱️  Total duration: ${(results.summary.duration / 1000).toFixed(2)}s`
      );

      if (results.summary.suites.failed > 0) {
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('❌ Test automation failed:', error);
      process.exit(1);
    });
}

module.exports = TestAutomation;
