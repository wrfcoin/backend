/**
 * Blockchain Adapter for Wrfcoin Core
 *
 * This module serves as a bridge between the Node.js server and the Rust blockchain implementation.
 * It provides JavaScript-friendly interfaces to interact with the Wrfcoin blockchain.
 */

const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const axios = require('axios');
const WebSocket = require('ws');
const { blockchainLogger } = require('./utils/logger.js');
const { getCore4ApiUrl } = require('../shared/core4-url.cjs');

// ---------------------------------------------------------------------------
// Core4 HTTP client with timeout (#441)
// ---------------------------------------------------------------------------
const CORE4_REQUEST_TIMEOUT_MS = Number(process.env.CORE4_REQUEST_TIMEOUT_MS) || 5000;

const core4Http = axios.create({
  timeout: CORE4_REQUEST_TIMEOUT_MS,
});

// ---------------------------------------------------------------------------
// Lightweight circuit breaker for Core4 HTTP calls (#441)
//
// States: CLOSED (normal) → OPEN (fast-fail) → HALF_OPEN (probe)
// ---------------------------------------------------------------------------
const CB_STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class Core4CircuitBreaker {
  constructor({
    failureThreshold = 5,
    resetTimeoutMs = 30000,
    halfOpenMaxProbes = 1,
  } = {}) {
    this.state = CB_STATE.CLOSED;
    this.failureCount = 0;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.halfOpenMaxProbes = halfOpenMaxProbes;
    this.halfOpenActiveProbes = 0;
    this.lastFailureTime = null;
    this.lastOpenedAt = null;
  }

  async execute(fn, operationName) {
    if (this.state === CB_STATE.OPEN) {
      if (Date.now() - this.lastOpenedAt >= this.resetTimeoutMs) {
        this.state = CB_STATE.HALF_OPEN;
        this.halfOpenActiveProbes = 0;
        blockchainLogger.info('Core4 circuit breaker transitioning to HALF_OPEN', { operationName });
      } else {
        blockchainLogger.warn('Core4 circuit breaker OPEN — fast-failing', { operationName });
        const err = new Error(`Circuit breaker OPEN for core4 (${operationName})`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }

    if (this.state === CB_STATE.HALF_OPEN && this.halfOpenActiveProbes >= this.halfOpenMaxProbes) {
      const err = new Error(`Circuit breaker HALF_OPEN probe limit reached (${operationName})`);
      err.code = 'CIRCUIT_OPEN';
      throw err;
    }

    if (this.state === CB_STATE.HALF_OPEN) {
      this.halfOpenActiveProbes++;
    }

    try {
      const result = await fn();
      this._onSuccess(operationName);
      return result;
    } catch (error) {
      this._onFailure(operationName, error);
      throw error;
    }
  }

  _onSuccess(operationName) {
    if (this.state === CB_STATE.HALF_OPEN) {
      blockchainLogger.info('Core4 circuit breaker recovered — closing', { operationName });
    }
    this.state = CB_STATE.CLOSED;
    this.failureCount = 0;
    this.halfOpenActiveProbes = 0;
  }

  _onFailure(operationName, error) {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CB_STATE.HALF_OPEN) {
      this.state = CB_STATE.OPEN;
      this.lastOpenedAt = Date.now();
      blockchainLogger.warn('Core4 circuit breaker probe failed — re-opening', { operationName, error: error.message });
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.state = CB_STATE.OPEN;
      this.lastOpenedAt = Date.now();
      blockchainLogger.error('Core4 circuit breaker OPENED after repeated failures', {
        operationName,
        failureCount: this.failureCount,
        error: error.message,
      });
    }
  }

  getState() {
    return this.state;
  }

  getMetrics() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      lastFailureTime: this.lastFailureTime,
      lastOpenedAt: this.lastOpenedAt,
    };
  }

  reset() {
    this.state = CB_STATE.CLOSED;
    this.failureCount = 0;
    this.halfOpenActiveProbes = 0;
    this.lastFailureTime = null;
    this.lastOpenedAt = null;
  }
}

const core4CircuitBreaker = new Core4CircuitBreaker({
  failureThreshold: Number(process.env.CORE4_CB_FAILURE_THRESHOLD) || 5,
  resetTimeoutMs: Number(process.env.CORE4_CB_RESET_TIMEOUT_MS) || 30000,
});
const { probeCore4Health } = require('./utils/core4-launch-health.js');
const { publishEvent } = require('../graphql/resolvers/subscription-resolvers.js');

// Paths to blockchain executables
const BLOCKCHAIN_CORE_DIR = path.join(__dirname, '..', '..', 'blockchain-core');
const CORE4_DIR = path.join(__dirname, '..', '..', 'core4');
const LEGACY_DIR = path.join(__dirname, '..', 'src-tauri');

// Core4 locations (New Architecture)
const CORE4_BIN = path.join(
  CORE4_DIR,
  'target',
  'release',
  'launch_api'
);
const CORE4_DEBUG_BIN = path.join(
  CORE4_DIR,
  'target',
  'debug',
  'launch_api'
);

// Primary locations (blockchain-core - Legacy)
const BLOCKCHAIN_BIN = path.join(
  BLOCKCHAIN_CORE_DIR,
  'target',
  'release',
  'wrfcoin-core'
);
const BLOCKCHAIN_DEBUG_BIN = path.join(
  BLOCKCHAIN_CORE_DIR,
  'target',
  'debug',
  'wrfcoin-core'
);

// Legacy locations (src-tauri) for backward compatibility
const LEGACY_BLOCKCHAIN_BIN = path.join(
  LEGACY_DIR,
  'target',
  'release',
  'wrfcoin-core'
);
const LEGACY_DEBUG_BIN = path.join(
  LEGACY_DIR,
  'target',
  'debug',
  'wrfcoin-core'
);

// Status flags
const RUST_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  BUILDING: 'BUILDING',
  FAILED: 'FAILED',
  READY: 'READY',
};

function validateCore4BuildDirectory(buildDir) {
  const expectedDir = fs.realpathSync(CORE4_DIR);
  const resolvedBuildDir = fs.realpathSync(buildDir);

  if (resolvedBuildDir !== expectedDir) {
    throw new Error(`Invalid Core4 build directory: ${resolvedBuildDir}`);
  }

  return resolvedBuildDir;
}

function sanitizeBlockLimit(limit) {
  const parsedLimit = Number.parseInt(String(limit), 10);
  if (!Number.isFinite(parsedLimit)) {
    return 10;
  }

  return Math.min(Math.max(parsedLimit, 1), 100);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumericString(value) {
  return typeof value === 'string' && /^-?\d+$/.test(value.trim());
}

function isNumberish(value) {
  return isFiniteNumber(value) || isNumericString(value);
}

function isIsoDateLike(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return false;
  }

  return !Number.isNaN(new Date(value).getTime());
}

function normalizeTimestamp(value) {
  return isIsoDateLike(value) ? new Date(value).toISOString() : new Date().toISOString();
}

function buildNewBlockEvent(payload) {
  if (!isObject(payload) || !isNumberish(payload.height) || !isNonEmptyString(payload.hash)) {
    return null;
  }

  const transactions = Array.isArray(payload.transactions)
    ? payload.transactions.filter(isNonEmptyString)
    : [];
  const producer = isNonEmptyString(payload.producer) ? payload.producer : null;

  return {
    id: payload.hash,
    height: payload.height,
    hash: payload.hash,
    timestamp: normalizeTimestamp(payload.timestamp),
    transactions,
    producer,
  };
}

function buildBridgeLockEvent(payload) {
  if (!isObject(payload) || !isNonEmptyString(payload.tx_id) || !isNumberish(payload.amount)) {
    return null;
  }

  return {
    id: payload.tx_id,
    txId: payload.tx_id,
    amount: payload.amount,
    bridge: isNonEmptyString(payload.bridge) ? payload.bridge : null,
    timestamp: normalizeTimestamp(payload.timestamp),
  };
}

function buildSystemStatusEvent(payload) {
  if (!isObject(payload)) {
    return null;
  }

  return {
    nodeId: isNonEmptyString(payload.node_id) ? payload.node_id : 'unknown',
    status: isNonEmptyString(payload.status) ? payload.status : 'unknown',
    blockHeight: isFiniteNumber(payload.block_height) ? payload.block_height : 0,
    peerCount: isFiniteNumber(payload.peer_count) ? payload.peer_count : 0,
    syncProgress: isFiniteNumber(payload.sync_progress) ? payload.sync_progress : 0,
    uptime: isFiniteNumber(payload.uptime) ? payload.uptime : 0,
    timestamp: normalizeTimestamp(payload.timestamp),
  };
}

/**
 * Class to interface with the Wrfcoin blockchain
 */
class BlockchainAdapter {
  constructor() {
    this.initialized = false;
    this.pollInterval = null;
    this.ws = null;
    this.rustStatus = RUST_STATUS.NOT_STARTED;
    this.buildAttempts = 0;
    this.maxBuildAttempts = 3;
    this.useMockData = process.env.BLOCKCHAIN_MOCK_MODE === 'true'; // Explicit opt-in (#391)
    if (this.useMockData) {
      console.warn('[blockchain_adapter] WARNING: MOCK MODE ACTIVE — blockchain data is synthetic. Set BLOCKCHAIN_MOCK_MODE=false for real chain data.');
    }
    this.isCore4 = false; // Flag to indicate if using new Core4 architecture
    this.apiBaseUrl = getCore4ApiUrl();
    this.wsBaseUrl = this.apiBaseUrl.replace(/^http/, 'ws') + '/ws'; // Derive WS URL from API base
    this.operatorToken = process.env.WRFCOIN_OPERATOR_TOKEN;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 60000;
    this.reconnectTimer = null;
    this.isShuttingDown = false;
    this.webSocketConnected = false;
    this.lastWebSocketConnectedAt = null;
    this.lastWebSocketDisconnectedAt = null;
    this.lastWebSocketError = null;
    this.lastCore4ApiCheckedAt = null;
    this.lastCore4ApiError = null;
    this.lastCore4ApiStatusCode = null;
    this.core4ApiReachable = false;
    this.circuitBreaker = core4CircuitBreaker;
  }

  /**
   * Execute an HTTP request to Core4 through the circuit breaker.
   * Uses the timeout-configured axios instance.
   */
  async core4Request(method, urlPath, operationName, data) {
    const url = `${this.apiBaseUrl}${urlPath}`;
    const config = this.getAuthHeaders();
    return this.circuitBreaker.execute(async () => {
      if (method === 'post') {
        return core4Http.post(url, data, config);
      }
      return core4Http.get(url, config);
    }, operationName);
  }

  isCore4WebSocketExpected() {
    return this.isCore4 === true && this.useMockData === false;
  }

  isCore4ApiExpected() {
    return this.isCore4 === true && this.useMockData === false;
  }

  markWebSocketConnected() {
    this.webSocketConnected = true;
    this.lastWebSocketConnectedAt = new Date().toISOString();
    this.lastWebSocketError = null;
  }

  markWebSocketDisconnected(reason = null) {
    this.webSocketConnected = false;
    this.lastWebSocketDisconnectedAt = new Date().toISOString();
    if (reason) {
      this.lastWebSocketError = reason;
    }
  }

  getWebSocketHealth() {
    const expected = this.isCore4WebSocketExpected();
    const connected = this.webSocketConnected === true && this.isShuttingDown === false;
    const reconnectPending = Boolean(this.reconnectTimer);
    const status = !expected || connected ? 'up' : 'down';

    return {
      status,
      expected,
      connected,
      reconnectPending,
      url: this.wsBaseUrl,
      lastConnectedAt: this.lastWebSocketConnectedAt,
      lastDisconnectedAt: this.lastWebSocketDisconnectedAt,
      lastError: this.lastWebSocketError,
    };
  }

  getCore4ApiHealth() {
    const expected = this.isCore4ApiExpected();

    if (!expected) {
      return {
        status: 'up',
        expected: false,
        reachable: false,
        url: `${this.apiBaseUrl}/health`,
        httpStatus: null,
        lastCheckedAt: this.lastCore4ApiCheckedAt,
        lastError: null,
      };
    }

    if (!this.lastCore4ApiCheckedAt) {
      return {
        status: 'down',
        expected: true,
        reachable: false,
        url: `${this.apiBaseUrl}/health`,
        httpStatus: null,
        lastCheckedAt: null,
        lastError: 'core4 API health has not been verified yet',
      };
    }

    return {
      status: this.core4ApiReachable ? 'up' : 'down',
      expected: true,
      reachable: this.core4ApiReachable,
      url: `${this.apiBaseUrl}/health`,
      httpStatus: this.lastCore4ApiStatusCode,
      lastCheckedAt: this.lastCore4ApiCheckedAt,
      lastError: this.lastCore4ApiError,
    };
  }

  async refreshCore4ApiHealth() {
    const health = await probeCore4Health({
      baseUrl: this.apiBaseUrl,
      expected: this.isCore4ApiExpected(),
    });

    this.lastCore4ApiCheckedAt = health.lastCheckedAt || new Date().toISOString();
    this.lastCore4ApiError = health.lastError || null;
    this.lastCore4ApiStatusCode = health.httpStatus ?? null;
    this.core4ApiReachable = health.reachable === true;

    return this.getCore4ApiHealth();
  }

  async getHealthStatus() {
    await this.refreshCore4ApiHealth();
    const websocket = this.getWebSocketHealth();
    const api = this.getCore4ApiHealth();
    const expectedDependencies = [websocket, api].filter(
      dependency => dependency.expected
    );
    const healthy = expectedDependencies.every(
      dependency => dependency.status === 'up'
    );

    return {
      status: healthy ? 'healthy' : 'unhealthy',
      services: {
        blockchain: {
          status: healthy ? 'healthy' : 'unhealthy',
          rustStatus: this.rustStatus,
          usingMockData: this.useMockData,
          api,
          websocket,
          circuitBreaker: this.circuitBreaker.getMetrics(),
        },
      },
    };
  }

  async refreshHealthStatus() {
    return this.getHealthStatus();
  }

  /**
   * Get headers for API calls to Core4.
   *
   * The operator token is REQUIRED for all authenticated core4 calls.
   * In mock mode (no binary present) the token is not needed because no
   * real HTTP calls are made; in live mode a missing token is a hard error
   * that must be caught at startup via validateSecrets() / WRFCOIN_OPERATOR_TOKEN
   * check in src/config/secrets.ts.
   */
  getAuthHeaders() {
    const token = this.operatorToken;
    if (!token) {
      if (this.useMockData) {
        // Mock mode — no real core4 calls, token not required yet.
        return { headers: {} };
      }
      throw new Error(
        'WRFCOIN_OPERATOR_TOKEN is not set — refusing to make unauthenticated request to core4'
      );
    }
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  /**
   * Initialize the blockchain adapter
   */
  async initialize() {
    try {
      // Check if the blockchain binary exists in any location
      let binaryFound = null;

      // Check Core4 locations first (Highest Priority)
      if (fs.existsSync(CORE4_BIN)) {
        blockchainLogger.info('Blockchain release binary found at core4');
        binaryFound = CORE4_BIN;
        this.isCore4 = true;
      } else if (fs.existsSync(CORE4_DEBUG_BIN)) {
        blockchainLogger.info('Blockchain debug binary found at core4');
        binaryFound = CORE4_DEBUG_BIN;
        this.isCore4 = true;
      }
      // Check primary locations (blockchain-core) - RETIRED but kept for binary fallback
      else if (fs.existsSync(BLOCKCHAIN_BIN)) {
        blockchainLogger.info('Blockchain release binary found at blockchain-core (RETIRED)');
        binaryFound = BLOCKCHAIN_BIN;
      } else if (fs.existsSync(BLOCKCHAIN_DEBUG_BIN)) {
        blockchainLogger.info('Blockchain debug binary found at blockchain-core (RETIRED)');
        binaryFound = BLOCKCHAIN_DEBUG_BIN;
      }

      if (binaryFound) {
        this.rustStatus = RUST_STATUS.READY;
        this.useMockData = false;
        this.binaryPath = binaryFound;
        blockchainLogger.info('Using blockchain binary', { binaryPath: binaryFound, isCore4: this.isCore4 });
      } else {
        blockchainLogger.info('Blockchain binary not found. Using mock data.');
        this.rustStatus = RUST_STATUS.NOT_STARTED;
        this.useMockData = true;
      }

      // Always initialize mining service (real or mock)
      try {
        await this.initializeMiningService();
      } catch (miningError) {
        blockchainLogger.warn('Failed to initialize mining service', {
          error: miningError.message,
        });
      }

      // Start listening for real-time events if using Core4
      if (this.isCore4) {
          this.connectWebSocket();
      } else {
          // Fallback to polling for legacy/mock
          this.startPolling();
      }

      this.initialized = true;
      blockchainLogger.info('Blockchain adapter initialized', {
        dataSource: this.useMockData ? 'mock data' : 'real Rust implementation'
      });
      return true;
    } catch (error) {
      blockchainLogger.error('Failed to initialize blockchain adapter', {
        error: error.message,
      });
      this.useMockData = true;
      return false;
    }
  }

  /**
   * Connect to Core4 WebSocket for real-time events
   */
  connectWebSocket() {
      if (this.isShuttingDown) return;

      this.clearReconnectTimer();
      this.closeCurrentWebSocket();
      this.lastWebSocketError = null;

      blockchainLogger.info('Connecting to blockchain WebSocket', { url: this.wsBaseUrl });
      const socket = new WebSocket(this.wsBaseUrl);
      this.ws = socket;
      this.webSocketConnected = false;

      socket.on('open', () => {
          if (this.ws !== socket) return;
          blockchainLogger.info('Blockchain WebSocket connected');
          this.reconnectAttempts = 0;
          this.clearReconnectTimer();
          this.markWebSocketConnected();
      });

      socket.on('message', (data) => {
          if (this.ws !== socket) return;
          try {
              const event = JSON.parse(data);
              this.handleBlockchainEvent(event);
          } catch (e) {
              blockchainLogger.error('Error parsing blockchain WS message', { error: e.message });
          }
      });

      socket.on('error', (error) => {
          if (this.ws !== socket) return;
          blockchainLogger.error('Blockchain WebSocket error', { error: error.message });
          this.lastWebSocketError = error.message;
      });

      socket.on('close', () => {
          if (this.ws === socket) {
              this.ws = null;
          }
          this.markWebSocketDisconnected(this.lastWebSocketError);
          if (this.isShuttingDown || this.ws !== null) return;

          this.scheduleReconnect();
      });
  }

  clearReconnectTimer() {
      if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
      }
  }

  closeCurrentWebSocket() {
      if (!this.ws) {
          return;
      }

      const socket = this.ws;
      this.ws = null;
      this.markWebSocketDisconnected('WebSocket connection closed');
      socket.removeAllListeners('open');
      socket.removeAllListeners('message');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      socket.terminate();
  }

  scheduleReconnect() {
      if (this.isShuttingDown || this.reconnectTimer) {
          return;
      }

      this.reconnectAttempts += 1;
      const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
      blockchainLogger.warn(`Blockchain WebSocket closed. Reconnecting in ${delay / 1000}s...`, {
          attempt: this.reconnectAttempts,
      });

      this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connectWebSocket();
      }, delay);
  }

  /**
   * Handle incoming blockchain events and broadcast to GraphQL subscriptions
   */
  handleBlockchainEvent(event) {
      if (!isObject(event) || !isNonEmptyString(event.type)) {
          blockchainLogger.warn('Ignoring malformed blockchain event envelope', { event });
          return;
      }

      blockchainLogger.debug('Blockchain event received', { type: event.type });

      switch (event.type) {
          case 'NewBlock':
              {
                  const newBlock = buildNewBlockEvent(event.payload);
                  if (!newBlock) {
                      blockchainLogger.warn('Ignoring malformed NewBlock event payload', { payload: event.payload });
                      break;
                  }

                  blockchainLogger.info('New block detected', { height: newBlock.height, hash: newBlock.hash });
                  if (typeof publishEvent === 'function') {
                      publishEvent('NEW_BLOCK', { newBlock });
                  }
              }
              break;
          case 'BridgeLock':
              {
                  const bridgeLockDetected = buildBridgeLockEvent(event.payload);
                  if (!bridgeLockDetected) {
                      blockchainLogger.warn('Ignoring malformed BridgeLock event payload', { payload: event.payload });
                      break;
                  }

                  blockchainLogger.info('Bridge lock detected', { tx_id: bridgeLockDetected.txId });
                  if (typeof publishEvent === 'function') {
                      publishEvent('BRIDGE_LOCK_DETECTED', { bridgeLockDetected });
                  }
              }
              break;
          case 'SystemStatus':
              {
                  const systemStatus = buildSystemStatusEvent(event.payload);
                  if (!systemStatus) {
                      blockchainLogger.warn('Ignoring malformed SystemStatus event payload', { payload: event.payload });
                      break;
                  }

                  blockchainLogger.info('System status update received', { status: systemStatus.status, height: systemStatus.blockHeight });
                  if (typeof publishEvent === 'function') {
                      publishEvent('SYSTEM_STATUS', { systemStatus });
                  }
              }
              break;
          default:
              blockchainLogger.debug('Unhandled blockchain event type', { type: event.type });
      }
  }

  /**
   * Initialize the mining service
   * This connects to the Rust-based mining service via FFI
   */
  async initializeMiningService() {
    // In a real implementation, this would initialize the Rust-based mining service
    if (this.useMockData) {
      blockchainLogger.info('Using mock mining service until Rust mining service is ready');
      return true;
    }

    if (this.isCore4) {
        blockchainLogger.info('Mining service managed by Core4 Launch API (HTTP)');
        return true;
    }

    try {
      const { stdout } = await execFileAsync(this.binaryPath, ['mining', 'init']);
      blockchainLogger.info('Mining service initialized', { output: stdout });
      return true;
    } catch (error) {
      blockchainLogger.error('Failed to initialize mining service', {
        error: error.message,
        stack: error.stack
      });
      return false;
    }
  }

  /**
   * Build the blockchain from source
   * This method is used to manually trigger a build attempt for the Rust blockchain
   */
  async buildBlockchain() {
    try {
      this.rustStatus = RUST_STATUS.BUILDING;
      this.buildAttempts++;

      blockchainLogger.info('Manual blockchain build attempt', { attempt: this.buildAttempts });

      // Log for transparency that we're using mock data while Rust components are developed
      blockchainLogger.info('Application will continue with mock data while Rust components are being built');

      // Try building Core4 first
      const buildDir = validateCore4BuildDirectory(CORE4_DIR);

      blockchainLogger.info('Building Core4 release version', { directory: buildDir });
      try {
        await execFileAsync(
          'cargo',
          ['build', '--release', '-p', 'wrfcoin-native-chain', '--bin', 'launch_api'],
          { cwd: buildDir }
        );
        blockchainLogger.info('Core4 Release build successful');
        this.rustStatus = RUST_STATUS.READY;
        this.useMockData = false;
        this.isCore4 = true;
        this.binaryPath = CORE4_BIN;
      } catch (releaseError) {
        blockchainLogger.info('Core4 Release build failed - trying debug', {
          error: releaseError.message,
        });
        try {
          await execFileAsync(
            'cargo',
            ['build', '-p', 'wrfcoin-native-chain', '--bin', 'launch_api'],
            { cwd: buildDir }
          );
          blockchainLogger.info('Core4 Debug build successful');
          this.rustStatus = RUST_STATUS.READY;
          this.useMockData = false;
          this.isCore4 = true;
          this.binaryPath = CORE4_DEBUG_BIN;
        } catch (debugError) {
          blockchainLogger.info('Core4 Debug build failed', {
            error: debugError.message,
          });
          this.rustStatus = RUST_STATUS.FAILED;
          this.useMockData = true;
        }
      }
    } catch (error) {
      blockchainLogger.error('Failed to build blockchain', {
        error: error.message,
        stack: error.stack
      });
      this.rustStatus = RUST_STATUS.FAILED;
      this.useMockData = true;
    }
  }

  /**
   * Start polling for blockchain updates
   */
  startPolling() {
    // Poll every 10 seconds for blockchain updates
    this.pollInterval = setInterval(async () => {
      try {
        // Poll for new data
        // In a real implementation, this would communicate with the blockchain
        // through its API or IPC mechanism
      } catch (error) {
        blockchainLogger.error('Error polling blockchain', { error: error.message, stack: error.stack });
      }
    }, 10000);
  }

  /**
   * Stop polling for blockchain updates
   */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Get blockchain information
   */
  async getBlockchainInfo() {
    try {
      if (!this.useMockData && this.rustStatus === RUST_STATUS.READY) {
        // Try to call the actual Rust binary or API
        try {
          // Check if it is core4
          if (this.isCore4) {
             blockchainLogger.debug('Calling Core4 API for blockchain info');
             const response = await this.core4Request('get', '/blockchain', 'getBlockchainInfo');
             const data = response.data.data || response.data;
             return {
                blockHeight: data.height || 0,
                totalTransactions: data.pending_transactions || 0,
                nodeCount: 1,
                implementation: 'Core4 Rust API',
                rustStatus: this.rustStatus,
                usingMockData: false
             };
          }

          const { stdout } = await execFileAsync(this.binaryPath, ['info']);
          return JSON.parse(stdout);
        } catch (rustError) {
          blockchainLogger.error('Error calling Rust binary/API, falling back to mock data', {
            error: rustError.message,
            stack: rustError.stack
          });
        }
      }

      // Use dynamic mock data
      const now = Date.now();
      return {
        blockHeight: 1000 + (Math.floor(now / 60000) % 100),
        difficulty: 5,
        networkHashrate: 1000,
        nodeCount: 42,
        totalTransactions: 9000,
        averageBlockTime: "2.5",
        implementation: 'JavaScript',
        rustStatus: this.rustStatus,
        buildAttempts: this.buildAttempts,
        usingMockData: true,
      };
    } catch (error) {
      blockchainLogger.error('Error getting blockchain info', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  /**
   * Get latest blocks
   */
  async getLatestBlocks(limit = 10) {
    try {
      const boundedLimit = sanitizeBlockLimit(limit);
      if (!this.useMockData && this.rustStatus === RUST_STATUS.READY) {
        try {
          if (this.isCore4) {
             blockchainLogger.debug('Calling Core4 API for latest blocks', { limit: boundedLimit });
             // core4 doesn't seem to have a dedicated /blocks route yet, it's mixed in
             // We'll return an empty list or try to fetch from a generic route
             return [];
          }
          const { stdout } = await execFileAsync(this.binaryPath, [
            'blocks',
            '--limit',
            String(boundedLimit),
          ]);
          return JSON.parse(stdout);
        } catch (rustError) {
          blockchainLogger.error('Error calling Rust binary/API, falling back to mock data', {
            error: rustError.message
          });
        }
      }

      return [];
    } catch (error) {
      blockchainLogger.error('Error getting latest blocks', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  /**
   * Get block by hash
   */
  async getBlockByHash(hash) {
    try {
      if (!this.useMockData && this.rustStatus === RUST_STATUS.READY && this.isCore4) {
          try {
              const response = await this.core4Request('get', `/transactions/commit/${hash}/status`, 'getBlockByHash');
              return response.data.data || response.data;
          } catch (e) {
              blockchainLogger.error('Error fetching block by hash from Core4 API', { hash, error: e.message });
          }
      }
      return null;
    } catch (error) {
      blockchainLogger.error('Error getting block by hash', { hash, error: error.message, stack: error.stack });
      throw error;
    }
  }

  /**
   * Get wallet information
   */
  async getWalletByAddress(address) {
    try {
      if (!this.useMockData && this.rustStatus === RUST_STATUS.READY && this.isCore4) {
          try {
              const response = await this.core4Request('get', `/addresses/${address}`, 'getWalletByAddress');
              const data = response.data.data || response.data;
              return {
                address: data.address,
                balance: data.balance,
                nonce: 0,
                lastUpdated: new Date(),
              };
          } catch (e) {
              blockchainLogger.error('Error fetching wallet by address from Core4 API', { address, error: e.message });
          }
      }
      return null;
    } catch (error) {
      blockchainLogger.error('Error getting wallet by address', { address, error: error.message, stack: error.stack });
      throw error;
    }
  }

  /**
   * Get mining statistics
   */
  async getMiningStats() {
    try {
      if (!this.useMockData && this.rustStatus === RUST_STATUS.READY && this.isCore4) {
          try {
              const response = await this.core4Request('get', '/metrics', 'getMiningStats');
              const data = response.data.data || response.data;
              return {
                networkHashrate: 0, 
                difficulty: 0,
                blockReward: 50,
                lastBlockFound: new Date(),
                activeMiners: data.account_count || 0,
                totalBlocks: data.chain_height || 0,
                totalTransactions: data.pending_transactions || 0,
              };
          } catch (e) {
              blockchainLogger.error('Error fetching mining stats from Core4 API', { error: e.message });
          }
      }
      return null;
    } catch (error) {
      blockchainLogger.error('Error getting mining stats', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  /**
   * Get ZK proving statistics
   */
  async getZkStats() {
    try {
      if (!this.useMockData && this.rustStatus === RUST_STATUS.READY && this.isCore4) {
          try {
              const response = await this.core4Request('get', '/zk/stats', 'getZkStats');
              const data = response.data.data || response.data;
              return {
                throughput: data.throughput || 0,
                avgVerificationTime: data.avg_verification_time_ms || 0,
                totalProofs: data.total_proofs || 0,
                proverUptime: 99.98, // Mocked for now
                activeProvers: data.active_provers || 1,
                timestamp: new Date().toISOString()
              };
          } catch (e) {
              blockchainLogger.error('Error fetching ZK stats from Core4 API', { error: e.message });
          }
      }
      
      // Fallback mock
      return {
        throughput: 42.5,
        avgVerificationTime: 12.4,
        totalProofs: 1245000,
        proverUptime: 99.98,
        activeProvers: 8,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      blockchainLogger.error('Error getting ZK stats', { error: error.message });
      throw error;
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    this.isShuttingDown = true;
    this.clearReconnectTimer();
    this.stopPolling();
    this.closeCurrentWebSocket();
    this.circuitBreaker.reset();
    blockchainLogger.info('Blockchain adapter cleaned up');
  }
}

// Export singleton instance
const blockchainAdapter = new BlockchainAdapter();
module.exports = blockchainAdapter;
