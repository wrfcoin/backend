# Wrfcoin Microservices Architecture

This directory contains the microservices implementation for Wrfcoin, replacing the monolithic
`main_api_server.ts`.

## Architecture Overview

### Services

1. **API Gateway** (Port 4000)

   - Entry point for all API requests
   - Routes requests to appropriate microservices
   - Handles service discovery and health monitoring
   - Provides unified error handling

2. **NFT Marketplace Service** (Port 4002)

   - Handles NFT marketplace data
   - Individual NFT details and metadata
   - Collection information and statistics
   - Routes: `/api/nft/*`

3. **User Management Service** (Port 4003)

   - Wallet balance and transaction history
   - User account management
   - Transaction creation and management
   - Routes: `/api/wallet/*`

4. **Main API Server** (Port 4001) - Legacy
   - Handles remaining endpoints not yet migrated
   - Governance, mining, bridges, weather, network endpoints
   - Will be gradually decomposed into additional microservices

## Service Communication

```
Client Request → API Gateway → Microservice
                    ↓
              Service Discovery
                    ↓
              Health Monitoring
```

## Development Setup

### Prerequisites

- Node.js 18+
- TypeScript
- Docker (optional)

### Running Services Locally

1. **Install dependencies for each service:**

```bash
cd nft-marketplace-service && npm install
cd ../user-management-service && npm install
cd ../api-gateway && npm install
```

2. **Start services in development mode:**

```bash
# Terminal 1: NFT Service
cd nft-marketplace-service && npm run dev

# Terminal 2: User Service
cd user-management-service && npm run dev

# Terminal 3: API Gateway
cd api-gateway && npm run dev

# Terminal 4: Main API Server (legacy)
cd ../../server && npm run dev # or ts-node main_api_server.ts
```

### Using Docker Compose

```bash
# Build and start all services
docker-compose up --build

# Start in background
docker-compose up -d

# Stop services
docker-compose down
```

## Environment Variables

### API Gateway

- `API_GATEWAY_PORT`: Gateway port (default: 4000)
- `NFT_SERVICE_URL`: NFT service URL (default: http://localhost:4002)
- `USER_SERVICE_URL`: User service URL (default: http://localhost:4003)
- `MAIN_SERVICE_URL`: Main API server URL (default: http://localhost:4001)
- `CORS_ORIGIN`: Comma-separated CORS allowed origins
- `ALLOWED_ORIGINS`: Deprecated fallback for `CORS_ORIGIN`

### NFT Marketplace Service

- `NFT_SERVICE_PORT`: Service port (default: 4002)
- `CORS_ORIGIN`: Comma-separated CORS allowed origins
- `ALLOWED_ORIGINS`: Deprecated fallback for `CORS_ORIGIN`

### User Management Service

- `USER_SERVICE_PORT`: Service port (default: 4003)
- `CORS_ORIGIN`: Comma-separated CORS allowed origins
- `ALLOWED_ORIGINS`: Deprecated fallback for `CORS_ORIGIN`

## API Endpoints

### Through API Gateway (Port 4000)

#### NFT Endpoints

- `GET /api/nft/marketplace` - Get marketplace overview
- `GET /api/nft/:tokenId` - Get specific NFT details
- `GET /api/nft/collection/:collectionId` - Get collection details

#### Wallet Endpoints

- `GET /api/wallet/:address` - Get wallet balance
- `GET /api/wallet/:address/transactions` - Get transaction history
- `POST /api/wallet/send` - Create transaction

#### Legacy Endpoints (Proxied to Main Server)

- `GET /api/governance/proposals` - Governance proposals
- `POST /api/governance/vote` - Submit vote
- `GET /api/mining/stats` - Mining statistics
- `GET /api/mining/pools` - Mining pools
- `GET /api/bridges` - Cross-chain bridges
- `POST /api/bridges/transfer` - Cross-chain transfer
- `POST /api/weather/submit` - Weather data submission
- `GET /api/network/info` - Network information
- `GET /api/validators` - Validator information
- `GET /api/transactions` - Transaction history
- `GET /api/stats` - Dashboard statistics

### Health Checks

- `GET /health` - Available on all services (4000, 4002, 4003)

## Migration Strategy

This implementation follows a **Strangler Fig Pattern**:

1. ✅ **Phase 1**: Create new microservices for NFT and user management
2. ✅ **Phase 2**: Deploy API Gateway with routing to new services
3. **Phase 3**: Gradually migrate remaining endpoints from main server
4. **Phase 4**: Decompose main server into additional microservices

### Benefits

- **Separation of Concerns**: Each service has a single responsibility
- **Independent Scaling**: Scale services based on demand
- **Technology Flexibility**: Use different technologies per service
- **Fault Isolation**: Service failures don't affect others
- **Development Velocity**: Teams can work independently

### Next Steps

1. ✅ **Database Separation**: NFT service now uses MongoDB with proper data models
2. **Service Authentication**: Add JWT validation and inter-service authentication
3. **Monitoring & Logging**: Implement distributed tracing and centralized logging
4. **Rate Limiting**: Add API rate limiting and security headers
5. **Additional Services**: Create governance, mining, and bridge services
6. **Load Balancing**: Add load balancers for high availability

## Testing

### Unit Tests

```bash
# Test individual services
cd nft-marketplace-service && npm test
cd user-management-service && npm test
cd api-gateway && npm test
```

### Integration Tests

```bash
# Prerequisites: All services must be running
# Terminal 1: Start NFT Service
cd nft-marketplace-service && npm run dev

# Terminal 2: Start User Service
cd user-management-service && npm run dev

# Terminal 3: Start API Gateway
cd api-gateway && npm run dev

# Terminal 4: Run Integration Tests
cd backend/microservices
node integration-test.js

# Or run with npm (if script is added to package.json)
npm run test:integration
```

### What Integration Tests Cover

- ✅ Health checks for all services
- ✅ API Gateway routing to microservices
- ✅ NFT marketplace data through gateway
- ✅ Wallet operations through gateway
- ✅ Service discovery functionality
- ✅ Error handling and 404 responses
- ✅ Database connectivity (when MongoDB is running)

## Monitoring

Each service exposes:

- Health check endpoint (`/health`)
- Structured logging
- Error tracking
- Performance metrics (to be implemented)

## Security

- CORS protection
- Helmet.js security headers
- Input validation
- Rate limiting (to be implemented)
- API authentication (to be implemented)
