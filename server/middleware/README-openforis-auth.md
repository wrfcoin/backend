# OpenForis API Authentication and Validation Guide

## Overview

This guide covers the comprehensive OpenForis API validation and error handling implementation for
the WRFCoin weather forecasting blockchain platform. The implementation includes production-ready
validation logic, security considerations, input sanitization, and standardized error responses.

## Key Components

### 1. Validation Schemas (`validation-schemas.js`)

- **API Key Validation**: Format validation, length checks, character validation
- **Endpoint URL Validation**: HTTPS enforcement, hostname verification, production safety checks
- **Request Validation**: Comprehensive schemas for projects, plots, time series, and climate data
- **Response Validation**: Structure validation for API responses

### 2. Error Handler (`error-handler.js`)

- **Structured Error Responses**: Consistent error format across all endpoints
- **Retry Logic**: Intelligent retry with exponential backoff
- **Error Classification**: Categorization of retryable vs non-retryable errors
- **Monitoring Integration**: Detailed logging for operational monitoring

### 3. Middleware (`middleware.js`)

- **Input Sanitization**: XSS protection, SQL injection prevention, path traversal protection
- **Request Size Limiting**: Body size limits, parameter count limits
- **Security Headers**: Comprehensive security header implementation
- **Content Type Validation**: Strict content type enforcement
- **Rate Limiting**: IP-based rate limiting with sliding window

### 4. Production Adapter (`adapter.js`)

- **Enhanced API Validation**: Multi-step validation process in production mode
- **Security Checks**: API key entropy validation, domain allowlisting, SSL verification
- **Response Time Tracking**: Performance monitoring and logging
- **Request Tracking**: Unique request IDs for debugging and monitoring

## Production Implementation Features

### Enhanced API Key Security

```javascript
// Environment variable validation
if (!process.env.OPENFORIS_API_KEY) {
  throw new Error('OpenForis API key not configured');
}

// Format and security validation
validateApiKey(apiKey);

// Production-specific checks
if (process.env.NODE_ENV === 'production') {
  // Prevent test keys in production
  if (apiKey.includes('test') || apiKey.includes('dev')) {
    throw new Error('Test API keys cannot be used in production');
  }

  // Check API key entropy
  const uniqueChars = new Set(apiKey.replace(/[^a-zA-Z0-9]/g, '')).size;
  if (uniqueChars < 16) {
    logger.warn('API key appears to have low entropy');
  }
}
```

### Enhanced URL Validation

```javascript
// Basic URL validation
validateEndpointUrl(url);

// Production security checks
if (process.env.NODE_ENV === 'production') {
  const parsedUrl = new URL(url);

  // Enforce HTTPS
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('All endpoints must use HTTPS in production');
  }

  // Domain allowlisting
  const allowedDomains = process.env.OPENFORIS_ALLOWED_DOMAINS?.split(',') || [];
  if (allowedDomains.length > 0) {
    const isAllowed = allowedDomains.some(domain => parsedUrl.hostname.endsWith(domain.trim()));
    if (!isAllowed) {
      throw new Error(`Domain ${parsedUrl.hostname} is not in allowed domains list`);
    }
  }
}
```

### Input Sanitization

```javascript
// XSS Prevention
sanitizedValue = value
  .replace(/<script[^>]*>.*?<\/script>/gi, '')
  .replace(/javascript:/gi, '')
  .replace(/vbscript:/gi, '')
  .replace(/on\w+\s*=/gi, '')
  .replace(/eval\s*\(/gi, '')
  .trim();

// SQL Injection Prevention
const suspiciousPatterns = [
  /union\s+select/i,
  /drop\s+table/i,
  /insert\s+into/i,
  /delete\s+from/i,
  /'.*?or.*?'.*?='/i,
];

// Path Traversal Prevention
const pathTraversalPatterns = [/\.\.\//g, /%2e%2e%2f/gi];
```

### Comprehensive Error Handling

```javascript
// Structured error responses
{
  "success": false,
  "error": "OpenForis API validation failed",
  "code": "VALIDATION_ERROR",
  "details": [
    {
      "field": "name",
      "message": "Project name must be between 3 and 100 characters",
      "value": "A",
      "location": "body"
    }
  ],
  "timestamp": "2023-12-07T10:30:00Z",
  "requestId": "wrfc-1701939000000-abc123"
}
```

## Usage Examples

### Basic Middleware Setup

```javascript
const express = require('express');
const OpenForisMiddleware = require('./openforis/middleware');

const app = express();

// Security middleware (apply first)
app.use(OpenForisMiddleware.securityHeaders());
app.use(OpenForisMiddleware.cors());

// Request processing middleware
app.use(
  OpenForisMiddleware.limitRequestSize({
    maxBodySize: 2 * 1024 * 1024, // 2MB
    maxQueryParams: 50,
    maxParamLength: 1000,
  })
);
app.use(OpenForisMiddleware.validateContentType());
app.use(OpenForisMiddleware.sanitizeInput());

// Rate limiting
app.use(
  '/api/openforis',
  OpenForisMiddleware.rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // requests per window
  })
);

// Logging
app.use(OpenForisMiddleware.requestLogger());
```

### Route-Specific Validation

```javascript
// Project creation endpoint
app.post(
  '/api/openforis/projects',
  OpenForisMiddleware.requireAuth(),
  ...OpenForisMiddleware.validateCreateProject(),
  async (req, res, next) => {
    try {
      const project = await openforisAdapter.createCollectEarthProject(req.body);
      res.json({
        success: true,
        data: project,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  }
);

// Error handling (apply last)
app.use(OpenForisMiddleware.errorHandler());
```

### Production Adapter Usage

```javascript
const { OpenForisAdapter } = require('./openforis/adapter');

// Production configuration
const adapter = new OpenForisAdapter({
  testMode: false, // Production mode
  collectEarthEndpoint: process.env.OPENFORIS_COLLECT_EARTH_ENDPOINT,
  earthMapEndpoint: process.env.OPENFORIS_EARTH_MAP_ENDPOINT,
  climateDataEndpoint: process.env.OPENFORIS_CLIMATE_DATA_ENDPOINT,
});

// Initialize with full validation
await adapter.initialize();

// Make validated API requests
const response = await adapter.makeApiRequest('POST', url, data, {
  validateResponse: validateProjectResponse, // Optional response validation
  timeout: 30000,
  maxRetries: 3,
});
```

## Environment Variables

### Required

```bash
# OpenForis API Configuration
OPENFORIS_API_KEY=your_production_api_key_here
OPENFORIS_COLLECT_EARTH_ENDPOINT=https://api.collect.earth
OPENFORIS_EARTH_MAP_ENDPOINT=https://api.earthmap.org
OPENFORIS_CLIMATE_DATA_ENDPOINT=https://api.climatedata.openforis.org

# Security Configuration
NODE_ENV=production
OPENFORIS_JWT_SECRET=replace-with-strong-random-secret

# API key auth (JSON array consumed by openforis-auth middleware)
# OPENFORIS_API_KEYS must be configured through environment, not source code.
OPENFORIS_API_KEYS='[
  {
    "key":"prod-openforis-key-1",
    "tier":"enterprise",
    "organizationId":"org_prod_1",
    "organizationName":"Production Organization 1",
    "permissions":["openforis:*","openforis:blockchain:export"]
  }
]'
```

### Optional Security Configuration

```bash
# Domain allowlisting (comma-separated)
OPENFORIS_ALLOWED_DOMAINS=collect.earth,earthmap.org,openforis.org

# Request timeouts
OPENFORIS_API_TIMEOUT=30000

# Rate limiting
OPENFORIS_RATE_LIMIT_WINDOW=900000  # 15 minutes in ms
OPENFORIS_RATE_LIMIT_MAX=100        # requests per window

# CORS configuration
CORS_ORIGIN=https://app.wrfcoin.com,https://dashboard.wrfcoin.com
```

### Local Development Configuration (No Built-In Demo Credentials)

The middleware no longer ships with runtime demo/default API keys or JWT tokens.
For local testing, explicitly provide local-only credentials through environment variables:

```bash
NODE_ENV=development
OPENFORIS_JWT_SECRET=local-openforis-dev-secret
OPENFORIS_API_KEYS='[
  {
    "key":"local-openforis-key-free",
    "tier":"free",
    "organizationId":"org_local_free",
    "organizationName":"Local Free Org",
    "permissions":["openforis:read","openforis:projects:read","openforis:climate:read"]
  }
]'
```

In non-development environments (`NODE_ENV` not equal to `development`), startup fails if
`OPENFORIS_JWT_SECRET` is missing.

## Security Features

### 1. **Input Validation and Sanitization**

- XSS attack prevention
- SQL injection protection
- Path traversal prevention
- Content type validation
- Request size limitations

### 2. **API Security**

- Bearer token authentication
- API key format validation
- Domain allowlisting
- HTTPS enforcement
- SSL certificate validation

### 3. **Response Security**

- Security headers (HSTS, CSP, etc.)
- Information disclosure prevention
- Error message sanitization
- Response size monitoring

### 4. **Monitoring and Logging**

- Request/response logging
- Error classification
- Performance metrics
- Security event logging
- Rate limit monitoring

## Error Response Standards

### Validation Error (400)

```json
{
  "success": false,
  "error": "OpenForis API validation failed",
  "code": "VALIDATION_ERROR",
  "details": [
    {
      "field": "coordinates.latitude",
      "message": "Latitude must be between -90 and 90",
      "value": 100,
      "location": "body"
    }
  ],
  "timestamp": "2023-12-07T10:30:00Z",
  "requestId": "wrfc-1701939000000-abc123"
}
```

### Authentication Error (401)

```json
{
  "success": false,
  "error": "OpenForis API authentication failed",
  "code": "AUTHENTICATION_FAILED",
  "message": "API key is invalid or has expired",
  "timestamp": "2023-12-07T10:30:00Z"
}
```

### Rate Limit Error (429)

```json
{
  "success": false,
  "error": "OpenForis API rate limit exceeded",
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Too many requests to OpenForis API. Please try again later.",
  "retryAfter": 300,
  "timestamp": "2023-12-07T10:30:00Z"
}
```

### Server Error (503)

```json
{
  "success": false,
  "error": "OpenForis API service unavailable",
  "code": "SERVICE_UNAVAILABLE",
  "message": "OpenForis API is temporarily unavailable. Please try again later.",
  "timestamp": "2023-12-07T10:30:00Z"
}
```

## Testing

### Unit Tests

Run the comprehensive test suite:

```bash
npm test -- backend/server/openforis/__tests__/api-validation.test.js
```

### Integration Tests

Test with actual OpenForis API endpoints (requires valid API key):

```bash
OPENFORIS_API_KEY=your_test_key \
OPENFORIS_JWT_SECRET=local-test-openforis-secret \
OPENFORIS_API_KEYS='[{"key":"local-test-openforis-key","tier":"free"}]' \
npm run test:integration
```

### Security Tests

Test input sanitization and security features:

```bash
npm run test:security
```

## Best Practices

### 1. **API Key Management**

- Use environment variables for API keys
- Rotate API keys regularly
- Use different keys for different environments
- Monitor API key usage

### 2. **Error Handling**

- Always provide user-friendly error messages
- Log detailed errors for debugging
- Use structured error responses
- Implement proper HTTP status codes

### 3. **Security**

- Validate all inputs on both client and server
- Use HTTPS for all API communications
- Implement proper rate limiting
- Monitor for suspicious activity

### 4. **Performance**

- Cache API responses when appropriate
- Use request timeouts
- Implement retry logic with exponential backoff
- Monitor response times

### 5. **Monitoring**

- Log all API requests and responses
- Track error rates and types
- Monitor API quotas and rate limits
- Set up alerts for service degradation

## Troubleshooting

### Common Issues

1. **API Key Validation Failures**

   - Check API key format and length
   - Verify environment variables are set
   - Ensure no test keys in production

2. **Endpoint Validation Failures**

   - Verify HTTPS URLs in production
   - Check domain allowlisting configuration
   - Validate SSL certificates

3. **Request Validation Failures**

   - Check request data structure
   - Verify content types
   - Review field validation rules

4. **Rate Limiting Issues**
   - Monitor request rates
   - Implement client-side backoff
   - Check rate limit headers

For additional support, refer to the OpenForis API documentation and WRFCoin platform security
guidelines.
