// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

const http = require('http');
const url = require('url');
const { applyRawCorsHeaders } = require('../shared/middleware/cors-config.js');
const { applyApiSecurityHeaders } = require('../shared/middleware/security-headers.js');
const { appLogger } = require('./utils/logger');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
const { writeProbeResponse } = require('./utils/raw-http-health');

const PORT = 3001;
const probeState = { draining: false };

const server = http.createServer((req, res) => {
  // Apply secure CORS headers with origin validation
  const origin = req.headers.origin;
  applyRawCorsHeaders(res, origin);

  // Apply security headers (CSP, X-Frame-Options, etc.)
  applyApiSecurityHeaders(res);

  if (writeProbeResponse(req, res, 'simple-http-server', probeState)) {
    return;
  }

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;

  // Set content type to JSON
  res.setHeader('Content-Type', 'application/json');

  // Handle different endpoints
  if (path === '/api/bridge/status') {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        status: 'connected',
        message: 'Bridge API is running',
        timestamp: new Date().toISOString(),
      })
    );
  } else if (path.startsWith('/api/')) {
    // Generic API response
    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        message: 'API endpoint',
        path: path,
        method: req.method,
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    res.writeHead(404);
    res.end(
      JSON.stringify({
        success: false,
        error: 'Not found',
      })
    );
  }
});

server.listen(PORT, '0.0.0.0', () => {
  appLogger.info('HTTP server running', { module: 'SimpleHTTPServer', operation: 'serverStart', port: PORT, url: `http://0.0.0.0:${PORT}` });
  appLogger.info('Bridge status endpoint available', { module: 'SimpleHTTPServer', operation: 'serverStart', url: `http://0.0.0.0:${PORT}/api/bridge/status` });
  appLogger.info('Health check endpoint available', { module: 'SimpleHTTPServer', operation: 'serverStart', url: `http://0.0.0.0:${PORT}/health` });
});

registerGracefulShutdown({
  serviceName: 'simple-http-server',
  server,
  logger: appLogger,
  state: probeState,
});
