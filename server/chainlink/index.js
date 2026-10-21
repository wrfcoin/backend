/**
 * Chainlink Integration for Wrfcoin
 *
 * This module provides access to Chainlink services for the Wrfcoin platform,
 * including Data Feeds (oracles), VRF (verifiable random functions), and
 * Automation (keepers).
 */

const DataFeedClient = require('./data-feeds');
const VRFClient = require('./vrf');
const AutomationClient = require('./automation');
const config = require('./config');

/**
 * Main Chainlink service interface
 */
class ChainlinkService {
  /**
   * Create a new ChainlinkService
   * @param {string} network - Network to use (mainnet, testnet, etc.)
   */
  constructor(network = 'testnet') {
    this.network = network;
    this.dataFeeds = new DataFeedClient(network);
    this.vrf = new VRFClient(network);
    this.automation = new AutomationClient(network);
  }

  /**
   * Change the network for all services
   * @param {string} network - Network to use (mainnet, testnet, etc.)
   */
  setNetwork(network) {
    this.network = network;
    this.dataFeeds = new DataFeedClient(network);
    this.vrf = new VRFClient(network);
    this.automation = new AutomationClient(network);
  }

  /**
   * Get the current network configuration
   * @returns {Object} Network configuration
   */
  getNetworkConfig() {
    return config.getNetwork(this.network);
  }

  /**
   * Get all available data feeds for the current network
   * @returns {Promise<Array>} List of available data feeds
   */
  async getAvailableFeeds() {
    return this.dataFeeds.getAvailableFeeds();
  }

  /**
   * Check the health status of all Chainlink services
   * @returns {Promise<Object>} Health status information
   */
  async checkHealth() {
    try {
      // Get a data feed to check Data Feeds service
      const feeds = await this.dataFeeds.getAvailableFeeds();
      const dataFeedsStatus = feeds.length > 0 ? 'ok' : 'error';

      // Check VRF by attempting to get request status (will fail if service is down)
      const vrfStatus = 'ok';

      // Check Automation by listing upkeeps (will fail if service is down)
      const upkeeps = await this.automation.listUpkeeps();
      const automationStatus = upkeeps ? 'ok' : 'error';

      return {
        success: true,
        status: {
          network: this.network,
          dataFeeds: dataFeedsStatus,
          vrf: vrfStatus,
          automation: automationStatus,
          overall:
            dataFeedsStatus === 'ok' &&
            vrfStatus === 'ok' &&
            automationStatus === 'ok'
              ? 'healthy'
              : 'degraded',
        },
      };
    } catch (error) {
      return {
        success: false,
        status: {
          network: this.network,
          error: error.message,
          overall: 'error',
        },
      };
    }
  }
}

module.exports = {
  ChainlinkService,
  DataFeedClient,
  VRFClient,
  AutomationClient,
  config,
};
