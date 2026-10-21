/**
 * Cross-Chain Integration Module
 *
 * This module exports the adapter, controller, and routes for the cross-chain
 * integration functionality, which allows Wrfcoin to communicate with other
 * blockchain networks and transfer environmental data.
 */

const { CrossChainAdapter } = require('./adapter');
const { CrossChainController } = require('./controller');
const { logger } = require('../../utils/logger');

// Create controller instance with test mode by default
const crossChainController = new CrossChainController({
  testMode: process.env.NODE_ENV !== 'production',
  defaultProvider: 'zeta',
  enabledProviders: ['zeta', 'axelar', 'layerzero'],
});

// Initialize the controller on first import
(async () => {
  try {
    const initialized = await crossChainController.initialize();
    if (initialized) {
      logger.info('Cross-chain integration initialized successfully', {
        module: 'cross-chain',
      });
    } else {
      logger.error('Failed to initialize cross-chain integration', {
        module: 'cross-chain',
      });
    }
  } catch (error) {
    logger.error('Error initializing cross-chain integration', {
      error,
      module: 'cross-chain',
    });
  }
})();

module.exports = {
  adapter: new CrossChainAdapter({
    testMode: process.env.NODE_ENV !== 'production',
  }),
  controller: crossChainController,
};
