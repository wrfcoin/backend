/**
 * Database Adapter for Wrfcoin (TypeScript Version)
 *
 * This adapter provides consistent field name conversion between application code (camelCase)
 * and database (snake_case) operations.
 */

import * as schema from '../shared/schema.js';
import { eq, and, or, SQL } from 'drizzle-orm';
import fieldNameConverter from '../utils/fieldNameConverter.js';
import { appLogger } from './utils/logger.js';
import { db as sharedDb, pool as sharedPool } from '../database/db.js';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must be set. Did you forget to provision a database?'
  );
}

const pool = sharedPool;
const db = sharedDb as typeof sharedDb & { schema?: typeof schema };

/**
 * Database adapter with field name conversion between camelCase and snake_case
 */
class DatabaseAdapter {
  /**
   * Insert data into a table with automatic field name conversion
   * @param table The Drizzle table object
   * @param data The data to insert in camelCase format
   * @returns The inserted record in camelCase format
   */
  async insert<T extends Record<string, any>>(table: any, data: T): Promise<T> {
    try {
      // Convert camelCase to snake_case for DB operation
      const snakeCaseData = fieldNameConverter.camelToSnake(data);
      const insertResult = await db
        .insert(table)
        .values(snakeCaseData)
        .returning();
      const result = Array.isArray(insertResult)
        ? insertResult[0]
        : insertResult;
      // Convert result back to camelCase for application code
      return fieldNameConverter.snakeToCamel(result) as T;
    } catch (error) {
      appLogger.error(`Insert error for table ${table.name}`, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Select data from a table with field name conversion
   * @param table The Drizzle table object
   * @param whereConditions Optional where conditions in camelCase format
   * @returns The selected records in camelCase format
   */
  async select<T extends Record<string, any>>(
    table: any,
    whereConditions: Partial<T> | null = null
  ): Promise<T[]> {
    try {
      let query = db.select().from(table);

      if (whereConditions) {
        // Build where conditions properly using Drizzle's eq operator
        const conditions: SQL[] = [];

        Object.entries(whereConditions).forEach(([key, value]) => {
          const snakeKeyObj = fieldNameConverter.camelToSnake({ [key]: value });
          const snakeKey = Object.keys(snakeKeyObj)[0];
          const column = table[snakeKey];
          if (column) {
            conditions.push(eq(column, value));
          }
        });

        if (conditions.length > 0) {
          query = query.where(and(...conditions)) as any;
        }
      }

      const results = await query;
      // Convert results back to camelCase
      return results.map(
        result => fieldNameConverter.snakeToCamel(result) as T
      );
    } catch (error) {
      appLogger.error(`Select error for table ${table.name}`, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Update data in a table with field name conversion
   * @param table The Drizzle table object
   * @param whereConditions The where conditions in camelCase format
   * @param data The data to update in camelCase format
   * @returns The updated records in camelCase format
   */
  async update<T extends Record<string, any>>(
    table: any,
    whereConditions: Partial<T>,
    data: Partial<T>
  ): Promise<T[]> {
    try {
      // Convert camelCase to snake_case for DB operation
      const snakeCaseData = fieldNameConverter.camelToSnake(data);

      // Build where conditions properly using Drizzle's eq operator
      const conditions: SQL[] = [];

      Object.entries(whereConditions).forEach(([key, value]) => {
        const snakeKeyObj = fieldNameConverter.camelToSnake({ [key]: value });
        const snakeKey = Object.keys(snakeKeyObj)[0];
        const column = table[snakeKey];
        if (column) {
          conditions.push(eq(column, value));
        }
      });

      if (conditions.length === 0) {
        throw new Error('Update requires at least one condition');
      }

      const results = await db
        .update(table)
        .set(snakeCaseData)
        .where(and(...conditions))
        .returning();

      // Convert results back to camelCase
      return results.map(
        result => fieldNameConverter.snakeToCamel(result) as T
      );
    } catch (error) {
      appLogger.error(`Update error for table ${table.name}`, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Delete data from a table with field name conversion
   * @param table The Drizzle table object
   * @param whereConditions The where conditions in camelCase format
   * @returns The deleted records in camelCase format
   */
  async delete<T extends Record<string, any>>(
    table: any,
    whereConditions: Partial<T>
  ): Promise<T[]> {
    try {
      // Build where conditions properly using Drizzle's eq operator
      const conditions: SQL[] = [];

      Object.entries(whereConditions).forEach(([key, value]) => {
        const snakeKeyObj = fieldNameConverter.camelToSnake({ [key]: value });
        const snakeKey = Object.keys(snakeKeyObj)[0];
        const column = table[snakeKey];
        if (column) {
          conditions.push(eq(column, value));
        }
      });

      if (conditions.length === 0) {
        throw new Error('Delete requires at least one condition');
      }

      const results = await db
        .delete(table)
        .where(and(...conditions))
        .returning();

      // Convert results back to camelCase
      return Array.isArray(results)
        ? results.map(result => fieldNameConverter.snakeToCamel(result) as T)
        : [];
    } catch (error) {
      appLogger.error(`Delete error for table ${table.name}`, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Execute a raw SQL query with result field conversion
   * @param sql The SQL query to execute
   * @param params The query parameters
   * @returns The query results in camelCase format
   */
  async rawQuery<T>(sql: string, params: any[] = []): Promise<T[]> {
    try {
      const { rows } = await pool.query(sql, params);
      // Convert results back to camelCase
      return rows.map(row => fieldNameConverter.snakeToCamel(row) as T);
    } catch (error) {
      appLogger.error('Raw query error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Get access to the raw db instance for advanced operations
   * @returns The raw Drizzle database instance
   */
  getRawDb() {
    return db;
  }

  /**
   * Get access to the raw database pool
   * @returns The raw database pool
   */
  getPool() {
    return pool;
  }
}

// Create and export singleton instance
const dbAdapter = new DatabaseAdapter();

export { db, pool, schema, dbAdapter };
