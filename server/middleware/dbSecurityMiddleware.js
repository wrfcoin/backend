/**
 * Database Security Middleware
 *
 * This middleware adds security protections to database operations
 * including input sanitization, permission checks, and access logging.
 */

const DbSecurityUtils = require('../utils/dbSecurityUtils');
const { logger } = require('../utils/logger');

const FAST_API_PATH_PREFIXES = ['/health', '/ready', '/live', '/metrics'];

function isFastApiPath(req) {
  const path = req.path || req.originalUrl || '';
  return FAST_API_PATH_PREFIXES.some(
    prefix => path === prefix || path.startsWith(`${prefix}/`)
  );
}

/**
 * Middleware to sanitize input before database operations
 */
function sanitizeDbInput(req, res, next) {
  try {
    if (isFastApiPath(req)) {
      return next();
    }

    // Sanitize request body for POST/PUT operations
    if (
      req.body &&
      (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')
    ) {
      req.body = DbSecurityUtils.sanitizeInput(req.body);
    }

    // Sanitize query parameters
    if (req.query) {
      req.query = DbSecurityUtils.sanitizeInput(req.query);
    }

    // Sanitize URL parameters
    if (req.params) {
      req.params = DbSecurityUtils.sanitizeInput(req.params);
    }

    next();
  } catch (error) {
    logger.error('Error sanitizing database input:', error);
    res.status(400).json({
      error: true,
      message: 'Invalid input format',
    });
  }
}

/**
 * Middleware to check database permissions
 * @param {string} resourceType - Type of resource being accessed
 */
function checkDbPermission(resourceType) {
  return function (req, res, next) {
    try {
      // Get resource ID from request parameters
      const resourceId = req.params.id;

      if (!resourceId) {
        return next();
      }

      // Determine action from HTTP method
      let action;
      switch (req.method) {
        case 'GET':
          action = 'read';
          break;
        case 'POST':
          action = 'create';
          break;
        case 'PUT':
        case 'PATCH':
          action = 'update';
          break;
        case 'DELETE':
          action = 'delete';
          break;
        default:
          action = 'unknown';
      }

      // For now, we'll log access and continue since we're still in development
      // In production, we would check permissions more strictly
      logger.info(
        `DB Access: ${req.method} ${resourceType}/${resourceId} by ${req.user?.id || 'anonymous'}`
      );

      // Continue request processing
      next();
    } catch (error) {
      logger.error('Error in DB permission middleware:', error);
      res.status(500).json({
        error: true,
        message: 'Internal server error',
      });
    }
  };
}

/**
 * Middleware to validate schema names (tables, columns) in dynamic queries
 */
function validateSchemaNames(req, res, next) {
  try {
    // Validate table name if specified
    if (req.query.table && !DbSecurityUtils.isValidTableName(req.query.table)) {
      return res.status(400).json({
        error: true,
        message: 'Invalid table name',
      });
    }

    // Validate column names if specified
    if (req.query.columns) {
      const columns = Array.isArray(req.query.columns)
        ? req.query.columns
        : req.query.columns.split(',');

      for (const column of columns) {
        if (!DbSecurityUtils.isValidColumnName(column.trim())) {
          return res.status(400).json({
            error: true,
            message: 'Invalid column name',
          });
        }
      }
    }

    // Validate sort column if specified
    if (
      req.query.sortBy &&
      !DbSecurityUtils.isValidColumnName(req.query.sortBy)
    ) {
      return res.status(400).json({
        error: true,
        message: 'Invalid sort column',
      });
    }

    next();
  } catch (error) {
    logger.error('Error validating schema names:', error);
    res.status(400).json({
      error: true,
      message: 'Invalid schema parameters',
    });
  }
}

/**
 * Middleware to prevent excessive database load
 */
function preventExcessiveDatabaseLoad(req, res, next) {
  if (isFastApiPath(req)) {
    return next();
  }

  // Set reasonable limits for database operations
  const MAX_PAGE_SIZE = 100;
  const DEFAULT_PAGE_SIZE = 20;

  // Apply pagination limits
  if (req.query.limit) {
    const limit = parseInt(req.query.limit, 10);

    if (isNaN(limit) || limit <= 0) {
      req.query.limit = DEFAULT_PAGE_SIZE;
    } else if (limit > MAX_PAGE_SIZE) {
      req.query.limit = MAX_PAGE_SIZE;
    }
  }

  // Ensure offset is valid
  if (req.query.offset) {
    const offset = parseInt(req.query.offset, 10);

    if (isNaN(offset) || offset < 0) {
      req.query.offset = 0;
    }
  }

  next();
}

module.exports = {
  sanitizeDbInput,
  checkDbPermission,
  validateSchemaNames,
  preventExcessiveDatabaseLoad,
  isFastApiPath,
};
