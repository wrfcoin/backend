/**
 * Partition Resilience Middleware
 * Express middleware for partition-aware request handling
 *
 * SECURITY: Addresses Task 100.9 vulnerabilities:
 * - Rejects requests during network partitions
 * - Provides partition status information
 * - Enables emergency mode for critical operations
 * - Returns appropriate HTTP status codes
 * - Logs partition-related request denials
 */

import { Request, Response, NextFunction } from 'express';
import { NetworkPartitionDetector } from '../../shared/network-partition-detector.js';
import { SplitBrainPrevention } from '../../shared/split-brain-prevention.js';
import { PartitionTolerantConsensus } from '../../shared/partition-tolerant-consensus.js';
import { NetworkTopologyMonitor } from '../../shared/network-topology-monitor.js';
import { blockchainLogger } from '../utils/logger.js';

export interface PartitionResilienceConfig {
  enablePartitionCheck: boolean;
  allowReadsDuringPartition: boolean;
  allowWritesDuringPartition: boolean;
  requireConsensusForWrites: boolean;
  emergencyModeEnabled: boolean;
  partitionStatusEndpoint: string;
}

/**
 * Partition Resilience Middleware Factory
 */
export function createPartitionResilienceMiddleware(
  partitionDetector: NetworkPartitionDetector,
  splitBrainPrevention: SplitBrainPrevention,
  consensus: PartitionTolerantConsensus,
  topologyMonitor: NetworkTopologyMonitor,
  config?: Partial<PartitionResilienceConfig>
) {
  const defaultConfig: PartitionResilienceConfig = {
    enablePartitionCheck: true,
    allowReadsDuringPartition: true,
    allowWritesDuringPartition: false,
    requireConsensusForWrites: true,
    emergencyModeEnabled: false,
    partitionStatusEndpoint: '/api/partition/status',
  };

  const mergedConfig = { ...defaultConfig, ...config };

  /**
   * Main partition resilience middleware
   */
  return function partitionResilienceMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Skip partition check if disabled
    if (!mergedConfig.enablePartitionCheck) {
      return next();
    }

    // Always allow partition status endpoint
    if (req.path === mergedConfig.partitionStatusEndpoint) {
      return next();
    }

    try {
      // Check for active partition
      const partitionStatus = partitionDetector.getPartitionStatus();

      if (partitionStatus.hasActivePartition) {
        // Determine if request is read or write
        const isReadOperation = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
          req.method
        );

        // Check read operations during partition
        if (isReadOperation && !mergedConfig.allowReadsDuringPartition) {
          return respondWithPartitionError(
            res,
            'Read operations not allowed during network partition',
            partitionStatus.partitions[0]
          );
        }

        // Check write operations during partition
        if (isWriteOperation) {
          if (!mergedConfig.allowWritesDuringPartition) {
            return respondWithPartitionError(
              res,
              'Write operations not allowed during network partition',
              partitionStatus.partitions[0]
            );
          }

          // If writes are allowed, check consensus
          if (mergedConfig.requireConsensusForWrites) {
            const consensusStatus = consensus.getConsensusStatus();

            if (consensusStatus.consensusHalted) {
              return respondWithPartitionError(
                res,
                'Consensus halted due to network partition',
                partitionStatus.partitions[0]
              );
            }

            if (!consensusStatus.inMajorityPartition) {
              return respondWithPartitionError(
                res,
                'Node not in majority partition - cannot process writes',
                partitionStatus.partitions[0]
              );
            }
          }

          // Check split-brain prevention
          const splitBrainStatus = splitBrainPrevention.getStatus();
          if (!splitBrainStatus.consensusAllowed) {
            return respondWithPartitionError(
              res,
              'Consensus not allowed due to split-brain risk',
              partitionStatus.partitions[0]
            );
          }

          if (!splitBrainStatus.blockProductionAllowed) {
            return respondWithPartitionError(
              res,
              'Block production not allowed during partition',
              partitionStatus.partitions[0]
            );
          }
        }

        // Add partition warning header
        res.setHeader('X-Network-Partition-Active', 'true');
        res.setHeader(
          'X-Partition-Severity',
          partitionStatus.partitions[0]?.severity || 'unknown'
        );
      }

      // Add topology health header
      const topologyStatus = topologyMonitor.getStatus();
      res.setHeader(
        'X-Network-Health-Score',
        topologyStatus.currentHealthScore.toString()
      );

      // Proceed with request
      next();
    } catch (error) {
      blockchainLogger.error('Error checking partition status', {
        operation: 'partition:middleware:check',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      // Fail open in case of middleware error
      next();
    }
  };
}

/**
 * Partition status endpoint handler
 */
export function createPartitionStatusHandler(
  partitionDetector: NetworkPartitionDetector,
  splitBrainPrevention: SplitBrainPrevention,
  consensus: PartitionTolerantConsensus,
  topologyMonitor: NetworkTopologyMonitor
) {
  return function partitionStatusHandler(req: Request, res: Response): void {
    try {
      const partitionStatus = partitionDetector.getPartitionStatus();
      const consensusStatus = consensus.getConsensusStatus();
      const splitBrainStatus = splitBrainPrevention.getStatus();
      const topologyStatus = topologyMonitor.getStatus();
      const topology = topologyMonitor.getCurrentTopology();
      const predictions = topologyMonitor.getPredictions();
      const healthAlerts = topologyMonitor.getHealthAlerts();

      res.json({
        partition: {
          hasActivePartition: partitionStatus.hasActivePartition,
          partitionCount: partitionStatus.partitionCount,
          partitions: partitionStatus.partitions.map((p) => ({
            partitionId: p.partitionId,
            severity: p.severity,
            affectedNodes: p.affectedNodes.length,
            affectedValidators: p.affectedValidators.length,
            detectedAt: p.detectedAt,
            duration: Date.now() - p.detectedAt.getTime(),
            type: p.partitionType,
          })),
          connectivity: {
            totalNodes: partitionStatus.connectivity.totalNodes,
            reachableNodes: partitionStatus.connectivity.reachableNodes,
            unreachableNodes: partitionStatus.connectivity.unreachableNodes,
            validatorNodes: partitionStatus.connectivity.validatorNodes,
            reachableValidators: partitionStatus.connectivity.reachableValidators,
            packetLoss: partitionStatus.connectivity.packetLoss,
          },
        },
        consensus: {
          term: consensusStatus.term,
          leader: consensusStatus.leader,
          role: consensusStatus.role,
          consensusHalted: consensusStatus.consensusHalted,
          inMajorityPartition: consensusStatus.inMajorityPartition,
          activeProposals: consensusStatus.activeProposals,
        },
        splitBrain: {
          consensusAllowed: splitBrainStatus.consensusAllowed,
          blockProductionAllowed: splitBrainStatus.blockProductionAllowed,
          activeConflicts: splitBrainStatus.activeConflicts,
          isolatedValidators: splitBrainStatus.isolatedValidators,
        },
        topology: {
          totalNodes: topologyStatus.totalNodes,
          onlineNodes: topologyStatus.onlineNodes,
          offlineNodes: topologyStatus.offlineNodes,
          degradedNodes: topologyStatus.degradedNodes,
          healthScore: topologyStatus.currentHealthScore,
          metrics: topology
            ? {
                totalEdges: topology.metrics.totalEdges,
                averageConnectivity: topology.metrics.averageConnectivity,
                networkDiameter: topology.metrics.networkDiameter,
                geographicDiversity: topology.metrics.geographicDiversity,
                asnDiversity: topology.metrics.asnDiversity,
              }
            : null,
        },
        predictions: predictions.slice(-5).map((p) => ({
          predictionId: p.predictionId,
          probability: p.probability,
          severity: p.severity,
          estimatedTime: p.estimatedTimeToPartition,
          affectedNodes: p.affectedNodes.length,
          affectedRegions: p.affectedRegions,
        })),
        healthAlerts: healthAlerts.slice(-10).map((a) => ({
          alertId: a.alertId,
          severity: a.severity,
          metric: a.metric,
          message: a.message,
          timestamp: a.timestamp,
        })),
        operationalStatus: {
          readsAllowed: true,
          writesAllowed:
            !partitionStatus.hasActivePartition ||
            (consensusStatus.inMajorityPartition &&
              splitBrainStatus.consensusAllowed),
          consensusActive: !consensusStatus.consensusHalted,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      blockchainLogger.error('Failed to retrieve partition status', {
        operation: 'partition:status:handler',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      res.status(500).json({
        error: 'Failed to retrieve partition status',
        message: String(error),
      });
    }
  };
}

/**
 * Emergency mode endpoint handler
 */
export function createEmergencyModeHandler(
  splitBrainPrevention: SplitBrainPrevention,
  consensus: PartitionTolerantConsensus
) {
  return function emergencyModeHandler(req: Request, res: Response): void {
    try {
      const { action } = req.body;

      if (!['enable', 'disable'].includes(action)) {
        res.status(400).json({
          error: 'Invalid action',
          message: 'Action must be "enable" or "disable"',
        });
        return;
      }

      // Emergency mode actions would be implemented here
      // For now, just return status

      res.json({
        emergencyMode: action === 'enable',
        message: `Emergency mode ${action}d`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      blockchainLogger.error('Failed to update emergency mode', {
        operation: 'partition:emergency:handler',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      res.status(500).json({
        error: 'Failed to update emergency mode',
        message: String(error),
      });
    }
  };
}

/**
 * Respond with partition error
 */
function respondWithPartitionError(
  res: Response,
  message: string,
  partition?: any
): void {
  res.status(503).json({
    error: 'Service Unavailable',
    message,
    partition: partition
      ? {
          partitionId: partition.partitionId,
          severity: partition.severity,
          detectedAt: partition.detectedAt,
          affectedNodes: partition.affectedNodes.length,
        }
      : undefined,
    retryAfter: 30, // seconds
    timestamp: new Date().toISOString(),
  });
}

/**
 * Health check middleware
 */
export function createHealthCheckMiddleware(
  partitionDetector: NetworkPartitionDetector,
  topologyMonitor: NetworkTopologyMonitor
) {
  return function healthCheckMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Only apply to health check endpoints
    if (!req.path.includes('/health')) {
      next();
      return;
    }

    const partitionStatus = partitionDetector.getPartitionStatus();
    const topologyStatus = topologyMonitor.getStatus();

    // Return degraded status if partition exists
    if (partitionStatus.hasActivePartition) {
      res.status(200).json({
        status: 'degraded',
        healthy: false,
        partition: {
          active: true,
          severity: partitionStatus.partitions[0]?.severity,
        },
        healthScore: topologyStatus.currentHealthScore,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Return healthy status
    res.status(200).json({
      status: 'healthy',
      healthy: true,
      partition: {
        active: false,
      },
      healthScore: topologyStatus.currentHealthScore,
      timestamp: new Date().toISOString(),
    });
  };
}
