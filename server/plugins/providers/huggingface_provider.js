/**
 * HuggingFace Provider for Wrfcoin Core
 *
 * This provider implements the AI Provider Interface using HuggingFace's Inference API.
 * It requires that users configure their own HuggingFace API key.
 */

const { AIProviderInterface } = require('../ai_provider_interface');
const { aimlLogger } = require('../../utils/logger.js');

class HuggingFaceProvider extends AIProviderInterface {
  constructor(config = {}) {
    super({
      name: 'HuggingFace',
      description:
        'Integrates with HuggingFace Inference API for open source models',
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

    this.apiKey = config.apiKey || process.env.HUGGINGFACE_API_KEY;
    this.model = config.model || 'mistralai/Mixtral-8x7B-Instruct-v0.1'; // Default model
    this.hf = null;
    this.baseUrl = 'https://api-inference.huggingface.co/models';
  }

  /**
   * Initialize the HuggingFace provider
   * @returns {Promise<boolean>} - Success status
   */
  async initialize() {
    try {
      if (!this.apiKey) {
        aimlLogger.warn('HuggingFace API key not provided', {
          operation: 'huggingface:init:no-key',
        });
        return false;
      }

      // For HuggingFace, we'll use a simple fetch-based client
      // Importing node-fetch for server-side fetch API
      const fetch = require('node-fetch');
      this.fetch = fetch;

      this.initialized = true;
      aimlLogger.info('HuggingFace provider initialized successfully', {
        operation: 'huggingface:init:success',
      });
      return true;
    } catch (error) {
      aimlLogger.error('Failed to initialize HuggingFace provider', {
        operation: 'huggingface:init:error',
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Make a request to the HuggingFace Inference API
   * @param {string} model - The model to use
   * @param {Object} payload - The request payload
   * @returns {Promise<Object>} - API response
   */
  async makeHfRequest(model, payload) {
    const url = `${this.baseUrl}/${model}`;

    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HuggingFace API error: ${error}`);
    }

    return await response.json();
  }

  /**
   * Generate text completion using HuggingFace
   * @param {string} prompt - The prompt to complete
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated text
   */
  async generateCompletion(prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error('HuggingFace provider not initialized');
    }

    try {
      const model = options.model || this.model;
      const payload = {
        inputs: prompt,
        parameters: {
          max_new_tokens: options.maxTokens || 1000,
          temperature: options.temperature || 0.7,
          top_p: options.top_p || 0.95,
          do_sample: options.do_sample !== undefined ? options.do_sample : true,
          return_full_text:
            options.return_full_text !== undefined
              ? options.return_full_text
              : false,
        },
      };

      const result = await this.makeHfRequest(model, payload);

      let generatedText = '';
      if (Array.isArray(result)) {
        if (result[0] && result[0].generated_text) {
          generatedText = result[0].generated_text;
        }
      } else if (result && result.generated_text) {
        generatedText = result.generated_text;
      }

      return {
        text: generatedText,
        usage: {
          total_tokens: 0, // HuggingFace doesn't provide token usage in free tier
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error generating HuggingFace completion', {
        operation: 'huggingface:completion:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Generate chat completion using HuggingFace
   * @param {Array} messages - Array of message objects with role and content
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated messages
   */
  async generateChatCompletion(messages, options = {}) {
    if (!this.isReady()) {
      throw new Error('HuggingFace provider not initialized');
    }

    try {
      const model = options.model || this.model;

      // Format messages into a chat prompt for the model
      // Different models expect different formats, so we'll use a general approach
      let prompt = '';

      // Extract system message if present
      const systemMessage = messages.find(msg => msg.role === 'system');
      if (systemMessage) {
        prompt += `<|system|>\n${systemMessage.content}\n`;
      }

      // Add user and assistant messages in order
      for (const message of messages) {
        if (message.role === 'system') continue; // Already handled

        if (message.role === 'user') {
          prompt += `<|user|>\n${message.content}\n`;
        } else if (message.role === 'assistant') {
          prompt += `<|assistant|>\n${message.content}\n`;
        }
      }

      // End with the assistant tag to generate the next assistant response
      prompt += '<|assistant|>\n';

      const payload = {
        inputs: prompt,
        parameters: {
          max_new_tokens: options.maxTokens || 1000,
          temperature: options.temperature || 0.7,
          top_p: options.top_p || 0.95,
          do_sample: options.do_sample !== undefined ? options.do_sample : true,
          return_full_text: false,
        },
      };

      const result = await this.makeHfRequest(model, payload);

      let generatedText = '';
      if (Array.isArray(result)) {
        if (result[0] && result[0].generated_text) {
          generatedText = result[0].generated_text;
        }
      } else if (result && result.generated_text) {
        generatedText = result.generated_text;
      }

      return {
        message: {
          role: 'assistant',
          content: generatedText,
        },
        usage: {
          total_tokens: 0, // HuggingFace doesn't provide token usage in free tier
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error generating HuggingFace chat completion', {
        operation: 'huggingface:chat:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Analyze weather data using HuggingFace
   * @param {Object} data - Weather data to analyze
   * @param {string} query - Analysis query
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeWeatherData(data, query, options = {}) {
    if (!this.isReady()) {
      throw new Error('HuggingFace provider not initialized');
    }

    try {
      // Format weather data and query for the model
      const prompt = `
<|system|>
You are a weather data analysis expert. Analyze the provided weather data and answer the query with accurate meteorological insights.

<|user|>
Weather Data Analysis Request:
${query}

Weather Data:
${JSON.stringify(data, null, 2)}

Please analyze this weather data and provide insights based on the query.

<|assistant|>
`;

      const model = options.model || this.model;
      const payload = {
        inputs: prompt,
        parameters: {
          max_new_tokens: options.maxTokens || 1500,
          temperature: options.temperature || 0.3, // Lower temperature for more focused analysis
          top_p: options.top_p || 0.95,
          do_sample: options.do_sample !== undefined ? options.do_sample : true,
          return_full_text: false,
        },
      };

      const result = await this.makeHfRequest(model, payload);

      let analysis = '';
      if (Array.isArray(result)) {
        if (result[0] && result[0].generated_text) {
          analysis = result[0].generated_text;
        }
      } else if (result && result.generated_text) {
        analysis = result.generated_text;
      }

      return {
        analysis: analysis,
        usage: {
          total_tokens: 0, // HuggingFace doesn't provide token usage in free tier
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error analyzing weather data with HuggingFace', {
        operation: 'huggingface:weather:error',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Analyze an image using HuggingFace
   * @param {Buffer|string} imageData - Image data (Buffer) or base64 string
   * @param {string} prompt - Analysis prompt
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeImage(imageData, prompt, options = {}) {
    if (!this.isReady()) {
      throw new Error('HuggingFace provider not initialized');
    }

    try {
      // Convert imageData to Buffer for multipart form data
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

      // For image analysis, we need to use a multipart form and a vision model
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', imageBuffer, 'image.jpg');

      if (prompt) {
        form.append(
          'text',
          prompt ||
            'Analyze this image in detail and describe its key elements, context, and any notable aspects.'
        );
      }

      // Use a vision model by default for image analysis
      const visionModel =
        options.model || 'Salesforce/blip-image-captioning-large';
      const url = `${this.baseUrl}/${visionModel}`;

      const response = await this.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: form,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`HuggingFace API error: ${error}`);
      }

      const result = await response.json();

      return {
        analysis: Array.isArray(result) ? result[0] : result,
        usage: {
          total_tokens: 0, // HuggingFace doesn't provide token usage
          prompt_tokens: 0,
          completion_tokens: 0,
        },
      };
    } catch (error) {
      aimlLogger.error('Error analyzing image with HuggingFace', {
        operation: 'huggingface:image:error',
        error: error.message,
      });
      throw error;
    }
  }
}

module.exports = HuggingFaceProvider;
