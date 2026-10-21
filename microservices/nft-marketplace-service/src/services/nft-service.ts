import {
  NFT,
  NFTCollection,
  NFTMarketplace,
  INFT,
  INFTCollection,
  INFTMarketplace,
} from '../models/nft-model.js';
import {
  NFTMarketplace as NFTMarketplaceType,
  NFT as NFTType,
  NFTCollection as NFTCollectionType,
} from '../models/nft-types.js';
import { ResilientDatabaseService } from './resilient-database.js';
import { appLogger } from '../../../../server/utils/logger.js';

export class NFTService {
  private resilientDb: ResilientDatabaseService;

  constructor() {
    this.resilientDb = ResilientDatabaseService.getInstance();
  }

  async getMarketplaceStats(): Promise<NFTMarketplaceType> {
    // Try to get cached marketplace stats with fallback
    const statsResult = await this.resilientDb.findOneWithResilience(
      async () => {
        const stats = await NFTMarketplace.findOne().sort({ lastUpdated: -1 });
        return stats;
      },
      'get-marketplace-stats',
      null
    );

    if (statsResult.data) {
      // Get top collections with resilience
      const collectionsResult = await this.resilientDb.findWithResilience(
        async () => {
          const topCollections = await NFTCollection.find()
            .sort({ volume: -1 })
            .limit(5)
            .select('-__v -updatedAt');

          return topCollections.map(col => ({
            id: col.id,
            name: col.name,
            floorPrice: col.floorPrice,
            volume: col.volume,
            owners: col.owners,
          }));
        },
        'get-top-collections',
        [] // Fallback to empty array
      );

      const stats = statsResult.data;
      return {
        totalNFTs: stats.totalNFTs,
        activeListings: stats.activeListings,
        floorPrice: stats.floorPrice,
        volume24h: stats.volume24h,
        topCollections: collectionsResult.data || [],
        // Add resilience info if data is degraded
        ...((statsResult.source !== 'primary' ||
          collectionsResult.source !== 'primary') && {
          _resilience: {
            degraded: true,
            fallbackCalculated: true,
            sources: {
              stats: statsResult.source,
              collections: collectionsResult.source,
            },
          },
        }),
      };
    }

    // Fallback to calculating from existing data with resilience
    const totalNFTsResult = await this.resilientDb.countWithResilience(
      async () => await NFT.countDocuments(),
      'count-total-nfts'
    );

    const activeListingsResult = await this.resilientDb.countWithResilience(
      async () => await NFT.countDocuments({ price: { $ne: null } }),
      'count-active-listings'
    );

    const collectionsResult = await this.resilientDb.findWithResilience(
      async () => {
        const collections = await NFTCollection.find().limit(5);
        return collections.map(col => ({
          id: col.id,
          name: col.name,
          floorPrice: col.floorPrice,
          volume: col.volume,
          owners: col.owners,
        }));
      },
      'get-fallback-collections',
      []
    );

    return {
      totalNFTs: totalNFTsResult.data || 0,
      activeListings: activeListingsResult.data || 0,
      floorPrice: '0.25 WRF',
      volume24h: '125,892 WRF',
      topCollections: collectionsResult.data || [],
      _resilience: {
        degraded: true,
        fallbackCalculated: true,
        sources: {
          totalNFTs: totalNFTsResult.source,
          activeListings: activeListingsResult.source,
          collections: collectionsResult.source,
        },
      },
    };
  }

  async getNFTById(tokenId: string): Promise<NFTType | null> {
    try {
      const nft = await NFT.findOne({ tokenId }).select('-__v -updatedAt');

      if (!nft) {
        return null;
      }

      return {
        tokenId: nft.tokenId,
        name: nft.name,
        description: nft.description,
        image: nft.image,
        price: nft.price,
        owner: nft.owner,
        collection: nft.collectionId,
        attributes: nft.attributes,
      };
    } catch (error) {
      appLogger.error('Error fetching NFT', { error });
      throw new Error('Failed to fetch NFT details');
    }
  }

  async getCollectionById(
    collectionId: string
  ): Promise<NFTCollectionType | null> {
    try {
      const collection = await NFTCollection.findOne({
        id: collectionId,
      }).select('-__v -updatedAt');

      if (!collection) {
        return null;
      }

      return {
        id: collection.id,
        name: collection.name,
        floorPrice: collection.floorPrice,
        volume: collection.volume,
        owners: collection.owners,
      };
    } catch (error) {
      appLogger.error('Error fetching collection', { error });
      throw new Error('Failed to fetch collection details');
    }
  }

  async getAllNFTs(
    page = 1,
    limit = 20
  ): Promise<{ nfts: NFTType[]; total: number; pages: number }> {
    const skip = (page - 1) * limit;

    // Get NFTs with resilience patterns
    const nftResult = await this.resilientDb.findWithResilience(
      async () => {
        const nfts = await NFT.find()
          .select('-__v -updatedAt')
          .skip(skip)
          .limit(limit)
          .sort({ createdAt: -1 });

        return nfts.map(nft => ({
          tokenId: nft.tokenId,
          name: nft.name,
          description: nft.description,
          image: nft.image,
          price: nft.price,
          owner: nft.owner,
          collection: nft.collectionId,
          attributes: nft.attributes,
        }));
      },
      'get-all-nfts',
      [] // Fallback to empty array if database fails
    );

    // Get total count with resilience
    const countResult = await this.resilientDb.countWithResilience(
      async () => await NFT.countDocuments(),
      'count-nfts'
    );

    const total = countResult.data || 0;
    const pages = Math.ceil(total / limit);

    return {
      nfts: nftResult.data || [],
      total,
      pages,
      // Add resilience info for debugging/monitoring
      ...(nftResult.source !== 'primary' && {
        _resilience: {
          source: nftResult.source,
          degraded: true,
        },
      }),
    };
  }

  async seedInitialData(): Promise<void> {
    try {
      // Check if data already exists
      const existingNFTs = await NFT.countDocuments();
      if (existingNFTs > 0) {
        appLogger.info('NFT data already exists, skipping seed');
        return;
      }

      // Seed collections
      const collections = [
        {
          id: 'climate_oracles',
          name: 'Climate Data Oracles',
          floorPrice: '2.5 WRF',
          volume: '45,892 WRF',
          owners: 1250,
          description: 'Computational NFTs that process real-time weather data',
        },
        {
          id: 'weather_stations',
          name: 'Weather Station Nodes',
          floorPrice: '1.8 WRF',
          volume: '32,156 WRF',
          owners: 890,
          description: 'NFTs representing physical weather monitoring stations',
        },
      ];

      await NFTCollection.insertMany(collections);

      // Seed some NFTs
      const sampleNFTs: Partial<INFT>[] = [];
      for (let i = 1; i <= 10; i++) {
        sampleNFTs.push({
          tokenId: `CL${i.toString().padStart(4, '0')}`,
          name: `Climate Data Oracle #${i}`,
          description:
            'A computational NFT that processes real-time weather data',
          image: `/api/nft/image/CL${i.toString().padStart(4, '0')}`,
          price: `${(Math.random() * 5 + 1).toFixed(1)} WRF`,
          owner: `0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f${i.toString().padStart(4, '0')}`,
          collectionId: 'climate_oracles',
          attributes: [
            {
              trait_type: 'Computational Power',
              value: `${Math.floor(Math.random() * 200 + 50)} GH/s`,
              rarity: Math.floor(Math.random() * 100),
            },
            {
              trait_type: 'Data Sources',
              value: Math.floor(Math.random() * 20 + 5),
              rarity: Math.floor(Math.random() * 100),
            },
            {
              trait_type: 'Accuracy Rating',
              value: `${(Math.random() * 5 + 95).toFixed(1)}%`,
              rarity: Math.floor(Math.random() * 100),
            },
          ],
        });
      }

      await NFT.insertMany(sampleNFTs);

      // Seed marketplace stats
      await NFTMarketplace.create({
        totalNFTs: 15643,
        activeListings: 892,
        floorPrice: '0.25 WRF',
        volume24h: '125,892 WRF',
      });

      appLogger.info('Initial NFT data seeded successfully');
    } catch (error) {
      appLogger.error('Error seeding initial data', { error });
      throw error;
    }
  }
}
