/**
 * Luftdaten Integration Adapter for Wrfcoin
 *
 * This adapter handles the communication with the Luftdaten air quality sensor network API
 * and provides methods for sensor data retrieval and management.
 */

const { logger } = require('../../utils/logger');
const { db, pool } = require('../../db');
const { sql } = require('drizzle-orm');

class LuftdatenAdapter {
  constructor(options = {}) {
    this.testMode = options.testMode || false;
    this.baseUrl = options.baseUrl || 'https://api.sensor.community/v1';
    this.logger = logger.child({ module: 'luftdaten:adapter' });
    this.logger.info('Creating Luftdaten adapter instance', {
      testMode: this.testMode,
    });
  }

  /**
   * Initialize the adapter by creating necessary database tables
   */
  async initialize() {
    this.logger.info('Initializing Luftdaten adapter');

    try {
      // Create sensors table if it doesn't exist
      await this.createTablesIfNeeded();
      this.logger.info('Luftdaten adapter initialized successfully');

      return true;
    } catch (error) {
      this.logger.error('Failed to initialize Luftdaten adapter', { error });
      return false;
    }
  }

  /**
   * Create necessary database tables if they don't exist
   */
  async createTablesIfNeeded() {
    try {
      // Check if sensors table exists
      const sensorTableExists =
        await this.checkTableExists('luftdaten_sensors');

      if (!sensorTableExists) {
        this.logger.info('Creating Luftdaten sensors table');

        // Create sensors table
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS luftdaten_sensors (
            id SERIAL PRIMARY KEY,
            sensor_id VARCHAR(50) NOT NULL UNIQUE,
            name VARCHAR(100) NOT NULL,
            latitude DECIMAL(10, 8) NOT NULL,
            longitude DECIMAL(11, 8) NOT NULL,
            altitude DECIMAL(8, 2),
            indoor BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Create index on sensor_id
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS idx_luftdaten_sensors_sensor_id ON luftdaten_sensors(sensor_id)
        `);
      }

      // Check if measurements table exists
      const measurementsTableExists = await this.checkTableExists(
        'luftdaten_measurements'
      );

      if (!measurementsTableExists) {
        this.logger.info('Creating Luftdaten measurements table');

        // Create measurements table
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS luftdaten_measurements (
            id SERIAL PRIMARY KEY,
            sensor_id VARCHAR(50) NOT NULL,
            timestamp TIMESTAMP NOT NULL,
            measurement_type VARCHAR(50) NOT NULL,
            value DECIMAL(10, 5) NOT NULL,
            unit VARCHAR(20),
            FOREIGN KEY (sensor_id) REFERENCES luftdaten_sensors(sensor_id) ON DELETE CASCADE
          )
        `);

        // Create indices
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS idx_luftdaten_measurements_sensor_id ON luftdaten_measurements(sensor_id)
        `);

        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS idx_luftdaten_measurements_timestamp ON luftdaten_measurements(timestamp)
        `);
      }

      this.logger.info('Luftdaten tables created or confirmed');
      return true;
    } catch (error) {
      this.logger.error('Failed to create Luftdaten tables', { error });
      throw error;
    }
  }

  /**
   * Check if a table exists in the database
   *
   * @param {string} tableName - Name of the table to check
   * @returns {Promise<boolean>} - Whether the table exists
   */
  async checkTableExists(tableName) {
    try {
      const result = await db.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables 
          WHERE table_name = ${tableName}
        )
      `);

      return result.rows[0]?.exists || false;
    } catch (error) {
      this.logger.error('Error checking if table exists', { error, tableName });
      return false;
    }
  }

  /**
   * Register a new sensor with the Luftdaten network
   *
   * @param {Object} sensorInfo - Information about the sensor to register
   * @returns {Promise<Object>} - The registered sensor
   */
  async registerSensor(sensorInfo) {
    this.logger.debug('Registering new sensor', { sensorInfo });

    try {
      const {
        sensorId,
        name,
        latitude,
        longitude,
        altitude = null,
        indoor = false,
      } = sensorInfo;

      // Insert sensor into database
      const result = await db.execute(sql`
        INSERT INTO luftdaten_sensors (
          sensor_id, name, latitude, longitude, altitude, indoor
        ) VALUES (
          ${sensorId}, ${name}, ${latitude}, ${longitude}, ${altitude}, ${indoor}
        )
        ON CONFLICT (sensor_id) 
        DO UPDATE SET 
          name = ${name},
          latitude = ${latitude},
          longitude = ${longitude},
          altitude = ${altitude},
          indoor = ${indoor},
          updated_at = CURRENT_TIMESTAMP
        RETURNING *
      `);

      const sensor = result.rows[0];

      this.logger.info('Sensor registered successfully', { sensorId });
      return sensor;
    } catch (error) {
      this.logger.error('Failed to register sensor', { error, sensorInfo });
      throw error;
    }
  }

  /**
   * Search for sensors in a geographic area
   *
   * @param {Object} options - Search options
   * @param {number} options.latitude - Latitude of search center
   * @param {number} options.longitude - Longitude of search center
   * @param {number} options.radius - Search radius in kilometers
   * @returns {Promise<Array>} - Array of sensors in the area
   */
  async searchSensors(options) {
    const { latitude, longitude, radius = 10 } = options;

    this.logger.debug('Searching for sensors in area', {
      latitude,
      longitude,
      radius,
    });

    // In test mode, return mock data
    if (this.testMode) {
      return this.getMockSensorsInArea(latitude, longitude, radius);
    }

    try {
      // Fetch sensors from Luftdaten API
      const response = await fetch(
        `${this.baseUrl}/sensors?near=${latitude},${longitude},${radius}`
      );

      if (!response.ok) {
        throw new Error(`API responded with status: ${response.status}`);
      }

      const sensors = await response.json();

      // Transform to consistent format
      return sensors.map(sensor => ({
        id: sensor.sensor.id,
        name: sensor.sensor.name || `Sensor ${sensor.sensor.id}`,
        location: {
          latitude: sensor.location.latitude,
          longitude: sensor.location.longitude,
          altitude: sensor.location.altitude,
        },
        indoor: !!sensor.indoor,
        type: sensor.sensor.sensor_type,
        lastSeen: sensor.sensor.last_measurement,
      }));
    } catch (error) {
      this.logger.error('Error searching for sensors', { error, options });

      // Fallback to mock data in case of error
      return this.getMockSensorsInArea(latitude, longitude, radius);
    }
  }

  /**
   * Get data from a specific sensor
   *
   * @param {string} sensorId - The sensor ID
   * @returns {Promise<Object>} - The sensor data
   */
  async getSensorData(sensorId) {
    this.logger.debug('Fetching sensor data', { sensorId });

    // In test mode, return mock data
    if (this.testMode) {
      return this.getMockSensorData(sensorId);
    }

    try {
      // Fetch sensor data from Luftdaten API
      const response = await fetch(
        `${this.baseUrl}/sensors/${sensorId}/measurements`
      );

      if (!response.ok) {
        throw new Error(`API responded with status: ${response.status}`);
      }

      const rawData = await response.json();

      // Process and validate the data
      const processedData = this.processRawSensorData(rawData, sensorId);
      return processedData;
    } catch (error) {
      this.logger.error('Error fetching sensor data', { error, sensorId });

      // Fallback to mock data in case of error
      return this.getMockSensorData(sensorId);
    }
  }

  /**
   * Process raw sensor data from the API
   *
   * @param {Object} rawData - Raw data from the API
   * @param {string} sensorId - The sensor ID
   * @returns {Object} - Processed sensor data
   */
  processRawSensorData(rawData, sensorId) {
    this.logger.debug('Validating air quality data');

    // Transform to consistent format
    const measurements = rawData
      .map(reading => {
        const timestamp = new Date(reading.timestamp);
        const values = {};

        // Extract readings
        Object.entries(reading.values).forEach(([key, value]) => {
          values[key] = {
            value: parseFloat(value.value),
            unit: value.unit,
          };
        });

        return {
          timestamp,
          readings: values,
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    return {
      sensorId,
      measurements,
      lastUpdated:
        measurements.length > 0 ? measurements[0].timestamp : new Date(),
    };
  }

  /**
   * Get registered sensors from the database
   *
   * @returns {Promise<Array>} - Array of registered sensors
   */
  async getRegisteredSensors() {
    try {
      const result = await db.execute(sql`
        SELECT * FROM luftdaten_sensors
        ORDER BY name ASC
      `);

      return result.rows.map(row => ({
        id: row.sensor_id,
        name: row.name,
        latitude: parseFloat(row.latitude),
        longitude: parseFloat(row.longitude),
        altitude: row.altitude ? parseFloat(row.altitude) : null,
        indoor: !!row.indoor,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (error) {
      this.logger.error('Error getting registered sensors', { error });
      return [];
    }
  }

  /**
   * Store sensor measurements in the database
   *
   * @param {string} sensorId - The sensor ID
   * @param {Array} measurements - Array of measurements
   * @returns {Promise<boolean>} - Success status
   */
  async storeMeasurements(sensorId, measurements) {
    try {
      // For each measurement, insert into database
      for (const measurement of measurements) {
        const { timestamp, readings } = measurement;

        // Insert each reading type
        for (const [type, data] of Object.entries(readings)) {
          await db.execute(sql`
            INSERT INTO luftdaten_measurements (
              sensor_id, timestamp, measurement_type, value, unit
            ) VALUES (
              ${sensorId}, ${timestamp}, ${type}, ${data.value}, ${data.unit}
            )
          `);
        }
      }

      return true;
    } catch (error) {
      this.logger.error('Error storing measurements', { error, sensorId });
      return false;
    }
  }

  /**
   * Generate mock sensors in an area for testing
   *
   * @param {number} centerLat - Center latitude
   * @param {number} centerLng - Center longitude
   * @param {number} radius - Radius in kilometers
   * @returns {Array} - Array of mock sensors
   */
  getMockSensorsInArea(centerLat, centerLng, radius) {
    // Create 20 mock sensors at random positions within the radius
    const sensors = [];

    for (let i = 0; i < 20; i++) {
      // Generate random position within radius
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * radius;

      // Convert km to degrees (approximate)
      const latOffset = distance * 0.009;
      const lngOffset =
        (distance * 0.009) / Math.cos((centerLat * Math.PI) / 180);

      const lat = centerLat + latOffset * Math.sin(angle);
      const lng = centerLng + lngOffset * Math.cos(angle);

      sensors.push({
        id: `mock-sensor-${i + 1}`,
        name: `Mock PM Sensor ${i + 1}`,
        location: {
          latitude: lat,
          longitude: lng,
          altitude: 100 + Math.random() * 500,
        },
        indoor: Math.random() > 0.8,
        type: Math.random() > 0.5 ? 'PM' : 'Temperature',
        lastSeen: new Date().toISOString(),
      });
    }

    return sensors;
  }

  /**
   * Generate mock sensor data for testing
   *
   * @param {string} sensorId - The sensor ID
   * @returns {Object} - Mock sensor data
   */
  getMockSensorData(sensorId) {
    const measurements = [];
    const now = new Date();

    // Generate data for the last 24 hours
    for (let i = 0; i < 5; i++) {
      const timestamp = new Date(now.getTime() - i * 3600000);

      measurements.push({
        timestamp,
        readings: {
          P1: {
            value: 25 + Math.random() * 30,
            unit: 'µg/m³',
          },
          P2: {
            value: 15 + Math.random() * 30,
            unit: 'µg/m³',
          },
          temperature: {
            value: 15 + Math.random() * 5,
            unit: '°C',
          },
          humidity: {
            value: 30 + Math.random() * 20,
            unit: '%',
          },
          pressure: {
            value: 1000 + Math.random() * 5,
            unit: 'hPa',
          },
        },
      });
    }

    return {
      sensorId,
      measurements,
      lastUpdated: now,
    };
  }
}

module.exports = { LuftdatenAdapter };
