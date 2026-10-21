/**
 * Network Topology Monitor
 * Real-time tracking and prediction of network topology changes
 *
 * SECURITY: Addresses Task 100.9 vulnerabilities:
 * - Tracks network topology in real-time
 * - Predicts potential partition events
 * - Monitors network health metrics
 * - Analyzes connectivity graphs
 * - Tracks geographic distribution
 * - Monitors ASN diversity for resilience
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { blockchainLogger } from '../server/utils/logger.js';

export interface NetworkNode {
  nodeId: string;
  address: string;
  port: number;
  region?: string;
  country?: string;
  asn?: string;
  isp?: string;
  isValidator: boolean;
  stake?: bigint;
  connections: string[]; // Connected node IDs
  latency: Map<string, number>; // nodeId -> latency (ms)
  lastSeen: Date;
  status: 'online' | 'offline' | 'degraded';
}

export interface TopologySnapshot {
  snapshotId: string;
  timestamp: Date;
  nodes: Map<string, NetworkNode>;
  edges: TopologyEdge[];
  clusters: NodeCluster[];
  metrics: TopologyMetrics;
}

export interface TopologyEdge {
  sourceNodeId: string;
  targetNodeId: string;
  latency: number;
  bandwidth?: number;
  reliability: number; // 0-1
  lastUpdated: Date;
}

export interface NodeCluster {
  clusterId: string;
  nodes: string[];
  region?: string;
  asn?: string;
  avgLatency: number;
  isIsolated: boolean;
}

export interface TopologyMetrics {
  totalNodes: number;
  totalEdges: number;
  connectedComponents: number;
  averageConnectivity: number;
  networkDiameter: number;
  clusteringCoefficient: number;
  geographicDiversity: number;
  asnDiversity: number;
  healthScore: number; // 0-100
}

export interface PartitionPrediction {
  predictionId: string;
  predictedAt: Date;
  probability: number; // 0-1
  estimatedTimeToPartition: number; // milliseconds
  affectedNodes: string[];
  affectedRegions: string[];
  riskFactors: RiskFactor[];
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface RiskFactor {
  factor: string;
  impact: number; // 0-1
  description: string;
}

export interface HealthAlert {
  alertId: string;
  timestamp: Date;
  severity: 'info' | 'warning' | 'error' | 'critical';
  metric: string;
  currentValue: number;
  threshold: number;
  affectedNodes: string[];
  message: string;
}

export interface TopologyMonitorConfig {
  snapshotInterval: number; // milliseconds
  predictionInterval: number; // milliseconds
  partitionPredictionThreshold: number; // probability threshold
  healthCheckInterval: number; // milliseconds
  minConnectivity: number; // minimum connections per node
  maxLatency: number; // maximum acceptable latency
  minGeographicDiversity: number;
  minAsnDiversity: number;
  enablePrediction: boolean;
}

/**
 * Network Topology Monitor
 * SECURITY: Monitors and predicts network topology issues
 */
export class NetworkTopologyMonitor extends EventEmitter {
  private nodes: Map<string, NetworkNode> = new Map();
  private topologyHistory: TopologySnapshot[] = [];
  private predictions: PartitionPrediction[] = [];
  private healthAlerts: HealthAlert[] = [];

  private snapshotTimer: NodeJS.Timeout | null = null;
  private predictionTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  private readonly config: TopologyMonitorConfig;

  private static readonly DEFAULT_CONFIG: TopologyMonitorConfig = {
    snapshotInterval: 10000, // 10 seconds
    predictionInterval: 30000, // 30 seconds
    partitionPredictionThreshold: 0.7,
    healthCheckInterval: 5000, // 5 seconds
    minConnectivity: 4,
    maxLatency: 500, // 500ms
    minGeographicDiversity: 3,
    minAsnDiversity: 3,
    enablePrediction: true,
  };

  constructor(config?: Partial<TopologyMonitorConfig>) {
    super();
    this.config = { ...NetworkTopologyMonitor.DEFAULT_CONFIG, ...config };
  }

  /**
   * Start monitoring
   */
  async start(): Promise<void> {
    blockchainLogger.info('Starting network topology monitoring', { module: 'TopologyMonitor' });

    // Start snapshot collection
    this.snapshotTimer = setInterval(
      () => this.captureTopologySnapshot(),
      this.config.snapshotInterval
    );

    // Start prediction
    if (this.config.enablePrediction) {
      this.predictionTimer = setInterval(
        () => this.predictPartitions(),
        this.config.predictionInterval
      );
    }

    // Start health checks
    this.healthCheckTimer = setInterval(
      () => this.performHealthChecks(),
      this.config.healthCheckInterval
    );

    this.emit('started');
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    if (this.predictionTimer) {
      clearInterval(this.predictionTimer);
      this.predictionTimer = null;
    }

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    blockchainLogger.info('Stopped topology monitoring', { module: 'TopologyMonitor' });
    this.emit('stopped');
  }

  /**
   * Register network node
   */
  registerNode(node: NetworkNode): void {
    this.nodes.set(node.nodeId, {
      ...node,
      connections: node.connections || [],
      latency: node.latency || new Map(),
      lastSeen: new Date(),
      status: 'online',
    });

    blockchainLogger.info('Registered node', {
      module: 'TopologyMonitor',
      nodeId: node.nodeId,
      region: node.region || 'unknown',
    });

    this.emit('node_registered', node.nodeId);
  }

  /**
   * Update node connection
   */
  updateConnection(
    sourceNodeId: string,
    targetNodeId: string,
    latency: number
  ): void {
    const sourceNode = this.nodes.get(sourceNodeId);
    const targetNode = this.nodes.get(targetNodeId);

    if (!sourceNode || !targetNode) return;

    // Add bidirectional connection
    if (!sourceNode.connections.includes(targetNodeId)) {
      sourceNode.connections.push(targetNodeId);
    }
    if (!targetNode.connections.includes(sourceNodeId)) {
      targetNode.connections.push(sourceNodeId);
    }

    // Update latency
    sourceNode.latency.set(targetNodeId, latency);
    targetNode.latency.set(sourceNodeId, latency);
  }

  /**
   * Update node status
   */
  updateNodeStatus(
    nodeId: string,
    status: 'online' | 'offline' | 'degraded'
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const oldStatus = node.status;
    node.status = status;
    node.lastSeen = new Date();

    if (oldStatus !== status) {
      blockchainLogger.info('Node status changed', {
        module: 'TopologyMonitor',
        nodeId,
        oldStatus,
        newStatus: status,
      });
      this.emit('node_status_changed', { nodeId, oldStatus, newStatus: status });
    }
  }

  /**
   * Capture topology snapshot
   */
  private async captureTopologySnapshot(): Promise<TopologySnapshot> {
    const snapshotId = crypto.randomBytes(16).toString('hex');

    // Build topology edges
    const edges = this.buildTopologyEdges();

    // Identify clusters
    const clusters = this.identifyClusters();

    // Calculate metrics
    const metrics = this.calculateTopologyMetrics(edges, clusters);

    const snapshot: TopologySnapshot = {
      snapshotId,
      timestamp: new Date(),
      nodes: new Map(this.nodes),
      edges,
      clusters,
      metrics,
    };

    this.topologyHistory.push(snapshot);

    // Keep only recent history (last 100 snapshots)
    if (this.topologyHistory.length > 100) {
      this.topologyHistory.shift();
    }

    this.emit('snapshot_captured', snapshot);

    return snapshot;
  }

  /**
   * Build topology edges
   */
  private buildTopologyEdges(): TopologyEdge[] {
    const edges: TopologyEdge[] = [];
    const processed = new Set<string>();

    for (const [sourceId, sourceNode] of this.nodes) {
      for (const targetId of sourceNode.connections) {
        // Avoid duplicate edges (undirected graph)
        const edgeKey = [sourceId, targetId].sort().join('-');
        if (processed.has(edgeKey)) continue;

        processed.add(edgeKey);

        const latency = sourceNode.latency.get(targetId) || 0;

        // Calculate reliability based on historical data
        const reliability = this.calculateEdgeReliability(sourceId, targetId);

        edges.push({
          sourceNodeId: sourceId,
          targetNodeId: targetId,
          latency,
          reliability,
          lastUpdated: new Date(),
        });
      }
    }

    return edges;
  }

  /**
   * Calculate edge reliability
   */
  private calculateEdgeReliability(nodeA: string, nodeB: string): number {
    // In production, would analyze historical connectivity
    // For now, use latency as proxy
    const nodeAData = this.nodes.get(nodeA);
    const latency = nodeAData?.latency.get(nodeB) || Infinity;

    if (latency === Infinity) return 0;
    if (latency < 50) return 1.0;
    if (latency < 100) return 0.9;
    if (latency < 200) return 0.7;
    if (latency < 500) return 0.5;
    return 0.3;
  }

  /**
   * Identify network clusters
   */
  private identifyClusters(): NodeCluster[] {
    const clusters: NodeCluster[] = [];
    const visited = new Set<string>();

    // Group by region
    const regionGroups = new Map<string, string[]>();
    for (const [nodeId, node] of this.nodes) {
      const region = node.region || 'unknown';
      if (!regionGroups.has(region)) {
        regionGroups.set(region, []);
      }
      regionGroups.get(region)!.push(nodeId);
    }

    // Create clusters from regions
    for (const [region, nodes] of regionGroups) {
      if (nodes.length === 0) continue;

      // Calculate average latency within cluster
      let totalLatency = 0;
      let latencyCount = 0;

      for (const nodeId of nodes) {
        const node = this.nodes.get(nodeId)!;
        for (const otherId of nodes) {
          if (nodeId === otherId) continue;
          const latency = node.latency.get(otherId);
          if (latency !== undefined) {
            totalLatency += latency;
            latencyCount++;
          }
        }
      }

      const avgLatency = latencyCount > 0 ? totalLatency / latencyCount : 0;

      // Check if cluster is isolated
      const isIsolated = this.isClusterIsolated(nodes);

      clusters.push({
        clusterId: crypto.randomBytes(8).toString('hex'),
        nodes,
        region,
        avgLatency,
        isIsolated,
      });
    }

    return clusters;
  }

  /**
   * Check if cluster is isolated
   */
  private isClusterIsolated(clusterNodes: string[]): boolean {
    const clusterSet = new Set(clusterNodes);

    // Check if any node in cluster connects outside
    for (const nodeId of clusterNodes) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;

      for (const connectedId of node.connections) {
        if (!clusterSet.has(connectedId)) {
          return false; // Has external connection
        }
      }
    }

    return true; // No external connections
  }

  /**
   * Calculate topology metrics
   */
  private calculateTopologyMetrics(
    edges: TopologyEdge[],
    clusters: NodeCluster[]
  ): TopologyMetrics {
    const totalNodes = this.nodes.size;
    const totalEdges = edges.length;

    // Calculate average connectivity
    const totalConnections = Array.from(this.nodes.values()).reduce(
      (sum, node) => sum + node.connections.length,
      0
    );
    const averageConnectivity = totalNodes > 0 ? totalConnections / totalNodes : 0;

    // Calculate connected components
    const connectedComponents = this.calculateConnectedComponents();

    // Calculate network diameter (longest shortest path)
    const networkDiameter = this.calculateNetworkDiameter();

    // Calculate clustering coefficient
    const clusteringCoefficient = this.calculateClusteringCoefficient();

    // Calculate geographic diversity
    const regions = new Set(
      Array.from(this.nodes.values())
        .map((n) => n.region)
        .filter(Boolean)
    );
    const geographicDiversity = regions.size;

    // Calculate ASN diversity
    const asns = new Set(
      Array.from(this.nodes.values())
        .map((n) => n.asn)
        .filter(Boolean)
    );
    const asnDiversity = asns.size;

    // Calculate health score
    const healthScore = this.calculateHealthScore({
      averageConnectivity,
      geographicDiversity,
      asnDiversity,
      connectedComponents,
    });

    return {
      totalNodes,
      totalEdges,
      connectedComponents,
      averageConnectivity,
      networkDiameter,
      clusteringCoefficient,
      geographicDiversity,
      asnDiversity,
      healthScore,
    };
  }

  /**
   * Calculate connected components
   */
  private calculateConnectedComponents(): number {
    const visited = new Set<string>();
    let components = 0;

    for (const nodeId of this.nodes.keys()) {
      if (visited.has(nodeId)) continue;

      // BFS to find component
      const queue = [nodeId];
      visited.add(nodeId);

      while (queue.length > 0) {
        const current = queue.shift()!;
        const node = this.nodes.get(current);
        if (!node) continue;

        for (const connectedId of node.connections) {
          if (!visited.has(connectedId)) {
            visited.add(connectedId);
            queue.push(connectedId);
          }
        }
      }

      components++;
    }

    return components;
  }

  /**
   * Calculate network diameter
   */
  private calculateNetworkDiameter(): number {
    // Simplified: use average path length as proxy
    // In production, would use Floyd-Warshall algorithm
    let maxDistance = 0;

    for (const nodeId of this.nodes.keys()) {
      const distances = this.bfsDistances(nodeId);
      const maxNodeDistance = Math.max(...Array.from(distances.values()));
      if (maxNodeDistance > maxDistance && maxNodeDistance !== Infinity) {
        maxDistance = maxNodeDistance;
      }
    }

    return maxDistance;
  }

  /**
   * BFS to calculate distances from node
   */
  private bfsDistances(startNodeId: string): Map<string, number> {
    const distances = new Map<string, number>();
    const queue: [string, number][] = [[startNodeId, 0]];
    const visited = new Set<string>([startNodeId]);

    distances.set(startNodeId, 0);

    while (queue.length > 0) {
      const [nodeId, distance] = queue.shift()!;
      const node = this.nodes.get(nodeId);
      if (!node) continue;

      for (const connectedId of node.connections) {
        if (!visited.has(connectedId)) {
          visited.add(connectedId);
          distances.set(connectedId, distance + 1);
          queue.push([connectedId, distance + 1]);
        }
      }
    }

    return distances;
  }

  /**
   * Calculate clustering coefficient
   */
  private calculateClusteringCoefficient(): number {
    let totalCoefficient = 0;
    let nodeCount = 0;

    for (const [nodeId, node] of this.nodes) {
      const neighbors = node.connections;
      if (neighbors.length < 2) continue;

      // Count connections between neighbors
      let neighborConnections = 0;
      for (let i = 0; i < neighbors.length; i++) {
        for (let j = i + 1; j < neighbors.length; j++) {
          const neighborA = this.nodes.get(neighbors[i]);
          if (neighborA?.connections.includes(neighbors[j])) {
            neighborConnections++;
          }
        }
      }

      const possibleConnections = (neighbors.length * (neighbors.length - 1)) / 2;
      const coefficient =
        possibleConnections > 0 ? neighborConnections / possibleConnections : 0;

      totalCoefficient += coefficient;
      nodeCount++;
    }

    return nodeCount > 0 ? totalCoefficient / nodeCount : 0;
  }

  /**
   * Calculate health score
   */
  private calculateHealthScore(params: {
    averageConnectivity: number;
    geographicDiversity: number;
    asnDiversity: number;
    connectedComponents: number;
  }): number {
    let score = 100;

    // Penalize low connectivity
    if (params.averageConnectivity < this.config.minConnectivity) {
      score -= (this.config.minConnectivity - params.averageConnectivity) * 10;
    }

    // Penalize low geographic diversity
    if (params.geographicDiversity < this.config.minGeographicDiversity) {
      score -=
        (this.config.minGeographicDiversity - params.geographicDiversity) * 5;
    }

    // Penalize low ASN diversity
    if (params.asnDiversity < this.config.minAsnDiversity) {
      score -= (this.config.minAsnDiversity - params.asnDiversity) * 5;
    }

    // Penalize multiple components (network fragmentation)
    if (params.connectedComponents > 1) {
      score -= (params.connectedComponents - 1) * 20;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Predict potential partitions
   */
  private async predictPartitions(): Promise<void> {
    if (this.topologyHistory.length < 3) return; // Need history for prediction

    const latestSnapshot = this.topologyHistory[this.topologyHistory.length - 1];
    const riskFactors: RiskFactor[] = [];

    // Analyze trends
    const healthTrend = this.analyzeHealthTrend();
    if (healthTrend < 0) {
      riskFactors.push({
        factor: 'declining_health',
        impact: Math.abs(healthTrend),
        description: `Network health declining at ${healthTrend.toFixed(2)}% per snapshot`,
      });
    }

    // Check for isolated clusters
    const isolatedClusters = latestSnapshot.clusters.filter((c) => c.isIsolated);
    if (isolatedClusters.length > 0) {
      riskFactors.push({
        factor: 'isolated_clusters',
        impact: isolatedClusters.length * 0.2,
        description: `${isolatedClusters.length} isolated cluster(s) detected`,
      });
    }

    // Check for low connectivity nodes
    const lowConnectivityNodes = Array.from(this.nodes.values()).filter(
      (n) => n.connections.length < this.config.minConnectivity
    );
    if (lowConnectivityNodes.length > 0) {
      riskFactors.push({
        factor: 'low_connectivity',
        impact: (lowConnectivityNodes.length / this.nodes.size) * 0.5,
        description: `${lowConnectivityNodes.length} node(s) with low connectivity`,
      });
    }

    // Calculate overall probability
    const probability = Math.min(
      1.0,
      riskFactors.reduce((sum, f) => sum + f.impact, 0)
    );

    if (probability >= this.config.partitionPredictionThreshold) {
      const prediction: PartitionPrediction = {
        predictionId: crypto.randomBytes(16).toString('hex'),
        predictedAt: new Date(),
        probability,
        estimatedTimeToPartition: this.estimateTimeToPartition(probability),
        affectedNodes: lowConnectivityNodes.map((n) => n.nodeId),
        affectedRegions: [
          ...new Set(isolatedClusters.map((c) => c.region).filter(Boolean)),
        ] as string[],
        riskFactors,
        severity: this.classifyPredictionSeverity(probability),
      };

      this.predictions.push(prediction);

      blockchainLogger.warn('PARTITION PREDICTED', {
        module: 'TopologyMonitor',
        probability: parseFloat((probability * 100).toFixed(1)),
        predictionId: prediction.predictionId,
        severity: prediction.severity,
        affectedNodes: prediction.affectedNodes.length,
      });

      this.emit('partition_predicted', prediction);
    }
  }

  /**
   * Analyze health trend
   */
  private analyzeHealthTrend(): number {
    if (this.topologyHistory.length < 3) return 0;

    const recentSnapshots = this.topologyHistory.slice(-5);
    const healthScores = recentSnapshots.map((s) => s.metrics.healthScore);

    // Calculate linear regression slope
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    const n = healthScores.length;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += healthScores[i];
      sumXY += i * healthScores[i];
      sumX2 += i * i;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }

  /**
   * Estimate time to partition
   */
  private estimateTimeToPartition(probability: number): number {
    // Simple heuristic: higher probability = sooner partition
    const baseTime = 3600000; // 1 hour
    return Math.floor(baseTime * (1 - probability));
  }

  /**
   * Classify prediction severity
   */
  private classifyPredictionSeverity(
    probability: number
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (probability >= 0.9) return 'critical';
    if (probability >= 0.8) return 'high';
    if (probability >= 0.7) return 'medium';
    return 'low';
  }

  /**
   * Perform health checks
   */
  private async performHealthChecks(): Promise<void> {
    const snapshot = await this.captureTopologySnapshot();
    const metrics = snapshot.metrics;

    // Check connectivity
    if (metrics.averageConnectivity < this.config.minConnectivity) {
      this.createHealthAlert(
        'warning',
        'average_connectivity',
        metrics.averageConnectivity,
        this.config.minConnectivity,
        'Average connectivity below threshold'
      );
    }

    // Check geographic diversity
    if (metrics.geographicDiversity < this.config.minGeographicDiversity) {
      this.createHealthAlert(
        'warning',
        'geographic_diversity',
        metrics.geographicDiversity,
        this.config.minGeographicDiversity,
        'Geographic diversity below threshold'
      );
    }

    // Check health score
    if (metrics.healthScore < 70) {
      this.createHealthAlert(
        metrics.healthScore < 50 ? 'error' : 'warning',
        'health_score',
        metrics.healthScore,
        70,
        `Network health score is ${metrics.healthScore.toFixed(1)}`
      );
    }
  }

  /**
   * Create health alert
   */
  private createHealthAlert(
    severity: HealthAlert['severity'],
    metric: string,
    currentValue: number,
    threshold: number,
    message: string
  ): void {
    const alert: HealthAlert = {
      alertId: crypto.randomBytes(16).toString('hex'),
      timestamp: new Date(),
      severity,
      metric,
      currentValue,
      threshold,
      affectedNodes: [],
      message,
    };

    this.healthAlerts.push(alert);

    // Keep only recent alerts (last 100)
    if (this.healthAlerts.length > 100) {
      this.healthAlerts.shift();
    }

    blockchainLogger.warn('Health alert', {
      module: 'TopologyMonitor',
      severity,
      metric,
      currentValue,
      threshold,
      message,
    });

    this.emit('health_alert', alert);
  }

  /**
   * Get current topology snapshot
   */
  getCurrentTopology(): TopologySnapshot | null {
    return this.topologyHistory[this.topologyHistory.length - 1] || null;
  }

  /**
   * Get topology history
   */
  getTopologyHistory(): TopologySnapshot[] {
    return [...this.topologyHistory];
  }

  /**
   * Get predictions
   */
  getPredictions(): PartitionPrediction[] {
    return [...this.predictions];
  }

  /**
   * Get health alerts
   */
  getHealthAlerts(): HealthAlert[] {
    return [...this.healthAlerts];
  }

  /**
   * Get monitor status
   */
  getStatus(): {
    totalNodes: number;
    onlineNodes: number;
    offlineNodes: number;
    degradedNodes: number;
    predictions: number;
    healthAlerts: number;
    currentHealthScore: number;
  } {
    const currentTopology = this.getCurrentTopology();

    return {
      totalNodes: this.nodes.size,
      onlineNodes: Array.from(this.nodes.values()).filter(
        (n) => n.status === 'online'
      ).length,
      offlineNodes: Array.from(this.nodes.values()).filter(
        (n) => n.status === 'offline'
      ).length,
      degradedNodes: Array.from(this.nodes.values()).filter(
        (n) => n.status === 'degraded'
      ).length,
      predictions: this.predictions.length,
      healthAlerts: this.healthAlerts.length,
      currentHealthScore: currentTopology?.metrics.healthScore || 0,
    };
  }
}
