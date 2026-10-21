// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});
const { resolveAllowedOrigins } = require('./utils/strict-cors-config');

/**
 * Interactive API Explorer Server
 *
 * Provides Swagger UI interface for testing WRFCoin API endpoints
 * with authentication support and real-time documentation.
 */

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const yaml = require('yamljs');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { appLogger } = require('./utils/logger');
const {
  GracefulShutdown,
  ShutdownPriority,
} = require('../shared/graceful-shutdown/index.js');

const app = express();
const PORT = process.env.API_EXPLORER_PORT || 3003;
const enablePersistedExplorerAuth =
  process.env.API_EXPLORER_PERSIST_AUTH === 'true' &&
  process.env.NODE_ENV !== 'production';
const enableExplorerCredentials =
  process.env.API_EXPLORER_WITH_CREDENTIALS === 'true' &&
  process.env.NODE_ENV !== 'production';

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
        fontSrc: ["'self'", 'fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'validator.swagger.io'],
        connectSrc: ["'self'", ...(process.env.CSP_CONNECT_SRC?.split(',') || ['localhost:*'])],
      },
    },
  })
);

// CORS configuration
app.use(
  cors({
    origin: [
      ...(resolveAllowedOrigins({ developmentDefaults: ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5000'] })),
      'https://api.wrfcoin.com',
      'https://docs.wrfcoin.com',
    ],
    credentials: true,
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Higher limit for API explorer
  message: 'Too many requests from this IP for API explorer',
});
app.use(limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Demo API keys for testing
const DEMO_API_KEYS = new Set([
  'demo-api-key-wrfcoin-explorer',
  'test-key-12345',
  'dev-api-key-wrfcoin',
]);

// Demo JWT secret (for testing only)
const DEMO_JWT_SECRET = (() => {
  const secret = process.env.DEMO_JWT_SECRET;
  if (!secret) {
    throw new Error(
      'DEMO_JWT_SECRET environment variable is required for API explorer service'
    );
  }
  return secret;
})();

// Authentication middleware
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      error: 'API Key Required',
      message: 'Please provide an API key in the X-API-Key header',
      hint: 'Use the demo API key: demo-api-key-wrfcoin-explorer',
    });
  }

  if (DEMO_API_KEYS.has(apiKey)) {
    req.apiKey = apiKey;
    next();
  } else {
    res.status(401).json({
      error: 'Invalid API Key',
      message: 'The provided API key is not valid',
      hint: 'Use a demo key or get a valid API key from the WRFCoin platform',
    });
  }
};

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      error: 'Bearer Token Required',
      message: 'Please provide a Bearer token in the Authorization header',
      hint: 'Format: Authorization: Bearer <your-token>',
    });
  }

  try {
    // For demo purposes, accept demo tokens
    if (token === 'demo-bearer-token-12345') {
      req.user = {
        id: 'demo-user-1',
        address: 'demo0x1234567890123456789012345678901234567890',
        role: 'user',
        permissions: ['read', 'write', 'trade'],
      };
      next();
      return;
    }

    // For production, verify JWT token here
    req.user = {
      id: 'demo-user',
      address: 'demo0x1234567890123456789012345678901234567890',
      role: 'user',
      permissions: ['read'],
    };

    next();
  } catch (error) {
    res.status(403).json({
      error: 'Invalid Token',
      message: 'The provided Bearer token is invalid or expired',
      hint: 'Use demo-bearer-token-12345 for testing or get a valid token',
    });
  }
};

// Setup authentication test routes
const setupAuthRoutes = app => {
  // Generate demo tokens
  app.post('/auth/demo-token', (req, res) => {
    const { userId = 'demo-user', role = 'user' } = req.body;

    const token = 'demo-bearer-token-12345'; // For demo purposes

    res.json({
      success: true,
      token,
      expiresIn: '24h',
      user: {
        id: userId,
        role,
        permissions:
          role === 'admin'
            ? ['read', 'write', 'admin', 'trade']
            : ['read', 'write', 'trade'],
      },
      usage: {
        header: `Authorization: Bearer ${token}`,
        curl: `curl -H "Authorization: Bearer ${token}" ${process.env.API_BASE_URL || 'http://localhost:3003'}/api/protected-endpoint`,
      },
    });
  });

  // Test protected endpoint
  app.get('/auth/test-protected', authenticateToken, (req, res) => {
    res.json({
      success: true,
      message: 'Successfully accessed protected endpoint',
      user: req.user,
      timestamp: new Date().toISOString(),
    });
  });

  // Test API key endpoint
  app.get('/auth/test-api-key', authenticateApiKey, (req, res) => {
    res.json({
      success: true,
      message: 'Successfully accessed API key protected endpoint',
      apiKey: req.apiKey,
      timestamp: new Date().toISOString(),
    });
  });
};

setupAuthRoutes(app);

// Load OpenAPI specification
let openApiSpec;
try {
  openApiSpec = yaml.load(
    path.join(__dirname, '../api/documentation/openapi.yaml')
  );
} catch (error) {
  appLogger.warn('Could not load OpenAPI spec, using default spec', { module: 'APIExplorer', operation: 'loadSpec', error: error.message });
  openApiSpec = {
    openapi: '3.0.3',
    info: {
      title: 'WRFCoin API Explorer',
      version: '1.0.0',
      description: 'Interactive API Explorer for WRFCoin Platform',
    },
    paths: {
      '/health': {
        get: {
          summary: 'Health Check',
          responses: {
            200: {
              description: 'Service is healthy',
            },
          },
        },
      },
    },
  };
}

// Enhanced Swagger UI configuration
const swaggerOptions = {
  explorer: true,
  swaggerOptions: {
    url: '/api-docs/swagger.json',
    docExpansion: 'list',
    defaultModelsExpandDepth: 2,
    defaultModelExpandDepth: 2,
    displayRequestDuration: true,
    filter: true,
    showExtensions: true,
    showCommonExtensions: true,
    tryItOutEnabled: true,
    persistAuthorization: enablePersistedExplorerAuth,
    withCredentials: enableExplorerCredentials,
  },
  customCss: `
    .swagger-ui .topbar { 
      background-color: #1e3a8a; 
      border-bottom: 3px solid #3b82f6;
    }
    .swagger-ui .info .title {
      color: #1e3a8a;
      font-size: 2rem;
    }
    .swagger-ui .btn.authorize {
      background-color: #3b82f6;
      border-color: #3b82f6;
    }
    .swagger-ui .btn.authorize:hover {
      background-color: #2563eb;
      border-color: #2563eb;
    }
  `,
  customSiteTitle: 'WRFCoin API Explorer',
};

// Enhanced OpenAPI spec with additional configuration
const enhancedSpec = {
  ...openApiSpec,
  servers: [
    {
      url: process.env.API_BASE_URL || 'http://localhost:3001',
      description: 'Local Development Server',
    },
    {
      url: 'https://staging-api.wrfcoin.com/v1',
      description: 'Staging Server',
    },
    {
      url: 'https://api.wrfcoin.com/v1',
      description: 'Production Server',
    },
  ],
  components: {
    ...openApiSpec.components,
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key for accessing WRFCoin endpoints',
      },
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token for authenticated requests',
      },
    },
  },
};

// Serve OpenAPI spec as JSON
app.get('/api-docs/swagger.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(enhancedSpec);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    service: 'api-explorer',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0',
  });
});

// API Explorer status endpoint
app.get('/explorer/status', (req, res) => {
  res.json({
    explorer: 'WRFCoin API Explorer',
    swaggerVersion: '3.0.3',
    endpoints: Object.keys(enhancedSpec.paths || {}).length,
    lastUpdated: new Date().toISOString(),
    supportedAuth: ['ApiKey', 'Bearer Token'],
    demoMode: true,
  });
});

// ReDoc alternative endpoint
app.get('/redoc', (req, res) => {
  const redocHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>WRFCoin API Documentation - ReDoc</title>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
      <style>
        body { margin: 0; padding: 0; }
        redoc { display: block; }
      </style>
    </head>
    <body>
      <redoc spec-url='/api-docs/swagger.json'></redoc>
      <script src="https://cdn.jsdelivr.net/npm/redoc@latest/bundles/redoc.standalone.js"></script>
    </body>
    </html>
  `;
  res.send(redocHtml);
});

// Custom Swagger UI setup with enhanced options
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(enhancedSpec, swaggerOptions)
);

// Custom API explorer with authentication helper
app.get('/', (req, res) => {
  const customHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>WRFCoin API Explorer</title>
      <style>
        .auth-helper {
          position: fixed;
          top: 80px;
          right: 20px;
          background: white;
          border: 2px solid #3b82f6;
          border-radius: 8px;
          padding: 15px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          z-index: 1000;
          max-width: 300px;
        }
        .auth-helper h4 {
          margin: 0 0 10px 0;
          color: #1e3a8a;
          font-size: 16px;
        }
        .auth-helper input {
          width: 100%;
          padding: 8px;
          border: 1px solid #d1d5db;
          border-radius: 4px;
          margin: 5px 0;
          font-size: 14px;
        }
        .auth-helper button {
          background: #3b82f6;
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
          margin: 5px 5px 5px 0;
          font-size: 14px;
        }
        .auth-helper button:hover {
          background: #2563eb;
        }
        .demo-btn {
          background: #10b981 !important;
        }
        .demo-btn:hover {
          background: #059669 !important;
        }
      </style>
    </head>
    <body>
      <div id="swagger-ui"></div>
      
      <div class="auth-helper">
        <h4>🔐 Quick Authentication</h4>
        
        <div>
          <input type="text" id="apiKey" placeholder="API Key" />
          <button onclick="setApiKey()">Set API Key</button>
        </div>
        
        <div>
          <input type="text" id="authToken" placeholder="Bearer Token" />
          <button onclick="setAuthToken()">Set Token</button>
        </div>
        
        <div style="margin-top: 10px;">
          <button class="demo-btn" onclick="useDemoCredentials()">Use Demo</button>
        </div>
        
        <div style="margin-top: 15px; font-size: 12px; color: #6b7280;">
          <strong>Quick Start:</strong><br>
          1. Click "Use Demo" for test credentials<br>
          2. Try the /health endpoint first<br>
          3. Explore weather and blockchain APIs
        </div>
      </div>

      <script>
        function setApiKey() {
          const apiKey = document.getElementById('apiKey').value;
          if (apiKey) {
            window.ui.preauthorizeApiKey('ApiKeyAuth', apiKey);
            alert('API Key set successfully');
          }
        }
        
        function setAuthToken() {
          const token = document.getElementById('authToken').value;
          if (token) {
            window.ui.preauthorizeApiKey('BearerAuth', token);
            alert('Auth Token set successfully');
          }
        }
        
        function useDemoCredentials() {
          const demoApiKey = 'demo-api-key-wrfcoin-explorer';
          const demoToken = 'demo-bearer-token-12345';
          
          document.getElementById('apiKey').value = demoApiKey;
          document.getElementById('authToken').value = demoToken;
          
          window.ui.preauthorizeApiKey('ApiKeyAuth', demoApiKey);
          window.ui.preauthorizeApiKey('BearerAuth', demoToken);
          alert('Demo credentials loaded');
        }
      </script>
      
      <link rel="stylesheet" type="text/css" href="/api-docs/swagger-ui-bundle.css" />
      <script src="/api-docs/swagger-ui-bundle.js"></script>
      <script>
        SwaggerUIBundle({
          url: '/api-docs/swagger.json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [
            SwaggerUIBundle.presets.apis,
            SwaggerUIBundle.presets.standalone
          ],
          plugins: [
            SwaggerUIBundle.plugins.DownloadUrl
          ],
          layout: "StandaloneLayout"
        });
      </script>
    </body>
    </html>
  `;

  res.send(customHtml);
});

// API documentation endpoint
app.get('/docs', (req, res) => {
  res.json({
    message: 'WRFCoin API Explorer',
    endpoints: {
      'Swagger UI': '/api-docs',
      ReDoc: '/redoc',
      'OpenAPI Spec': '/api-docs/swagger.json',
      'Health Check': '/health',
      'Explorer Status': '/explorer/status',
    },
    authentication: {
      apiKey: 'Use X-API-Key header or set in UI',
      bearerToken: 'Use Authorization: Bearer <token> header',
      demo: 'Click "Use Demo" button for test credentials',
    },
    usage: {
      quickStart: [
        '1. Visit / for interactive explorer',
        '2. Click "Use Demo" for test credentials',
        '3. Try /health endpoint first',
        '4. Explore weather, blockchain, and other APIs',
      ],
    },
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  appLogger.error('API Explorer Error', { module: 'APIExplorer', operation: 'errorHandler', error: err.message });
  res.status(500).json({
    error: 'API Explorer Error',
    message: err.message || 'Unknown error',
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Endpoint ${req.path} not found in API Explorer`,
    availableEndpoints: ['/', '/api-docs', '/redoc', '/health', '/docs'],
  });
});

// Start server
const server = app.listen(PORT, () => {
  appLogger.info('WRFCoin API Explorer running', { module: 'APIExplorer', operation: 'serverStart', port: PORT });
  appLogger.info('Swagger UI available', { module: 'APIExplorer', operation: 'serverStart', url: `http://localhost:${PORT}/api-docs` });
  appLogger.info('ReDoc available', { module: 'APIExplorer', operation: 'serverStart', url: `http://localhost:${PORT}/redoc` });
  appLogger.info('Interactive Explorer available', { module: 'APIExplorer', operation: 'serverStart', url: `http://localhost:${PORT}/` });
  appLogger.info('Health Check available', { module: 'APIExplorer', operation: 'serverStart', url: `http://localhost:${PORT}/health` });
});

// Setup graceful shutdown
const gracefulShutdown = GracefulShutdown.getInstance();

gracefulShutdown.registerHandler({
  name: 'api-explorer-http-server',
  priority: ShutdownPriority.DRAIN_HTTP_CONNECTIONS,
  timeout: 10000,
  handler: () => {
    return new Promise((resolve, reject) => {
      appLogger.info('Shutting down API Explorer HTTP server...', { module: 'APIExplorer', operation: 'shutdown' });
      server.close((err) => {
        if (err) {
          appLogger.error('Error closing API Explorer server', { module: 'APIExplorer', operation: 'shutdown', error: err.message });
          reject(err);
        } else {
          appLogger.info('API Explorer HTTP server closed', { module: 'APIExplorer', operation: 'shutdown' });
          resolve();
        }
      });
    });
  },
});

gracefulShutdown.setupSignalHandlers();

module.exports = { app, server };
