/**
 * Shared WebSocket channel constants.
 *
 * Both WebSocket server implementations must use these values so that
 * clients can subscribe to exactly one name per channel regardless of
 * which server handles the connection (#454).
 *
 * Values are lowercase-hyphenated strings matching the main websocket.js
 * CHANNELS object, which is the canonical source of truth.
 */

const CHANNELS = {
  GLOBAL: 'global',
  BLOCKCHAIN: 'blockchain',
  BLOCKS: 'blocks',
  COMPUTATIONAL: 'computational',
  CROSS_CHAIN: 'cross-chain',
  GOVERNANCE: 'governance',
  MINING: 'mining',
  API_MONITORING: 'api-monitoring',
  WEATHER: 'weather',
};

module.exports = { CHANNELS };
