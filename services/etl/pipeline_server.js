/**
 * WRFCoin ETL Pipeline Server
 * Data extraction, transformation, and loading service for weather data.
 */

const express = require('express');
const cors = require('cors');
// backend#1236: production refuses an empty/loopback/wildcard CORS_ORIGIN.
// infra/docker/Dockerfile.etl ships this helper at the same relative path.
const { resolveAllowedOrigins } = require('../../server/utils/strict-cors-config');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: resolveAllowedOrigins({
    developmentDefaults: ['http://localhost:5000', 'http://localhost:3000'],
  }),
  credentials: true,
}));
app.use(express.json());

// Pipeline state
const pipelineState = {
  status: 'idle',
  lastRun: null,
  processedRecords: 0,
  errors: []
};

// Active pipelines
const activePipelines = new Map();

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'etl-pipeline',
    version: '1.0.0',
    uptime: process.uptime(),
    pipelines: {
      active: activePipelines.size,
      state: pipelineState.status
    }
  });
});

/**
 * Readiness probe
 */
app.get('/ready', (req, res) => {
  res.json({ ready: true });
});

/**
 * Liveness probe
 */
app.get('/live', (req, res) => {
  res.json({ alive: true });
});

/**
 * Get pipeline status
 */
app.get('/pipeline/status', (req, res) => {
  res.json({
    ...pipelineState,
    activePipelines: Array.from(activePipelines.keys())
  });
});

/**
 * Start a new ETL pipeline
 */
app.post('/pipeline/start', async (req, res) => {
  const { pipelineId, source, destination, transformations } = req.body;

  if (!pipelineId) {
    return res.status(400).json({ error: 'pipelineId is required' });
  }

  if (activePipelines.has(pipelineId)) {
    return res.status(409).json({ error: 'Pipeline already running' });
  }

  // Create pipeline instance
  const pipeline = {
    id: pipelineId,
    source: source || 'weather-sensors',
    destination: destination || 'database',
    transformations: transformations || [],
    status: 'running',
    startedAt: new Date().toISOString(),
    processedRecords: 0
  };

  activePipelines.set(pipelineId, pipeline);
  pipelineState.status = 'running';
  pipelineState.lastRun = new Date().toISOString();

  console.log(`Pipeline ${pipelineId} started`);

  res.json({
    status: 'started',
    pipeline
  });
});

/**
 * Stop a running pipeline
 */
app.post('/pipeline/stop/:pipelineId', (req, res) => {
  const { pipelineId } = req.params;

  if (!activePipelines.has(pipelineId)) {
    return res.status(404).json({ error: 'Pipeline not found' });
  }

  const pipeline = activePipelines.get(pipelineId);
  pipeline.status = 'stopped';
  pipeline.stoppedAt = new Date().toISOString();

  activePipelines.delete(pipelineId);

  if (activePipelines.size === 0) {
    pipelineState.status = 'idle';
  }

  console.log(`Pipeline ${pipelineId} stopped`);

  res.json({
    status: 'stopped',
    pipeline
  });
});

/**
 * Get pipeline details
 */
app.get('/pipeline/:pipelineId', (req, res) => {
  const { pipelineId } = req.params;

  if (!activePipelines.has(pipelineId)) {
    return res.status(404).json({ error: 'Pipeline not found' });
  }

  res.json(activePipelines.get(pipelineId));
});

/**
 * List all pipelines
 */
app.get('/pipelines', (req, res) => {
  res.json({
    pipelines: Array.from(activePipelines.values())
  });
});

/**
 * Trigger data extraction
 */
app.post('/extract', async (req, res) => {
  // TODO(#225): Implement real extraction from configured weather data sources
  // (sensor APIs, NOAA feeds, station databases via weather_station_connector.js).
  // This endpoint must NOT return fabricated record counts.
  const err = new Error(
    'ETL /extract is not implemented: data source not configured. ' +
    'See issue #225 — connect to a real weather data source before using this endpoint.'
  );
  pipelineState.errors.push({
    timestamp: new Date().toISOString(),
    error: err.message
  });
  res.status(501).json({ error: err.message });
});

/**
 * Apply transformations
 */
app.post('/transform', async (req, res) => {
  // TODO(#225): Implement real transformations: unit conversion, coordinate projection,
  // physics range checks (per shared-protocol rules), and grid-cell assignment.
  // This endpoint must NOT echo back record counts without actual processing.
  const err = new Error(
    'ETL /transform is not implemented: no transformation logic configured. ' +
    'See issue #225 — apply real normalization and validation before using this endpoint.'
  );
  pipelineState.errors.push({
    timestamp: new Date().toISOString(),
    error: err.message
  });
  res.status(501).json({ error: err.message });
});

/**
 * Load data to destination
 */
app.post('/load', async (req, res) => {
  // TODO(#225): Implement real persistence via Drizzle ORM to PostgreSQL and/or
  // forward to the blockchain commit-reveal pipeline.
  // This endpoint must NOT return a success response without actually persisting data.
  const err = new Error(
    'ETL /load is not implemented: no persistence destination configured. ' +
    'See issue #225 — connect to the database layer before using this endpoint.'
  );
  pipelineState.errors.push({
    timestamp: new Date().toISOString(),
    error: err.message
  });
  res.status(501).json({ error: err.message });
});

/**
 * Get error log
 */
app.get('/errors', (req, res) => {
  res.json({
    errors: pipelineState.errors.slice(-100) // Last 100 errors
  });
});

/**
 * Clear error log
 */
app.delete('/errors', (req, res) => {
  pipelineState.errors = [];
  res.json({ status: 'cleared' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ETL Pipeline Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
