/**
 * AI Provider Interface for Wrfcoin Core
 *
 * This file defines the common interface that all AI providers must implement.
 * It serves as a contract to ensure that all providers expose the same methods
 * with consistent signatures, making them interchangeable in the application.
 */

class AIProviderInterface {
  constructor(config = {}) {
    this.name = config.name || 'Default Provider';
    this.description = config.description || 'A generic AI provider';
    this.initialized = false;
    this.version = config.version || '1.0.0';
    this.capabilities = config.capabilities || {
      textGeneration: true,
      chatCompletion: true,
      weatherAnalysis: false,
      blockchainAnalysis: false,
      imageGeneration: false,
      imageAnalysis: false,
      audioTranscription: false,
    };
  }

  /**
   * Initialize the provider
   * @returns {Promise<boolean>} - Success status
   */
  async initialize() {
    throw new Error('Method not implemented: initialize()');
  }

  /**
   * Check if the provider is ready for use
   * @returns {boolean} - Provider ready status
   */
  isReady() {
    return this.initialized;
  }

  /**
   * Generate text completion
   * @param {string} prompt - The prompt to complete
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated text
   */
  async generateCompletion(prompt, options = {}) {
    throw new Error('Method not implemented: generateCompletion()');
  }

  /**
   * Generate chat completion
   * @param {Array} messages - Array of message objects with role and content
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Response with generated messages
   */
  async generateChatCompletion(messages, options = {}) {
    throw new Error('Method not implemented: generateChatCompletion()');
  }

  /**
   * Analyze weather data
   * @param {Object} data - Weather data to analyze
   * @param {string} query - Analysis query
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeWeatherData(data, query, options = {}) {
    if (!this.capabilities.weatherAnalysis) {
      throw new Error('Weather analysis not supported by this provider');
    }
    throw new Error('Method not implemented: analyzeWeatherData()');
  }

  /**
   * Analyze blockchain data
   * @param {Object} data - Blockchain data to analyze
   * @param {string} query - Analysis query
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeBlockchainData(data, query, options = {}) {
    if (!this.capabilities.blockchainAnalysis) {
      throw new Error('Blockchain analysis not supported by this provider');
    }
    throw new Error('Method not implemented: analyzeBlockchainData()');
  }

  /**
   * Generate image
   * @param {string} prompt - The prompt to generate an image from
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Generated image data
   */
  async generateImage(prompt, options = {}) {
    if (!this.capabilities.imageGeneration) {
      throw new Error('Image generation not supported by this provider');
    }
    throw new Error('Method not implemented: generateImage()');
  }

  /**
   * Analyze image
   * @param {Buffer|string} imageData - Image data (Buffer) or base64 string
   * @param {string} prompt - Analysis prompt
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeImage(imageData, prompt, options = {}) {
    if (!this.capabilities.imageAnalysis) {
      throw new Error('Image analysis not supported by this provider');
    }
    throw new Error('Method not implemented: analyzeImage()');
  }

  /**
   * Transcribe audio
   * @param {Buffer|string} audioData - Audio data (Buffer) or file path
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} - Transcription results
   */
  async transcribeAudio(audioData, options = {}) {
    if (!this.capabilities.audioTranscription) {
      throw new Error('Audio transcription not supported by this provider');
    }
    throw new Error('Method not implemented: transcribeAudio()');
  }

  /**
   * Get provider information
   * @returns {Object} - Provider information
   */
  getInfo() {
    return {
      name: this.name,
      description: this.description,
      version: this.version,
      capabilities: this.capabilities,
      initialized: this.initialized,
    };
  }
}

module.exports = {
  AIProviderInterface,
};
