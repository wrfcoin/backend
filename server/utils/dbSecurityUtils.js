/**
 * Database Security Utilities
 *
 * This module provides utilities for enhancing database security across the application.
 * It implements sanitization, validation, and other security best practices.
 */

const { logger } = require('./logger');

class DbSecurityUtils {
  /**
   * Sanitize user input to prevent SQL injection
   * @param {any} input - User input to sanitize
   * @returns {any} Sanitized input
   */
  static sanitizeInput(input) {
    if (typeof input === 'string') {
      // Remove potentially dangerous SQL characters and patterns
      return input
        .replace(/'/g, "''") // Escape single quotes
        .replace(/;/g, '') // Remove semicolons
        .replace(/--/g, '') // Remove SQL comments
        .replace(/\/\*/g, '') // Remove block comment starts
        .replace(/\*\//g, ''); // Remove block comment ends
    } else if (Array.isArray(input)) {
      return input.map(item => this.sanitizeInput(item));
    } else if (input && typeof input === 'object') {
      const sanitizedObj = {};
      for (const key in input) {
        sanitizedObj[key] = this.sanitizeInput(input[key]);
      }
      return sanitizedObj;
    }
    return input;
  }

  /**
   * Validate table name to prevent SQL injection in dynamic queries
   * @param {string} tableName - Table name to validate
   * @returns {boolean} Whether the table name is valid
   */
  static isValidTableName(tableName) {
    if (typeof tableName !== 'string') {
      return false;
    }

    // Check if the table name follows a valid pattern
    const validPattern = /^[a-zA-Z0-9_]+$/;
    return validPattern.test(tableName);
  }

  /**
   * Validate column name to prevent SQL injection in dynamic queries
   * @param {string} columnName - Column name to validate
   * @returns {boolean} Whether the column name is valid
   */
  static isValidColumnName(columnName) {
    if (typeof columnName !== 'string') {
      return false;
    }

    // Check if the column name follows a valid pattern
    const validPattern = /^[a-zA-Z0-9_]+$/;
    return validPattern.test(columnName);
  }

  /**
   * Check if a user has permission to access the given resource
   * @param {Object} user - Current user
   * @param {string} resourceType - Type of resource
   * @param {string} resourceId - ID of resource
   * @param {string} action - Action being performed (read, write, delete)
   * @returns {Promise<boolean>} Whether access is allowed
   */
  static async checkPermission(user, resourceType, resourceId, action) {
    // If no user, only allow access to public resources
    if (!user) {
      logger.info(
        `Anonymous access attempt to ${resourceType}/${resourceId} for ${action}`
      );
      return false;
    }

    // Super admins have access to everything
    if (user.role === 'admin') {
      return true;
    }

    // Check for specific resource permissions
    switch (resourceType) {
      case 'wallet':
        // Only owner can access their wallet
        return user.id === resourceId || user.wallets?.includes(resourceId);

      case 'transaction':
        // Transactions need special handling based on visibility
        return this.checkTransactionPermission(user, resourceId, action);

      case 'validator':
        // Check validator node permissions
        return user.id === resourceId || user.validators?.includes(resourceId);

      default:
        // Default to ownership check
        return user.id === resourceId;
    }
  }

  /**
   * Check transaction permissions with special handling
   * @param {Object} user - Current user
   * @param {string} transactionId - Transaction ID
   * @param {string} action - Action being performed
   * @returns {Promise<boolean>} Whether access is allowed
   */
  static async checkTransactionPermission(user, transactionId, action) {
    try {
      // For demo purposes - in a real implementation, this would query the database
      // to check if the user is sender or recipient of the transaction

      // Only allow read access for non-owners
      if (action !== 'read') {
        // Only transaction creator can modify/delete
        return user.transactions?.includes(transactionId);
      }

      return true; // For demo, allow read access to all users
    } catch (error) {
      logger.error('Error checking transaction permission:', error);
      return false;
    }
  }

  /**
   * Log database access for auditing purposes
   * @param {Object} user - Current user
   * @param {string} action - Action performed (read, write, delete)
   * @param {string} table - Table accessed
   * @param {string|number} recordId - Record ID accessed
   * @param {Object} details - Additional details
   */
  static logDbAccess(user, action, table, recordId, details = {}) {
    const userId = user?.id || 'anonymous';
    const timestamp = new Date().toISOString();

    logger.info(
      `DB Access: ${timestamp} | User: ${userId} | Action: ${action} | Table: ${table} | ID: ${recordId}`,
      {
        userId,
        action,
        table,
        recordId,
        timestamp,
        details,
        ip: details.ip || 'unknown',
      }
    );
  }
}

module.exports = DbSecurityUtils;
