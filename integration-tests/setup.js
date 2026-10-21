/**
 * Integration Test Setup
 * Configures test environment for integration testing with real database connections
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/wrfcoin_test';

// Global test utilities
global.IntegrationTestUtils = {
  // Database utilities
  async createTestDatabase() {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    try {
      await pool.query('SELECT 1');
      return pool;
    } catch (error) {
      console.warn(
        'Database not available for integration tests:',
        error.message
      );
      return null;
    }
  },

  async cleanupTestData(pool) {
    if (!pool) return;

    try {
      // Clean up test data in reverse dependency order
      await pool.query("DELETE FROM votes WHERE id LIKE 'test_%'");
      await pool.query(
        "DELETE FROM governance_proposals WHERE id LIKE 'test_%'"
      );
      await pool.query("DELETE FROM transactions WHERE id LIKE 'test_%'");
      await pool.query("DELETE FROM blocks WHERE id LIKE 'test_%'");
      await pool.query(
        "DELETE FROM weather_data WHERE station_id LIKE 'test_%'"
      );
      await pool.query("DELETE FROM nfts WHERE id LIKE 'test_%'");
      await pool.query("DELETE FROM wallets WHERE address LIKE 'test_%'");
    } catch (error) {
      console.warn('Error cleaning test data:', error.message);
    }
  },

  // Mock data generators
  generateTestWallet() {
    return {
      address: `test_wallet_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      balance: Math.floor(Math.random() * 10000),
      network: 'testnet',
      created_at: new Date().toISOString(),
    };
  },

  generateTestTransaction() {
    return {
      id: `test_tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      from_address: `test_from_${Math.random().toString(36).substr(2, 9)}`,
      to_address: `test_to_${Math.random().toString(36).substr(2, 9)}`,
      amount: Math.floor(Math.random() * 1000),
      fee: Math.floor(Math.random() * 10),
      status: 'confirmed',
      timestamp: new Date().toISOString(),
    };
  },

  generateTestWeatherData() {
    return {
      station_id: `test_station_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      temperature: 20 + Math.random() * 15, // 20-35°C
      humidity: 30 + Math.random() * 40, // 30-70%
      pressure: 1000 + Math.random() * 50, // 1000-1050 hPa
      wind_speed: Math.random() * 30, // 0-30 m/s
      wind_direction: Math.floor(Math.random() * 360), // 0-359 degrees
      location: {
        latitude: 40.7128 + (Math.random() - 0.5) * 0.1,
        longitude: -74.006 + (Math.random() - 0.5) * 0.1,
      },
    };
  },

  generateTestNFT() {
    return {
      id: `test_nft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: `Test NFT ${Math.random().toString(36).substr(2, 9)}`,
      description: 'Integration test NFT',
      creator: `test_creator_${Math.random().toString(36).substr(2, 9)}`,
      owner: `test_owner_${Math.random().toString(36).substr(2, 9)}`,
      price: Math.floor(Math.random() * 1000),
      category: 'test',
      created_at: new Date().toISOString(),
    };
  },

  // API test helpers
  async makeApiRequest(app, method, endpoint, data = null, headers = {}) {
    const request = require('supertest')(app);

    const defaultHeaders = {
      'Content-Type': 'application/json',
      'X-API-Key': 'test-integration-key',
      ...headers,
    };

    let req;
    switch (method.toLowerCase()) {
      case 'get':
        req = request.get(endpoint);
        break;
      case 'post':
        req = request.post(endpoint);
        break;
      case 'put':
        req = request.put(endpoint);
        break;
      case 'delete':
        req = request.delete(endpoint);
        break;
      default:
        throw new Error(`Unsupported HTTP method: ${method}`);
    }

    // Add headers
    Object.entries(defaultHeaders).forEach(([key, value]) => {
      req.set(key, value);
    });

    // Add data for POST/PUT requests
    if (data && ['post', 'put'].includes(method.toLowerCase())) {
      req.send(data);
    }

    return req;
  },

  // Assertion helpers
  expectValidApiResponse(response, expectedStatus = 200) {
    expect(response.status).toBe(expectedStatus);
    expect(response.body).toBeDefined();

    if (expectedStatus >= 200 && expectedStatus < 300) {
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
    } else {
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
    }
  },

  expectValidPaginatedResponse(response, expectedStatus = 200) {
    this.expectValidApiResponse(response, expectedStatus);

    if (expectedStatus >= 200 && expectedStatus < 300) {
      expect(response.body.data.items).toBeInstanceOf(Array);
      expect(response.body.data.pagination).toBeDefined();
      expect(response.body.data.pagination.page).toBeGreaterThan(0);
      expect(response.body.data.pagination.limit).toBeGreaterThan(0);
      expect(response.body.data.pagination.total).toBeGreaterThanOrEqual(0);
    }
  },
};

// Increase timeout for integration tests
jest.setTimeout(30000);

// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Console log setup
console.log('Integration test setup completed');
console.log('Database URL:', process.env.DATABASE_URL);
console.log('Node environment:', process.env.NODE_ENV);
