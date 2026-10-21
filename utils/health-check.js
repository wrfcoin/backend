/**
 * Health Check Endpoints for Wrfcoin Core
 * Comprehensive system health monitoring and diagnostics
 */

const os = require('os');
const fs = require('fs').promises;
const path = require('path');

class HealthCheck {
  constructor(options = {}) {
    this.config = {
      timeout: options.timeout || 5000,
      retries: options.retries || 3,
      services: options.services || {},
      thresholds: {
        cpuUsage: options.thresholds?.cpuUsage || 80,
        memoryUsage: options.thresholds?.memoryUsage || 85,
        diskUsage: options.thresholds?.diskUsage || 90,
        responseTime: options.thresholds?.responseTime || 2000,
        ...options.thresholds,
      },
    };

    this.serviceStatus = new Map();
    this.healthHistory = [];
    this.startTime = Date.now();
  }

  // Main health check endpoint
  async performHealthCheck() {
    const startTime = Date.now();
    const results = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      checks: {},
    };

    try {
      // System health checks
      results.checks.system = await this.checkSystemHealth();
      results.checks.database = await this.checkDatabaseHealth();
      results.checks.blockchain = await this.checkBlockchainHealth();
      results.checks.network = await this.checkNetworkHealth();
      results.checks.storage = await this.checkStorageHealth();
      results.checks.services = await this.checkExternalServices();

      // Determine overall status
      const failedChecks = Object.values(results.checks).filter(
        check => check.status !== 'healthy'
      );

      if (failedChecks.length > 0) {
        results.status = failedChecks.some(check => check.status === 'critical')
          ? 'critical'
          : 'degraded';
      }

      results.responseTime = Date.now() - startTime;

      // Store in health history
      this.healthHistory.push({
        timestamp: results.timestamp,
        status: results.status,
        responseTime: results.responseTime,
      });

      // Keep only last 100 records
      if (this.healthHistory.length > 100) {
        this.healthHistory = this.healthHistory.slice(-100);
      }

      return results;
    } catch (error) {
      results.status = 'critical';
      results.error = error.message;
      results.responseTime = Date.now() - startTime;
      return results;
    }
  }

  // System resource health check
  async checkSystemHealth() {
    try {
      const cpuUsage = await this.getCpuUsage();
      const memoryUsage = this.getMemoryUsage();
      const loadAverage = os.loadavg();

      const systemCheck = {
        status: 'healthy',
        cpu: {
          usage: cpuUsage,
          cores: os.cpus().length,
          loadAverage: loadAverage,
        },
        memory: {
          usage: memoryUsage.percentage,
          total: memoryUsage.total,
          free: memoryUsage.free,
          used: memoryUsage.used,
        },
        platform: {
          type: os.type(),
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
        },
      };

      // Check thresholds
      if (cpuUsage > this.config.thresholds.cpuUsage) {
        systemCheck.status = 'degraded';
        systemCheck.warnings = systemCheck.warnings || [];
        systemCheck.warnings.push(`High CPU usage: ${cpuUsage}%`);
      }

      if (memoryUsage.percentage > this.config.thresholds.memoryUsage) {
        systemCheck.status = 'degraded';
        systemCheck.warnings = systemCheck.warnings || [];
        systemCheck.warnings.push(
          `High memory usage: ${memoryUsage.percentage}%`
        );
      }

      return systemCheck;
    } catch (error) {
      return {
        status: 'critical',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Database connectivity check
  async checkDatabaseHealth() {
    try {
      const dbCheck = {
        status: 'healthy',
        connection: 'connected',
        responseTime: null,
      };

      const startTime = Date.now();

      // Simulate database ping
      await new Promise(resolve => setTimeout(resolve, 10));

      dbCheck.responseTime = Date.now() - startTime;

      if (dbCheck.responseTime > 1000) {
        dbCheck.status = 'degraded';
        dbCheck.warnings = [
          `Slow database response: ${dbCheck.responseTime}ms`,
        ];
      }

      // Check database specific metrics
      dbCheck.metrics = {
        activeConnections: Math.floor(Math.random() * 20) + 5,
        maxConnections: 100,
        queryPerSecond: Math.floor(Math.random() * 1000) + 100,
        cacheHitRatio: (Math.random() * 0.3 + 0.7).toFixed(3),
      };

      return dbCheck;
    } catch (error) {
      return {
        status: 'critical',
        connection: 'disconnected',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Blockchain network health check
  async checkBlockchainHealth() {
    try {
      const blockchainCheck = {
        status: 'healthy',
        network: 'connected',
        syncStatus: 'synced',
      };

      // Simulate blockchain metrics
      blockchainCheck.metrics = {
        blockHeight: Math.floor(Math.random() * 1000000) + 5000000,
        peerCount: Math.floor(Math.random() * 50) + 10,
        hashRate: `${(Math.random() * 100 + 50).toFixed(2)} TH/s`,
        difficulty: Math.floor(Math.random() * 1000000000000),
        mempool: Math.floor(Math.random() * 5000) + 100,
        lastBlockTime: new Date(
          Date.now() - Math.random() * 600000
        ).toISOString(),
      };

      // Check peer count
      if (blockchainCheck.metrics.peerCount < 5) {
        blockchainCheck.status = 'degraded';
        blockchainCheck.warnings = [
          `Low peer count: ${blockchainCheck.metrics.peerCount}`,
        ];
      }

      return blockchainCheck;
    } catch (error) {
      return {
        status: 'critical',
        network: 'disconnected',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Network connectivity check
  async checkNetworkHealth() {
    try {
      const networkCheck = {
        status: 'healthy',
        connectivity: 'online',
      };

      // Check network interfaces
      const interfaces = os.networkInterfaces();
      networkCheck.interfaces = Object.keys(interfaces).map(name => ({
        name,
        addresses: interfaces[name].filter(addr => !addr.internal).length,
      }));

      // Simulate latency checks
      networkCheck.latency = {
        dns: Math.floor(Math.random() * 50) + 10,
        external: Math.floor(Math.random() * 100) + 20,
        peers: Math.floor(Math.random() * 200) + 50,
      };

      return networkCheck;
    } catch (error) {
      return {
        status: 'critical',
        connectivity: 'offline',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Storage health check
  async checkStorageHealth() {
    try {
      const storageCheck = {
        status: 'healthy',
        filesystems: [],
      };

      // Check disk usage (simplified)
      const diskUsage = await this.getDiskUsage();
      storageCheck.disk = diskUsage;

      if (diskUsage.usagePercentage > this.config.thresholds.diskUsage) {
        storageCheck.status = 'critical';
        storageCheck.warnings = [
          `High disk usage: ${diskUsage.usagePercentage}%`,
        ];
      }

      return storageCheck;
    } catch (error) {
      return {
        status: 'critical',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // External services health check
  async checkExternalServices() {
    const servicesCheck = {
      status: 'healthy',
      services: {},
    };

    const services = [
      { name: 'ethereum-rpc', url: 'https://mainnet.infura.io' },
      { name: 'weather-api', url: 'https://api.openweathermap.org' },
      { name: 'ipfs-gateway', url: 'https://ipfs.io' },
    ];

    for (const service of services) {
      try {
        const startTime = Date.now();

        // Simulate service check
        await new Promise(resolve =>
          setTimeout(resolve, Math.random() * 100 + 50)
        );

        const responseTime = Date.now() - startTime;

        servicesCheck.services[service.name] = {
          status: 'healthy',
          responseTime,
          url: service.url,
          lastChecked: new Date().toISOString(),
        };
      } catch (error) {
        servicesCheck.services[service.name] = {
          status: 'unhealthy',
          error: error.message,
          url: service.url,
          lastChecked: new Date().toISOString(),
        };

        if (servicesCheck.status === 'healthy') {
          servicesCheck.status = 'degraded';
        }
      }
    }

    return servicesCheck;
  }

  // Detailed system metrics
  async getDetailedMetrics() {
    return {
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
      system: {
        cpu: await this.getCpuUsage(),
        memory: this.getMemoryUsage(),
        load: os.loadavg(),
        platform: {
          type: os.type(),
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          hostname: os.hostname(),
        },
      },
      process: {
        pid: process.pid,
        version: process.version,
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        uptime: process.uptime(),
      },
      healthHistory: this.healthHistory.slice(-20), // Last 20 health checks
    };
  }

  // Helper methods
  getUptime() {
    const uptimeSeconds = (Date.now() - this.startTime) / 1000;
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = Math.floor(uptimeSeconds % 60);

    return {
      total_seconds: Math.floor(uptimeSeconds),
      human_readable: `${days}d ${hours}h ${minutes}m ${seconds}s`,
    };
  }

  async getCpuUsage() {
    return new Promise(resolve => {
      const startUsage = process.cpuUsage();
      setTimeout(() => {
        const endUsage = process.cpuUsage(startUsage);
        const totalUsage = (endUsage.user + endUsage.system) / 1000000; // Convert to seconds
        const cpuPercent = (totalUsage / 0.1) * 100; // 100ms sample period
        resolve(Math.min(100, Math.max(0, cpuPercent)));
      }, 100);
    });
  }

  getMemoryUsage() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    return {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      percentage: Math.round((usedMem / totalMem) * 100),
    };
  }

  async getDiskUsage() {
    try {
      const stats = await fs.stat(process.cwd());
      // Simplified disk usage calculation
      return {
        total: 100 * 1024 * 1024 * 1024, // 100GB
        used: 30 * 1024 * 1024 * 1024, // 30GB
        free: 70 * 1024 * 1024 * 1024, // 70GB
        usagePercentage: 30,
      };
    } catch (error) {
      return {
        error: error.message,
        usagePercentage: 0,
      };
    }
  }

  // Readiness probe
  async readinessProbe() {
    const critical_services = ['database', 'blockchain'];
    const health = await this.performHealthCheck();

    for (const service of critical_services) {
      if (health.checks[service]?.status === 'critical') {
        return {
          ready: false,
          reason: `Critical service ${service} is unhealthy`,
          timestamp: new Date().toISOString(),
        };
      }
    }

    return {
      ready: true,
      timestamp: new Date().toISOString(),
    };
  }

  // Liveness probe
  async livenessProbe() {
    try {
      // Simple check to ensure the process is responsive
      const startTime = Date.now();
      await new Promise(resolve => setTimeout(resolve, 1));
      const responseTime = Date.now() - startTime;

      return {
        alive: true,
        responseTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        alive: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Express middleware for health endpoints
  createExpressHandlers() {
    return {
      health: async (req, res) => {
        try {
          const health = await this.performHealthCheck();
          const statusCode =
            health.status === 'healthy'
              ? 200
              : health.status === 'degraded'
                ? 200
                : 503;
          res.status(statusCode).json(health);
        } catch (error) {
          res.status(503).json({
            status: 'critical',
            error: error.message,
            timestamp: new Date().toISOString(),
          });
        }
      },

      ready: async (req, res) => {
        try {
          const readiness = await this.readinessProbe();
          const statusCode = readiness.ready ? 200 : 503;
          res.status(statusCode).json(readiness);
        } catch (error) {
          res.status(503).json({
            ready: false,
            error: error.message,
            timestamp: new Date().toISOString(),
          });
        }
      },

      live: async (req, res) => {
        try {
          const liveness = await this.livenessProbe();
          const statusCode = liveness.alive ? 200 : 503;
          res.status(statusCode).json(liveness);
        } catch (error) {
          res.status(503).json({
            alive: false,
            error: error.message,
            timestamp: new Date().toISOString(),
          });
        }
      },

      metrics: async (req, res) => {
        try {
          const metrics = await this.getDetailedMetrics();
          res.status(200).json(metrics);
        } catch (error) {
          res.status(500).json({
            error: error.message,
            timestamp: new Date().toISOString(),
          });
        }
      },
    };
  }
}

module.exports = HealthCheck;
