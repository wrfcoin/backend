/**
 * GraphQL Security Validation Rules - Task 103.7
 *
 * Implements comprehensive security measures for GraphQL:
 * - Query depth limiting
 * - Query complexity limiting
 * - Introspection disabling in production
 * - Query batching limits
 * - Subscription rate limiting
 */

import {
  ValidationContext,
  ValidationRule,
  GraphQLError,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  InlineFragmentNode,
  OperationDefinitionNode,
  Kind,
  TypeInfo,
  visit,
  visitWithTypeInfo,
  getNamedType,
  isObjectType,
  isListType,
  isNonNullType,
  GraphQLObjectType,
  GraphQLOutputType,
} from 'graphql';
import { graphqlLogger } from '../../utils/logger.js';

// Configuration from environment
const MAX_DEPTH = parseInt(process.env.GRAPHQL_MAX_DEPTH || '10', 10);
const MAX_COMPLEXITY = parseInt(process.env.GRAPHQL_MAX_COMPLEXITY || '1000', 10);
const MAX_BATCH_SIZE = parseInt(process.env.GRAPHQL_MAX_BATCH_SIZE || '10', 10);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Custom complexity weights for expensive fields
 */
const FIELD_COMPLEXITY_WEIGHTS: Record<string, number> = {
  // High-cost queries that fetch lists or perform complex operations
  blocks: 5,
  transactions: 5,
  users: 3,
  computationalNFTs: 4,
  weatherData: 3,
  governanceProposals: 3,
  miningPools: 2,
  walletTransactions: 4,
  pendingTransactions: 3,
  nftExecutionHistory: 5,
  topPerformingNFTs: 4,
  nftMarketplace: 3,
  executionHistory: 5,
  recentExecutions: 4,
  // Nested object fields
  nfts: 3,
  votes: 2,
  performance: 2,
  metadata: 1,
  // Default for unlisted fields
  default: 1,
};

/**
 * Creates a depth limit validation rule for GraphQL queries
 *
 * @param maxDepth - Maximum allowed query depth (default: 10)
 * @returns ValidationRule that rejects queries exceeding the depth limit
 */
export function createDepthLimitRule(maxDepth: number = MAX_DEPTH): ValidationRule {
  return function DepthLimitRule(context: ValidationContext): any {
    const definitions = context.getDocument().definitions;
    const fragments: Record<string, FragmentDefinitionNode> = {};

    // Collect all fragment definitions first
    for (const definition of definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments[definition.name.value] = definition;
      }
    }

    /**
     * Recursively calculates the depth of a selection set
     */
    function calculateDepth(
      node: FieldNode | InlineFragmentNode | FragmentDefinitionNode | OperationDefinitionNode,
      currentDepth: number,
      visitedFragments: Set<string> = new Set()
    ): number {
      if (!('selectionSet' in node) || !node.selectionSet) {
        return currentDepth;
      }

      let maxChildDepth = currentDepth;

      for (const selection of node.selectionSet.selections) {
        let childDepth = currentDepth;

        if (selection.kind === Kind.FIELD) {
          // Field nodes increase depth
          childDepth = calculateDepth(selection, currentDepth + 1, visitedFragments);
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          // Inline fragments don't increase depth themselves
          childDepth = calculateDepth(selection, currentDepth, visitedFragments);
        } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
          // Handle fragment spreads with cycle detection
          const fragmentName = selection.name.value;
          if (!visitedFragments.has(fragmentName) && fragments[fragmentName]) {
            visitedFragments.add(fragmentName);
            childDepth = calculateDepth(
              fragments[fragmentName],
              currentDepth,
              visitedFragments
            );
          }
        }

        maxChildDepth = Math.max(maxChildDepth, childDepth);
      }

      return maxChildDepth;
    }

    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const depth = calculateDepth(node, 0);

        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query depth limit exceeded. Maximum depth: ${maxDepth}, actual depth: ${depth}`,
              {
                nodes: [node],
                extensions: {
                  code: 'QUERY_DEPTH_EXCEEDED',
                  maxDepth,
                  actualDepth: depth,
                },
              }
            )
          );
        }
      },
    };
  };
}

/**
 * Creates a complexity limit validation rule for GraphQL queries
 *
 * @param maxComplexity - Maximum allowed query complexity (default: 1000)
 * @param onCost - Optional callback when cost is calculated
 * @returns ValidationRule that rejects queries exceeding the complexity limit
 */
export function createComplexityLimitRule(
  maxComplexity: number = MAX_COMPLEXITY,
  options: {
    onCost?: (cost: number, operationName?: string) => void;
    formatErrorMessage?: (cost: number, max: number) => string;
  } = {}
): ValidationRule {
  return function ComplexityLimitRule(context: ValidationContext): any {
    const schema = context.getSchema();
    const typeInfo = new TypeInfo(schema);
    const definitions = context.getDocument().definitions;
    const fragments: Record<string, FragmentDefinitionNode> = {};

    // Collect fragment definitions
    for (const definition of definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments[definition.name.value] = definition;
      }
    }

    /**
     * Get the complexity weight for a field
     */
    function getFieldComplexity(fieldName: string, args: Record<string, any> = {}): number {
      const baseWeight = FIELD_COMPLEXITY_WEIGHTS[fieldName] || FIELD_COMPLEXITY_WEIGHTS.default;

      // Increase complexity for pagination arguments
      let multiplier = 1;
      if (args.limit && typeof args.limit === 'number') {
        multiplier = Math.max(1, Math.ceil(args.limit / 10));
      }
      if (args.first && typeof args.first === 'number') {
        multiplier = Math.max(1, Math.ceil(args.first / 10));
      }

      return baseWeight * multiplier;
    }

    /**
     * Calculate complexity recursively
     */
    function calculateComplexity(
      node: FieldNode | InlineFragmentNode | FragmentDefinitionNode | OperationDefinitionNode,
      parentType: GraphQLOutputType | null,
      visitedFragments: Set<string> = new Set()
    ): number {
      if (!('selectionSet' in node) || !node.selectionSet) {
        return 0;
      }

      let totalComplexity = 0;

      for (const selection of node.selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          const fieldName = selection.name.value;

          // Skip __typename as it's always cheap
          if (fieldName.startsWith('__')) {
            continue;
          }

          // Get arguments for complexity calculation
          const args: Record<string, any> = {};
          if (selection.arguments) {
            for (const arg of selection.arguments) {
              if (arg.value.kind === Kind.INT) {
                args[arg.name.value] = parseInt(arg.value.value, 10);
              } else if (arg.value.kind === Kind.STRING) {
                args[arg.name.value] = arg.value.value;
              }
            }
          }

          // Base field complexity
          let fieldComplexity = getFieldComplexity(fieldName, args);

          // Add child complexity
          if (selection.selectionSet) {
            fieldComplexity += calculateComplexity(selection, null, visitedFragments);
          }

          // Check if field returns a list (adds multiplier)
          const namedType = parentType ? getNamedType(parentType) : null;
          if (namedType && isObjectType(namedType)) {
            const field = (namedType as GraphQLObjectType).getFields()[fieldName];
            if (field) {
              const fieldType = field.type;
              const unwrappedType = isNonNullType(fieldType) ? fieldType.ofType : fieldType;
              if (isListType(unwrappedType)) {
                // Lists are more expensive - apply multiplier
                fieldComplexity *= 2;
              }
            }
          }

          totalComplexity += fieldComplexity;
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          totalComplexity += calculateComplexity(selection, parentType, visitedFragments);
        } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
          const fragmentName = selection.name.value;
          if (!visitedFragments.has(fragmentName) && fragments[fragmentName]) {
            visitedFragments.add(fragmentName);
            totalComplexity += calculateComplexity(
              fragments[fragmentName],
              parentType,
              visitedFragments
            );
          }
        }
      }

      return totalComplexity;
    }

    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const operationName = node.name?.value;

        // Calculate total complexity
        const cost = calculateComplexity(node, null);

        // Call optional cost callback
        if (options.onCost) {
          options.onCost(cost, operationName);
        }

        // Check against limit
        if (cost > maxComplexity) {
          const message = options.formatErrorMessage
            ? options.formatErrorMessage(cost, maxComplexity)
            : `Query complexity limit exceeded. Maximum complexity: ${maxComplexity}, actual complexity: ${cost}`;

          context.reportError(
            new GraphQLError(message, {
              nodes: [node],
              extensions: {
                code: 'QUERY_COMPLEXITY_EXCEEDED',
                maxComplexity,
                actualComplexity: cost,
                operationName,
              },
            })
          );
        }
      },
    };
  };
}

/**
 * Creates an introspection disabling rule for production
 *
 * @returns ValidationRule that rejects introspection queries in production
 */
export function createNoIntrospectionRule(): ValidationRule {
  return function NoIntrospectionRule(context: ValidationContext): any {
    return {
      Field(node: FieldNode) {
        const fieldName = node.name.value;

        // Block __schema and __type introspection queries
        if (fieldName === '__schema' || fieldName === '__type') {
          context.reportError(
            new GraphQLError('GraphQL introspection is disabled in production', {
              nodes: [node],
              extensions: {
                code: 'INTROSPECTION_DISABLED',
              },
            })
          );
        }
      },
    };
  };
}

/**
 * Creates a query batching limit rule
 *
 * Note: This checks operation count in a single document.
 * For HTTP batching limits, see the middleware implementation.
 *
 * @param maxOperations - Maximum allowed operations per request (default: 10)
 * @returns ValidationRule that rejects documents with too many operations
 */
export function createBatchLimitRule(maxOperations: number = MAX_BATCH_SIZE): ValidationRule {
  return function BatchLimitRule(context: ValidationContext): any {
    const operations = context.getDocument().definitions.filter(
      def => def.kind === Kind.OPERATION_DEFINITION
    );

    if (operations.length > maxOperations) {
      // Report on the first operation node
      const firstOp = operations[0] as OperationDefinitionNode;
      context.reportError(
        new GraphQLError(
          `Query batching limit exceeded. Maximum operations per request: ${maxOperations}, actual: ${operations.length}`,
          {
            nodes: [firstOp],
            extensions: {
              code: 'BATCH_LIMIT_EXCEEDED',
              maxOperations,
              actualOperations: operations.length,
            },
          }
        )
      );
    }

    return {};
  };
}

/**
 * Subscription connection tracker for rate limiting
 */
class SubscriptionConnectionTracker {
  private connections: Map<string, { count: number; lastReset: number }> = new Map();
  private readonly maxConnectionsPerIP: number;
  private readonly windowMs: number;

  constructor(maxConnectionsPerIP: number = 10, windowMs: number = 60000) {
    this.maxConnectionsPerIP = maxConnectionsPerIP;
    this.windowMs = windowMs;
  }

  canConnect(clientIP: string): boolean {
    const now = Date.now();
    const record = this.connections.get(clientIP);

    if (!record || now - record.lastReset > this.windowMs) {
      this.connections.set(clientIP, { count: 1, lastReset: now });
      return true;
    }

    if (record.count >= this.maxConnectionsPerIP) {
      return false;
    }

    record.count++;
    return true;
  }

  disconnect(clientIP: string): void {
    const record = this.connections.get(clientIP);
    if (record && record.count > 0) {
      record.count--;
    }
  }

  cleanup(): void {
    const now = Date.now();
    const entries = Array.from(this.connections.entries());
    for (const [ip, record] of entries) {
      if (now - record.lastReset > this.windowMs) {
        this.connections.delete(ip);
      }
    }
  }
}

// Singleton instance for subscription rate limiting
export const subscriptionTracker = new SubscriptionConnectionTracker(
  parseInt(process.env.GRAPHQL_MAX_SUBSCRIPTIONS_PER_IP || '10', 10),
  parseInt(process.env.GRAPHQL_SUBSCRIPTION_WINDOW_MS || '60000', 10)
);

// Clean up old connections periodically
// #977 ratchet: unref'd — created at import, must not hold the loop open.
const importTimeTimer1 = setInterval(() => subscriptionTracker.cleanup(), 60000);
importTimeTimer1.unref();

/**
 * Build the complete set of validation rules based on environment
 *
 * @returns Array of ValidationRule functions
 */
export function buildSecurityValidationRules(): ValidationRule[] {
  const rules: ValidationRule[] = [];

  // Always enforce depth limits
  rules.push(
    createDepthLimitRule(MAX_DEPTH)
  );

  // Always enforce complexity limits
  rules.push(
    createComplexityLimitRule(MAX_COMPLEXITY, {
      onCost: (cost, operationName) => {
        // Log high-cost queries for monitoring
        if (cost > MAX_COMPLEXITY * 0.8) {
          graphqlLogger.warn('High complexity query detected', {
            operation: `graphql:complexity:${operationName || 'anonymous'}`,
            complexity: cost,
            maxComplexity: MAX_COMPLEXITY,
            threshold: MAX_COMPLEXITY * 0.8,
          });
        }
      },
      formatErrorMessage: (cost, max) =>
        `Query exceeds maximum complexity of ${max}. Cost: ${cost}. Consider simplifying your query.`,
    })
  );

  // Always enforce batch limits
  rules.push(
    createBatchLimitRule(MAX_BATCH_SIZE)
  );

  // Disable introspection in production
  if (IS_PRODUCTION) {
    rules.push(createNoIntrospectionRule());
  }

  return rules;
}

/**
 * Export pre-built validation rules for easy use
 */
export const securityValidationRules = buildSecurityValidationRules();

/**
 * Export individual rules for custom configuration
 */
export {
  MAX_DEPTH,
  MAX_COMPLEXITY,
  MAX_BATCH_SIZE,
  IS_PRODUCTION,
  FIELD_COMPLEXITY_WEIGHTS,
};
