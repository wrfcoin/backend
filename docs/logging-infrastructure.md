# WRFCoin Logging Infrastructure Documentation

## Overview

The WRFCoin platform implements a comprehensive logging infrastructure designed for high-performance
blockchain applications with advanced monitoring, security, and compliance requirements.

## Architecture

### Core Components

1. **Enhanced Logger Configuration** (`server/utils/logger.ts`)

   - Correlation tracking across async operations
   - PII data masking for compliance
   - Multiple specialized loggers (app, performance, security, GraphQL, etc.)
   - Structured JSON logging with metadata

2. **Centralized Middleware** (`server/middleware/logging.ts`)

   - Request/response correlation tracking
   - Performance timing analysis
   - Error handling and propagation
   - Express middleware integration

3. **Real-time Analysis** (`server/utils/log-analyzer.ts`)

   - Log file monitoring and parsing
   - Automated alert generation
   - Historical analysis capabilities
   - EventEmitter-based notifications

4. **Performance Monitoring** (`server/middleware/performance-logging.ts`)

   - Prometheus metrics integration
   - Detailed timing analysis
   - Memory and CPU usage tracking
   - Service call performance monitoring

5. **Security Logging** (`server/middleware/security-logging.ts`)

   - Threat detection and risk scoring
   - HSM operation logging
   - Compliance violation tracking
   - Authentication and authorization monitoring

6. **GraphQL Integration** (`server/middleware/graphql-logging.ts`)

   - Operation complexity analysis
   - Resolver-level performance tracking
   - Query pattern monitoring
   - Security event detection

7. **Monitoring Dashboard** (`server/utils/logging-dashboard.ts`)
   - Real-time system metrics
   - API endpoints for external monitoring
   - HTML dashboard interface
   - Alert management integration

## Features

### Correlation Tracking

- Unique correlation IDs for request tracing
- AsyncLocalStorage for context preservation
- Cross-service request tracking
- Distributed system support

### PII Data Protection

- Automatic PII field masking
- Configurable masking patterns
- Compliance with GDPR/CCPA
- Audit trail preservation

### Performance Monitoring

- Request/response timing
- Memory usage tracking
- CPU utilization monitoring
- Database query performance
- Redis operation timing
- Service call latency

### Security Features

- Threat pattern detection
- Brute force attack monitoring
- IP activity tracking
- Device fingerprinting
- HSM operation auditing
- Admin action logging

### Real-time Analysis

- Log file monitoring
- Automated alert generation
- Pattern recognition
- Anomaly detection
- Threshold-based alerting

## Configuration

### Environment Variables

```bash
# Log levels
LOG_LEVEL=info              # debug, info, warn, error
NODE_ENV=production         # development, production

# Log storage
LOG_RETENTION_DAYS=30       # Log file retention
LOG_MAX_SIZE=100m          # Maximum log file size
LOG_MAX_FILES=10           # Maximum log files to keep

# Monitoring
PROMETHEUS_ENABLED=true     # Enable Prometheus metrics
ALERT_THRESHOLD_ERROR=10    # Error count threshold
ALERT_THRESHOLD_PERF=1000   # Performance threshold (ms)
```

### Logger Configuration

```typescript
import { appLogger, performanceLogger, securityLogger } from './server/utils/logger';

// Basic logging
appLogger.info('Application event', {
  operation: 'user:login',
  userId: 'user123',
  correlationId: 'wrfc_123456_abc',
});

// Performance logging
logPerformanceMetrics('Database query', duration, memoryUsage, { query: 'SELECT', table: 'users' });

// Security logging
logSecurityEvent(
  SecurityEventType.AUTHENTICATION_SUCCESS,
  { method: 'jwt', userId: 'user123' },
  'info',
  'user123',
  '192.168.1.1'
);
```

## Integration

### Express Application

```typescript
import express from 'express';
import {
  loggingMiddlewareChain,
  performanceMonitoringMiddleware,
  securityLoggingMiddlewareChain,
} from './server/middleware';

const app = express();

// Apply logging middleware
app.use(...loggingMiddlewareChain);
app.use(performanceMonitoringMiddleware);
app.use(...securityLoggingMiddlewareChain);
```

### GraphQL Server

```typescript
import { createGraphQLLoggingPlugin } from './server/middleware/graphql-logging';

const server = new ApolloServer({
  schema,
  plugins: [
    createGraphQLLoggingPlugin(),
    // other plugins...
  ],
});
```

### Dashboard Integration

```typescript
import { createDashboardEndpoints } from './server/utils/logging-dashboard';

const dashboardEndpoints = createDashboardEndpoints();

app.get('/api/logging/dashboard', dashboardEndpoints.getDashboard);
app.get('/api/logging/metrics', dashboardEndpoints.getMetrics);
app.get('/api/logging/health', dashboardEndpoints.getHealth);
```

## Fatal Process Events (uncaughtException / unhandledRejection)

Policy from backend#1243, implemented in `server/utils/logger.ts` (see `installFatalExit`).

- **Winston never exits on its own.** With file transports on, Winston registers exactly one listener for each of `uncaughtException` and `unhandledRejection`, logs the error, and the logger keeps `exitOnError: false`. `exitOnError` is a plain `false`, not a function, and no listener count is consulted.
- **Emit hook decides ownership.** The module wraps `process.emit` once. When `uncaughtException` or `unhandledRejection` is emitted, the hook decides ownership for that event before any listener is dispatched, so registration order (`on`, `once`, `prependListener`, `prependOnceListener`) and one-shot listener removal cannot change the decision.
  - If any registered listener for that event is not one of Winston's own, the application owns the event. Nothing is scheduled and the application's drain policy (for example `GracefulShutdown`, or the log-and-continue legacy servers) is left intact.
  - Otherwise the hook sets `process.exitCode = 1` and calls `process.exit(1)` 500 ms later (unref'd timer), after Winston's listener has written the record.
  - Ownership is per event: a handler for one event does not silence the other.
- **Process-receiver guard.** The policy runs only when `this === process`. A borrowed `emit` call on another emitter, or on the same function invoked with a different receiver, is forwarded unchanged.
- **Shared ownership record.** The set of Winston-owned listeners and the hook marker live on the process under registered Symbols (`Symbol.for('wrfcoin.logger.fatalListeners')`, `Symbol.for('wrfcoin.logger.fatalExitHook')`). Every evaluation of the module, including a fresh re-import with a different query string, shares one hook and one record, so a re-import neither double-installs the hook nor mistakes Winston's listeners for the application's.
- **Regression tests:** `__tests__/logger-fatal-exit-1243.test.ts` runs real subprocesses against the real logger (unowned exits 1, cross-event, listener-order matrix, fresh re-import, clean process exits 0).

### Database shutdown timeouts (backend#1259)

`database/connection.ts` ends the Postgres client with a 3 s `end` timeout inside a shutdown handler whose own timeout is 8 s, so the handler timer no longer wins the race on a starved host. The supporting load experiment (22 busy-loop processes; 2 of 4 runs failed before, 0 of 4 after) is a small sample and is directional evidence only, not proof of a flake-rate change.

## Log Files

### File Structure

```
logs/
├── combined.log          # All log entries
├── error.log            # Error-level entries only
├── performance.log      # Performance metrics
├── security.log         # Security events
├── graphql.log         # GraphQL operations
├── crosschain.log      # Cross-chain operations
├── iot.log             # IoT sensor data
└── weather.log         # Weather data processing
```

### Log Format

```json
{
  "timestamp": "2025-01-27T10:30:00.000Z",
  "level": "info",
  "message": "User authentication successful",
  "correlationId": "wrfc_1706353800000_abc123",
  "operation": "auth:login",
  "userId": "user123",
  "duration": 150,
  "metadata": {
    "ip": "192.168.1.1",
    "userAgent": "Mozilla/5.0...",
    "method": "jwt"
  }
}
```

## Monitoring

### Prometheus Metrics

Available at `/metrics` endpoint:

- `http_request_duration_ms` - Request timing
- `http_requests_total` - Request count
- `nodejs_memory_usage_bytes` - Memory usage
- `database_query_duration_ms` - Database performance
- `service_call_duration_ms` - Service call timing

### Dashboard

Access the logging dashboard at `/dashboard`:

- Real-time system metrics
- Performance trends
- Security alerts
- Log file status
- Service health monitoring

### Alerts

Configurable alerts for:

- High error rates
- Performance degradation
- Security threats
- Memory/CPU usage
- Service failures

## API Endpoints

### Dashboard API

```
GET /api/logging/dashboard    # Complete dashboard data
GET /api/logging/metrics      # Performance metrics
GET /api/logging/alerts       # Recent alerts
GET /api/logging/analysis     # Log analysis report
GET /api/logging/health       # System health status
GET /api/logging/config       # Configuration info
```

### Prometheus Integration

```
GET /metrics                  # Prometheus metrics
```

## Security Considerations

### Data Protection

- PII fields automatically masked
- Sensitive data redaction
- Compliance logging
- Audit trail integrity

### Access Control

- Dashboard authentication (if enabled)
- API endpoint protection
- Log file permissions
- Metric endpoint security

### Threat Detection

- SQL injection patterns
- XSS attempt detection
- Brute force monitoring
- Anomalous behavior tracking

## Performance

### Benchmarks

- 36,000+ logs/second capability
- Minimal memory overhead
- Async operation support
- Non-blocking I/O

### Optimization

- Log rotation and compression
- Configurable log levels
- Selective field logging
- Efficient JSON serialization

## Troubleshooting

### Common Issues

1. **Log files not created**

   - Check directory permissions
   - Verify LOG_LEVEL setting
   - Ensure sufficient disk space

2. **Performance impact**

   - Adjust log levels for production
   - Configure log rotation
   - Monitor memory usage

3. **Missing correlation IDs**
   - Ensure middleware is properly applied
   - Check AsyncLocalStorage setup
   - Verify header propagation

### Validation

Run the validation script to test the infrastructure:

```bash
node scripts/simple-logging-validation.js
```

### Health Checks

Monitor logging infrastructure health:

```bash
curl http://localhost:4000/api/logging/health
```

## Best Practices

### Development

- Use appropriate log levels
- Include correlation IDs
- Provide meaningful messages
- Add relevant metadata

### Production

- Monitor log file sizes
- Set up log rotation
- Configure alerting
- Regular health checks

### Security

- Mask sensitive data
- Monitor for threats
- Audit admin actions
- Track compliance events

## Future Enhancements

### Planned Features

- ElasticSearch integration
- Advanced ML-based anomaly detection
- Custom alert configurations
- Extended compliance reporting
- Multi-tenant logging support

### Extensibility

- Plugin architecture for custom loggers
- Configurable data retention policies
- External system integrations
- Custom metric definitions

---

This comprehensive logging infrastructure provides enterprise-grade logging capabilities for the
WRFCoin blockchain platform, ensuring proper monitoring, security, and compliance for all system
operations.
