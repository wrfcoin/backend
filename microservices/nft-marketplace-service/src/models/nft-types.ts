export interface NFT {
  tokenId: string;
  name: string;
  description: string;
  image: string;
  price: string;
  owner: string;
  collection: string;
  attributes: NFTAttribute[];
}

export interface NFTAttribute {
  trait_type: string;
  value: string | number;
  rarity: number;
}

export interface NFTCollection {
  id: string;
  name: string;
  floorPrice: string;
  volume: string;
  owners: number;
}

export interface NFTMarketplace {
  totalNFTs: number;
  activeListings: number;
  floorPrice: string;
  volume24h: string;
  topCollections: NFTCollection[];
  _resilience?: {
    degraded: boolean;
    fallbackCalculated: boolean;
    sources: Record<string, string>;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  timestamp: string;
  meta?: Record<string, string | number | boolean>;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}
