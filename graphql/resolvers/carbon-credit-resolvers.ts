/**
 * Carbon Credit GraphQL Resolvers
 * Handles carbon credits, trading, and environmental data
 */

import { ethers } from 'ethers';
import {
  GraphQLContext,
  requireAuth,
  requireVerifiedWallet,
} from '../context.js';
import { logger } from '../../utils/logger.js';
import { formatError } from '../error-handler.js';
import { pubsub } from '../subscriptions/pubsub.js';
import { eq, gte, desc, asc, and, or, sql } from 'drizzle-orm';
import { nfts, transactions, carbonTrades, carbonCredits } from '../../shared/schema.js';

// Module-level cache for blockchain calls that change infrequently.
// Keys: "tradingInfo:<tokenId>" | "owner:<tokenId>"; values: { value, expiresAt }
const _blockchainCache = new Map<string, { value: any; expiresAt: number }>();
const BLOCKCHAIN_CACHE_TTL_MS = 30_000; // 30 seconds

function _cacheGet(key: string): any | undefined {
  const entry = _blockchainCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { _blockchainCache.delete(key); return undefined; }
  return entry.value;
}

function _cacheSet(key: string, value: any): void {
  _blockchainCache.set(key, { value, expiresAt: Date.now() + BLOCKCHAIN_CACHE_TTL_MS });
}

export const carbonCreditResolvers = {
  Query: {
    // Get single carbon credit
    carbonCredit: async (
      _: any,
      { id }: { id: string },
      context: GraphQLContext
    ) => {
      try {
        const tokenId = BigInt(id);

        const [creditDetails, tradingInfo, owner] = await Promise.all([
          context.contracts.carbonCredits.getCreditDetails(tokenId),
          context.contracts.carbonCredits.getTradingInfo(tokenId),
          context.contracts.carbonCredits.ownerOf(tokenId),
        ]);

        // Get additional data from database
        const creditRecord = await context.db.query.nfts.findFirst({
          where: eq(nfts.nftId, id),
        });

        return {
          id,
          tokenId: tokenId.toString(),
          carbonOffset: creditDetails[0].toString(), // carbonOffset in grams
          projectType: creditDetails[1], // projectType
          verificationStandard: creditDetails[2], // verificationStandard
          issuanceDate: new Date(Number(creditDetails[3]) * 1000), // issuanceDate
          expiryDate: new Date(Number(creditDetails[4]) * 1000), // expiryDate
          location: creditDetails[5], // location
          isRetired: creditDetails[6], // isRetired
          issuer: creditDetails[7], // issuer
          certificationHash:
            (creditRecord?.metadata as any)?.certificationHash || '',
          forSale: tradingInfo[0], // forSale
          price: tradingInfo[1].toString(), // price in WRF
          owner: owner.toLowerCase(),
        };
      } catch (error) {
        logger.error('Error fetching carbon credit', {
          id,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });

        if (
          error instanceof Error &&
          error.message.includes('ERC721: invalid token ID')
        ) {
          return null; // Credit doesn't exist
        }

        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'CARBON_CREDIT_FETCH_ERROR',
        });
      }
    },

    // Get multiple carbon credits with filtering
    carbonCredits: async (
      _: any,
      {
        first = 10,
        skip = 0,
        orderBy = 'id',
        orderDirection = 'asc',
        where,
      }: {
        first?: number;
        skip?: number;
        orderBy?: string;
        orderDirection?: string;
        where?: any;
      },
      context: GraphQLContext
    ) => {
      try {
        // Build database query with filters
        const queryConditions: any[] = [];

        // Apply filters
        // Filter for carbon credit NFTs
        queryConditions.push(eq(nfts.nftType, 'carbon_credit'));

        if (where) {
          // Note: These fields would need to be stored in metadata or additional tables
          // For now, we'll use the nfts table structure
          if (where.projectType) {
            queryConditions.push(
              sql`${nfts.metadata}->>'projectType' = ${where.projectType}` as any
            );
          }

          if (where.verificationStandard) {
            queryConditions.push(
              sql`${nfts.metadata}->>'verificationStandard' = ${where.verificationStandard}` as any
            );
          }

          if (where.isRetired !== undefined) {
            queryConditions.push(
              sql`${nfts.metadata}->>'isRetired' = ${where.isRetired.toString()}` as any
            );
          }

          if (where.forSale !== undefined) {
            queryConditions.push(
              sql`${nfts.metadata}->>'forSale' = ${where.forSale.toString()}` as any
            );
          }

          if (where.issuer) {
            queryConditions.push(eq(nfts.creator, where.issuer.toLowerCase()));
          }
        }

        const whereClause =
          queryConditions.length > 0 ? and(...queryConditions) : undefined;

        // Execute query with ordering
        let orderByClause;
        if (orderBy === 'carbonOffset') {
          orderByClause =
            orderDirection === 'desc'
              ? desc(sql`${nfts.metadata}->>'carbonOffset'` as any)
              : asc(sql`${nfts.metadata}->>'carbonOffset'` as any);
        } else if (orderBy === 'issuanceDate') {
          orderByClause =
            orderDirection === 'desc'
              ? desc(sql`${nfts.metadata}->>'issuanceDate'` as any)
              : asc(sql`${nfts.metadata}->>'issuanceDate'` as any);
        } else {
          orderByClause =
            orderDirection === 'desc'
              ? desc(nfts.createdAt)
              : asc(nfts.createdAt);
        }

        const credits = await context.db.query.nfts.findMany({
          where: whereClause,
          limit: Math.min(first, 100), // Cap at 100 items
          offset: skip,
          orderBy: orderByClause,
        });

        // Enrich with current blockchain data.
        // Per-credit calls are parallelised and cached (30s TTL) to avoid
        // saturating the RPC node with 2×N serial calls for a page of N credits.
        const enrichedCredits = await Promise.all(
          credits.map(async credit => {
            try {
              const tokenId = BigInt(credit.nftId);
              const tradingKey = `tradingInfo:${tokenId}`;
              const ownerKey = `owner:${tokenId}`;

              const [tradingInfo, owner] = await Promise.all([
                _cacheGet(tradingKey) ??
                  context.contracts.carbonCredits
                    .getTradingInfo(tokenId)
                    .then((v: any) => {
                      _cacheSet(tradingKey, v);
                      return v;
                    }),
                _cacheGet(ownerKey) ??
                  context.contracts.carbonCredits.ownerOf(tokenId).then((v: any) => {
                    _cacheSet(ownerKey, v);
                    return v;
                  }),
              ]);

              // Extract carbon credit data from metadata
              const metadata = (credit.metadata as any) || {};

              return {
                id: credit.nftId,
                tokenId: credit.nftId,
                carbonOffset: metadata.carbonOffset || '0',
                projectType: metadata.projectType || 'Unknown',
                verificationStandard:
                  metadata.verificationStandard || 'Unknown',
                issuanceDate: metadata.issuanceDate || credit.createdAt,
                expiryDate: metadata.expiryDate || credit.createdAt,
                location: metadata.location || 'Unknown',
                isRetired: metadata.isRetired || false,
                issuer: credit.creator,
                certificationHash: metadata.certificationHash || '',
                forSale: tradingInfo[0],
                price: tradingInfo[1].toString(),
                owner: owner.toLowerCase(),
              };
            } catch (error) {
              // If blockchain call fails, use database data with fallback values
              logger.warn('Failed to fetch blockchain data for credit', {
                tokenId: credit.nftId,
                error: error instanceof Error ? error.message : String(error),
              });

              const metadata = (credit.metadata as any) || {};

              return {
                id: credit.nftId,
                tokenId: credit.nftId,
                carbonOffset: metadata.carbonOffset || '0',
                projectType: metadata.projectType || 'Unknown',
                verificationStandard:
                  metadata.verificationStandard || 'Unknown',
                issuanceDate: metadata.issuanceDate || credit.createdAt,
                expiryDate: metadata.expiryDate || credit.createdAt,
                location: metadata.location || 'Unknown',
                isRetired: metadata.isRetired || false,
                issuer: credit.creator,
                certificationHash: metadata.certificationHash || '',
                forSale: metadata.forSale || false,
                price: metadata.price || '0',
                owner: credit.owner || credit.creator,
              };
            }
          })
        );

        return enrichedCredits;
      } catch (error) {
        logger.error('Error fetching carbon credits', {
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'CARBON_CREDITS_FETCH_ERROR',
        });
      }
    },
  },

  // Field resolvers for CarbonCredit
  CarbonCredit: {
    transfers: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        // Query general transactions table for transfers of this NFT
        const transfers = await context.db.query.transactions.findMany({
          where: and(
            eq(transactions.type, 'transfer'),
            sql`${transactions.data}->>'tokenId' = ${parent.tokenId}`
          ),
          limit: Math.min(first, 100),
          orderBy: desc(transactions.timestamp),
        });

        return transfers.map(transfer => ({
          id: transfer.id.toString(),
          tokenId: parent.tokenId,
          from: transfer.fromAddress,
          to: transfer.toAddress,
          price: (transfer.data as any)?.price || '0',
          timestamp: transfer.timestamp,
          transactionHash: transfer.txId,
        }));
      } catch (error) {
        logger.error('Error fetching credit transfers', {
          tokenId: parent.tokenId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    retirements: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        // Query general transactions table for retirements of this NFT
        const retirements = await context.db.query.transactions.findMany({
          where: and(
            eq(transactions.type, 'retirement'),
            sql`${transactions.data}->>'tokenId' = ${parent.tokenId}`
          ),
          limit: Math.min(first, 100),
          orderBy: desc(transactions.timestamp),
        });

        return retirements.map(retirement => ({
          id: retirement.id.toString(),
          tokenId: parent.tokenId,
          retiringEntity: retirement.fromAddress,
          carbonOffset: (retirement.data as any)?.carbonOffset || '0',
          timestamp: retirement.timestamp,
          transactionHash: retirement.txId,
        }));
      } catch (error) {
        logger.error('Error fetching credit retirements', {
          tokenId: parent.tokenId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    // Trading history from carbonTrades table
    tradingHistory: async (
      parent: any,
      { first = 20 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const trades = await context.db.query.carbonTrades.findMany({
          where: eq(carbonTrades.creditId, parent.tokenId.toString()),
          orderBy: desc(carbonTrades.tradedAt),
          limit: Math.min(first, 100),
        });

        return trades.map(trade => ({
          id: trade.id.toString(),
          creditId: trade.creditId,
          buyer: trade.buyerAddress,
          seller: trade.sellerAddress,
          price: trade.price,
          quantity: trade.quantity,
          totalValue: trade.totalValue || (parseFloat(trade.price) * parseFloat(trade.quantity)).toString(),
          transactionHash: trade.transactionHash,
          tradeType: trade.tradeType || 'market',
          timestamp: trade.tradedAt,
        }));
      } catch (error) {
        logger.error('Error fetching carbon credit trading history', {
          tokenId: parent.tokenId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    // Price history derived from trading data
    priceHistory: async (
      parent: any,
      { first = 30 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const trades = await context.db.query.carbonTrades.findMany({
          where: eq(carbonTrades.creditId, parent.tokenId.toString()),
          orderBy: asc(carbonTrades.tradedAt),
          limit: Math.min(first, 100),
        });

        return trades.map(trade => ({
          price: trade.price,
          timestamp: trade.tradedAt,
          volume: trade.quantity,
        }));
      } catch (error) {
        logger.error('Error fetching carbon credit price history', {
          tokenId: parent.tokenId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
  },

  Mutation: {
    // Track carbon activity (simplified version using existing tables)
    trackCarbonActivity: async (
      _: any,
      { input }: { input: any },
      context: GraphQLContext
    ) => {
      try {
        // SECURITY: Require authentication
        const user = requireAuth(context);

        // SECURITY: Verify user can only track their own activity
        if (user.address.toLowerCase() !== input.userId.toLowerCase()) {
          throw new Error('Cannot track carbon activity for other users');
        }

        // Validate input
        if (
          !input.userId ||
          !input.activityType ||
          !input.category ||
          !input.amount ||
          !input.unit
        ) {
          throw new Error(
            'Missing required fields for carbon activity tracking'
          );
        }

        // Calculate carbon emission based on activity type and amount
        const carbonEmission = calculateCarbonEmission(
          input.activityType,
          input.category,
          input.amount,
          input.unit
        );

        // Store activity as a transaction record (simplified approach)
        const [activityRecord] = await context.db
          .insert(transactions)
          .values({
            txId: `carbon-activity-${Date.now()}-${input.userId}`,
            fromAddress: input.userId,
            toAddress: 'system',
            amount: Math.round(carbonEmission * 1000), // Convert to integer
            fee: 0,
            type: 'carbon_activity',
            status: 'completed',
            data: {
              activityType: input.activityType,
              category: input.category,
              amount: input.amount,
              unit: input.unit,
              carbonEmission,
              confidence: 85,
              source: input.source || 'manual',
              location: input.location,
            },
          })
          .returning();

        // Generate basic recommendations
        const recommendations = generateBasicRecommendations(
          input.activityType,
          carbonEmission
        );

        logger.info('Carbon activity tracked', {
          userId: input.userId,
          activityType: input.activityType,
          carbonEmission,
          requestId: context.requestId,
        });

        return {
          success: true,
          activity: {
            id: activityRecord.id.toString(),
            user: input.userId,
            activityType: input.activityType,
            category: input.category,
            amount: input.amount,
            unit: input.unit,
            carbonEmission,
            confidence: 85,
            source: input.source || 'manual',
            timestamp: activityRecord.timestamp,
            location: input.location,
          },
          carbonEmission,
          recommendations,
          error: null,
        };
      } catch (error) {
        logger.error('Error tracking carbon activity', {
          input,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });

        return {
          success: false,
          activity: null,
          carbonEmission: 0,
          recommendations: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    // Create a new carbon credit (issuer role required)
    createCarbonCredit: async (
      _: any,
      { input }: { input: any },
      context: GraphQLContext
    ) => {
      try {
        // SECURITY: Require authentication and verified wallet
        const user = requireVerifiedWallet(context);

        // Validate required fields
        if (
          !input.carbonOffset ||
          !input.projectType ||
          !input.verificationStandard
        ) {
          throw new Error('Missing required fields for carbon credit creation');
        }

        // Check if user is an authorized issuer
        const isAuthorizedIssuer =
          await context.contracts.carbonCredits.authorizedIssuers(user.address);
        if (!isAuthorizedIssuer) {
          throw new Error('Only authorized issuers can create carbon credits');
        }

        // Generate unique token ID
        const tokenId = `cc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Store in database
        const [credit] = await context.db
          .insert(carbonCredits)
          .values({
            tokenId,
            owner: user.address.toLowerCase(),
            carbonOffset: input.carbonOffset.toString(),
            projectType: input.projectType,
            verificationStandard: input.verificationStandard,
            issuanceDate: new Date(),
            expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
            location: input.location || null,
            isRetired: false,
            issuer: user.address.toLowerCase(),
            certificationHash: input.certificationHash || null,
            forSale: false,
            price: null,
            metadata: input.metadata || {},
          })
          .returning();

        // Publish event for subscriptions
        pubsub.publish('CARBON_CREDIT_UPDATED', {
          carbonCreditUpdated: {
            ...credit,
            action: 'CREATED',
          },
        });

        logger.info('Carbon credit created', {
          tokenId,
          issuer: user.address,
          carbonOffset: input.carbonOffset,
          requestId: context.requestId,
        });

        return {
          success: true,
          credit,
          error: null,
        };
      } catch (error) {
        logger.error('Error creating carbon credit', {
          input,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });

        return {
          success: false,
          credit: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    // Purchase a carbon credit from the marketplace
    buyCarbonCredit: async (
      _: any,
      { tokenId, maxPrice }: { tokenId: string; maxPrice: string },
      context: GraphQLContext
    ) => {
      try {
        // SECURITY: Require authentication and verified wallet
        const user = requireVerifiedWallet(context);

        // Use DataLoader to get the credit
        const credit = await context.loaders.carbonCredits.load(tokenId);

        if (!credit) {
          throw new Error('Carbon credit not found');
        }

        if (!credit.forSale) {
          throw new Error('Carbon credit is not for sale');
        }

        if (credit.owner.toLowerCase() === user.address.toLowerCase()) {
          throw new Error('Cannot buy your own carbon credit');
        }

        if (credit.isRetired) {
          throw new Error('Cannot buy retired carbon credit');
        }

        // Check price
        if (credit.price && BigInt(credit.price) > BigInt(maxPrice)) {
          throw new Error('Price exceeds maximum specified');
        }

        const previousOwner = credit.owner;

        // Update ownership in database
        // carbonCredits imported from schema
        const [updatedCredit] = await context.db
          .update(carbonCredits)
          .set({
            owner: user.address.toLowerCase(),
            forSale: false,
            price: null,
            updatedAt: new Date(),
          })
          .where(eq(carbonCredits.tokenId, tokenId))
          .returning();

        // Record the transaction
        const txId = `cc-purchase-${Date.now()}-${tokenId}`;
        await context.db.insert(transactions).values({
          txId,
          fromAddress: previousOwner,
          toAddress: user.address.toLowerCase(),
          amount: Number(credit.price) || 0,
          fee: 0,
          type: 'carbon_credit_purchase',
          status: 'completed',
          data: {
            tokenId,
            carbonOffset: credit.carbonOffset,
            projectType: credit.projectType,
          },
        });

        // Record trade in carbonTrades table for trading history
        await context.db.insert(carbonTrades).values({
          creditId: tokenId,
          buyerAddress: user.address.toLowerCase(),
          sellerAddress: previousOwner,
          price: credit.price || '0',
          quantity: '1', // Single credit purchase
          totalValue: credit.price || '0',
          transactionHash: txId,
          tradeType: 'purchase',
          metadata: {
            carbonOffset: credit.carbonOffset,
            projectType: credit.projectType,
          },
        });

        // Publish event
        pubsub.publish('CARBON_CREDIT_UPDATED', {
          carbonCreditUpdated: {
            ...updatedCredit,
            action: 'PURCHASED',
            previousOwner,
          },
        });

        logger.info('Carbon credit purchased', {
          tokenId,
          buyer: user.address,
          seller: previousOwner,
          price: credit.price,
          requestId: context.requestId,
        });

        return {
          success: true,
          credit: updatedCredit,
          transactionHash: `tx-${Date.now()}`,
          error: null,
        };
      } catch (error) {
        logger.error('Error purchasing carbon credit', {
          tokenId,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });

        return {
          success: false,
          credit: null,
          transactionHash: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    // Retire a carbon credit (permanently remove from circulation)
    retireCarbonCredit: async (
      _: any,
      { tokenId, purpose }: { tokenId: string; purpose: string },
      context: GraphQLContext
    ) => {
      try {
        // SECURITY: Require authentication and verified wallet
        const user = requireVerifiedWallet(context);

        // Use DataLoader to get the credit
        const credit = await context.loaders.carbonCredits.load(tokenId);

        if (!credit) {
          throw new Error('Carbon credit not found');
        }

        if (credit.owner.toLowerCase() !== user.address.toLowerCase()) {
          throw new Error('You do not own this carbon credit');
        }

        if (credit.isRetired) {
          throw new Error('Carbon credit is already retired');
        }

        // Retire the credit in database
        // carbonCredits imported from schema
        const [retiredCredit] = await context.db
          .update(carbonCredits)
          .set({
            isRetired: true,
            forSale: false,
            price: null,
            updatedAt: new Date(),
            metadata: {
              ...(credit.metadata || {}),
              retirementPurpose: purpose,
              retiredAt: new Date().toISOString(),
              retiredBy: user.address.toLowerCase(),
            },
          })
          .where(eq(carbonCredits.tokenId, tokenId))
          .returning();

        // Record the retirement transaction
        await context.db.insert(transactions).values({
          txId: `cc-retire-${Date.now()}-${tokenId}`,
          fromAddress: user.address.toLowerCase(),
          toAddress: 'burned',
          amount: Number(credit.carbonOffset) || 0,
          fee: 0,
          type: 'carbon_credit_retirement',
          status: 'completed',
          data: {
            tokenId,
            carbonOffset: credit.carbonOffset,
            projectType: credit.projectType,
            purpose,
          },
        });

        // Publish event
        pubsub.publish('CARBON_CREDIT_UPDATED', {
          carbonCreditUpdated: {
            ...retiredCredit,
            action: 'RETIRED',
            purpose,
          },
        });

        logger.info('Carbon credit retired', {
          tokenId,
          owner: user.address,
          carbonOffset: credit.carbonOffset,
          purpose,
          requestId: context.requestId,
        });

        return {
          success: true,
          credit: retiredCredit,
          retirementCertificate: {
            tokenId,
            carbonOffset: credit.carbonOffset,
            projectType: credit.projectType,
            retiredBy: user.address.toLowerCase(),
            retiredAt: new Date().toISOString(),
            purpose,
          },
          error: null,
        };
      } catch (error) {
        logger.error('Error retiring carbon credit', {
          tokenId,
          purpose,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });

        return {
          success: false,
          credit: null,
          retirementCertificate: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    // List a carbon credit for sale
    listCarbonCreditForSale: async (
      _: any,
      { tokenId, price }: { tokenId: string; price: string },
      context: GraphQLContext
    ) => {
      try {
        // SECURITY: Require authentication and verified wallet
        const user = requireVerifiedWallet(context);

        // Use DataLoader to get the credit
        const credit = await context.loaders.carbonCredits.load(tokenId);

        if (!credit) {
          throw new Error('Carbon credit not found');
        }

        if (credit.owner.toLowerCase() !== user.address.toLowerCase()) {
          throw new Error('You do not own this carbon credit');
        }

        if (credit.isRetired) {
          throw new Error('Cannot list retired carbon credit for sale');
        }

        // Update in database
        // carbonCredits imported from schema
        const [listedCredit] = await context.db
          .update(carbonCredits)
          .set({
            forSale: true,
            price,
            updatedAt: new Date(),
          })
          .where(eq(carbonCredits.tokenId, tokenId))
          .returning();

        // Publish event
        pubsub.publish('CARBON_CREDIT_UPDATED', {
          carbonCreditUpdated: {
            ...listedCredit,
            action: 'LISTED',
          },
        });

        logger.info('Carbon credit listed for sale', {
          tokenId,
          owner: user.address,
          price,
          requestId: context.requestId,
        });

        return {
          success: true,
          credit: listedCredit,
          error: null,
        };
      } catch (error) {
        logger.error('Error listing carbon credit for sale', {
          tokenId,
          price,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });

        return {
          success: false,
          credit: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
};

// Helper functions

/**
 * Calculate carbon emission based on activity type and amount
 */
function calculateCarbonEmission(
  activityType: string,
  category: string,
  amount: number,
  unit: string
): number {
  // Emission factors (kg CO2e per unit)
  const emissionFactors: Record<string, Record<string, number>> = {
    TRANSPORTATION: {
      car_gasoline: 0.253, // kg CO2e/km
      car_electric: 0.089, // kg CO2e/km
      flight_domestic: 0.255, // kg CO2e/km
      flight_international: 0.195, // kg CO2e/km
      train: 0.041, // kg CO2e/km
      bus: 0.089, // kg CO2e/km
      motorcycle: 0.113, // kg CO2e/km
    },
    ENERGY: {
      electricity_grid: 0.457, // kg CO2e/kWh
      electricity_renewable: 0.024, // kg CO2e/kWh
      natural_gas: 0.202, // kg CO2e/kWh
      heating_oil: 0.264, // kg CO2e/kWh
      coal: 0.82, // kg CO2e/kWh
    },
    FOOD: {
      beef: 27.0, // kg CO2e/kg
      lamb: 24.5, // kg CO2e/kg
      pork: 12.1, // kg CO2e/kg
      chicken: 5.7, // kg CO2e/kg
      fish: 4.6, // kg CO2e/kg
      dairy: 3.2, // kg CO2e/kg
      vegetables: 1.1, // kg CO2e/kg
      fruits: 0.9, // kg CO2e/kg
      grains: 2.5, // kg CO2e/kg
    },
    DIGITAL: {
      streaming: 0.0036, // kg CO2e/hour
      video_call: 0.15, // kg CO2e/hour
      email: 0.004, // kg CO2e/email
      cloud_storage: 0.5, // kg CO2e/GB/year
    },
  };

  const factor = emissionFactors[activityType]?.[category];
  if (!factor) {
    throw new Error(
      `Unknown activity type/category: ${activityType}/${category}`
    );
  }

  // Convert units if necessary
  let normalizedAmount = amount;
  if (unit === 'miles' && activityType === 'TRANSPORTATION') {
    normalizedAmount = amount * 1.60934; // Convert miles to km
  }

  return normalizedAmount * factor;
}

/**
 * Generate basic carbon reduction recommendations
 */
function generateBasicRecommendations(
  activityType: string,
  carbonEmission: number
): any[] {
  const recommendations: any[] = [];

  // Generate specific recommendations based on activity type
  switch (activityType) {
    case 'TRANSPORTATION':
      if (carbonEmission > 10) {
        // High emission trip
        recommendations.push({
          title: 'Consider Public Transportation',
          description:
            'Your recent trip had high carbon emissions. Consider using public transport, carpooling, or electric vehicles for similar journeys.',
          potentialSavings: carbonEmission * 0.6, // Up to 60% reduction
          priority: 'high',
          category: 'transportation',
        });
      }
      break;

    case 'ENERGY':
      if (carbonEmission > 20) {
        // High energy consumption
        recommendations.push({
          title: 'Switch to Renewable Energy',
          description:
            'Your energy consumption has high carbon impact. Consider switching to renewable energy sources or improving energy efficiency.',
          potentialSavings: carbonEmission * 0.8, // Up to 80% reduction with renewables
          priority: 'high',
          category: 'energy',
        });
      }
      break;

    case 'FOOD':
      if (carbonEmission > 15) {
        // High-carbon food
        recommendations.push({
          title: 'Reduce Meat Consumption',
          description:
            'Animal products have high carbon footprints. Consider plant-based alternatives for some meals.',
          potentialSavings: carbonEmission * 0.7, // Up to 70% reduction
          priority: 'medium',
          category: 'food',
        });
      }
      break;

    case 'DIGITAL':
      recommendations.push({
        title: 'Optimize Digital Usage',
        description:
          'Reduce streaming quality, use energy-efficient devices, and consider cloud storage optimization.',
        potentialSavings: carbonEmission * 0.3, // Up to 30% reduction
        priority: 'low',
        category: 'digital',
      });
      break;
  }

  // Add general recommendation for offsetting
  if (carbonEmission > 50) {
    // High overall footprint
    recommendations.push({
      title: 'Consider Carbon Offsetting',
      description: `This activity generated ${carbonEmission.toFixed(1)} kg CO2e. Consider purchasing carbon credits to offset your impact.`,
      potentialSavings: carbonEmission,
      priority: 'medium',
      category: 'offsetting',
    });
  }

  return recommendations;
}
