/**
 * Inter-service communication types
 */
import { BaseApiResponse, AuthenticatedUser } from './common';
/**
 * Service-to-service request context
 */
export interface ServiceContext {
  requestId: string;
  serviceId: string;
  serviceName: string;
  timestamp: string;
  user?: AuthenticatedUser;
}
/**
 * Gateway proxy request information
 */
export interface ProxyRequest {
  serviceName: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  user?: AuthenticatedUser;
}
/**
 * Service discovery events
 */
export interface ServiceDiscoveryEvent {
  type:
    | 'service_registered'
    | 'service_deregistered'
    | 'health_check_failed'
    | 'health_check_passed';
  serviceName: string;
  serviceUrl: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
/**
 * Cross-service data transfer objects
 */
export interface UserProfileDTO {
  id: string;
  address: string;
  email?: string;
  role: string;
  createdAt: string;
  lastLogin?: string;
}
export interface WalletBalanceDTO {
  address: string;
  balance: string;
  tokens: Array<{
    token: string;
    balance: string;
    value?: string;
  }>;
  stakingRewards: string;
  weatherRewards: string;
}
export interface NFTDTO {
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
}
export interface NFTCollectionDTO {
  id: string;
  name: string;
  floorPrice: string;
  volume: string;
  owners: number;
}
export interface NFTMarketplaceStatsDTO {
  totalNFTs: number;
  activeListings: number;
  floorPrice: string;
  volume24h: string;
  topCollections: NFTCollectionDTO[];
}
export type { WeatherDataDTO } from '../../../shared/types/weather-types';
export interface BlockchainStatsDTO {
  blockHeight: number;
  hashRate: string;
  difficulty: string;
  networkPeers: number;
  memPoolSize: number;
  lastBlockTime: string;
}
/**
 * Service API method interfaces
 */
export interface UserManagementServiceAPI {
  '/api/wallet/balance/:address': {
    GET: {
      response: BaseApiResponse<WalletBalanceDTO>;
    };
  };
  '/api/wallet/transactions/:address': {
    GET: {
      query?: {
        page?: number;
        limit?: number;
      };
      response: BaseApiResponse<{
        transactions: Array<{
          hash: string;
          from: string;
          to: string;
          amount: string;
          token: string;
          timestamp: string;
          status: 'pending' | 'confirmed' | 'failed';
          fee: string;
          memo?: string;
        }>;
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
          hasNext: boolean;
          hasPrev: boolean;
        };
      }>;
    };
  };
}
export interface NFTMarketplaceServiceAPI {
  '/api/nft/marketplace/stats': {
    GET: {
      response: BaseApiResponse<NFTMarketplaceStatsDTO>;
    };
  };
  '/api/nft/:tokenId': {
    GET: {
      response: BaseApiResponse<NFTDTO>;
    };
  };
  '/api/nft/collection/:collectionId': {
    GET: {
      response: BaseApiResponse<NFTCollectionDTO>;
    };
  };
  '/api/nft/list': {
    GET: {
      query?: {
        page?: number;
        limit?: number;
      };
      response: BaseApiResponse<{
        nfts: NFTDTO[];
        total: number;
        pages: number;
      }>;
    };
  };
}
export interface MainServiceAPI {
  '/api/weather/stations': {
    GET: {
      response: BaseApiResponse<WeatherDataDTO[]>;
    };
  };
  '/api/blockchain/stats': {
    GET: {
      response: BaseApiResponse<BlockchainStatsDTO>;
    };
  };
}
/**
 * Complete service API registry
 */
export interface ServiceAPIRegistry {
  userService: UserManagementServiceAPI;
  nftService: NFTMarketplaceServiceAPI;
  mainService: MainServiceAPI;
}
//# sourceMappingURL=service-communication.d.ts.map
