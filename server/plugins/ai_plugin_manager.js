/**
 * AI Plugin Manager for Wrfcoin Core
 *
 * This module manages the loading, configuration, and execution of AI plugins.
 * It acts as an intermediary between the application and various AI providers,
 * allowing seamless switching between them based on user preferences.
 */

const LocalProvider = require('./providers/local_provider');
const OpenAIProvider = require('./providers/openai_provider');
const AnthropicProvider = require('./providers/anthropic_provider');
const PerplexityProvider = require('./providers/perplexity_provider');
const XAIProvider = require('./providers/xai_provider');
const GeminiProvider = require('./providers/gemini_provider');
const HuggingFaceProvider = require('./providers/huggingface_provider');
const { aimlLogger } = require('../utils/logger.js');

class AIPluginManager {
  constructor() {
    this.providers = {
      local: new LocalProvider(),
      openai: new OpenAIProvider(),
      anthropic: new AnthropicProvider(),
      perplexity: new PerplexityProvider(),
      xai: new XAIProvider(),
      gemini: new GeminiProvider(),
      huggingface: new HuggingFaceProvider(),
    };

    this.activeProvider = null;
    this.activeProviderName = null;
    this.initialized = false;
    this.providerStats = {};

    // Initialize usage counters for each provider
    Object.keys(this.providers).forEach(name => {
      this.providerStats[name] = {
        requests: 0,
        tokens: 0,
        errors: 0,
        lastUsed: null,
      };
    });
  }

  /**
   * Initialize the plugin manager and the local provider
   * @returns {Promise<boolean>} - Success status
   */
  async initialize() {
    try {
      // Always initialize the local provider as a fallback
      const localInitialized = await this.providers.local.initialize();

      if (localInitialized) {
        // Set local as the default active provider until configured otherwise
        this.activeProvider = this.providers.local;
        this.activeProviderName = 'local';
      } else {
        aimlLogger.error('Failed to initialize local AI provider', {
          operation: 'ai:plugin:init:local:error',
        });
        return false;
      }

      this.initialized = true;
      return true;
    } catch (error) {
      aimlLogger.error('Error initializing AI Plugin Manager', {
        operation: 'ai:plugin:init:error',
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Check if the plugin manager is ready to use
   * @returns {boolean} - Ready status
   */
  isReady() {
    return (
      this.initialized && this.activeProvider && this.activeProvider.isReady()
    );
  }

  /**
   * Set the active provider
   * @param {string} providerName - The name of the provider to activate
   * @param {Object} config - Optional configuration for the provider
   * @returns {Promise<boolean>} - Success status
   */
  async setActiveProvider(providerName, config = {}) {
    try {
      if (!Object.keys(this.providers).includes(providerName)) {
        throw new Error(`Unknown provider: ${providerName}`);
      }

      const provider = this.providers[providerName];

      // If the provider has configuration, apply it
      if (Object.keys(config).length > 0) {
        Object.assign(provider, config);
      }

      // Initialize the provider if it hasn't been already
      if (!provider.isReady()) {
        const initialized = await provider.initialize();
        if (!initialized) {
          throw new Error(`Failed to initialize provider: ${providerName}`);
        }
      }

      this.activeProvider = provider;
      this.activeProviderName = providerName;

      aimlLogger.info('Activated AI provider', {
        operation: 'ai:provider:activate',
        providerName,
      });
      return true;
    } catch (error) {
      aimlLogger.error('Error setting active provider', {
        operation: 'ai:provider:activate:error',
        providerName,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Get the active provider name
   * @returns {string} - Active provider name
   */
  getActiveProviderName() {
    return this.activeProviderName;
  }

  /**
   * Configure a specific provider
   * @param {string} providerName - The name of the provider to configure
   * @param {Object} config - Configuration for the provider
   * @returns {Promise<boolean>} - Success status
   */
  async configureProvider(providerName, config) {
    try {
      if (!Object.keys(this.providers).includes(providerName)) {
        throw new Error(`Unknown provider: ${providerName}`);
      }

      const provider = this.providers[providerName];

      // Update the provider configuration
      Object.assign(provider, config);

      // If this is the active provider, reinitialize it
      if (providerName === this.activeProviderName) {
        return await provider.initialize();
      }

      return true;
    } catch (error) {
      aimlLogger.error('Error configuring provider', {
        operation: 'ai:provider:config:error',
        providerName,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Generate text completion using the active provider
   * @param {string} prompt - The prompt to complete
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response from the provider
   */
  async generateCompletion(prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error(
        'AI Plugin Manager not initialized or no active provider'
      );
    }

    try {
      const result = await this.activeProvider.generateCompletion(
        prompt,
        options
      );

      // Update stats
      this.providerStats[this.activeProviderName].requests += 1;
      this.providerStats[this.activeProviderName].lastUsed = new Date();

      if (result.usage && result.usage.total_tokens) {
        this.providerStats[this.activeProviderName].tokens +=
          result.usage.total_tokens;
      }

      return result;
    } catch (error) {
      this.providerStats[this.activeProviderName].errors += 1;

      // If the active provider fails and it's not local, try falling back to local
      if (this.activeProviderName !== 'local') {
        aimlLogger.warn('Falling back to local provider after error', {
          operation: 'ai:completion:fallback',
          originalProvider: this.activeProviderName,
          error: error.message,
        });

        try {
          const result = await this.providers.local.generateCompletion(
            prompt,
            options
          );
          result.fallback = true;
          result.originalProvider = this.activeProviderName;
          return result;
        } catch (fallbackError) {
          aimlLogger.error('Local provider fallback also failed', {
            operation: 'ai:completion:fallback:error',
            error: fallbackError.message,
          });
          throw error; // Throw the original error
        }
      }

      throw error;
    }
  }

  /**
   * Generate chat completion using the active provider
   * @param {Array} messages - Array of message objects with role and content
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response from the provider
   */
  async generateChatCompletion(messages, options = {}) {
    if (!this.isReady()) {
      throw new Error(
        'AI Plugin Manager not initialized or no active provider'
      );
    }

    try {
      const result = await this.activeProvider.generateChatCompletion(
        messages,
        options
      );

      // Update stats
      this.providerStats[this.activeProviderName].requests += 1;
      this.providerStats[this.activeProviderName].lastUsed = new Date();

      if (result.usage && result.usage.total_tokens) {
        this.providerStats[this.activeProviderName].tokens +=
          result.usage.total_tokens;
      }

      return result;
    } catch (error) {
      this.providerStats[this.activeProviderName].errors += 1;

      // If the active provider fails and it's not local, try falling back to local
      if (this.activeProviderName !== 'local') {
        aimlLogger.warn('Falling back to local provider after error', {
          operation: 'ai:chat:fallback',
          originalProvider: this.activeProviderName,
          error: error.message,
        });

        try {
          const result = await this.providers.local.generateChatCompletion(
            messages,
            options
          );
          result.fallback = true;
          result.originalProvider = this.activeProviderName;
          return result;
        } catch (fallbackError) {
          aimlLogger.error('Local provider fallback also failed', {
            operation: 'ai:chat:fallback:error',
            error: fallbackError.message,
          });
          throw error; // Throw the original error
        }
      }

      throw error;
    }
  }

  /**
   * Get statistics for provider usage
   * @returns {Object} - Usage statistics for all providers
   */
  getStats() {
    return this.providerStats;
  }

  /**
   * Test connection to a provider
   * @param {string} providerName - The name of the provider to test
   * @param {Object} config - Optional configuration for the test
   * @returns {Promise<Object>} - Test results
   */
  async testProvider(providerName, config = {}) {
    try {
      if (!Object.keys(this.providers).includes(providerName)) {
        throw new Error(`Unknown provider: ${providerName}`);
      }

      const provider = this.providers[providerName];

      // Apply temporary config for testing if provided
      const originalConfig = { ...provider };
      if (Object.keys(config).length > 0) {
        Object.assign(provider, config);
      }

      // Initialize the provider if needed
      let initialized = provider.isReady();
      if (!initialized) {
        initialized = await provider.initialize();
      }

      const result = {
        provider: providerName,
        initialized,
        status: initialized ? 'connected' : 'failed',
      };

      // If initialized, try a simple test request
      if (initialized) {
        try {
          const testResponse = await provider.generateCompletion(
            'Test connection to Wrfcoin AI plugin system',
            { maxTokens: 10 }
          );

          result.testResponse = testResponse;
          result.working = true;
        } catch (testError) {
          result.testError = testError.message;
          result.working = false;
        }
      }

      // Restore original config if we applied a temporary one
      if (Object.keys(config).length > 0) {
        Object.assign(provider, originalConfig);
      }

      return result;
    } catch (error) {
      return {
        provider: providerName,
        initialized: false,
        status: 'error',
        error: error.message,
      };
    }
  }

  /**
   * Get available providers
   * @returns {Array} - List of available provider names
   */
  getAvailableProviders() {
    return Object.keys(this.providers);
  }

  /**
   * Check if the active provider supports a capability
   * @param {string} capability - Capability name from AICapabilities
   * @returns {boolean} - Whether the capability is supported
   */
  hasCapability(capability) {
    if (!this.activeProvider) return false;
    return !!this.activeProvider.capabilities[capability];
  }

  /**
   * Invoke a provider method with capability checking
   * Returns a structured error instead of throwing if capability is unsupported
   * @param {string} method - Method name to call
   * @param {...any} args - Arguments to pass to the method
   * @returns {Promise<Object>} - Result or error object
   */
  async invokeWithCapabilityCheck(method, ...args) {
    const CAPABILITY_MAP = {
      analyzeWeatherData: 'weatherAnalysis',
      analyzeBlockchainData: 'blockchainAnalysis',
      generateImage: 'imageGeneration',
      analyzeImage: 'imageAnalysis',
      transcribeAudio: 'audioTranscription',
      generateCompletion: 'textGeneration',
      generateChatCompletion: 'chatCompletion',
    };

    if (!this.isReady()) {
      return { success: false, error: 'PROVIDER_NOT_READY', message: 'AI Plugin Manager not initialized' };
    }

    const requiredCapability = CAPABILITY_MAP[method];
    if (requiredCapability && !this.activeProvider.capabilities[requiredCapability]) {
      return {
        success: false,
        error: 'CAPABILITY_UNSUPPORTED',
        message: `Provider "${this.activeProviderName}" does not support ${requiredCapability}`,
        provider: this.activeProviderName,
      };
    }

    if (typeof this.activeProvider[method] !== 'function') {
      return { success: false, error: 'METHOD_NOT_FOUND', message: `Method ${method} not found on provider` };
    }

    try {
      const result = await this.activeProvider[method](...args);
      this.providerStats[this.activeProviderName].requests += 1;
      this.providerStats[this.activeProviderName].lastUsed = new Date();
      return { success: true, data: result };
    } catch (error) {
      this.providerStats[this.activeProviderName].errors += 1;
      aimlLogger.error(`Provider method ${method} failed`, {
        operation: `ai:${method}:error`,
        provider: this.activeProviderName,
        error: error.message,
      });
      return { success: false, error: 'PROVIDER_ERROR', message: error.message, provider: this.activeProviderName };
    }
  }
}

// Export singleton instance
module.exports = new AIPluginManager();
