/**
 * GraphQL Subscription Resolvers
 * Handles real-time updates and event streams
 */

import { GraphQLContext } from '../context.js';
import { logger } from '../../utils/logger.js';
import { pubsub } from '../subscriptions/pubsub.js';
import { withFilter } from 'graphql-subscriptions';

export function matchesBridgeLockFilter(payload: any, variables: { bridge?: string }): boolean {
  if (!variables.bridge) {
    return true;
  }

  const bridge = payload?.bridgeLockDetected?.bridge;
  return (
    typeof bridge === 'string' &&
    bridge.toLowerCase() === variables.bridge.toLowerCase()
  );
}

export const subscriptionResolvers = {
  Subscription: {
    // New block notifications
    newBlock: {
      subscribe: () => pubsub.asyncIterator(['NEW_BLOCK']),
      resolve: (payload: any) => payload.newBlock,
    },

    // Bridge lock detections
    bridgeLockDetected: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['BRIDGE_LOCK_DETECTED']),
        (payload, variables) => matchesBridgeLockFilter(payload, variables)
      ),
      resolve: (payload: any) => payload.bridgeLockDetected,
    },

    // System status updates (emitted by core4)
    systemStatusUpdated: {
      subscribe: () => pubsub.asyncIterator(['SYSTEM_STATUS']),
      resolve: (payload: any) => payload.systemStatus,
    },

    // Weather data updates
    weatherDataUpdated: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['WEATHER_DATA_UPDATED']),
        (payload, variables) => {
          // Filter by station ID if provided
          if (variables.stationId) {
            return payload.weatherDataUpdated.stationId === variables.stationId;
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.weatherDataUpdated,
    },

    // Carbon credit updates
    carbonCreditUpdated: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['CARBON_CREDIT_UPDATED']),
        (payload, variables) => {
          // Filter by token ID if provided
          if (variables.tokenId) {
            return payload.carbonCreditUpdated.tokenId === variables.tokenId;
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.carbonCreditUpdated,
    },

    // Governance proposal updates
    proposalUpdated: {
      subscribe: () => pubsub.asyncIterator(['PROPOSAL_UPDATED']),
      resolve: (payload: any) => payload.proposalUpdated,
    },

    // New governance proposals
    proposalCreated: {
      subscribe: () => pubsub.asyncIterator(['PROPOSAL_CREATED']),
      resolve: (payload: any) => payload.proposalCreated,
    },

    // Vote cast notifications
    voteCast: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['VOTE_CAST']),
        (payload, variables) => {
          // Filter by proposal ID if provided
          if (variables.proposalId) {
            return payload.voteCast.proposalId === variables.proposalId;
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.voteCast,
    },

    // AMM swap executions
    swapExecuted: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['SWAP_EXECUTED']),
        (payload, variables) => {
          // Filter by user if provided
          if (variables.user) {
            return (
              payload.swapExecuted.user.toLowerCase() ===
              variables.user.toLowerCase()
            );
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.swapExecuted,
    },

    // Computational NFT job updates
    computeJobUpdated: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['COMPUTE_JOB_UPDATED']),
        (payload, variables) => {
          // Filter by token ID or owner if provided
          if (variables.tokenId) {
            return payload.computeJobUpdated.tokenId === variables.tokenId;
          }
          if (variables.owner) {
            return (
              payload.computeJobUpdated.owner.toLowerCase() ===
              variables.owner.toLowerCase()
            );
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.computeJobUpdated,
    },

    // WRF token transfers
    tokenTransfer: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['TOKEN_TRANSFER']),
        (payload, variables) => {
          // Filter by from or to address if provided
          if (variables.address) {
            const address = variables.address.toLowerCase();
            return (
              payload.tokenTransfer.from.toLowerCase() === address ||
              payload.tokenTransfer.to.toLowerCase() === address
            );
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.tokenTransfer,
    },

    // User activity updates
    userActivityUpdated: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['USER_ACTIVITY_UPDATED']),
        (payload, variables, context) => {
          // Only send to the specific user
          if (context.user && variables.userId) {
            return (
              context.user.address.toLowerCase() ===
              variables.userId.toLowerCase()
            );
          }
          return false;
        }
      ),
      resolve: (payload: any) => payload.userActivityUpdated,
    },

    // Platform notifications
    platformNotification: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['PLATFORM_NOTIFICATION']),
        (payload, variables) => {
          // Filter by notification type if provided
          if (variables.type) {
            return payload.platformNotification.type === variables.type;
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.platformNotification,
    },

    // Price updates (from AMM)
    priceUpdated: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['PRICE_UPDATED']),
        (payload, variables) => {
          // Filter by token pair if provided
          if (variables.token0 && variables.token1) {
            return (
              (payload.priceUpdated.token0 === variables.token0 &&
                payload.priceUpdated.token1 === variables.token1) ||
              (payload.priceUpdated.token0 === variables.token1 &&
                payload.priceUpdated.token1 === variables.token0)
            );
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.priceUpdated,
    },

    // Carbon activity tracking updates
    carbonActivityTracked: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['CARBON_ACTIVITY_TRACKED']),
        (payload, variables, context) => {
          // Only send to the specific user
          if (context.user && variables.userId) {
            return (
              context.user.address.toLowerCase() ===
              variables.userId.toLowerCase()
            );
          }
          return false;
        }
      ),
      resolve: (payload: any) => payload.carbonActivityTracked,
    },

    // Weather station alerts
    weatherStationAlert: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['WEATHER_STATION_ALERT']),
        (payload, variables) => {
          // Filter by station ID or owner if provided
          if (variables.stationId) {
            return (
              payload.weatherStationAlert.stationId === variables.stationId
            );
          }
          if (variables.owner) {
            return (
              payload.weatherStationAlert.owner.toLowerCase() ===
              variables.owner.toLowerCase()
            );
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.weatherStationAlert,
    },

    // Liquidity pool updates
    liquidityPoolUpdated: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['LIQUIDITY_POOL_UPDATED']),
        (payload, variables) => {
          // Filter by pool address if provided
          if (variables.poolAddress) {
            return (
              payload.liquidityPoolUpdated.poolAddress.toLowerCase() ===
              variables.poolAddress.toLowerCase()
            );
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.liquidityPoolUpdated,
    },

    // Rewards distributed
    rewardsDistributed: {
      subscribe: withFilter(
        () => pubsub.asyncIterator(['REWARDS_DISTRIBUTED']),
        (payload, variables) => {
          // Filter by recipient or reward type if provided
          if (variables.recipient) {
            return (
              payload.rewardsDistributed.recipient.toLowerCase() ===
              variables.recipient.toLowerCase()
            );
          }
          if (variables.type) {
            return payload.rewardsDistributed.type === variables.type;
          }
          return true;
        }
      ),
      resolve: (payload: any) => payload.rewardsDistributed,
    },
  },
};

// Helper function to publish events
export const publishEvent = (event: string, payload: any) => {
  try {
    pubsub.publish(event, payload);
    logger.debug('Event published', { event, payload });
  } catch (error) {
    logger.error('Error publishing event', {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Specific event publishers for common use cases
export const publishWeatherDataUpdate = (weatherData: any) => {
  publishEvent('WEATHER_DATA_UPDATED', { weatherDataUpdated: weatherData });
};

export const publishCarbonCreditUpdate = (carbonCredit: any) => {
  publishEvent('CARBON_CREDIT_UPDATED', { carbonCreditUpdated: carbonCredit });
};

export const publishProposalUpdate = (proposal: any) => {
  publishEvent('PROPOSAL_UPDATED', { proposalUpdated: proposal });
};

export const publishProposalCreated = (proposal: any) => {
  publishEvent('PROPOSAL_CREATED', { proposalCreated: proposal });
};

export const publishVoteCast = (vote: any) => {
  publishEvent('VOTE_CAST', { voteCast: vote });
};

export const publishSwapExecuted = (swap: any) => {
  publishEvent('SWAP_EXECUTED', { swapExecuted: swap });
};

export const publishComputeJobUpdate = (job: any) => {
  publishEvent('COMPUTE_JOB_UPDATED', { computeJobUpdated: job });
};

export const publishTokenTransfer = (transfer: any) => {
  publishEvent('TOKEN_TRANSFER', { tokenTransfer: transfer });
};

export const publishUserActivityUpdate = (activity: any) => {
  publishEvent('USER_ACTIVITY_UPDATED', { userActivityUpdated: activity });
};

export const publishPlatformNotification = (notification: any) => {
  publishEvent('PLATFORM_NOTIFICATION', { platformNotification: notification });
};

export const publishPriceUpdate = (priceData: any) => {
  publishEvent('PRICE_UPDATED', { priceUpdated: priceData });
};

export const publishCarbonActivityTracked = (activity: any) => {
  publishEvent('CARBON_ACTIVITY_TRACKED', { carbonActivityTracked: activity });
};

export const publishWeatherStationAlert = (alert: any) => {
  publishEvent('WEATHER_STATION_ALERT', { weatherStationAlert: alert });
};

export const publishLiquidityPoolUpdate = (pool: any) => {
  publishEvent('LIQUIDITY_POOL_UPDATED', { liquidityPoolUpdated: pool });
};

export const publishRewardsDistributed = (rewards: any) => {
  publishEvent('REWARDS_DISTRIBUTED', { rewardsDistributed: rewards });
};

export const publishSystemStatus = (status: any) => {
  publishEvent('SYSTEM_STATUS', { systemStatus: status });
};
