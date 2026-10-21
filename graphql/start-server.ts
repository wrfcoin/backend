#!/usr/bin/env node

/**
 * GraphQL Server Startup Script
 * Starts the Wrfcoin GraphQL API server
 */

import { createGraphQLServer } from './server.js';
import { logger } from '../utils/logger.js';
import { checkDatabaseHealth } from '../database/connection.js';
import { GracefulShutdown } from '../shared/graceful-shutdown/index.js';

async function startServer() {
  try {
    // Check database connection
    const dbHealth = await checkDatabaseHealth();
    if (dbHealth !== 'healthy') {
      logger.error('Database is not healthy, cannot start GraphQL server');
      process.exit(1);
    }

    logger.info('Starting Wrfcoin GraphQL server...');

    // Start the GraphQL server
    await createGraphQLServer();

    logger.info('🚀 Wrfcoin GraphQL server started successfully');
  } catch (error) {
    logger.error('Failed to start GraphQL server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Set up graceful shutdown with uncaughtException and unhandledRejection handling
const shutdown = GracefulShutdown.getInstance({
  enableLogging: true,
  handleUncaughtExceptions: true,
  handleUnhandledRejections: true,
  logger: (message, level) => {
    if (level === 'error') {
      logger.error(message);
    } else if (level === 'warn') {
      logger.warn(message);
    } else {
      logger.info(message);
    }
  },
});

shutdown.setupSignalHandlers();

// Start the server
startServer();
