/**
 * Luftdaten Integration Controller for Wrfcoin
 *
 * This controller manages the integration with the Luftdaten air quality sensor network
 * and provides high-level operations for integrating air quality data into the Wrfcoin
 * blockchain ecosystem.
 */

const { LuftdatenAdapter } = require('./luftdaten-adapter');
const { logger } = require('../../utils/logger');

class LuftdatenController {
  constructor(options = {}) {
    this.options = {
      testMode: options.testMode || false,
      pollingInterval: options.pollingInterval || 5 * 60 * 1000, // Default 5 minutes
      baseUrl: options.baseUrl || 'https://api.sensor.community/v1',
      ...options,
    };

    this.adapter = new LuftdatenAdapter({
      testMode: this.options.testMode,
      baseUrl: this.options.baseUrl,
    });

    this.sensors = [];
    this.pollingTimer = null;
    this.status = 'inactive';
    this.logger = logger.child({ module: 'luftdaten' });
    this.logger.info('Creating Luftdaten controller instance', {
      testMode: this.options.testMode,
    });
  }

  /**
   * Initialize the Luftdaten controller
   */
  async initialize() {
    this.logger.info('Initializing Luftdaten controller');

    try {
      // Initialize the adapter
      const adapterInitialized = await this.adapter.initialize();

      if (!adapterInitialized) {
        this.logger.error('Failed to initialize Luftdaten adapter');
        return false;
      }

      // Load registered sensors from the database
      await this.loadRegisteredSensors();

      // Start polling if we have sensors and a polling interval
      if (this.sensors.length > 0 && this.options.pollingInterval > 0) {
        this.startPolling();
      }

      this.status = 'active';
      this.logger.info('Luftdaten controller initialized successfully');

      return true;
    } catch (error) {
      this.logger.error('Error initializing Luftdaten controller', { error });
      return false;
    }
  }

  /**
   * Load registered sensors from the database or configuration
   */
  async loadRegisteredSensors() {
    this.logger.debug('Loading registered sensors');

    try {
      let sensors = await this.adapter.getRegisteredSensors();

      if (sensors.length === 0 && this.options.testMode) {
        // In test mode, add some test sensors
        const testSensors = [
          {
            sensorId: 'test-sensor-001',
            name: 'Berlin Test Sensor',
            latitude: 52.52,
            longitude: 13.41,
            altitude: 34,
            indoor: false,
          },
          {
            sensorId: 'test-sensor-002',
            name: 'New York Test Sensor',
            latitude: 40.71,
            longitude: -74.01,
            altitude: 10,
            indoor: false,
          },
          {
            sensorId: 'test-sensor-003',
            name: 'Tokyo Test Sensor',
            latitude: 35.68,
            longitude: 139.76,
            altitude: 40,
            indoor: false,
          },
        ];

        // Register each test sensor
        this.logger.info('Registering test sensors', {
          count: testSensors.length,
        });
        for (const sensor of testSensors) {
          try {
            const result = await this.adapter.registerSensor(sensor);
            this.logger.debug('Registered test sensor', {
              sensorId: sensor.sensorId,
            });
          } catch (err) {
            this.logger.error('Failed to register test sensor', {
              error: err,
              sensorId: sensor.sensorId,
            });
          }
        }

        // Get updated list of sensors
        sensors = await this.adapter.getRegisteredSensors();
      }

      this.sensors = sensors;
      this.logger.debug('Loaded registered sensors', {
        count: this.sensors.length,
      });
      return this.sensors;
    } catch (error) {
      this.logger.error('Error loading registered sensors', { error });
      return [];
    }
  }

  /**
   * Start polling for sensor data
   */
  startPolling() {
    if (this.pollingTimer !== null) {
      this.logger.debug('Polling already started, stopping first');
      this.stopPolling();
    }

    this.logger.info('Starting sensor data polling', {
      interval: this.options.pollingInterval,
      sensorCount: this.sensors.length,
    });

    // Do an initial poll immediately
    this.pollSensorData();

    // Set up regular polling
    if (this.options.pollingInterval > 0) {
      this.pollingTimer = setInterval(() => {
        this.pollSensorData();
      }, this.options.pollingInterval);
    }
  }

  /**
   * Stop polling for sensor data
   */
  stopPolling() {
    if (this.pollingTimer !== null) {
      this.logger.info('Stopping sensor data polling');
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * Poll all registered sensors for data
   */
  async pollSensorData() {
    this.logger.debug('Polling sensor data', {
      sensorCount: this.sensors.length,
    });

    const results = {
      success: 0,
      failure: 0,
    };

    for (const sensor of this.sensors) {
      try {
        // Get sensor data
        const sensorData = await this.adapter.getSensorData(sensor.id);

        // Store measurements in the database
        const stored = await this.adapter.storeMeasurements(
          sensor.id,
          sensorData.measurements
        );

        if (stored) {
          results.success++;
        } else {
          results.failure++;
        }
      } catch (error) {
        this.logger.error('Error polling sensor data', {
          error,
          sensorId: sensor.id,
        });
        results.failure++;
      }
    }

    this.logger.debug('Sensor data polling completed', { results });
    return results;
  }

  /**
   * Register a new sensor with the Luftdaten integration
   *
   * @param {Object} sensorInfo - Information about the sensor to register
   * @returns {Promise<Object>} - The registered sensor
   */
  async registerSensor(sensorInfo) {
    this.logger.info('Registering new sensor', {
      sensorId: sensorInfo.sensorId,
      name: sensorInfo.name,
    });

    try {
      const sensor = await this.adapter.registerSensor(sensorInfo);

      // Add to our internal list if not already there
      const existingSensorIndex = this.sensors.findIndex(
        s => s.id === sensorInfo.sensorId
      );

      if (existingSensorIndex >= 0) {
        this.sensors[existingSensorIndex] = {
          id: sensorInfo.sensorId,
          name: sensorInfo.name,
          latitude: sensorInfo.latitude,
          longitude: sensorInfo.longitude,
          altitude: sensorInfo.altitude,
          indoor: sensorInfo.indoor,
        };
      } else {
        this.sensors.push({
          id: sensorInfo.sensorId,
          name: sensorInfo.name,
          latitude: sensorInfo.latitude,
          longitude: sensorInfo.longitude,
          altitude: sensorInfo.altitude,
          indoor: sensorInfo.indoor,
        });
      }

      return sensor;
    } catch (error) {
      this.logger.error('Error registering sensor', { error, sensorInfo });
      throw error;
    }
  }

  /**
   * Search for Luftdaten sensors in a geographic area
   *
   * @param {Object} searchOptions - Search parameters
   * @returns {Promise<Array>} - Array of sensor metadata
   */
  async searchSensors(searchOptions) {
    return this.adapter.searchSensors(searchOptions);
  }

  /**
   * Fetch data from a specific sensor
   *
   * @param {string} sensorId - The sensor ID
   * @returns {Promise<Object>} - The sensor data
   */
  async getSensorData(sensorId) {
    return this.adapter.getSensorData(sensorId);
  }

  /**
   * Get all registered sensors
   *
   * @returns {Array} - Array of registered sensors
   */
  getRegisteredSensors() {
    return this.sensors;
  }

  /**
   * Get the status of the Luftdaten integration
   *
   * @returns {Object} - Status object
   */
  getStatus() {
    return {
      status: this.status,
      sensorCount: this.sensors.length,
      testMode: this.options.testMode,
      lastPollTime: this.lastPollTime,
      pollingInterval: this.options.pollingInterval,
    };
  }

  /**
   * Shutdown the Luftdaten controller
   */
  shutdown() {
    this.logger.info('Shutting down Luftdaten controller');
    this.stopPolling();
    this.status = 'inactive';
  }
}

module.exports = { LuftdatenController };
