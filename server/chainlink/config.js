/**
 * Chainlink Configuration for Wrfcoin
 *
 * This module provides configuration values for the Chainlink integration,
 * including network endpoints, contract addresses, and supported data feeds.
 */

/**
 * Network configurations for different environments
 */
const networks = {
  mainnet: {
    name: 'Ethereum Mainnet',
    chainId: 1,
    endpoint: 'https://chainlink-external-adapter-mainnet.wrfcoin.com',
    wsEndpoint: 'wss://chainlink-external-adapter-mainnet.wrfcoin.com/ws',
    explorerUrl: 'https://etherscan.io',
  },
  testnet: {
    name: 'Ethereum Goerli',
    chainId: 5,
    endpoint: 'https://chainlink-external-adapter-testnet.wrfcoin.com',
    wsEndpoint: 'wss://chainlink-external-adapter-testnet.wrfcoin.com/ws',
    explorerUrl: 'https://goerli.etherscan.io',
  },
  wrfcoinMainnet: {
    name: 'Wrfcoin Mainnet',
    chainId: 31337,
    endpoint: 'https://chainlink-node.wrfcoin.com',
    wsEndpoint: 'wss://chainlink-node.wrfcoin.com/ws',
    explorerUrl: 'https://explorer.wrfcoin.com',
  },
  wrfcoinTestnet: {
    name: 'Wrfcoin Testnet',
    chainId: 31338,
    endpoint: 'https://chainlink-node-testnet.wrfcoin.com',
    wsEndpoint: 'wss://chainlink-node-testnet.wrfcoin.com/ws',
    explorerUrl: 'https://testnet-explorer.wrfcoin.com',
  },
};

/**
 * Supported data feeds configuration
 */
const dataFeeds = {
  // Cryptocurrency price feeds
  'ETH-USD': {
    mainnet: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    testnet: '0xD4a33860578De61DBAbDc8BFdb98FD742fA7028e',
    decimals: 8,
    description: 'ETH/USD Price Feed',
  },
  'BTC-USD': {
    mainnet: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    testnet: '0xA39434A63A52E749F02807ae27335515BA4b07F7',
    decimals: 8,
    description: 'BTC/USD Price Feed',
  },
  'USDC-USD': {
    mainnet: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    testnet: '0xAb5c49580294Aff77670F839ea425f5b78ab3Ae7',
    decimals: 8,
    description: 'USDC/USD Price Feed',
  },
  // Weather data feeds
  'TEMPERATURE-NY': {
    mainnet: '0x7F069df72b7A39bCE9806e3AfaF579E54D8CF2b9',
    testnet: '0x8A753747A1Fa494EC906cE90E9f37563A8AF630e',
    decimals: 2,
    description: 'New York Temperature (Celsius)',
  },
  'TEMPERATURE-LA': {
    mainnet: '0x72AFAECF99C9d9C8215fF44C77B94B99C28741e8',
    testnet: '0x1A602D4928faF0A153A520f58B332f9CAFF320f7',
    decimals: 2,
    description: 'Los Angeles Temperature (Celsius)',
  },
  'RAINFALL-EU': {
    mainnet: '0xaEA2808407B7319A31A383B6F8B60f04BCa23cE2',
    testnet: '0x0FCAa9c899EC5A91eBc3D5Dd869De833A06520Ed',
    decimals: 1,
    description: 'Europe Average Rainfall (mm)',
  },
  // Air quality feeds
  'AIR-QUALITY-NYC': {
    mainnet: '0x1aA396A416F7E6D49faF6B552E71B77Cf7841A6e',
    testnet: '0x9326BFA02ADD2366b30bacB125260Af641031331',
    decimals: 0,
    description: 'New York City Air Quality Index',
  },
  'AIR-QUALITY-GLOBAL': {
    mainnet: '0x6Df09E975c830ECae5bd4eD9d90f3A95a4f88012',
    testnet: '0x8c9e6c40d3402480ACE624730524fACC5482798c',
    decimals: 0,
    description: 'Global Air Quality Index',
  },
};

/**
 * Supported VRF (Verifiable Random Function) configurations
 */
const vrfConfig = {
  mainnet: {
    coordinatorAddress: '0x271682DEB8C4E0901D1a1550aD2e64D568E69909',
    keyHash:
      '0x8af398995b04c28e9951adb9721ef74c74f93e6a478f39e7e0777be13527e7ef',
    subscriptionId: 1,
    callbackGasLimit: 100000,
    fee: '0.1', // in LINK
  },
  testnet: {
    coordinatorAddress: '0x2Ca8E0C643bDe4C2E08ab1fA0da3401AdAD7734D',
    keyHash:
      '0x79d3d8832d904592c0bf9818b621522c988bb8b0c05cdc3b15aea1b6e8db0c15',
    subscriptionId: 1,
    callbackGasLimit: 100000,
    fee: '0.1', // in LINK
  },
};

/**
 * Supported Automation (Keepers) configurations
 */
const automationConfig = {
  mainnet: {
    registryAddress: '0x02777053d6764996e594c3E88AF1D58D5363a2e6',
    minUpkeepFunds: '10.0', // in LINK
    registrationFee: '5.0', // in LINK
  },
  testnet: {
    registryAddress: '0x02777053d6764996e594c3E88AF1D58D5363a2e6',
    minUpkeepFunds: '1.0', // in LINK
    registrationFee: '1.0', // in LINK
  },
};

/**
 * Function to get network configuration
 * @param {string} network - Network name
 * @returns {object} Network configuration
 */
function getNetwork(network) {
  if (!networks[network]) {
    throw new Error(`Network '${network}' not supported`);
  }
  return networks[network];
}

/**
 * Function to get data feed configuration
 * @param {string} feedId - Feed identifier
 * @param {string} network - Network name (mainnet, testnet)
 * @returns {object} Data feed configuration
 */
function getDataFeed(feedId, network = 'mainnet') {
  if (!dataFeeds[feedId]) {
    throw new Error(`Data feed '${feedId}' not supported`);
  }

  if (!dataFeeds[feedId][network]) {
    throw new Error(
      `Data feed '${feedId}' not available on network '${network}'`
    );
  }

  return {
    address: dataFeeds[feedId][network],
    decimals: dataFeeds[feedId].decimals,
    description: dataFeeds[feedId].description,
  };
}

/**
 * Function to get VRF configuration
 * @param {string} network - Network name (mainnet, testnet)
 * @returns {object} VRF configuration
 */
function getVRFConfig(network = 'mainnet') {
  if (!vrfConfig[network]) {
    throw new Error(`VRF not supported on network '${network}'`);
  }
  return vrfConfig[network];
}

/**
 * Function to get Automation configuration
 * @param {string} network - Network name (mainnet, testnet)
 * @returns {object} Automation configuration
 */
function getAutomationConfig(network = 'mainnet') {
  if (!automationConfig[network]) {
    throw new Error(`Automation not supported on network '${network}'`);
  }
  return automationConfig[network];
}

module.exports = {
  getNetwork,
  getDataFeed,
  getVRFConfig,
  getAutomationConfig,
  networks,
  dataFeeds,
  vrfConfig,
  automationConfig,
};
