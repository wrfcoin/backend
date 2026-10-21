/**
 * Database Error Handler
 * Provides resilient database operations with retry logic
 */

const { appLogger } = require('./utils/logger');

class DatabaseErrorHandler {
  static async executeWithRetry(operation, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        appLogger.error('Database operation failed', { module: 'DatabaseErrorHandler', operation: 'executeWithRetry', attempt, maxRetries, error: error.message });

        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          appLogger.info(`Retrying database operation`, { module: 'DatabaseErrorHandler', operation: 'executeWithRetry', delayMs: delay });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `Database operation failed after ${maxRetries} attempts: ${lastError.message}`
    );
  }

  static handleConnectionError(error) {
    appLogger.error('Database connection error', { module: 'DatabaseErrorHandler', operation: 'connectionError', error: error.message, code: error.code });

    // Implement connection recovery logic here
    return {
      shouldRetry: error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT',
      retryDelay: 2000,
    };
  }
}

module.exports = { DatabaseErrorHandler };
