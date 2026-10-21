/**
 * GraphQL Query Depth Limiting
 * Prevents deeply nested queries that could cause performance issues
 */

import { DocumentNode, visit, FieldNode, SelectionNode } from 'graphql';
import { logger } from '../../utils/logger.js';

interface DepthAnalysisResult {
  maxDepth: number;
  totalFields: number;
  complexityScore: number;
}

/**
 * Analyzes GraphQL query depth and complexity
 */
export function depthLimit(
  document: DocumentNode,
  maxDepth: number = 10
): number {
  const result = analyzeQueryDepth(document);

  logger.debug('Query depth analysis', {
    maxDepth: result.maxDepth,
    totalFields: result.totalFields,
    complexityScore: result.complexityScore,
  });

  if (result.maxDepth > maxDepth) {
    logger.warn('Query depth limit exceeded', {
      maxDepth: result.maxDepth,
      limit: maxDepth,
      totalFields: result.totalFields,
    });
    throw new Error(
      `Query depth limit exceeded. Maximum depth: ${maxDepth}, actual: ${result.maxDepth}`
    );
  }

  return result.complexityScore;
}

/**
 * Analyzes the depth and complexity of a GraphQL query
 */
function analyzeQueryDepth(document: DocumentNode): DepthAnalysisResult {
  let maxDepth = 0;
  let totalFields = 0;
  let complexityScore = 0;

  visit(document, {
    SelectionSet: {
      enter(node, key, parent, path) {
        const depth = path.length;
        maxDepth = Math.max(maxDepth, depth);

        // Count fields in this selection set
        const fieldCount = node.selections.filter(
          selection => selection.kind === 'Field'
        ).length;

        totalFields += fieldCount;

        // Calculate complexity score based on depth and field count
        // Exponential growth for deeper levels
        complexityScore += Math.pow(depth, 2) * fieldCount;
      },
    },
  });

  return {
    maxDepth: Math.floor(maxDepth / 2), // Adjust for GraphQL AST structure
    totalFields,
    complexityScore,
  };
}

/**
 * Creates a depth limit validation rule
 */
export function createDepthLimitRule(maxDepth: number = 10) {
  return {
    validate: (document: DocumentNode) => {
      const result = analyzeQueryDepth(document);

      if (result.maxDepth > maxDepth) {
        return [
          {
            message: `Query depth limit exceeded. Maximum depth: ${maxDepth}, actual: ${result.maxDepth}`,
            extensions: {
              code: 'DEPTH_LIMIT_EXCEEDED',
              maxDepth: result.maxDepth,
              limit: maxDepth,
            },
          },
        ];
      }

      return [];
    },
  };
}

/**
 * Analyzes field complexity for cost analysis
 */
export function analyzeFieldComplexity(
  fieldName: string,
  args: any = {}
): number {
  const baseComplexity = 1;
  let complexity = baseComplexity;

  // Fields that are more expensive to resolve
  const expensiveFields = {
    weatherData: 3,
    carbonCredits: 2,
    proposals: 2,
    users: 2,
    swaps: 3,
    marketData: 2,
    search: 5,
  };

  if (expensiveFields[fieldName]) {
    complexity = expensiveFields[fieldName];
  }

  // Increase complexity based on pagination arguments
  if (args.first) {
    const limit = Math.min(args.first, 1000);
    complexity *= Math.log10(limit + 1);
  }

  // Increase complexity for filtering and sorting
  if (args.where) {
    complexity *= 1.5;
  }

  if (args.orderBy) {
    complexity *= 1.2;
  }

  return Math.ceil(complexity);
}

/**
 * Cost analysis for query complexity
 */
export function analyzeCost(
  document: DocumentNode,
  maxCost: number = 1000
): number {
  let totalCost = 0;

  visit(document, {
    Field: {
      enter(node: FieldNode) {
        const fieldName = node.name.value;
        const args = node.arguments
          ? node.arguments.reduce((acc, arg) => {
              if (arg.value.kind === 'IntValue') {
                acc[arg.name.value] = parseInt(arg.value.value);
              } else if (arg.value.kind === 'StringValue') {
                acc[arg.name.value] = arg.value.value;
              } else if (arg.value.kind === 'BooleanValue') {
                acc[arg.name.value] = arg.value.value;
              }
              return acc;
            }, {} as any)
          : {};

        const fieldCost = analyzeFieldComplexity(fieldName, args);
        totalCost += fieldCost;

        logger.debug('Field cost analysis', {
          fieldName,
          fieldCost,
          totalCost,
        });
      },
    },
  });

  if (totalCost > maxCost) {
    logger.warn('Query cost limit exceeded', {
      totalCost,
      limit: maxCost,
    });
    throw new Error(
      `Query cost limit exceeded. Maximum cost: ${maxCost}, actual: ${totalCost}`
    );
  }

  return totalCost;
}

/**
 * Combined query analysis
 */
export function analyzeQuery(
  document: DocumentNode,
  limits: {
    maxDepth?: number;
    maxCost?: number;
  } = {}
): {
  depth: number;
  cost: number;
  complexity: number;
} {
  const maxDepth = limits.maxDepth || 10;
  const maxCost = limits.maxCost || 1000;

  const complexity = depthLimit(document, maxDepth);
  const cost = analyzeCost(document, maxCost);
  const depthResult = analyzeQueryDepth(document);

  return {
    depth: depthResult.maxDepth,
    cost,
    complexity,
  };
}
