import { createHandler } from 'graphql-http/lib/use/express';
import { buildSchema, print } from 'graphql';
import typeDefs from './schema/typeDefs.js';
import resolvers from './resolvers/index.js';
import type { Express, Request, Response, NextFunction } from 'express';
import {
  createGraphQLErrorFormatter,
  createGraphQLContext,
  createGraphQLPerformanceMonitor,
  createComplexityErrorHandler,
  createDepthErrorHandler,
} from './error-handling.js';
import { setupErrorHandling } from '../middleware/error-handler.js';
import {
  securityValidationRules,
  MAX_DEPTH,
  MAX_COMPLEXITY,
  MAX_BATCH_SIZE,
  IS_PRODUCTION,
  subscriptionTracker,
} from './security/validation-rules.js';
import { graphqlLogger } from '../utils/logger.js';

// Create schema from SDL
const schema = buildSchema(print(typeDefs));

// Configuration
const isProduction = IS_PRODUCTION;
const maxComplexity = MAX_COMPLEXITY;
const maxDepth = MAX_DEPTH;
const maxBatchSize = MAX_BATCH_SIZE;

// Create error handlers
const errorFormatter = createGraphQLErrorFormatter({
  enableStackTrace: !isProduction,
  enableSecurityMasking: true,
  enableDetailedErrors: !isProduction,
});

const complexityHandler = createComplexityErrorHandler(maxComplexity);
const depthHandler = createDepthErrorHandler(maxDepth);

/**
 * Middleware to limit HTTP request batching
 * Prevents batching attacks by limiting the number of operations in a single HTTP request
 */
function createBatchingLimitMiddleware(maxBatch: number = maxBatchSize) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Check if the body is an array (batched request)
    if (Array.isArray(req.body)) {
      if (req.body.length > maxBatch) {
        return res.status(400).json({
          errors: [
            {
              message: `Batch request limit exceeded. Maximum ${maxBatch} operations per request.`,
              extensions: {
                code: 'BATCH_LIMIT_EXCEEDED',
                maxBatch,
                actualBatch: req.body.length,
              },
            },
          ],
        });
      }
    }
    next();
  };
}

/**
 * Subscription rate limiting middleware
 * Limits the number of WebSocket connections per IP
 */
function createSubscriptionRateLimitMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientIP = req.ip || req.socket.remoteAddress || 'unknown';

    // Check for WebSocket upgrade requests
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      if (!subscriptionTracker.canConnect(clientIP)) {
        return res.status(429).json({
          errors: [
            {
              message: 'Too many subscription connections. Please try again later.',
              extensions: {
                code: 'SUBSCRIPTION_RATE_LIMIT_EXCEEDED',
              },
            },
          ],
        });
      }
    }

    next();
  };
}

// Function to set up GraphQL middleware
function setupGraphQLServer(app: Express): void {
  // Add error handling setup middleware
  app.use('/graphql', setupErrorHandling());

  // Add HTTP request body parsing for batch detection
  // Note: This assumes body-parser or express.json() middleware is used upstream
  app.use('/graphql', createBatchingLimitMiddleware(maxBatchSize));

  // Add subscription rate limiting for WebSocket upgrade requests
  app.use('/graphql', createSubscriptionRateLimitMiddleware());

  // GraphQL endpoint with comprehensive security validation
  (app as any).use(
    '/graphql',
    createHandler({
      schema,
      rootValue: resolvers,
      context: ((req: any, res: any) => createGraphQLContext(req, res)) as any,
      formatError: errorFormatter as any,
      // SECURITY: Enforce query depth, complexity, and introspection limits
      // These validation rules are dynamically built based on environment:
      // - Depth limit: MAX_DEPTH (default: 10)
      // - Complexity limit: MAX_COMPLEXITY (default: 1000)
      // - Batch limit: MAX_BATCH_SIZE (default: 10)
      // - Introspection: Disabled in production
      validationRules: securityValidationRules,
    })
  );

  // Log security configuration on startup
  graphqlLogger.info('GraphQL server set up with security hardening', {
    operation: 'graphql:server:startup',
    endpoint: '/graphql',
    maxQueryDepth: maxDepth,
    maxQueryComplexity: maxComplexity,
    maxBatchSize: maxBatchSize,
    introspection: isProduction ? 'disabled' : 'enabled',
    subscriptionRateLimiting: 'enabled',
  });
}

module.exports = {
  setupGraphQLServer,
};
