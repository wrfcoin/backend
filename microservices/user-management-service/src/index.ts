import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { walletRoutes } from './routes/wallet-routes.js';
import { errorHandler, notFoundHandler } from './utils/error-handlers.js';
// Resilience framework imports
import {
  setupResilienceMiddleware,
  healthCheckMiddleware,
  metricsMiddleware,
  resilienceErrorHandler,
} from '../../shared/resilience.js';
import { appLogger } from '../../../server/utils/logger.js';
import {
  GracefulShutdown,
  ShutdownPriority,
} from '../../../shared/graceful-shutdown/index.js';
const { resolveAllowedOrigins } = require('../../../server/utils/strict-cors-config.js');

dotenv.config();

const app = express();
const PORT = process.env.USER_SERVICE_PORT || 4003;

// Initialize resilience for user management service
const setupResilience = () => {
  const manager = setupResilienceMiddleware(app, 'user-management-service', {
    serviceName: 'user-management-service',
    circuitBreaker: {
      threshold: 3,
      timeout: 8000,
      resetTimeout: 60000,
      monitoringWindow: 60000,
      volumeThreshold: 5,
      errorThreshold: 50,
    },
    retry: {
      maxAttempts: 2,
      baseDelay: 1000,
      maxDelay: 5000,
      backoffMultiplier: 2,
      jitter: true,
      retryableErrors: [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'NETWORK_ERROR',
      ],
    },
    fallback: {
      enabled: true,
      cacheEnabled: true,
      cacheTtl: 180000, // 3 minutes
      degradedResponse: {
        success: true,
        degraded: true,
        message: 'User service temporarily degraded',
        data: null,
      },
    },
  });

  appLogger.info('Resilience patterns initialized for User Management Service');
  return manager;
};

const resilienceManager = setupResilience();

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

// Enhanced health check with resilience metrics
app.get(
  '/health',
  healthCheckMiddleware('user-management-service', resilienceManager)
);

// Resilience metrics endpoint
app.get('/resilience/metrics', metricsMiddleware('user-management-service'));

// API routes
app.use('/api/wallet', walletRoutes);

// Error handling
app.use(notFoundHandler);
app.use(resilienceErrorHandler()); // Add resilience error handler
app.use(errorHandler);

// Graceful shutdown handling
const shutdown = GracefulShutdown.getInstance();

shutdown.registerHandler({
  name: 'resilience-manager',
  priority: ShutdownPriority.STOP_BACKGROUND_JOBS,
  timeout: 5000,
  handler: async () => {
    appLogger.info('Shutting down resilience manager...');
    resilienceManager.shutdown();
    appLogger.info('Resilience manager shutdown complete');
  },
});

shutdown.setupSignalHandlers();

// Start server
app.listen(PORT, () => {
  appLogger.info('User Management Service running', { port: PORT });
  appLogger.info('Health check available', { url: `http://localhost:${PORT}/health` });
  appLogger.info('Resilience metrics available', { url: `http://localhost:${PORT}/resilience/metrics` });

  const metrics = resilienceManager.getMetrics();
  appLogger.info('Circuit Breaker status', { state: metrics.circuit.state });
  appLogger.info('Error Rate', { rate: `${metrics.circuit.errorRate.toFixed(2)}%` });
});

export default app;
