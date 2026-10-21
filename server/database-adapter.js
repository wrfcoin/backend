/**
 * Database Adapter for Wrfcoin
 *
 * This adapter provides consistent field name conversion between application code (camelCase)
 * and database (snake_case) operations.
 */

const schema = require('../shared/schema');
const { db: sharedDb, pool: sharedPool } = require('../database/db.js');
const {
  toSnakeCase,
  toCamelCase,
  transformQueryResults,
} = require('../utils/fieldNameConverter');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must be set. Did you forget to provision a database?'
  );
}

const pool = sharedPool;
const db = sharedDb;

/**
 * Database adapter with field name conversion between camelCase and snake_case
 */
class DatabaseAdapter {
  /**
   * Insert data into a table with automatic field name conversion
   * @param {Object} table The Drizzle table object
   * @param {Object} data The data to insert in camelCase format
   * @returns {Promise<Object>} The inserted record in camelCase format
   */
  async insert(table, data) {
    try {
      // Convert camelCase to snake_case for DB operation
      const snakeCaseData = toSnakeCase(data);
      const [result] = await db.insert(table).values(snakeCaseData).returning();
      // Convert result back to camelCase for application code
      return toCamelCase(result);
    } catch (error) {
      console.error(`Insert error for table ${table.name}:`, error);
      throw error;
    }
  }

  /**
   * Select data from a table with field name conversion
   * @param {Object} table The Drizzle table object
   * @param {Object} whereConditions Optional where conditions in camelCase format
   * @returns {Promise<Array<Object>>} The selected records in camelCase format
   */
  async select(table, whereConditions = null) {
    try {
      let query = db.select().from(table);

      if (whereConditions) {
        // Convert camelCase conditions to snake_case
        const snakeCaseConditions = toSnakeCase(whereConditions);
        // Apply conditions (this is simplified, actual implementation would need proper operators)
        query = query.where(snakeCaseConditions);
      }

      const results = await query;
      // Convert results back to camelCase
      return results.map(result => toCamelCase(result));
    } catch (error) {
      console.error(`Select error for table ${table.name}:`, error);
      throw error;
    }
  }

  /**
   * Update data in a table with field name conversion
   * @param {Object} table The Drizzle table object
   * @param {Object} whereConditions The where conditions in camelCase format
   * @param {Object} data The data to update in camelCase format
   * @returns {Promise<Array<Object>>} The updated records in camelCase format
   */
  async update(table, whereConditions, data) {
    try {
      // Convert camelCase to snake_case for DB operation
      const snakeCaseData = toSnakeCase(data);
      const snakeCaseConditions = toSnakeCase(whereConditions);

      const results = await db
        .update(table)
        .set(snakeCaseData)
        .where(snakeCaseConditions)
        .returning();

      // Convert results back to camelCase
      return results.map(result => toCamelCase(result));
    } catch (error) {
      console.error(`Update error for table ${table.name}:`, error);
      throw error;
    }
  }

  /**
   * Delete data from a table with field name conversion
   * @param {Object} table The Drizzle table object
   * @param {Object} whereConditions The where conditions in camelCase format
   * @returns {Promise<Array<Object>>} The deleted records in camelCase format
   */
  async delete(table, whereConditions) {
    try {
      // Convert camelCase to snake_case for DB operation
      const snakeCaseConditions = toSnakeCase(whereConditions);

      const results = await db
        .delete(table)
        .where(snakeCaseConditions)
        .returning();

      // Convert results back to camelCase
      return results.map(result => toCamelCase(result));
    } catch (error) {
      console.error(`Delete error for table ${table.name}:`, error);
      throw error;
    }
  }

  /**
   * Execute a raw SQL query with result field conversion
   * @param {string} sql The SQL query to execute
   * @param {Array} params The query parameters
   * @returns {Promise<Array<Object>>} The query results in camelCase format
   */
  async rawQuery(sql, params = []) {
    try {
      const { rows } = await pool.query(sql, params);
      // Convert results back to camelCase
      return rows.map(row => toCamelCase(row));
    } catch (error) {
      console.error('Raw query error:', error);
      throw error;
    }
  }

  /**
   * Get access to the raw db instance for advanced operations
   * @returns {Object} The raw Drizzle database instance
   */
  getRawDb() {
    return db;
  }

  /**
   * Get access to the raw database pool
   * @returns {Object} The raw database pool
   */
  getPool() {
    return pool;
  }
}

// Create and export singleton instance
const dbAdapter = new DatabaseAdapter();

module.exports = {
  db,
  pool,
  schema,
  dbAdapter,
};
