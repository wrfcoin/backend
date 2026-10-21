/**
 * GraphQL Query Complexity Middleware
 *
 * Limits query complexity to prevent resource exhaustion attacks
 * and ensure consistent API performance.
 */

import { GraphQLError } from 'graphql';
import { Counter, Histogram } from 'prom-client';
import { graphqlLogger } from '../utils/logger.js';

// Optional dependency - gracefully degrade if not installed
let getComplexity: any = null;
let fieldExtensionsEstimator: any = null;
let simpleEstimator: any = null;

(async () => {
  try {
    const complexityModule = await import('graphql-query-complexity');
    getComplexity = complexityModule.getComplexity;
    fieldExtensionsEstimator = complexityModule.fieldExtensionsEstimator;
    simpleEstimator = complexityModule.simpleEstimator;
  } catch {
    graphqlLogger.warn('graphql-query-complexity not installed. Complexity limiting disabled.', {
      operation: 'graphql:complexity:module-load',
      suggestion: 'Install with: npm install graphql-query-complexity',
    });
  }
})();

// Prometheus metrics for query complexity
export const complexityMetrics = {
  queryComplexity: new Histogram({
    name: 'wrfcoin_graphql_query_complexity',
    help: 'Distribution of GraphQL query complexity scores',
    labelNames: ['operation_name'],
    buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000],
  }),

  rejectedQueries: new Counter({
    name: 'wrfcoin_graphql_rejected_queries_total',
    help: 'Total number of GraphQL queries rejected due to complexity',
    labelNames: ['reason'],
  }),

  queryDepth: new Histogram({
    name: 'wrfcoin_graphql_query_depth',
    help: 'Distribution of GraphQL query depth',
    labelNames: ['operation_name'],
    buckets: [1, 2, 3, 5, 7, 10, 15, 20],
  }),
};

// Configuration for complexity limits
export interface ComplexityConfig {
  maxComplexity: number;
  maxDepth: number;
  maxAliases: number;
  allowIntrospection: boolean;
  fieldCosts: Record<string, number>;
  estimators: {
    field: boolean;
    simple: boolean;
    defaultCost: number;
    multiplyByListSize: boolean;
  };
}

// Default configuration
const DEFAULT_CONFIG: ComplexityConfig = {
  maxComplexity: 1000,
  maxDepth: 10,
  maxAliases: 5,
  allowIntrospection: process.env.NODE_ENV !== 'production',
  fieldCosts: {
    // High-cost operations
    'Query.wrfToken': 10,
    'Query.tokenBalance': 5,
    'WRFToken.weatherStations': 20,
    'WRFToken.proposals': 15,
    'WRFToken.votes': 15,
    'WRFToken.performance': 10,
    // Medium-cost operations
    'Query.weatherData': 10,
    'Query.bridgeTransactions': 15,
    'Query.computeJobs': 10,
    // Low-cost operations
    'Query.currentUser': 1,
    'Query.health': 1,
  },
  estimators: {
    field: true,
    simple: true,
    defaultCost: 1,
    multiplyByListSize: true,
  },
};

/**
 * Calculate query depth recursively
 */
function calculateDepth(
  selectionSet: any,
  fragments: Record<string, any>,
  currentDepth: number = 0
): number {
  if (!selectionSet || !selectionSet.selections) {
    return currentDepth;
  }

  let maxDepth = currentDepth;

  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      if (selection.selectionSet) {
        const depth = calculateDepth(
          selection.selectionSet,
          fragments,
          currentDepth + 1
        );
        maxDepth = Math.max(maxDepth, depth);
      }
    } else if (selection.kind === 'FragmentSpread') {
      const fragment = fragments[selection.name.value];
      if (fragment) {
        const depth = calculateDepth(
          fragment.selectionSet,
          fragments,
          currentDepth
        );
        maxDepth = Math.max(maxDepth, depth);
      }
    } else if (selection.kind === 'InlineFragment') {
      const depth = calculateDepth(
        selection.selectionSet,
        fragments,
        currentDepth
      );
      maxDepth = Math.max(maxDepth, depth);
    }
  }

  return maxDepth;
}

/**
 * Count field aliases in the query
 */
function countAliases(
  selectionSet: any,
  fragments: Record<string, any>
): number {
  if (!selectionSet || !selectionSet.selections) {
    return 0;
  }

  let count = 0;

  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      if (selection.alias) {
        count++;
      }
      if (selection.selectionSet) {
        count += countAliases(selection.selectionSet, fragments);
      }
    } else if (selection.kind === 'FragmentSpread') {
      const fragment = fragments[selection.name.value];
      if (fragment) {
        count += countAliases(fragment.selectionSet, fragments);
      }
    } else if (selection.kind === 'InlineFragment') {
      count += countAliases(selection.selectionSet, fragments);
    }
  }

  return count;
}

/**
 * Check for introspection queries
 */
function isIntrospectionQuery(document: any): boolean {
  return document.definitions.some((def: any) => {
    if (def.kind !== 'OperationDefinition') return false;
    return def.selectionSet.selections.some((selection: any) => {
      return (
        selection.kind === 'Field' &&
        (selection.name.value === '__schema' ||
          selection.name.value === '__type')
      );
    });
  });
}

/**
 * GraphQL Complexity Plugin for Apollo Server
 */
export function createComplexityPlugin(config: Partial<ComplexityConfig> = {}) {
  const finalConfig: ComplexityConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    async requestDidStart() {
      return {
        async didResolveOperation(requestContext: any) {
          const { request, document, schema } = requestContext;

          // Build fragments map
          const fragments: Record<string, any> = {};
          for (const def of document.definitions) {
            if (def.kind === 'FragmentDefinition') {
              fragments[def.name.value] = def;
            }
          }

          // Get operation name
          const operationName =
            request.operationName ||
            document.definitions.find(
              (def: any) => def.kind === 'OperationDefinition'
            )?.name?.value ||
            'anonymous';

          // Check introspection
          if (isIntrospectionQuery(document)) {
            if (!finalConfig.allowIntrospection) {
              complexityMetrics.rejectedQueries.inc({ reason: 'introspection' });
              throw new GraphQLError('Introspection is disabled', {
                extensions: {
                  code: 'GRAPHQL_INTROSPECTION_DISABLED',
                },
              });
            }
            return; // Skip other checks for introspection
          }

          // Calculate query depth
          const operationDef = document.definitions.find(
            (def: any) => def.kind === 'OperationDefinition'
          );
          if (operationDef) {
            const depth = calculateDepth(operationDef.selectionSet, fragments);
            complexityMetrics.queryDepth.observe(
              { operation_name: operationName },
              depth
            );

            if (depth > finalConfig.maxDepth) {
              complexityMetrics.rejectedQueries.inc({ reason: 'depth' });
              throw new GraphQLError(
                `Query depth (${depth}) exceeds maximum allowed (${finalConfig.maxDepth})`,
                {
                  extensions: {
                    code: 'QUERY_TOO_DEEP',
                    maxDepth: finalConfig.maxDepth,
                    actualDepth: depth,
                  },
                }
              );
            }

            // Count aliases
            const aliasCount = countAliases(operationDef.selectionSet, fragments);
            if (aliasCount > finalConfig.maxAliases) {
              complexityMetrics.rejectedQueries.inc({ reason: 'aliases' });
              throw new GraphQLError(
                `Too many aliases (${aliasCount}), maximum allowed is ${finalConfig.maxAliases}`,
                {
                  extensions: {
                    code: 'TOO_MANY_ALIASES',
                    maxAliases: finalConfig.maxAliases,
                    actualAliases: aliasCount,
                  },
                }
              );
            }
          }

          // Calculate complexity using graphql-query-complexity (if available)
          if (!getComplexity) {
            // Module not installed, skip complexity check
            return;
          }

          try {
            const estimators: any[] = [];

            if (finalConfig.estimators.field && fieldExtensionsEstimator) {
              estimators.push(fieldExtensionsEstimator());
            }

            if (finalConfig.estimators.simple && simpleEstimator) {
              estimators.push(
                simpleEstimator({
                  defaultComplexity: finalConfig.estimators.defaultCost,
                })
              );
            }

            const complexity = getComplexity({
              schema,
              query: document,
              variables: request.variables || {},
              estimators,
            });

            // Record complexity metric
            complexityMetrics.queryComplexity.observe(
              { operation_name: operationName },
              complexity
            );

            // Check against limit
            if (complexity > finalConfig.maxComplexity) {
              complexityMetrics.rejectedQueries.inc({ reason: 'complexity' });
              throw new GraphQLError(
                `Query complexity (${complexity}) exceeds maximum allowed (${finalConfig.maxComplexity})`,
                {
                  extensions: {
                    code: 'QUERY_TOO_COMPLEX',
                    maxComplexity: finalConfig.maxComplexity,
                    actualComplexity: complexity,
                  },
                }
              );
            }
          } catch (error) {
            // If it's already a GraphQL error from complexity, rethrow
            if (error instanceof GraphQLError) {
              throw error;
            }
            // Log other errors but don't block the request
            graphqlLogger.warn('Complexity calculation error', {
              operation: 'graphql:complexity:calculation',
              error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
            });
          }
        },
      };
    },
  };
}

/**
 * Express middleware for pre-validation of GraphQL queries
 */
export function graphqlComplexityMiddleware(
  config: Partial<ComplexityConfig> = {}
) {
  const finalConfig: ComplexityConfig = { ...DEFAULT_CONFIG, ...config };

  return (req: any, res: any, next: any) => {
    // Quick checks before parsing
    const body = req.body;
    if (!body || !body.query) {
      return next();
    }

    const query = body.query;

    // Quick string-based checks
    // Check for obvious attack patterns
    const depthIndicator = (query.match(/{/g) || []).length;
    if (depthIndicator > finalConfig.maxDepth * 3) {
      complexityMetrics.rejectedQueries.inc({ reason: 'pre_validation_depth' });
      return res.status(400).json({
        errors: [
          {
            message: 'Query appears to be too deeply nested',
            extensions: {
              code: 'QUERY_PRE_VALIDATION_FAILED',
            },
          },
        ],
      });
    }

    // Check query size
    if (query.length > 100000) {
      // 100KB limit
      complexityMetrics.rejectedQueries.inc({ reason: 'query_too_large' });
      return res.status(413).json({
        errors: [
          {
            message: 'Query is too large',
            extensions: {
              code: 'QUERY_TOO_LARGE',
              maxSize: 100000,
              actualSize: query.length,
            },
          },
        ],
      });
    }

    next();
  };
}

/**
 * Rate limiting configuration for GraphQL operations
 */
export const operationRateLimits = {
  // Heavy operations - stricter limits
  heavyOperations: {
    'Query.wrfToken': { windowMs: 60000, max: 30 },
    'Query.tokenBalance': { windowMs: 60000, max: 60 },
    'WRFToken.weatherStations': { windowMs: 60000, max: 20 },
    'WRFToken.proposals': { windowMs: 60000, max: 30 },
    'Mutation.createProposal': { windowMs: 60000, max: 5 },
    'Mutation.vote': { windowMs: 60000, max: 20 },
  },
  // Normal operations
  normalOperations: {
    windowMs: 60000,
    max: 100,
  },
};

export { DEFAULT_CONFIG as defaultComplexityConfig };
