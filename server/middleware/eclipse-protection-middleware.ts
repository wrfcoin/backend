/**
 * Eclipse Attack Protection Middleware
 *
 * Express middleware for real-time Eclipse attack prevention including
 * connection validation, diversity enforcement, and threat detection.
 */

import { Request, Response, NextFunction } from 'express';
import { DiversePeerSelectionManager, PeerInfo } from '../../shared/eclipse-peer-selection.js';
import { NetworkTopologyMonitor } from '../../shared/eclipse-topology-monitor.js';
import { ConnectionDiversityManager } from '../../shared/eclipse-connection-diversity.js';
import { HeartbeatManager } from '../../shared/eclipse-heartbeat-manager.js';
import { securityLogger } from '../utils/logger.js';

// ============================================================================
// Middleware State
// ============================================================================

const peerSelector = new DiversePeerSelectionManager();
const topologyMonitor = new NetworkTopologyMonitor();
const diversityManager = new ConnectionDiversityManager();
const heartbeatManager = new HeartbeatManager();

let alertsGenerated = 0;
let connectionsRejected = 0;

// ============================================================================
// Connection Validation Middleware
// ============================================================================

export interface PeerConnectionRequest {
  nodeId: string;
  ipAddress: string;
  port: number;
  publicKey: string;
  signature: string;
}

export function validatePeerConnection(req: Request, res: Response, next: NextFunction) {
  const connectionReq: PeerConnectionRequest = req.body;

  // Basic validation
  if (!connectionReq.nodeId || !connectionReq.ipAddress || !connectionReq.publicKey) {
    return res.status(400).json({
      error: 'Invalid connection request',
      message: 'Missing required fields'
    });
  }

  // Verify signature (in production, verify cryptographically)
  if (!connectionReq.signature) {
    return res.status(401).json({
      error: 'Authentication failed',
      message: 'Missing signature'
    });
  }

  // Attach validated connection data to request
  (req as any).peerConnection = connectionReq;
  next();
}

// ============================================================================
// Diversity Enforcement Middleware
// ============================================================================

export async function enforceDiversity(req: Request, res: Response, next: NextFunction) {
  const connectionReq: PeerConnectionRequest | undefined = (req as any).peerConnection;

  if (!connectionReq) {
    return res.status(500).json({
      error: 'Internal error',
      message: 'Connection request not validated'
    });
  }

  // Create peer info from request
  const peerInfo: PeerInfo = {
    nodeId: connectionReq.nodeId,
    ipAddress: connectionReq.ipAddress,
    port: connectionReq.port,
    publicKey: connectionReq.publicKey,
    geographicRegion: null as any, // Will be enriched
    continent: '',
    country: '',
    autonomousSystem: '',
    ipSubnet: '',
    reputationScore: 50, // Default for new peers
    reputationTier: null as any,
    stakeAmount: BigInt(0),
    lastSeen: new Date(),
    connectionLatency: 0,
    uptimePercentage: 100,
    successfulTransactions: 0,
    failedTransactions: 0,
    consensusParticipation: 0,
    isBootstrapNode: false
  };

  // Check diversity requirements
  const acceptance = await diversityManager.addConnection(peerInfo);

  if (!acceptance.accepted) {
    connectionsRejected++;

    return res.status(403).json({
      error: 'Connection rejected',
      message: 'Would violate diversity requirements',
      reason: acceptance.reason,
      diversityScore: diversityManager.getCurrentScore()
    });
  }

  next();
}

// ============================================================================
// Topology Monitoring Middleware
// ============================================================================

export function monitorTopology(req: Request, res: Response, next: NextFunction) {
  const connectionReq: PeerConnectionRequest | undefined = (req as any).peerConnection;

  if (!connectionReq) {
    return next();
  }

  // Add node to topology graph
  topologyMonitor.addNode({
    nodeId: connectionReq.nodeId,
    connections: new Set(),
    lastSeen: new Date(),
    isActive: true,
    geographicRegion: '', // Would be enriched
    reputation: 50
  });

  // Check for immediate anomalies
  const recentAnomalies = topologyMonitor.getRecentAnomalies(5);

  if (recentAnomalies.length > 10) {
    alertsGenerated++;

    // Log alert but don't block connection
    securityLogger.warn('High anomaly rate detected in topology', {
      operation: 'eclipse:topology:anomaly',
      anomalyCount: recentAnomalies.length,
      nodeId: connectionReq.nodeId,
    });
  }

  next();
}

// ============================================================================
// Heartbeat Validation Middleware
// ============================================================================

export interface HeartbeatRequest {
  peerId: string;
  sequence: number;
  timestamp: number;
  blockHash: string;
  blockHeight: number;
  nonce: string;
  signature: string;
}

export function validateHeartbeat(req: Request, res: Response, next: NextFunction) {
  const heartbeat: HeartbeatRequest = req.body;

  if (!heartbeat.peerId || !heartbeat.signature) {
    return res.status(400).json({
      error: 'Invalid heartbeat',
      message: 'Missing required fields'
    });
  }

  // Check timestamp freshness (within 5 minutes)
  const now = Date.now();
  const timeDiff = Math.abs(now - heartbeat.timestamp);

  if (timeDiff > 300000) { // 5 minutes
    return res.status(400).json({
      error: 'Invalid heartbeat',
      message: 'Timestamp too old or in future'
    });
  }

  // Verify sequence number monotonically increases
  // (would check against stored sequence in production)

  // Process heartbeat
  heartbeatManager.receiveHeartbeat({
    peerId: heartbeat.peerId,
    sequence: heartbeat.sequence,
    timestamp: new Date(heartbeat.timestamp),
    blockHash: Buffer.from(heartbeat.blockHash, 'hex'),
    blockHeight: heartbeat.blockHeight,
    nonce: Buffer.from(heartbeat.nonce, 'hex'),
    signature: Buffer.from(heartbeat.signature, 'hex'),
    channel: 'P2P_DIRECT' as any
  });

  next();
}

// ============================================================================
// Alert Generation Middleware
// ============================================================================

export function generateAlerts(req: Request, res: Response, next: NextFunction) {
  const connectionReq: PeerConnectionRequest | undefined = (req as any).peerConnection;

  if (!connectionReq) {
    return next();
  }

  // Check current diversity score
  const diversityScore = diversityManager.getCurrentScore();

  if (!diversityScore.meetsMinimumRequirements) {
    alertsGenerated++;

    // Emit alert event
    securityLogger.error('Diversity requirements not met - potential eclipse attack', {
      operation: 'eclipse:alert:diversity',
      severity: 'high',
      score: diversityScore.overallScore,
      violations: diversityScore.violations,
    });

    // In production, would send to monitoring system
  }

  // Check for isolation indicators
  const topologyMetrics = topologyMonitor.getMetrics();

  if (topologyMetrics && topologyMetrics.connectedComponents > 1) {
    alertsGenerated++;

    securityLogger.error('Network partition detected - potential eclipse attack', {
      operation: 'eclipse:alert:partition',
      severity: 'critical',
      connectedComponents: topologyMetrics.connectedComponents,
      largestComponentSize: topologyMetrics.largestComponentSize,
    });
  }

  next();
}

// ============================================================================
// Statistics and Monitoring
// ============================================================================

export function getProtectionStats(req: Request, res: Response) {
  const diversityScore = diversityManager.getCurrentScore();
  const topologyMetrics = topologyMonitor.getMetrics();
  const activeConnections = diversityManager.getActiveConnections();

  res.json({
    status: 'active',
    timestamp: new Date().toISOString(),
    protection: {
      diversityScore: diversityScore.overallScore,
      meetsRequirements: diversityScore.meetsMinimumRequirements,
      activeConnections: activeConnections.length,
      connectionsRejected,
      alertsGenerated
    },
    topology: topologyMetrics ? {
      totalNodes: topologyMetrics.totalNodes,
      totalEdges: topologyMetrics.totalEdges,
      connectedComponents: topologyMetrics.connectedComponents,
      networkDiameter: topologyMetrics.networkDiameter,
      averageDegree: topologyMetrics.averageDegree
    } : null,
    diversity: {
      geographic: diversityScore.geographicDiversity,
      asn: diversityScore.asnDiversity,
      ip: diversityScore.ipDiversity,
      reputation: diversityScore.reputationDiversity,
      stake: diversityScore.stakeDiversity
    },
    violations: diversityScore.violations
  });
}

// ============================================================================
// Cleanup
// ============================================================================

export function cleanup() {
  topologyMonitor.stopMonitoring();
  diversityManager.stopRebalancing();
}

// Type augmentation for Express Request
declare global {
  namespace Express {
    interface Request {
      peerConnection?: PeerConnectionRequest;
    }
  }
}
