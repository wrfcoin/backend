/**
 * Network Protocol Handler for Wrfcoin Core
 * Handles P2P networking, protocol messages, and network communication
 */

const EventEmitter = require('events');
const crypto = require('crypto');

class NetworkProtocolHandler extends EventEmitter {
  constructor(options = {}) {
    super();

    this.config = {
      protocolVersion: options.protocolVersion || '1.0.0',
      networkId: options.networkId || 'wrfcoin-mainnet',
      maxPeers: options.maxPeers || 50,
      messageTimeout: options.messageTimeout || 30000,
      heartbeatInterval: options.heartbeatInterval || 60000,
      reconnectDelay: options.reconnectDelay || 5000,
      ...options,
    };

    this.peers = new Map();
    this.messageHandlers = new Map();
    this.pendingRequests = new Map();
    this.networkStats = {
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      errorsCount: 0,
    };

    this.setupMessageHandlers();
    this.startHeartbeat();
  }

  // Setup default message handlers
  setupMessageHandlers() {
    this.registerHandler('version', this.handleVersionMessage.bind(this));
    this.registerHandler('verack', this.handleVerackMessage.bind(this));
    this.registerHandler('ping', this.handlePingMessage.bind(this));
    this.registerHandler('pong', this.handlePongMessage.bind(this));
    this.registerHandler('addr', this.handleAddrMessage.bind(this));
    this.registerHandler('getaddr', this.handleGetAddrMessage.bind(this));
    this.registerHandler('inv', this.handleInvMessage.bind(this));
    this.registerHandler('getdata', this.handleGetDataMessage.bind(this));
    this.registerHandler('block', this.handleBlockMessage.bind(this));
    this.registerHandler('tx', this.handleTransactionMessage.bind(this));
    this.registerHandler('reject', this.handleRejectMessage.bind(this));
  }

  // Register a message handler
  registerHandler(messageType, handler) {
    this.messageHandlers.set(messageType, handler);
  }

  // Process incoming network message
  async processMessage(peerId, messageData) {
    try {
      const message = this.parseMessage(messageData);
      if (!message) {
        throw new Error('Invalid message format');
      }

      this.networkStats.messagesReceived++;
      this.networkStats.bytesReceived += messageData.length;

      const peer = this.peers.get(peerId);
      if (peer) {
        peer.lastActivity = Date.now();
        peer.messagesReceived++;
      }

      // Handle the message
      const handler = this.messageHandlers.get(message.command);
      if (handler) {
        await handler(peerId, message.payload, message);
      } else {
        console.warn(`Unknown message type: ${message.command}`);
        await this.sendReject(peerId, message.command, 'unknown-command');
      }

      this.emit('message:processed', {
        peerId,
        command: message.command,
        size: messageData.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.networkStats.errorsCount++;
      this.emit('message:error', {
        peerId,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Parse binary message format
  parseMessage(data) {
    try {
      // Simplified message parsing - in production would use actual protocol format
      const message = JSON.parse(data.toString());
      return {
        magic: message.magic || 0xf9beb4d9,
        command: message.command,
        length: message.payload
          ? Buffer.from(JSON.stringify(message.payload)).length
          : 0,
        checksum: this.calculateChecksum(message.payload),
        payload: message.payload,
      };
    } catch (error) {
      return null;
    }
  }

  // Create binary message
  createMessage(command, payload = {}) {
    const message = {
      magic: 0xf9beb4d9,
      command,
      payload,
      timestamp: Date.now(),
    };

    return Buffer.from(JSON.stringify(message));
  }

  // Calculate message checksum
  calculateChecksum(payload) {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(payload || {}));
    return hash.digest('hex').substring(0, 8);
  }

  // Send message to peer
  async sendMessage(peerId, command, payload = {}) {
    try {
      const peer = this.peers.get(peerId);
      if (!peer || !peer.connected) {
        throw new Error(`Peer ${peerId} not connected`);
      }

      const message = this.createMessage(command, payload);

      // Simulate sending message
      await new Promise(resolve => setTimeout(resolve, 10));

      this.networkStats.messagesSent++;
      this.networkStats.bytesSent += message.length;

      if (peer) {
        peer.messagesSent++;
        peer.lastActivity = Date.now();
      }

      this.emit('message:sent', {
        peerId,
        command,
        size: message.length,
        timestamp: new Date().toISOString(),
      });

      return true;
    } catch (error) {
      this.networkStats.errorsCount++;
      throw error;
    }
  }

  // Message Handlers
  async handleVersionMessage(peerId, payload) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.version = payload.version;
      peer.services = payload.services;
      peer.userAgent = payload.userAgent;
      peer.startHeight = payload.startHeight;
    }

    // Send version acknowledgment
    await this.sendMessage(peerId, 'verack');

    this.emit('peer:version', { peerId, payload });
  }

  async handleVerackMessage(peerId, payload) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.handshakeComplete = true;
    }

    this.emit('peer:handshake_complete', { peerId });
  }

  async handlePingMessage(peerId, payload) {
    await this.sendMessage(peerId, 'pong', { nonce: payload.nonce });
  }

  async handlePongMessage(peerId, payload) {
    const peer = this.peers.get(peerId);
    if (peer && peer.pingNonce === payload.nonce) {
      peer.latency = Date.now() - peer.pingTime;
      delete peer.pingNonce;
      delete peer.pingTime;
    }
  }

  async handleAddrMessage(peerId, payload) {
    // Process peer addresses
    for (const addr of payload.addresses || []) {
      this.emit('peer:discovered', {
        address: addr.ip,
        port: addr.port,
        services: addr.services,
        timestamp: addr.timestamp,
      });
    }
  }

  async handleGetAddrMessage(peerId, payload) {
    // Send known peer addresses
    const knownPeers = Array.from(this.peers.values())
      .filter(peer => peer.connected && peer.public)
      .slice(0, 1000) // Limit to 1000 addresses
      .map(peer => ({
        ip: peer.address,
        port: peer.port,
        services: peer.services || 1,
        timestamp: peer.lastActivity,
      }));

    await this.sendMessage(peerId, 'addr', { addresses: knownPeers });
  }

  async handleInvMessage(peerId, payload) {
    // Handle inventory message
    const requestItems = [];

    for (const item of payload.inventory || []) {
      if (!this.hasItem(item.type, item.hash)) {
        requestItems.push(item);
      }
    }

    if (requestItems.length > 0) {
      await this.sendMessage(peerId, 'getdata', { inventory: requestItems });
    }
  }

  async handleGetDataMessage(peerId, payload) {
    // Handle data request
    for (const item of payload.inventory || []) {
      const data = await this.getItemData(item.type, item.hash);
      if (data) {
        const command = item.type === 1 ? 'tx' : 'block';
        await this.sendMessage(peerId, command, data);
      }
    }
  }

  async handleBlockMessage(peerId, payload) {
    this.emit('block:received', {
      peerId,
      block: payload,
      timestamp: new Date().toISOString(),
    });
  }

  async handleTransactionMessage(peerId, payload) {
    this.emit('transaction:received', {
      peerId,
      transaction: payload,
      timestamp: new Date().toISOString(),
    });
  }

  async handleRejectMessage(peerId, payload) {
    console.warn(
      `Peer ${peerId} rejected: ${payload.message} - ${payload.reason}`
    );

    this.emit('message:rejected', {
      peerId,
      message: payload.message,
      reason: payload.reason,
      data: payload.data,
    });
  }

  // Send rejection message
  async sendReject(peerId, command, reason, data = null) {
    await this.sendMessage(peerId, 'reject', {
      message: command,
      reason,
      data,
    });
  }

  // Peer management
  addPeer(peerId, peerInfo) {
    const peer = {
      id: peerId,
      address: peerInfo.address,
      port: peerInfo.port,
      connected: true,
      handshakeComplete: false,
      lastActivity: Date.now(),
      messagesReceived: 0,
      messagesSent: 0,
      version: null,
      services: null,
      userAgent: null,
      startHeight: null,
      latency: null,
      public: peerInfo.public || false,
      ...peerInfo,
    };

    this.peers.set(peerId, peer);
    this.emit('peer:connected', { peerId, peer });

    // Send version message to initiate handshake
    this.sendVersion(peerId);
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      this.peers.delete(peerId);
      this.emit('peer:disconnected', { peerId, peer });
    }
  }

  // Send version message for handshake
  async sendVersion(peerId) {
    const versionPayload = {
      version: 70015,
      services: 1,
      timestamp: Math.floor(Date.now() / 1000),
      userAgent: '/Wrfcoin:1.0.0/',
      startHeight: 5000000,
      relay: true,
    };

    await this.sendMessage(peerId, 'version', versionPayload);
  }

  // Ping peer to measure latency
  async pingPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.connected) {
      throw new Error(`Peer ${peerId} not connected`);
    }

    const nonce = crypto.randomBytes(8).toString('hex');
    peer.pingNonce = nonce;
    peer.pingTime = Date.now();

    await this.sendMessage(peerId, 'ping', { nonce });
  }

  // Broadcast message to all connected peers
  async broadcast(command, payload, excludePeer = null) {
    const results = [];

    for (const [peerId, peer] of this.peers) {
      if (peer.connected && peer.handshakeComplete && peerId !== excludePeer) {
        try {
          await this.sendMessage(peerId, command, payload);
          results.push({ peerId, success: true });
        } catch (error) {
          results.push({ peerId, success: false, error: error.message });
        }
      }
    }

    return results;
  }

  // Helper methods
  hasItem(type, hash) {
    // Check if we have the requested item
    return Math.random() > 0.5; // Simulate random availability
  }

  async getItemData(type, hash) {
    // Get item data by type and hash
    if (type === 1) {
      // Transaction
      return {
        hash,
        inputs: [],
        outputs: [],
        timestamp: Date.now(),
      };
    } else if (type === 2) {
      // Block
      return {
        hash,
        height: Math.floor(Math.random() * 1000000),
        transactions: [],
        timestamp: Date.now(),
      };
    }
    return null;
  }

  // Start heartbeat to maintain connections
  startHeartbeat() {
    setInterval(() => {
      const now = Date.now();

      // Check for stale connections
      for (const [peerId, peer] of this.peers) {
        if (now - peer.lastActivity > this.config.messageTimeout) {
          console.warn(`Peer ${peerId} connection timeout`);
          this.removePeer(peerId);
        } else if (peer.connected && peer.handshakeComplete) {
          // Send periodic ping
          this.pingPeer(peerId).catch(error => {
            console.error(`Failed to ping peer ${peerId}:`, error.message);
          });
        }
      }

      this.emit('heartbeat', {
        activePeers: this.peers.size,
        timestamp: new Date().toISOString(),
      });
    }, this.config.heartbeatInterval);
  }

  // Get network statistics
  getNetworkStats() {
    return {
      ...this.networkStats,
      activePeers: this.peers.size,
      connectedPeers: Array.from(this.peers.values()).filter(p => p.connected)
        .length,
      handshakeComplete: Array.from(this.peers.values()).filter(
        p => p.handshakeComplete
      ).length,
      averageLatency: this.calculateAverageLatency(),
      timestamp: new Date().toISOString(),
    };
  }

  calculateAverageLatency() {
    const latencies = Array.from(this.peers.values())
      .filter(peer => peer.latency !== null)
      .map(peer => peer.latency);

    if (latencies.length === 0) return null;

    return (
      latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length
    );
  }

  // Get peer information
  getPeerInfo(peerId) {
    return this.peers.get(peerId) || null;
  }

  // Get all connected peers
  getConnectedPeers() {
    return Array.from(this.peers.values()).filter(peer => peer.connected);
  }
}

module.exports = NetworkProtocolHandler;
