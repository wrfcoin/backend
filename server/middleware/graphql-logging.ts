/**
 * GraphQL Logging Integration - Task 67.4
 *
 * Comprehensive GraphQL operation logging, performance monitoring,
 * and security tracking for the WRFCoin GraphQL API.
 */

import { Request, Response } from 'express';
import { GraphQLRequestContext, GraphQLRequestListener } from '@apollo/server';
import {
  graphqlLogger,
  logGraphQLOperation,
  logError,
  getCorrelationId,
  LogMetadata,
} from '../utils/logger.js';
import { logPerformanceMetrics } from '../utils/logger.js';
import { logSecurityEvent, SecurityEventType } from './security-logging.js';

// GraphQL operation complexity analyzer
function calculateComplexity(query: string): number {
  // Simple complexity calculation based on query structure
  const depthMatches = query.match(/\{/g) || [];
  const fieldMatches = query.match(/\w+\s*\{/g) || [];
  const argMatches = query.match(/\(\s*\w+\s*:/g) || [];

  return depthMatches.length + fieldMatches.length + argMatches.length * 0.5;
}

// Extract operation details from GraphQL query
function extractOperationDetails(query: string, operationName?: string) {
  const operationMatch = query.match(/(query|mutation|subscription)\s+(\w+)?/);
  const detectedType = operationMatch?.[1] || 'query';
  const detectedName = operationMatch?.[2] || operationName || 'anonymous';

  // Extract field selections
  const fieldMatches = query.match(/\{\s*(\w+)/g) || [];
  const fields = fieldMatches.map(match => match.replace(/\{\s*/, ''));

  return {
    type: detectedType as 'query' | 'mutation' | 'subscription',
    name: detectedName,
    fields: fields.slice(0, 10), // Limit to first 10 fields
    complexity: calculateComplexity(query),
  };
}

// GraphQL request logging plugin
export function createGraphQLLoggingPlugin() {
  return {
    async requestDidStart(
      requestContext: GraphQLRequestContext<any>
    ): Promise<GraphQLRequestListener<any> | void> {
      const startTime = Date.now();
      const correlationId = getCorrelationId();

      return {
        async didResolveOperation(requestContext) {
          const { request, document } = requestContext;

          if (!document || !request.query) return;

          const operationDetails = extractOperationDetails(
            request.query,
            request.operationName || undefined
          );

          // Check for potentially dangerous operations
          const isDangerous =
            operationDetails.complexity > 20 ||
            operationDetails.fields.some(field =>
              ['admin', 'secret', 'private', 'delete', 'drop'].some(danger =>
                field.toLowerCase().includes(danger)
              )
            );

          if (isDangerous) {
            logSecurityEvent(
              SecurityEventType.SUSPICIOUS_ACTIVITY,
              {
                graphqlOperation: operationDetails.name,
                operationType: operationDetails.type,
                complexity: operationDetails.complexity,
                suspiciousFields: operationDetails.fields,
                query: request.query.substring(0, 500), // First 500 chars
              },
              'warn',
              requestContext.contextValue?.user?.id,
              requestContext.contextValue?.req?.ip
            );
          }

          // Log operation start
          graphqlLogger.info(
            `GraphQL ${operationDetails.type} started: ${operationDetails.name}`,
            {
              operation: `graphql:${operationDetails.type}:${operationDetails.name}`,
              correlationId,
              userId: requestContext.contextValue?.user?.id,
              graphql: {
                operationType: operationDetails.type,
                operationName: operationDetails.name,
                complexity: operationDetails.complexity,
                variables: request.variables,
                fields: operationDetails.fields,
              },
            }
          );
        },

        async didEncounterErrors(requestContext) {
          const { request, errors } = requestContext;
          const duration = Date.now() - startTime;

          if (!request.query) return;

          const operationDetails = extractOperationDetails(
            request.query,
            request.operationName || undefined
          );

          // Log each error
          errors.forEach((error, index) => {
            logError(
              graphqlLogger,
              `GraphQL error in ${operationDetails.type} ${operationDetails.name}`,
              error,
              {
                operation: `graphql:error:${operationDetails.type}:${operationDetails.name}`,
                correlationId,
                userId: requestContext.contextValue?.user?.id,
                duration,
                graphql: {
                  operationType: operationDetails.type,
                  operationName: operationDetails.name,
                  complexity: operationDetails.complexity,
                  variables: request.variables,
                  resolverPath: error.path as string[] | undefined,
                },
                error: {
                  name: error.name,
                  message: error.message,
                  code: error.extensions?.code as string,
                  category: 'business',
                  severity: 'medium',
                },
              }
            );
          });

          // Log security-related errors separately
          const securityErrors = errors.filter(
            error =>
              error.message.includes('Unauthorized') ||
              error.message.includes('Forbidden') ||
              error.message.includes('Authentication') ||
              error.extensions?.code === 'UNAUTHENTICATED' ||
              error.extensions?.code === 'FORBIDDEN'
          );

          if (securityErrors.length > 0) {
            logSecurityEvent(
              SecurityEventType.AUTHORIZATION_FAILURE,
              {
                graphqlOperation: operationDetails.name,
                operationType: operationDetails.type,
                errorCount: securityErrors.length,
                errorMessages: securityErrors.map(e => e.message),
              },
              'warn',
              requestContext.contextValue?.user?.id,
              requestContext.contextValue?.req?.ip
            );
          }
        },

        async willSendResponse(requestContext) {
          const { request, response } = requestContext;
          const duration = Date.now() - startTime;

          if (!request.query) return;

          const operationDetails = extractOperationDetails(
            request.query,
            request.operationName || undefined
          );

          const hasErrors =
            response.body.kind === 'single' &&
            response.body.singleResult.errors &&
            response.body.singleResult.errors.length > 0;

          const level = hasErrors ? 'warn' : 'info';
          const status = hasErrors ? 'error' : 'success';

          // Log operation completion
          graphqlLogger.log(
            level,
            `GraphQL ${operationDetails.type} completed: ${operationDetails.name} (${duration}ms)`,
            {
              operation: `graphql:${operationDetails.type}:${operationDetails.name}`,
              correlationId,
              userId: requestContext.contextValue?.user?.id,
              duration,
              status,
              graphql: {
                operationType: operationDetails.type,
                operationName: operationDetails.name,
                complexity: operationDetails.complexity,
                variables: request.variables,
                fields: operationDetails.fields,
                errorCount: hasErrors
                  ? (response.body as any).errors?.length
                  : 0,
              },
              performance: {
                responseTime: duration,
                memoryUsage: process.memoryUsage(),
              },
            }
          );

          // Use the helper function for structured logging
          logGraphQLOperation(
            operationDetails.type,
            operationDetails.name,
            duration,
            operationDetails.complexity,
            request.variables,
            requestContext.contextValue?.user?.id
          );

          // Log performance metrics
          logPerformanceMetrics(
            `GraphQL ${operationDetails.type} ${operationDetails.name}`,
            duration,
            process.memoryUsage(),
            {
              complexity: operationDetails.complexity,
              fieldCount: operationDetails.fields.length,
              hasErrors,
              errorCount: hasErrors ? (response.body as any).errors?.length : 0,
            }
          );

          // Log slow operations
          if (duration > 1000) {
            graphqlLogger.warn(
              `Slow GraphQL operation: ${operationDetails.name} (${duration}ms)`,
              {
                operation: `graphql:slow:${operationDetails.type}:${operationDetails.name}`,
                correlationId,
                userId: requestContext.contextValue?.user?.id,
                duration,
                graphql: {
                  operationType: operationDetails.type,
                  operationName: operationDetails.name,
                  complexity: operationDetails.complexity,
                  variables: request.variables,
                },
                performance: {
                  responseTime: duration,
                },
              }
            );
          }
        },

        // willSendResponse already defined above
      };
    },
  };
}

// GraphQL subscription logging
export function logGraphQLSubscription(
  operationName: string,
  userId?: string,
  event: 'start' | 'data' | 'complete' | 'error' = 'start',
  error?: Error
): void {
  const level = error ? 'error' : event === 'error' ? 'warn' : 'info';

  graphqlLogger.log(level, `GraphQL subscription ${event}: ${operationName}`, {
    operation: `graphql:subscription:${operationName}:${event}`,
    correlationId: getCorrelationId(),
    userId,
    graphql: {
      operationType: 'subscription',
      operationName,
      subscriptionEvent: event,
    },
    error: error
      ? {
          name: error.name,
          message: error.message,
          category: 'subscription',
          severity: 'medium',
        }
      : undefined,
  });
}

// GraphQL rate limiting logging
export function logGraphQLRateLimit(
  operationName: string,
  userId: string | undefined,
  limit: number,
  current: number,
  windowMs: number
): void {
  logSecurityEvent(
    SecurityEventType.RATE_LIMIT_EXCEEDED,
    {
      graphqlOperation: operationName,
      operationType: 'rate_limit',
      limit,
      current,
      windowMs,
    },
    'warn',
    userId
  );
}

// GraphQL depth/complexity limit logging
export function logGraphQLComplexityLimit(
  operationName: string,
  complexity: number,
  limit: number,
  userId?: string
): void {
  logSecurityEvent(
    SecurityEventType.SUSPICIOUS_ACTIVITY,
    {
      graphqlOperation: operationName,
      operationType: 'complexity_limit',
      complexity,
      limit,
      reason: 'Query complexity exceeded limit',
    },
    'warn',
    userId
  );
}

// GraphQL authentication logging
export function logGraphQLAuthentication(
  operationName: string,
  authMethod: string,
  success: boolean,
  userId?: string,
  error?: string
): void {
  const eventType = success
    ? SecurityEventType.AUTHENTICATION_SUCCESS
    : SecurityEventType.AUTHENTICATION_FAILURE;

  logSecurityEvent(
    eventType,
    {
      graphqlOperation: operationName,
      authMethod,
      error,
    },
    success ? 'info' : 'warn',
    userId
  );
}

// Export logging utilities
export { calculateComplexity, extractOperationDetails };
