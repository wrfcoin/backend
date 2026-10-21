/**
 * OpenAI Provider for Wrfcoin Core
 *
 * This provider implements the AI Provider Interface using OpenAI's API.
 * It requires that users configure their own OpenAI API key.
 */

const { AIProviderInterface } = require('../ai_provider_interface');
const { aimlLogger } = require('../../utils/logger.js');

class OpenAIProvider extends AIProviderInterface {
  constructor(config = {}) {
    super({
      name: 'OpenAI',
      description: 'Integrates with OpenAI models including GPT-4o',
      version: '1.0.0',
      capabilities: {
        textGeneration: true,
        chatCompletion: true,
        weatherAnalysis: true,
        blockchainAnalysis: true,
        imageGeneration: true,
        imageAnalysis: true,
        audioTranscription: true,
      },
      ...config,
    });

    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    this.model = config.model || 'gpt-4o'; // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
    this.openai = null;
  }

  /**
   * Initialize the OpenAI provider
   * @returns {Promise<boolean>} - Success status
   */
  async initialize() {
    try {
      if (!this.apiKey) {
        aimlLogger.warn('OpenAI API key not provided', {
          operation: 'openai:init:no-key',
        });
        return false;
      }

      // Only import OpenAI if an API key is provided
      let OpenAI;
      try {
        // Dynamically import OpenAI, so it works even if the package is removed
        OpenAI = require('openai');
      } catch (importError) {
        aimlLogger.warn('OpenAI package not available', {
          operation: 'openai:init:package-missing',
        });
        return false;
      }

      this.openai = new OpenAI({
        apiKey: this.apiKey,
      });

      this.initialized = true;
      aimlLogger.info('OpenAI provider initialized successfully', {
        operation: 'openai:init:success',
      });
      return true;
    } catch (error) {
      aimlLogger.error('Failed to initialize OpenAI provider', {
        operation: 'openai:init:error',
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Generate text completion using OpenAI
   * @param {string} prompt - The prompt to complete
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated text
   */
  async generateCompletion(prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error('OpenAI provider not initialized');
    }

    try {
      // OpenAI now uses chat completions API for all completions
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
        response_format: options.responseFormat
          ? { type: options.responseFormat }
          : undefined,
      });

      return {
        text: completion.choices[0].message.content,
        usage: completion.usage || {
          total_tokens: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error generating OpenAI completion', {
        operation: 'openai:completion:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate chat completion using OpenAI
   * @param {Array} messages - Array of message objects with role and content
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated messages
   */
  async generateChatCompletion(messages, options = {}) {
    if (!this.isReady()) {
      throw new Error('OpenAI provider not initialized');
    }

    try {
      const completion = await this.openai.chat.completions.create({
        model: options.model || this.model,
        messages: messages,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.7,
        response_format: options.responseFormat
          ? { type: options.responseFormat }
          : undefined,
      });

      return {
        message: completion.choices[0].message,
        usage: completion.usage || {
          total_tokens: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error generating OpenAI chat completion', {
        operation: 'openai:chat:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Analyze weather data using OpenAI
   * @param {Object} data - Weather data to analyze
   * @param {string} query - Analysis query
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeWeatherData(data, query, options = {}) {
    if (!this.isReady()) {
      throw new Error('OpenAI provider not initialized');
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

      const completion = await this.openai.chat.completions.create({
        model: options.model || this.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a weather data analysis expert. Analyze the provided weather data and answer the query with accurate meteorological insights.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: options.maxTokens || 1500,
        temperature: options.temperature || 0.3, // Lower temperature for more focused analysis
        response_format:
          options.responseFormat === 'json_object'
            ? { type: 'json_object' }
            : undefined,
      });

      return {
        analysis: completion.choices[0].message.content,
        usage: completion.usage || {
          total_tokens: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error analyzing weather data with OpenAI', {
        operation: 'openai:weather:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate an image using OpenAI's DALL-E
   * @param {string} prompt - The prompt to generate an image from
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Generated image data
   */
  async generateImage(prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error('OpenAI provider not initialized');
    }

    try {
      const response = await this.openai.images.generate({
        model: options.model || 'dall-e-3',
        prompt: prompt,
        n: options.n || 1,
        size: options.size || '1024x1024',
        quality: options.quality || 'standard',
      });

      return {
        images: response.data.map(img => ({
          url: img.url,
          b64: img.b64_json,
        })),
        prompt: prompt,
      };
    } catch (error) {
      aimlLogger.error('Error generating image with OpenAI', {
        operation: 'openai:image:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Analyze an image using OpenAI
   * @param {Buffer|string} imageData - Image data (Buffer) or base64 string
   * @param {string} prompt - Analysis prompt
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeImage(imageData, prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error('OpenAI provider not initialized');
    }

    try {
      // Convert imageData to appropriate format for OpenAI
      let base64Image;
      if (Buffer.isBuffer(imageData)) {
        base64Image = imageData.toString('base64');
      } else if (typeof imageData === 'string') {
        // Remove data URI prefix if it exists
        base64Image = imageData.replace(/^data:image\/[a-z]+;base64,/, '');
      } else {
        throw new Error('Invalid image data format');
      }

      const response = await this.openai.chat.completions.create({
        model: options.model || this.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  prompt ||
                  'Analyze this image in detail and describe its key elements, context, and any notable aspects.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: options.maxTokens || 500,
      });

      return {
        analysis: response.choices[0].message.content,
        usage: response.usage || {
          total_tokens: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error analyzing image with OpenAI', {
        operation: 'openai:image-analysis:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Transcribe audio using OpenAI's Whisper
   * @param {Buffer|string} audioData - Audio data (Buffer) or file path
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Transcription results
   */
  async transcribeAudio(audioData, options = {}) {
    if (!this.isReady()) {
      throw new Error('OpenAI provider not initialized');
    }

    try {
      // For simplicity, we'll assume audioData is a file path
      const fs = require('fs');

      const transcription = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(audioData),
        model: 'whisper-1',
        language: options.language,
        prompt: options.prompt,
      });

      return {
        text: transcription.text,
        duration: transcription.duration || 0,
      };
    } catch (error) {
      aimlLogger.error('Error transcribing audio with OpenAI', {
        operation: 'openai:transcription:error',
        error: error.message,
      });
      throw error;
    }
  }
}

module.exports = OpenAIProvider;
