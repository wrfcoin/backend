/**
 * Luftdaten Integration Module for Wrfcoin
 *
 * This module integrates the Luftdaten air quality sensor network with the Wrfcoin blockchain.
 * It provides API routes for sensor management, data submission, and visualization.
 */

const { LuftdatenController } = require('./luftdaten-controller');
const { logger } = require('../../utils/logger');

let controller = null;
const moduleLogger = logger.child({ module: 'luftdaten' });

/**
 * Initialize the Luftdaten module
 *
 * @param {Object} app - Express application instance
 * @param {Object} options - Configuration options
 * @returns {Promise<boolean>} - Initialization status
 */
async function initialize(app, options = {}) {
  try {
    moduleLogger.info('Initializing Luftdaten integration module');

    // Create the controller
    controller = new LuftdatenController(options);

    // Initialize the controller
    const initialized = await controller.initialize();

    if (!initialized) {
      moduleLogger.error('Failed to initialize Luftdaten controller');
      return false;
    }

    // Register routes
    registerRoutes(app);

    moduleLogger.info('Luftdaten integration module initialized successfully');
    return true;
  } catch (error) {
    moduleLogger.error('Error initializing Luftdaten integration module', {
      error,
    });
    return false;
  }
}

/**
 * Register Luftdaten API routes
 *
 * @param {Object} app - Express application instance
 */
function registerRoutes(app) {
  // Get status
  app.get('/api/luftdaten/status', getStatus);

  // Get registered sensors
  app.get('/api/luftdaten/sensors', getSensors);

  // Search for sensors
  app.get('/api/luftdaten/sensors/search', searchSensors);

  // Get sensor data
  app.get('/api/luftdaten/sensors/:sensorId/data', getSensorData);

  // Register a new sensor
  app.post('/api/luftdaten/sensors', registerSensor);

  moduleLogger.info('Registered Luftdaten API routes');
}

/**
 * Get Luftdaten integration status
 */
async function getStatus(req, res) {
  try {
    if (!controller) {
      return res.status(503).json({
        success: false,
        message: 'Luftdaten integration not initialized',
      });
    }

    const status = controller.getStatus();
    res.json({ success: true, status });
  } catch (error) {
    moduleLogger.error('Error getting Luftdaten status', { error });
    res.status(500).json({
      success: false,
      message: 'Failed to get Luftdaten integration status',
      error: error.message,
    });
  }
}

/**
 * Get all registered sensors
 */
async function getSensors(req, res) {
  try {
    if (!controller) {
      return res.status(503).json({
        success: false,
        message: 'Luftdaten integration not initialized',
      });
    }

    const sensors = controller.getRegisteredSensors();
    res.json({ success: true, sensors });
  } catch (error) {
    moduleLogger.error('Error getting registered sensors', { error });
    res.status(500).json({
      success: false,
      message: 'Failed to get registered sensors',
      error: error.message,
    });
  }
}

/**
 * Search for sensors in a geographic area
 */
async function searchSensors(req, res) {
  try {
    if (!controller) {
      return res.status(503).json({
        success: false,
        message: 'Luftdaten integration not initialized',
      });
    }

    const { latitude, longitude, radius } = req.query;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude are required',
      });
    }

    const searchOptions = {
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      radius: radius ? parseFloat(radius) : 10,
    };

    const sensors = await controller.searchSensors(searchOptions);
    res.json({ success: true, sensors });
  } catch (error) {
    moduleLogger.error('Error searching for sensors', { error });
    res.status(500).json({
      success: false,
      message: 'Failed to search for sensors',
      error: error.message,
    });
  }
}

/**
 * Get data from a specific sensor
 */
async function getSensorData(req, res) {
  try {
    if (!controller) {
      return res.status(503).json({
        success: false,
        message: 'Luftdaten integration not initialized',
      });
    }

    const { sensorId } = req.params;

    if (!sensorId) {
      return res.status(400).json({
        success: false,
        message: 'Sensor ID is required',
      });
    }

    const sensorData = await controller.getSensorData(sensorId);
    res.json({ success: true, data: sensorData });
  } catch (error) {
    moduleLogger.error('Error getting sensor data', { error });
    res.status(500).json({
      success: false,
      message: 'Failed to get sensor data',
      error: error.message,
    });
  }
}

/**
 * Register a new sensor
 */
async function registerSensor(req, res) {
  try {
    if (!controller) {
      return res.status(503).json({
        success: false,
        message: 'Luftdaten integration not initialized',
      });
    }

    const { sensorId, name, latitude, longitude, altitude, indoor } = req.body;

    if (!sensorId || !name || !latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Sensor ID, name, latitude and longitude are required',
      });
    }

    const sensorInfo = {
      sensorId,
      name,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      altitude: altitude ? parseFloat(altitude) : null,
      indoor: indoor === true || indoor === 'true',
    };

    const sensor = await controller.registerSensor(sensorInfo);
    res.status(201).json({ success: true, sensor });
  } catch (error) {
    moduleLogger.error('Error registering sensor', { error });
    res.status(500).json({
      success: false,
      message: 'Failed to register sensor',
      error: error.message,
    });
  }
}

/**
 * Shutdown the Luftdaten module
 */
function shutdown() {
  if (controller) {
    moduleLogger.info('Shutting down Luftdaten integration module');
    controller.shutdown();
    controller = null;
  }
}

module.exports = {
  initialize,
  shutdown,
};
