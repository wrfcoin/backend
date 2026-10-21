/**
 * MCP Data Validator
 *
 * This module validates context data and operations to ensure they
 * meet the requirements for processing with AI models in the MCP.
 */

const { logger } = require('../utils/logger');

/**
 * Validate context data
 * @param {Object} context - Context object to validate
 * @returns {Promise<boolean>} Whether the context is valid
 */
async function validateContext(context) {
  try {
    // Check required fields
    if (!context || !context.type) {
      logger.warn('[Validator] Context missing required fields: type');
      return false;
    }

    // Validate specific context types
    switch (context.type) {
      case 'blockchain-data':
      case 'block-data':
      case 'transaction-data':
      case 'wallet-data':
      case 'network-stats':
        return validateBlockchainContext(context);

      case 'weather-data':
      case 'station-data':
      case 'forecast-data':
      case 'historical-weather':
      case 'climate-data':
        return validateWeatherContext(context);

      case 'proposal-data':
      case 'voting-data':
      case 'foundation-data':
      case 'parameter-data':
        return validateGovernanceContext(context);

      case 'computation-data':
      case 'resource-data':
      case 'job-data':
      case 'model-data':
        return validateComputationContext(context);

      default:
        // For unknown types, just check if data is present
        if (!context.data) {
          logger.warn(
            `[Validator] Context of type ${context.type} has no data`
          );
          return false;
        }

        return true;
    }
  } catch (error) {
    logger.error(`[Validator] Context validation error: ${error.message}`);
    return false;
  }
}

/**
 * Validate blockchain context data
 * @param {Object} context - Context object to validate
 * @returns {boolean} Whether the context is valid
 */
function validateBlockchainContext(context) {
  // If no data is present but dynamic loading is expected, it's valid
  if (!context.data && context.dynamic && context.providerId) {
    return true;
  }

  // If data is present, validate it
  if (!context.data) {
    logger.warn(
      `[Validator] Blockchain context of type ${context.type} has no data`
    );
    return false;
  }

  // Basic validation based on context type
  switch (context.type) {
    case 'blockchain-data':
    case 'network-stats':
      // Should have network stats
      if (!context.data.blockHeight || !context.data.hashrate) {
        logger.warn('[Validator] Blockchain data missing required fields');
        return false;
      }
      break;

    case 'block-data':
      // Should have block information
      if (!context.data.blocks && !context.data.blockNumber) {
        logger.warn('[Validator] Block data missing required fields');
        return false;
      }
      break;

    case 'transaction-data':
      // Should have transaction information
      if (!context.data.transactions && !context.data.txId) {
        logger.warn('[Validator] Transaction data missing required fields');
        return false;
      }
      break;

    case 'wallet-data':
      // Should have wallet information
      if (!context.data.address || context.data.balance === undefined) {
        logger.warn('[Validator] Wallet data missing required fields');
        return false;
      }
      break;
  }

  return true;
}

/**
 * Validate weather context data
 * @param {Object} context - Context object to validate
 * @returns {boolean} Whether the context is valid
 */
function validateWeatherContext(context) {
  // If no data is present but dynamic loading is expected, it's valid
  if (!context.data && context.dynamic && context.providerId) {
    return true;
  }

  // If data is present, validate it
  if (!context.data) {
    logger.warn(
      `[Validator] Weather context of type ${context.type} has no data`
    );
    return false;
  }

  // Basic validation based on context type
  switch (context.type) {
    case 'weather-data':
      // Should have weather observations or station information
      if (
        !context.data.observations &&
        !context.data.stationId &&
        !context.data.regions
      ) {
        logger.warn('[Validator] Weather data missing required fields');
        return false;
      }
      break;

    case 'station-data':
      // Should have station information
      if (!context.data.stationId && !context.data.stationName) {
        logger.warn('[Validator] Station data missing required fields');
        return false;
      }
      break;

    case 'forecast-data':
      // Should have forecast information
      if (!context.data.hourlyForecast && !context.data.dailyForecast) {
        logger.warn('[Validator] Forecast data missing required fields');
        return false;
      }
      break;

    case 'historical-weather':
    case 'climate-data':
      // These may have various structures, just check if some data exists
      if (Object.keys(context.data).length < 2) {
        logger.warn(
          '[Validator] Historical/climate data has insufficient structure'
        );
        return false;
      }
      break;
  }

  return true;
}

/**
 * Validate governance context data
 * @param {Object} context - Context object to validate
 * @returns {boolean} Whether the context is valid
 */
function validateGovernanceContext(context) {
  // If no data is present but dynamic loading is expected, it's valid
  if (!context.data && context.dynamic && context.providerId) {
    return true;
  }

  // If data is present, validate it
  if (!context.data) {
    logger.warn(
      `[Validator] Governance context of type ${context.type} has no data`
    );
    return false;
  }

  // Basic validation based on context type
  switch (context.type) {
    case 'proposal-data':
      // Should have proposal information
      if (!context.data.proposals && !context.data.proposalId) {
        logger.warn('[Validator] Proposal data missing required fields');
        return false;
      }
      break;

    case 'voting-data':
      // Should have voting information
      if (!context.data.votes && !context.data.proposalId) {
        logger.warn('[Validator] Voting data missing required fields');
        return false;
      }
      break;

    case 'foundation-data':
      // Should have foundation information
      if (!context.data.members && !context.data.structure) {
        logger.warn('[Validator] Foundation data missing required fields');
        return false;
      }
      break;

    case 'parameter-data':
      // Should have parameter information
      if (!context.data.parameters && !context.data.history) {
        logger.warn('[Validator] Parameter data missing required fields');
        return false;
      }
      break;
  }

  return true;
}

/**
 * Validate computation context data
 * @param {Object} context - Context object to validate
 * @returns {boolean} Whether the context is valid
 */
function validateComputationContext(context) {
  // If no data is present but dynamic loading is expected, it's valid
  if (!context.data && context.dynamic && context.providerId) {
    return true;
  }

  // If data is present, validate it
  if (!context.data) {
    logger.warn(
      `[Validator] Computation context of type ${context.type} has no data`
    );
    return false;
  }

  // Basic validation based on context type
  switch (context.type) {
    case 'computation-data':
    case 'job-data':
      // Should have job information
      if (!context.data.jobs && !context.data.jobId) {
        logger.warn('[Validator] Computation/job data missing required fields');
        return false;
      }
      break;

    case 'resource-data':
      // Should have resource information
      if (!context.data.resources && !context.data.availability) {
        logger.warn('[Validator] Resource data missing required fields');
        return false;
      }
      break;

    case 'model-data':
      // Should have model information
      if (!context.data.models && !context.data.modelId) {
        logger.warn('[Validator] Model data missing required fields');
        return false;
      }
      break;
  }

  return true;
}

/**
 * Validate an operation and its parameters
 * @param {string} operation - Operation to validate
 * @param {Object} parameters - Operation parameters
 * @returns {boolean} Whether the operation is valid
 */
function validateOperation(operation, parameters) {
  try {
    // Check if operation is provided
    if (!operation) {
      logger.warn('[Validator] Operation not specified');
      return false;
    }

    // Validate based on operation type
    switch (operation) {
      case 'get_blockchain_status':
        // No required parameters
        return true;

      case 'get_transaction':
        // Requires transaction ID
        if (!parameters.txId) {
          logger.warn('[Validator] get_transaction requires txId parameter');
          return false;
        }
        return true;

      case 'get_weather_data':
        // Requires either location or stationId
        if (!parameters.location && !parameters.stationId) {
          logger.warn(
            '[Validator] get_weather_data requires location or stationId parameter'
          );
          return false;
        }
        return true;

      case 'get_governance_proposals':
        // No required parameters
        return true;

      case 'submit_weather_data':
        // Requires stationId and measurements
        if (!parameters.stationId || !parameters.measurements) {
          logger.warn(
            '[Validator] submit_weather_data requires stationId and measurements parameters'
          );
          return false;
        }

        // Validate measurements
        if (
          !Array.isArray(parameters.measurements) &&
          typeof parameters.measurements !== 'object'
        ) {
          logger.warn(
            '[Validator] submit_weather_data measurements must be an array or object'
          );
          return false;
        }

        return true;

      case 'submit_transaction':
        // Requires recipient and amount
        if (!parameters.recipient || parameters.amount === undefined) {
          logger.warn(
            '[Validator] submit_transaction requires recipient and amount parameters'
          );
          return false;
        }

        // Validate amount
        if (
          isNaN(parseFloat(parameters.amount)) ||
          parseFloat(parameters.amount) <= 0
        ) {
          logger.warn(
            '[Validator] submit_transaction amount must be a positive number'
          );
          return false;
        }

        return true;

      case 'submit_computation_job':
        // Requires jobType and inputData
        if (!parameters.jobType || !parameters.inputData) {
          logger.warn(
            '[Validator] submit_computation_job requires jobType and inputData parameters'
          );
          return false;
        }

        return true;

      default:
        logger.warn(`[Validator] Unknown operation: ${operation}`);
        return false;
    }
  } catch (error) {
    logger.error(`[Validator] Operation validation error: ${error.message}`);
    return false;
  }
}

/**
 * Validate a model query
 * @param {string} query - Query to validate
 * @param {Object} model - Model information
 * @returns {Promise<boolean>} Whether the query is valid
 */
async function validateQuery(query, model) {
  try {
    // Check if query is provided
    if (!query || query.trim().length === 0) {
      logger.warn('[Validator] Empty query');
      return false;
    }

    // Check if query is too long for the model
    if (
      model &&
      model.maxContextLength &&
      query.length > model.maxContextLength
    ) {
      logger.warn(
        `[Validator] Query length (${query.length}) exceeds model's max context length (${model.maxContextLength})`
      );
      return false;
    }

    // Check for potentially harmful content (basic check)
    const potentiallyHarmful = [
      'rm -rf',
      'DROP TABLE',
      'DELETE FROM',
      'FORMAT',
      'sudo',
      'system(',
      'exec(',
      'eval(',
    ];

    const lowerQuery = query.toLowerCase();
    for (const term of potentiallyHarmful) {
      if (lowerQuery.includes(term.toLowerCase())) {
        logger.warn(
          `[Validator] Query contains potentially harmful content: ${term}`
        );
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.error(`[Validator] Query validation error: ${error.message}`);
    return false;
  }
}

module.exports = {
  validateContext,
  validateOperation,
  validateQuery,
};
