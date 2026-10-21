# OpenForis API Monitoring and Logging Implementation

## Overview

The OpenForis API integration includes a comprehensive monitoring and logging system designed for
production-grade observability, performance tracking, and operational alerting.

## Architecture Components

### 1. Structured Logging System (`utils/logger.ts`)

**Features:**

- Winston-based logging with structured JSON output
- Multiple specialized loggers (app, openforis, performance, security)
- Custom log formatting for OpenForis operations
- File rotation and multiple transport support
- Environment-based log levels

**Log Categories:**

- **OpenForis Operations**: API calls, response times, success/failure tracking
- **Performance Metrics**: Memory usage, CPU utilization, response times
- **Security Events**: Authentication failures, suspicious activity
- **Error Tracking**: Detailed error information with stack traces

**Usage Example:**

```typescript
import { logOpenforisOperation, logPerformanceMetrics } from '../utils/logger';

// Log successful operation
logOpenforisOperation('project_creation', {
  success: true,
  duration: 1250,
  projectId: 'proj_123',
  dataSize: 2048,
});

// Log performance metrics
logPerformanceMetrics('database_query', 850, process.memoryUsage(), {
  queryType: 'project_fetch',
  recordCount: 150,
});
```

### 2. Monitoring Middleware (`middleware/openforis-monitoring.ts`)

**Capabilities:**

- Real-time request tracking with unique IDs
- Performance metrics collection (response time, memory usage)
- Alert threshold monitoring
- Health scoring algorithm
- Concurrent request tracking

**Key Metrics Tracked:**

- Request count and error rates
- Average and peak response times
- Memory usage patterns
- Active concurrent requests
- API endpoint usage patterns

**Alert Thresholds:**

- Response time > 5s (warning), > 10s (critical)
- Error rate > 5% (warning), > 10% (critical)
- Memory usage > 512MB (warning), > 1GB (critical)
- Concurrent requests > 50 (warning), > 100 (critical)

### 3. Prometheus Integration (`middleware/prometheus-metrics.ts`)

**Metrics Exported:**

- HTTP request counters with labels (method, endpoint, status)
- Response time histograms with configurable buckets
- Memory usage gauges (heap, RSS, external)
- OpenForis-specific business metrics
- Error rate tracking
- Health score monitoring

**Custom Metrics:**

```typescript
// Project operations
wrfcoin_openforis_projects_total{status="active",type="forest_monitoring"}
wrfcoin_openforis_project_operations_total{operation="create",status="success"}

// Survey processing
wrfcoin_openforis_surveys_total{project_id="proj_123",status="success"}
wrfcoin_openforis_survey_processing_duration_seconds{project_id="proj_123"}

// Analysis execution
wrfcoin_openforis_analyses_total{analysis_type="time_series",status="success"}
wrfcoin_openforis_analysis_processing_duration_seconds{analysis_type="time_series"}

// Data quality
wrfcoin_openforis_data_quality_score{project_id="proj_123",data_type="survey"}

// Blockchain integration
wrfcoin_openforis_blockchain_exports_total{data_type="project",status="success"}
```

### 4. Alerting System (`utils/openforis-alerting.ts`)

**Alert Categories:**

- **Performance**: High response times, slow operations
- **Availability**: High concurrent requests, service degradation
- **Errors**: High error rates, repeated failures
- **Security**: Suspicious activity patterns, authentication issues
- **Resource**: Memory leaks, CPU spikes
- **Data Quality**: Degraded data integrity
- **Integration**: External service failures

**Notification Channels:**

- **Slack**: Real-time team notifications
- **Email**: Management and on-call alerts
- **Webhook**: Custom integrations and automation
- **PagerDuty**: Critical incident management
- **SMS**: Emergency escalation (when configured)

**Escalation Rules:**

```typescript
{
  level: 1,
  afterMinutes: 15,
  severity: 'critical',
  notificationChannels: ['slack', 'email']
}
```

### 5. Health Check Endpoints (`routes/openforis-health.ts`)

**Available Endpoints:**

| Endpoint                                | Purpose                      | Response Format              |
| --------------------------------------- | ---------------------------- | ---------------------------- |
| `GET /api/openforis/health`             | Comprehensive health status  | JSON with health score       |
| `GET /api/openforis/health/ping`        | Simple up/down check         | Basic status response        |
| `GET /api/openforis/health/metrics`     | Detailed operational metrics | Structured metrics data      |
| `GET /api/openforis/health/prometheus`  | Prometheus format metrics    | Text-based metrics           |
| `GET /api/openforis/health/performance` | Performance analytics        | Performance trends           |
| `GET /api/openforis/health/alerts`      | Current alert status         | Active alerts and thresholds |
| `GET /api/openforis/health/info`        | System information           | Service and system details   |
| `GET /api/openforis/health/live`        | Real-time monitoring         | Server-sent events stream    |
| `POST /api/openforis/health/reset`      | Reset metrics (admin)        | Confirmation response        |

## Configuration

### Environment Variables

```bash
# Logging Configuration
LOG_LEVEL=info                    # debug, info, warn, error
NODE_ENV=production              # development, staging, production

# Alert Notification Channels
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
ALERT_EMAIL=admin@wrfcoin.com
ALERT_WEBHOOK_URL=https://monitoring.wrfcoin.com/webhook
ALERT_WEBHOOK_TOKEN=your-webhook-token
PAGERDUTY_INTEGRATION_KEY=your-pagerduty-key

# Monitoring Thresholds (optional overrides)
MAX_RESPONSE_TIME=5000           # milliseconds
MAX_ERROR_RATE=0.1              # percentage (0.1 = 10%)
MAX_MEMORY_USAGE=536870912      # bytes (512MB)
MAX_ACTIVE_REQUESTS=100         # concurrent requests
```

### Integration with Main Application

The monitoring system is automatically integrated through middleware in the OpenForis routes:

```typescript
import { openforisMonitoringMiddleware } from '../middleware/openforis-monitoring';
import { prometheusMiddleware } from '../middleware/prometheus-metrics';

// Apply to all OpenForis routes
router.use(openforisMonitoringMiddleware);
router.use(prometheusMiddleware);
```

## Production Deployment

### Docker Integration

The monitoring system works seamlessly with the existing Docker infrastructure:

```yaml
# docker-compose.monitoring.yml integration
services:
  prometheus:
    image: prom/prometheus
    ports:
      - '9090:9090'
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana
    ports:
      - '3000:3000'
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
```

### Prometheus Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'openforis-api'
    static_configs:
      - targets: ['api:4001']
    metrics_path: '/api/openforis/health/prometheus'
    scrape_interval: 15s
```

### Grafana Dashboards

Key dashboards to create:

1. **OpenForis API Overview**: Request rates, response times, error rates
2. **System Performance**: Memory usage, CPU utilization, uptime
3. **Business Metrics**: Projects created, surveys processed, analyses completed
4. **Alert Status**: Active alerts, escalations, resolution times

## Operational Procedures

### Daily Monitoring Checklist

1. Review health dashboard: `GET /api/openforis/health`
2. Check alert status: `GET /api/openforis/health/alerts`
3. Monitor performance trends: `GET /api/openforis/health/performance`
4. Verify log rotation and storage

### Troubleshooting Guide

**High Response Times:**

1. Check `GET /api/openforis/health/performance` for bottlenecks
2. Review memory usage patterns
3. Analyze request patterns in logs
4. Consider scaling horizontally

**High Error Rates:**

1. Check recent error logs: `tail -f logs/error.log`
2. Review authentication/authorization patterns
3. Verify external service dependencies
4. Check rate limiting configurations

**Memory Issues:**

1. Monitor heap usage: `GET /api/openforis/health/metrics`
2. Check for memory leaks in performance logs
3. Review concurrent request patterns
4. Consider process restart if critical

### Log Analysis

**Finding Performance Issues:**

```bash
# High response time requests
grep "responseTime.*[5-9][0-9][0-9][0-9]" logs/openforis.log

# Memory usage patterns
grep "memoryUsage" logs/performance.log | tail -100

# Error patterns
grep "ERROR" logs/error.log | grep "openforis"
```

**Security Event Monitoring:**

```bash
# Authentication failures
grep "INVALID_OPENFORIS" logs/openforis.log

# Suspicious activity
grep "security" logs/combined.log | tail -50
```

## Testing and Validation

### Health Check Testing

```bash
# Basic health verification
curl http://localhost:4001/api/openforis/health

# Prometheus metrics export
curl http://localhost:4001/api/openforis/health/prometheus

# Real-time monitoring
curl -N http://localhost:4001/api/openforis/health/live
```

### Load Testing

```bash
# Install artillery for load testing
npm install -g artillery

# Run load test
artillery run openforis-load-test.yml
```

### Alert Testing

```bash
# Test alert conditions (development only)
curl -X POST http://localhost:4001/api/openforis/health/reset \
  -H "Authorization: Bearer test-token"
```

## Best Practices

### Logging Best Practices

1. **Use Structured logging**: Always include context metadata
2. **Appropriate Log Levels**: Use DEBUG for development, INFO for operations
3. **Avoid Sensitive Data**: Never log API keys, tokens, or personal data
4. **Performance Impact**: Be mindful of logging overhead in high-traffic scenarios

### Monitoring Best Practices

1. **Set Realistic Thresholds**: Base on actual usage patterns
2. **Monitor Trends**: Look for patterns over time, not just current values
3. **Alert Fatigue**: Avoid too many low-priority alerts
4. **Escalation Procedures**: Ensure critical alerts reach the right people

### Performance Best Practices

1. **Efficient Logging**: Use appropriate log levels and structured data
2. **Metric Collection**: Balance detail with performance impact
3. **Memory Management**: Monitor for leaks and optimize regularly
4. **Cache Wisely**: Use monitoring data to identify caching opportunities

## Maintenance and Updates

### Regular Maintenance Tasks

1. **Log Rotation**: Ensure logs don't consume excessive disk space
2. **Metric Cleanup**: Archive old metrics and maintain reasonable retention
3. **Alert Tuning**: Review and adjust thresholds based on usage patterns
4. **Dashboard Updates**: Keep Grafana dashboards relevant and accurate

### Monitoring System Health

The monitoring system itself should be monitored:

- Check log file growth and rotation
- Verify alert delivery mechanisms
- Test escalation procedures periodically
- Monitor resource usage of monitoring components

---

This comprehensive monitoring and logging system provides production-grade observability for the
WRFCoin OpenForis integration, ensuring reliable operation and quick issue resolution in the weather
forecasting blockchain platform.
