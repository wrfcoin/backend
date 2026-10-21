/**
 * GraphQL Response Type Definitions for Tests
 * Provides comprehensive type definitions for all GraphQL responses used in tests
 */

// Base GraphQL response structure
export interface GraphQLResponse<T = any> {
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

// AMM Types
export interface AMMPoolData {
  id: string;
  pairAddress: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  totalLiquidity: string;
  swapFee: string;
  volume24h: string;
  volumeWeek: string;
  feeRewards24h: string;
  priceToken0: string;
  priceToken1: string;
  lastUpdateTime: string;
  isActive: boolean;
  createdAt: string;
  swaps?: AMMSwapData[];
}

export interface AMMSwapData {
  id: string;
  user: string;
  pairAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  minimumAmountOut: string;
  priceImpact: string;
  fee: string;
  status: string;
  timestamp: string;
  blockNumber: number;
  transactionHash: string;
  gasUsed: number;
  metadata: {
    slippage: string;
    deadline: number;
  };
}

// Computational NFT Types
export interface ComputationalNFTData {
  id: string;
  nftId: string;
  creator: string;
  name: string;
  computationType: string;
  modelType: string; // Added missing property
  inputData: string;
  resourceRequirements: string;
  executionResultHash: string;
  isVerified: boolean;
  metadata: {
    status: string;
    stakeAmount: string;
    computeProvider: string;
    executionTime: string;
    resultData: string;
    executedAt: string;
  };
  createdAt: string;
  updatedAt: string;
  job?: ComputeJobData;
}

export interface ComputeJobData {
  id: string;
  nft: ComputationalNFTData;
  provider?: ComputeProviderData;
  rewards?: ComputeRewardData[];
}

export interface ComputeProviderData {
  id: string;
  address: string;
  isAuthorized: boolean;
  totalComputeTime: string;
  successfulJobs: string;
  failedJobs: string;
  stakedTokens: string;
  jobs?: ComputeJobData[];
}

export interface ComputeRewardData {
  id: string;
  jobId: string;
  amount: string; // Added missing property
  provider: string; // Added missing property
  computeTime: number; // Added missing property
  computeProvider: string; // Kept for backward compatibility
  rewardAmount: string; // Kept for backward compatibility
  rewardType: string;
  jobComplexity: number;
  executionTime: number;
  qualityScore: number;
  status: string;
  distributedAt: string;
  transactionHash: string;
  createdAt: string;
}

// User Types
export interface UserData {
  id: string;
  username: string;
  email: string;
  walletAddress: string;
  displayName: string;
  bio: string;
  avatar: string;
  location: string;
  isActive: boolean;
  isVerified: boolean;
  address?: string; // Added missing property
  carbonFootprint?: CarbonFootprintData; // Added missing property
  createdAt: Date;
  lastActiveAt: Date;
  updatedAt: Date;
  carbonCredits?: CarbonCreditData[];
  weatherStations?: WeatherStationData[];
  computationalNFTs?: ComputationalNFTData[];
}

export interface CarbonCreditData {
  id: string;
  tokenId: string;
  owner: string;
  projectType: string;
  carbonOffset: string;
  issuedAt: string;
  expiresAt?: string;
  metadata?: {
    projectName: string;
    location: string;
    verificationStandard: string;
  };
}

export interface WeatherStationData {
  id: string;
  stationId: string;
  owner: string;
  location: {
    latitude: number;
    longitude: number;
    altitude?: number;
  };
  isActive: boolean;
  lastDataSubmission?: string;
  totalRewards: string;
}

export interface CarbonFootprintData {
  id: string;
  totalEmissions: string;
  totalOffsets: string;
  netEmissions: string;
  metadata: {
    methodology: string;
    confidence: number;
  };
  calculationDate: Date;
  emissionSources?: Record<string, number>;
  offsetSources?: Record<string, number>;
}

// Query Response Types
export interface AMMPoolQueryResponse {
  ammPool: AMMPoolData | null;
}

export interface AMMPoolsQueryResponse {
  ammPools: AMMPoolData[];
}

export interface ComputationalNFTQueryResponse {
  computationalNFT: ComputationalNFTData | null;
}

export interface ComputationalNFTsQueryResponse {
  computationalNFTs: ComputationalNFTData[];
}

export interface UserQueryResponse {
  user: UserData | null;
  me: UserData | null; // Added missing property
}

export interface UsersQueryResponse {
  users: UserData[];
}

export interface CarbonCreditsQueryResponse {
  carbonCredits: CarbonCreditData[];
}

// Mutation Response Types
export interface MutationResponse {
  success: boolean;
  message?: string;
  error?: string;
  user?: UserData;
}

export interface UserProfileUpdateResponse {
  updateProfile: MutationResponse;
}

// Type assertion helpers
export function assertGraphQLResponse<T>(result: any): GraphQLResponse<T> {
  if (!result.body || result.body.kind !== 'single') {
    throw new Error('Expected single GraphQL result');
  }
  return result as GraphQLResponse<T>;
}

export function getGraphQLData<T>(result: any): T | null {
  const typed = assertGraphQLResponse<T>(result);
  return typed.body.singleResult.data || null;
}

export function hasGraphQLErrors(result: any): boolean {
  const typed = assertGraphQLResponse(result);
  return Boolean(typed.body.singleResult.errors?.length);
}

export function getGraphQLErrors(result: any): Array<{ message: string }> {
  const typed = assertGraphQLResponse(result);
  return typed.body.singleResult.errors || [];
}
