// OpenTelemetry must be initialized before other imports for auto-instrumentation
import { initializeOTel } from './utils/otel-setup.js';
void initializeOTel().catch(() => {});

/**
 * Interactive API Explorer Server
 *
 * Provides Swagger UI interface for testing WRFCoin API endpoints
 * with authentication support and real-time documentation.
 */

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import * as fs from 'fs';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as yaml from 'yaml';
import { appLogger } from './utils/logger.js';
import {
  GracefulShutdown,
  ShutdownPriority,
} from '../shared/graceful-shutdown/index.js';
import strictCorsConfig from './utils/strict-cors-config.js';

const { resolveAllowedOrigins } = strictCorsConfig;

// Auth test routes removed for security — use proper authentication flows

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
    origin: resolveAllowedOrigins({ developmentDefaults: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5000',
      'https://api.wrfcoin.com',
      'https://docs.wrfcoin.com',
    ] }),
    credentials: true,
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Higher limit for API explorer
  message: 'Too many requests from this IP for API explorer',
});
(app as any).use(limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Load OpenAPI specification
const openApiSpec = yaml.parse(
  fs.readFileSync(
    path.join(__dirname, '../api/documentation/openapi.yaml'),
    'utf8'
  )
);

// Enhanced Swagger UI configuration
const swaggerOptions: swaggerUi.SwaggerUiOptions = {
  explorer: true,
  swaggerOptions: {
    url: '/api-docs/swagger.json',
    docExpansion: 'list', // 'list', 'full', 'none'
    defaultModelsExpandDepth: 2,
    defaultModelExpandDepth: 2,
    displayRequestDuration: true,
    filter: true,
    showExtensions: true,
    showCommonExtensions: true,
    tryItOutEnabled: true,
    requestInterceptor: `(request) => {
      appLogger.info('API Request', { request });
      return request;
    }`,
    responseInterceptor: `(response) => {
      appLogger.info('API Response', { response });
      return response;
    }`,
    persistAuthorization: enablePersistedExplorerAuth,
    withCredentials: enableExplorerCredentials,
  },
  customCss: `
    .swagger-ui .topbar { 
      background-color: #1e3a8a; 
      border-bottom: 3px solid #3b82f6;
    }
    .swagger-ui .topbar .link {
      content: url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTIwIiBoZWlnaHQ9IjQwIiB2aWV3Qm94PSIwIDAgMTIwIDQwIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjx0ZXh0IHg9IjEwIiB5PSIyNSIgZm9udC1mYW1pbHk9IkFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjE4IiBmb250LXdlaWdodD0iYm9sZCIgZmlsbD0iI0ZGRkZGRiI+V1JGQ29pbjwvdGV4dD48L3N2Zz4=');
    }
    .swagger-ui .info .title {
      color: #1e3a8a;
      font-size: 2rem;
    }
    .swagger-ui .scheme-container {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 1rem;
      margin: 1rem 0;
    }
    .swagger-ui .auth-container {
      background: #fef3c7;
      border: 1px solid #f59e0b;
      border-radius: 8px;
      padding: 1rem;
      margin: 1rem 0;
    }
    .swagger-ui .btn.authorize {
      background-color: #3b82f6;
      border-color: #3b82f6;
    }
    .swagger-ui .btn.authorize:hover {
      background-color: #2563eb;
      border-color: #2563eb;
    }
    .swagger-ui .opblock.opblock-get .opblock-summary-method {
      background: #10b981;
    }
    .swagger-ui .opblock.opblock-post .opblock-summary-method {
      background: #3b82f6;
    }
    .swagger-ui .opblock.opblock-put .opblock-summary-method {
      background: #f59e0b;
    }
    .swagger-ui .opblock.opblock-delete .opblock-summary-method {
      background: #ef4444;
    }
    .auth-wrapper {
      background: #f1f5f9;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      border-left: 4px solid #3b82f6;
    }
    .quick-auth-buttons {
      display: flex;
      gap: 10px;
      margin: 10px 0;
    }
    .quick-auth-btn {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    .quick-auth-btn:hover {
      background: #2563eb;
    }
  `,
  customSiteTitle: 'WRFCoin API Explorer',
  customfavIcon: '/favicon.ico',
};

// Custom authentication helper UI
const customHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>WRFCoin API Explorer</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
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
    .auth-helper .demo-btn {
      background: #10b981;
    }
    .auth-helper .demo-btn:hover {
      background: #059669;
    }
    .auth-helper .clear-btn {
      background: #ef4444;
    }
    .auth-helper .clear-btn:hover {
      background: #dc2626;
    }
    .status {
      font-size: 12px;
      margin-top: 10px;
      padding: 5px;
      border-radius: 4px;
    }
    .status.success {
      background: #d1fae5;
      color: #065f46;
    }
    .status.error {
      background: #fee2e2;
      color: #991b1b;
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
      <button class="clear-btn" onclick="clearAuth()">Clear All</button>
    </div>
    
    <div id="authStatus" class="status" style="display: none;"></div>
    
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
            showStatus('API Key set successfully', 'success');
            window.ui.preauthorizeApiKey('ApiKeyAuth', apiKey);
          }
        }
    
        function setAuthToken() {
          const token = document.getElementById('authToken').value;
          if (token) {
            showStatus('Auth Token set successfully', 'success');
            window.ui.preauthorizeApiKey('BearerAuth', token);
          }
        }
    
    function useDemoCredentials() {
      // Demo API key for testing
      const demoApiKey = 'demo-api-key-wrfcoin-explorer';
      const demoToken = 'demo-bearer-token-12345';
      
      document.getElementById('apiKey').value = demoApiKey;
      document.getElementById('authToken').value = demoToken;
      
      showStatus('Demo credentials loaded', 'success');
      
      // Update Swagger UI
      window.ui.preauthorizeApiKey('ApiKeyAuth', demoApiKey);
      window.ui.preauthorizeApiKey('BearerAuth', demoToken);
    }
    
    function clearAuth() {
      localStorage.removeItem('wrfcoin-api-key');
      localStorage.removeItem('wrfcoin-auth-token');
      document.getElementById('apiKey').value = '';
      document.getElementById('authToken').value = '';
      showStatus('Authentication cleared', 'error');
    }
    
    function showStatus(message, type) {
      const status = document.getElementById('authStatus');
      status.textContent = message;
      status.className = 'status ' + type;
      status.style.display = 'block';
      
      setTimeout(() => {
        status.style.display = 'none';
      }, 3000);
    }
    
  </script>
</body>
</html>
`;

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
app.get(
  '/api-docs/swagger.json',
  (req: express.Request, res: express.Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(enhancedSpec);
  }
);

// Health check endpoint
app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({
    service: 'api-explorer',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0',
  });
});

// API Explorer status endpoint
app.get('/explorer/status', (req: express.Request, res: express.Response) => {
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
app.get('/redoc', (req: express.Request, res: express.Response) => {
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

// Proxy endpoint for testing against actual API
app.use('/proxy/api', async (req: express.Request, res: express.Response) => {
  try {
    const apiUrl = process.env.API_BASE_URL || 'http://localhost:3001';
    const targetUrl = `${apiUrl}${req.url}`;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(
          ([key, value]) => key !== 'host' && value !== undefined
        )
      ) as Record<string, string>,
      body: ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : JSON.stringify(req.body),
    });

    const data = await response.text();
    res.status(response.status).send(data);
  } catch (error) {
    res.status(500).json({
      error: 'Proxy error',
      message: error instanceof Error ? error.message : 'Unknown proxy error',
    });
  }
});

// Custom Swagger UI setup with enhanced options
app.use(
  '/api-docs',
  swaggerUi.serveFiles(enhancedSpec, swaggerOptions),
  swaggerUi.setup(enhancedSpec, swaggerOptions)
);

// Custom API explorer with authentication helper
app.get('/', (req: express.Request, res: express.Response) => {
  const customSwaggerHtml = swaggerUi.generateHTML(enhancedSpec, {
    ...swaggerOptions,
    customCss: swaggerOptions.customCss,
    customSiteTitle: 'WRFCoin API Explorer',
  });

  // Inject custom authentication helper
  const enhancedHtml = customSwaggerHtml.replace(
    '<div id="swagger-ui"></div>',
    customHtml.match(/<body>([\s\S]*?)<\/body>/)?.[1] ||
      '<div id=\"swagger-ui\"></div>'
  );

  res.send(enhancedHtml);
});

// API documentation endpoint
app.get('/docs', (req: express.Request, res: express.Response) => {
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
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    appLogger.error('API Explorer Error', { error: err.message });
    res.status(500).json({
      error: 'API Explorer Error',
      message: err instanceof Error ? err.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
);

// 404 handler
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Endpoint ${req.path} not found in API Explorer`,
    availableEndpoints: ['/', '/api-docs', '/redoc', '/health', '/docs'],
  });
});

// Start server
const server = app.listen(PORT, () => {
  appLogger.info(`WRFCoin API Explorer running on port ${PORT}`);
  appLogger.info(`Swagger UI: http://localhost:${PORT}/api-docs`);
  appLogger.info(`ReDoc: http://localhost:${PORT}/redoc`);
  appLogger.info(`Interactive Explorer: http://localhost:${PORT}/`);
  appLogger.info(`Health Check: http://localhost:${PORT}/health`);
});

// Setup graceful shutdown
const gracefulShutdown = GracefulShutdown.getInstance();

gracefulShutdown.registerHandler({
  name: 'api-explorer-http-server',
  priority: ShutdownPriority.DRAIN_HTTP_CONNECTIONS,
  timeout: 10000,
  handler: () => {
    return new Promise<void>((resolve, reject) => {
      appLogger.info('Shutting down API Explorer HTTP server...');
      server.close((err) => {
        if (err) {
          appLogger.error('Error closing API Explorer server', { error: err.message });
          reject(err);
        } else {
          appLogger.info('API Explorer HTTP server closed');
          resolve();
        }
      });
    });
  },
});

gracefulShutdown.setupSignalHandlers();

export { app, server };
