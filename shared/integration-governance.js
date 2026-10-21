/**
 * Wrfcoin Integration Governance System
 *
 * This module implements a governance-based system for controlling
 * the status of external integrations. It allows authorized governance
 * actions to enable, disable, or set integrations to testnet mode through
 * on-chain messages.
 */

// Integration modes
const INTEGRATION_MODES = {
  OFF: 'off', // Integration is completely disabled
  TESTNET: 'testnet', // Integration operates in testnet/sandbox mode only
  ON: 'on', // Integration is fully enabled
};

// Governance action types
const GOVERNANCE_ACTIONS = {
  SET_INTEGRATION_MODE: 'SET_INTEGRATION_MODE',
  FIRE_DRILL_START: 'FIRE_DRILL_START',
  FIRE_DRILL_END: 'FIRE_DRILL_END',
};

// Validation helper for integration status
function isValidMode(mode) {
  return Object.values(INTEGRATION_MODES).includes(mode);
}

/**
 * Create a governance message to set an integration's mode
 *
 * @param {string} integrationId - The ID of the integration
 * @param {string} mode - The mode to set (off, testnet, on)
 * @param {string} reason - Reason for the change
 * @param {number} duration - Optional duration in seconds (0 = permanent)
 * @returns {Object} Governance message
 */
function createIntegrationModeMessage(
  integrationId,
  mode,
  reason,
  duration = 0
) {
  if (!isValidMode(mode)) {
    throw new Error(`Invalid integration mode: ${mode}`);
  }

  return {
    type: GOVERNANCE_ACTIONS.SET_INTEGRATION_MODE,
    payload: {
      integrationId,
      mode,
      reason,
      duration,
      timestamp: Date.now(),
    },
  };
}

/**
 * Create a fire drill governance message
 *
 * @param {boolean} start - True for starting, false for ending fire drill
 * @param {Array<string>} integrations - List of integration IDs to affect
 * @param {string} mode - Mode to set for the fire drill (typically 'testnet' or 'off')
 * @param {number} duration - Duration in seconds
 * @returns {Object} Governance message
 */
function createFireDrillMessage(start, integrations, mode, duration) {
  if (!isValidMode(mode)) {
    throw new Error(`Invalid integration mode: ${mode}`);
  }

  return {
    type: start
      ? GOVERNANCE_ACTIONS.FIRE_DRILL_START
      : GOVERNANCE_ACTIONS.FIRE_DRILL_END,
    payload: {
      integrations,
      mode,
      duration,
      timestamp: Date.now(),
    },
  };
}

/**
 * Serialize a governance message for on-chain storage
 *
 * @param {Object} message - Governance message
 * @returns {string} JSON string
 */
function serializeMessage(message) {
  return JSON.stringify(message);
}

/**
 * Deserialize a governance message from on-chain storage
 *
 * @param {string} data - Serialized message
 * @returns {Object} Governance message
 */
function deserializeMessage(data) {
  try {
    return JSON.parse(data);
  } catch (err) {
    throw new Error(`Invalid governance message format: ${err.message}`);
  }
}

module.exports = {
  INTEGRATION_MODES,
  GOVERNANCE_ACTIONS,
  createIntegrationModeMessage,
  createFireDrillMessage,
  serializeMessage,
  deserializeMessage,
  isValidMode,
};
