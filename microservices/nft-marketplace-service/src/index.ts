import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { DatabaseService } from './services/database.js';
import { ResilientDatabaseService } from './services/resilient-database.js';
import { NFTService } from './services/nft-service.js';
import { nftRoutes } from './routes/nft-routes.js';
import { errorHandler, notFoundHandler } from './utils/error-handlers.js';
// Resilience framework imports
import {
  setupResilienceMiddleware,
  healthCheckMiddleware,
  metricsMiddleware,
  resilienceErrorHandler,
  ResilienceManager,
} from '../../shared/resilience.js';
import { appLogger } from '../../../server/utils/logger.js';
import { GracefulShutdown, ShutdownPriority } from '../../../shared/graceful-shutdown/index.js';
const { resolveAllowedOrigins } = require('../../../server/utils/strict-cors-config.js');

dotenv.config();

const app = express();
const PORT = process.env.NFT_SERVICE_PORT || 4002;

// Initialize resilience managers for external dependencies
const initializeResilience = () => {
  // Database resilience
  const dbResilienceManager = ResilienceManager.forDatabaseService(
    'nft-database',
    {
      serviceName: 'nft-database',
      circuitBreaker: {
        threshold: 3,
        timeout: 10000,
        resetTimeout: 90000,
        monitoringWindow: 90000,
        volumeThreshold: 5,
        errorThreshold: 60,
      },
      retry: {
        maxAttempts: 5,
        baseDelay: 500,
        maxDelay: 5000,
        backoffMultiplier: 1.5,
        jitter: true,
        retryableErrors: [
          'ECONNREFUSED',
          'ETIMEDOUT',
          'CONNECTION_ERROR',
          'DEADLOCK_DETECTED',
        ],
      },
      fallback: {
        enabled: true,
        cacheEnabled: true,
        cacheTtl: 300000, // 5 minutes for NFT data
        degradedResponse: {
          success: true,
          degraded: true,
          message: 'Database temporarily unavailable - showing cached NFT data',
          data: { nfts: [], total: 0, cached: true },
        },
      },
    }
  );

  // Setup resilience middleware for the NFT service itself
  setupResilienceMiddleware(app, 'nft-marketplace-service', {
    serviceName: 'nft-marketplace-service',
    circuitBreaker: {
      threshold: 5,
      timeout: 15000,
      resetTimeout: 60000,
      monitoringWindow: 60000,
      volumeThreshold: 10,
      errorThreshold: 50,
    },
    retry: {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 8000,
      backoffMultiplier: 2,
      jitter: true,
      retryableErrors: [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'SERVICE_UNAVAILABLE',
      ],
    },
    fallback: {
      enabled: true,
      cacheEnabled: true,
      cacheTtl: 600000, // 10 minutes for NFT service responses
    },
  });

  appLogger.info('Resilience patterns initialized for NFT Marketplace Service');
};

initializeResilience();

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: resolveAllowedOrigins({
      developmentDefaults: ['http://localhost:3000'],
    }),
    credentials: true,
  })
);

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  const dbService = DatabaseService.getInstance();
  res.json({
    status: dbService.isHealthy() ? 'healthy' : 'degraded',
    service: 'nft-marketplace-service',
    database: dbService.getConnectionStatus(),
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use('/api/nft', nftRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
async function startServer() {
  try {
    // Initialize resilient database connection
    const resilientDb = ResilientDatabaseService.getInstance();
    await resilientDb.connect();

    // Get health status for logging
    const healthStatus = await resilientDb.getHealthStatus();
    appLogger.info('Database Health', { healthStatus });

    // Seed initial data if needed
    const nftService = new NFTService();
    await nftService.seedInitialData();

    app.listen(PORT, () => {
      appLogger.info('NFT Marketplace Service running', { port: PORT });
      appLogger.info('Health check available', { url: `http://localhost:${PORT}/health` });
      appLogger.info('Resilience metrics available', { url: `http://localhost:${PORT}/resilience/metrics` });
      appLogger.info('Database Status', { status: healthStatus.database.status });
      appLogger.info('Circuit Breaker', { state: healthStatus.resilience.circuitState });
      appLogger.info('Success Rate', { rate: `${(100 - healthStatus.resilience.errorRate).toFixed(1)}%` });
    });
  } catch (error) {
    appLogger.error('Failed to start NFT service', { error });
    process.exit(1);
  }
}

// Graceful shutdown handling
const shutdown = GracefulShutdown.getInstance();

// Register database disconnect handler
shutdown.registerHandler({
  name: 'nft-marketplace-database',
  priority: ShutdownPriority.CLOSE_DATABASE,
  timeout: 5000,
  handler: async () => {
    const resilientDb = ResilientDatabaseService.getInstance();
    await resilientDb.disconnect();
    appLogger.info('NFT Marketplace Service database disconnected');
  },
});

// Set up signal handlers (SIGTERM, SIGINT)
shutdown.setupSignalHandlers();

startServer();

export default app;
