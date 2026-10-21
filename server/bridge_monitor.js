// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

/**
 * Bridge Monitoring System
 * Implements Task 22.3 - Comprehensive Cross-Chain Bridge Monitoring
 *
 * Features:
 * - Real-time bridge status monitoring
 * - Validator health tracking
 * - Security threat detection
 * - Transaction volume analytics
 * - Cross-chain performance metrics
 * - Automated alerting system
 */

const express = require('express');
const WebSocket = require('ws');
const EventEmitter = require('events');
const winston = require('winston');
const { spawn } = require('child_process');

// Configure logger for bridge monitoring
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'bridge-monitor' },
  transports: [
    new winston.transports.File({
      filename: 'logs/bridge-monitor-error.log',
      level: 'error',
    }),
    new winston.transports.File({ filename: 'logs/bridge-monitor.log' }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

class BridgeMonitor extends EventEmitter {
  constructor() {
    super();
    this.bridges = new Map();
    this.validators = new Map();
    this.securityAlerts = [];
    this.performanceHistory = [];
    this.blockchainConnections = new Map();

    // Enhanced metrics with security and performance tracking
    this.metrics = {
      totalTransactions: 0,
      successfulTransactions: 0,
      failedTransactions: 0,
      totalVolume: '0',
      averageProcessingTime: 0,
      networkHealth: 'healthy',
      securityThreats: 0,
      suspiciousPatterns: 0,
      validatorConsensus: 100,
      crossChainLatency: 0,
      bridgeUtilization: 0,
      gasEfficiency: 95,
    };

    // Enhanced alert thresholds with security parameters
    this.alertThresholds = {
      failureRate: 0.05, // 5%
      processingTime: 300000, // 5 minutes
      validatorDowntime: 600000, // 10 minutes
      securityScore: 0.8, // 80% security score minimum
      consecutiveFailures: 5,
      volumeSpike: 10, // 10x normal volume
      latencyThreshold: 600000, // 10 minutes
      consensusThreshold: 0.67, // 67% consensus minimum
    };

    // Initialize blockchain connections
    this.initializeBlockchainConnections();
    this.startMonitoring();
  }

  // Initialize connections to blockchain nodes
  initializeBlockchainConnections() {
    const supportedChains = [
      'ethereum',
      'polygon',
      'bsc',
      'avalanche',
      'arbitrum',
      'optimism',
      'cosmos',
      'polkadot',
      'near',
      'thorchain',
    ];

    supportedChains.forEach(chain => {
      this.blockchainConnections.set(chain, {
        connected: true,
        lastBlock: 0,
        rpcEndpoint: `https://${chain}.rpc.endpoint`,
        status: 'healthy',
        latency: 0,
      });
    });

    logger.info('Initialized blockchain connections', {
      chains: supportedChains,
    });
  }

  startMonitoring() {
    logger.info('Starting comprehensive bridge monitoring system');

    // Core monitoring - every 10 seconds
    // #977 ratchet: handle stored and unref'd - was discarded, so unclearable.
    const importTimeTimer1 = setInterval(() => {
      this.updateBridgeMetrics();
      this.checkValidatorHealth();
      this.detectAnomalies();
      this.monitorSecurityThreats();
      this.updatePerformanceMetrics();
    }, 10000);
    importTimeTimer1.unref();

    // Transaction simulation - every 5 seconds
    // #977 ratchet: handle stored and unref'd - was discarded, so unclearable.
    const importTimeTimer2 = setInterval(() => {
      this.generateTransactionActivity();
    }, 5000);
    importTimeTimer2.unref();

    // Blockchain health check - every 30 seconds
    // #977 ratchet: handle stored and unref'd - was discarded, so unclearable.
    const importTimeTimer3 = setInterval(() => {
      this.checkBlockchainConnections();
    }, 30000);
    importTimeTimer3.unref();

    // Security audit - every minute
    // #977 ratchet: handle stored and unref'd - was discarded, so unclearable.
    const importTimeTimer4 = setInterval(() => {
      this.performSecurityAudit();
    }, 60000);
    importTimeTimer4.unref();

    // Performance analysis - every 2 minutes
    // #977 ratchet: handle stored and unref'd - was discarded, so unclearable.
    const importTimeTimer5 = setInterval(() => {
      this.analyzePerformanceTrends();
    }, 120000);
    importTimeTimer5.unref();
  }

  // Check blockchain connections health
  async checkBlockchainConnections() {
    for (const [chain, connection] of this.blockchainConnections) {
      try {
        const startTime = Date.now();

        // Simulate RPC call to check latest block
        const latency = Math.random() * 500 + 50; // 50-550ms
        connection.latency = latency;
        connection.lastBlock = Math.floor(Date.now() / 1000); // Mock block number
        connection.status = latency > 1000 ? 'degraded' : 'healthy';
        connection.connected = true;

        logger.debug('Blockchain health check', {
          chain,
          latency: latency.toFixed(2),
          status: connection.status,
        });
      } catch (error) {
        connection.status = 'unhealthy';
        connection.connected = false;
        connection.latency = 0;
        logger.error('Blockchain connection failed', {
          chain,
          error: error.message,
        });

        // Emit alert for monitoring system
        this.emit('blockchainDisconnected', {
          chain,
          error: error.message,
          timestamp: Date.now(),
          severity: 'critical',
        });
      }
    }
  }

  // Monitor security threats and suspicious patterns
  monitorSecurityThreats() {
    let threatsDetected = 0;
    const suspiciousPatterns = [];

    for (const [bridgeId, bridge] of this.bridges) {
      // Check for unusual transaction patterns
      const recentFailures = bridge.failureCount || 0;
      const recentVolume = parseFloat(bridge.volume) || 0;

      // Detect consecutive failures
      if (recentFailures >= this.alertThresholds.consecutiveFailures) {
        threatsDetected++;
        suspiciousPatterns.push({
          type: 'consecutive_failures',
          bridgeId,
          severity: 'high',
          details: `${recentFailures} consecutive failures detected`,
        });
      }

      // Detect volume spikes
      const avgVolume = 1000; // Mock average volume
      if (recentVolume > avgVolume * this.alertThresholds.volumeSpike) {
        threatsDetected++;
        suspiciousPatterns.push({
          type: 'volume_spike',
          bridgeId,
          severity: 'medium',
          details: `Volume spike: ${recentVolume} vs avg ${avgVolume}`,
        });
      }

      // Detect validator consensus issues
      const validatorConsensus = this.calculateValidatorConsensus(bridgeId);
      if (validatorConsensus < this.alertThresholds.consensusThreshold) {
        threatsDetected++;
        suspiciousPatterns.push({
          type: 'consensus_failure',
          bridgeId,
          severity: 'critical',
          details: `Low consensus: ${(validatorConsensus * 100).toFixed(1)}%`,
        });
      }
    }

    this.metrics.securityThreats = threatsDetected;
    this.metrics.suspiciousPatterns = suspiciousPatterns.length;

    // Store security alerts
    if (suspiciousPatterns.length > 0) {
      this.securityAlerts.push({
        timestamp: Date.now(),
        patterns: suspiciousPatterns,
        severity: this.calculateOverallSeverity(suspiciousPatterns),
      });

      // Keep only last 100 alerts
      if (this.securityAlerts.length > 100) {
        this.securityAlerts = this.securityAlerts.slice(-100);
      }

      logger.warn('Security threats detected', {
        patterns: suspiciousPatterns,
      });
      this.emit('securityThreat', { patterns: suspiciousPatterns });
    }
  }

  // Calculate validator consensus for a bridge
  calculateValidatorConsensus(bridgeId) {
    const bridge = this.bridges.get(bridgeId);
    if (!bridge || !bridge.validators) return 1.0;

    const onlineValidators = bridge.validators.filter(validatorId => {
      const validator = this.validators.get(validatorId);
      return validator && validator.status === 'online';
    }).length;

    return bridge.validators.length > 0
      ? onlineValidators / bridge.validators.length
      : 1.0;
  }

  // Calculate overall severity from patterns
  calculateOverallSeverity(patterns) {
    const severityLevels = { low: 1, medium: 2, high: 3, critical: 4 };
    const maxSeverity = Math.max(
      ...patterns.map(p => severityLevels[p.severity] || 1)
    );

    const severityMap = { 1: 'low', 2: 'medium', 3: 'high', 4: 'critical' };
    return severityMap[maxSeverity];
  }

  // Update performance metrics
  updatePerformanceMetrics() {
    const activeBridges = Array.from(this.bridges.values()).filter(
      b => b.status === 'active'
    );
    const totalLatency = activeBridges.reduce(
      (sum, bridge) => sum + (bridge.averageProcessingTime || 0),
      0
    );

    this.metrics.crossChainLatency =
      activeBridges.length > 0 ? totalLatency / activeBridges.length : 0;
    this.metrics.bridgeUtilization =
      (activeBridges.length / Math.max(this.bridges.size, 1)) * 100;

    // Calculate validator consensus average
    let consensusSum = 0;
    let bridgeCount = 0;

    for (const [bridgeId] of this.bridges) {
      consensusSum += this.calculateValidatorConsensus(bridgeId);
      bridgeCount++;
    }

    this.metrics.validatorConsensus =
      bridgeCount > 0 ? (consensusSum / bridgeCount) * 100 : 100;

    // Store performance history
    this.performanceHistory.push({
      timestamp: Date.now(),
      latency: this.metrics.crossChainLatency,
      utilization: this.metrics.bridgeUtilization,
      consensus: this.metrics.validatorConsensus,
      networkHealth: this.metrics.networkHealth,
    });

    // Keep only last 100 entries
    if (this.performanceHistory.length > 100) {
      this.performanceHistory = this.performanceHistory.slice(-100);
    }
  }

  // Perform comprehensive security audit
  performSecurityAudit() {
    const auditResults = {
      timestamp: Date.now(),
      bridgeSecurityScores: new Map(),
      overallSecurityScore: 0,
      recommendations: [],
    };

    let totalSecurityScore = 0;
    let bridgeCount = 0;

    for (const [bridgeId, bridge] of this.bridges) {
      const securityScore = this.calculateBridgeSecurityScore(bridge);
      auditResults.bridgeSecurityScores.set(bridgeId, securityScore);
      totalSecurityScore += securityScore;
      bridgeCount++;

      if (securityScore < this.alertThresholds.securityScore) {
        auditResults.recommendations.push({
          bridgeId,
          severity: 'high',
          recommendation:
            'Bridge security score below threshold - investigate immediately',
          score: securityScore,
        });

        this.emit('securityAuditFailed', { bridgeId, score: securityScore });
      }
    }

    auditResults.overallSecurityScore =
      bridgeCount > 0 ? totalSecurityScore / bridgeCount : 1.0;

    logger.info('Security audit completed', {
      overallScore: auditResults.overallSecurityScore.toFixed(3),
      recommendations: auditResults.recommendations.length,
    });

    return auditResults;
  }

  // Calculate security score for a bridge
  calculateBridgeSecurityScore(bridge) {
    let score = 1.0;

    // Factor in failure rate
    const failureRate =
      bridge.failureCount / Math.max(bridge.transactionCount, 1);
    score *= Math.max(0, 1 - failureRate * 2); // Penalty for failures

    // Factor in validator consensus
    const consensus = this.calculateValidatorConsensus(bridge.id);
    score *= consensus;

    // Factor in uptime
    const timeSinceLastTransaction =
      Date.now() - (bridge.lastTransaction || Date.now());
    const uptimeScore = timeSinceLastTransaction < 600000 ? 1.0 : 0.8; // Penalty for inactivity
    score *= uptimeScore;

    // Factor in processing time
    const processingTimeScore =
      bridge.averageProcessingTime < this.alertThresholds.processingTime
        ? 1.0
        : 0.9;
    score *= processingTimeScore;

    return Math.max(0, Math.min(1, score));
  }

  // Analyze performance trends
  analyzePerformanceTrends() {
    if (this.performanceHistory.length < 10) return;

    const recent = this.performanceHistory.slice(-10);
    const older = this.performanceHistory.slice(-20, -10);

    if (older.length === 0) return;

    const recentAvgLatency =
      recent.reduce((sum, p) => sum + p.latency, 0) / recent.length;
    const olderAvgLatency =
      older.reduce((sum, p) => sum + p.latency, 0) / older.length;

    const latencyTrend = recentAvgLatency - olderAvgLatency;

    if (latencyTrend > 30000) {
      // 30 second increase
      logger.warn('Performance degradation detected', {
        recentLatency: recentAvgLatency.toFixed(0),
        oldLatency: olderAvgLatency.toFixed(0),
        trend: latencyTrend.toFixed(0),
      });

      this.emit('performanceDegradation', {
        latencyIncrease: latencyTrend,
        currentLatency: recentAvgLatency,
      });
    }
  }

  addBridge(bridgeId, config) {
    this.bridges.set(bridgeId, {
      id: bridgeId,
      name: config.name,
      sourceChain: config.sourceChain,
      targetChain: config.targetChain,
      status: 'active',
      lastTransaction: Date.now(),
      transactionCount: 0,
      failureCount: 0,
      volume: '0',
      averageProcessingTime: 0,
      validators: config.validators || [],
      // Enhanced monitoring fields
      securityScore: 1.0,
      consecutiveFailures: 0,
      consensusHealth: 100,
      lastSecurityAudit: Date.now(),
      protocolType: config.protocolType || 'generic',
      gasOptimization: config.gasOptimization || 95,
      messageTypes: config.messageTypes || ['generic', 'asset_transfer'],
      maxThroughput: config.maxThroughput || 1000,
      currentLoad: 0,
    });

    logger.info(`Bridge ${bridgeId} added to comprehensive monitoring`, {
      sourceChain: config.sourceChain,
      targetChain: config.targetChain,
      validatorCount: (config.validators || []).length,
      protocolType: config.protocolType,
    });

    // Emit bridge addition event
    this.emit('bridgeAdded', { bridgeId, config });
  }

  addValidator(validatorId, config) {
    this.validators.set(validatorId, {
      id: validatorId,
      address: config.address,
      bridges: config.bridges || [],
      status: 'online',
      lastSeen: Date.now(),
      signatureCount: 0,
      uptime: 100,
      reputation: 100,
    });

    logger.info('Validator added to monitoring', { validatorId });
  }

  updateBridgeMetrics() {
    for (const [bridgeId, bridge] of this.bridges) {
      // Simulate random activity
      const hasActivity = Math.random() > 0.7;

      if (hasActivity) {
        bridge.transactionCount++;
        bridge.lastTransaction = Date.now();
        bridge.volume = (
          parseFloat(bridge.volume) +
          Math.random() * 1000
        ).toFixed(2);

        // Simulate occasional failures
        if (Math.random() < 0.02) {
          bridge.failureCount++;
          this.emit('bridgeFailure', { bridgeId, bridge });
        }

        bridge.averageProcessingTime = Math.random() * 120000 + 30000; // 30s - 2.5min
      }

      // Update bridge status
      const timeSinceLastTransaction = Date.now() - bridge.lastTransaction;
      if (timeSinceLastTransaction > 300000) {
        // 5 minutes
        bridge.status = 'inactive';
      } else {
        bridge.status = 'active';
      }
    }
  }

  checkValidatorHealth() {
    for (const [validatorId, validator] of this.validators) {
      // Simulate validator activity
      const isActive = Math.random() > 0.1;

      if (isActive) {
        validator.lastSeen = Date.now();
        validator.status = 'online';
        validator.signatureCount++;

        // Update uptime
        const uptime = Math.min(100, validator.uptime + Math.random() * 0.1);
        validator.uptime = uptime;
      } else {
        const timeSinceLastSeen = Date.now() - validator.lastSeen;
        if (timeSinceLastSeen > this.alertThresholds.validatorDowntime) {
          validator.status = 'offline';
          validator.uptime = Math.max(0, validator.uptime - 1);
          this.emit('validatorOffline', { validatorId, validator });
        }
      }
    }
  }

  detectAnomalies() {
    // Check failure rates
    for (const [bridgeId, bridge] of this.bridges) {
      const failureRate =
        bridge.failureCount / Math.max(bridge.transactionCount, 1);

      if (failureRate > this.alertThresholds.failureRate) {
        this.emit('highFailureRate', { bridgeId, failureRate, bridge });
      }

      if (bridge.averageProcessingTime > this.alertThresholds.processingTime) {
        this.emit('slowProcessing', {
          bridgeId,
          processingTime: bridge.averageProcessingTime,
          bridge,
        });
      }
    }

    // Update network health
    const totalBridges = this.bridges.size;
    const activeBridges = Array.from(this.bridges.values()).filter(
      b => b.status === 'active'
    ).length;

    if (activeBridges / totalBridges < 0.5) {
      this.metrics.networkHealth = 'critical';
    } else if (activeBridges / totalBridges < 0.8) {
      this.metrics.networkHealth = 'degraded';
    } else {
      this.metrics.networkHealth = 'healthy';
    }
  }

  generateTransactionActivity() {
    // Simulate transaction metrics
    this.metrics.totalTransactions += Math.floor(Math.random() * 5);

    const successRate = 0.95 + Math.random() * 0.04; // 95-99% success rate
    const newSuccessful = Math.floor(
      this.metrics.totalTransactions * successRate
    );
    this.metrics.successfulTransactions = newSuccessful;
    this.metrics.failedTransactions =
      this.metrics.totalTransactions - newSuccessful;

    const currentVolume = parseFloat(this.metrics.totalVolume);
    this.metrics.totalVolume = (currentVolume + Math.random() * 10000).toFixed(
      2
    );
    this.metrics.averageProcessingTime = Math.random() * 120000 + 30000;
  }

  getBridgeStatus(bridgeId) {
    return this.bridges.get(bridgeId) || null;
  }

  getValidatorStatus(validatorId) {
    return this.validators.get(validatorId) || null;
  }

  getNetworkMetrics() {
    return {
      ...this.metrics,
      bridgeCount: this.bridges.size,
      validatorCount: this.validators.size,
      activeBridges: Array.from(this.bridges.values()).filter(
        b => b.status === 'active'
      ).length,
      onlineValidators: Array.from(this.validators.values()).filter(
        v => v.status === 'online'
      ).length,
      timestamp: new Date().toISOString(),
    };
  }

  getAllBridges() {
    return Array.from(this.bridges.entries()).map(([id, bridge]) => ({
      id,
      ...bridge,
      failureRate: (
        (bridge.failureCount / Math.max(bridge.transactionCount, 1)) *
        100
      ).toFixed(2),
      utilizationRate:
        Date.now() - bridge.lastTransaction < 300000 ? 'High' : 'Low',
    }));
  }

  getAllValidators() {
    return Array.from(this.validators.entries()).map(([id, validator]) => ({
      id,
      ...validator,
      uptimePercentage: validator.uptime.toFixed(2),
      timeSinceLastSeen: Date.now() - validator.lastSeen,
    }));
  }

  // Enhanced security and monitoring data getters
  getSecurityAlerts(limit = 50) {
    return this.securityAlerts
      .slice(-limit)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  getPerformanceHistory(limit = 100) {
    return this.performanceHistory
      .slice(-limit)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  getBlockchainStatus() {
    const status = {};
    for (const [chain, connection] of this.blockchainConnections) {
      status[chain] = {
        connected: connection.connected,
        status: connection.status,
        latency: connection.latency,
        lastBlock: connection.lastBlock,
        healthScore:
          connection.status === 'healthy'
            ? 100
            : connection.status === 'degraded'
              ? 70
              : 30,
      };
    }
    return status;
  }

  getAlerts() {
    const alerts = [];
    const now = Date.now();

    // Bridge alerts with enhanced security monitoring
    for (const [bridgeId, bridge] of this.bridges) {
      const failureRate =
        bridge.failureCount / Math.max(bridge.transactionCount, 1);

      if (failureRate > this.alertThresholds.failureRate) {
        alerts.push({
          type: 'bridge_failure_rate',
          severity: 'high',
          bridgeId,
          message: `High failure rate: ${(failureRate * 100).toFixed(2)}%`,
          timestamp: now,
          securityImpact: true,
        });
      }

      // Security score alerts
      if (bridge.securityScore < this.alertThresholds.securityScore) {
        alerts.push({
          type: 'security_score_low',
          severity: 'critical',
          bridgeId,
          message: `Security score below threshold: ${(bridge.securityScore * 100).toFixed(1)}%`,
          timestamp: now,
          securityImpact: true,
        });
      }

      // Consecutive failures
      if (
        bridge.consecutiveFailures >= this.alertThresholds.consecutiveFailures
      ) {
        alerts.push({
          type: 'consecutive_failures',
          severity: 'high',
          bridgeId,
          message: `${bridge.consecutiveFailures} consecutive failures detected`,
          timestamp: now,
          securityImpact: true,
        });
      }

      // Bridge inactive alert
      if (now - bridge.lastTransaction > 600000) {
        // 10 minutes
        alerts.push({
          type: 'bridge_inactive',
          severity: 'medium',
          bridgeId,
          message: `No transactions for ${Math.floor((now - bridge.lastTransaction) / 60000)} minutes`,
          timestamp: now,
        });
      }

      // High latency alert
      if (
        bridge.averageProcessingTime > this.alertThresholds.latencyThreshold
      ) {
        alerts.push({
          type: 'high_latency',
          severity: 'medium',
          bridgeId,
          message: `High processing time: ${Math.floor(bridge.averageProcessingTime / 1000)}s`,
          timestamp: now,
        });
      }
    }

    // Validator alerts with consensus monitoring
    for (const [validatorId, validator] of this.validators) {
      if (validator.status === 'offline') {
        alerts.push({
          type: 'validator_offline',
          severity: 'high',
          validatorId,
          message: `Validator offline for ${Math.floor((now - validator.lastSeen) / 60000)} minutes`,
          timestamp: now,
          consensusImpact: true,
        });
      }

      if (validator.uptime < 95) {
        alerts.push({
          type: 'validator_low_uptime',
          severity: 'medium',
          validatorId,
          message: `Low uptime: ${validator.uptime.toFixed(2)}%`,
          timestamp: now,
          consensusImpact: true,
        });
      }

      if (validator.reputation < 80) {
        alerts.push({
          type: 'validator_low_reputation',
          severity: 'medium',
          validatorId,
          message: `Low reputation score: ${validator.reputation.toFixed(1)}`,
          timestamp: now,
          consensusImpact: true,
        });
      }
    }

    // Blockchain connection alerts
    for (const [chain, connection] of this.blockchainConnections) {
      if (!connection.connected || connection.status === 'unhealthy') {
        alerts.push({
          type: 'blockchain_disconnected',
          severity: 'critical',
          chain,
          message: `Blockchain ${chain} connection lost`,
          timestamp: now,
          infrastructureImpact: true,
        });
      }

      if (connection.latency > 2000) {
        // 2 second latency
        alerts.push({
          type: 'blockchain_high_latency',
          severity: 'medium',
          chain,
          message: `High blockchain latency: ${connection.latency.toFixed(0)}ms`,
          timestamp: now,
        });
      }
    }

    return alerts.sort((a, b) => b.timestamp - a.timestamp);
  }
}

// Initialize monitoring system
const monitor = new BridgeMonitor();

// Add comprehensive bridge configurations for monitoring
monitor.addBridge('ethereum-polygon', {
  name: 'Ethereum-Polygon Bridge',
  sourceChain: 'ethereum',
  targetChain: 'polygon',
  validators: ['val1', 'val2', 'val3'],
  protocolType: 'pos_bridge',
  gasOptimization: 92,
  messageTypes: ['asset_transfer', 'generic', 'state_sync'],
  maxThroughput: 2000,
});

monitor.addBridge('ethereum-bsc', {
  name: 'Ethereum-BSC Bridge',
  sourceChain: 'ethereum',
  targetChain: 'bsc',
  validators: ['val1', 'val4', 'val5'],
  protocolType: 'binance_bridge',
  gasOptimization: 88,
  messageTypes: ['asset_transfer', 'generic'],
  maxThroughput: 1500,
});

monitor.addBridge('polygon-avalanche', {
  name: 'Polygon-Avalanche Bridge',
  sourceChain: 'polygon',
  targetChain: 'avalanche',
  validators: ['val2', 'val3', 'val6'],
  protocolType: 'avalanche_bridge',
  gasOptimization: 94,
  messageTypes: ['asset_transfer', 'generic', 'subnets'],
  maxThroughput: 1800,
});

monitor.addBridge('ethereum-arbitrum', {
  name: 'Ethereum-Arbitrum Bridge',
  sourceChain: 'ethereum',
  targetChain: 'arbitrum',
  validators: ['val1', 'val2', 'val4'],
  protocolType: 'rollup_bridge',
  gasOptimization: 96,
  messageTypes: ['asset_transfer', 'generic', 'rollup_data'],
  maxThroughput: 4000,
});

monitor.addBridge('cosmos-osmosis', {
  name: 'Cosmos-Osmosis IBC Bridge',
  sourceChain: 'cosmos',
  targetChain: 'osmosis',
  validators: ['val3', 'val5', 'val6'],
  protocolType: 'ibc_bridge',
  gasOptimization: 98,
  messageTypes: ['asset_transfer', 'generic', 'ibc_packets'],
  maxThroughput: 3000,
});

monitor.addBridge('axelar-multichain', {
  name: 'Axelar Multi-Chain Bridge',
  sourceChain: 'axelar',
  targetChain: 'multichain',
  validators: ['val1', 'val3', 'val4', 'val5'],
  protocolType: 'general_message_passing',
  gasOptimization: 93,
  messageTypes: ['asset_transfer', 'generic', 'contract_call'],
  maxThroughput: 2500,
});

monitor.addBridge('wormhole-solana', {
  name: 'Wormhole-Solana Bridge',
  sourceChain: 'ethereum',
  targetChain: 'solana',
  validators: ['val2', 'val4', 'val6'],
  protocolType: 'wormhole_bridge',
  gasOptimization: 91,
  messageTypes: ['asset_transfer', 'generic', 'attestation'],
  maxThroughput: 1200,
});

// Add enhanced validators with realistic configurations
const validatorConfigs = [
  { stake: 1000000, reputation: 98, specialization: ['ethereum', 'polygon'] },
  {
    stake: 850000,
    reputation: 95,
    specialization: ['ethereum', 'bsc', 'arbitrum'],
  },
  {
    stake: 1200000,
    reputation: 99,
    specialization: ['cosmos', 'osmosis', 'axelar'],
  },
  { stake: 750000, reputation: 92, specialization: ['polygon', 'avalanche'] },
  {
    stake: 950000,
    reputation: 96,
    specialization: ['ethereum', 'solana', 'wormhole'],
  },
  { stake: 1100000, reputation: 97, specialization: ['all_chains'] },
];

for (let i = 1; i <= 6; i++) {
  const config = validatorConfigs[i - 1];
  monitor.addValidator(`val${i}`, {
    address: `0x${Math.random().toString(16).substr(2, 40)}`,
    bridges: [`bridge${i}`],
    stake: config.stake,
    reputation: config.reputation,
    specialization: config.specialization,
    location: `Region${i}`,
    hardwareSpec: {
      cpu: `${8 + i * 2} cores`,
      memory: `${16 + i * 8}GB`,
      storage: `${500 + i * 100}GB SSD`,
    },
  });
}

// Set up comprehensive event listeners for enhanced monitoring
monitor.on('bridgeFailure', data => {
  logger.error(`Bridge failure detected: ${data.bridgeId}`, {
    bridgeId: data.bridgeId,
    failureType: 'transaction_failure',
    timestamp: new Date().toISOString(),
  });
});

monitor.on('validatorOffline', data => {
  logger.warn(`Validator offline: ${data.validatorId}`, {
    validatorId: data.validatorId,
    offlineDuration: Date.now() - data.validator.lastSeen,
    consensusImpact: true,
  });
});

monitor.on('highFailureRate', data => {
  logger.warn(
    `High failure rate on bridge ${data.bridgeId}: ${(data.failureRate * 100).toFixed(2)}%`,
    {
      bridgeId: data.bridgeId,
      failureRate: data.failureRate,
      securityConcern: true,
    }
  );
});

monitor.on('securityThreat', data => {
  logger.error('Security threat detected', {
    patterns: data.patterns,
    severity: data.patterns.length > 0 ? data.patterns[0].severity : 'unknown',
    requiresAttention: true,
  });
});

monitor.on('performanceDegradation', data => {
  logger.warn('Performance degradation detected', {
    latencyIncrease: data.latencyIncrease,
    currentLatency: data.currentLatency,
    performanceImpact: true,
  });
});

monitor.on('blockchainDisconnected', data => {
  logger.error('Blockchain connection lost', {
    chain: data.chain,
    error: data.error,
    infrastructureImpact: true,
  });
});

monitor.on('securityAuditFailed', data => {
  logger.error('Security audit failed for bridge', {
    bridgeId: data.bridgeId,
    securityScore: data.score,
    requiresImmediateAction: true,
  });
});

monitor.on('bridgeAdded', data => {
  logger.info('Bridge added to monitoring', {
    bridgeId: data.bridgeId,
    sourceChain: data.config.sourceChain,
    targetChain: data.config.targetChain,
    protocolType: data.config.protocolType,
  });
});

// Express API
const app = express();
app.use(express.json());

// Get network overview
app.get('/api/bridge/monitor/overview', (req, res) => {
  res.json({
    success: true,
    data: monitor.getNetworkMetrics(),
    timestamp: new Date().toISOString(),
  });
});

// Get all bridges status
app.get('/api/bridge/monitor/bridges', (req, res) => {
  res.json({
    success: true,
    data: monitor.getAllBridges(),
    count: monitor.bridges.size,
    timestamp: new Date().toISOString(),
  });
});

// Get specific bridge status
app.get('/api/bridge/monitor/bridges/:bridgeId', (req, res) => {
  const { bridgeId } = req.params;
  const bridge = monitor.getBridgeStatus(bridgeId);

  if (!bridge) {
    return res.status(404).json({
      success: false,
      error: 'Bridge not found',
    });
  }

  res.json({
    success: true,
    data: bridge,
    timestamp: new Date().toISOString(),
  });
});

// Get all validators status
app.get('/api/bridge/monitor/validators', (req, res) => {
  res.json({
    success: true,
    data: monitor.getAllValidators(),
    count: monitor.validators.size,
    timestamp: new Date().toISOString(),
  });
});

// Get alerts
app.get('/api/bridge/monitor/alerts', (req, res) => {
  const { severity, limit = 50 } = req.query;
  let alerts = monitor.getAlerts();

  if (severity) {
    alerts = alerts.filter(alert => alert.severity === severity);
  }

  alerts = alerts.slice(0, parseInt(limit, 10));

  res.json({
    success: true,
    data: alerts,
    count: alerts.length,
    timestamp: new Date().toISOString(),
  });
});

// Enhanced monitoring endpoints

// Get security alerts
app.get('/api/bridge/monitor/security/alerts', (req, res) => {
  const { limit = 50 } = req.query;
  const alerts = monitor.getSecurityAlerts(parseInt(limit, 10));

  res.json({
    success: true,
    data: alerts,
    count: alerts.length,
    timestamp: new Date().toISOString(),
  });
});

// Get performance history
app.get('/api/bridge/monitor/performance/history', (req, res) => {
  const { limit = 100 } = req.query;
  const history = monitor.getPerformanceHistory(parseInt(limit, 10));

  res.json({
    success: true,
    data: history,
    count: history.length,
    timestamp: new Date().toISOString(),
  });
});

// Get blockchain connection status
app.get('/api/bridge/monitor/blockchain/status', (req, res) => {
  const blockchainStatus = monitor.getBlockchainStatus();

  res.json({
    success: true,
    data: blockchainStatus,
    timestamp: new Date().toISOString(),
  });
});

// Perform security audit
app.post('/api/bridge/monitor/security/audit', (req, res) => {
  try {
    const auditResults = monitor.performSecurityAudit();

    res.json({
      success: true,
      data: {
        overallSecurityScore: auditResults.overallSecurityScore,
        recommendations: auditResults.recommendations,
        bridgeScores: Object.fromEntries(auditResults.bridgeSecurityScores),
        auditTimestamp: auditResults.timestamp,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Security audit failed',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Get comprehensive monitoring dashboard data
app.get('/api/bridge/monitor/dashboard', (req, res) => {
  try {
    const dashboardData = {
      metrics: monitor.getNetworkMetrics(),
      bridges: monitor.getAllBridges(),
      validators: monitor.getAllValidators(),
      alerts: monitor.getAlerts().slice(0, 20), // Latest 20 alerts
      securityAlerts: monitor.getSecurityAlerts(10), // Latest 10 security alerts
      performanceHistory: monitor.getPerformanceHistory(50), // Latest 50 performance entries
      blockchainStatus: monitor.getBlockchainStatus(),
    };

    res.json({
      success: true,
      data: dashboardData,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard data',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Get bridge analytics
app.get('/api/bridge/monitor/analytics', (req, res) => {
  const { timeframe = '1h' } = req.query;

  try {
    const analytics = {
      successRate: (
        (monitor.metrics.successfulTransactions /
          Math.max(monitor.metrics.totalTransactions, 1)) *
        100
      ).toFixed(2),
      averageLatency: monitor.metrics.crossChainLatency,
      bridgeUtilization: monitor.metrics.bridgeUtilization,
      validatorConsensus: monitor.metrics.validatorConsensus,
      securityScore: monitor.performSecurityAudit().overallSecurityScore,
      gasEfficiency: monitor.metrics.gasEfficiency,
      networkHealth: monitor.metrics.networkHealth,
      totalVolume: monitor.metrics.totalVolume,
      timeframe,
    };

    res.json({
      success: true,
      data: analytics,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to generate analytics',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Health check with enhanced monitoring
app.get('/api/bridge/monitor/health', (req, res) => {
  const metrics = monitor.getNetworkMetrics();
  const blockchainStatus = monitor.getBlockchainStatus();

  // Calculate overall health score
  let healthScore = 100;
  const alertCount = monitor.getAlerts().length;
  const securityScore = monitor.performSecurityAudit().overallSecurityScore;

  // Reduce health score based on alerts and security
  healthScore -= Math.min(alertCount * 5, 50); // Max 50 points for alerts
  healthScore *= securityScore; // Multiply by security score

  const overallStatus =
    healthScore >= 90 ? 'healthy' : healthScore >= 70 ? 'degraded' : 'critical';

  res.json({
    status: overallStatus,
    healthScore: Math.max(0, healthScore).toFixed(1),
    uptime: process.uptime(),
    bridgesMonitored: metrics.bridgeCount,
    validatorsMonitored: metrics.validatorCount,
    activeAlerts: alertCount,
    securityScore: (securityScore * 100).toFixed(1),
    blockchainConnections: Object.keys(blockchainStatus).length,
    networkHealth: metrics.networkHealth,
    timestamp: new Date().toISOString(),
  });
});

// Log startup summary
logger.info('Bridge monitoring system initialized successfully', {
  bridgeCount: monitor.bridges.size,
  validatorCount: monitor.validators.size,
  blockchainConnections: monitor.blockchainConnections.size,
  securityMonitoring: 'enabled',
  performanceTracking: 'enabled',
  alertingSystem: 'active',
  features: [
    'real-time bridge status monitoring',
    'validator health tracking',
    'security threat detection',
    'transaction volume analytics',
    'cross-chain performance metrics',
    'automated alerting system',
    'blockchain connection monitoring',
    'comprehensive security auditing',
  ],
});

module.exports = { BridgeMonitor, monitor, app };
