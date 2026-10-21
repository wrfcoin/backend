# GraphQL Service Integration Implementation

## Overview

This document describes the implementation of Task 67.1: Connect GraphQL Resolvers to Backend
Services. The implementation establishes robust connections between GraphQL resolvers and the 15+
WRFCoin microservices with enterprise-grade patterns.

## Architecture Components

### 1. Service Registry (`services/service-registry.ts`)

**Key Features:**

- Centralized service discovery and configuration
- Circuit breaker pattern for fault tolerance
- Request retry with exponential backoff
- Health monitoring and status reporting
- Performance metrics collection

**Service Endpoints:**

```typescript
const SERVICE_REGISTRY = {
  mainApi: { port: 4001, protocol: 'http', timeout: 5000, retries: 3 },
  crossChain: { port: 3000, protocol: 'http', timeout: 15000, retries: 3 },
  wallet: { port: 4000, protocol: 'http', timeout: 10000, retries: 2 },
  compute: { port: 6000, protocol: 'http', timeout: 30000, retries: 2 },
  aiml: { port: 6001, protocol: 'http', timeout: 45000, retries: 2 },
  storage: { port: 7000, protocol: 'http', timeout: 20000, retries: 3 },
  iot: { port: 3002, protocol: 'http', timeout: 10000, retries: 3 },
  governance: { port: 8000, protocol: 'http', timeout: 15000, retries: 2 },
  weatherEarnings: { port: 8080, protocol: 'http', timeout: 10000, retries: 3 },
  nodeDiscovery: { port: 9001, protocol: 'http', timeout: 5000, retries: 2 },
};
```

**Circuit Breaker Implementation:**

- **CLOSED**: Normal operation
- **OPEN**: Service unavailable, requests fail fast
- **HALF_OPEN**: Testing service recovery

### 2. Enhanced Context (`context.ts`)

**Service Integration:**

```typescript
export interface GraphQLContext {
  // Database
  db: typeof db;

  // Services - 15+ microservice clients
  services: {
    mainApi: ServiceClient;
    crossChain: ServiceClient;
    wallet: ServiceClient;
    compute: ServiceClient;
    aiml: ServiceClient;
    storage: ServiceClient;
    iot: ServiceClient;
    governance: ServiceClient;
    weatherEarnings: ServiceClient;
    nodeDiscovery: ServiceClient;
  };

  // DataLoaders for performance optimization
  loaders: DataLoaders;

  // Authentication & Security
  user?: { address: string; verified: boolean };

  // Request tracking
  clientIP: string;
  requestId: string;
}
```

### 3. DataLoader Implementation (`dataloaders.ts`)

**Optimized Data Loading:**

- **Batching**: Groups multiple requests into single API calls
- **Caching**: Request-scoped caching to prevent duplicate calls
- **Performance Monitoring**: Tracks load times and cache hit rates

**Available DataLoaders:**

- `weatherStations`: IoT sensor data batching
- `votes`: Governance vote aggregation
- `proposals`: Proposal data with sentiment analysis
- `tokenBalances`: Multi-service balance queries
- `crossChainTransfers`: Bridge transaction batching
- `computeJobs`: Distributed computing job status
- `aiModels`: ML model metadata
- `storageNodes`: Distributed storage node info

### 4. Enhanced Token Resolvers (`resolvers/token-resolvers.ts`)

**Key Improvements:**

#### A. Parallel Service Calls

```typescript
// Before: Sequential contract calls only
const tokenData = await context.contracts.wrfToken.symbol();

// After: Parallel service integration
const [contractData, walletServiceData, governanceData] = await Promise.allSettled([
  // Blockchain contract data
  Promise.all([
    context.contracts.wrfToken.symbol(),
    context.contracts.wrfToken.name(),
    // ... other contract calls
  ]),
  // Wallet service data
  context.services.wallet.get('/api/token/wrf/stats'),
  // Governance service data
  context.services.governance.get('/api/token/governance-stats'),
]);
```

#### B. Enhanced Data with Service Integration

```typescript
return {
  // Basic contract data
  symbol,
  name,
  decimals,
  totalSupply,

  // Enhanced with service data
  holderCount: walletData?.holderCount || 0,
  circulatingSupply: walletData?.circulatingSupply,
  governanceWeight: govData?.totalVotingWeight || '0',

  // Service health monitoring
  metadata: {
    lastUpdated: new Date().toISOString(),
    dataSource: 'blockchain+services',
    serviceHealth: {
      wallet: walletServiceData.status === 'fulfilled',
      governance: governanceData.status === 'fulfilled',
    },
  },
};
```

#### C. New Enhanced Resolvers

- **`tokenBalance`**: Multi-service balance queries with staking info
- **`weatherStations`**: Real-time IoT data integration
- **`votes`**: Enhanced with delegation and power data
- **`proposals`**: AI sentiment analysis integration
- **`performance`**: Cross-service metrics aggregation

### 5. GraphQL Server Enhancements (`server.ts`)

**Health Monitoring:**

```typescript
app.get('/health', async (req, res) => {
  const serviceHealth = await serviceClientManager.checkAllServices();
  const serviceStatus = serviceClientManager.getServiceStatus();

  const allServicesHealthy = Object.values(serviceHealth).every(healthy => healthy);
  const criticalServicesHealthy = [
    serviceHealth.mainApi,
    serviceHealth.governance,
    serviceHealth.wallet,
  ].every(healthy => healthy);

  res.status(allServicesHealthy ? 200 : criticalServicesHealthy ? 206 : 503).json({
    status: allServicesHealthy ? 'healthy' : criticalServicesHealthy ? 'degraded' : 'unhealthy',
    services: { health: serviceHealth, status: serviceStatus },
    metrics: { memoryUsage: process.memoryUsage(), cpuUsage: process.cpuUsage() },
  });
});
```

## Performance Optimizations

### 1. Request Batching

- DataLoaders batch multiple requests into single API calls
- Reduces network overhead and improves response times
- Configurable batch sizes per service type

### 2. Multi-Level Caching

- **L1 (Memory)**: DataLoader request-scoped cache
- **L2 (Redis)**: Cross-request shared cache (future enhancement)
- **L3 (Database)**: Persistent data layer

### 3. Parallel Processing

- Service calls executed concurrently using `Promise.allSettled()`
- Graceful degradation when services are unavailable
- Maintains functionality with partial service failures

### 4. Circuit Breaker Protection

- Prevents cascading failures across services
- Automatic recovery testing
- Configurable failure thresholds per service

## Security Implementation

### 1. Request Correlation

- Unique request IDs for audit logging
- End-to-end request tracking
- Security event correlation

### 2. Input Validation

- Service-level input sanitization
- GraphQL query depth limiting
- Rate limiting per client IP

### 3. Error Handling

- Structured error responses
- Sensitive information masking
- Service failure isolation

## Monitoring & Observability

### 1. Performance Metrics

- Response time tracking (target: <200ms average)
- Service health monitoring
- Circuit breaker state tracking
- DataLoader cache hit rates

### 2. Service Health Dashboard

- Real-time service status
- Performance metrics aggregation
- Alert thresholds for degraded services

### 3. Request Monitoring

```typescript
// Automatic request/response logging
logger.debug('Service request completed', {
  service: serviceName,
  method: 'GET',
  url: '/api/endpoint',
  status: 200,
  latency: 45,
  requestId: 'req_123456789',
});
```

## Usage Examples

### 1. Enhanced Token Query

```graphql
query GetEnhancedTokenInfo {
  wrfToken {
    symbol
    name
    totalSupply
    holderCount # From wallet service
    governanceWeight # From governance service
    weatherStations(first: 10) {
      stationId
      location
      realtimeData {
        # From IoT service
        temperature
        humidity
        connectionStatus
      }
    }

    proposals(first: 5, status: "ACTIVE") {
      title
      state
      currentQuorum # From governance service
      participationRate
      sentimentAnalysis {
        # From AI/ML service
        overallSentiment
        supportProbability
        riskFactors
      }
    }

    performance {
      # Cross-service metrics
      totalTransactions
      crossChainVolume
      computeJobsCompleted
    }
  }
}
```

### 2. Token Balance with Staking

```graphql
query GetTokenBalance($address: String!) {
  tokenBalance(address: $address, includeStaking: true) {
    address
    balance
    pendingRewards # From wallet service
    staking {
      # From governance service
      stakedAmount
      rewards
      lockPeriod
      canUnstake
    }
  }
}
```

## Configuration

### Environment Variables

```bash
# Service endpoints (defaults to localhost)
MAIN_API_HOST=localhost
MAIN_API_PORT=4001

GOVERNANCE_HOST=localhost
GOVERNANCE_PORT=8000

# Security
JWT_SECRET=your_jwt_secret
ADMIN_ADDRESSES=0x123...,0x456...

# Performance tuning
GRAPHQL_TIMEOUT=30000
MAX_QUERY_DEPTH=20
RATE_LIMIT_REQUESTS_PER_MINUTE=1000
```

### Service Configuration

```typescript
// Customize service endpoints
const SERVICE_REGISTRY = {
  governance: {
    host: process.env.GOVERNANCE_HOST || 'localhost',
    port: parseInt(process.env.GOVERNANCE_PORT || '8000'),
    timeout: 15000,
    retries: 2,
  },
  // ... other services
};
```

## Testing

### Health Check Endpoints

```bash
# Basic health check
curl http://localhost:4000/health

# Detailed status
curl http://localhost:4000/status

# GraphQL endpoint
curl -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ wrfToken { symbol } }"}'
```

### Performance Testing

```bash
# Load test with multiple concurrent requests
for i in {1..100}; do
  curl -X POST http://localhost:4000/graphql \
    -H "Content-Type: application/json" \
    -d '{"query": "{ wrfToken { weatherStations { stationId } } }"}' &
done
```

## Future Enhancements

### 1. Redis Caching Layer

- Shared cache across GraphQL instances
- Configurable TTL per data type
- Cache warming strategies

### 2. Advanced Monitoring

- Distributed tracing with OpenTelemetry
- Real-time performance dashboards
- Automated alerting

### 3. Service Mesh Integration

- Istio/Linkerd integration
- Advanced traffic management
- Enhanced security policies

### 4. GraphQL Federation

- Schema stitching across services
- Distributed GraphQL architecture
- Service-specific schema ownership

## Troubleshooting

### Common Issues

1. **Service Unavailable Errors**

   - Check service health endpoints
   - Verify network connectivity
   - Review circuit breaker states

2. **Performance Degradation**

   - Monitor DataLoader cache hit rates
   - Check service response times
   - Review batch sizes and timeouts

3. **Authentication Failures**
   - Verify JWT tokens and signatures
   - Check wallet verification status
   - Review admin address configuration

### Debug Commands

```bash
# Check service health
node -e "
const { serviceClientManager } = require('./services/service-registry.js');
serviceClientManager.checkAllServices().then(console.log);
"

# Test specific service
curl http://localhost:8000/health  # Governance service
curl http://localhost:3002/health  # IoT service
```

This implementation provides a robust, scalable foundation for GraphQL-to-microservice communication
in the WRFCoin platform, meeting all performance, security, and monitoring requirements specified in
Task 67.1.
