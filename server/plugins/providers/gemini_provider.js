/**
 * Gemini Provider for Wrfcoin Core
 *
 * This provider implements the AI Provider Interface using Google's Gemini API.
 * It requires that users configure their own Gemini API key.
 */

const { AIProviderInterface } = require('../ai_provider_interface');
const { aimlLogger } = require('../../utils/logger.js');

class GeminiProvider extends AIProviderInterface {
  constructor(config = {}) {
    super({
      name: 'Gemini',
      description: 'Integrates with Google Gemini models',
      version: '1.0.0',
      capabilities: {
        textGeneration: true,
        chatCompletion: true,
        weatherAnalysis: true,
        blockchainAnalysis: true,
        imageAnalysis: true,
      },
      ...config,
    });

    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY;
    this.model = config.model || 'gemini-1.5-pro-latest'; // Gemini 1.5 Pro is the latest model as of May 2025
    this.gemini = null;
  }

  /**
   * Initialize the Gemini provider
   * @returns {Promise<boolean>} - Success status
   */
  async initialize() {
    try {
      if (!this.apiKey) {
        aimlLogger.warn('Gemini API key not provided', {
          operation: 'gemini:init:no-key',
        });
        return false;
      }

      // Only import the Google AI SDK if an API key is provided
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      this.gemini = new GoogleGenerativeAI(this.apiKey);

      this.initialized = true;
      aimlLogger.info('Gemini provider initialized successfully', {
        operation: 'gemini:init:success',
      });
      return true;
    } catch (error) {
      aimlLogger.error('Failed to initialize Gemini provider', {
        operation: 'gemini:init:error',
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Generate text completion using Gemini
   * @param {string} prompt - The prompt to complete
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated text
   */
  async generateCompletion(prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error('Gemini provider not initialized');
    }

    try {
      const geminiModel = this.gemini.getGenerativeModel({
        model: options.model || this.model,
      });

      const response = await geminiModel.generateContent(prompt);
      const result = response.response;

      return {
        text: result.text(),
        usage: {
          total_tokens: 0, // Gemini doesn't provide token usage in its response
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error generating Gemini completion', {
        operation: 'gemini:completion:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate chat completion using Gemini
   * @param {Array} messages - Array of message objects with role and content
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated messages
   */
  async generateChatCompletion(messages, options = {}) {
    if (!this.isReady()) {
      throw new Error('Gemini provider not initialized');
    }

    try {
      const geminiModel = this.gemini.getGenerativeModel({
        model: options.model || this.model,
      });

      // Convert the message format to match what Gemini expects
      const chat = geminiModel.startChat();
      let systemPrompt = '';

      // Extract system prompt if present
      const systemMessage = messages.find(msg => msg.role === 'system');
      if (systemMessage) {
        systemPrompt = systemMessage.content;
      }

      // Send each user message to the chat
      let lastResponse = null;
      for (const message of messages) {
        // Skip system messages as they are handled separately
        if (message.role === 'system') continue;

        // For user messages, send them to the chat
        if (message.role === 'user') {
          // Add system prompt to user message if this is the first message
          const content =
            lastResponse === null && systemPrompt
              ? `${systemPrompt}\n\n${message.content}`
              : message.content;

          lastResponse = await chat.sendMessage(content);
        }
        // For assistant messages, we'll assume they're already sent in a previous conversation
        // Gemini doesn't have a way to inject assistant messages directly
      }

      // If we didn't manage to send any messages, send a blank one
      if (lastResponse === null) {
        lastResponse = await chat.sendMessage('Please respond.');
      }

      return {
        message: {
          role: 'assistant',
          content: lastResponse.response.text(),
        },
        usage: {
          total_tokens: 0, // Gemini doesn't provide token usage
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error generating Gemini chat completion', {
        operation: 'gemini:chat:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Analyze weather data using Gemini
   * @param {Object} data - Weather data to analyze
   * @param {string} query - Analysis query
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeWeatherData(data, query, options = {}) {
    if (!this.isReady()) {
      throw new Error('Gemini provider not initialized');
    }

    try {
      // Format weather data and query for the model
      const prompt = `
Weather Data Analysis Request:
${query}

Weather Data:
${JSON.stringify(data, null, 2)}

Please analyze this weather data and provide insights based on the query.
`;

      const geminiModel = this.gemini.getGenerativeModel({
        model: options.model || this.model,
      });

      // Create a structured prompt with a system message
      const chat = geminiModel.startChat({
        systemInstruction:
          'You are a weather data analysis expert. Analyze the provided weather data and answer the query with accurate meteorological insights.',
      });

      const result = await chat.sendMessage(prompt);

      return {
        analysis: result.response.text(),
        usage: {
          total_tokens: 0, // Gemini doesn't provide token usage
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error analyzing weather data with Gemini', {
        operation: 'gemini:weather:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Analyze an image using Gemini
   * @param {Buffer|string} imageData - Image data (Buffer) or base64 string
   * @param {string} prompt - Analysis prompt
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeImage(imageData, prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error('Gemini provider not initialized');
    }

    try {
      // Convert imageData to appropriate format for Gemini
      let imageBuffer;
      if (Buffer.isBuffer(imageData)) {
        imageBuffer = imageData;
      } else if (typeof imageData === 'string') {
        // If it's a base64 string, convert to buffer
        if (imageData.startsWith('data:image/')) {
          const base64Data = imageData.split(',')[1];
          imageBuffer = Buffer.from(base64Data, 'base64');
        } else {
          // Assume it's already a base64 string without data URI prefix
          imageBuffer = Buffer.from(imageData, 'base64');
        }
      } else {
        throw new Error('Invalid image data format');
      }

      const geminiModel = this.gemini.getGenerativeModel({
        model: options.model || this.model,
      });

      // Create parts array with the image and prompt
      const parts = [
        {
          text:
            prompt ||
            'Analyze this image in detail and describe its key elements, context, and any notable aspects.',
        },
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageBuffer.toString('base64'),
          },
        },
      ];

      const result = await geminiModel.generateContent({
        contents: [{ role: 'user', parts }],
      });

      return {
        analysis: result.response.text(),
        usage: {
          total_tokens: 0, // Gemini doesn't provide token usage
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error analyzing image with Gemini', {
        operation: 'gemini:image:error',
        error: error.message,
      });
      throw error;
    }
  }
}

module.exports = GeminiProvider;
