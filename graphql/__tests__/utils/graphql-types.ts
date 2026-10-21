/**
 * GraphQL Test Type Utilities
 * Provides type-safe access to GraphQL response data in tests
 */

export interface GraphQLTestResponse<T = any> {
  body: {
    kind: 'single';
    singleResult: {
      data?: T;
      errors?: Array<{
        message: string;
        extensions?: any;
      }>;
    };
  };
}

// Common response types
export interface UserProfileResponse {
  updateProfile: {
    success: boolean;
    error?: string;
  };
}

export interface UsersQueryResponse {
  users: Array<{
    id: string;
    username?: string;
    address?: string;
  }>;
}

export interface CarbonCreditsResponse {
  carbonCredits: Array<{
    id: string;
    tokenId: string;
    owner: string;
    carbonOffset: string;
  }>;
}

export interface SwapsResponse {
  swaps: Array<{
    id: string;
    user: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
  }>;
}

export interface PairsResponse {
  pairs: Array<{
    id: string;
    pairAddress: string;
    token0: string;
    token1: string;
    reserve0: string;
    reserve1: string;
  }>;
}

// Type assertion helpers
export function assertSingleResult<T>(result: any): GraphQLTestResponse<T> {
  if (result.body.kind !== 'single') {
    throw new Error('Expected single GraphQL result');
  }
  return result as GraphQLTestResponse<T>;
}

export function getGraphQLData<T>(result: any): T | null {
  const typed = assertSingleResult<T>(result);
  return typed.body.singleResult.data || null;
}

export function hasGraphQLErrors(result: any): boolean {
  const typed = assertSingleResult(result);
  return Boolean(typed.body.singleResult.errors?.length);
}

export function getGraphQLErrors(result: any): Array<{ message: string }> {
  const typed = assertSingleResult(result);
  return typed.body.singleResult.errors || [];
}
