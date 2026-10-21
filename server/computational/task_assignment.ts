/**
 * Task Assignment Protocol for Wrfcoin
 *
 * efficiently matching computational tasks with appropriate nodes based on proximity,
 * capabilities, and network conditions.
 */

import * as crypto from 'crypto';
import { proximityIncentiveCalculator } from '../proximity/incentives.js';
import { aiValidator } from '../validation/ai_validator.js';

// Type definitions for external dependencies
interface ProximityIncentiveCalculator {
  selectOptimalNodes(task: any, activeNodes: any[], networkState: any): any[];
  calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number;
}

interface AIValidator {
  validateTaskAndCalculateIncentives(
    task: any,
    result: any,
    node: any,
    networkState: any
  ): Promise<{
    validation: {
      decision: string;
      overallScore: number;
      confidenceLevel: string;
      methods: string[];
      results: any;
      comments: string[];
    };
    incentive: {
      baseReward: number;
      finalReward: number;
      proximityMultiplier: number;
      validationMultiplier: number;
      distance: number;
    };
    validationId: string;
    taskId: string;
    nodeId: string;
    timestamp: number;
  }>;
}

// Note: proximityIncentiveCalculator and aiValidator are imported above

// Assignment strategies
const ASSIGNMENT_STRATEGIES = {
  PROXIMITY_FIRST: 'proximity_first',
  CAPABILITY_FIRST: 'capability_first',
  BALANCED: 'balanced',
  ENERGY_EFFICIENT: 'energy_efficient',
  REDUNDANT: 'redundant', // For tasks requiring multiple nodes for verification
};

// Task statuses
const TASK_STATUSES = {
  CREATED: 'created',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  VALIDATED: 'validated',
  REJECTED: 'rejected',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// Result verification types
const VERIFICATION_TYPES = {
  SINGLE: 'single', // Single node verification
  DISTRIBUTED: 'distributed', // Multiple nodes verify
  THRESHOLD: 'threshold', // Threshold of nodes must agree
  CONSENSUS: 'consensus', // Consensus among verifiers
};

// Type definitions for task assignment system
interface NodeCapabilities {
  cpu: {
    cores: number;
    architecture: string;
  };
  memory: number;
  gpu: any;
  storageAvailable: number;
}

interface ComputationalNode {
  nodeId: string;
  capabilities: NodeCapabilities;
  status: string;
  reliability: number;
  lastSeen: number;
  energyEfficiency?: number;
  provider?: string;
  latitude?: number;
  longitude?: number;
  location?: {
    latitude: number;
    longitude: number;
  };
  performance?: {
    avgCompletionTime: number;
    successRate: number;
  };
}

interface ComputationalTask {
  taskId: string;
  taskType: string;
  status: string;
  createdAt: number;
  priority: string;
  baseReward: number;
  requirements?: {
    minMemory?: number;
    minCores?: number;
    maxExecutionTime?: number;
    gpuRequired?: boolean;
  };
  data?: any;
  location?: {
    latitude: number;
    longitude: number;
  };
  redundancyCount?: number;
  requiresVerification?: boolean;
  assignedNodeId?: string;
  assignedAt?: number;
  startedAt?: number;
  completedAt?: number;
}

interface AssignmentOptions {
  strategy?: string;
  verificationType?: string;
  priority?: number;
  maxRetries?: number;
  requiresVerification?: boolean;
  nodePreferences?: string[];
  excludeNodes?: string[];
  timeout?: number;
  verifierCount?: number;
}

interface TaskAssignment {
  assignmentId: string;
  taskId: string;
  nodeId: string;
  assignedAt: number;
  status: string;
  expectedCompletion?: number;
  actualCompletion?: number;
  result?: any;
  verificationData?: any;
  startedAt?: number;
  completedAt?: number;
  executionTime?: number;
  validationResult?: any;
  verificationRequired?: boolean;
  verificationType?: string;
  verifiers?: string[];
}

interface VerificationConfig {
  defaultType: string;
  thresholdPercentage: number;
  minimumVerifiers: number;
  verifierReward: number;
}

interface PriorityLevels {
  LOW: number;
  STANDARD: number;
  HIGH: number;
  CRITICAL: number;
}

interface TaskAssignmentOptions {
  redundancyCount?: number;
  verificationType?: string;
  verifierCount?: number;
  maxNodes?: number;
  excludeNodes?: string[];
  strategy?: string;
  requiresVerification?: boolean;
}

/**
 * Task Assignment Manager
 * Handles the assignment of computational tasks to nodes
 */
class TaskAssignmentManager {
  // Property declarations
  public tasks: Map<string, ComputationalTask>;
  public nodes: Map<string, ComputationalNode>;
  public assignments: Map<string, TaskAssignment>;
  public verificationConfig: VerificationConfig;
  public priorityLevels: PriorityLevels;

  constructor() {
    // Map of task IDs to task data
    this.tasks = new Map();

    // Map of node IDs to node data
    this.nodes = new Map();

    // Map of assignments
    this.assignments = new Map();

    // Result verification settings
    this.verificationConfig = {
      defaultType: VERIFICATION_TYPES.SINGLE,
      thresholdPercentage: 0.67, // 67% of verifiers must agree
      minimumVerifiers: 3, // Minimum verifiers for consensus
      verifierReward: 0.2, // 20% of reward goes to verifiers
    };

    // Task priorities
    this.priorityLevels = {
      LOW: 1,
      STANDARD: 2,
      HIGH: 3,
      CRITICAL: 4,
    };
  }

  /**
   * Register a computational node with the system
   *
   * @param {Partial<ComputationalNode>} nodeData - Node details including capabilities and location
   * @returns {string} - Node ID
   */
  registerNode(nodeData: Partial<ComputationalNode>): string {
    if (!nodeData.nodeId) {
      const nodeId = `node-${crypto.randomBytes(16).toString('hex')}`;
      nodeData.nodeId = nodeId;
    }

    if (!nodeData.capabilities) {
      nodeData.capabilities = {
        cpu: {
          cores: 4,
          architecture: 'unknown',
        },
        memory: 8192, // MB
        gpu: null,
        storageAvailable: 1024 * 10, // 10 GB
      };
    }

    // Ensure required fields
    nodeData.status = nodeData.status || 'ACTIVE';
    nodeData.reliability =
      nodeData.reliability !== undefined ? nodeData.reliability : 1.0;
    nodeData.lastSeen = Date.now();

    // Cast to ComputationalNode since we've ensured all required fields are present
    const completeNode = nodeData as ComputationalNode;
    this.nodes.set(completeNode.nodeId, completeNode);

    console.log(`Registered computational node: ${completeNode.nodeId}`);
    return completeNode.nodeId;
  }

  /**
   * Update node status and capabilities
   *
   * @param {string} nodeId - ID of the node to update
   * @param {Partial<ComputationalNode>} updateData - Updated node information
   * @returns {boolean} - Success status
   */
  updateNode(nodeId: string, updateData: Partial<ComputationalNode>): boolean {
    if (!this.nodes.has(nodeId)) {
      console.warn(`Node ${nodeId} not found`);
      return false;
    }

    const node = this.nodes.get(nodeId);
    if (!node) {
      console.warn(`Node ${nodeId} not found`);
      return false;
    }

    // Update fields
    Object.assign(node, updateData);

    // Always update lastSeen
    node.lastSeen = Date.now();

    this.nodes.set(nodeId, node);
    return true;
  }

  /**
   * Create a new computational task
   *
   * @param {Partial<ComputationalTask>} taskData - Task details
   * @returns {string} - Task ID
   */
  createTask(taskData: Partial<ComputationalTask>): string {
    if (!taskData.taskId) {
      const taskId = `task-${crypto.randomBytes(16).toString('hex')}`;
      taskData.taskId = taskId;
    }

    // Ensure required fields
    taskData.status = TASK_STATUSES.CREATED;
    taskData.createdAt = Date.now();
    taskData.priority = taskData.priority || 'STANDARD';
    taskData.baseReward = taskData.baseReward || 10;
    taskData.taskType = taskData.taskType || 'GENERAL';

    // Cast to ComputationalTask since we've ensured all required fields are present
    const completeTask = taskData as ComputationalTask;
    this.tasks.set(completeTask.taskId, completeTask);

    console.log(
      `Created computational task: ${completeTask.taskId} (${completeTask.taskType})`
    );
    return completeTask.taskId;
  }

  /**
   * Find optimal nodes for a task based on specified strategy
   *
   * @param {string} taskId - ID of the task
   * @param {string} strategy - Assignment strategy to use
   * @param {TaskAssignmentOptions} options - Additional options
   * @returns {ComputationalNode[]} - Sorted list of suitable nodes
   */
  findOptimalNodesForTask(
    taskId: string,
    strategy: string = ASSIGNMENT_STRATEGIES.BALANCED,
    options: TaskAssignmentOptions = {}
  ): ComputationalNode[] {
    const task = this.tasks.get(taskId);

    if (!task) {
      console.warn(`Task ${taskId} not found`);
      return [];
    }

    // Get current active nodes
    const activeNodes = Array.from(this.nodes.values()).filter(
      (node: any) => node.status === 'ACTIVE'
    );

    if (activeNodes.length === 0) {
      console.warn(`No active nodes available for task ${taskId}`);
      return [];
    }

    // Mock network state - in a real implementation, this would be obtained from the network
    const networkState = {
      pendingTransactions: 10,
      nodeUsage: 0.7,
      transactionThroughput: 100,
    };

    let suitableNodes: ComputationalNode[] = [];

    switch (strategy) {
      case ASSIGNMENT_STRATEGIES.PROXIMITY_FIRST:
        // Prioritize nodes closest to the task location
        suitableNodes = proximityIncentiveCalculator.selectOptimalNodes(
          task,
          activeNodes,
          networkState
        );
        break;

      case ASSIGNMENT_STRATEGIES.CAPABILITY_FIRST:
        // Prioritize nodes with best capabilities for the task
        suitableNodes = this._rankNodesByCapability(task, activeNodes);
        break;

      case ASSIGNMENT_STRATEGIES.ENERGY_EFFICIENT:
        // Prioritize energy efficiency
        suitableNodes = this._rankNodesByEnergyEfficiency(task, activeNodes);
        break;

      case ASSIGNMENT_STRATEGIES.REDUNDANT:
        // Select a diverse set of nodes for redundant computation
        suitableNodes = this._selectDiverseNodeSet(
          task,
          activeNodes,
          options.redundancyCount || 3
        );
        break;

      case ASSIGNMENT_STRATEGIES.BALANCED:
      default:
        // Balance proximity and capability
        const proximityRanked = proximityIncentiveCalculator.selectOptimalNodes(
          task,
          activeNodes,
          networkState
        );
        const capabilityRanked = this._rankNodesByCapability(task, activeNodes);

        // Combine ranks with balanced weight
        suitableNodes = this._combineNodeRankings(
          proximityRanked,
          capabilityRanked
        );
        break;
    }

    return suitableNodes;
  }

  /**
   * Assign a task to a node
   *
   * @param {string} taskId - ID of the task to assign
   * @param {string} nodeId - ID of the node to assign to (or null for auto-assignment)
   * @param {Object} options - Assignment options
   * @returns {Object} - Assignment details
   */
  assignTask(
    taskId: string,
    nodeId: string | null = null,
    options: AssignmentOptions = {}
  ): TaskAssignment {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.status !== TASK_STATUSES.CREATED) {
      throw new Error(`Task ${taskId} is already ${task.status}`);
    }

    // If no specific node provided, auto-assign based on strategy
    if (!nodeId) {
      const strategy = options.strategy || ASSIGNMENT_STRATEGIES.BALANCED;
      const suitableNodes = this.findOptimalNodesForTask(
        taskId,
        strategy,
        options
      );

      if (suitableNodes.length === 0) {
        throw new Error(`No suitable nodes found for task ${taskId}`);
      }

      // Select the best node
      nodeId = suitableNodes[0].nodeId;
    }

    // Get the node
    const node = this.nodes.get(nodeId);

    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    if (node.status !== 'ACTIVE') {
      throw new Error(`Node ${nodeId} is not active`);
    }

    // Create assignment
    const assignmentId = `assignment-${crypto.randomBytes(12).toString('hex')}`;

    const assignment: TaskAssignment = {
      assignmentId,
      taskId,
      nodeId,
      status: 'ASSIGNED',
      assignedAt: Date.now(),
      verificationRequired: task.requiresVerification || false,
      verificationType:
        options.verificationType || this.verificationConfig.defaultType,
      verifiers: [],
    };

    // If verification is required, assign verifier nodes
    if (assignment.verificationRequired) {
      assignment.verifiers = this._assignVerifiers(task, node, options);
    }

    // Update task status
    task.status = TASK_STATUSES.ASSIGNED;
    task.assignedNodeId = nodeId;
    task.assignedAt = assignment.assignedAt;

    // Store assignment
    this.assignments.set(assignmentId, assignment);
    this.tasks.set(taskId, task);

    console.log(`Assigned task ${taskId} to node ${nodeId}`);

    return assignment;
  }

  /**
   * Start execution of an assigned task
   *
   * @param {string} assignmentId - ID of the assignment
   * @returns {Object} - Updated assignment
   */
  startTaskExecution(assignmentId: string): TaskAssignment {
    const assignment = this.assignments.get(assignmentId);

    if (!assignment) {
      throw new Error(`Assignment ${assignmentId} not found`);
    }

    if (assignment.status !== 'ASSIGNED') {
      throw new Error(
        `Assignment ${assignmentId} is already ${assignment.status}`
      );
    }

    // Update assignment status
    assignment.status = 'IN_PROGRESS';
    assignment.startedAt = Date.now();

    // Update task status
    const task = this.tasks.get(assignment.taskId);
    if (!task) {
      throw new Error(`Task ${assignment.taskId} not found`);
    }

    task.status = TASK_STATUSES.IN_PROGRESS;
    task.startedAt = assignment.startedAt;

    // Store updates
    this.assignments.set(assignmentId, assignment);
    this.tasks.set(task.taskId, task);

    console.log(
      `Started execution of task ${task.taskId} on node ${assignment.nodeId}`
    );

    return assignment;
  }

  /**
   * Submit a completed task result
   *
   * @param {string} assignmentId - ID of the assignment
   * @param {Object} result - Task result data
   * @returns {Promise<Object>} - Result processing outcome
   */
  async submitTaskResult(
    assignmentId: string,
    result: any
  ): Promise<{
    assignmentId: string;
    taskId: string;
    status: string;
    validation: any;
    incentive: any;
  }> {
    const assignment = this.assignments.get(assignmentId);

    if (!assignment) {
      throw new Error(`Assignment ${assignmentId} not found`);
    }

    if (assignment.status !== 'IN_PROGRESS') {
      throw new Error(
        `Cannot submit result for assignment ${assignmentId} with status ${assignment.status}`
      );
    }

    // Get task and node
    const task = this.tasks.get(assignment.taskId);
    const node = this.nodes.get(assignment.nodeId);

    if (!task) {
      throw new Error(`Task ${assignment.taskId} not found`);
    }

    if (!node) {
      throw new Error(`Node ${assignment.nodeId} not found`);
    }

    if (!assignment.startedAt) {
      throw new Error(`Assignment ${assignmentId} has no start time`);
    }

    // Update assignment
    assignment.status = 'COMPLETED';
    assignment.completedAt = Date.now();
    assignment.result = result;
    assignment.executionTime = assignment.completedAt - assignment.startedAt;

    // Update task status
    task.status = TASK_STATUSES.COMPLETED;
    task.completedAt = assignment.completedAt;

    // Mock network state - in a real implementation, this would be obtained from the network
    const networkState = {
      pendingTransactions: 10,
      nodeUsage: 0.7,
      transactionThroughput: 100,
    };

    // Perform validation of the result
    let validationResult;

    try {
      validationResult = await aiValidator.validateTaskAndCalculateIncentives(
        task,
        result,
        node,
        networkState
      );

      // Store validation result
      assignment.validationResult = validationResult;

      // Update task status based on validation
      task.status =
        validationResult.validation.decision === 'ACCEPTED'
          ? TASK_STATUSES.VALIDATED
          : TASK_STATUSES.REJECTED;

      // Update node reliability based on validation
      const reliabilityDelta =
        validationResult.validation.decision === 'ACCEPTED' ? 0.01 : -0.05;
      node.reliability = Math.min(
        1.0,
        Math.max(0.1, node.reliability + reliabilityDelta)
      );

      // Store updates
      this.assignments.set(assignmentId, assignment);
      this.tasks.set(task.taskId, task);
      this.nodes.set(node.nodeId, node);

      console.log(`Validated task ${task.taskId} result: ${task.status}`);

      return {
        assignmentId,
        taskId: task.taskId,
        status: task.status,
        validation: validationResult.validation,
        incentive: validationResult.incentive,
      };
    } catch (error) {
      console.error(`Error validating task ${task.taskId}:`, error);

      // Mark as failed if validation error
      assignment.status = 'FAILED';
      task.status = TASK_STATUSES.FAILED;

      // Store updates
      this.assignments.set(assignmentId, assignment);
      this.tasks.set(task.taskId, task);

      throw error;
    }
  }

  /**
   * Rank nodes by their computational capabilities for a specific task
   *
   * @private
   * @param {Object} task - Task to match
   * @param {Array<Object>} nodes - Available nodes
   * @returns {Array<Object>} - Ranked nodes
   */
  _rankNodesByCapability(
    task: ComputationalTask,
    nodes: ComputationalNode[]
  ): ComputationalNode[] {
    // Calculate capability score for each node
    return nodes
      .map(node => {
        // Extract node capabilities
        const { capabilities } = node;

        // Calculate capability score based on task requirements
        let capabilityScore = 0;

        // CPU score - more cores is better
        if (capabilities.cpu && capabilities.cpu.cores) {
          capabilityScore += Math.min(1, capabilities.cpu.cores / 16) * 0.4; // 40% weight
        }

        // Memory score - more memory is better
        if (capabilities.memory) {
          capabilityScore += Math.min(1, capabilities.memory / 32768) * 0.3; // 30% weight
        }

        // GPU score - presence of GPU is better for computational tasks
        if (capabilities.gpu) {
          capabilityScore += 0.3; // 30% weight
        }

        // Reliability factor
        capabilityScore *= node.reliability;

        return {
          ...node,
          score: capabilityScore,
        };
      })
      .sort((a, b) => b.score - a.score); // Sort by descending score
  }

  /**
   * Rank nodes by energy efficiency for a given task
   *
   * @private
   * @param {Object} task - Task to match
   * @param {Array<Object>} nodes - Available nodes
   * @returns {Array<Object>} - Ranked nodes
   */
  _rankNodesByEnergyEfficiency(
    task: ComputationalTask,
    nodes: ComputationalNode[]
  ): ComputationalNode[] {
    // Calculate energy efficiency score for each node
    return nodes
      .map(node => {
        // Extract node capabilities and efficiency metrics
        const { capabilities, energyEfficiency } = node;

        // Default energy efficiency if not provided
        const efficiency = energyEfficiency || 0.7;

        // Calculate energy efficiency score
        let efficiencyScore = efficiency;

        // Adjust by capability to ensure the node can handle the task
        if (capabilities) {
          // Basic capability check
          const capabilityFactor =
            (capabilities.cpu ? 0.4 : 0) +
            (capabilities.memory ? 0.3 : 0) +
            (capabilities.gpu ? 0.3 : 0);

          efficiencyScore *= 0.3 + 0.7 * capabilityFactor;
        }

        // Reliability factor
        efficiencyScore *= node.reliability;

        return {
          ...node,
          score: efficiencyScore,
        };
      })
      .sort((a, b) => b.score - a.score); // Sort by descending score
  }

  /**
   * Select a diverse set of nodes for redundant computation
   *
   * @private
   * @param {Object} task - Task to match
   * @param {Array<Object>} nodes - Available nodes
   * @param {number} count - Number of nodes to select
   * @returns {Array<Object>} - Selected diverse nodes
   */
  _selectDiverseNodeSet(
    task: ComputationalTask,
    nodes: ComputationalNode[],
    count: number
  ): ComputationalNode[] {
    if (nodes.length <= count) {
      return nodes; // Not enough nodes to select from
    }

    // Create clusters of nodes based on their characteristics
    // For simplicity in this implementation, we'll use a greedy approach

    const selected: ComputationalNode[] = [];
    const remainingNodes = [...nodes];

    // First, select the best node
    const proximityRanked = proximityIncentiveCalculator.selectOptimalNodes(
      task,
      remainingNodes,
      { pendingTransactions: 10, nodeUsage: 0.7 }
    );

    if (proximityRanked.length > 0) {
      selected.push(proximityRanked[0]);
      remainingNodes.splice(
        remainingNodes.findIndex(n => n.nodeId === proximityRanked[0].nodeId),
        1
      );
    }

    // Then select nodes that are different from already selected ones
    while (selected.length < count && remainingNodes.length > 0) {
      // Find the node that's most different from already selected nodes
      const mostDifferent = this._findMostDifferentNode(
        selected,
        remainingNodes
      );

      if (mostDifferent) {
        selected.push(mostDifferent);
        remainingNodes.splice(
          remainingNodes.findIndex(n => n.nodeId === mostDifferent.nodeId),
          1
        );
      } else {
        break;
      }
    }

    return selected;
  }

  /**
   * Find the node that's most different from a set of selected nodes
   *
   * @private
   * @param {Array<Object>} selectedNodes - Already selected nodes
   * @param {Array<Object>} candidateNodes - Candidate nodes to choose from
   * @returns {Object} - The most different node
   */
  _findMostDifferentNode(
    selectedNodes: ComputationalNode[],
    candidateNodes: ComputationalNode[]
  ): ComputationalNode | null {
    if (candidateNodes.length === 0) return null;
    if (selectedNodes.length === 0) return candidateNodes[0];

    // Calculate "difference score" for each candidate
    const scoresByNodeId: { [key: string]: number } = {};

    candidateNodes.forEach(candidate => {
      let totalDifference = 0;

      selectedNodes.forEach(selected => {
        // Calculate difference factors:

        // 1. Geographic distance
        const distance = this._calculateDistance(
          candidate.latitude || candidate.location?.latitude || 0,
          candidate.longitude || candidate.location?.longitude || 0,
          selected.latitude || selected.location?.latitude || 0,
          selected.longitude || selected.location?.longitude || 0
        );
        const distanceFactor = Math.min(1, distance / 5000); // Normalize, max at 5000km

        // 2. Hardware difference
        const hwDifference = this._calculateHardwareDifference(
          candidate,
          selected
        );

        // 3. Provider difference (if they have different providers, that's good)
        const providerDifference =
          candidate.provider === selected.provider ? 0 : 1;

        // Combined difference score for this pair
        const pairDifference =
          distanceFactor * 0.5 + hwDifference * 0.3 + providerDifference * 0.2;
        totalDifference += pairDifference;
      });

      // Average difference across all selected nodes
      scoresByNodeId[candidate.nodeId] = totalDifference / selectedNodes.length;
    });

    // Find candidate with highest difference score
    let maxScore = -1;
    let mostDifferentNode: ComputationalNode | null = null;

    candidateNodes.forEach(candidate => {
      const score = scoresByNodeId[candidate.nodeId];
      if (score > maxScore) {
        maxScore = score;
        mostDifferentNode = candidate;
      }
    });

    return mostDifferentNode;
  }

  /**
   * Calculate hardware difference between two nodes
   *
   * @private
   * @param {Object} node1 - First node
   * @param {Object} node2 - Second node
   * @returns {number} - Difference score (0-1)
   */
  _calculateHardwareDifference(
    node1: ComputationalNode,
    node2: ComputationalNode
  ): number {
    const cap1 = node1.capabilities;
    const cap2 = node2.capabilities;

    // CPU architecture difference
    const cpuDiff = cap1.cpu?.architecture !== cap2.cpu?.architecture ? 1 : 0;

    // Memory difference (normalized)
    const mem1 = cap1.memory || 0;
    const mem2 = cap2.memory || 0;
    const memDiff = Math.abs(mem1 - mem2) / Math.max(mem1, mem2, 1);

    // GPU difference
    const gpuDiff = !!cap1.gpu !== !!cap2.gpu ? 1 : 0;

    // Weighted average of differences
    return cpuDiff * 0.4 + memDiff * 0.3 + gpuDiff * 0.3;
  }

  /**
   * Calculate distance between two points using Haversine formula
   *
   * @private
   * @param {number} lat1 - Latitude of point 1
   * @param {number} lon1 - Longitude of point 1
   * @param {number} lat2 - Latitude of point 2
   * @param {number} lon2 - Longitude of point 2
   * @returns {number} - Distance in kilometers
   */
  _calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    // Use the same implementation as in proximityIncentiveCalculator
    if (!lat1 || !lon1 || !lat2 || !lon2) {
      return 10000; // If coordinates not available, assume far apart
    }

    return proximityIncentiveCalculator.calculateDistance(
      lat1,
      lon1,
      lat2,
      lon2
    );
  }

  /**
   * Combine two node rankings with balanced weighting
   *
   * @private
   * @param {Array<Object>} ranking1 - First ranking
   * @param {Array<Object>} ranking2 - Second ranking
   * @returns {Array<Object>} - Combined ranking
   */
  _combineNodeRankings(
    ranking1: ComputationalNode[],
    ranking2: ComputationalNode[]
  ): ComputationalNode[] {
    // Create map of nodes with their ranks
    const nodeMap = new Map();

    ranking1.forEach((node, index) => {
      nodeMap.set(node.nodeId, {
        node,
        rank1: index,
        rank2: undefined,
      });
    });

    ranking2.forEach((node, index) => {
      if (nodeMap.has(node.nodeId)) {
        nodeMap.get(node.nodeId).rank2 = index;
      } else {
        nodeMap.set(node.nodeId, {
          node,
          rank1: undefined,
          rank2: index,
        });
      }
    });

    // Calculate combined score based on both rankings
    const maxRank1 = ranking1.length - 1;
    const maxRank2 = ranking2.length - 1;

    // Convert to array and add combined scores
    const combinedRanking = Array.from(nodeMap.values()).map(item => {
      const normalizedRank1 =
        item.rank1 !== undefined ? (maxRank1 - item.rank1) / maxRank1 : 0;
      const normalizedRank2 =
        item.rank2 !== undefined ? (maxRank2 - item.rank2) / maxRank2 : 0;

      // Balanced score (50% weight to each ranking)
      const combinedScore = normalizedRank1 * 0.5 + normalizedRank2 * 0.5;

      return {
        ...item.node,
        score: combinedScore,
      };
    });

    // Sort by combined score (descending)
    return combinedRanking.sort((a, b) => b.score - a.score);
  }

  /**
   * Assign verifier nodes for a task
   *
   * @private
   * @param {Object} task - Task to verify
   * @param {Object} assignedNode - Node assigned to the task
   * @param {Object} options - Verification options
   * @returns {Array<string>} - IDs of verifier nodes
   */
  _assignVerifiers(
    task: ComputationalTask,
    assignedNode: ComputationalNode,
    options: AssignmentOptions
  ): string[] {
    const verificationType =
      options.verificationType || this.verificationConfig.defaultType;
    const verifierCount =
      options.verifierCount || this.verificationConfig.minimumVerifiers;

    // For single verification, no additional verifiers needed
    if (verificationType === VERIFICATION_TYPES.SINGLE) {
      return [];
    }

    // Get all nodes except the assigned one
    const candidateVerifiers = Array.from(this.nodes.values()).filter(
      node => node.status === 'ACTIVE' && node.nodeId !== assignedNode.nodeId
    );

    if (candidateVerifiers.length === 0) {
      console.warn(`No candidate verifiers available for task ${task.taskId}`);
      return [];
    }

    // Select diverse set of verifiers
    const verifiers = this._selectDiverseNodeSet(
      task,
      candidateVerifiers,
      verifierCount
    );

    // Return just the node IDs
    return verifiers.map(node => node.nodeId);
  }

  /**
   * Get task information
   *
   * @param {string} taskId - ID of the task
   * @returns {Object} - Task information
   */
  getTaskInfo(taskId: string): {
    task: ComputationalTask;
    assignment: TaskAssignment | null;
    assignedNode: ComputationalNode | null;
  } {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Get associated assignment if any
    let assignment: TaskAssignment | null = null;
    for (const [id, a] of this.assignments.entries()) {
      if (a.taskId === taskId) {
        assignment = a;
        break;
      }
    }

    // Get assigned node if any
    let assignedNode: ComputationalNode | null = null;
    if (task.assignedNodeId) {
      assignedNode = this.nodes.get(task.assignedNodeId) || null;
    }

    return {
      task,
      assignment,
      assignedNode,
    };
  }

  /**
   * Get status counts for tasks and assignments
   *
   * @returns {Object} - Status statistics
   */
  getStatusStatistics(): {
    tasks: Record<string, number>;
    assignments: Record<string, number>;
    totalTasks: number;
    totalAssignments: number;
    totalNodes: number;
  } {
    const taskStatusCounts = {};
    const assignmentStatusCounts = {};

    // Count task statuses
    for (const task of this.tasks.values()) {
      taskStatusCounts[task.status] = (taskStatusCounts[task.status] || 0) + 1;
    }

    // Count assignment statuses
    for (const assignment of this.assignments.values()) {
      assignmentStatusCounts[assignment.status] =
        (assignmentStatusCounts[assignment.status] || 0) + 1;
    }

    return {
      tasks: taskStatusCounts,
      assignments: assignmentStatusCounts,
      totalTasks: this.tasks.size,
      totalAssignments: this.assignments.size,
      totalNodes: this.nodes.size,
    };
  }
}

// Export as singleton
const taskAssignmentManager = new TaskAssignmentManager();
module.exports = {
  taskAssignmentManager,
  ASSIGNMENT_STRATEGIES,
  TASK_STATUSES,
  VERIFICATION_TYPES,
};
