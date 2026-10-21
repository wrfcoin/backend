// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

/**
 * IoT/Sensor Networks Server
 * Port 3002 - Dedicated to sensor data collection and IoT device management
 * Real: in-memory reading intake (POST /api/iot/data) and readback.
 * Catalog only (not wired, backend#1173): The Things Network, Helium Network,
 * FOAM Protocol, IOTA, Sensor Community, Streamr, Open Geospatial Consortium,
 * OpenForis, OpenAQ, IoTeX.
 */

const express = require('express');
const cors = require('cors');
const ProductionCORSCleanup = require('../middleware/production-cors-cleanup').default;
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const crypto = require('crypto');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
const { integrationNotice } = require('./utils/honest-gap.js');

const { sendSidecarUnavailable } = require('./utils/sidecar-unavailable.js');

const IOT_SEE = 'wrfcoin/backend#1173';

const app = express();
const PORT = parseInt(process.env.IOT_PORT || '3002', 10);
const probeState = { draining: false };

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'iot-sensor-networks' },
  transports: [
    new winston.transports.File({
      filename: 'logs/iot-error.log',
      level: 'error',
    }),
    new winston.transports.File({ filename: 'logs/iot-combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Middleware
app.use(helmet());
// Enhanced security middleware with production CORS cleanup
ProductionCORSCleanup.autoConfigureCORS(app);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(
  createHealthMiddleware('iot-sensor-networks', {}, { state: probeState }).router
);

// Rate limiting for IoT data streams
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, // Higher limit for IoT data streams
  message: 'Too many sensor requests from this IP, please try again later.',
});
app.use(limiter);

// IoT/Sensor Networks — design catalog of the third-party networks this
// service is meant to front. `status: 'not_wired'` on every entry is deliberate
// (backend#1173, same treatment as #1118): no client for any of them exists in
// this repo. The invented network sizes (gateways, hotspots, devices, ...) were
// removed rather than presented as live figures.
const iotNetworks = {
  ttn: {
    name: 'The Things Network',
    type: 'lorawan_iot',
    status: 'not_wired',
    coverage: 'global',
    specialization: 'low_power_wide_area',
    data_types: ['temperature', 'humidity', 'air_quality', 'location'],
  },
  foam: {
    name: 'FOAM Protocol',
    type: 'location_verification',
    status: 'not_wired',
    coverage: 'urban_areas',
    specialization: 'proof_of_location',
    data_types: ['location', 'presence', 'movement', 'geofencing'],
  },
  helium: {
    name: 'Helium Network',
    type: 'wireless_iot',
    status: 'not_wired',
    coverage: 'global',
    specialization: 'people_network',
    data_types: ['location', 'environmental', 'asset_tracking', 'connectivity'],
  },
  sensor_community: {
    name: 'Sensor.Community',
    type: 'citizen_science',
    status: 'not_wired',
    coverage: 'europe_focus',
    specialization: 'air_quality_monitoring',
    data_types: ['pm2.5', 'pm10', 'temperature', 'humidity', 'noise'],
  },
  iota: {
    name: 'IOTA Tangle',
    type: 'iot_blockchain',
    status: 'not_wired',
    coverage: 'global',
    specialization: 'feeless_microtransactions',
    data_types: [
      'sensor_data',
      'micropayments',
      'device_identity',
      'supply_chain',
    ],
  },
  streamr: {
    name: 'Streamr Network',
    type: 'real_time_data',
    status: 'not_wired',
    coverage: 'global',
    specialization: 'real_time_data_streaming',
    data_types: [
      'real_time_data',
      'event_streams',
      'iot_telemetry',
      'analytics',
    ],
  },
  ogc: {
    name: 'Open Geospatial Consortium',
    type: 'geospatial_standards',
    status: 'not_wired',
    coverage: 'global_standards',
    specialization: 'spatial_data_interoperability',
    data_types: ['geospatial', 'mapping', 'gis', 'remote_sensing'],
  },
  openforis: {
    name: 'OpenForis',
    type: 'forest_monitoring',
    status: 'not_wired',
    coverage: 'global_forestry',
    specialization: 'forest_inventory_monitoring',
    data_types: ['forest_data', 'biomass', 'carbon_stocks', 'biodiversity'],
  },
  openaq: {
    name: 'OpenAQ',
    type: 'air_quality_platform',
    status: 'not_wired',
    coverage: 'global',
    specialization: 'open_air_quality_data',
    data_types: ['air_quality', 'pollutants', 'pm2.5', 'pm10', 'ozone', 'no2'],
  },
  iotex: {
    name: 'IoTeX W3bstream',
    type: 'trusted_iot_devices',
    status: 'not_wired',
    coverage: 'global',
    specialization: 'device_attestation_verification',
    data_types: ['weather', 'environmental', 'location', 'sensor_proofs'],
  },
};

// Active sensor readings tracking
const sensorReadings = new Map();

// Logging middleware
app.use((req, res, next) => {
  logger.info('IoT/Sensor API Request', {
    ip: req.ip,
    method: req.method,
    path: req.path,
  });
  next();
});

// No third-party IoT client is wired. Local readings remain under /api/iot/data.
app.get('/api/iot/networks', (_req, res) => sendSidecarUnavailable(res, {
  capability: 'iot.networks',
  message: 'No third-party IoT network client is wired.',
}));

app.get('/api/iot/networks/:network', (req, res) => {
  const networkInfo = iotNetworks[req.params.network.toLowerCase()];
  if (!networkInfo) {
    return res.status(404).json({ success: false, error: 'Network not found' });
  }
  return sendSidecarUnavailable(res, {
    capability: 'iot.network',
    message: `No ${networkInfo.name} client is wired; live network data is unavailable.`,
  });
});

// Submit sensor data
app.post('/api/iot/data', async (req, res) => {
  try {
    const { network, sensor_id, data_type, value, location, timestamp } =
      req.body;

    if (!network || !sensor_id || !data_type || value === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Network, sensor_id, data_type, and value are required',
      });
    }

    const selectedNetwork = iotNetworks[network.toLowerCase()];
    if (!selectedNetwork) {
      return res
        .status(404)
        .json({ success: false, error: 'Network not found' });
    }

    if (!selectedNetwork.data_types.includes(data_type)) {
      return res.status(400).json({
        success: false,
        error: `Data type ${data_type} not supported by ${selectedNetwork.name}`,
        supported_types: selectedNetwork.data_types,
      });
    }

    // quality_score is null: nothing here scores a reading, and the 80-100 %
    // random score it used to carry was invented (backend#1173).
    const reading = {
      id: `reading_${crypto.randomUUID()}`,
      network: selectedNetwork.name,
      sensor_id,
      data_type,
      value,
      location: location || { lat: null, lon: null },
      timestamp: timestamp || new Date().toISOString(),
      quality_score: null,
    };

    // Store reading
    if (!sensorReadings.has(network)) {
      sensorReadings.set(network, []);
    }
    const networkReadings = sensorReadings.get(network);
    networkReadings.push(reading);

    // Keep only last 1000 readings per network
    if (networkReadings.length > 1000) {
      networkReadings.shift();
    }

    // Data lineage: record ingestion provenance (Issue #213)
    let lineageId = null;
    try {
      const contentHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ network, sensor_id, data_type, value, location: reading.location, timestamp: reading.timestamp }))
        .digest('hex');

      // Lazy-load lineage service (TS compiled module)
      const { lineageService } = require('./services/lineage-service.js');
      const lineageRecord = await lineageService.createLineageRecord({
        stageId: 'iot_ingestion',
        stationId: sensor_id,
        contentHash,
        sourceType: 'iot_sensor',
        sourceReference: `${network}:${sensor_id}`,
        metadata: {
          quality_score: reading.quality_score,
          network: selectedNetwork.name,
          data_type,
        },
      });
      lineageId = lineageRecord.lineageId;
    } catch (lineageErr) {
      // Lineage recording should not block data ingestion
      logger.warn('Failed to record lineage for IoT data', {
        error: lineageErr instanceof Error ? lineageErr.message : String(lineageErr),
        sensor_id,
      });
    }

    res.json({
      success: true,
      reading_id: reading.id,
      network: selectedNetwork.name,
      data_accepted: true,
      quality_score: null,
      // No reward is paid for readings posted here; never claim one.
      reward_earned: null,
      lineage_id: lineageId,
    });
  } catch (error) {
    logger.error('Error submitting sensor data', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get sensor data
app.get('/api/iot/data/:network', (req, res) => {
  try {
    const { network } = req.params;
    const { limit = 100, data_type, sensor_id } = req.query;

    const networkReadings = sensorReadings.get(network) || [];
    let filteredReadings = networkReadings;

    if (data_type) {
      filteredReadings = filteredReadings.filter(
        r => r.data_type === data_type
      );
    }

    if (sensor_id) {
      filteredReadings = filteredReadings.filter(
        r => r.sensor_id === sensor_id
      );
    }

    // Get most recent readings
    const recentReadings = filteredReadings
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, parseInt(limit, 10));

    res.json({
      success: true,
      network,
      readings: recentReadings,
      total_readings: filteredReadings.length,
      // Readings are not quality-scored (backend#1173).
      avg_quality_score: null,
    });
  } catch (error) {
    logger.error('Error fetching sensor data', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Real-time data stream — honestly absent (backend#1173).
app.get('/api/iot/stream/:network', (req, res) => {
  try {
    const { network } = req.params;
    const networkInfo = iotNetworks[network.toLowerCase()];

    if (!networkInfo) {
      return res
        .status(404)
        .json({ success: false, error: 'Network not found' });
    }

    // No network client exists, so there is no live stream to report.
    return sendSidecarUnavailable(res, {
      capability: 'iot.stream',
      message: `No ${networkInfo.name} client is wired; there is no real-time stream to report.`,
    });
  } catch (error) {
    logger.error('Error fetching stream data', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// IoT metrics — only what this process actually holds. Third-party network
// sizes, uptime, latency and reward figures were invented and are gone
// (backend#1173); the field names the frontend's sensorAPI.getMetrics() maps
// are kept, as null, so it degrades instead of breaking.
app.get('/api/iot/metrics', (req, res) => {
  try {
    const totalReadings = Array.from(sensorReadings.values()).reduce(
      (sum, readings) => sum + readings.length,
      0
    );

    res.json({
      success: true,
      integration: integrationNotice('IoT/sensor networks', IOT_SEE),
      metrics: {
        total_networks: Object.keys(iotNetworks).length,
        active_networks: 0,
        total_devices: null,
        global_coverage: false,
        network_uptime: null,
        avg_latency: null,
        readings_held: totalReadings,
        readings_scope: 'in-memory, this process, last 1000 per network',
      },
    });
  } catch (error) {
    logger.error('Error fetching IoT metrics', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// 404 handler
app.all('*', (req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info('IoT/Sensor Networks Server started', { port: PORT, url: `http://0.0.0.0:${PORT}` });
});

registerGracefulShutdown({
  serviceName: 'iot-sensor-networks',
  server,
  logger,
  state: probeState,
});

module.exports = app;
module.exports.server = server;
