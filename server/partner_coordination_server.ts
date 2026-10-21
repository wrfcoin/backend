// OpenTelemetry must be initialized before other imports for auto-instrumentation
import { initializeOTel } from './utils/otel-setup.js';
void initializeOTel().catch(() => {});

/**
 * Partner Coordination & Integration Server
 * Port 3003 - Enterprise Partner API Integration for Layer 2 Testing
 *
 * Coordinates with enterprise partners to integrate their systems with the Layer 2
 * scaling solution. Handles API endpoints, data exchange protocols, and testing
 * interoperability for 100k+ TPS validation.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import winston from 'winston';
import { validationResult, body, param } from 'express-validator';
import WebSocket from 'ws';
import * as WebSocketNS from 'ws';
import { createServer } from 'http';
import crypto from 'crypto';
import strictCorsConfig from './utils/strict-cors-config.js';

const { resolveAllowedOrigins } = strictCorsConfig;
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
const {
  trustKnownProxy,
  getPartnerRateLimitKey,
} = require('./utils/trustedProxyConfig.js');

const app: express.Express = express();
const PORT = process.env.PARTNER_COORDINATION_PORT || 3003;
const probeState = { draining: false };

// Create HTTP server for WebSocket support
const server = createServer(app);

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'partner-coordination' },
  transports: [
    new winston.transports.File({
      filename: 'logs/partner-coordination-error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'logs/partner-coordination-combined.log',
    }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Middleware configuration
app.set('trust proxy', trustKnownProxy);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
      },
    },
  })
);

app.use(
  cors({
    origin: resolveAllowedOrigins({ developmentDefaults: [
      'http://localhost:5000',
      'http://localhost:3000',
    ] }),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Partner-ID',
      'X-API-Key',
    ],
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(
  createHealthMiddleware('partner-coordination', {}, { state: probeState }).router
);

// Partner-specific rate limiting
const partnerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // Higher limits for enterprise partners
  message: 'Partner API rate limit exceeded',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req): string => getPartnerRateLimitKey(req),
});

(app as any).use('/api/', partnerLimiter);

// Partner Registry and Configuration
interface PartnerConfig {
  partnerId: string;
  name: string;
  type: 'enterprise' | 'government' | 'research' | 'ngo';
  status: 'active' | 'pending' | 'suspended' | 'testing';
  apiKey: string;
  endpoints: {
    webhook: string;
    statusCallback: string;
    dataExchange: string;
  };
  capabilities: {
    maxTPS: number;
    dataTypes: string[];
    protocols: string[];
    regions: string[];
  };
  authentication: {
    method: 'api_key' | 'oauth2' | 'mutual_tls';
    credentials: any;
  };
  testingProfile: {
    participatesInLoadTesting: boolean;
    targetTPS: number;
    dataVolume: number; // GB per day
    testingWindows: string[]; // Time windows for testing
  };
  contractualSLA: {
    uptime: number; // percentage
    responseTime: number; // ms
    dataIntegrity: number; // percentage
    supportLevel: 'basic' | 'standard' | 'premium';
  };
  integrationMetrics: {
    totalTransactions: number;
    avgResponseTime: number;
    errorRate: number;
    lastActivity: Date;
  };
}

// Mock partner registry (in production, this would be in database)
const PARTNER_REGISTRY: Map<string, PartnerConfig> = new Map([
  [
    'CLIMATE_CORP_001',
    {
      partnerId: 'CLIMATE_CORP_001',
      name: 'ClimateData Corp',
      type: 'enterprise',
      status: 'active',
      apiKey: 'cc001_' + crypto.randomBytes(32).toString('hex'),
      endpoints: {
        webhook: 'https://api.climatedata.corp/webhook',
        statusCallback: 'https://api.climatedata.corp/status',
        dataExchange: 'https://api.climatedata.corp/exchange',
      },
      capabilities: {
        maxTPS: 25000,
        dataTypes: ['weather_stations', 'satellite_imagery', 'climate_models'],
        protocols: ['REST', 'GraphQL', 'WebSocket'],
        regions: ['NA', 'EU', 'APAC'],
      },
      authentication: {
        method: 'api_key',
        credentials: { scope: 'climate_data_read_write' },
      },
      testingProfile: {
        participatesInLoadTesting: true,
        targetTPS: 20000,
        dataVolume: 50, // 50GB per day
        testingWindows: ['00:00-06:00 UTC', '18:00-23:59 UTC'],
      },
      contractualSLA: {
        uptime: 99.9,
        responseTime: 100,
        dataIntegrity: 99.99,
        supportLevel: 'premium',
      },
      integrationMetrics: {
        totalTransactions: 0,
        avgResponseTime: 0,
        errorRate: 0,
        lastActivity: new Date(),
      },
    },
  ],
  [
    'ENV_RESEARCH_002',
    {
      partnerId: 'ENV_RESEARCH_002',
      name: 'Environmental Research Institute',
      type: 'research',
      status: 'testing',
      apiKey: 'eri002_' + crypto.randomBytes(32).toString('hex'),
      endpoints: {
        webhook: 'https://research.env.edu/webhook',
        statusCallback: 'https://research.env.edu/status',
        dataExchange: 'https://research.env.edu/exchange',
      },
      capabilities: {
        maxTPS: 10000,
        dataTypes: ['sensor_networks', 'environmental_models', 'research_data'],
        protocols: ['REST', 'MQTT', 'WebSocket'],
        regions: ['NA', 'EU'],
      },
      authentication: {
        method: 'oauth2',
        credentials: {
          clientId: 'env_research_client',
          scopes: ['data_read', 'model_execute'],
        },
      },
      testingProfile: {
        participatesInLoadTesting: true,
        targetTPS: 8000,
        dataVolume: 20,
        testingWindows: ['08:00-17:00 UTC'],
      },
      contractualSLA: {
        uptime: 99.5,
        responseTime: 200,
        dataIntegrity: 99.9,
        supportLevel: 'standard',
      },
      integrationMetrics: {
        totalTransactions: 0,
        avgResponseTime: 0,
        errorRate: 0,
        lastActivity: new Date(),
      },
    },
  ],
  [
    'GOVT_WEATHER_003',
    {
      partnerId: 'GOVT_WEATHER_003',
      name: 'National Weather Service',
      type: 'government',
      status: 'active',
      apiKey: 'nws003_' + crypto.randomBytes(32).toString('hex'),
      endpoints: {
        webhook: 'https://api.weather.gov/wrfcoin/webhook',
        statusCallback: 'https://api.weather.gov/wrfcoin/status',
        dataExchange: 'https://api.weather.gov/wrfcoin/exchange',
      },
      capabilities: {
        maxTPS: 15000,
        dataTypes: ['official_forecasts', 'radar_data', 'warning_systems'],
        protocols: ['REST', 'SOAP', 'WebSocket'],
        regions: ['NA'],
      },
      authentication: {
        method: 'mutual_tls',
        credentials: {
          certPath: '/secure/certs/nws.crt',
          keyPath: '/secure/keys/nws.key',
        },
      },
      testingProfile: {
        participatesInLoadTesting: true,
        targetTPS: 12000,
        dataVolume: 30,
        testingWindows: ['06:00-18:00 UTC'],
      },
      contractualSLA: {
        uptime: 99.95,
        responseTime: 50,
        dataIntegrity: 99.999,
        supportLevel: 'premium',
      },
      integrationMetrics: {
        totalTransactions: 0,
        avgResponseTime: 0,
        errorRate: 0,
        lastActivity: new Date(),
      },
    },
  ],
]);

// WebSocket server for real-time coordination
const wss = new WebSocketNS.WebSocketServer({ server, maxPayload: 64 * 1024 });
const partnerConnections: Map<string, WebSocket> = new Map();

wss.on('connection', (ws, req) => {
  logger.info('Partner WebSocket connection established');

  ws.on('message', data => {
    try {
      const message = JSON.parse(data.toString());
      handlePartnerWebSocketMessage(ws, message);
    } catch (error) {
      logger.error('Invalid WebSocket message:', error);
      ws.send(JSON.stringify({ error: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    // Remove from active connections
    for (const [partnerId, connection] of partnerConnections.entries()) {
      if (connection === ws) {
        partnerConnections.delete(partnerId);
        logger.info(`Partner ${partnerId} disconnected`);
        break;
      }
    }
  });
});

// Partner authentication middleware
const authenticatePartner = (req: any, res: any, next: any) => {
  const partnerId = req.headers['x-partner-id'];
  const apiKey = req.headers['x-api-key'];

  if (!partnerId || !apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Partner ID and API Key required',
      timestamp: new Date().toISOString(),
    });
  }

  const partner = PARTNER_REGISTRY.get(partnerId);
  if (!partner || partner.apiKey !== apiKey) {
    logger.warn(`Authentication failed for partner: ${partnerId}`);
    return res.status(401).json({
      success: false,
      error: 'Invalid partner credentials',
      timestamp: new Date().toISOString(),
    });
  }

  if (partner.status !== 'active' && partner.status !== 'testing') {
    return res.status(403).json({
      success: false,
      error: 'Partner account not active',
      timestamp: new Date().toISOString(),
    });
  }

  req.partner = partner;
  next();
};

// Validation middleware
const validatePartnerRegistration = [
  body('name').isString().notEmpty().isLength({ min: 3, max: 100 }),
  body('type').isIn(['enterprise', 'government', 'research', 'ngo']),
  body('endpoints.webhook').isURL(),
  body('endpoints.statusCallback').isURL(),
  body('endpoints.dataExchange').isURL(),
  body('capabilities.maxTPS').isInt({ min: 100, max: 100000 }),
  body('capabilities.dataTypes').isArray({ min: 1 }),
  body('testingProfile.targetTPS').isInt({ min: 100, max: 50000 }),
  body('testingProfile.dataVolume').isInt({ min: 1, max: 1000 }),
];

// API Response helpers
const successResponse = (data: any) => ({
  success: true,
  data,
  timestamp: new Date().toISOString(),
});

const errorResponse = (error: string) => ({
  success: false,
  error,
  timestamp: new Date().toISOString(),
});

// Partner Registration and Management APIs

/**
 * Register a new enterprise partner
 */
app.post(
  '/api/partners/register',
  validatePartnerRegistration,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(
        errorResponse(
          'Validation failed: ' +
            errors
              .array()
              .map(e => e.msg)
              .join(', ')
        )
      );
    }

    try {
      const { name, type, endpoints, capabilities, testingProfile } = req.body;

      const partnerId = `${type.toUpperCase()}_${String(PARTNER_REGISTRY.size + 1).padStart(3, '0')}`;
      const apiKey = `${partnerId.toLowerCase()}_${crypto.randomBytes(32).toString('hex')}`;

      const newPartner: PartnerConfig = {
        partnerId,
        name,
        type,
        status: 'pending',
        apiKey,
        endpoints,
        capabilities,
        authentication: {
          method: 'api_key',
          credentials: {},
        },
        testingProfile: {
          ...testingProfile,
          participatesInLoadTesting: true,
          testingWindows: testingProfile.testingWindows || ['00:00-23:59 UTC'],
        },
        contractualSLA: {
          uptime: 99.0,
          responseTime: 500,
          dataIntegrity: 99.0,
          supportLevel: 'basic',
        },
        integrationMetrics: {
          totalTransactions: 0,
          avgResponseTime: 0,
          errorRate: 0,
          lastActivity: new Date(),
        },
      };

      PARTNER_REGISTRY.set(partnerId, newPartner);

      logger.info(`New partner registered: ${partnerId} - ${name}`);

      // Initiate partner verification process
      await initiatePartnerVerification(newPartner);

      res.status(201).json(
        successResponse({
          partnerId,
          apiKey,
          status: 'pending',
          message: 'Partner registration initiated. Verification in progress.',
          nextSteps: [
            'Complete endpoint verification',
            'Undergo integration testing',
            'Sign enterprise agreement',
            'Activate production access',
          ],
        })
      );
    } catch (error) {
      logger.error('Partner registration failed:', error);
      res.status(500).json(errorResponse('Registration failed'));
    }
  }
);

/**
 * Get partner information
 */
app.get('/api/partners/:partnerId', authenticatePartner, (req, res) => {
  const partner = (req as any).partner;

  // Return partner info without sensitive data
  const partnerInfo = {
    partnerId: partner.partnerId,
    name: partner.name,
    type: partner.type,
    status: partner.status,
    capabilities: partner.capabilities,
    testingProfile: partner.testingProfile,
    contractualSLA: partner.contractualSLA,
    integrationMetrics: partner.integrationMetrics,
  };

  res.json(successResponse(partnerInfo));
});

/**
 * Update partner configuration
 */
app.put(
  '/api/partners/:partnerId/config',
  authenticatePartner,
  [
    body('endpoints').optional().isObject(),
    body('capabilities').optional().isObject(),
    body('testingProfile').optional().isObject(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(errorResponse('Validation failed'));
    }

    try {
      const partner = req.partner;
      const { endpoints, capabilities, testingProfile } = req.body;

      // Update partner configuration
      if (endpoints) {
        partner.endpoints = { ...partner.endpoints, ...endpoints };
      }
      if (capabilities) {
        partner.capabilities = { ...partner.capabilities, ...capabilities };
      }
      if (testingProfile) {
        partner.testingProfile = {
          ...partner.testingProfile,
          ...testingProfile,
        };
      }

      PARTNER_REGISTRY.set(partner.partnerId, partner);

      logger.info(`Partner configuration updated: ${partner.partnerId}`);

      res.json(
        successResponse({
          partnerId: partner.partnerId,
          message: 'Configuration updated successfully',
          updatedAt: new Date().toISOString(),
        })
      );
    } catch (error) {
      logger.error('Partner config update failed:', error);
      res.status(500).json(errorResponse('Configuration update failed'));
    }
  }
);

// Data Exchange APIs

/**
 * Initiate data exchange session
 */
app.post(
  '/api/partners/:partnerId/exchange/initiate',
  authenticatePartner,
  [
    body('dataType').isString().notEmpty(),
    body('volume').isInt({ min: 1 }),
    body('format').isIn(['json', 'csv', 'binary', 'stream']),
    body('compression').optional().isIn(['gzip', 'lz4', 'zstd']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(errorResponse('Validation failed'));
    }

    try {
      const partner = req.partner;
      const { dataType, volume, format, compression } = req.body;

      // Validate partner can handle this data type
      if (!partner.capabilities.dataTypes.includes(dataType)) {
        return res
          .status(400)
          .json(
            errorResponse(`Partner does not support data type: ${dataType}`)
          );
      }

      const exchangeSession = {
        sessionId: crypto.randomUUID(),
        partnerId: partner.partnerId,
        dataType,
        volume,
        format,
        compression: compression || 'gzip',
        status: 'initiated',
        createdAt: new Date().toISOString(),
        estimatedDuration: calculateExchangeDuration(
          volume,
          partner.capabilities.maxTPS
        ),
        protocols: {
          layer2Endpoint: `ws://${process.env.L2_WS_HOST || 'localhost'}:${process.env.L2_WS_PORT || '8080'}/partner-exchange/${partner.partnerId}`,
          restEndpoint: `/api/partners/${partner.partnerId}/exchange/${crypto.randomUUID()}`,
          webhookCallback: partner.endpoints.statusCallback,
        },
      };

      // Notify partner via WebSocket if connected
      const wsConnection = partnerConnections.get(partner.partnerId);
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.send(
          JSON.stringify({
            type: 'exchange_initiated',
            session: exchangeSession,
          })
        );
      }

      logger.info(
        `Data exchange session initiated: ${exchangeSession.sessionId} for partner ${partner.partnerId}`
      );

      res.json(successResponse(exchangeSession));
    } catch (error) {
      logger.error('Data exchange initiation failed:', error);
      res.status(500).json(errorResponse('Exchange initiation failed'));
    }
  }
);

/**
 * Partner performance testing integration
 */
app.post(
  '/api/partners/:partnerId/testing/performance',
  authenticatePartner,
  [
    body('testType').isIn(['load', 'stress', 'endurance', 'spike']),
    body('duration').isInt({ min: 60, max: 3600 }),
    body('targetTPS').isInt({ min: 100 }),
    body('dataPattern').isString().notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(errorResponse('Validation failed'));
    }

    try {
      const partner = req.partner;
      const { testType, duration, targetTPS, dataPattern } = req.body;

      // Validate partner can participate in testing
      if (!partner.testingProfile.participatesInLoadTesting) {
        return res
          .status(403)
          .json(errorResponse('Partner not enrolled in performance testing'));
      }

      if (targetTPS > partner.testingProfile.targetTPS) {
        return res
          .status(400)
          .json(
            errorResponse(
              `Target TPS exceeds partner limit: ${partner.testingProfile.targetTPS}`
            )
          );
      }

      const performanceTest = {
        testId: crypto.randomUUID(),
        partnerId: partner.partnerId,
        testType,
        duration,
        targetTPS,
        dataPattern,
        status: 'scheduled',
        scheduledAt: new Date().toISOString(),
        estimatedCompletion: new Date(
          Date.now() + duration * 1000
        ).toISOString(),
        layer2Config: {
          rollupBatchSize: Math.min(10000, targetTPS * 0.1),
          compressionEnabled: true,
          stateOptimization: true,
          finalityTime: '800ms',
        },
        metrics: {
          expectedTPS: targetTPS,
          expectedLatency: partner.contractualSLA.responseTime,
          expectedUptime: partner.contractualSLA.uptime / 100,
        },
      };

      // Schedule the performance test
      await schedulePerformanceTest(performanceTest);

      logger.info(
        `Performance test scheduled: ${performanceTest.testId} for partner ${partner.partnerId}`
      );

      res.json(successResponse(performanceTest));
    } catch (error) {
      logger.error('Performance test scheduling failed:', error);
      res.status(500).json(errorResponse('Performance test scheduling failed'));
    }
  }
);

/**
 * Get partner integration metrics and performance
 */
app.get('/api/partners/:partnerId/metrics', authenticatePartner, (req, res) => {
  const partner = (req as any).partner;
  const timeRange = (req.query.timeRange as string) || '24h';

  const metrics = {
    partnerId: partner.partnerId,
    timeRange,
    performance: {
      averageResponseTime: partner.integrationMetrics.avgResponseTime,
      totalTransactions: partner.integrationMetrics.totalTransactions,
      errorRate: partner.integrationMetrics.errorRate,
      currentTPS: calculateCurrentTPS(partner.partnerId),
      uptimePercentage: calculateUptimePercentage(partner.partnerId, timeRange),
    },
    layer2Metrics: {
      l2TransactionCount: 0, // Would be fetched from Layer 2 system
      gasReduction: 0.99, // 99% gas reduction achieved
      finalityTime: '780ms',
      batchEfficiency: 0.94,
    },
    slaCompliance: {
      uptimeCompliance: partner.contractualSLA.uptime,
      responseTimeCompliance: partner.contractualSLA.responseTime,
      dataIntegrityCompliance: partner.contractualSLA.dataIntegrity,
      overallScore: calculateSLAScore(partner),
    },
    recommendations: generatePartnerRecommendations(partner),
  };

  res.json(successResponse(metrics));
});

// WebSocket message handling
function handlePartnerWebSocketMessage(ws: WebSocket, message: any) {
  switch (message.type) {
    case 'partner_connect':
      const { partnerId, apiKey } = message;
      const partner = PARTNER_REGISTRY.get(partnerId);

      if (partner && partner.apiKey === apiKey) {
        partnerConnections.set(partnerId, ws);
        ws.send(
          JSON.stringify({
            type: 'connection_confirmed',
            partnerId,
            timestamp: new Date().toISOString(),
          })
        );
        logger.info(`Partner ${partnerId} connected via WebSocket`);
      } else {
        ws.send(
          JSON.stringify({
            type: 'connection_rejected',
            error: 'Invalid credentials',
          })
        );
        ws.close();
      }
      break;

    case 'status_update':
      logger.info(`Status update from partner: ${JSON.stringify(message)}`);
      break;

    case 'performance_data':
      handlePerformanceData(message);
      break;

    default:
      logger.warn(`Unknown WebSocket message type: ${message.type}`);
  }
}

// Helper functions
async function initiatePartnerVerification(
  partner: PartnerConfig
): Promise<void> {
  // In production, this would:
  // 1. Verify endpoint accessibility
  // 2. Test authentication methods
  // 3. Validate data exchange capabilities
  // 4. Run preliminary integration tests

  logger.info(`Initiating verification for partner: ${partner.partnerId}`);

  // Simulate verification process
  setTimeout(() => {
    if (Math.random() > 0.1) {
      // 90% success rate for demo
      partner.status = 'testing';
      PARTNER_REGISTRY.set(partner.partnerId, partner);
      logger.info(`Partner verification completed: ${partner.partnerId}`);
    } else {
      partner.status = 'suspended';
      PARTNER_REGISTRY.set(partner.partnerId, partner);
      logger.warn(`Partner verification failed: ${partner.partnerId}`);
    }
  }, 5000);
}

function calculateExchangeDuration(volume: number, maxTPS: number): string {
  const estimatedSeconds = Math.ceil(volume / (maxTPS * 0.7)); // 70% efficiency factor
  return `${estimatedSeconds}s`;
}

async function schedulePerformanceTest(test: any): Promise<void> {
  // In production, this would integrate with the performance testing framework
  logger.info(`Performance test scheduled: ${JSON.stringify(test)}`);
}

function calculateCurrentTPS(partnerId: string): number {
  // Mock calculation - in production, would query real metrics
  return Math.floor(Math.random() * 1000) + 500;
}

function calculateUptimePercentage(
  partnerId: string,
  timeRange: string
): number {
  // Mock calculation - in production, would query monitoring data
  return 99.0 + Math.random() * 0.9;
}

function calculateSLAScore(partner: PartnerConfig): number {
  // Calculate overall SLA compliance score
  const uptimeScore = Math.min(
    partner.integrationMetrics.avgResponseTime /
      partner.contractualSLA.responseTime,
    1.0
  );
  const responseScore = Math.max(
    1.0 - partner.integrationMetrics.errorRate / 100,
    0
  );

  return Math.round((uptimeScore + responseScore) * 50); // 0-100 score
}

function generatePartnerRecommendations(partner: PartnerConfig): string[] {
  const recommendations: string[] = [];

  if (
    partner.integrationMetrics.avgResponseTime >
    partner.contractualSLA.responseTime
  ) {
    recommendations.push('Consider optimizing API response times');
  }

  if (partner.integrationMetrics.errorRate > 1.0) {
    recommendations.push('Review error handling and retry mechanisms');
  }

  if (partner.capabilities.maxTPS < partner.testingProfile.targetTPS) {
    recommendations.push('Upgrade infrastructure to meet testing TPS targets');
  }

  recommendations.push('Enable Layer 2 compression for improved performance');

  return recommendations;
}

function handlePerformanceData(message: any): void {
  // Process real-time performance data from partners
  logger.info(`Performance data received: ${JSON.stringify(message)}`);
}

// Global error handler
app.use((err: Error, req: any, res: any, next: any) => {
  logger.error('Unhandled error:', err);
  res.status(500).json(errorResponse('Internal server error'));
});

registerGracefulShutdown({
  serviceName: 'partner-coordination',
  server,
  logger,
  state: probeState,
  cleanupFns: [
    {
      name: 'partner-coordination-websocket',
      handler: async () => {
        logger.info('Closing partner WebSocket connections...');
        wss.clients.forEach(ws => {
          ws.terminate();
        });
        partnerConnections.clear();
        logger.info('Partner WebSocket connections closed');
      },
    },
  ],
});

// Start server
server.listen(PORT, () => {
  logger.info(`Partner Coordination Server running on port ${PORT}`);
  logger.info('WebSocket server enabled for real-time partner communication');
  logger.info(`Registered partners: ${PARTNER_REGISTRY.size}`);
  logger.info('Layer 2 enterprise testing target: 100,000+ TPS');
});

export { app, server, PARTNER_REGISTRY };
