/**
 * Wrfcoin Forecast Compute Node
 *
 * This module defines the functionality for forecast computation nodes in the
 * Wrfcoin blockchain network. These specialized nodes perform meteorological
 * computations and submit forecast results to the blockchain.
 */

const {
  DataBlockType,
  DataStorageProvider,
  GeoReferenceSystem,
} = require('./data-aware-block');
const crypto = require('crypto');

// Forecast computation model types
const ForecastModelType = {
  WRF: 'wrf', // Weather Research & Forecasting Model
  GFS: 'gfs', // Global Forecast System
  ECMWF: 'ecmwf', // European Centre for Medium-Range Weather Forecasts
  HRRR: 'hrrr', // High-Resolution Rapid Refresh
  NAM: 'nam', // North American Mesoscale Model
  CUSTOM: 'custom', // Custom model (must be documented)
};

// Compute task priorities
const ComputePriority = {
  CRITICAL: 'critical', // Emergency events (hurricanes, floods, etc.)
  HIGH: 'high', // Severe weather alerts
  MEDIUM: 'medium', // Regular forecasts
  LOW: 'low', // Research computations
  BACKGROUND: 'background', // Long-term climate studies
};

// Computation resource requirements
class ComputeResourceRequirements {
  constructor(options = {}) {
    this.cpuCores = options.cpuCores || 4;
    this.memoryGB = options.memoryGB || 8;
    this.storageGB = options.storageGB || 20;
    this.gpuRequired = options.gpuRequired || false;
    this.gpuMemoryGB = options.gpuMemoryGB || 0;
    this.networkBandwidthMbps = options.networkBandwidthMbps || 100;
    this.estimatedDurationMinutes = options.estimatedDurationMinutes || 60;
    this.containerImage = options.containerImage || 'wrfcoin/forecast:latest';
  }

  // Calculate resource tokens needed for this computation
  calculateResourceTokens() {
    let tokens = 0;

    // Base CPU cost
    tokens += this.cpuCores * 10;

    // Memory cost
    tokens += this.memoryGB * 5;

    // Storage cost
    tokens += this.storageGB * 2;

    // GPU premium
    if (this.gpuRequired) {
      tokens += 100 + this.gpuMemoryGB * 20;
    }

    // Duration factor
    tokens *= this.estimatedDurationMinutes / 60;

    return Math.ceil(tokens);
  }
}

// Compute task definition
class ForecastComputeTask {
  constructor(options = {}) {
    this.id = options.id || `compute-${Date.now().toString(36)}`;
    this.modelType = options.modelType || ForecastModelType.WRF;
    this.customModelDetails = options.customModelDetails;
    this.priority = options.priority || ComputePriority.MEDIUM;
    this.resources = new ComputeResourceRequirements(options.resources || {});
    this.inputData = options.inputData || [];
    this.parameters = options.parameters || {};
    this.geoBounds = options.geoBounds || {
      north: 90,
      south: -90,
      east: 180,
      west: -180,
      resolution: 0.25, // degrees
    };
    this.geoReference = options.geoReference || GeoReferenceSystem.WGS84;
    this.forecastHours = options.forecastHours || 24;
    this.forecastInterval = options.forecastInterval || 1; // hours
    this.variables = options.variables || [
      'temperature',
      'precipitation',
      'wind_speed',
      'wind_direction',
    ];
    this.createdAt = options.createdAt || new Date().toISOString();
    this.deadline = options.deadline;
    this.reward = options.reward || this.resources.calculateResourceTokens();
    this.requester = options.requester;
    this.status = options.status || 'created';
  }

  // Validate the compute task
  validate() {
    const errors = [];

    if (!this.modelType) errors.push('Model type is required');
    if (
      this.modelType === ForecastModelType.CUSTOM &&
      !this.customModelDetails
    ) {
      errors.push('Custom model details are required for custom model type');
    }

    if (!this.geoBounds) errors.push('Geographic bounds are required');
    if (!this.variables || this.variables.length === 0) {
      errors.push('At least one forecast variable is required');
    }

    if (this.forecastHours <= 0) errors.push('Forecast hours must be positive');
    if (this.forecastInterval <= 0)
      errors.push('Forecast interval must be positive');

    // Validate that input data includes necessary datasets
    const hasInitialConditions = this.inputData.some(
      d => d.type === 'initial_conditions'
    );
    if (!hasInitialConditions) {
      errors.push('Input data must include initial conditions');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // Prepare compute task for blockchain submission
  prepareForBlockchain() {
    // Generate a unique computation ID based on task parameters
    const taskHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          modelType: this.modelType,
          geoBounds: this.geoBounds,
          variables: this.variables,
          forecastHours: this.forecastHours,
          parameters: this.parameters,
          createdAt: this.createdAt,
        })
      )
      .digest('hex');

    return {
      task_id: this.id,
      task_hash: taskHash,
      model_type: this.modelType,
      priority: this.priority,
      geo_bounds: this.geoBounds,
      geo_reference: this.geoReference,
      forecast_hours: this.forecastHours,
      variables: this.variables,
      resource_tokens: this.reward,
      requester: this.requester,
      status: this.status,
    };
  }
}

// Compute result data structure
class ForecastComputeResult {
  constructor(options = {}) {
    this.taskId = options.taskId;
    this.computeNodeId = options.computeNodeId;
    this.resultId = options.resultId || `result-${Date.now().toString(36)}`;
    this.completedAt = options.completedAt || new Date().toISOString();
    this.status = options.status || 'completed';
    this.dataLocation = options.dataLocation || {
      provider: DataStorageProvider.IPFS,
      reference: null, // Will be filled in after data upload
    };
    this.dataSummary = options.dataSummary || {
      variables: [],
      timeSteps: 0,
      resolution: null,
      min_values: {},
      max_values: {},
      mean_values: {},
    };
    this.verificationProof = options.verificationProof;
    this.computationMetrics = options.computationMetrics || {
      duration: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      energyUsage: 0,
    };
    this.anomalyIndices = options.anomalyIndices || [];
  }

  // Validate the compute result
  validate() {
    const errors = [];

    if (!this.taskId) errors.push('Task ID is required');
    if (!this.computeNodeId) errors.push('Compute node ID is required');
    if (!this.dataLocation.reference)
      errors.push('Data storage reference is required');

    if (
      !this.dataSummary.variables ||
      this.dataSummary.variables.length === 0
    ) {
      errors.push('Data summary must include variables');
    }

    if (!this.dataSummary.timeSteps || this.dataSummary.timeSteps <= 0) {
      errors.push('Data summary must include positive number of time steps');
    }

    // Check for valid min/max values for each variable
    for (const variable of this.dataSummary.variables) {
      if (typeof this.dataSummary.min_values[variable] !== 'number') {
        errors.push(`Min value for ${variable} is missing or not a number`);
      }
      if (typeof this.dataSummary.max_values[variable] !== 'number') {
        errors.push(`Max value for ${variable} is missing or not a number`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // Prepare compute result for blockchain submission
  prepareForBlockchain() {
    // Generate a unique result hash for verification
    const resultHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          taskId: this.taskId,
          computeNodeId: this.computeNodeId,
          completedAt: this.completedAt,
          dataSummary: this.dataSummary,
          dataLocation: this.dataLocation,
        })
      )
      .digest('hex');

    return {
      task_id: this.taskId,
      result_id: this.resultId,
      result_hash: resultHash,
      compute_node_id: this.computeNodeId,
      completed_at: this.completedAt,
      status: this.status,
      data_type: DataBlockType.WEATHER_FORECAST,
      data_location: this.dataLocation,
      data_summary: this.dataSummary,
      verification_proof: this.verificationProof,
      computation_metrics: this.computationMetrics,
    };
  }
}

// Forecast compute node class
class ForecastComputeNode {
  constructor(options = {}) {
    this.nodeId = options.nodeId || `node-${Date.now().toString(36)}`;
    this.nodeName = options.nodeName || 'Unnamed Compute Node';
    this.resources = new ComputeResourceRequirements(options.resources || {});
    this.supportedModels = options.supportedModels || [ForecastModelType.WRF];
    this.geographicSpecialization = options.geographicSpecialization;
    this.operatorAddress = options.operatorAddress;
    this.status = options.status || 'online';
    this.taskQueue = [];
    this.completedTasks = [];
    this.reputation = options.reputation || 1.0;
    this.lastSeen = options.lastSeen || new Date().toISOString();
    this.totalComputations = options.totalComputations || 0;
    this.successfulComputations = options.successfulComputations || 0;
  }

  // Queue a new compute task
  queueTask(task) {
    // Check if task's model is supported
    if (!this.supportedModels.includes(task.modelType)) {
      return {
        success: false,
        error: `Model ${task.modelType} not supported by this node`,
      };
    }

    // Check if resources are sufficient
    if (
      task.resources.cpuCores > this.resources.cpuCores ||
      task.resources.memoryGB > this.resources.memoryGB ||
      (task.resources.gpuRequired && !this.resources.gpuRequired)
    ) {
      return {
        success: false,
        error: 'Insufficient resources for this task',
      };
    }

    // Add to queue
    this.taskQueue.push({
      task,
      queuedAt: new Date().toISOString(),
      status: 'queued',
    });

    return {
      success: true,
      queuePosition: this.taskQueue.length,
      estimatedStartTime: this._calculateEstimatedStartTime(
        this.taskQueue.length - 1
      ),
    };
  }

  // Calculate estimated start time for a task at given queue position
  _calculateEstimatedStartTime(queuePosition) {
    // Simple estimation based on queue position and average task duration
    const averageTaskDuration = 30; // minutes
    const delay = queuePosition * averageTaskDuration;

    const startTime = new Date();
    startTime.setMinutes(startTime.getMinutes() + delay);

    return startTime.toISOString();
  }

  // Process the next task in queue
  async processNextTask() {
    if (this.taskQueue.length === 0) {
      return {
        success: false,
        error: 'No tasks in queue',
      };
    }

    const taskEntry = this.taskQueue.shift();
    taskEntry.status = 'processing';
    taskEntry.startedAt = new Date().toISOString();

    try {
      // Simulate computation process
      const result = await this._simulateComputation(taskEntry.task);

      // Record successful completion
      this.totalComputations++;
      this.successfulComputations++;
      this.completedTasks.push({
        task: taskEntry.task,
        result,
        completedAt: new Date().toISOString(),
      });

      // Update reputation
      this._updateReputation(true);

      return {
        success: true,
        taskId: taskEntry.task.id,
        resultId: result.resultId,
      };
    } catch (error) {
      // Record failure
      this.totalComputations++;
      this._updateReputation(false);

      return {
        success: false,
        taskId: taskEntry.task.id,
        error: error.message,
      };
    }
  }

  // Simulate computation process
  async _simulateComputation(task) {
    // For simulation, create a realistic duration based on task complexity
    const estimatedSeconds =
      (task.resources.cpuCores *
        task.resources.memoryGB *
        task.forecastHours *
        task.variables.length) /
      1000;

    // Simulate the actual computation with a delay
    await new Promise(resolve =>
      setTimeout(resolve, Math.min(2000, estimatedSeconds))
    );

    // Generate realistic result data
    const result = new ForecastComputeResult({
      taskId: task.id,
      computeNodeId: this.nodeId,
      completedAt: new Date().toISOString(),
      status: 'completed',
      dataLocation: {
        provider: DataStorageProvider.IPFS,
        reference: `ipfs://Qm${crypto.randomBytes(16).toString('hex')}`,
      },
      dataSummary: {
        variables: task.variables,
        timeSteps: task.forecastHours / task.forecastInterval,
        resolution: task.geoBounds.resolution,
        min_values: this._generateRandomMinValues(task.variables),
        max_values: this._generateRandomMaxValues(task.variables),
        mean_values: this._generateRandomMeanValues(task.variables),
      },
      computationMetrics: {
        duration: estimatedSeconds,
        cpuUsage: 0.8 + Math.random() * 0.2,
        memoryUsage: 0.7 + Math.random() * 0.3,
        energyUsage: task.resources.cpuCores * estimatedSeconds * 0.01,
      },
    });

    return result;
  }

  // Generate random min values for variables
  _generateRandomMinValues(variables) {
    const values = {};
    for (const variable of variables) {
      switch (variable) {
        case 'temperature':
          values[variable] = -10 + Math.random() * 15;
          break;
        case 'precipitation':
          values[variable] = 0;
          break;
        case 'wind_speed':
          values[variable] = 0;
          break;
        case 'wind_direction':
          values[variable] = 0;
          break;
        case 'humidity':
          values[variable] = 10 + Math.random() * 30;
          break;
        case 'pressure':
          values[variable] = 980 + Math.random() * 15;
          break;
        default:
          values[variable] = Math.random() * 10;
      }
    }
    return values;
  }

  // Generate random max values for variables
  _generateRandomMaxValues(variables) {
    const values = {};
    for (const variable of variables) {
      switch (variable) {
        case 'temperature':
          values[variable] = 20 + Math.random() * 15;
          break;
        case 'precipitation':
          values[variable] = Math.random() * 50;
          break;
        case 'wind_speed':
          values[variable] = 10 + Math.random() * 50;
          break;
        case 'wind_direction':
          values[variable] = 359;
          break;
        case 'humidity':
          values[variable] = 70 + Math.random() * 30;
          break;
        case 'pressure':
          values[variable] = 1015 + Math.random() * 15;
          break;
        default:
          values[variable] = 50 + Math.random() * 50;
      }
    }
    return values;
  }

  // Generate random mean values between min and max
  _generateRandomMeanValues(variables) {
    const values = {};
    const mins = this._generateRandomMinValues(variables);
    const maxes = this._generateRandomMaxValues(variables);

    for (const variable of variables) {
      values[variable] =
        mins[variable] + Math.random() * (maxes[variable] - mins[variable]);
    }
    return values;
  }

  // Update node reputation based on task success or failure
  _updateReputation(success) {
    if (success) {
      // Slowly increase reputation for successful tasks
      this.reputation = Math.min(5.0, this.reputation + 0.01);
    } else {
      // More severely punish failures
      this.reputation = Math.max(0, this.reputation - 0.05);
    }
    return this.reputation;
  }

  // Get node status and statistics
  getStatus() {
    return {
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      status: this.status,
      supportedModels: this.supportedModels,
      resources: {
        cpuCores: this.resources.cpuCores,
        memoryGB: this.resources.memoryGB,
        gpuAvailable: this.resources.gpuRequired,
      },
      queueLength: this.taskQueue.length,
      reputation: this.reputation,
      successRate:
        this.totalComputations > 0
          ? this.successfulComputations / this.totalComputations
          : 1.0,
      totalComputations: this.totalComputations,
    };
  }
}

// Compute Node Manager for coordinating nodes and tasks
class ForecastComputeManager {
  constructor() {
    this.nodes = [];
    this.tasks = [];
    this.pendingTasks = [];
    this.completedTasks = [];
    this.failedTasks = [];
  }

  // Register a new compute node
  registerNode(node) {
    const existingIndex = this.nodes.findIndex(n => n.nodeId === node.nodeId);
    if (existingIndex >= 0) {
      this.nodes[existingIndex] = node;
      return {
        success: true,
        message: 'Node updated',
        nodeId: node.nodeId,
      };
    } else {
      this.nodes.push(node);
      return {
        success: true,
        message: 'Node registered',
        nodeId: node.nodeId,
      };
    }
  }

  // Submit a new compute task
  submitTask(task) {
    const validation = task.validate();
    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors,
      };
    }

    this.tasks.push(task);
    this.pendingTasks.push(task);

    // Attempt to assign the task to a suitable node
    this._assignTaskToNode(task);

    return {
      success: true,
      taskId: task.id,
      message: 'Task submitted',
    };
  }

  // Match and assign tasks to suitable nodes
  _assignTaskToNode(task) {
    // Find eligible nodes that can handle this task
    const eligibleNodes = this.nodes.filter(node => {
      // Check if online
      if (node.status !== 'online') return false;

      // Check model support
      if (!node.supportedModels.includes(task.modelType)) return false;

      // Check resources
      if (
        task.resources.cpuCores > node.resources.cpuCores ||
        task.resources.memoryGB > node.resources.memoryGB ||
        (task.resources.gpuRequired && !node.resources.gpuRequired)
      ) {
        return false;
      }

      // Check geographic specialization if applicable
      if (node.geographicSpecialization && task.geoBounds) {
        // Simple check if task's area overlaps with node's specialization
        // A more sophisticated check would use proper geography calculations
        const nodeGeo = node.geographicSpecialization;
        const taskGeo = task.geoBounds;

        if (
          taskGeo.north < nodeGeo.south ||
          taskGeo.south > nodeGeo.north ||
          taskGeo.east < nodeGeo.west ||
          taskGeo.west > nodeGeo.east
        ) {
          return false;
        }
      }

      return true;
    });

    if (eligibleNodes.length === 0) {
      // No eligible nodes, keep in pending
      return null;
    }

    // Sort eligible nodes by reputation and queue length
    eligibleNodes.sort((a, b) => {
      // First prioritize by reputation
      const reputationDiff = b.reputation - a.reputation;
      if (Math.abs(reputationDiff) > 0.5) return reputationDiff;

      // If reputation is similar, prioritize by queue length
      return a.taskQueue.length - b.taskQueue.length;
    });

    // Assign to best node
    const bestNode = eligibleNodes[0];
    const result = bestNode.queueTask(task);

    if (result.success) {
      // Update task status
      task.status = 'assigned';

      // Remove from pending
      const pendingIndex = this.pendingTasks.findIndex(t => t.id === task.id);
      if (pendingIndex >= 0) {
        this.pendingTasks.splice(pendingIndex, 1);
      }

      return bestNode.nodeId;
    }

    return null;
  }

  // Process results submitted by compute nodes
  processResult(result) {
    const validation = result.validate();
    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors,
      };
    }

    // Find the original task
    const taskIndex = this.tasks.findIndex(t => t.id === result.taskId);
    if (taskIndex < 0) {
      return {
        success: false,
        error: 'Task not found',
      };
    }

    const task = this.tasks[taskIndex];
    task.status = 'completed';

    // Add to completed tasks
    this.completedTasks.push({
      task,
      result,
      processedAt: new Date().toISOString(),
    });

    // Prepare for blockchain
    const blockchainData = result.prepareForBlockchain();

    return {
      success: true,
      taskId: task.id,
      resultId: result.resultId,
      blockchainData,
    };
  }

  // Get network status and statistics
  getNetworkStatus() {
    return {
      activeNodes: this.nodes.filter(n => n.status === 'online').length,
      totalNodes: this.nodes.length,
      pendingTasks: this.pendingTasks.length,
      completedTasks: this.completedTasks.length,
      failedTasks: this.failedTasks.length,
      averageNodeReputation: this._calculateAverageReputation(),
      modelDistribution: this._calculateModelDistribution(),
      resourceUtilization: this._calculateResourceUtilization(),
    };
  }

  // Calculate average node reputation
  _calculateAverageReputation() {
    if (this.nodes.length === 0) return 0;

    const total = this.nodes.reduce((sum, node) => sum + node.reputation, 0);
    return total / this.nodes.length;
  }

  // Calculate distribution of supported models across nodes
  _calculateModelDistribution() {
    const distribution = {};

    for (const node of this.nodes) {
      for (const model of node.supportedModels) {
        distribution[model] = (distribution[model] || 0) + 1;
      }
    }

    return distribution;
  }

  // Calculate current resource utilization
  _calculateResourceUtilization() {
    let totalCPU = 0;
    let usedCPU = 0;
    let totalMemory = 0;
    let usedMemory = 0;
    let totalGPU = 0;
    let usedGPU = 0;

    for (const node of this.nodes) {
      if (node.status !== 'online') continue;

      totalCPU += node.resources.cpuCores;
      totalMemory += node.resources.memoryGB;
      if (node.resources.gpuRequired) {
        totalGPU += node.resources.gpuMemoryGB || 1;
      }

      // Estimate used resources based on queue
      const taskLoad = node.taskQueue.reduce(
        (load, entry) => {
          if (entry.status === 'processing') {
            load.cpu += entry.task.resources.cpuCores;
            load.memory += entry.task.resources.memoryGB;
            if (entry.task.resources.gpuRequired) {
              load.gpu += entry.task.resources.gpuMemoryGB || 1;
            }
          }
          return load;
        },
        { cpu: 0, memory: 0, gpu: 0 }
      );

      usedCPU += taskLoad.cpu;
      usedMemory += taskLoad.memory;
      usedGPU += taskLoad.gpu;
    }

    return {
      cpu: {
        total: totalCPU,
        used: usedCPU,
        utilization: totalCPU > 0 ? usedCPU / totalCPU : 0,
      },
      memory: {
        total: totalMemory,
        used: usedMemory,
        utilization: totalMemory > 0 ? usedMemory / totalMemory : 0,
      },
      gpu: {
        total: totalGPU,
        used: usedGPU,
        utilization: totalGPU > 0 ? usedGPU / totalGPU : 0,
      },
    };
  }
}

module.exports = {
  ForecastModelType,
  ComputePriority,
  ComputeResourceRequirements,
  ForecastComputeTask,
  ForecastComputeResult,
  ForecastComputeNode,
  ForecastComputeManager,
};
