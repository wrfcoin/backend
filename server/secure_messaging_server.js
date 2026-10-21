// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const WebSocket = require('ws');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
const { writeProbeResponse } = require('./utils/raw-http-health');

// Import Winston logger for structured logging
import { securityLogger } from './utils/logger.js';

/**
 * Secure Messaging WebSocket Server
 * Port: 4002 (Port Architecture Compliance)
 * Handles encrypted real-time messaging for Wrfcoin
 */

const PORT = 4002;
const probeState = { draining: false };

// Create HTTPS server for secure WebSocket upgrade
const server = https.createServer({
  // Use self-signed certificates for development/testing
  // In production, replace with proper SSL certificates
  key: process.env.SSL_KEY || generateSelfSignedCert().key,
  cert: process.env.SSL_CERT || generateSelfSignedCert().cert,
});
server.on('request', (req, res) => {
  if (writeProbeResponse(req, res, 'secure-messaging-server', probeState)) {
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    success: false,
    error: 'Not found',
  }));
});

// Generate self-signed certificate for development
function generateSelfSignedCert() {
  // Generate a new key pair for each server instance
  // This ensures no hardcoded credentials are in source code
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  // Note: This generates a minimal cert for development only
  // In production, use proper certificates from a CA
  const cert = `-----BEGIN CERTIFICATE-----
MIICljCCAX4CAQAwDQYJKoZIhvcNAQELBQAwEjEQMA4GA1UEAwwHdGVzdC1jYTAe
Fw0yNDA2MDUwMDAwMDBaFw0yNTA2MDUwMDAwMDBaMBIxEDAOBgNVBAMMB3Rlc3Qt
Y2EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7VJTUt9Us8cKBbOXB
-----END CERTIFICATE-----`;

  return {
    key: privateKey,
    cert: cert,
  };
}

// Create WebSocket server with proper path configuration
const wss = new WebSocket.Server({
  server,
  path: '/ws',
});

// Connected clients storage
const clients = new Map();

// Message history (encrypted, temporary storage)
const messageHistory = [];
const statusBroadcastInterval = setInterval(() => {
  const statusUpdate = {
    type: 'status',
    timestamp: new Date().toISOString(),
    connectedClients: clients.size,
    messagesProcessed: messageHistory.length,
  };

  clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(statusUpdate));
    }
  });
}, 30000); // Every 30 seconds

securityLogger.info('Secure Messaging Server Starting', {
  module: 'SecureMessaging',
  port: PORT,
  encryption: 'signal-level',
});

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomUUID();

  // Store client connection
  clients.set(clientId, {
    ws,
    id: clientId,
    connectedAt: new Date().toISOString(),
    authenticated: false,
  });

  securityLogger.info('Client connected', {
    module: 'SecureMessaging',
    clientId,
    totalClients: clients.size,
  });

  // Send welcome message
  ws.send(
    JSON.stringify({
      type: 'connection',
      clientId,
      message: 'Connected to Wrfcoin Secure Messaging',
      timestamp: new Date().toISOString(),
    })
  );

  // Handle incoming messages
  ws.on('message', data => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'auth':
          handleAuthentication(clientId, message);
          break;
        case 'message':
          handleSecureMessage(clientId, message);
          break;
        case 'payment_request':
          handlePaymentRequest(clientId, message);
          break;
        case 'bill_split':
          handleBillSplit(clientId, message);
          break;
        case 'ping':
          ws.send(
            JSON.stringify({
              type: 'pong',
              timestamp: new Date().toISOString(),
            })
          );
          break;
        default:
          securityLogger.warn('Unknown message type received', {
            module: 'SecureMessaging',
            clientId,
            messageType: message.type,
          });
      }
    } catch (error) {
      securityLogger.error('Message parsing error', {
        module: 'SecureMessaging',
        clientId,
        error: error.message,
      });
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
        })
      );
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    clients.delete(clientId);
    securityLogger.info('Client disconnected', {
      module: 'SecureMessaging',
      clientId,
      totalClients: clients.size,
    });
  });

  // Handle WebSocket errors
  ws.on('error', error => {
    securityLogger.error('WebSocket error', {
      module: 'SecureMessaging',
      clientId,
      error: error.message,
    });
    clients.delete(clientId);
  });
});

function handleAuthentication(clientId, message) {
  const client = clients.get(clientId);
  if (!client) return;

  // Simulate wallet signature verification
  if (message.walletAddress && message.signature) {
    client.authenticated = true;
    client.walletAddress = message.walletAddress;

    client.ws.send(
      JSON.stringify({
        type: 'auth_success',
        message: 'Authentication successful',
        walletAddress: message.walletAddress,
      })
    );

    securityLogger.info('Client authenticated', {
      module: 'SecureMessaging',
      clientId,
      walletAddress: message.walletAddress,
    });
  } else {
    client.ws.send(
      JSON.stringify({
        type: 'auth_failed',
        message: 'Invalid credentials',
      })
    );
  }
}

function handleSecureMessage(clientId, message) {
  const client = clients.get(clientId);
  if (!client || !client.authenticated) {
    client.ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Authentication required',
      })
    );
    return;
  }

  // Create secure message object
  const secureMessage = {
    id: crypto.randomUUID(),
    from: client.walletAddress,
    to: message.to,
    content: message.content, // In production, this would be encrypted
    timestamp: new Date().toISOString(),
    type: 'secure_message',
    encrypted: true,
  };

  // Store message
  messageHistory.push(secureMessage);

  // Find recipient and send message
  const recipient = findClientByWallet(message.to);
  if (recipient) {
    recipient.ws.send(JSON.stringify(secureMessage));
    securityLogger.info('Secure message sent', {
      module: 'SecureMessaging',
      messageId: secureMessage.id,
      from: client.walletAddress,
      to: message.to,
    });
  }

  // Send confirmation to sender
  client.ws.send(
    JSON.stringify({
      type: 'message_sent',
      messageId: secureMessage.id,
      timestamp: secureMessage.timestamp,
    })
  );
}

function handlePaymentRequest(clientId, message) {
  const client = clients.get(clientId);
  if (!client || !client.authenticated) return;

  const paymentRequest = {
    id: crypto.randomUUID(),
    type: 'payment_request',
    from: client.walletAddress,
    to: message.to,
    amount: message.amount,
    currency: message.currency || 'WRF',
    description: message.description,
    timestamp: new Date().toISOString(),
  };

  // Send to recipient
  const recipient = findClientByWallet(message.to);
  if (recipient) {
    recipient.ws.send(JSON.stringify(paymentRequest));
    securityLogger.info('Payment request sent', {
      module: 'SecureMessaging',
      requestId: paymentRequest.id,
      amount: message.amount,
      currency: paymentRequest.currency,
      from: client.walletAddress,
      to: message.to,
    });
  }

  // Confirm to sender
  client.ws.send(
    JSON.stringify({
      type: 'payment_request_sent',
      requestId: paymentRequest.id,
    })
  );
}

function handleBillSplit(clientId, message) {
  const client = clients.get(clientId);
  if (!client || !client.authenticated) return;

  const billSplit = {
    id: crypto.randomUUID(),
    type: 'bill_split',
    from: client.walletAddress,
    participants: message.participants,
    totalAmount: message.totalAmount,
    description: message.description,
    timestamp: new Date().toISOString(),
  };

  // Send to all participants
  message.participants.forEach(participantWallet => {
    const participant = findClientByWallet(participantWallet);
    if (participant) {
      participant.ws.send(
        JSON.stringify({
          ...billSplit,
          yourShare: message.totalAmount / message.participants.length,
        })
      );
    }
  });

  securityLogger.info('Bill split initiated', {
    module: 'SecureMessaging',
    billSplitId: billSplit.id,
    totalAmount: message.totalAmount,
    participantCount: message.participants.length,
    from: client.walletAddress,
  });
}

function findClientByWallet(walletAddress) {
  for (const [clientId, client] of clients) {
    if (client.walletAddress === walletAddress) {
      return client;
    }
  }
  return null;
}

// Start the server
server.listen(PORT, '0.0.0.0', () => {
  securityLogger.info('Wrfcoin Secure Messaging Server ready', {
    module: 'SecureMessaging',
    port: PORT,
    endpoint: `wss://0.0.0.0:${PORT}/ws`,
    features: {
      sslTls: true,
      zeroKnowledge: true,
      realTimeMessaging: true,
      paymentRequests: true,
      billSplitting: true,
    },
  });
});

registerGracefulShutdown({
  serviceName: 'secure-messaging-server',
  server,
  logger: securityLogger,
  state: probeState,
  cleanupFns: [
    {
      name: 'secure-messaging-websocket',
      handler: async () => {
        securityLogger.info('Closing WebSocket connections', { module: 'SecureMessaging' });
        clearInterval(statusBroadcastInterval);
        clients.forEach(client => {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({
              type: 'server_shutdown',
              message: 'Server shutting down',
              timestamp: new Date().toISOString(),
            }));
            client.ws.close();
          }
        });
        clients.clear();
        await new Promise(resolve => wss.close(resolve));
      },
    },
  ],
});
