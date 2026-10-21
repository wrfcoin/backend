// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});
const { resolveAllowedOrigins } = require('./utils/strict-cors-config');

/**
 * Compute Contribution Server
 * One-click computational power contribution to Wrfcoin network
 * Follows the proven "set it and forget it" model from weather stations
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { computeLogger, aimlLogger } = require('./utils/logger.js');
const { requireOperatorToken } = require('./middleware/operator-token-auth.js');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');

const app = express();
const PORT = process.env.PORT || 6003;
const probeState = { draining: false };

// Middleware
app.use(cors({
  origin: resolveAllowedOrigins({ developmentDefaults: ['http://localhost:5000', 'http://localhost:3000'] }),
  credentials: true,
}));
app.use(express.json());
app.use(
  createHealthMiddleware('compute-contribution-server', {}, { state: probeState }).router
);

// In-memory storage for demo (would use database in production)
const computeNodes = new Map();
const activeTasks = new Map();
const completedTasks = new Map();
const computeEarnings = new Map();

// Compute task types and rewards
const taskTypes = {
  weather_model: {
    name: 'Weather Model Processing',
    description: 'Run WRF weather forecasting models',
    baseReward: 0.25,
    cpuIntensive: true,
    estimatedTime: '15-30 minutes',
    requirements: { minCPU: 2, minRAM: 4 },
  },
  forecast_validation: {
    name: 'Forecast Validation',
    description: 'Validate weather forecast accuracy',
    baseReward: 0.15,
    cpuIntensive: false,
    estimatedTime: '5-10 minutes',
    requirements: { minCPU: 1, minRAM: 2 },
  },
  ai_inference: {
    name: 'AI Model Inference',
    description: 'Run environmental AI models',
    baseReward: 0.35,
    cpuIntensive: true,
    estimatedTime: '20-45 minutes',
    requirements: { minCPU: 4, minRAM: 8 },
  },
  analytics_processing: {
    name: 'Environmental Analytics',
    description: 'Process environmental data analytics',
    baseReward: 0.2,
    cpuIntensive: false,
    estimatedTime: '10-20 minutes',
    requirements: { minCPU: 2, minRAM: 4 },
  },
  climate_simulation: {
    name: 'Climate Simulation',
    description: 'Run distributed climate models',
    baseReward: 0.5,
    cpuIntensive: true,
    estimatedTime: '30-60 minutes',
    requirements: { minCPU: 8, minRAM: 16 },
  },
};

// System capability detection
function detectSystemCapabilities() {
  const cpus = os.cpus();
  const totalRAM = Math.round(os.totalmem() / (1024 * 1024 * 1024)); // GB
  const platform = os.platform();
  const arch = os.arch();

  return {
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model || 'Unknown',
    totalRAM,
    platform,
    architecture: arch,
    nodeVersion: process.version,
    uptime: os.uptime(),
    loadAverage: os.loadavg(),
  };
}

// Recommend optimal tasks based on system capabilities
function recommendTasks(capabilities) {
  const recommended = [];

  for (const [taskId, task] of Object.entries(taskTypes)) {
    if (
      capabilities.cpuCount >= task.requirements.minCPU &&
      capabilities.totalRAM >= task.requirements.minRAM
    ) {
      recommended.push({
        taskId,
        ...task,
        suitability: calculateSuitability(capabilities, task),
      });
    }
  }

  return recommended.sort((a, b) => b.suitability - a.suitability);
}

function calculateSuitability(capabilities, task) {
  let score = 100;

  // CPU suitability
  const cpuRatio = capabilities.cpuCount / task.requirements.minCPU;
  score += Math.min(cpuRatio * 20, 50);

  // RAM suitability
  const ramRatio = capabilities.totalRAM / task.requirements.minRAM;
  score += Math.min(ramRatio * 15, 30);

  // Load average consideration
  const avgLoad = capabilities.loadAverage[0];
  if (avgLoad < 1) score += 20;
  else if (avgLoad > 2) score -= 30;

  return Math.max(0, Math.min(200, score));
}

// =====================================================
// COMPUTE NODE REGISTRATION & MANAGEMENT
// =====================================================

/**
 * Register a new compute node for one-click contribution
 */
app.post('/api/compute/register', requireOperatorToken, (req, res) => {
  try {
    const { walletAddress, preferences = {} } = req.body;

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        error: 'Wallet address is required',
      });
    }

    const nodeId = `compute_${crypto.randomBytes(8).toString('hex')}`;
    const capabilities = detectSystemCapabilities();
    const recommended = recommendTasks(capabilities);

    const node = {
      nodeId,
      walletAddress,
      capabilities,
      preferences: {
        maxCPUUsage: preferences.maxCPUUsage || 80,
        maxRAMUsage: preferences.maxRAMUsage || 70,
        allowGPU: preferences.allowGPU || false,
        preferredTasks: preferences.preferredTasks || [],
        autoStart: preferences.autoStart !== false,
        onlyWhenIdle: preferences.onlyWhenIdle || true,
      },
      status: {
        online: true,
        active: false,
        currentTask: null,
        lastSeen: new Date().toISOString(),
        totalUptime: 0,
        tasksCompleted: 0,
        tasksRunning: 0,
      },
      stats: {
        totalComputeTime: 0,
        totalEarnings: 0,
        averageTaskTime: 0,
        successRate: 100,
      },
      registeredAt: new Date().toISOString(),
    };

    computeNodes.set(nodeId, node);
    computeEarnings.set(nodeId, []);

    computeLogger.info('Compute node registered', {
      operation: 'node:register',
      nodeId,
      cpuCount: capabilities.cpuCount,
      totalRAM: capabilities.totalRAM,
      walletAddress,
      recommendedTasks: recommended.length,
    });

    res.json({
      success: true,
      nodeId,
      capabilities,
      recommendedTasks: recommended,
      estimatedEarnings: {
        hourly: recommended.length > 0 ? recommended[0].baseReward * 2 : 0,
        daily: recommended.length > 0 ? recommended[0].baseReward * 24 : 0,
      },
      message: 'Compute node registered successfully',
    });
  } catch (error) {
    computeLogger.error('Node registration error', {
      operation: 'node:register:error',
      error: error.message,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to register compute node',
      details: error.message,
    });
  }
});

/**
 * Configure compute node preferences
 */
app.put('/api/compute/configure/:nodeId', requireOperatorToken, (req, res) => {
  try {
    const { nodeId } = req.params;
    const { preferences } = req.body;

    const node = computeNodes.get(nodeId);
    if (!node) {
      return res.status(404).json({
        success: false,
        error: 'Compute node not found',
      });
    }

    // Update preferences
    Object.assign(node.preferences, preferences);
    computeNodes.set(nodeId, node);

    // Recalculate recommendations
    const recommended = recommendTasks(node.capabilities);

    computeLogger.info('Node configuration updated', {
      operation: 'node:config:update',
      nodeId,
    });

    res.json({
      success: true,
      nodeId,
      preferences: node.preferences,
      recommendedTasks: recommended,
      message: 'Configuration updated successfully',
    });
  } catch (error) {
    computeLogger.error('Configuration error', {
      operation: 'node:config:error',
      error: error.message,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to update configuration',
      details: error.message,
    });
  }
});

// =====================================================
// TASK ASSIGNMENT & EXECUTION
// =====================================================

/**
 * Get available tasks for a compute node
 */
app.get('/api/compute/tasks/available/:nodeId', (req, res) => {
  try {
    const { nodeId } = req.params;

    const node = computeNodes.get(nodeId);
    if (!node) {
      return res.status(404).json({
        success: false,
        error: 'Compute node not found',
      });
    }

    const recommended = recommendTasks(node.capabilities);
    const available = recommended.filter(task => {
      // Check if node is capable and task matches preferences
      return (
        node.preferences.preferredTasks.length === 0 ||
        node.preferences.preferredTasks.includes(task.taskId)
      );
    });

    res.json({
      success: true,
      nodeId,
      availableTasks: available,
      systemStatus: {
        load: os.loadavg()[0],
        freeRAM: Math.round(os.freemem() / (1024 * 1024 * 1024)),
        cpuUsage: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
      },
    });
  } catch (error) {
    computeLogger.error('Task retrieval error', {
      operation: 'task:retrieve:error',
      error: error.message,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get available tasks',
      details: error.message,
    });
  }
});

/**
 * Start a compute task
 */
app.post('/api/compute/tasks/start', requireOperatorToken, (req, res) => {
  try {
    const { nodeId, taskType } = req.body;

    const node = computeNodes.get(nodeId);
    if (!node) {
      return res.status(404).json({
        success: false,
        error: 'Compute node not found',
      });
    }

    if (node.status.active) {
      return res.status(400).json({
        success: false,
        error: 'Node is already running a task',
      });
    }

    const taskTemplate = taskTypes[taskType];
    if (!taskTemplate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid task type',
      });
    }

    const taskId = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startTime = new Date().toISOString();

    const task = {
      taskId,
      nodeId,
      taskType,
      ...taskTemplate,
      status: 'running',
      startTime,
      estimatedCompletion: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min estimate
      progress: 0,
      resourceUsage: {
        cpu: 0,
        memory: 0,
        networkIO: 0,
      },
    };

    activeTasks.set(taskId, task);

    // Update node status
    node.status.active = true;
    node.status.currentTask = taskId;
    node.status.tasksRunning++;
    computeNodes.set(nodeId, node);

    // Simulate task execution
    simulateTaskExecution(taskId);

    computeLogger.info('Task started', {
      operation: 'task:start',
      taskType,
      nodeId,
      taskId,
      estimatedCompletion: task.estimatedCompletion,
    });

    res.json({
      success: true,
      taskId,
      nodeId,
      task,
      message: 'Compute task started successfully',
    });
  } catch (error) {
    computeLogger.error('Task start error', {
      operation: 'task:start:error',
      error: error.message,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to start compute task',
      details: error.message,
    });
  }
});

/**
 * Get task progress and status
 */
app.get('/api/compute/tasks/:taskId/status', (req, res) => {
  try {
    const { taskId } = req.params;

    const task = activeTasks.get(taskId) || completedTasks.get(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        error: 'Task not found',
      });
    }

    res.json({
      success: true,
      taskId,
      status: task.status,
      progress: task.progress,
      resourceUsage: task.resourceUsage,
      startTime: task.startTime,
      completionTime: task.completionTime,
      estimatedCompletion: task.estimatedCompletion,
      reward: task.reward,
    });
  } catch (error) {
    computeLogger.error('Task status error', { operation: 'task:status:error', error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get task status',
      details: error.message,
    });
  }
});

// =====================================================
// EARNINGS & REWARDS
// =====================================================

/**
 * View compute earnings for a node or wallet
 */
app.get('/api/compute/earnings', (req, res) => {
  try {
    const { nodeId, walletAddress } = req.query;

    if (nodeId) {
      const node = computeNodes.get(nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          error: 'Compute node not found',
        });
      }

      const earnings = computeEarnings.get(nodeId) || [];

      res.json({
        success: true,
        nodeId,
        walletAddress: node.walletAddress,
        earnings: {
          total: node.stats.totalEarnings,
          pending: 0, // Compute rewards are immediate
          history: earnings,
        },
        statistics: {
          tasksCompleted: node.status.tasksCompleted,
          totalComputeTime: node.stats.totalComputeTime,
          averageTaskTime: node.stats.averageTaskTime,
          successRate: node.stats.successRate,
        },
      });
    } else if (walletAddress) {
      // Get earnings for all nodes owned by wallet
      const ownedNodes = Array.from(computeNodes.values()).filter(
        node => node.walletAddress === walletAddress
      );

      const totalEarnings = ownedNodes.reduce(
        (sum, node) => sum + node.stats.totalEarnings,
        0
      );
      const totalTasks = ownedNodes.reduce(
        (sum, node) => sum + node.status.tasksCompleted,
        0
      );

      res.json({
        success: true,
        walletAddress,
        nodeCount: ownedNodes.length,
        earnings: {
          total: totalEarnings,
          pending: 0,
        },
        nodes: ownedNodes.map(node => ({
          nodeId: node.nodeId,
          capabilities: `${node.capabilities.cpuCount} cores, ${node.capabilities.totalRAM}GB RAM`,
          earnings: node.stats.totalEarnings,
          tasksCompleted: node.status.tasksCompleted,
        })),
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'Either nodeId or walletAddress is required',
      });
    }
  } catch (error) {
    computeLogger.error('Earnings query error', { operation: 'earnings:query:error', error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get earnings',
      details: error.message,
    });
  }
});

// =====================================================
// NODE MONITORING & HEALTH
// =====================================================

/**
 * Node heartbeat and status update
 */
app.post('/api/compute/heartbeat', requireOperatorToken, (req, res) => {
  try {
    const { nodeId, status } = req.body;

    const node = computeNodes.get(nodeId);
    if (!node) {
      return res.status(404).json({
        success: false,
        error: 'Compute node not found',
      });
    }

    // Update node status
    node.status.online = true;
    node.status.lastSeen = new Date().toISOString();
    if (status) {
      Object.assign(node.status, status);
    }

    computeNodes.set(nodeId, node);

    // Check for available tasks if node is idle
    const availableTasks = node.status.active
      ? []
      : recommendTasks(node.capabilities);

    res.json({
      success: true,
      nodeId,
      nextHeartbeat: Date.now() + 60000, // Next in 1 minute
      availableTasks: availableTasks.slice(0, 3), // Top 3 recommendations
      systemHealth: {
        load: os.loadavg()[0],
        memory: Math.round((os.freemem() / os.totalmem()) * 100),
        uptime: os.uptime(),
      },
    });
  } catch (error) {
    computeLogger.error('Heartbeat error', { operation: 'heartbeat:error', error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to process heartbeat',
      details: error.message,
    });
  }
});

/**
 * Get compute node statistics
 */
app.get('/api/compute/stats', (req, res) => {
  try {
    const { nodeId } = req.query;

    if (nodeId) {
      const node = computeNodes.get(nodeId);
      if (!node) {
        return res.status(404).json({
          success: false,
          error: 'Compute node not found',
        });
      }

      res.json({
        success: true,
        nodeId,
        statistics: node.stats,
        status: node.status,
        capabilities: node.capabilities,
        currentPerformance: {
          cpuUsage: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
          memoryUsage: Math.round(
            ((os.totalmem() - os.freemem()) / os.totalmem()) * 100
          ),
          uptime: os.uptime(),
        },
      });
    } else {
      // Network-wide statistics
      const allNodes = Array.from(computeNodes.values());
      const allActiveTasks = Array.from(activeTasks.values());

      res.json({
        success: true,
        networkStatistics: {
          totalNodes: allNodes.length,
          activeNodes: allNodes.filter(n => n.status.online).length,
          runningTasks: allActiveTasks.length,
          totalComputeTime: allNodes.reduce(
            (sum, n) => sum + n.stats.totalComputeTime,
            0
          ),
          totalEarnings: allNodes.reduce(
            (sum, n) => sum + n.stats.totalEarnings,
            0
          ),
          averageSuccessRate:
            allNodes.length > 0
              ? allNodes.reduce((sum, n) => sum + n.stats.successRate, 0) /
                allNodes.length
              : 100,
        },
      });
    }
  } catch (error) {
    computeLogger.error('Statistics error', { operation: 'stats:error', error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get statistics',
      details: error.message,
    });
  }
});

// =====================================================
// BACKGROUND TASK SIMULATION
// =====================================================

function simulateTaskExecution(taskId) {
  const task = activeTasks.get(taskId);
  if (!task) return;

  const updateInterval = setInterval(() => {
    const task = activeTasks.get(taskId);
    if (!task || task.status !== 'running') {
      clearInterval(updateInterval);
      return;
    }

    // Simulate progress
    task.progress += Math.random() * 10;
    task.resourceUsage.cpu = 20 + Math.random() * 60;
    task.resourceUsage.memory = 10 + Math.random() * 40;

    if (task.progress >= 100) {
      completeTask(taskId);
      clearInterval(updateInterval);
    }

    activeTasks.set(taskId, task);
  }, 3000); // Update every 3 seconds
}

function completeTask(taskId) {
  const task = activeTasks.get(taskId);
  if (!task) return;

  const node = computeNodes.get(task.nodeId);
  if (!node) return;

  // Mark task as completed
  task.status = 'completed';
  task.progress = 100;
  task.completionTime = new Date().toISOString();
  task.reward = task.baseReward;

  // Calculate actual runtime
  const runtime = Date.now() - new Date(task.startTime).getTime();
  task.actualRuntime = runtime;

  // Update node statistics
  node.status.active = false;
  node.status.currentTask = null;
  node.status.tasksCompleted++;
  node.status.tasksRunning--;
  node.stats.totalEarnings += task.reward;
  node.stats.totalComputeTime += runtime;
  node.stats.averageTaskTime =
    node.stats.totalComputeTime / node.status.tasksCompleted;

  // Record earning
  const earnings = computeEarnings.get(task.nodeId) || [];
  earnings.push({
    amount: task.reward,
    taskType: task.taskType,
    taskId,
    timestamp: task.completionTime,
    runtime: runtime,
  });
  computeEarnings.set(task.nodeId, earnings);

  // Move task to completed
  completedTasks.set(taskId, task);
  activeTasks.delete(taskId);

  computeNodes.set(task.nodeId, node);

  computeLogger.info('Task completed', {
    operation: 'task:complete',
    taskType: task.taskType,
    reward: task.reward,
    runtimeSeconds: Math.round(runtime / 1000),
  });
}

// =====================================================
// HEALTH CHECK & INFO
// =====================================================

app.get('/', (req, res) => {
  res.json({
    service: 'Wrfcoin Compute Contribution Network',
    version: '1.0.0',
    description:
      'One-click computational power contribution for environmental forecasting',
    endpoints: [
      'POST /api/compute/register - Register compute node',
      'PUT /api/compute/configure/:nodeId - Configure preferences',
      'GET /api/compute/tasks/available/:nodeId - Get available tasks',
      'POST /api/compute/tasks/start - Start compute task',
      'GET /api/compute/tasks/:taskId/status - Task status',
      'GET /api/compute/earnings - View earnings',
      'POST /api/compute/heartbeat - Node heartbeat',
      'GET /api/compute/stats - Statistics',
    ],
    registeredNodes: computeNodes.size,
    activeTasks: activeTasks.size,
    totalEarnings: Array.from(computeNodes.values()).reduce(
      (sum, node) => sum + node.stats.totalEarnings,
      0
    ),
    systemCapabilities: detectSystemCapabilities(),
  });
});

// Start server with proper error handling
let activeServer = app.listen(PORT, '0.0.0.0', () => {
  computeLogger.info('Compute Contribution Server started', {
    operation: 'server:start',
    port: PORT,
    features: ['one-click-compute', 'ai-ml-tasks', 'environmental-forecasting', 'rewards-system'],
  });
});

activeServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    computeLogger.warn('Port in use, trying alternate port', {
      operation: 'server:port:retry',
      originalPort: PORT,
      newPort: PORT + 1,
    });
    activeServer = app.listen(PORT + 1, '0.0.0.0', () => {
      computeLogger.info('Compute Contribution Server started on alternate port', {
        operation: 'server:start:alternate',
        port: PORT + 1,
      });
    });
  } else {
    computeLogger.error('Server error', { operation: 'server:error', error: err.message });
  }
});

registerGracefulShutdown({
  serviceName: 'compute-contribution-server',
  server: activeServer,
  logger: computeLogger,
  state: probeState,
});

module.exports = app;
