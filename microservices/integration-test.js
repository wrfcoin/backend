#!/usr/bin/env node

/**
 * Integration Test for Microservices Architecture
 * Tests the complete flow through API Gateway to individual services
 */

const axios = require('axios');
const { spawn } = require('child_process');

// Configuration
const CONFIG = {
  apiGateway: 'http://localhost:4000',
  nftService: 'http://localhost:4002',
  userService: 'http://localhost:4003',
  timeout: 10000,
};

class IntegrationTest {
  constructor() {
    this.results = [];
    this.services = [];
  }

  async log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
  }

  async test(name, testFn) {
    try {
      await this.log(`🧪 Testing: ${name}`);
      const startTime = Date.now();
      await testFn();
      const duration = Date.now() - startTime;
      this.results.push({ name, status: 'PASS', duration });
      await this.log(`✅ PASS: ${name} (${duration}ms)`);
    } catch (error) {
      this.results.push({ name, status: 'FAIL', error: error.message });
      await this.log(`❌ FAIL: ${name} - ${error.message}`);
    }
  }

  async healthCheck(url, serviceName) {
    const response = await axios.get(`${url}/health`, {
      timeout: CONFIG.timeout,
    });
    if (response.status !== 200) {
      throw new Error(`${serviceName} health check failed`);
    }
    return response.data;
  }

  async testApiGatewayHealth() {
    const health = await this.healthCheck(CONFIG.apiGateway, 'API Gateway');
    if (!health.data || health.data.gateway !== 'api-gateway') {
      throw new Error('API Gateway health response invalid');
    }
  }

  async testNftServiceHealth() {
    const health = await this.healthCheck(CONFIG.nftService, 'NFT Service');
    if (!health.service || health.service !== 'nft-marketplace-service') {
      throw new Error('NFT Service health response invalid');
    }
  }

  async testUserServiceHealth() {
    const health = await this.healthCheck(CONFIG.userService, 'User Service');
    if (!health.service || health.service !== 'user-management-service') {
      throw new Error('User Service health response invalid');
    }
  }

  async testNftMarketplaceThroughGateway() {
    const response = await axios.get(
      `${CONFIG.apiGateway}/api/nft/marketplace`,
      { timeout: CONFIG.timeout }
    );

    if (response.status !== 200) {
      throw new Error(`Expected status 200, got ${response.status}`);
    }

    const data = response.data;
    if (!data.success || !data.data) {
      throw new Error('Invalid response format');
    }

    const marketplace = data.data;
    const requiredFields = [
      'totalNFTs',
      'activeListings',
      'floorPrice',
      'volume24h',
      'topCollections',
    ];

    for (const field of requiredFields) {
      if (!(field in marketplace)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (!Array.isArray(marketplace.topCollections)) {
      throw new Error('topCollections should be an array');
    }
  }

  async testNftDetailsThroughGateway() {
    // First try to get a seeded NFT
    const response = await axios.get(`${CONFIG.apiGateway}/api/nft/CL0001`, {
      timeout: CONFIG.timeout,
    });

    if (response.status === 404) {
      // If no seeded data, test with a non-existent NFT (should return 404)
      const notFoundResponse = await axios.get(
        `${CONFIG.apiGateway}/api/nft/INVALID`,
        {
          timeout: CONFIG.timeout,
          validateStatus: () => true,
        }
      );

      if (notFoundResponse.status !== 404) {
        throw new Error(
          `Expected 404 for invalid NFT, got ${notFoundResponse.status}`
        );
      }
      return; // Test passed for 404 scenario
    }

    if (response.status !== 200) {
      throw new Error(`Expected status 200, got ${response.status}`);
    }

    const data = response.data;
    if (!data.success || !data.data) {
      throw new Error('Invalid response format');
    }

    const nft = data.data;
    const requiredFields = ['tokenId', 'name', 'description', 'price', 'owner'];

    for (const field of requiredFields) {
      if (!(field in nft)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
  }

  async testWalletBalanceThroughGateway() {
    const testAddress = '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234';
    const response = await axios.get(
      `${CONFIG.apiGateway}/api/wallet/${testAddress}`,
      { timeout: CONFIG.timeout }
    );

    if (response.status !== 200) {
      throw new Error(`Expected status 200, got ${response.status}`);
    }

    const data = response.data;
    if (!data.success || !data.data) {
      throw new Error('Invalid response format');
    }

    const wallet = data.data;
    const requiredFields = ['address', 'balance', 'tokens'];

    for (const field of requiredFields) {
      if (!(field in wallet)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
  }

  async testServiceDiscovery() {
    // Test that API Gateway can route to different services
    const responses = await Promise.all([
      axios.get(`${CONFIG.apiGateway}/api/nft/marketplace`, {
        timeout: CONFIG.timeout,
      }),
      axios.get(`${CONFIG.apiGateway}/api/wallet/0x123`, {
        timeout: CONFIG.timeout,
      }),
    ]);

    for (const response of responses) {
      if (response.status !== 200) {
        throw new Error(`Service discovery failed: ${response.status}`);
      }
    }
  }

  async testErrorHandling() {
    // Test invalid endpoints return proper errors
    const invalidResponse = await axios.get(
      `${CONFIG.apiGateway}/api/invalid/endpoint`,
      {
        timeout: CONFIG.timeout,
        validateStatus: () => true,
      }
    );

    if (invalidResponse.status !== 404) {
      throw new Error(
        `Expected 404 for invalid endpoint, got ${invalidResponse.status}`
      );
    }
  }

  async run() {
    await this.log('🚀 Starting Microservices Integration Tests');
    await this.log(`📡 API Gateway: ${CONFIG.apiGateway}`);
    await this.log(`🎨 NFT Service: ${CONFIG.nftService}`);
    await this.log(`👤 User Service: ${CONFIG.userService}`);
    await this.log('');

    // Health Checks
    await this.test('API Gateway Health Check', () =>
      this.testApiGatewayHealth()
    );
    await this.test('NFT Service Health Check', () =>
      this.testNftServiceHealth()
    );
    await this.test('User Service Health Check', () =>
      this.testUserServiceHealth()
    );

    // API Tests through Gateway
    await this.test('NFT Marketplace via Gateway', () =>
      this.testNftMarketplaceThroughGateway()
    );
    await this.test('NFT Details via Gateway', () =>
      this.testNftDetailsThroughGateway()
    );
    await this.test('Wallet Balance via Gateway', () =>
      this.testWalletBalanceThroughGateway()
    );

    // System Tests
    await this.test('Service Discovery', () => this.testServiceDiscovery());
    await this.test('Error Handling', () => this.testErrorHandling());

    // Results Summary
    await this.log('');
    await this.log('📊 Test Results Summary:');

    const passed = this.results.filter(r => r.status === 'PASS').length;
    const failed = this.results.filter(r => r.status === 'FAIL').length;
    const total = this.results.length;

    await this.log(`✅ Passed: ${passed}/${total}`);
    await this.log(`❌ Failed: ${failed}/${total}`);

    if (failed > 0) {
      await this.log('');
      await this.log('Failed Tests:');
      this.results
        .filter(r => r.status === 'FAIL')
        .forEach(r => this.log(`  ❌ ${r.name}: ${r.error}`));
    }

    const success = failed === 0;
    await this.log('');
    await this.log(success ? '🎉 All tests passed!' : '💥 Some tests failed!');

    return success;
  }
}

// Run tests if called directly
if (require.main === module) {
  const test = new IntegrationTest();
  test
    .run()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error('❌ Test runner failed:', error.message);
      process.exit(1);
    });
}

module.exports = IntegrationTest;
