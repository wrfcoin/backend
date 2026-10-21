/**
 * Global Teardown for Integration Tests
 * Runs once after all integration tests to clean up test environment
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  console.log('Cleaning up integration test environment...');

  // Database cleanup
  if (!process.env.USE_MOCK_DATABASE) {
    const databaseUrl =
      process.env.TEST_DATABASE_URL ||
      'postgresql://localhost:5432/wrfcoin_test';

    try {
      const pool = new Pool({
        connectionString: databaseUrl,
        max: 5,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
      });

      // Mark test run as complete
      if (global.__TEST_RUN_ID__) {
        await pool.query('UPDATE test_runs SET status = $1 WHERE id = $2', [
          'completed',
          global.__TEST_RUN_ID__,
        ]);
        console.log(`✓ Test run ${global.__TEST_RUN_ID__} marked as completed`);
      }

      // Clean up any remaining test data
      const cleanupQueries = [
        "DELETE FROM votes WHERE id LIKE 'test_%'",
        "DELETE FROM governance_proposals WHERE id LIKE 'test_%'",
        "DELETE FROM transactions WHERE id LIKE 'test_%'",
        "DELETE FROM blocks WHERE id LIKE 'test_%'",
        "DELETE FROM weather_data WHERE station_id LIKE 'test_%'",
        "DELETE FROM nfts WHERE id LIKE 'test_%'",
        "DELETE FROM wallets WHERE address LIKE 'test_%'",
      ];

      for (const query of cleanupQueries) {
        try {
          const result = await pool.query(query);
          if (result.rowCount > 0) {
            console.log(
              `✓ Cleaned ${result.rowCount} test records from ${query.split(' ')[2]}`
            );
          }
        } catch (error) {
          console.warn(`Warning: Could not clean table: ${error.message}`);
        }
      }

      await pool.end();
      console.log('✓ Database cleanup completed');
    } catch (error) {
      console.warn('Database cleanup failed:', error.message);
    }
  }

  // Clean up temporary test files
  const testDataDir = path.join(__dirname, 'test-data');
  if (fs.existsSync(testDataDir)) {
    try {
      // Remove temporary test files
      const files = fs.readdirSync(testDataDir);
      files.forEach(file => {
        if (file.startsWith('temp_')) {
          fs.unlinkSync(path.join(testDataDir, file));
        }
      });
      console.log('✓ Temporary test files cleaned up');
    } catch (error) {
      console.warn('Warning: Could not clean test files:', error.message);
    }
  }

  // Final memory cleanup
  if (global.gc) {
    global.gc();
    console.log('✓ Garbage collection triggered');
  }

  console.log('Integration test environment cleanup complete');
};
