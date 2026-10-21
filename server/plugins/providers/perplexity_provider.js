/**
 * Perplexity Provider for Wrfcoin Core
 *
 * This provider implements the AI Provider Interface using Perplexity's API.
 * It requires that users configure their own Perplexity API key.
 */

const { AIProviderInterface } = require('../ai_provider_interface');
const { aimlLogger } = require('../../utils/logger.js');

class PerplexityProvider extends AIProviderInterface {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.PERPLEXITY_API_KEY;
    this.model = config.model || 'llama-3.1-sonar-small-128k-online';
    this.baseURL = 'https://api.perplexity.ai';
  }

  /**
   * Initialize the Perplexity provider
   * @returns {Promise<boolean>} - Success status
   */
  async initialize() {
    try {
      if (!this.apiKey) {
        aimlLogger.warn('Perplexity API key not provided', {
          operation: 'perplexity:init:no-key',
        });
        return false;
      }

      this.initialized = true;
      aimlLogger.info('Perplexity provider initialized successfully', {
        operation: 'perplexity:init:success',
      });
      return true;
    } catch (error) {
      aimlLogger.error('Failed to initialize Perplexity provider', {
        operation: 'perplexity:init:error',
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Generate text completion using Perplexity
   * @param {string} prompt - The prompt to complete
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated text
   */
  async generateCompletion(prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error('Perplexity provider not initialized');
    }

    try {
      // Since Perplexity only supports chat completions interface, we'll use that
      const result = await this.generateChatCompletion(
        [
          {
            role: 'user',
            content: prompt,
          },
        ],
        options
      );

      return {
        text: result.message.content,
        usage: result.usage,
      };
    } catch (error) {
      aimlLogger.error('Error generating Perplexity completion', {
        operation: 'perplexity:completion:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate chat completion using Perplexity
   * @param {Array} messages - Array of message objects with role and content
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated messages
   */
  async generateChatCompletion(messages, options = {}) {
    if (!this.isReady()) {
      throw new Error('Perplexity provider not initialized');
    }

    try {
      // Enforce the proper message format
      const formattedMessages = this._formatMessages(messages);

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model || this.model,
          messages: formattedMessages,
          max_tokens: options.maxTokens || 1000,
          temperature: options.temperature || 0.7,
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Perplexity API error (${response.status}): ${errorText}`
        );
      }

      const result = await response.json();

      return {
        message: result.choices[0].message,
        citations: result.citations || [],
        usage: result.usage,
      };
    } catch (error) {
      aimlLogger.error('Error generating Perplexity chat completion', {
        operation: 'perplexity:chat:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Format messages to ensure proper structure for Perplexity API
   * @param {Array} messages - Input messages
   * @returns {Array} - Properly formatted messages
   */
  _formatMessages(messages) {
    // Ensure messages alternate properly and end with user
    const formattedMessages = [];
    let systemMessage = null;

    // Extract system message if present
    messages.forEach(msg => {
      if (msg.role === 'system') {
        systemMessage = msg;
      } else {
        formattedMessages.push(msg);
      }
    });

    // Add system message first if present
    if (systemMessage) {
      formattedMessages.unshift(systemMessage);
    }

    return formattedMessages;
  }
}

module.exports = PerplexityProvider;
