/**
 * Sensor.Community Integration Adapter (MOCK VERSION)
 *
 * This is a mocked version of the Sensor.Community adapter to work around
 * the axios dependency issue. Instead of making actual API calls, it returns
 * static mock data.
 *
 * Original version would fetch PM2.5, PM10, temperature, humidity, and pressure
 * data from the global network of DIY sensors.
 */

// Mock implementation - no need for axios
// const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../utils/logger')('sensor-community:adapter');

// Base API endpoints
const API_ENDPOINTS = {
  ALL_SENSORS: 'https://data.sensor.community/airrohr/v1/filter/type=SDS011',
  SENSOR_DATA: 'https://data.sensor.community/airrohr/v1/sensor/',
  ARCHIVED_DATA: 'https://archive.sensor.community/api/v1/',
};

// Data types mapped to Sensor.Community sensor types
const DATA_TYPES = {
  PM25: 'SDS011', // Particulate Matter 2.5μm
  PM10: 'SDS011', // Particulate Matter 10μm
  TEMPERATURE: 'DHT22', // Temperature
  HUMIDITY: 'DHT22', // Humidity
  PRESSURE: 'BMP280', // Atmospheric pressure
};

class SensorCommunityAdapter {
  constructor() {
    this.initialized = false;
    logger.info('Initializing Sensor.Community adapter');
  }

  /**
   * Initialize the adapter
   */
  async initialize() {
    try {
      // Check if the API is accessible
      await this.checkApiStatus();
      this.initialized = true;
      logger.info('Sensor.Community adapter initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Sensor.Community adapter', {
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Check if the Sensor.Community API is accessible
   * This is a mock implementation that always returns success
   */
  async checkApiStatus() {
    try {
      // Mock successful API check
      logger.debug('Sensor.Community API check successful (MOCK)');
      return true;
    } catch (error) {
      logger.error('Sensor.Community API check failed', {
        error: error.message,
      });
      throw new Error(`API check failed: ${error.message}`);
    }
  }

  /**
   * Get sensors in a specific geographic area (MOCK)
   * @param {Object} bounds - Geographic bounds { north, south, east, west }
   * @param {number} limit - Maximum number of sensors to return
   * @returns {Promise<Array>} - Array of sensors in the area
   */
  async getSensorsInArea(bounds, limit = 100) {
    if (!this.initialized) {
      throw new Error('Adapter not initialized');
    }

    try {
      // Generate mock sensor data
      const mockSensors = [
        {
          id: 12345,
          sensor: {
            id: '12345',
            sensor_type: 'SDS011',
            firmware_version: 'NRZ-2020-133',
          },
          location: {
            latitude: '40.7128',
            longitude: '-74.0060',
            altitude: '10',
            indoor: false,
          },
          sensordatavalues: [
            { value_type: 'P1', value: '28.3' },
            { value_type: 'P2', value: '12.5' },
            { value_type: 'temperature', value: '22.4' },
            { value_type: 'humidity', value: '65.7' },
          ],
          timestamp: new Date().toISOString(),
        },
        {
          id: 67890,
          sensor: {
            id: '67890',
            sensor_type: 'DHT22+SDS011',
            firmware_version: 'NRZ-2021-056',
          },
          location: {
            latitude: '34.0522',
            longitude: '-118.2437',
            altitude: '5',
            indoor: false,
          },
          sensordatavalues: [
            { value_type: 'P1', value: '17.1' },
            { value_type: 'P2', value: '8.2' },
            { value_type: 'temperature', value: '24.8' },
            { value_type: 'humidity', value: '58.3' },
            { value_type: 'pressure', value: '1013.2' },
          ],
          timestamp: new Date().toISOString(),
        },
        {
          id: 24680,
          sensor: {
            id: '24680',
            sensor_type: 'SDS011',
            firmware_version: 'NRZ-2021-100',
          },
          location: {
            latitude: '41.8781',
            longitude: '-87.6298',
            altitude: '15',
            indoor: false,
          },
          sensordatavalues: [
            { value_type: 'P1', value: '45.9' },
            { value_type: 'P2', value: '23.7' },
          ],
          timestamp: new Date().toISOString(),
        },
      ];

      // Apply simple filtering based on bounds (in a real implementation this would be done by the API)
      const filteredSensors = mockSensors
        .filter(sensor => {
          const lat = parseFloat(sensor.location.latitude);
          const lng = parseFloat(sensor.location.longitude);

          return (
            lat >= bounds.south &&
            lat <= bounds.north &&
            lng >= bounds.west &&
            lng <= bounds.east
          );
        })
        .slice(0, limit);

      logger.debug(
        `Found ${filteredSensors.length} mock sensors in specified area`
      );
      return filteredSensors;
    } catch (error) {
      logger.error('Failed to get sensors in area', {
        error: error.message,
        bounds,
      });
      throw error;
    }
  }

  /**
   * Get the latest data from a specific sensor (MOCK)
   * @param {string} sensorId - The Sensor.Community sensor ID
   * @returns {Promise<Object>} - Latest sensor data
   */
  async getSensorData(sensorId) {
    if (!this.initialized) {
      throw new Error('Adapter not initialized');
    }

    try {
      // Generate mock data for the requested sensor
      const mockSensorData = {
        id: parseInt(sensorId),
        sensor: {
          id: sensorId.toString(),
          sensor_type: 'SDS011',
          firmware_version: 'NRZ-2020-133',
        },
        location: {
          latitude: '40.7128',
          longitude: '-74.0060',
          altitude: '10',
          indoor: false,
        },
        sensordatavalues: [
          { value_type: 'P1', value: String(Math.random() * 50) },
          { value_type: 'P2', value: String(Math.random() * 25) },
          { value_type: 'temperature', value: String(20 + Math.random() * 10) },
          { value_type: 'humidity', value: String(50 + Math.random() * 30) },
          { value_type: 'pressure', value: String(1000 + Math.random() * 30) },
        ],
        timestamp: new Date().toISOString(),
      };

      logger.debug(`Retrieved mock data for sensor ${sensorId}`, {
        timestamp: mockSensorData.timestamp,
      });
      return mockSensorData;
    } catch (error) {
      logger.error(`Failed to get data for sensor ${sensorId}`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get historical data for a sensor (MOCK)
   * @param {string} sensorId - The Sensor.Community sensor ID
   * @param {string} startDate - Start date in ISO format
   * @param {string} endDate - End date in ISO format
   * @returns {Promise<Array>} - Array of historical data points
   */
  async getSensorHistory(sensorId, startDate, endDate) {
    if (!this.initialized) {
      throw new Error('Adapter not initialized');
    }

    try {
      // Parse the date range
      const start = new Date(startDate);
      const end = new Date(endDate);

      // Calculate how many days are in the range
      const dayDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

      // Generate mock data for each day in the range (limited to 10 days max for performance)
      const days = Math.min(dayDiff, 10);
      const mockHistoricalData = [];

      for (let i = 0; i < days; i++) {
        const currentDate = new Date(start);
        currentDate.setDate(start.getDate() + i);

        // Generate multiple readings per day (1-3 random readings)
        const readingsPerDay = Math.floor(Math.random() * 3) + 1;

        for (let j = 0; j < readingsPerDay; j++) {
          // Randomize the time of day
          const hours = Math.floor(Math.random() * 24);
          const minutes = Math.floor(Math.random() * 60);
          currentDate.setHours(hours, minutes, 0, 0);

          mockHistoricalData.push({
            id: parseInt(sensorId),
            sensor: {
              id: sensorId.toString(),
              sensor_type: 'SDS011',
              firmware_version: 'NRZ-2020-133',
            },
            location: {
              latitude: '40.7128',
              longitude: '-74.0060',
              altitude: '10',
              indoor: false,
            },
            sensordatavalues: [
              { value_type: 'P1', value: String(Math.random() * 50) },
              { value_type: 'P2', value: String(Math.random() * 25) },
              {
                value_type: 'temperature',
                value: String(20 + Math.random() * 10),
              },
              {
                value_type: 'humidity',
                value: String(50 + Math.random() * 30),
              },
              {
                value_type: 'pressure',
                value: String(1000 + Math.random() * 30),
              },
            ],
            timestamp: currentDate.toISOString(),
          });
        }
      }

      // Sort by timestamp (newest first)
      mockHistoricalData.sort(
        (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
      );

      logger.debug(
        `Generated ${mockHistoricalData.length} mock historical data points for sensor ${sensorId}`
      );
      return mockHistoricalData;
    } catch (error) {
      logger.error(`Failed to get historical data for sensor ${sensorId}`, {
        error: error.message,
        dateRange: { startDate, endDate },
      });
      throw error;
    }
  }

  /**
   * Transform Sensor.Community data to Wrfcoin data format
   * @param {Object} sensorData - Raw sensor data from Sensor.Community
   * @returns {Object} - Transformed data in Wrfcoin format
   */
  transformSensorData(sensorData) {
    if (!sensorData || !sensorData.sensordatavalues) {
      throw new Error('Invalid sensor data format');
    }

    // Create a structured data object for Wrfcoin
    const transformedData = {
      id: `sc-${sensorData.sensor.id}-${Date.now()}`,
      timestamp: sensorData.timestamp || new Date().toISOString(),
      sourceId: `sensor-community-${sensorData.sensor.id}`,
      sensorType: 'air-quality',
      location: {
        latitude: parseFloat(sensorData.location.latitude),
        longitude: parseFloat(sensorData.location.longitude),
        altitude: parseFloat(sensorData.location.altitude) || 0,
      },
      measurements: {},
      metadata: {
        sensorId: sensorData.sensor.id,
        sensorModel: sensorData.sensor.sensor_type,
        firmware: sensorData.sensor.firmware_version || 'unknown',
        originSource: 'Sensor.Community',
        indoorOutdoor: sensorData.location.indoor ? 'indoor' : 'outdoor',
      },
    };

    // Extract the measured values
    for (const value of sensorData.sensordatavalues) {
      switch (value.value_type) {
        case 'P1': // PM10
          transformedData.measurements.pm10 = parseFloat(value.value);
          break;
        case 'P2': // PM2.5
          transformedData.measurements.pm25 = parseFloat(value.value);
          break;
        case 'temperature':
          transformedData.measurements.temperature = parseFloat(value.value);
          break;
        case 'humidity':
          transformedData.measurements.humidity = parseFloat(value.value);
          break;
        case 'pressure':
          transformedData.measurements.pressure = parseFloat(value.value);
          break;
        // Add more value types as needed
        default:
          // Store other measurements with their original names
          transformedData.measurements[value.value_type] = parseFloat(
            value.value
          );
      }
    }

    return transformedData;
  }

  /**
   * Register a new sensor with Wrfcoin
   * @param {Object} sensorData - Basic sensor data
   * @returns {Promise<Object>} - Registered sensor details
   */
  async registerSensor(sensorData) {
    try {
      const wrfcoinSensorId = `sc-${sensorData.sensor.id}`;

      // Create a registration entry for the Wrfcoin system
      const registrationData = {
        sensorId: wrfcoinSensorId,
        originalId: sensorData.sensor.id,
        name: `Sensor.Community ${sensorData.sensor.id}`,
        type: 'AIR_QUALITY',
        location: {
          latitude: parseFloat(sensorData.location.latitude),
          longitude: parseFloat(sensorData.location.longitude),
          altitude: parseFloat(sensorData.location.altitude) || 0,
        },
        dataTypes: this._detectSensorDataTypes(sensorData),
        metadata: {
          source: 'Sensor.Community',
          indoor: !!sensorData.location.indoor,
          model: sensorData.sensor.sensor_type,
          firmware: sensorData.sensor.firmware_version || 'unknown',
          registrationDate: new Date().toISOString(),
        },
      };

      logger.info(
        `Registered Sensor.Community sensor with Wrfcoin: ${wrfcoinSensorId}`
      );
      return registrationData;
    } catch (error) {
      logger.error('Failed to register sensor with Wrfcoin', {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Detect data types provided by the sensor
   * @private
   * @param {Object} sensorData - Raw sensor data
   * @returns {Array} - Array of data types provided by this sensor
   */
  _detectSensorDataTypes(sensorData) {
    const dataTypes = [];

    if (!sensorData.sensordatavalues) {
      return dataTypes;
    }

    for (const value of sensorData.sensordatavalues) {
      switch (value.value_type) {
        case 'P1':
          dataTypes.push('PM10');
          break;
        case 'P2':
          dataTypes.push('PM25');
          break;
        case 'temperature':
          dataTypes.push('TEMPERATURE');
          break;
        case 'humidity':
          dataTypes.push('HUMIDITY');
          break;
        case 'pressure':
          dataTypes.push('PRESSURE');
          break;
      }
    }

    return [...new Set(dataTypes)]; // Remove duplicates
  }
}

module.exports = SensorCommunityAdapter;
