#!/bin/bash

# WRFCoin Enhanced Unified API with Caching - Startup Script
# This script starts Redis and the optimized API server

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
REDIS_PORT=6379
API_PORT=3001
# Dynamically determine project root from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REDIS_CONFIG="$PROJECT_ROOT/backend/server/config/redis.conf"
REDIS_PASSWORD="wrfcoin_cache_2024"

echo -e "${GREEN}🚀 Starting WRFCoin Enhanced Unified API with Caching${NC}"
echo "=================================================="

# Function to check if port is in use
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null ; then
        return 0  # Port is in use
    else
        return 1  # Port is free
    fi
}

# Function to stop existing processes
cleanup() {
    echo -e "${YELLOW}🧹 Cleaning up existing processes...${NC}"
    
    # Stop Redis if running
    if check_port $REDIS_PORT; then
        echo "Stopping Redis on port $REDIS_PORT..."
        redis-cli -p $REDIS_PORT -a $REDIS_PASSWORD shutdown save || true
        sleep 2
    fi
    
    # Stop API server if running
    if check_port $API_PORT; then
        echo "Stopping API server on port $API_PORT..."
        pkill -f "enhanced_unified_api_optimized" || true
        sleep 2
    fi
}

# Function to start Redis
start_redis() {
    echo -e "${GREEN}🔧 Starting Redis server...${NC}"
    
    # Check if Redis is installed
    if ! command -v redis-server &> /dev/null; then
        echo -e "${YELLOW}⚠️  Redis not found. Installing Redis...${NC}"
        
        # Install Redis based on OS
        if [[ "$OSTYPE" == "linux-gnu"* ]]; then
            # Ubuntu/Debian
            if command -v apt-get &> /dev/null; then
                sudo apt-get update
                sudo apt-get install -y redis-server
            # CentOS/RHEL
            elif command -v yum &> /dev/null; then
                sudo yum install -y redis
            fi
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            if command -v brew &> /dev/null; then
                brew install redis
            fi
        fi
    fi
    
    # Create log directory
    sudo mkdir -p /var/log/redis
    sudo chown $(whoami) /var/log/redis
    
    # Start Redis with our configuration
    if [ -f "$REDIS_CONFIG" ]; then
        echo "Using custom Redis configuration: $REDIS_CONFIG"
        redis-server "$REDIS_CONFIG" &
    else
        echo "Using default Redis configuration"
        redis-server --port $REDIS_PORT --bind 127.0.0.1 --requirepass $REDIS_PASSWORD &
    fi
    
    # Wait for Redis to start
    echo "Waiting for Redis to start..."
    sleep 3
    
    # Test Redis connection
    if redis-cli -p $REDIS_PORT -a $REDIS_PASSWORD ping | grep -q "PONG"; then
        echo -e "${GREEN}✅ Redis started successfully on port $REDIS_PORT${NC}"
    else
        echo -e "${RED}❌ Failed to start Redis${NC}"
        exit 1
    fi
}

# Function to start the optimized API server
start_api_server() {
    echo -e "${GREEN}🌐 Starting Enhanced Unified API server...${NC}"
    
    cd "$PROJECT_ROOT"
    
    # Set environment variables
    export PORT=$API_PORT
    export REDIS_HOST=127.0.0.1
    export REDIS_PORT=$REDIS_PORT
    export REDIS_PASSWORD=$REDIS_PASSWORD
    export NODE_ENV=production
    
    # Start the optimized API server
    npx tsx backend/server/enhanced_unified_api_optimized.ts &
    API_PID=$!
    
    # Wait for API server to start
    echo "Waiting for API server to start..."
    sleep 5
    
    # Test API server
    if curl -s http://localhost:$API_PORT/api/health >/dev/null; then
        echo -e "${GREEN}✅ API server started successfully on port $API_PORT${NC}"
        echo -e "${GREEN}📊 Performance dashboard: http://localhost:$API_PORT/api/performance/metrics${NC}"
        echo -e "${GREEN}🏥 Health check: http://localhost:$API_PORT/api/health${NC}"
    else
        echo -e "${RED}❌ Failed to start API server${NC}"
        exit 1
    fi
}

# Function to run performance test
run_performance_test() {
    echo -e "${YELLOW}⚡ Running initial performance test...${NC}"
    
    cd "$PROJECT_ROOT"
    
    # Wait a bit more for everything to settle
    sleep 5
    
    # Run a quick performance test
    echo "Testing basic endpoints..."
    npx tsx backend/server/tests/performance-test.ts || true
}

# Function to show status
show_status() {
    echo ""
    echo "=================================================="
    echo -e "${GREEN}🎉 WRFCoin Enhanced API is running!${NC}"
    echo "=================================================="
    echo ""
    echo "Services:"
    echo "  🔧 Redis Cache Server: localhost:$REDIS_PORT"
    echo "  🌐 Enhanced API Server: localhost:$API_PORT"
    echo ""
    echo "Endpoints:"
    echo "  📊 Performance Dashboard: http://localhost:$API_PORT/api/dashboard"
    echo "  📈 Performance Metrics: http://localhost:$API_PORT/api/performance/metrics"
    echo "  🏥 Health Check: http://localhost:$API_PORT/api/health"
    echo "  📈 Main Stats: http://localhost:$API_PORT/api/stats"
    echo "  ⛓️  Blockchain Status: http://localhost:$API_PORT/api/blockchain/status"
    echo "  ⛏️  Mining Stats: http://localhost:$API_PORT/api/mining/stats"
    echo "  🎨 NFT Marketplace: http://localhost:$API_PORT/api/nft/marketplace"
    echo "  🔒 Security Metrics: http://localhost:$API_PORT/api/security/metrics"
    echo ""
    echo "Management:"
    echo "  🧹 Clear Cache: curl -X POST http://localhost:$API_PORT/api/cache/clear"
    echo ""
    echo "To stop all services: pkill -f 'redis-server|enhanced_unified_api_optimized'"
    echo ""
}

# Main execution
main() {
    # Parse command line arguments
    case "${1:-start}" in
        "start")
            cleanup
            start_redis
            start_api_server
            run_performance_test
            show_status
            
            # Keep script running and monitoring
            echo "Monitoring services... (Press Ctrl+C to stop)"
            trap cleanup EXIT
            
            while true; do
                if ! check_port $REDIS_PORT; then
                    echo -e "${RED}❌ Redis died, restarting...${NC}"
                    start_redis
                fi
                
                if ! check_port $API_PORT; then
                    echo -e "${RED}❌ API server died, restarting...${NC}"
                    start_api_server
                fi
                
                sleep 10
            done
            ;;
            
        "stop")
            cleanup
            echo -e "${GREEN}✅ All services stopped${NC}"
            ;;
            
        "status")
            if check_port $REDIS_PORT && check_port $API_PORT; then
                show_status
            else
                echo -e "${RED}❌ Services are not running${NC}"
                echo "Use '$0 start' to start services"
            fi
            ;;
            
        "test")
            if check_port $API_PORT; then
                run_performance_test
            else
                echo -e "${RED}❌ API server is not running${NC}"
                echo "Use '$0 start' to start services first"
            fi
            ;;
            
        *)
            echo "Usage: $0 {start|stop|status|test}"
            echo ""
            echo "Commands:"
            echo "  start  - Start Redis and API server with monitoring"
            echo "  stop   - Stop all services"
            echo "  status - Show status and endpoints"
            echo "  test   - Run performance test"
            exit 1
            ;;
    esac
}

# Run main function
main "$@"