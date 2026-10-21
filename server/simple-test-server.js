// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

const express = require('express');
const cors = require('cors');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');

const app = express();
const PORT = 3001;
const probeState = { draining: false };

// Test-only server — unrestricted CORS is acceptable
app.use(cors());

// JSON parsing middleware
app.use(express.json());
app.use(
  createHealthMiddleware('simple-test-server', {}, { state: probeState }).router
);

// Basic test routes
app.get('/api/bridge/status', (req, res) => {
  res.json({
    success: true,
    status: 'connected',
    message: 'Bridge API is running',
  });
});

// Catch-all for API endpoints
app.use('/api/*', (req, res) => {
  res.json({
    success: true,
    message: 'Test API endpoint',
    path: req.path,
    method: req.method,
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Test server running on http://0.0.0.0:${PORT}`);
  console.log(
    `✅ Bridge status endpoint: http://0.0.0.0:${PORT}/api/bridge/status`
  );
});

registerGracefulShutdown({
  serviceName: 'simple-test-server',
  server,
  logger: console,
  state: probeState,
});
