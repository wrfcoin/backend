/**
 * Chainlink Data Feeds Client for Wrfcoin
 *
 * This module provides functions to interact with Chainlink Data Feeds,
 * retrieving price data and other oracle information.
 */

const axios = require('axios');
const config = require('./config');
const logger = require('../utils/logger');

/**
 * Interface to fetch data from Chainlink price feeds
 */
class DataFeedClient {
  /**
   * Create a new DataFeedClient
   * @param {string} network - Network to use (mainnet, testnet, etc.)
   */
  constructor(network = 'testnet') {
    this.network = network;
    this.networkConfig = config.getNetwork(network);
    this.endpoint = this.networkConfig.endpoint;
    this.wsEndpoint = this.networkConfig.wsEndpoint;
  }

  /**
   * Get the latest price from a data feed
   * @param {string} feedId - The feed identifier (e.g., 'ETH-USD')
   * @returns {Promise<object>} Price data
   */
  async getLatestPrice(feedId) {
    try {
      const feedConfig = config.getDataFeed(feedId, this.network);
      const response = await axios.get(
        `${this.endpoint}/feeds/${feedConfig.address}/latest`
      );

      if (!response.data || !response.data.success) {
        throw new Error(`Failed to get latest price for ${feedId}`);
      }

      const { price, updatedAt, roundId } = response.data.data;
      const priceValue = parseFloat(price) / Math.pow(10, feedConfig.decimals);

      return {
        feedId,
        description: feedConfig.description,
        price: priceValue,
        decimals: feedConfig.decimals,
        updatedAt: new Date(updatedAt),
        roundId,
      };
    } catch (error) {
      logger.error(`Failed to get latest price for ${feedId}:`, error);
      throw new Error(
        `Failed to get data from feed ${feedId}: ${error.message}`
      );
    }
  }

  /**
   * Get historical price data from a feed
   * @param {string} feedId - The feed identifier (e.g., 'ETH-USD')
   * @param {number} startTime - Start timestamp (in milliseconds)
   * @param {number} endTime - End timestamp (in milliseconds)
   * @param {number} limit - Maximum number of data points to return
   * @returns {Promise<Array>} Historical price data
   */
  async getHistoricalData(feedId, startTime, endTime, limit = 100) {
    try {
      const feedConfig = config.getDataFeed(feedId, this.network);
      const response = await axios.get(
        `${this.endpoint}/feeds/${feedConfig.address}/history`,
        {
          params: {
            startTime,
            endTime,
            limit,
          },
        }
      );

      if (!response.data || !response.data.success) {
        throw new Error(`Failed to get historical data for ${feedId}`);
      }

      return response.data.data.map(item => ({
        feedId,
        description: feedConfig.description,
        price: parseFloat(item.price) / Math.pow(10, feedConfig.decimals),
        decimals: feedConfig.decimals,
        updatedAt: new Date(item.updatedAt),
        roundId: item.roundId,
      }));
    } catch (error) {
      logger.error(`Failed to get historical data for ${feedId}:`, error);
      throw new Error(
        `Failed to get historical data from feed ${feedId}: ${error.message}`
      );
    }
  }

  /**
   * Get multiple feed prices at once
   * @param {Array<string>} feedIds - Array of feed identifiers
   * @returns {Promise<object>} Object with feed identifiers as keys and price data as values
   */
  async getBulkPrices(feedIds) {
    try {
      const requests = feedIds.map(feedId => this.getLatestPrice(feedId));
      const results = await Promise.allSettled(requests);

      const prices = {};
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          prices[feedIds[index]] = result.value;
        } else {
          prices[feedIds[index]] = { error: result.reason.message };
        }
      });

      return prices;
    } catch (error) {
      logger.error('Failed to get bulk prices:', error);
      throw new Error(`Failed to get bulk prices: ${error.message}`);
    }
  }

  /**
   * Get all available feeds on the current network
   * @returns {Promise<Array>} List of available feeds
   */
  async getAvailableFeeds() {
    const availableFeeds = [];

    for (const [feedId, feed] of Object.entries(config.dataFeeds)) {
      if (feed[this.network]) {
        availableFeeds.push({
          id: feedId,
          description: feed.description,
          address: feed[this.network],
          decimals: feed.decimals,
        });
      }
    }

    return availableFeeds;
  }

  /**
   * Subscribe to price updates for a feed
   * @param {string} feedId - The feed identifier
   * @param {Function} callback - Callback to invoke on price updates
   * @returns {object} Subscription object with unsubscribe method
   */
  subscribeToFeed(feedId, callback) {
    // Simulated implementation - in a real implementation, this would use WebSockets
    logger.info(`Subscribing to feed ${feedId} updates`);

    // For the simulation, we'll just poll every 5 seconds
    const interval = setInterval(async () => {
      try {
        const priceData = await this.getLatestPrice(feedId);
        callback(null, priceData);
      } catch (error) {
        callback(error, null);
      }
    }, 5000);

    // Return an object with an unsubscribe method
    return {
      unsubscribe: () => {
        clearInterval(interval);
        logger.info(`Unsubscribed from feed ${feedId} updates`);
      },
    };
  }
}

module.exports = DataFeedClient;
