#!/bin/bash

# Wrfcoin Microservices Development Startup Script

echo "🚀 Starting Wrfcoin Microservices..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to check if port is available
check_port() {
    if lsof -Pi :$1 -sTCP:LISTEN -t >/dev/null ; then
        echo -e "${RED}Port $1 is already in use${NC}"
        return 1
    else
        echo -e "${GREEN}Port $1 is available${NC}"
        return 0
    fi
}

# Check required ports
echo "Checking port availability..."
check_port 4000 || exit 1
check_port 4002 || exit 1  
check_port 4003 || exit 1

# Install dependencies if node_modules don't exist
install_deps() {
    local service=$1
    if [ ! -d "$service/node_modules" ]; then
        echo -e "${YELLOW}Installing dependencies for $service...${NC}"
        cd $service && npm install && cd ..
    else
        echo -e "${GREEN}Dependencies already installed for $service${NC}"
    fi
}

echo "Installing dependencies..."
install_deps "nft-marketplace-service"
install_deps "user-management-service"
install_deps "api-gateway"

# Create log directory
mkdir -p logs

echo "Starting services..."

# Start NFT Marketplace Service
echo -e "${BLUE}Starting NFT Marketplace Service on port 4002...${NC}"
cd nft-marketplace-service
npm run dev > ../logs/nft-service.log 2>&1 &
NFT_PID=$!
cd ..

# Wait a moment for service to start
sleep 2

# Start User Management Service
echo -e "${BLUE}Starting User Management Service on port 4003...${NC}"
cd user-management-service
npm run dev > ../logs/user-service.log 2>&1 &
USER_PID=$!
cd ..

# Wait a moment for service to start
sleep 2

# Start API Gateway
echo -e "${BLUE}Starting API Gateway on port 4000...${NC}"
cd api-gateway
npm run dev > ../logs/gateway.log 2>&1 &
GATEWAY_PID=$!
cd ..

# Wait for services to start
sleep 5

# Health checks
echo "Performing health checks..."

check_health() {
    local url=$1
    local service=$2
    
    if curl -s $url > /dev/null; then
        echo -e "${GREEN}✓ $service is healthy${NC}"
        return 0
    else
        echo -e "${RED}✗ $service is not responding${NC}"
        return 1
    fi
}

check_health "http://localhost:4002/health" "NFT Marketplace Service"
check_health "http://localhost:4003/health" "User Management Service"  
check_health "http://localhost:4000/health" "API Gateway"

echo ""
echo -e "${GREEN}🎉 Microservices are running!${NC}"
echo ""
echo "Services:"
echo "  🎨 NFT Marketplace Service: http://localhost:4002"
echo "  👤 User Management Service: http://localhost:4003"
echo "  🚪 API Gateway: http://localhost:4000"
echo ""
echo "API Endpoints through Gateway:"
echo "  GET  http://localhost:4000/api/nft/marketplace"
echo "  GET  http://localhost:4000/api/nft/123"
echo "  GET  http://localhost:4000/api/wallet/0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234"
echo ""
echo "Logs are available in:"
echo "  - logs/nft-service.log"
echo "  - logs/user-service.log"
echo "  - logs/gateway.log"
echo ""
echo "To stop services, run: ./stop-dev.sh"
echo "Process IDs: NFT=$NFT_PID, User=$USER_PID, Gateway=$GATEWAY_PID"

# Save PIDs for stopping later
echo "$NFT_PID $USER_PID $GATEWAY_PID" > .dev-pids