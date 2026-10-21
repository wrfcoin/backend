/**
 * Anthropic Provider for Wrfcoin Core
 *
 * This provider implements the AI Provider Interface using Anthropic's Claude API.
 * It requires that users configure their own Anthropic API key.
 */

const { AIProviderInterface } = require('../ai_provider_interface');
const { aimlLogger } = require('../../utils/logger.js');

class AnthropicProvider extends AIProviderInterface {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    this.model = config.model || 'claude-3-7-sonnet-20250219'; // the newest Anthropic model is "claude-3-7-sonnet-20250219" which was released February 24, 2025
    this.anthropic = null;
  }

  /**
   * Initialize the Anthropic provider
   * @returns {Promise<boolean>} - Success status
   */
  async initialize() {
    try {
      if (!this.apiKey) {
        aimlLogger.warn('Anthropic API key not provided', {
          operation: 'anthropic:init:no-key',
        });
        return false;
      }

      // Only import Anthropic if an API key is provided
      const Anthropic = require('@anthropic-ai/sdk');
      this.anthropic = new Anthropic({
        apiKey: this.apiKey,
      });

      this.initialized = true;
      aimlLogger.info('Anthropic provider initialized successfully', {
        operation: 'anthropic:init:success',
      });
      return true;
    } catch (error) {
      aimlLogger.error('Failed to initialize Anthropic provider', {
        operation: 'anthropic:init:error',
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Generate text completion using Anthropic
   * @param {string} prompt - The prompt to complete
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated text
   */
  async generateCompletion(prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error('Anthropic provider not initialized');
    }

    try {
      // Anthropic only supports chat completions API, so we'll use that
      const completion = await this.anthropic.messages.create({
        model: options.model || this.model,
        max_tokens: options.maxTokens || 1000,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      return {
        text: completion.content[0].text,
        usage: {
          total_tokens:
            completion.usage?.input_tokens + completion.usage?.output_tokens ||
            0,
          input_tokens: completion.usage?.input_tokens || 0,
          output_tokens: completion.usage?.output_tokens || 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error generating Anthropic completion', {
        operation: 'anthropic:completion:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate chat completion using Anthropic
   * @param {Array} messages - Array of message objects with role and content
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated messages
   */
  async generateChatCompletion(messages, options = {}) {
    if (!this.isReady()) {
      throw new Error('Anthropic provider not initialized');
    }

    try {
      // Convert messages format if needed (System message is handled differently)
      let systemPrompt = null;
      const formattedMessages = [];

      for (const message of messages) {
        if (message.role === 'system') {
          systemPrompt = message.content;
        } else {
          formattedMessages.push(message);
        }
      }

      const completion = await this.anthropic.messages.create({
        model: options.model || this.model,
        max_tokens: options.maxTokens || 1000,
        system: systemPrompt,
        messages: formattedMessages,
      });

      return {
        message: {
          role: 'assistant',
          content: completion.content[0].text,
        },
        usage: {
          total_tokens:
            completion.usage?.input_tokens + completion.usage?.output_tokens ||
            0,
          input_tokens: completion.usage?.input_tokens || 0,
          output_tokens: completion.usage?.output_tokens || 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error generating Anthropic chat completion', {
        operation: 'anthropic:chat:error',
        error: error.message,
      });
      throw error;
    }
  }
}

module.exports = AnthropicProvider;
