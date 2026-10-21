/**
 * API types for NFT Marketplace service
 */

export interface BaseResponse<T = unknown> {
  success: boolean;
  data: T;
  timestamp: string;
  meta?: Record<string, string | number | boolean>;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded';
  service: string;
  database: string;
  timestamp: string;
}

export interface NFTListResponse {
  nfts: Array<{
    tokenId: string;
    name: string;
    description: string;
    image: string;
    price: string;
    owner: string;
    collection: string;
    attributes: Array<{
      trait_type: string;
      value: string | number;
      rarity: number;
    }>;
  }>;
  total: number;
  pages: number;
}

export interface MarketplaceStatsResponse {
  totalNFTs: number;
  activeListings: number;
  floorPrice: string;
  volume24h: string;
  topCollections: Array<{
    id: string;
    name: string;
    floorPrice: string;
    volume: string;
    owners: number;
  }>;
}

export enum NFTErrorCodes {
  NFT_NOT_FOUND = 'NFT_NOT_FOUND',
  COLLECTION_NOT_FOUND = 'COLLECTION_NOT_FOUND',
  INVALID_TOKEN_ID = 'INVALID_TOKEN_ID',
  DATABASE_ERROR = 'DATABASE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}
