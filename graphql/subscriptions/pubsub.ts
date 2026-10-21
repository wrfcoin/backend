/**
 * GraphQL Subscriptions PubSub System
 * Redis-based pubsub for distributed GraphQL subscriptions
 */

import { RedisPubSub } from 'graphql-redis-subscriptions';
import { logger } from '../../utils/logger.js';
import { createRedisClient } from '../../server/utils/create-redis.js';

// Create Redis instances for publisher and subscriber
// Pub/Sub is a required delivery path, never a disposable cache.
const publisher = createRedisClient({
  failureMode: 'fail-closed',
  maxRetriesPerRequest: null,
});
const subscriber = createRedisClient({
  failureMode: 'fail-closed',
  maxRetriesPerRequest: null,
});

// Create PubSub instance
export const pubsub = new RedisPubSub({
  publisher,
  subscriber,
  messageEventName: 'wrfcoin-message',
  pmessageEventName: 'wrfcoin-pmessage',
});

// Error handling
publisher.on('error', error => {
  logger.error('Redis Publisher Error:', error);
});

subscriber.on('error', error => {
  logger.error('Redis Subscriber Error:', error);
});

publisher.on('connect', () => {
  logger.info('Redis Publisher Connected');
});

subscriber.on('connect', () => {
  logger.info('Redis Subscriber Connected');
});

// Graceful shutdown
export const closePubSub = async () => {
  try {
    await pubsub.close();
    await publisher.quit();
    await subscriber.quit();
    logger.info('PubSub connections closed');
  } catch (error) {
    logger.error('Error closing PubSub connections:', error);
  }
};

// Export Redis instances for direct use if needed
export { publisher, subscriber };
