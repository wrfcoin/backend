/**
 * TatauCloud Controller for Wrfcoin
 *
 * This controller manages the interaction between Wrfcoin and the TatauCloud platform
 * for distributed AI/ML tasks related to weather forecasting, sensor data analysis,
 * and climate modeling.
 */

const TatauCloudAdapter = require('./adapter');
const { logger } = require('../../utils/logger');

const tatauLogger = logger.child({ module: 'tataucloud:controller' });

class TatauCloudController {
  constructor(options = {}) {
    this.options = {
      pollingInterval: 30000, // Poll status every 30 seconds
      testMode: false,
      ...options,
    };

    this.adapter = new TatauCloudAdapter({
      apiEndpoint: options.apiEndpoint,
      apiKey: options.apiKey,
      testMode: this.options.testMode,
    });

    this.pollingInterval = null;
    this.activeJobs = new Map();
    this.initialized = false;
  }

  /**
   * Initialize the TatauCloud controller
   */
  async initialize() {
    try {
      tatauLogger.info('Initializing TatauCloud controller');

      // Get initial network status to confirm connectivity
      const networkStatus = await this.adapter.getNetworkStatus();
      tatauLogger.info('TatauCloud network status', {
        status: networkStatus.status,
      });

      if (networkStatus.status !== 'operational') {
        tatauLogger.warn('TatauCloud network is not fully operational', {
          status: networkStatus.status,
        });
      }

      // Start polling for job updates
      this._startPolling();

      this.initialized = true;
      tatauLogger.info('TatauCloud controller initialized successfully');

      return true;
    } catch (error) {
      tatauLogger.error('Failed to initialize TatauCloud controller', {
        error,
      });
      throw error;
    }
  }

  /**
   * Start polling for job status updates
   * @private
   */
  _startPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.pollingInterval = setInterval(async () => {
      await this._pollJobUpdates();
    }, this.options.pollingInterval);

    logger.info('Started TatauCloud job polling', {
      interval: this.options.pollingInterval,
      activeJobs: this.activeJobs.size,
    });
  }

  /**
   * Poll for updates on active jobs
   * @private
   */
  async _pollJobUpdates() {
    if (this.activeJobs.size === 0) return;

    logger.debug('Polling TatauCloud job updates', {
      jobCount: this.activeJobs.size,
    });

    const jobPromises = Array.from(this.activeJobs.keys()).map(async jobId => {
      try {
        const jobStatus = await this.adapter.getJobStatus(jobId);
        const prevStatus = this.activeJobs.get(jobId).status;

        // Update stored job info
        this.activeJobs.set(jobId, jobStatus);

        // If status changed, trigger callback if available
        if (prevStatus !== jobStatus.status) {
          logger.info('Job status changed', {
            jobId,
            prevStatus,
            newStatus: jobStatus.status,
          });

          const callback = this.activeJobs.get(jobId).callback;
          if (callback && typeof callback === 'function') {
            callback(jobStatus);
          }

          // Remove completed or failed jobs from active tracking
          if (
            jobStatus.status === 'completed' ||
            jobStatus.status === 'failed'
          ) {
            this.activeJobs.delete(jobId);
          }
        }
      } catch (error) {
        logger.error('Error polling job status', {
          jobId,
          error: error.message,
        });
      }
    });

    await Promise.all(jobPromises);
  }

  /**
   * Run a weather forecast using TatauCloud's AI models
   * @param {Object} params - The parameters for the forecast
   * @param {Function} statusCallback - Optional callback for status updates
   * @returns {Promise<Object>} The created job information
   */
  async runWeatherForecast(params, statusCallback = null) {
    if (!this.initialized) {
      await this.initialize();
    }

    logger.info('Submitting weather forecast job', params);

    try {
      const job = await this.adapter.runWeatherForecastJob(params);

      // Store job with callback for status updates
      this.activeJobs.set(job.id, {
        ...job,
        callback: statusCallback,
      });

      return job;
    } catch (error) {
      logger.error('Error submitting weather forecast job', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get the status of a specific job
   * @param {string} jobId - The ID of the job to check
   * @returns {Promise<Object>} Job status information
   */
  async getJobStatus(jobId) {
    return await this.adapter.getJobStatus(jobId);
  }

  /**
   * Get results from a completed job
   * @param {string} jobId - The ID of the completed job
   * @returns {Promise<Object>} Job results
   */
  async getJobResults(jobId) {
    return await this.adapter.getJobResults(jobId);
  }

  /**
   * Train a custom weather model using historical data
   * @param {Object} params - Training parameters
   * @param {Function} statusCallback - Optional callback for status updates
   * @returns {Promise<Object>} Training job information
   */
  async trainCustomWeatherModel(params, statusCallback = null) {
    if (!this.initialized) {
      await this.initialize();
    }

    logger.info('Submitting weather model training job', params);

    try {
      const job = await this.adapter.trainWeatherModel(params);

      // Store job with callback for status updates
      this.activeJobs.set(job.id, {
        ...job,
        callback: statusCallback,
      });

      return job;
    } catch (error) {
      logger.error('Error submitting weather model training job', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get available weather models in TatauCloud network
   * @param {Object} filters - Optional filters
   * @returns {Promise<Array>} List of available models
   */
  async getAvailableModels(filters = {}) {
    return await this.adapter.getAvailableModels(filters);
  }

  /**
   * Get a cost estimate for a computation job
   * @param {Object} params - Job parameters
   * @returns {Promise<Object>} Cost estimate
   */
  async getCostEstimate(params) {
    return await this.adapter.getCostEstimate(params);
  }

  /**
   * Get TatauCloud network status
   * @returns {Promise<Object>} Network status
   */
  async getNetworkStatus() {
    return await this.adapter.getNetworkStatus();
  }

  /**
   * Get available compute nodes
   * @param {Object} filters - Optional filters
   * @returns {Promise<Array>} List of available nodes
   */
  async getAvailableNodes(filters = {}) {
    return await this.adapter.getAvailableNodes(filters);
  }

  /**
   * Shut down the controller and clean up resources
   */
  shutdown() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this.activeJobs.clear();
    this.initialized = false;

    logger.info('TatauCloud controller shut down');
  }
}

module.exports = TatauCloudController;
