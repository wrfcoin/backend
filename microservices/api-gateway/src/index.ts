import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import {
  ServiceDiscovery,
  ServiceHealthStatus,
} from './services/service-discovery.js';
import {
  serviceConfig,
  testnetMvpScopeEnabled,
} from './services/service-config.js';
import { createServiceProxy } from './middleware/proxy-middleware.js';
import { authRoutes } from './routes/auth-routes.js';
import { monitoringRoutes } from './routes/monitoring-routes.js';
import { securityRoutes } from './routes/security-routes.js';
import { AuthService } from './services/auth-service.js';
import { AuthMiddleware } from './middleware/auth-middleware.js';
import { Logger } from './services/logger.js';
import {
  requestLogger,
  usageTracker,
  securityLogger,
  errorLogger,
} from './middleware/logging-middleware.js';
import {
  generalRateLimit,
  authRateLimit,
  walletRateLimit,
  bridgeRateLimit,
  speedLimiter,
  ipSecurityMiddleware,
  securityHeaders,
  requestValidation,
} from './middleware/security-middleware.js';
// Resilience framework imports
import {
  ResilienceManager,
  resilience,
  setupResilienceMiddleware,
  healthCheckMiddleware,
  metricsMiddleware,
  resilienceErrorHandler,
} from '../../shared/resilience/index.ts';
const { resolveAllowedOrigins } = require('../../../server/utils/strict-cors-config.js');

dotenv.config();

const app = express();
const PORT = process.env.API_GATEWAY_PORT || 4000;

// Initialize service discovery
const serviceDiscovery = new ServiceDiscovery();

// Initialize resilience managers for downstream services
const initializeResilience = () => {
  // NFT Marketplace Service
  const nftServiceManager = ResilienceManager.forHttpService(
    'nftService',
    serviceConfig.nftService.url,
    {
      serviceName: 'nftService',
      circuitBreaker: {
        threshold: 3,
        timeout: 8000,
        resetTimeout: 60000,
        monitoringWindow: 60000,
        volumeThreshold: 5,
        errorThreshold: 60,
      },
      retry: {
        maxAttempts: 2,
        baseDelay: 1000,
        maxDelay: 5000,
        backoffMultiplier: 2,
        jitter: true,
        retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'],
      },
      fallback: {
        enabled: true,
        cacheEnabled: true,
        cacheTtl: 300000,
        degradedResponse: {
          success: true,
          degraded: true,
          message: 'NFT service temporarily unavailable - showing cached data',
          data: { nfts: [], total: 0 },
        },
      },
    }
  );
  resilience.register('nftService', nftServiceManager);

  // User Management Service
  const userServiceManager = ResilienceManager.forHttpService(
    'userService',
    serviceConfig.userService.url,
    {
      serviceName: 'userService',
      circuitBreaker: {
        threshold: 3,
        timeout: 10000,
        resetTimeout: 90000,
        monitoringWindow: 90000,
        volumeThreshold: 5,
        errorThreshold: 50,
      },
      retry: {
        maxAttempts: 3,
        baseDelay: 500,
        maxDelay: 3000,
        backoffMultiplier: 1.5,
        jitter: true,
        retryableErrors: [
          'ECONNREFUSED',
          'ETIMEDOUT',
          'ENOTFOUND',
          'EAI_AGAIN',
        ],
      },
      fallback: {
        enabled: true,
        cacheEnabled: true,
        cacheTtl: 180000,
        degradedResponse: {
          success: true,
          degraded: true,
          message: 'User service temporarily unavailable',
          data: null,
        },
      },
    }
  );
  resilience.register('userService', userServiceManager);

  // Main Service (Legacy endpoints)
  const mainServiceManager = ResilienceManager.forHttpService(
    'mainService',
    serviceConfig.mainService.url,
    {
      serviceName: 'mainService',
      circuitBreaker: {
        threshold: 5,
        timeout: 15000,
        resetTimeout: 120000,
        monitoringWindow: 120000,
        volumeThreshold: 10,
        errorThreshold: 60,
      },
      retry: {
        maxAttempts: 2,
        baseDelay: 2000,
        maxDelay: 8000,
        backoffMultiplier: 2,
        jitter: true,
        retryableErrors: [
          'ECONNREFUSED',
          'ETIMEDOUT',
          'ENOTFOUND',
          'EHOSTUNREACH',
        ],
      },
      fallback: {
        enabled: true,
        cacheEnabled: true,
        cacheTtl: 600000,
        degradedResponse: {
          success: true,
          degraded: true,
          message: 'Service temporarily unavailable - please try again later',
          data: null,
        },
      },
    }
  );
  resilience.register('mainService', mainServiceManager);

  Logger.info('Resilience managers initialized for all downstream services');
};

initializeResilience();

if (testnetMvpScopeEnabled) {
  Logger.info(
    'TESTNET_MVP_SCOPE=true: nft/user gateway routes will use MAIN_SERVICE_URL unless explicit service URLs are provided'
  );
}

// Security middleware
app.use(helmet());
app.use(securityHeaders);
app.use(ipSecurityMiddleware);
app.use(requestValidation);
app.use(generalRateLimit);
app.use(speedLimiter);
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

// Logging and monitoring middleware
app.use(requestLogger);
app.use(securityLogger);
app.use(usageTracker);

// Authentication routes (no proxy needed) with strict rate limiting
app.use('/api/auth', authRateLimit, authRoutes);

// Monitoring routes (admin only)
app.use('/api/monitoring', monitoringRoutes);

// Security management routes (admin only)
app.use('/api/security', securityRoutes);

// Enhanced health check with resilience metrics
app.get('/health', async (req, res) => {
  const services = serviceDiscovery.getHealthStatus();
  const resilienceMetrics = resilience.getAllMetrics();

  const allHealthy = Object.values(services).every(
    (service: ServiceHealthStatus) => service.healthy
  );

  // Check resilience health
  const resilienceHealthy = Object.values(resilienceMetrics).every(
    metrics => metrics.circuit.state !== 'OPEN'
  );

  const overallHealthy = allHealthy && resilienceHealthy;

  res.status(overallHealthy ? 200 : 503).json({
    success: true,
    data: {
      status: overallHealthy ? 'healthy' : 'degraded',
      gateway: 'api-gateway',
      timestamp: new Date().toISOString(),
      services,
      resilience: {
        healthy: resilienceHealthy,
        metrics: Object.keys(resilienceMetrics).reduce(
          (acc, serviceName) => {
            const metrics = resilienceMetrics[serviceName];
            acc[serviceName] = {
              circuit: metrics.circuit.state,
              errorRate: Math.round(metrics.circuit.errorRate * 100) / 100,
              fallbacksActivated: metrics.fallbacksActivated,
              healthy: metrics.health.healthy,
            };
            return acc;
          },
          {} as Record<string, any>
        ),
      },
    },
  });
});

// Resilience metrics endpoint
app.get('/resilience/metrics', metricsMiddleware());

// Route to NFT Marketplace Service (public endpoints)
app.use('/api/nft', createServiceProxy('nftService', serviceDiscovery));

// Route to User Management Service (protected - requires authentication + rate limiting)
app.use(
  '/api/wallet',
  walletRateLimit,
  AuthMiddleware.verifyUserToken,
  createServiceProxy('userService', serviceDiscovery)
);

// Route remaining endpoints to main service (legacy fallback)
// Some endpoints require authentication
app.use(
  '/api/governance',
  AuthMiddleware.optionalAuth,
  createServiceProxy('mainService', serviceDiscovery)
);
app.use('/api/mining', createServiceProxy('mainService', serviceDiscovery));
app.use(
  '/api/bridges',
  bridgeRateLimit,
  AuthMiddleware.verifyUserToken,
  createServiceProxy('mainService', serviceDiscovery)
);
app.use(
  '/api/weather',
  AuthMiddleware.optionalAuth,
  createServiceProxy('mainService', serviceDiscovery)
);
app.use('/api/network', createServiceProxy('mainService', serviceDiscovery));
app.use('/api/validators', createServiceProxy('mainService', serviceDiscovery));
app.use(
  '/api/transactions',
  createServiceProxy('mainService', serviceDiscovery)
);
app.use('/api/stats', createServiceProxy('mainService', serviceDiscovery));

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Endpoint ${req.originalUrl} not found`,
    },
    timestamp: new Date().toISOString(),
  });
});

// Error logging middleware
app.use(errorLogger);

// Resilience error handler (before global error handler)
app.use(resilienceErrorHandler());

// Global error handler
app.use(
  (
    error: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    Logger.error('API Gateway error', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'GATEWAY_ERROR',
        message: 'An error occurred in the API gateway',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      },
      timestamp: new Date().toISOString(),
    });
  }
);

// Graceful shutdown
process.on('SIGTERM', () => {
  Logger.info('Shutting down API Gateway...');
  serviceDiscovery.stop();
  process.exit(0);
});

// Start server
async function startServer() {
  try {
    Logger.info('Starting API Gateway...');

    if (AuthService.isDemoSeedingEnabled()) {
      await AuthService.seedDemoUsers();
      Logger.info('Authentication service initialized with test demo users');
    } else {
      Logger.info('Authentication service initialized');
    }

    app.listen(PORT, () => {
      Logger.info(`API Gateway running on port ${PORT}`);
      Logger.info(`Health check: http://localhost:${PORT}/health`);
      Logger.info('Authentication endpoints: /api/auth/* (rate limited)');
      Logger.info('Monitoring endpoints: /api/monitoring/* (admin only)');
      Logger.info('Security management: /api/security/* (admin only)');
      Logger.info('Routing requests to microservices');
      Logger.info('NFT routes: /api/nft/* (public)');
      Logger.info('Wallet routes: /api/wallet/* (protected, rate limited)');
      Logger.info(
        'Bridge routes: /api/bridges/* (protected, strict rate limited)'
      );
      Logger.info('Legacy routes: /api/governance/*, /api/mining/*, etc.');
      // Log service discovery status
      const services = serviceDiscovery.getHealthStatus();
      Object.entries(services).forEach(
        ([name, service]: [string, ServiceHealthStatus]) => {
          Logger.service(
            name,
            'initial check',
            service.healthy ? 'healthy' : 'down'
          );
        }
      );

      // Log resilience status
      const resilienceMetrics = resilience.getAllMetrics();
      Object.entries(resilienceMetrics).forEach(([serviceName, metrics]) => {
        Logger.info(
          `Resilience for ${serviceName}: Circuit ${metrics.circuit.state}, Error Rate: ${metrics.circuit.errorRate.toFixed(2)}%`
        );
      });
    });
  } catch (error) {
    Logger.error('Failed to start API Gateway', error);
    process.exit(1);
  }
}

// Graceful shutdown handling
process.on('SIGTERM', () => {
  Logger.info('Received SIGTERM, shutting down gracefully...');

  // Shutdown resilience framework
  resilience.shutdown();

  // Stop service discovery
  serviceDiscovery.stop();

  Logger.info('API Gateway shutdown complete');
  process.exit(0);
});

process.on('SIGINT', () => {
  Logger.info('Received SIGINT, shutting down gracefully...');

  // Shutdown resilience framework
  resilience.shutdown();

  // Stop service discovery
  serviceDiscovery.stop();

  Logger.info('API Gateway shutdown complete');
  process.exit(0);
});

startServer();

export default app;
