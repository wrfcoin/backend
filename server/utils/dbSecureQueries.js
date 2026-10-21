/**
 * Secure Database Query Utilities
 *
 * This module provides secure database access functions that automatically
 * apply row-level security and prevent SQL injection.
 */

const { db } = require('../db');
const { eq, and } = require('drizzle-orm');
const DbAccessControl = require('../middleware/dbAccessControl');
const { logger } = require('./logger');

/**
 * Secure database query utilities to enforce access control
 */
class DbSecureQueries {
  /**
   * Get a record by ID with row-level security
   * @param {Object} table - The table schema
   * @param {number|string} id - Record ID
   * @param {string|null} userId - Current user ID
   * @param {Object} options - Additional options
   * @returns {Promise<Object|null>} The requested record if accessible
   */
  static async getById(table, id, userId, options = {}) {
    try {
      // Create secure query with row-level filtering
      const query = db.select().from(table).where(eq(table.id, id)).limit(1);

      // Apply row-level security filter
      const secureQuery = DbAccessControl.secureQuery(
        query,
        table,
        userId,
        options
      );

      // Execute query
      const [record] = await secureQuery;
      return record || null;
    } catch (error) {
      logger.error(`Error in getById for ${table._.name}:`, {
        error: error.message,
        stack: error.stack,
        tableId: id,
        userId,
      });
      throw error;
    }
  }

  /**
   * Get all records with row-level security
   * @param {Object} table - The table schema
   * @param {string|null} userId - Current user ID
   * @param {Object} options - Additional options
   * @returns {Promise<Array>} Array of accessible records
   */
  static async getAll(table, userId, options = {}) {
    try {
      // Create basic query
      const query = db.select().from(table);

      // Apply row-level security filter
      const secureQuery = DbAccessControl.secureQuery(
        query,
        table,
        userId,
        options
      );

      // Apply pagination if requested
      if (options.limit) {
        secureQuery.limit(options.limit);

        if (options.offset) {
          secureQuery.offset(options.offset);
        }
      }

      // Apply sorting if requested
      if (options.orderBy) {
        if (options.orderDirection === 'desc') {
          secureQuery.orderBy(table[options.orderBy], 'desc');
        } else {
          secureQuery.orderBy(table[options.orderBy]);
        }
      }

      // Execute query
      return await secureQuery;
    } catch (error) {
      logger.error(`Error in getAll for ${table._.name}:`, {
        error: error.message,
        stack: error.stack,
        userId,
      });
      throw error;
    }
  }

  /**
   * Create a new record and associate with user
   * @param {Object} table - The table schema
   * @param {Object} data - Record data
   * @param {string|null} userId - Current user ID
   * @returns {Promise<Object>} Created record
   */
  static async create(table, data, userId) {
    try {
      // Ensure owner ID is set
      const secureData = { ...data };

      // Set user ID if the table has a user ID column
      if (table.userId && userId) {
        secureData.userId = userId;
      } else if (table.ownerId && userId) {
        secureData.ownerId = userId;
      }

      // Create record
      const [newRecord] = await db.insert(table).values(secureData).returning();

      return newRecord;
    } catch (error) {
      logger.error(`Error in create for ${table._.name}:`, {
        error: error.message,
        stack: error.stack,
        userId,
      });
      throw error;
    }
  }

  /**
   * Update a record with row-level security
   * @param {Object} table - The table schema
   * @param {number|string} id - Record ID
   * @param {Object} data - Updated data
   * @param {string|null} userId - Current user ID
   * @param {Object} options - Additional options
   * @returns {Promise<Object|null>} Updated record if successful
   */
  static async update(table, id, data, userId, options = {}) {
    try {
      // Verify access first
      const hasAccess = await DbAccessControl.validateAccess(
        table,
        id,
        userId,
        options
      );

      if (!hasAccess) {
        logger.warn(
          `Access denied: User ${userId} attempted to update ${table._.name} record ${id}`
        );
        return null;
      }

      // Remove ownership fields from update data
      const secureData = { ...data };
      delete secureData.userId;
      delete secureData.ownerId;

      // Update the record
      const [updatedRecord] = await db
        .update(table)
        .set(secureData)
        .where(eq(table.id, id))
        .returning();

      return updatedRecord || null;
    } catch (error) {
      logger.error(`Error in update for ${table._.name}:`, {
        error: error.message,
        stack: error.stack,
        tableId: id,
        userId,
      });
      throw error;
    }
  }

  /**
   * Delete a record with row-level security
   * @param {Object} table - The table schema
   * @param {number|string} id - Record ID
   * @param {string|null} userId - Current user ID
   * @param {Object} options - Additional options
   * @returns {Promise<boolean>} Success status
   */
  static async delete(table, id, userId, options = {}) {
    try {
      // Verify access first
      const hasAccess = await DbAccessControl.validateAccess(
        table,
        id,
        userId,
        options
      );

      if (!hasAccess) {
        logger.warn(
          `Access denied: User ${userId} attempted to delete ${table._.name} record ${id}`
        );
        return false;
      }

      // Delete the record
      const result = await db.delete(table).where(eq(table.id, id));

      return true;
    } catch (error) {
      logger.error(`Error in delete for ${table._.name}:`, {
        error: error.message,
        stack: error.stack,
        tableId: id,
        userId,
      });
      throw error;
    }
  }

  /**
   * Check if a record exists and is accessible to the user
   * @param {Object} table - The table schema
   * @param {number|string} id - Record ID
   * @param {string|null} userId - Current user ID
   * @param {Object} options - Additional options
   * @returns {Promise<boolean>} Whether record exists and is accessible
   */
  static async exists(table, id, userId, options = {}) {
    try {
      return await DbAccessControl.validateAccess(table, id, userId, options);
    } catch (error) {
      logger.error(`Error checking existence for ${table._.name}:`, {
        error: error.message,
        stack: error.stack,
        tableId: id,
        userId,
      });
      return false;
    }
  }
}

module.exports = DbSecureQueries;
