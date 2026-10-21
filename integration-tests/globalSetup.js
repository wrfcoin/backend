/**
 * Global Setup for Integration Tests
 * Runs once before all integration tests to set up test environment
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  console.log('Setting up integration test environment...');

  // Set global test environment
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';

  // Database setup
  const databaseUrl =
    process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/wrfcoin_test';

  try {
    // Test database connectivity
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    await pool.query('SELECT 1');
    console.log('✓ Database connection verified');

    // Create test schema if needed
    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_runs (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMP DEFAULT NOW(),
        status VARCHAR(20) DEFAULT 'running'
      )
    `);

    // Insert test run record
    const testRunResult = await pool.query(
      'INSERT INTO test_runs (started_at) VALUES (NOW()) RETURNING id'
    );

    global.__TEST_RUN_ID__ = testRunResult.rows[0].id;
    console.log(`✓ Test run ${global.__TEST_RUN_ID__} initialized`);

    await pool.end();
  } catch (error) {
    console.warn('Database setup failed:', error.message);
    console.warn('Integration tests will run with mocked database');

    // Set flag for tests to use mocks instead of real database
    process.env.USE_MOCK_DATABASE = 'true';
  }

  // Create logs directory for integration tests
  const logsDir = path.join(__dirname, '../logs/integration-tests');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
    console.log('✓ Integration test logs directory created');
  }

  // Set up test data directory
  const testDataDir = path.join(__dirname, 'test-data');
  if (!fs.existsSync(testDataDir)) {
    fs.mkdirSync(testDataDir, { recursive: true });
    console.log('✓ Test data directory created');
  }

  console.log('Integration test environment setup complete');
};
