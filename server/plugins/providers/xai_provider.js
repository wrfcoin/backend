/**
 * xAI Grok Provider for Wrfcoin Core
 *
 * This provider implements the AI Provider Interface using xAI's Grok API.
 * It requires that users configure their own xAI API key.
 */

const { AIProviderInterface } = require('../ai_provider_interface');
const { aimlLogger } = require('../../utils/logger.js');

class XAIProvider extends AIProviderInterface {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.XAI_API_KEY;
    this.model = config.model || 'grok-2-1212';
    this.openai = null;
    this.baseURL = 'https://api.x.ai/v1';
  }

  /**
   * Initialize the xAI provider
   * @returns {Promise<boolean>} - Success status
   */
  async initialize() {
    try {
      if (!this.apiKey) {
        aimlLogger.warn('xAI API key not provided', {
          operation: 'xai:init:no-key',
        });
        return false;
      }

      // Since xAI follows OpenAI's API pattern, we can use the OpenAI client
      const { OpenAI } = require('openai');
      this.openai = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseURL,
      });

      this.initialized = true;
      aimlLogger.info('xAI Grok provider initialized successfully', {
        operation: 'xai:init:success',
      });
      return true;
    } catch (error) {
      aimlLogger.error('Failed to initialize xAI provider', {
        operation: 'xai:init:error',
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Generate text completion using xAI Grok
   * @param {string} prompt - The prompt to complete
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated text
   */
  async generateCompletion(prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error('xAI provider not initialized');
    }

    try {
      // xAI Grok only supports chat completions, so we'll use that API
      const completion = await this.openai.chat.completions.create({
        model: options.model || this.model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.7,
      });

      return {
        text: completion.choices[0].message.content,
        usage: completion.usage,
      };
    } catch (error) {
      aimlLogger.error('Error generating xAI Grok completion', {
        operation: 'xai:completion:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate chat completion using xAI Grok
   * @param {Array} messages - Array of message objects with role and content
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated messages
   */
  async generateChatCompletion(messages, options = {}) {
    if (!this.isReady()) {
      throw new Error('xAI provider not initialized');
    }

    try {
      // Prepare a response format if JSON is requested
      const responseFormat = options.jsonResponse
        ? { type: 'json_object' }
        : undefined;

      const completion = await this.openai.chat.completions.create({
        model: options.model || this.model,
        messages: messages,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.7,
        response_format: responseFormat,
      });

      return {
        message: completion.choices[0].message,
        usage: completion.usage,
      };
    } catch (error) {
      aimlLogger.error('Error generating xAI Grok chat completion', {
        operation: 'xai:chat:error',
        error: error.message,
      });
      throw error;
    }
  }
}

module.exports = XAIProvider;
