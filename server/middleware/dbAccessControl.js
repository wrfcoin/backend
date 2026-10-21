/**
 * Database Access Control Middleware
 *
 * This module implements row-level security and access control for database operations.
 * It ensures that users can only access data they own or have explicit permission to view.
 */

const { db } = require('../db');
const { eq, and, or, inArray } = require('drizzle-orm');
const { logger } = require('../utils/logger');

/**
 * Database Access Control Service
 */
class DbAccessControl {
  /**
   * Create a query filter to enforce row-level security based on user
   * @param {Object} table - The Drizzle table schema
   * @param {string|null} userId - The current user's ID
   * @param {Object} options - Additional options
   * @returns {Object} The security filter to be applied to queries
   */
  static createUserFilter(table, userId, options = {}) {
    if (!userId && !options.allowPublic) {
      // If no user ID and not public data, return a filter that will match nothing
      return eq(table.id, -1);
    }

    // Check if table has ownership columns
    if (table.userId) {
      // Basic owner check
      if (options.allowPublic) {
        // Allow either owned by user or public items
        return or(eq(table.userId, userId), eq(table.isPublic, true));
      } else {
        // Only allow items owned by the user
        return eq(table.userId, userId);
      }
    } else if (table.ownerId) {
      // Alternative ownership column
      return eq(table.ownerId, userId);
    }

    // For tables without ownership columns, apply custom rules or return true
    if (options.customFilter) {
      return options.customFilter;
    }

    // Default to allowing access (for tables without ownership)
    logger.warn(`No ownership column found for table: ${table._.name}`);
    return undefined;
  }

  /**
   * Apply access control to a query using row-level security
   * @param {Object} queryBuilder - The Drizzle query builder
   * @param {Object} table - The table schema
   * @param {string|null} userId - The current user's ID
   * @param {Object} options - Additional options
   * @returns {Object} Modified query builder with security filters
   */
  static secureQuery(queryBuilder, table, userId, options = {}) {
    const filter = this.createUserFilter(table, userId, options);

    if (filter) {
      return queryBuilder.where(filter);
    }

    return queryBuilder;
  }

  /**
   * Validate that a user has access to a specific record
   * @param {Object} table - The table schema
   * @param {number|string} recordId - The record ID to validate
   * @param {string} userId - The current user's ID
   * @param {Object} options - Additional options
   * @returns {Promise<boolean>} Whether the user has access
   */
  static async validateAccess(table, recordId, userId, options = {}) {
    if (!userId && !options.allowPublic) {
      return false;
    }

    try {
      const filter = this.createUserFilter(table, userId, options);
      if (!filter) {
        return true; // No ownership filter means access allowed
      }

      const record = await db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.id, recordId), filter))
        .limit(1);

      return record && record.length > 0;
    } catch (error) {
      logger.error('Error validating access:', error);
      return false;
    }
  }

  /**
   * Create middleware that enforces row-level security
   * @param {Object} table - The table schema
   * @param {Object} options - Additional options
   * @returns {function} Express middleware function
   */
  static enforceRowLevelSecurity(table, options = {}) {
    return async (req, res, next) => {
      // Only apply to requests with record IDs
      if (!req.params.id) {
        return next();
      }

      const userId = req.user?.id;
      const recordId = req.params.id;

      const hasAccess = await this.validateAccess(
        table,
        recordId,
        userId,
        options
      );

      if (!hasAccess) {
        logger.warn(
          `Access denied: User ${userId} attempted to access ${table._.name} record ${recordId}`
        );
        return res.status(403).json({
          error: true,
          message: 'You do not have permission to access this resource',
          code: 'ACCESS_DENIED',
        });
      }

      next();
    };
  }

  /**
   * Create a data ownership middleware that adds the user ID to created records
   * @returns {function} Express middleware function
   */
  static enforceDataOwnership() {
    return (req, res, next) => {
      // Only apply to requests with a body (typically POST/PUT)
      if (!req.body || req.method === 'GET') {
        return next();
      }

      const userId = req.user?.id;

      // Skip if no authenticated user
      if (!userId) {
        return next();
      }

      // Add owner ID to the request body
      if (req.method === 'POST') {
        // For new resources
        req.body.userId = userId;
      } else if (req.method === 'PUT' || req.method === 'PATCH') {
        // For updates, don't allow changing ownership
        if (req.body.userId && req.body.userId !== userId) {
          delete req.body.userId;
        }
      }

      next();
    };
  }
}

module.exports = DbAccessControl;
