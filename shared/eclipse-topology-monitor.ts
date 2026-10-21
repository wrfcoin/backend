/**
 * Eclipse Attack Protection - Network Topology Monitoring
 *
 * Comprehensive network topology analysis to detect Eclipse attack patterns
 * and network isolation attempts through graph-based metrics and anomaly detection.
 *
 * Key Features:
 * - Real-time connection graph construction
 * - Betweenness centrality analysis for critical nodes
 * - Clustering coefficient calculation
 * - Network diameter monitoring
 * - Partition detection algorithms
 * - Historical trend analysis
 * - Anomaly detection and alerting
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface NetworkNode {
  nodeId: string;
  connections: Set<string>; // Connected node IDs
  lastSeen: Date;
  isActive: boolean;
  geographicRegion: string;
  reputation: number;
}

export interface NetworkEdge {
  source: string;
  target: string;
  latency: number;
  bandwidth: number;
  established: Date;
  lastActivity: Date;
  trafficVolume: number;
}

export interface TopologyMetrics {
  timestamp: Date;
  totalNodes: number;
  totalEdges: number;
  averageDegree: number;
  networkDiameter: number;
  averagePathLength: number;
  clusteringCoefficient: number;
  connectedComponents: number;
  largestComponentSize: number;
  isolatedNodes: number;
  centralityMetrics: Map<string, CentralityMetrics>;
}

export interface CentralityMetrics {
  nodeId: string;
  degreeCentrality: number;
  betweennessCentrality: number;
  closenessCentrality: number;
  eigenvectorCentrality: number;
  isCriticalNode: boolean;
}

export interface TopologyAnomaly {
  type: AnomalyType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  affectedNodes: string[];
  detectedAt: Date;
  metrics: any;
}

export enum AnomalyType {
  SUDDEN_DISCONNECT = 'SUDDEN_DISCONNECT',
  CLUSTERING_ATTACK = 'CLUSTERING_ATTACK',
  PARTITION_DETECTED = 'PARTITION_DETECTED',
  TRAFFIC_ANOMALY = 'TRAFFIC_ANOMALY',
  GEOGRAPHIC_ISOLATION = 'GEOGRAPHIC_ISOLATION',
  COORDINATED_DISCONNECT = 'COORDINATED_DISCONNECT',
  CRITICAL_NODE_FAILURE = 'CRITICAL_NODE_FAILURE',
  UNUSUAL_TOPOLOGY_CHANGE = 'UNUSUAL_TOPOLOGY_CHANGE'
}

export interface PartitionInfo {
  partitions: Set<string>[];
  bridgeNodes: string[];
  isolatedRegions: string[];
}

// ============================================================================
// Network Topology Monitor
// ============================================================================

export class NetworkTopologyMonitor extends EventEmitter {
  private nodes: Map<string, NetworkNode> = new Map();
  private edges: Map<string, NetworkEdge> = new Map();
  private adjacencyList: Map<string, Set<string>> = new Map();
  private metricsHistory: TopologyMetrics[] = [];
  private anomalyHistory: TopologyAnomaly[] = [];

  private readonly maxHistorySize = 1000;
  private readonly quickScanInterval = 30000; // 30 seconds
  private readonly fullAnalysisInterval = 300000; // 5 minutes
  private readonly historicalAnalysisInterval = 3600000; // 1 hour

  private quickScanTimer?: NodeJS.Timeout;
  private fullAnalysisTimer?: NodeJS.Timeout;
  private historicalAnalysisTimer?: NodeJS.Timeout;

  constructor() {
    super();
    this.startMonitoring();
  }

  // ============================================================================
  // Monitoring Lifecycle
  // ============================================================================

  /**
   * Start all monitoring tasks
   */
  public startMonitoring(): void {
    this.quickScanTimer = setInterval(
      () => this.performQuickScan(),
      this.quickScanInterval
    );

    this.fullAnalysisTimer = setInterval(
      () => this.performFullAnalysis(),
      this.fullAnalysisInterval
    );

    this.historicalAnalysisTimer = setInterval(
      () => this.performHistoricalAnalysis(),
      this.historicalAnalysisInterval
    );

    this.emit('monitoringStarted');
  }

  /**
   * Stop all monitoring tasks
   */
  public stopMonitoring(): void {
    if (this.quickScanTimer) clearInterval(this.quickScanTimer);
    if (this.fullAnalysisTimer) clearInterval(this.fullAnalysisTimer);
    if (this.historicalAnalysisTimer) clearInterval(this.historicalAnalysisTimer);
    this.emit('monitoringStopped');
  }

  // ============================================================================
  // Graph Construction
  // ============================================================================

  /**
   * Add node to network graph
   */
  public addNode(node: NetworkNode): void {
    this.nodes.set(node.nodeId, node);
    if (!this.adjacencyList.has(node.nodeId)) {
      this.adjacencyList.set(node.nodeId, new Set());
    }
    this.emit('nodeAdded', node);
  }

  /**
   * Remove node from network graph
   */
  public removeNode(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    // Remove all edges connected to this node
    const edgesToRemove: string[] = [];
    this.edges.forEach((edge, edgeId) => {
      if (edge.source === nodeId || edge.target === nodeId) {
        edgesToRemove.push(edgeId);
      }
    });
    edgesToRemove.forEach(edgeId => this.edges.delete(edgeId));

    // Remove from adjacency list
    this.adjacencyList.delete(nodeId);
    this.adjacencyList.forEach(neighbors => neighbors.delete(nodeId));

    this.nodes.delete(nodeId);
    this.emit('nodeRemoved', { nodeId, node });
  }

  /**
   * Add edge (connection) between nodes
   */
  public addEdge(edge: NetworkEdge): void {
    const edgeId = this.getEdgeId(edge.source, edge.target);
    this.edges.set(edgeId, edge);

    // Update adjacency list
    if (!this.adjacencyList.has(edge.source)) {
      this.adjacencyList.set(edge.source, new Set());
    }
    if (!this.adjacencyList.has(edge.target)) {
      this.adjacencyList.set(edge.target, new Set());
    }

    this.adjacencyList.get(edge.source)!.add(edge.target);
    this.adjacencyList.get(edge.target)!.add(edge.source);

    this.emit('edgeAdded', edge);
  }

  /**
   * Remove edge between nodes
   */
  public removeEdge(source: string, target: string): void {
    const edgeId = this.getEdgeId(source, target);
    const edge = this.edges.get(edgeId);

    if (edge) {
      this.edges.delete(edgeId);
      this.adjacencyList.get(source)?.delete(target);
      this.adjacencyList.get(target)?.delete(source);
      this.emit('edgeRemoved', edge);
    }
  }

  /**
   * Update edge properties
   */
  public updateEdge(source: string, target: string, updates: Partial<NetworkEdge>): void {
    const edgeId = this.getEdgeId(source, target);
    const edge = this.edges.get(edgeId);
    if (edge) {
      Object.assign(edge, updates);
      this.emit('edgeUpdated', edge);
    }
  }

  private getEdgeId(source: string, target: string): string {
    return [source, target].sort().join('::');
  }

  // ============================================================================
  // Quick Scan (Every 30 seconds)
  // ============================================================================

  private async performQuickScan(): Promise<void> {
    try {
      // Check for sudden disconnections
      const suddenDisconnects = this.detectSuddenDisconnections();
      if (suddenDisconnects.length > 0) {
        this.reportAnomaly({
          type: AnomalyType.SUDDEN_DISCONNECT,
          severity: 'HIGH',
          description: `${suddenDisconnects.length} nodes suddenly disconnected`,
          affectedNodes: suddenDisconnects,
          detectedAt: new Date(),
          metrics: { count: suddenDisconnects.length }
        });
      }

      // Check for coordinated disconnections
      const coordinatedDisconnects = this.detectCoordinatedDisconnections();
      if (coordinatedDisconnects.length > 0) {
        this.reportAnomaly({
          type: AnomalyType.COORDINATED_DISCONNECT,
          severity: 'CRITICAL',
          description: 'Coordinated disconnection pattern detected',
          affectedNodes: coordinatedDisconnects,
          detectedAt: new Date(),
          metrics: { pattern: 'coordinated' }
        });
      }

      this.emit('quickScanComplete');
    } catch (error) {
      this.emit('scanError', { type: 'quick', error });
    }
  }

  /**
   * Detect sudden disconnections (nodes going offline rapidly)
   */
  private detectSuddenDisconnections(): string[] {
    const now = Date.now();
    const threshold = 60000; // 1 minute
    const disconnected: string[] = [];

    this.nodes.forEach((node, nodeId) => {
      if (node.isActive && now - node.lastSeen.getTime() > threshold) {
        disconnected.push(nodeId);
        node.isActive = false;
      }
    });

    return disconnected;
  }

  /**
   * Detect coordinated disconnections (multiple nodes disconnecting simultaneously)
   */
  private detectCoordinatedDisconnections(): string[] {
    const recentDisconnects: Array<{ nodeId: string; time: number }> = [];
    const now = Date.now();
    const timeWindow = 10000; // 10 seconds

    this.nodes.forEach((node, nodeId) => {
      const timeSinceLastSeen = now - node.lastSeen.getTime();
      if (!node.isActive && timeSinceLastSeen < timeWindow) {
        recentDisconnects.push({ nodeId, time: timeSinceLastSeen });
      }
    });

    // If more than 20% of nodes disconnected within time window
    const threshold = Math.max(5, this.nodes.size * 0.2);
    if (recentDisconnects.length >= threshold) {
      return recentDisconnects.map(d => d.nodeId);
    }

    return [];
  }

  // ============================================================================
  // Full Analysis (Every 5 minutes)
  // ============================================================================

  private async performFullAnalysis(): Promise<TopologyMetrics> {
    try {
      const metrics = this.calculateTopologyMetrics();
      this.metricsHistory.push(metrics);

      // Trim history
      if (this.metricsHistory.length > this.maxHistorySize) {
        this.metricsHistory.shift();
      }

      // Detect anomalies
      await this.detectTopologyAnomalies(metrics);

      this.emit('fullAnalysisComplete', metrics);
      return metrics;
    } catch (error) {
      this.emit('scanError', { type: 'full', error });
      throw error;
    }
  }

  /**
   * Calculate comprehensive topology metrics
   */
  public calculateTopologyMetrics(): TopologyMetrics {
    const activeNodes = Array.from(this.nodes.values()).filter(n => n.isActive);
    const totalNodes = activeNodes.length;
    const totalEdges = this.edges.size;

    // Calculate average degree
    let totalDegree = 0;
    activeNodes.forEach(node => {
      totalDegree += node.connections.size;
    });
    const averageDegree = totalNodes > 0 ? totalDegree / totalNodes : 0;

    // Calculate connected components
    const components = this.findConnectedComponents();
    const largestComponent = Math.max(...components.map(c => c.size), 0);
    const isolatedNodes = components.filter(c => c.size === 1).length;

    // Calculate network diameter and average path length
    const { diameter, avgPathLength } = this.calculateDistanceMetrics();

    // Calculate clustering coefficient
    const clusteringCoefficient = this.calculateClusteringCoefficient();

    // Calculate centrality metrics
    const centralityMetrics = this.calculateCentralityMetrics();

    return {
      timestamp: new Date(),
      totalNodes,
      totalEdges,
      averageDegree,
      networkDiameter: diameter,
      averagePathLength: avgPathLength,
      clusteringCoefficient,
      connectedComponents: components.length,
      largestComponentSize: largestComponent,
      isolatedNodes,
      centralityMetrics
    };
  }

  /**
   * Find connected components using DFS
   */
  private findConnectedComponents(): Set<string>[] {
    const visited = new Set<string>();
    const components: Set<string>[] = [];

    this.nodes.forEach((node, nodeId) => {
      if (!node.isActive || visited.has(nodeId)) return;

      const component = new Set<string>();
      this.dfsComponent(nodeId, visited, component);
      components.push(component);
    });

    return components;
  }

  private dfsComponent(nodeId: string, visited: Set<string>, component: Set<string>): void {
    visited.add(nodeId);
    component.add(nodeId);

    const neighbors = this.adjacencyList.get(nodeId) || new Set();
    neighbors.forEach(neighbor => {
      const node = this.nodes.get(neighbor);
      if (node?.isActive && !visited.has(neighbor)) {
        this.dfsComponent(neighbor, visited, component);
      }
    });
  }

  /**
   * Calculate network diameter and average path length using BFS
   */
  private calculateDistanceMetrics(): { diameter: number; avgPathLength: number } {
    const activeNodes = Array.from(this.nodes.values())
      .filter(n => n.isActive)
      .map(n => n.nodeId);

    if (activeNodes.length === 0) {
      return { diameter: 0, avgPathLength: 0 };
    }

    let maxDistance = 0;
    let totalDistance = 0;
    let pathCount = 0;

    // Calculate shortest paths from each node
    activeNodes.forEach(sourceId => {
      const distances = this.bfsDistances(sourceId);

      distances.forEach((distance, targetId) => {
        if (distance > 0 && distance < Infinity) {
          maxDistance = Math.max(maxDistance, distance);
          totalDistance += distance;
          pathCount++;
        }
      });
    });

    const avgPathLength = pathCount > 0 ? totalDistance / pathCount : 0;

    return {
      diameter: maxDistance,
      avgPathLength
    };
  }

  /**
   * BFS to calculate distances from source node
   */
  private bfsDistances(sourceId: string): Map<string, number> {
    const distances = new Map<string, number>();
    const queue: string[] = [sourceId];
    distances.set(sourceId, 0);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentDistance = distances.get(currentId)!;

      const neighbors = this.adjacencyList.get(currentId) || new Set();
      neighbors.forEach(neighborId => {
        const node = this.nodes.get(neighborId);
        if (node?.isActive && !distances.has(neighborId)) {
          distances.set(neighborId, currentDistance + 1);
          queue.push(neighborId);
        }
      });
    }

    return distances;
  }

  /**
   * Calculate clustering coefficient
   */
  private calculateClusteringCoefficient(): number {
    let totalCoefficient = 0;
    let nodeCount = 0;

    this.nodes.forEach((node, nodeId) => {
      if (!node.isActive) return;

      const neighbors = Array.from(this.adjacencyList.get(nodeId) || [])
        .filter(nId => this.nodes.get(nId)?.isActive);

      if (neighbors.length < 2) return;

      // Count edges between neighbors
      let edgesBetweenNeighbors = 0;
      for (let i = 0; i < neighbors.length; i++) {
        for (let j = i + 1; j < neighbors.length; j++) {
          const edgeId = this.getEdgeId(neighbors[i], neighbors[j]);
          if (this.edges.has(edgeId)) {
            edgesBetweenNeighbors++;
          }
        }
      }

      const possibleEdges = (neighbors.length * (neighbors.length - 1)) / 2;
      const coefficient = edgesBetweenNeighbors / possibleEdges;
      totalCoefficient += coefficient;
      nodeCount++;
    });

    return nodeCount > 0 ? totalCoefficient / nodeCount : 0;
  }

  /**
   * Calculate centrality metrics for all nodes
   */
  private calculateCentralityMetrics(): Map<string, CentralityMetrics> {
    const metrics = new Map<string, CentralityMetrics>();
    const activeNodes = Array.from(this.nodes.values()).filter(n => n.isActive);

    // Calculate degree centrality
    const degreeCentrality = this.calculateDegreeCentrality();

    // Calculate betweenness centrality
    const betweennessCentrality = this.calculateBetweennessCentrality();

    // Calculate closeness centrality
    const closenessCentrality = this.calculateClosenessCentrality();

    // Calculate eigenvector centrality (simplified)
    const eigenvectorCentrality = this.calculateEigenvectorCentrality();

    // Combine metrics
    activeNodes.forEach(node => {
      const nodeId = node.nodeId;
      const isCriticalNode = betweennessCentrality.get(nodeId)! > 0.1; // Top 10% betweenness

      metrics.set(nodeId, {
        nodeId,
        degreeCentrality: degreeCentrality.get(nodeId) || 0,
        betweennessCentrality: betweennessCentrality.get(nodeId) || 0,
        closenessCentrality: closenessCentrality.get(nodeId) || 0,
        eigenvectorCentrality: eigenvectorCentrality.get(nodeId) || 0,
        isCriticalNode
      });
    });

    return metrics;
  }

  private calculateDegreeCentrality(): Map<string, number> {
    const centrality = new Map<string, number>();
    const maxDegree = this.nodes.size - 1;

    this.nodes.forEach((node, nodeId) => {
      if (node.isActive) {
        const degree = node.connections.size;
        centrality.set(nodeId, maxDegree > 0 ? degree / maxDegree : 0);
      }
    });

    return centrality;
  }

  private calculateBetweennessCentrality(): Map<string, number> {
    const centrality = new Map<string, number>();
    const activeNodes = Array.from(this.nodes.values())
      .filter(n => n.isActive)
      .map(n => n.nodeId);

    // Initialize
    activeNodes.forEach(nodeId => centrality.set(nodeId, 0));

    // For each pair of nodes, find shortest paths
    activeNodes.forEach(sourceId => {
      const pathsThrough = this.calculatePathsThrough(sourceId);

      pathsThrough.forEach((count, nodeId) => {
        if (nodeId !== sourceId) {
          centrality.set(nodeId, centrality.get(nodeId)! + count);
        }
      });
    });

    // Normalize
    const normFactor = (activeNodes.length - 1) * (activeNodes.length - 2);
    if (normFactor > 0) {
      centrality.forEach((value, nodeId) => {
        centrality.set(nodeId, value / normFactor);
      });
    }

    return centrality;
  }

  private calculatePathsThrough(sourceId: string): Map<string, number> {
    const pathCount = new Map<string, number>();
    const distances = this.bfsDistances(sourceId);

    // Count how many shortest paths go through each node
    distances.forEach((distance, nodeId) => {
      if (nodeId !== sourceId && distance < Infinity) {
        pathCount.set(nodeId, (pathCount.get(nodeId) || 0) + 1);
      }
    });

    return pathCount;
  }

  private calculateClosenessCentrality(): Map<string, number> {
    const centrality = new Map<string, number>();
    const activeNodes = Array.from(this.nodes.values())
      .filter(n => n.isActive)
      .map(n => n.nodeId);

    activeNodes.forEach(nodeId => {
      const distances = this.bfsDistances(nodeId);
      let totalDistance = 0;
      let reachableNodes = 0;

      distances.forEach((distance, targetId) => {
        if (targetId !== nodeId && distance < Infinity) {
          totalDistance += distance;
          reachableNodes++;
        }
      });

      if (totalDistance > 0) {
        centrality.set(nodeId, reachableNodes / totalDistance);
      } else {
        centrality.set(nodeId, 0);
      }
    });

    return centrality;
  }

  private calculateEigenvectorCentrality(): Map<string, number> {
    const centrality = new Map<string, number>();
    const activeNodes = Array.from(this.nodes.values())
      .filter(n => n.isActive)
      .map(n => n.nodeId);

    // Initialize with equal values
    activeNodes.forEach(nodeId => centrality.set(nodeId, 1 / Math.sqrt(activeNodes.length)));

    // Power iteration (simplified, 10 iterations)
    for (let iter = 0; iter < 10; iter++) {
      const newCentrality = new Map<string, number>();

      activeNodes.forEach(nodeId => {
        let sum = 0;
        const neighbors = this.adjacencyList.get(nodeId) || new Set();

        neighbors.forEach(neighborId => {
          if (this.nodes.get(neighborId)?.isActive) {
            sum += centrality.get(neighborId) || 0;
          }
        });

        newCentrality.set(nodeId, sum);
      });

      // Normalize
      let norm = 0;
      newCentrality.forEach(value => norm += value * value);
      norm = Math.sqrt(norm);

      if (norm > 0) {
        newCentrality.forEach((value, nodeId) => {
          centrality.set(nodeId, value / norm);
        });
      }
    }

    return centrality;
  }

  // ============================================================================
  // Anomaly Detection
  // ============================================================================

  private async detectTopologyAnomalies(metrics: TopologyMetrics): Promise<void> {
    // Detect partitions
    if (metrics.connectedComponents > 1) {
      this.reportAnomaly({
        type: AnomalyType.PARTITION_DETECTED,
        severity: 'CRITICAL',
        description: `Network partition detected: ${metrics.connectedComponents} components`,
        affectedNodes: [],
        detectedAt: new Date(),
        metrics: { components: metrics.connectedComponents }
      });
    }

    // Detect clustering attacks (unusually high clustering)
    if (metrics.clusteringCoefficient > 0.7 && this.metricsHistory.length > 10) {
      const avgPrevious = this.metricsHistory
        .slice(-10)
        .reduce((sum, m) => sum + m.clusteringCoefficient, 0) / 10;

      if (metrics.clusteringCoefficient > avgPrevious * 1.5) {
        this.reportAnomaly({
          type: AnomalyType.CLUSTERING_ATTACK,
          severity: 'HIGH',
          description: 'Unusual clustering pattern detected',
          affectedNodes: [],
          detectedAt: new Date(),
          metrics: { clustering: metrics.clusteringCoefficient }
        });
      }
    }

    // Detect critical node failures
    const criticalNodes = Array.from(metrics.centralityMetrics.values())
      .filter(m => m.isCriticalNode);

    criticalNodes.forEach(node => {
      const nodeInfo = this.nodes.get(node.nodeId);
      if (nodeInfo && !nodeInfo.isActive) {
        this.reportAnomaly({
          type: AnomalyType.CRITICAL_NODE_FAILURE,
          severity: 'HIGH',
          description: `Critical bridge node ${node.nodeId} failed`,
          affectedNodes: [node.nodeId],
          detectedAt: new Date(),
          metrics: { betweenness: node.betweennessCentrality }
        });
      }
    });

    // Detect geographic isolation
    const geoIsolation = this.detectGeographicIsolation();
    if (geoIsolation.length > 0) {
      this.reportAnomaly({
        type: AnomalyType.GEOGRAPHIC_ISOLATION,
        severity: 'MEDIUM',
        description: 'Geographic isolation detected',
        affectedNodes: geoIsolation,
        detectedAt: new Date(),
        metrics: { isolated: geoIsolation.length }
      });
    }
  }

  /**
   * Detect geographic isolation patterns
   */
  private detectGeographicIsolation(): string[] {
    const regionCounts = new Map<string, number>();
    const isolatedNodes: string[] = [];

    // Count nodes per region
    this.nodes.forEach(node => {
      if (node.isActive) {
        regionCounts.set(
          node.geographicRegion,
          (regionCounts.get(node.geographicRegion) || 0) + 1
        );
      }
    });

    // Check for regions with very few nodes
    this.nodes.forEach((node, nodeId) => {
      if (node.isActive) {
        const regionCount = regionCounts.get(node.geographicRegion) || 0;
        if (regionCount < 3) {
          isolatedNodes.push(nodeId);
        }
      }
    });

    return isolatedNodes;
  }

  private reportAnomaly(anomaly: TopologyAnomaly): void {
    this.anomalyHistory.push(anomaly);

    // Trim history
    if (this.anomalyHistory.length > this.maxHistorySize) {
      this.anomalyHistory.shift();
    }

    this.emit('anomalyDetected', anomaly);
  }

  // ============================================================================
  // Historical Analysis (Every hour)
  // ============================================================================

  private async performHistoricalAnalysis(): Promise<void> {
    try {
      if (this.metricsHistory.length < 10) return;

      // Analyze trends
      const trends = this.analyzeTrends();
      this.emit('trendsAnalyzed', trends);

      // Detect long-term anomalies
      const longTermAnomalies = this.detectLongTermAnomalies(trends);
      longTermAnomalies.forEach(anomaly => this.reportAnomaly(anomaly));

      this.emit('historicalAnalysisComplete', { trends, anomalies: longTermAnomalies });
    } catch (error) {
      this.emit('scanError', { type: 'historical', error });
    }
  }

  private analyzeTrends(): any {
    const recent = this.metricsHistory.slice(-12); // Last hour of 5-min intervals

    return {
      nodeCountTrend: this.calculateTrend(recent.map(m => m.totalNodes)),
      diameterTrend: this.calculateTrend(recent.map(m => m.networkDiameter)),
      clusteringTrend: this.calculateTrend(recent.map(m => m.clusteringCoefficient)),
      componentsTrend: this.calculateTrend(recent.map(m => m.connectedComponents))
    };
  }

  private calculateTrend(values: number[]): { slope: number; direction: 'increasing' | 'decreasing' | 'stable' } {
    if (values.length < 2) return { slope: 0, direction: 'stable' };

    // Simple linear regression
    const n = values.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    values.forEach((y, x) => {
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    });

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    let direction: 'increasing' | 'decreasing' | 'stable' = 'stable';
    if (Math.abs(slope) > 0.1) {
      direction = slope > 0 ? 'increasing' : 'decreasing';
    }

    return { slope, direction };
  }

  private detectLongTermAnomalies(trends: any): TopologyAnomaly[] {
    const anomalies: TopologyAnomaly[] = [];

    // Decreasing node count trend
    if (trends.nodeCountTrend.direction === 'decreasing' &&
        Math.abs(trends.nodeCountTrend.slope) > 0.5) {
      anomalies.push({
        type: AnomalyType.UNUSUAL_TOPOLOGY_CHANGE,
        severity: 'MEDIUM',
        description: 'Sustained decrease in network size',
        affectedNodes: [],
        detectedAt: new Date(),
        metrics: { trend: trends.nodeCountTrend }
      });
    }

    return anomalies;
  }

  // ============================================================================
  // Partition Detection
  // ============================================================================

  /**
   * Detect network partitions and identify bridge nodes
   */
  public detectPartitions(): PartitionInfo {
    const components = this.findConnectedComponents();
    const bridgeNodes = this.findBridgeNodes();
    const isolatedRegions = this.identifyIsolatedRegions(components);

    return {
      partitions: components,
      bridgeNodes,
      isolatedRegions
    };
  }

  /**
   * Find bridge nodes (articulation points)
   */
  private findBridgeNodes(): string[] {
    const bridges: string[] = [];
    const visited = new Set<string>();
    const disc = new Map<string, number>();
    const low = new Map<string, number>();
    const parent = new Map<string, string | null>();
    let time = 0;

    const dfs = (nodeId: string): void => {
      visited.add(nodeId);
      disc.set(nodeId, time);
      low.set(nodeId, time);
      time++;

      let children = 0;
      const neighbors = this.adjacencyList.get(nodeId) || new Set();

      neighbors.forEach(neighborId => {
        const node = this.nodes.get(neighborId);
        if (!node?.isActive) return;

        if (!visited.has(neighborId)) {
          children++;
          parent.set(neighborId, nodeId);
          dfs(neighborId);

          low.set(nodeId, Math.min(low.get(nodeId)!, low.get(neighborId)!));

          // Check if nodeId is an articulation point
          if (parent.get(nodeId) === null && children > 1) {
            bridges.push(nodeId);
          }

          if (parent.get(nodeId) !== null && low.get(neighborId)! >= disc.get(nodeId)!) {
            bridges.push(nodeId);
          }
        } else if (neighborId !== parent.get(nodeId)) {
          low.set(nodeId, Math.min(low.get(nodeId)!, disc.get(neighborId)!));
        }
      });
    };

    // Run DFS from each unvisited node
    this.nodes.forEach((node, nodeId) => {
      if (node.isActive && !visited.has(nodeId)) {
        parent.set(nodeId, null);
        dfs(nodeId);
      }
    });

    return Array.from(new Set(bridges)); // Remove duplicates
  }

  private identifyIsolatedRegions(components: Set<string>[]): string[] {
    const isolated: string[] = [];

    components.forEach(component => {
      const regions = new Set<string>();
      component.forEach(nodeId => {
        const node = this.nodes.get(nodeId);
        if (node) {
          regions.add(node.geographicRegion);
        }
      });

      // If component only has nodes from one region and is small
      if (regions.size === 1 && component.size < 5) {
        isolated.push(Array.from(regions)[0]);
      }
    });

    return isolated;
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  public getMetrics(): TopologyMetrics | null {
    return this.metricsHistory[this.metricsHistory.length - 1] || null;
  }

  public getMetricsHistory(): TopologyMetrics[] {
    return [...this.metricsHistory];
  }

  public getAnomalies(): TopologyAnomaly[] {
    return [...this.anomalyHistory];
  }

  public getRecentAnomalies(minutes: number = 60): TopologyAnomaly[] {
    const cutoff = Date.now() - minutes * 60000;
    return this.anomalyHistory.filter(a => a.detectedAt.getTime() > cutoff);
  }
}

export default NetworkTopologyMonitor;
