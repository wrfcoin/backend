/**
 * Model Registry for the Model Context Protocol
 *
 * This module manages the registration and retrieval of AI models
 * that are compatible with the Model Context Protocol.
 */

const { randomBytes, createHash } = require('crypto');
const { logger } = require('../utils/logger');

// In-memory storage for models (would be replaced with a database in production)
const models = new Map();

// Default models to initialize the registry with
const defaultModels = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    version: '2024-05-13',
    description: 'Advanced multimodal model with vision and audio capabilities',
    capabilities: [
      'text-generation',
      'image-understanding',
      'audio-processing',
      'blockchain-operations',
    ],
    contextTypes: [
      'blockchain-data',
      'weather-data',
      'transaction-data',
      'governance-data',
      'image-data',
    ],
    maxContextLength: 128000,
    interface: 'chat',
    endpointType: 'api',
    parameters: {
      temperature: { type: 'float', default: 0.7, min: 0, max: 2 },
      topP: { type: 'float', default: 0.95, min: 0, max: 1 },
      presencePenalty: { type: 'float', default: 0, min: -2, max: 2 },
      frequencyPenalty: { type: 'float', default: 0, min: -2, max: 2 },
      maxOutputTokens: { type: 'integer', default: 4096, min: 1, max: 4096 },
    },
    metadata: {
      created: new Date('2024-05-13').toISOString(),
      lastUpdated: new Date().toISOString(),
    },
  },
  {
    id: 'claude-3-7-sonnet',
    name: 'Claude 3.7 Sonnet',
    provider: 'anthropic',
    version: '20250219',
    description:
      'Advanced reasoning and context understanding with blockchain awareness',
    capabilities: [
      'text-generation',
      'image-understanding',
      'blockchain-operations',
      'structured-output',
    ],
    contextTypes: [
      'blockchain-data',
      'weather-data',
      'transaction-data',
      'governance-data',
      'image-data',
    ],
    maxContextLength: 200000,
    interface: 'chat',
    endpointType: 'api',
    parameters: {
      temperature: { type: 'float', default: 0.7, min: 0, max: 1 },
      topP: { type: 'float', default: 0.95, min: 0, max: 1 },
      topK: { type: 'integer', default: 40, min: 1, max: 100 },
      maxOutputTokens: { type: 'integer', default: 4096, min: 1, max: 4096 },
    },
    metadata: {
      created: new Date('2025-02-19').toISOString(),
      lastUpdated: new Date().toISOString(),
    },
  },
  {
    id: 'wrfcoin-local-model',
    name: 'Wrfcoin Local Model',
    provider: 'wrfcoin',
    version: '1.0.0',
    description:
      'Local model optimized for Wrfcoin blockchain operations and weather data analysis',
    capabilities: [
      'text-generation',
      'blockchain-operations',
      'weather-analysis',
    ],
    contextTypes: [
      'blockchain-data',
      'weather-data',
      'transaction-data',
      'computational-data',
    ],
    maxContextLength: 16384,
    interface: 'chat',
    endpointType: 'local',
    parameters: {
      temperature: { type: 'float', default: 0.7, min: 0, max: 1 },
      maxOutputTokens: { type: 'integer', default: 1024, min: 1, max: 2048 },
    },
    metadata: {
      created: new Date('2025-01-15').toISOString(),
      lastUpdated: new Date().toISOString(),
    },
  },
];

/**
 * Initialize the model registry with default models
 */
async function initialize() {
  try {
    logger.info('[ModelRegistry] Initializing model registry');

    // Add default models if the registry is empty
    if (models.size === 0) {
      for (const model of defaultModels) {
        models.set(model.id, model);
      }

      logger.info(
        `[ModelRegistry] Initialized with ${models.size} default models`
      );
    }
  } catch (error) {
    logger.error(`[ModelRegistry] Initialization error: ${error.message}`);
    throw error;
  }
}

/**
 * Register a new model
 * @param {Object} modelData - Model data
 * @returns {Promise<Object>} Registered model
 */
async function registerModel(modelData) {
  try {
    // Validate required fields
    if (!modelData.name || !modelData.provider || !modelData.version) {
      throw new Error('Missing required fields: name, provider, and version');
    }

    // Generate an ID if not provided
    const modelId = modelData.id || generateModelId(modelData);

    // Check if model already exists
    if (models.has(modelId)) {
      throw new Error(`Model with ID '${modelId}' already exists`);
    }

    // Create the model
    const model = {
      id: modelId,
      name: modelData.name,
      provider: modelData.provider,
      version: modelData.version,
      description: modelData.description || '',
      capabilities: modelData.capabilities || [],
      contextTypes: modelData.contextTypes || [],
      maxContextLength: modelData.maxContextLength || 4096,
      interface: modelData.interface || 'chat',
      endpointType: modelData.endpointType || 'api',
      parameters: modelData.parameters || {},
      metadata: {
        created: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        ...modelData.metadata,
      },
    };

    // Store the model
    models.set(modelId, model);

    logger.info(`[ModelRegistry] Registered model: ${modelId}`);

    return model;
  } catch (error) {
    logger.error(`[ModelRegistry] Model registration error: ${error.message}`);
    throw error;
  }
}

/**
 * Update an existing model
 * @param {string} modelId - Model ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated model
 */
async function updateModel(modelId, updates) {
  try {
    // Check if model exists
    if (!models.has(modelId)) {
      throw new Error(`Model with ID '${modelId}' not found`);
    }

    // Get the current model
    const model = models.get(modelId);

    // Update fields
    const updatedModel = {
      ...model,
      ...updates,
      id: modelId, // Ensure ID doesn't change
      metadata: {
        ...model.metadata,
        ...updates.metadata,
        lastUpdated: new Date().toISOString(),
      },
    };

    // Store the updated model
    models.set(modelId, updatedModel);

    logger.info(`[ModelRegistry] Updated model: ${modelId}`);

    return updatedModel;
  } catch (error) {
    logger.error(`[ModelRegistry] Model update error: ${error.message}`);
    throw error;
  }
}

/**
 * Get a model by ID
 * @param {string} modelId - Model ID
 * @returns {Promise<Object|null>} Model data or null if not found
 */
async function getModel(modelId) {
  try {
    const model = models.get(modelId) || null;

    if (!model) {
      logger.warn(`[ModelRegistry] Model not found: ${modelId}`);
    }

    return model;
  } catch (error) {
    logger.error(`[ModelRegistry] Model retrieval error: ${error.message}`);
    throw error;
  }
}

/**
 * Delete a model by ID
 * @param {string} modelId - Model ID
 * @returns {Promise<boolean>} Whether the model was deleted
 */
async function deleteModel(modelId) {
  try {
    if (!models.has(modelId)) {
      logger.warn(`[ModelRegistry] Model not found for deletion: ${modelId}`);
      return false;
    }

    models.delete(modelId);
    logger.info(`[ModelRegistry] Deleted model: ${modelId}`);

    return true;
  } catch (error) {
    logger.error(`[ModelRegistry] Model deletion error: ${error.message}`);
    throw error;
  }
}

/**
 * List all registered models
 * @param {Object} filters - Optional filters (provider, capability, etc.)
 * @returns {Promise<Array<Object>>} List of models
 */
async function listModels(filters = {}) {
  try {
    let result = Array.from(models.values());

    // Apply filters if provided
    if (filters.provider) {
      result = result.filter(model => model.provider === filters.provider);
    }

    if (filters.capability) {
      result = result.filter(model =>
        model.capabilities.includes(filters.capability)
      );
    }

    if (filters.contextType) {
      result = result.filter(model =>
        model.contextTypes.includes(filters.contextType)
      );
    }

    if (filters.interface) {
      result = result.filter(model => model.interface === filters.interface);
    }

    if (filters.endpointType) {
      result = result.filter(
        model => model.endpointType === filters.endpointType
      );
    }

    return result;
  } catch (error) {
    logger.error(`[ModelRegistry] Model listing error: ${error.message}`);
    throw error;
  }
}

/**
 * Find models that support specific context types
 * @param {string[]} contextTypes - Context types to find support for
 * @returns {Promise<Array<Object>>} List of compatible models
 */
async function findModelsByContextTypes(contextTypes) {
  try {
    const result = Array.from(models.values()).filter(model => {
      return contextTypes.every(type => model.contextTypes.includes(type));
    });

    return result;
  } catch (error) {
    logger.error(`[ModelRegistry] Context type search error: ${error.message}`);
    throw error;
  }
}

/**
 * Generate a model ID based on model data
 * @param {Object} modelData - Model data
 * @returns {string} Generated model ID
 */
function generateModelId(modelData) {
  const baseId = `${modelData.provider}-${modelData.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${modelData.version}`;
  const hash = createHash('sha256')
    .update(JSON.stringify(modelData))
    .digest('hex')
    .slice(0, 8);

  return `${baseId}-${hash}`;
}

/**
 * Check if a model exists
 * @param {string} modelId - Model ID
 * @returns {Promise<boolean>} Whether the model exists
 */
async function modelExists(modelId) {
  return models.has(modelId);
}

// Initialize the registry when this module is imported
initialize().catch(error => {
  logger.error(`[ModelRegistry] Failed to initialize: ${error.message}`);
});

module.exports = {
  registerModel,
  updateModel,
  getModel,
  deleteModel,
  listModels,
  findModelsByContextTypes,
  modelExists,
};
