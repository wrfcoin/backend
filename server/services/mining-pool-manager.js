/**
 * Mining Pool Management Service
 * Handles pool discovery, connection management, load balancing, and mining coordination
 */

const { logger } = require('../utils/logger');
const EventEmitter = require('events');

class MiningPoolManager extends EventEmitter {
  constructor() {
    super();
    this.pools = new Map();
    this.activePools = new Set();
    this.poolStats = new Map();
    this.connectionHealthChecks = new Map();
    this.loadBalancingStrategy = 'round_robin'; // round_robin, hash_rate, latency
    this.poolFailoverEnabled = true;
    this.maxPoolConnections = 3;
    this.healthCheckInterval = 30000; // 30 seconds

    // Default pool configurations
    this.defaultPools = [
      {
        id: 'wrfcoin-primary',
        name: 'WRFCoin Primary Pool',
        url: 'stratum+tcp://pool1.wrfcoin.io:4444',
        backup_url: 'stratum+tcp://backup1.wrfcoin.io:4444',
        fee: 1.0,
        location: 'us-east',
        algorithm: 'climate_proof_of_work',
        priority: 1,
        active: true,
      },
      {
        id: 'wrfcoin-secondary',
        name: 'WRFCoin Secondary Pool',
        url: 'stratum+tcp://pool2.wrfcoin.io:4444',
        backup_url: 'stratum+tcp://backup2.wrfcoin.io:4444',
        fee: 1.5,
        location: 'eu-west',
        algorithm: 'climate_proof_of_work',
        priority: 2,
        active: true,
      },
      {
        id: 'wrfcoin-asia',
        name: 'WRFCoin Asia Pool',
        url: 'stratum+tcp://asia.wrfcoin.io:4444',
        backup_url: 'stratum+tcp://asia-backup.wrfcoin.io:4444',
        fee: 1.2,
        location: 'asia-pacific',
        algorithm: 'climate_proof_of_work',
        priority: 3,
        active: true,
      },
    ];

    this.initializePools();
    this.startHealthChecks();
  }

  /**
   * Initialize default mining pools
   */
  initializePools() {
    try {
      logger.info('Initializing mining pools');

      this.defaultPools.forEach(poolConfig => {
        this.pools.set(poolConfig.id, {
          ...poolConfig,
          status: 'disconnected',
          latency: null,
          hashrate: 0,
          workers: 0,
          shares_accepted: 0,
          shares_rejected: 0,
          uptime: 0,
          last_seen: null,
          connection_attempts: 0,
          max_connection_attempts: 3,
        });
      });

      logger.info(`Initialized ${this.pools.size} mining pools`);
    } catch (error) {
      logger.error('Error initializing mining pools:', error);
      throw error;
    }
  }

  /**
   * Start health check monitoring for all pools
   */
  startHealthChecks() {
    logger.info('Starting pool health checks');

    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks();
    }, this.healthCheckInterval);
  }

  /**
   * Stop health check monitoring
   */
  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Perform health checks on all active pools
   */
  async performHealthChecks() {
    try {
      const healthCheckPromises = Array.from(this.pools.values())
        .filter(pool => pool.active)
        .map(pool => this.checkPoolHealth(pool));

      await Promise.allSettled(healthCheckPromises);

      // Update pool rankings based on health
      this.updatePoolRankings();
    } catch (error) {
      logger.error('Error performing pool health checks:', error);
    }
  }

  /**
   * Check health of a specific pool
   */
  async checkPoolHealth(pool) {
    try {
      const startTime = Date.now();

      // Simulate network latency check
      const latency = await this.pingPool(pool);
      const endTime = Date.now();

      if (latency !== null) {
        pool.status = 'connected';
        pool.latency = latency;
        pool.last_seen = new Date();
        pool.connection_attempts = 0;

        // Update pool stats
        this.updatePoolStats(pool.id, {
          latency,
          response_time: endTime - startTime,
          health_score: this.calculateHealthScore(pool),
        });

        this.emit('pool_health_updated', {
          pool_id: pool.id,
          status: 'healthy',
          latency,
          health_score: this.calculateHealthScore(pool),
        });
      } else {
        pool.connection_attempts++;

        if (pool.connection_attempts >= pool.max_connection_attempts) {
          pool.status = 'disconnected';
          this.emit('pool_health_updated', {
            pool_id: pool.id,
            status: 'unhealthy',
            attempts: pool.connection_attempts,
          });
        }
      }
    } catch (error) {
      logger.error(`Error checking health for pool ${pool.id}:`, error);
      pool.status = 'error';
    }
  }

  /**
   * Simulate ping to mining pool
   */
  async pingPool(pool) {
    try {
      // Simulate network latency (50-200ms for healthy pools)
      const baseLatency = 50;
      const variance = Math.random() * 150;
      const simulatedLatency = baseLatency + variance;

      // Simulate occasional connection failures (5% chance)
      if (Math.random() < 0.05) {
        return null;
      }

      return Math.round(simulatedLatency);
    } catch (error) {
      logger.error(`Error pinging pool ${pool.id}:`, error);
      return null;
    }
  }

  /**
   * Calculate health score for a pool
   */
  calculateHealthScore(pool) {
    let score = 100;

    // Latency factor (lower is better)
    if (pool.latency > 200) score -= 30;
    else if (pool.latency > 100) score -= 15;
    else if (pool.latency > 50) score -= 5;

    // Fee factor (lower is better)
    score -= pool.fee * 10;

    // Connection stability factor
    if (pool.connection_attempts > 0) {
      score -= pool.connection_attempts * 10;
    }

    // Uptime factor
    if (pool.uptime < 95) score -= 20;
    else if (pool.uptime < 99) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Update pool rankings based on health scores
   */
  updatePoolRankings() {
    const healthyPools = Array.from(this.pools.values())
      .filter(pool => pool.status === 'connected')
      .sort(
        (a, b) => this.calculateHealthScore(b) - this.calculateHealthScore(a)
      );

    this.emit('pool_rankings_updated', {
      pools: healthyPools.map(pool => ({
        id: pool.id,
        name: pool.name,
        health_score: this.calculateHealthScore(pool),
        latency: pool.latency,
        fee: pool.fee,
      })),
    });
  }

  /**
   * Get best available pool based on current strategy
   */
  getBestPool(options = {}) {
    const algorithm = options.algorithm || 'climate_proof_of_work';
    const location = options.preferred_location || null;

    const availablePools = Array.from(this.pools.values()).filter(
      pool =>
        pool.active &&
        pool.status === 'connected' &&
        pool.algorithm === algorithm
    );

    if (availablePools.length === 0) {
      logger.warn('No available pools found for algorithm:', algorithm);
      return null;
    }

    let selectedPool;

    switch (this.loadBalancingStrategy) {
      case 'hash_rate':
        selectedPool = availablePools.sort(
          (a, b) => b.hashrate - a.hashrate
        )[0];
        break;

      case 'latency':
        selectedPool = availablePools.sort((a, b) => a.latency - b.latency)[0];
        break;

      case 'health_score':
        selectedPool = availablePools.sort(
          (a, b) => this.calculateHealthScore(b) - this.calculateHealthScore(a)
        )[0];
        break;

      case 'round_robin':
      default:
        // Simple round-robin selection
        const lastUsedIndex = this.lastRoundRobinIndex || 0;
        const nextIndex = (lastUsedIndex + 1) % availablePools.length;
        selectedPool = availablePools[nextIndex];
        this.lastRoundRobinIndex = nextIndex;
        break;
    }

    // Prefer pools in specific location if requested
    if (location) {
      const locationPools = availablePools.filter(pool =>
        pool.location.includes(location)
      );
      if (locationPools.length > 0) {
        selectedPool = locationPools[0];
      }
    }

    logger.info(`Selected pool: ${selectedPool.name} (${selectedPool.id})`, {
      strategy: this.loadBalancingStrategy,
      health_score: this.calculateHealthScore(selectedPool),
      latency: selectedPool.latency,
    });

    return selectedPool;
  }

  /**
   * Connect to a mining pool
   */
  async connectToPool(poolId, minerConfig = {}) {
    try {
      const pool = this.pools.get(poolId);
      if (!pool) {
        throw new Error(`Pool not found: ${poolId}`);
      }

      logger.info(`Connecting to mining pool: ${pool.name}`);

      // Simulate connection process
      const connectionResult = await this.establishPoolConnection(
        pool,
        minerConfig
      );

      if (connectionResult.success) {
        this.activePools.add(poolId);
        pool.status = 'connected';
        pool.workers = minerConfig.workers || 1;

        this.emit('pool_connected', {
          pool_id: poolId,
          pool_name: pool.name,
          url: pool.url,
          algorithm: pool.algorithm,
        });

        logger.info(`Successfully connected to pool: ${pool.name}`);
        return {
          success: true,
          pool_id: poolId,
          connection_id: connectionResult.connection_id,
        };
      } else {
        throw new Error(connectionResult.error);
      }
    } catch (error) {
      logger.error(`Error connecting to pool ${poolId}:`, error);
      this.emit('pool_connection_failed', {
        pool_id: poolId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Simulate establishing pool connection
   */
  async establishPoolConnection(pool, minerConfig) {
    try {
      // Simulate network connection delay
      await new Promise(resolve =>
        setTimeout(resolve, 1000 + Math.random() * 2000)
      );

      // Simulate 95% success rate
      if (Math.random() < 0.95) {
        return {
          success: true,
          connection_id: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          protocol: 'stratum',
          version: '1.0',
        };
      } else {
        return {
          success: false,
          error: 'Connection timeout or pool rejected connection',
        };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Disconnect from a mining pool
   */
  async disconnectFromPool(poolId) {
    try {
      const pool = this.pools.get(poolId);
      if (!pool) {
        throw new Error(`Pool not found: ${poolId}`);
      }

      logger.info(`Disconnecting from mining pool: ${pool.name}`);

      // Simulate disconnection
      await new Promise(resolve => setTimeout(resolve, 500));

      this.activePools.delete(poolId);
      pool.status = 'disconnected';
      pool.workers = 0;

      this.emit('pool_disconnected', {
        pool_id: poolId,
        pool_name: pool.name,
      });

      logger.info(`Successfully disconnected from pool: ${pool.name}`);
      return { success: true };
    } catch (error) {
      logger.error(`Error disconnecting from pool ${poolId}:`, error);
      throw error;
    }
  }

  /**
   * Submit work share to pool
   */
  async submitShare(poolId, shareData) {
    try {
      const pool = this.pools.get(poolId);
      if (!pool || !this.activePools.has(poolId)) {
        throw new Error(`Not connected to pool: ${poolId}`);
      }

      // Simulate share submission
      const isAccepted = Math.random() > 0.02; // 98% acceptance rate

      if (isAccepted) {
        pool.shares_accepted++;
        this.emit('share_accepted', {
          pool_id: poolId,
          share_id: shareData.share_id,
          difficulty: shareData.difficulty,
        });
        return { accepted: true, share_id: shareData.share_id };
      } else {
        pool.shares_rejected++;
        this.emit('share_rejected', {
          pool_id: poolId,
          share_id: shareData.share_id,
          reason: 'stale_share',
        });
        return { accepted: false, reason: 'stale_share' };
      }
    } catch (error) {
      logger.error(`Error submitting share to pool ${poolId}:`, error);
      throw error;
    }
  }

  /**
   * Get pool statistics
   */
  getPoolStats(poolId = null) {
    if (poolId) {
      const pool = this.pools.get(poolId);
      if (!pool) return null;

      return {
        pool_id: poolId,
        name: pool.name,
        status: pool.status,
        latency: pool.latency,
        hashrate: pool.hashrate,
        workers: pool.workers,
        shares_accepted: pool.shares_accepted,
        shares_rejected: pool.shares_rejected,
        acceptance_rate:
          (pool.shares_accepted /
            Math.max(1, pool.shares_accepted + pool.shares_rejected)) *
          100,
        health_score: this.calculateHealthScore(pool),
        uptime: pool.uptime || 99.5,
        fee: pool.fee,
        algorithm: pool.algorithm,
        location: pool.location,
      };
    }

    // Return stats for all pools
    return Array.from(this.pools.entries()).map(([id, pool]) => ({
      pool_id: id,
      name: pool.name,
      status: pool.status,
      latency: pool.latency,
      hashrate: pool.hashrate,
      workers: pool.workers,
      shares_accepted: pool.shares_accepted,
      shares_rejected: pool.shares_rejected,
      acceptance_rate:
        (pool.shares_accepted /
          Math.max(1, pool.shares_accepted + pool.shares_rejected)) *
        100,
      health_score: this.calculateHealthScore(pool),
      uptime: pool.uptime || 99.5,
      fee: pool.fee,
      algorithm: pool.algorithm,
      location: pool.location,
      active: this.activePools.has(id),
    }));
  }

  /**
   * Update pool statistics
   */
  updatePoolStats(poolId, stats) {
    const existingStats = this.poolStats.get(poolId) || {};
    this.poolStats.set(poolId, {
      ...existingStats,
      ...stats,
      updated_at: new Date(),
    });
  }

  /**
   * Set load balancing strategy
   */
  setLoadBalancingStrategy(strategy) {
    const validStrategies = [
      'round_robin',
      'hash_rate',
      'latency',
      'health_score',
    ];
    if (!validStrategies.includes(strategy)) {
      throw new Error(`Invalid load balancing strategy: ${strategy}`);
    }

    this.loadBalancingStrategy = strategy;
    logger.info(`Load balancing strategy set to: ${strategy}`);
  }

  /**
   * Add custom mining pool
   */
  addPool(poolConfig) {
    const requiredFields = ['id', 'name', 'url', 'algorithm'];
    for (const field of requiredFields) {
      if (!poolConfig[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (this.pools.has(poolConfig.id)) {
      throw new Error(`Pool already exists: ${poolConfig.id}`);
    }

    const pool = {
      ...poolConfig,
      status: 'disconnected',
      latency: null,
      hashrate: 0,
      workers: 0,
      shares_accepted: 0,
      shares_rejected: 0,
      uptime: 0,
      last_seen: null,
      connection_attempts: 0,
      max_connection_attempts: 3,
      fee: poolConfig.fee || 1.0,
      priority: poolConfig.priority || 10,
      active: poolConfig.active !== false,
    };

    this.pools.set(poolConfig.id, pool);
    logger.info(`Added custom mining pool: ${poolConfig.name}`);

    return pool;
  }

  /**
   * Remove mining pool
   */
  async removePool(poolId) {
    if (!this.pools.has(poolId)) {
      throw new Error(`Pool not found: ${poolId}`);
    }

    // Disconnect if currently connected
    if (this.activePools.has(poolId)) {
      await this.disconnectFromPool(poolId);
    }

    this.pools.delete(poolId);
    this.poolStats.delete(poolId);

    logger.info(`Removed mining pool: ${poolId}`);
  }

  /**
   * Get network hashrate distribution
   */
  getNetworkHashrateDistribution() {
    const totalHashrate = Array.from(this.pools.values()).reduce(
      (sum, pool) => sum + pool.hashrate,
      0
    );

    return Array.from(this.pools.values()).map(pool => ({
      pool_id: pool.id,
      name: pool.name,
      hashrate: pool.hashrate,
      percentage: totalHashrate > 0 ? (pool.hashrate / totalHashrate) * 100 : 0,
    }));
  }

  /**
   * Cleanup resources
   */
  destroy() {
    this.stopHealthChecks();
    this.removeAllListeners();

    // Disconnect from all active pools
    Promise.all(
      Array.from(this.activePools).map(poolId =>
        this.disconnectFromPool(poolId).catch(err =>
          logger.error(`Error disconnecting from pool ${poolId}:`, err)
        )
      )
    );

    this.pools.clear();
    this.activePools.clear();
    this.poolStats.clear();

    logger.info('Mining pool manager destroyed');
  }
}

module.exports = MiningPoolManager;
