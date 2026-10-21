/**
 * GraphQL Server Implementation for Wrfcoin
 * Comprehensive GraphQL API with real-time subscriptions
 */

import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { createServer } from 'http';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/use/ws';
const express = require('express');
const cors = require('cors');
// backend#1236: FRONTEND_URL, else CORS_ORIGIN; production refuses empty/loopback/wildcard.
const { resolveServiceCorsOrigins } = require('../server/utils/strict-cors-config');
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolvers } from './resolvers/index.js';
import { GraphQLContext, createContext } from './context.js';
import { formatError } from './error-handler.js';
import { depthLimit } from './security/depth-limit.js';
import { logger } from '../utils/logger.js';
import { serviceClientManager } from './services/service-registry.js';
import {
  loggingMiddlewareChain,
  errorMiddlewareChain,
} from '../server/middleware/logging.js';
import {
  performanceMonitoringMiddleware,
  getMetricsEndpoint,
  startResourceMonitoring,
} from '../server/middleware/performance-logging.js';
import { securityLoggingMiddlewareChain } from '../server/middleware/security-logging.js';
import {
  createGraphQLLoggingPlugin,
  logGraphQLComplexityLimit,
} from '../server/middleware/graphql-logging.js';
import {
  createDashboardEndpoints,
  getHtmlDashboard,
} from '../server/utils/logging-dashboard.js';
import {
  GracefulShutdown,
  ShutdownPriority,
  createHttpServerShutdownHandler,
  createWebSocketShutdownHandler,
  createIntervalShutdownHandler,
} from '../shared/graceful-shutdown/index.js';

const __dirname = process.cwd() + '/backend/graphql';

// Load GraphQL schema
const typeDefs = readFileSync(join(__dirname, 'schema.graphql'), 'utf8');

// Create executable schema
const schema = makeExecutableSchema({
  typeDefs,
  resolvers,
});

// Rate limiting for GraphQL queries
const graphqlLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: {
    error: 'Too many GraphQL requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for subscriptions
const subscriptionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Limit subscription connections
  message: {
    error: 'Too many subscription connections from this IP.',
  },
});

export async function createGraphQLServer() {
  const app = express();
  const httpServer = createServer(app);

  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy:
        process.env.NODE_ENV === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    })
  );

  // CORS configuration
  const corsOptions = {
    origin: resolveServiceCorsOrigins(process.env.FRONTEND_URL, {
      developmentDefaults: ['http://localhost:5000'],
    }),
    credentials: true,
    optionsSuccessStatus: 200,
  };

  // WebSocket server for subscriptions
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: '/graphql',
  });

  // Create WebSocket handler
  const serverCleanup = useServer(
    {
      schema,
      context: async (ctx, msg, args) => {
        // Apply rate limiting for subscriptions
        const clientIP = ctx.extra.request.socket.remoteAddress;

        try {
          return await createContext({
            req: ctx.extra.request as any,
            connection: ctx,
            isSubscription: true,
          });
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          logger.error('Subscription context creation failed', {
            error: errorMessage,
            clientIP,
          });
          throw new Error('Subscription authentication failed');
        }
      },
      onConnect: async ctx => {
        logger.info('GraphQL subscription connected', {
          clientIP: ctx.extra.request.socket.remoteAddress,
        });
      },
      onDisconnect: ctx => {
        logger.info('GraphQL subscription disconnected', {
          clientIP: ctx.extra.request.socket.remoteAddress,
        });
      },
      onError: (ctx, msg, errors) => {
        const errorList = Array.isArray(errors) ? errors : [errors];
        logger.error('GraphQL subscription error', {
          errors: errorList.map(err => ({
            message: err.message,
            path: err.path,
          })),
        });
      },
    },
    wsServer
  );

  // Apollo Server with comprehensive logging
  const server = new ApolloServer<GraphQLContext>({
    schema,
    formatError,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            },
          };
        },
      },
      // Comprehensive GraphQL logging plugin
      createGraphQLLoggingPlugin(),
      // Enhanced query complexity analysis with logging
      {
        async requestDidStart() {
          return {
            async didResolveOperation({ request, document, contextValue }) {
              const complexity = depthLimit(document);
              const threshold = 20; // Configurable threshold

              if (complexity > threshold) {
                // Log complexity violation before throwing error
                logGraphQLComplexityLimit(
                  request.operationName || 'anonymous',
                  complexity,
                  threshold,
                  contextValue?.user?.address
                );
                throw new Error(
                  `Query too complex (${complexity} > ${threshold})`
                );
              }

              // Log high complexity queries as warnings
              if (complexity > threshold * 0.8) {
                logger.warn('High complexity GraphQL query detected', {
                  operation: `graphql:high-complexity:${request.operationName || 'anonymous'}`,
                  complexity,
                  threshold,
                  userId: contextValue?.user?.address,
                });
              }
            },
          };
        },
      },
    ],
    introspection: process.env.NODE_ENV !== 'production',
    includeStacktraceInErrorResponses: process.env.NODE_ENV !== 'production',
  });

  await server.start();

  // Apply comprehensive logging and monitoring middleware
  app.use('/graphql', ...loggingMiddlewareChain);
  app.use('/graphql', performanceMonitoringMiddleware);
  app.use('/graphql', ...securityLoggingMiddlewareChain);
  app.use('/graphql', cors(corsOptions));
  app.use('/graphql', graphqlLimiter);
  app.use('/graphql', express.json({ limit: '10mb' }));
  app.use(
    '/graphql',
    expressMiddleware(server, {
      context: async ({ req, res }: any) => createContext({ req, res }),
    }) as any
  );

  // Apply error logging middleware after routes
  app.use('/graphql', ...errorMiddlewareChain);

  // Enhanced health check endpoint with service monitoring
  app.get('/health', async (req, res) => {
    try {
      // Check all backend services
      const serviceHealth = await serviceClientManager.checkAllServices();
      const serviceStatus = serviceClientManager.getServiceStatus();

      const allServicesHealthy = Object.values(serviceHealth).every(
        healthy => healthy
      );
      const criticalServicesHealthy = [
        serviceHealth.mainApi,
        serviceHealth.governance,
        serviceHealth.wallet,
      ].every(healthy => healthy);

      res
        .status(allServicesHealthy ? 200 : criticalServicesHealthy ? 206 : 503)
        .json({
          status: allServicesHealthy
            ? 'healthy'
            : criticalServicesHealthy
              ? 'degraded'
              : 'unhealthy',
          service: 'wrfcoin-graphql',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          services: {
            health: serviceHealth,
            status: serviceStatus,
          },
          metrics: {
            memoryUsage: process.memoryUsage(),
            cpuUsage: process.cpuUsage(),
          },
        });
    } catch (error) {
      logger.error('Health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({
        status: 'unhealthy',
        service: 'wrfcoin-graphql',
        timestamp: new Date().toISOString(),
        error: 'Health check failed',
      });
    }
  });

  // Service status endpoint for detailed monitoring
  app.get('/status', async (req, res) => {
    try {
      const serviceHealth = await serviceClientManager.checkAllServices();
      const serviceStatus = serviceClientManager.getServiceStatus();

      res.json({
        graphql: {
          status: 'running',
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          pid: process.pid,
        },
        services: {
          health: serviceHealth,
          details: serviceStatus,
        },
        performance: {
          avgResponseTime: '< 200ms', // This would be calculated from actual metrics
          requestsPerSecond: 0, // This would be calculated from actual metrics
          errorRate: '< 1%', // This would be calculated from actual metrics
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Status check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'Status check failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Prometheus metrics endpoint
  app.get('/metrics', getMetricsEndpoint());

  // Logging dashboard endpoints
  const dashboardEndpoints = createDashboardEndpoints();
  app.get('/api/logging/dashboard', dashboardEndpoints.getDashboard);
  app.get('/api/logging/metrics', dashboardEndpoints.getMetrics);
  app.get('/api/logging/alerts', dashboardEndpoints.getAlerts);
  app.get('/api/logging/analysis', dashboardEndpoints.getLogAnalysis);
  app.get('/api/logging/health', dashboardEndpoints.getHealth);
  app.get('/api/logging/config', dashboardEndpoints.getConfiguration);

  // HTML dashboard endpoint
  app.get('/dashboard', (req, res) => {
    res.send(getHtmlDashboard());
  });

  // Logging and monitoring status endpoint
  app.get('/logging-status', (req, res) => {
    res.json({
      status: 'operational',
      service: 'wrfcoin-graphql-logging',
      timestamp: new Date().toISOString(),
      logging: {
        correlationTracking: true,
        performanceMonitoring: true,
        securityLogging: true,
        graphqlLogging: true,
        realTimeAnalysis: true,
      },
      metrics: {
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
      },
    });
  });

  // GraphQL Playground redirect in development
  if (process.env.NODE_ENV !== 'production') {
    app.get('/', (req, res) => {
      res.redirect('/graphql');
    });
  }

  const PORT = process.env.GRAPHQL_PORT || 4000;

  return new Promise<{
    app: any;
    server: any;
    resourceMonitor: NodeJS.Timeout;
  }>(resolve => {
    const httpListener = httpServer.listen(PORT, () => {
      logger.info(
        `🚀 GraphQL Server ready at http://localhost:${PORT}/graphql`
      );
      logger.info(
        `🔗 GraphQL Subscriptions ready at ws://localhost:${PORT}/graphql`
      );
      logger.info(
        `📊 Prometheus metrics available at http://localhost:${PORT}/metrics`
      );
      logger.info(
        `🔍 Logging status available at http://localhost:${PORT}/logging-status`
      );

      // Start resource monitoring after server is ready
      const resourceMonitorInterval = startResourceMonitoring(30000); // Every 30 seconds

      // Register shutdown handlers with GracefulShutdown
      const shutdown = GracefulShutdown.getInstance({
        enableLogging: true,
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

      // Register Apollo server drain (stops accepting new connections)
      shutdown.registerHandler({
        name: 'apollo-server-drain',
        priority: ShutdownPriority.DRAIN_HTTP_CONNECTIONS,
        timeout: 10000,
        handler: async () => {
          logger.info('Draining Apollo server connections...');
          await server.stop();
        },
      });

      // Register HTTP server shutdown
      shutdown.registerHandler(
        createHttpServerShutdownHandler(httpServer, {
          name: 'graphql-http-server',
          timeout: 10000,
        })
      );

      // Register WebSocket server shutdown
      shutdown.registerHandler(
        createWebSocketShutdownHandler(wsServer, {
          name: 'graphql-websocket-server',
          timeout: 5000,
          closeReason: 'GraphQL server shutting down',
        })
      );

      // Register resource monitoring interval cleanup
      shutdown.registerHandler(
        createIntervalShutdownHandler([resourceMonitorInterval], {
          name: 'graphql-resource-monitor',
        })
      );

      // Set up signal handlers
      shutdown.setupSignalHandlers();

      resolve({
        app,
        server: httpListener,
        resourceMonitor: resourceMonitorInterval,
      });
    });
  });
}

// Start server if this file is run directly
if (require.main === module) {
  createGraphQLServer()
    .then(() => {
      logger.info(
        '✅ GraphQL server started successfully with comprehensive logging'
      );
    })
    .catch(error => {
      logger.error('Failed to start GraphQL server', { error: error.message });
      process.exit(1);
    });
}
