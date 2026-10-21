import mongoose, { Schema, Document } from 'mongoose';

export interface INFTAttribute {
  trait_type: string;
  value: string | number;
  rarity: number;
}

export interface INFT extends Document {
  tokenId: string;
  name: string;
  description: string;
  image: string;
  price: string;
  owner: string;
  collectionId: string;
  attributes: INFTAttribute[];
  createdAt: Date;
  updatedAt: Date;
}

export interface INFTCollection extends Document {
  id: string;
  name: string;
  floorPrice: string;
  volume: string;
  owners: number;
  description?: string;
  image?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface INFTMarketplace extends Document {
  totalNFTs: number;
  activeListings: number;
  floorPrice: string;
  volume24h: string;
  lastUpdated: Date;
}

const NFTAttributeSchema = new Schema<INFTAttribute>({
  trait_type: { type: String, required: true },
  value: { type: Schema.Types.Mixed, required: true },
  rarity: { type: Number, required: true, min: 0, max: 100 },
});

const NFTSchema = new Schema<INFT>(
  {
    tokenId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    image: { type: String, required: true },
    price: { type: String, required: true },
    owner: { type: String, required: true, index: true },
    collectionId: { type: String, required: true, index: true },
    attributes: [NFTAttributeSchema],
  },
  {
    timestamps: true,
    collection: 'nfts',
  }
);

const NFTCollectionSchema = new Schema<INFTCollection>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    floorPrice: { type: String, required: true },
    volume: { type: String, required: true },
    owners: { type: Number, required: true, min: 0 },
    description: { type: String },
    image: { type: String },
  },
  {
    timestamps: true,
    collection: 'nft_collections',
  }
);

const NFTMarketplaceSchema = new Schema<INFTMarketplace>(
  {
    totalNFTs: { type: Number, required: true, min: 0 },
    activeListings: { type: Number, required: true, min: 0 },
    floorPrice: { type: String, required: true },
    volume24h: { type: String, required: true },
    lastUpdated: { type: Date, default: Date.now },
  },
  {
    collection: 'marketplace_stats',
  }
);

export const NFT = mongoose.model<INFT>('NFT', NFTSchema);
export const NFTCollection = mongoose.model<INFTCollection>(
  'NFTCollection',
  NFTCollectionSchema
);
export const NFTMarketplace = mongoose.model<INFTMarketplace>(
  'NFTMarketplace',
  NFTMarketplaceSchema
);
