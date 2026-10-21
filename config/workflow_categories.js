/**
 * Wrfcoin Workflow Categories
 *
 * This file defines workflow categories for easier management during development.
 * Categories allow enabling/disabling groups of related workflows together.
 */

module.exports = {
  // Core components - essential for basic blockchain functionality
  core: {
    name: 'Core Components',
    description: 'Essential blockchain services and APIs',
    workflows: [
      'Wrfcoin Core',
      'API Server',
      'WebSocket Server',
      'Database Push',
      'DB Push',
    ],
  },

  // Database management components
  database: {
    name: 'Database Management',
    description: 'Database migration and schema management tools',
    workflows: [
      'DB Migrate',
      'DB Migrate Apply',
      'DB Migrate List',
      'Generate Schema',
      'Axelar Schema Push',
      'Create Migration',
      'Create Data-Aware Blocks Migration',
    ],
  },

  // Consensus and blockchain testing components
  blockchain: {
    name: 'Blockchain & Consensus',
    description: 'Core blockchain testing and validation',
    workflows: [
      'Test Blockchain',
      'Test Incentives',
      'Test PoP',
      'Test Light Client',
      'Test Validator Node',
      'Test Slashing Mechanism',
      'Seed Validators',
    ],
  },

  // Cross-chain integration components
  crosschain: {
    name: 'Cross-Chain Integration',
    description: 'Cross-chain bridges and integration tests',
    workflows: [
      'Test Cross-Chain',
      'Test Cross-Chain Integration',
      'Test Cross-Chain Providers',
      'Test Sidechain',
      'Test LayerZero',
      'Test Axelar',
      'Test Wormhole',
    ],
  },

  // Privacy features
  privacy: {
    name: 'Privacy Features',
    description: 'Privacy-focused components and testing',
    workflows: ['Test Privacy', 'Test Privacy Features'],
  },

  // Governance components
  governance: {
    name: 'Governance',
    description: 'Governance system and related components',
    workflows: [
      'Test Governance',
      'Test Governance Security',
      'Test Governance System',
      'Setup Governance DB',
      'Seed Governance',
    ],
  },

  // Computational and data processing components
  computational: {
    name: 'Computational & Data',
    description: 'Computational tasks and data processing',
    workflows: [
      'Test Computational Blocks',
      'Test Computational DB',
      'Test Fixed Database',
      'Test TypeScript DB',
      'Test Forecast Compute Node',
      'Test Storage Keeper Node',
      'Setup Wolfram DB',
    ],
  },

  // Weather and climate data components
  weather: {
    name: 'Weather & Climate',
    description: 'Weather station and data validation',
    workflows: [
      'Test Weather Data Validation',
      'Test Weather Parsers',
      'Test Weather Station Protocol',
      'Oracle Schema Migration',
    ],
  },

  // External blockchain integrations
  externalChains: {
    name: 'External Networks',
    description: 'Integration with external blockchain networks',
    workflows: [
      'Test Akash Network',
      'Test Arweave',
      'Test Bittensor',
      'Test Near Protocol',
    ],
  },

  // Data storage and processing networks
  dataNetworks: {
    name: 'Data Networks',
    description: 'Integration with data and storage networks',
    workflows: [
      'Test BigchainDB',
      'Test FOAM',
      'Test Golem',
      'Test Streamr',
      'Test Storj',
      'Test SONM',
      'Test TatauCloud',
    ],
  },

  // IoT and sensor networks
  iotNetworks: {
    name: 'IoT & Sensors',
    description: 'IoT and sensor network integrations',
    workflows: [
      'Test IoT Devices',
      'Test Luftdaten',
      'Test OGC',
      'Test Sensor.Community',
      'Test TTN',
    ],
  },

  // Rewards and achievements
  rewards: {
    name: 'Rewards & Achievements',
    description: 'Reward and achievement management',
    workflows: ['Seed Achievements', 'Test Achievements', 'Seed Rewards'],
  },

  // Miscellaneous testing components
  testing: {
    name: 'Testing Infrastructure',
    description: 'Miscellaneous testing utilities',
    workflows: [
      'Test Workflow Categories',
      'Test Smart Contract Security',
      'Mainnet Mode',
    ],
  },
};
