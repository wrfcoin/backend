#!/bin/bash

# Wrfcoin Microservices Development Stop Script

echo "🛑 Stopping Wrfcoin Microservices..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Read PIDs if available
if [ -f ".dev-pids" ]; then
    read NFT_PID USER_PID GATEWAY_PID < .dev-pids
    
    echo "Stopping services..."
    
    # Stop each process
    if [ ! -z "$NFT_PID" ] && kill -0 $NFT_PID 2>/dev/null; then
        echo -e "${YELLOW}Stopping NFT Marketplace Service (PID: $NFT_PID)...${NC}"
        kill $NFT_PID
    fi
    
    if [ ! -z "$USER_PID" ] && kill -0 $USER_PID 2>/dev/null; then
        echo -e "${YELLOW}Stopping User Management Service (PID: $USER_PID)...${NC}"
        kill $USER_PID
    fi
    
    if [ ! -z "$GATEWAY_PID" ] && kill -0 $GATEWAY_PID 2>/dev/null; then
        echo -e "${YELLOW}Stopping API Gateway (PID: $GATEWAY_PID)...${NC}"
        kill $GATEWAY_PID
    fi
    
    # Wait for graceful shutdown
    sleep 2
    
    # Force kill if still running
    if [ ! -z "$NFT_PID" ] && kill -0 $NFT_PID 2>/dev/null; then
        echo -e "${RED}Force stopping NFT service...${NC}"
        kill -9 $NFT_PID
    fi
    
    if [ ! -z "$USER_PID" ] && kill -0 $USER_PID 2>/dev/null; then
        echo -e "${RED}Force stopping User service...${NC}"
        kill -9 $USER_PID
    fi
    
    if [ ! -z "$GATEWAY_PID" ] && kill -0 $GATEWAY_PID 2>/dev/null; then
        echo -e "${RED}Force stopping Gateway...${NC}"
        kill -9 $GATEWAY_PID
    fi
    
    # Clean up PID file
    rm -f .dev-pids
    
else
    echo -e "${YELLOW}No PID file found, attempting to kill by port...${NC}"
    
    # Kill processes by port
    lsof -ti:4000 | xargs kill 2>/dev/null || true
    lsof -ti:4002 | xargs kill 2>/dev/null || true
    lsof -ti:4003 | xargs kill 2>/dev/null || true
fi

echo -e "${GREEN}✓ All services stopped${NC}"