// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('../utils/otel-setup.js');
initializeOTel().catch(() => {});

/**
 * Weather Service HTTP Server
 *
 * Provides HTTP endpoints for the Weather Data Ingestion Orchestrator
 * and related weather services.
 */

const http = require('http');
const { logger } = require('../utils/logger');
const WeatherDataIngestionOrchestrator = require('./weather-data-ingestion-orchestrator');
const { applyRawCorsHeaders } = require('../../shared/middleware/cors-config.js');
const { applyApiSecurityHeaders } = require('../../shared/middleware/security-headers.js');
const {
  GracefulShutdown,
  ShutdownPriority,
} = require('../../shared/graceful-shutdown/index.js');

class WeatherServiceServer {
  constructor(port = 3000) {
    this.port = port;
    this.orchestrator = new WeatherDataIngestionOrchestrator();
    this.server = null;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.listen(this.port, () => {
      logger.info(`Weather Service Server started on port ${this.port}`);
    });

    // Set up graceful shutdown using centralized manager
    this.setupGracefulShutdown();
  }

  setupGracefulShutdown() {
    const shutdown = GracefulShutdown.getInstance({
      logger: (message, level) => {
        if (level === 'error') {
          logger.error(message);
        } else if (level === 'warn') {
          logger.warn(message);
        } else {
          logger.info(message);
        }
      },
    });

    // Register HTTP server cleanup handler
    shutdown.registerHandler({
      name: 'weather-service-http',
      priority: ShutdownPriority.DRAIN_HTTP_CONNECTIONS,
      timeout: 10000,
      handler: () => {
        return new Promise((resolve, reject) => {
          logger.info('Closing Weather Service HTTP server...');
          if (this.server) {
            this.server.close(err => {
              if (err) {
                logger.error('Error closing HTTP server:', err);
                reject(err);
              } else {
                logger.info('HTTP server closed');
                resolve();
              }
            });
          } else {
            resolve();
          }
        });
      },
    });

    // Register orchestrator cleanup handler
    shutdown.registerHandler({
      name: 'weather-service-orchestrator',
      priority: ShutdownPriority.STOP_BACKGROUND_JOBS,
      timeout: 15000,
      handler: async () => {
        logger.info('Shutting down Weather Data Ingestion Orchestrator...');
        await this.orchestrator.shutdown();
        logger.info('Orchestrator shutdown complete');
      },
    });

    shutdown.setupSignalHandlers();
  }

  async handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);

    // Apply secure CORS headers with origin validation
    const origin = req.headers.origin;
    applyRawCorsHeaders(res, origin);

    // Apply security headers (CSP, X-Frame-Options, etc.)
    applyApiSecurityHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      if (url.pathname === '/health') {
        await this.handleHealth(req, res);
      } else if (url.pathname === '/status') {
        await this.handleStatus(req, res);
      } else if (url.pathname === '/ingest' && req.method === 'POST') {
        await this.handleIngest(req, res);
      } else if (url.pathname === '/metrics') {
        await this.handleMetrics(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
      }
    } catch (error) {
      logger.error('Request handling error:', {
        error: error.message,
        path: url.pathname,
      });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  async handleHealth(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'healthy',
        service: 'weather-service',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      })
    );
  }

  async handleStatus(req, res) {
    const status = this.orchestrator.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }

  async handleMetrics(req, res) {
    const metrics = this.orchestrator.getDetailedStatistics();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics));
  }

  async handleIngest(req, res) {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const requestData = JSON.parse(body);
        const { source, data, options = {} } = requestData;

        if (!source || !data) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: 'Missing required fields: source, data' })
          );
          return;
        }

        const result = await this.orchestrator.ingestWeatherData(
          source,
          data,
          options
        );

        const statusCode = result.success ? 200 : 400;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        logger.error('Ingestion request error:', { error: error.message });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request data' }));
      }
    });
  }

  async shutdown() {
    logger.info('Weather Service Server shutting down...');
    // Delegate to GracefulShutdown manager which handles proper cleanup
    const shutdown = GracefulShutdown.getInstance();
    await shutdown.shutdown('manual');
  }
}

// Start the server if this file is run directly
if (require.main === module) {
  const port = process.env.PORT || 3000;
  const server = new WeatherServiceServer(port);

  server.start().catch(error => {
    logger.error('Failed to start Weather Service Server:', {
      error: error.message,
    });
    process.exit(1);
  });
}

module.exports = WeatherServiceServer;
