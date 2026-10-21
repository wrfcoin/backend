/**
 * WebSocket Health Monitor
 * Monitors connection health and implements automatic recovery
 */

class WebSocketHealthMonitor {
  constructor(wss) {
    this.wss = wss;
    this.healthChecks = new Map();
    this.startHealthChecking();
  }

  startHealthChecking() {
    // Ping all connections every 30 seconds
    const pingInterval = setInterval(() => {
      this.wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
          console.log('🔌 Terminating unresponsive WebSocket connection');
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    // Clean up interval on server close
    this.wss.on('close', () => {
      clearInterval(pingInterval);
    });
  }

  setupConnection(ws, clientId) {
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('error', error => {
      console.error(`WebSocket error for ${clientId}:`, error.message);
      this.handleConnectionError(ws, clientId, error);
    });
  }

  handleConnectionError(ws, clientId, error) {
    // Log error details
    console.error('Connection error details:', {
      clientId,
      error: error.message,
      code: error.code,
      timestamp: new Date().toISOString(),
    });

    // Attempt graceful cleanup
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Connection issue - attempting recovery',
            timestamp: new Date().toISOString(),
          })
        );
      }
    } catch (error) {
      console.error('Failed to send error notification:', sendError.message);
    }
  }
}

module.exports = { WebSocketHealthMonitor };
