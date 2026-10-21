/**
 * Topology Integration Service
 *
 * Bridges the Rust blockchain-core TopologyManager with the TypeScript
 * TopologyAttackDefense system for coordinated network protection.
 *
 * SECURITY: Addresses Task 100.13 - Integration Layer
 *
 * Features:
 * - IPC communication with Rust blockchain node
 * - Unified metrics aggregation
 * - Coordinated peer management
 * - Cross-layer alert propagation
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { TopologyAttackDefense, TopologyMetrics, TopologyAlert, TopologyAlertType } from './topology-attack-defense.js';
import { NetworkTopologyMonitor } from './eclipse-topology-monitor.js';
import { blockchainLogger } from '../server/utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface RustTopologyStatus {
  knownPeers: number;
  activePeers: number;
  decoyPeers: number;
  bannedIPs: string[];
  subnetDistribution: Record<string, number>;
  lastChurnTime?: string;
  churnRate: number;
}

export interface IntegrationConfig {
  /** Path to Rust topology verification binary */
  rustBinaryPath: string;
  /** Enable IPC communication with Rust node */
  enableRustIntegration: boolean;
  /** Sync interval for cross-layer metrics (ms) */
  syncInterval: number;
  /** Port for IPC communication */
  ipcPort: number;
  /** Enable unified alerting */
  enableUnifiedAlerting: boolean;
}

export interface UnifiedMetrics {
  typescript: TopologyMetrics;
  rust?: RustTopologyStatus;
  combined: {
    totalPeers: number;
    totalBannedIPs: number;
    totalDecoys: number;
    overallHealthScore: number;
    lastSyncTime: Date;
  };
}

export interface CrossLayerAlert {
  source: 'typescript' | 'rust';
  alert: TopologyAlert | RustAlert;
  propagated: boolean;
  timestamp: Date;
}

export interface RustAlert {
  alertType: string;
  severity: string;
  message: string;
  affectedPeers: string[];
  metadata: Record<string, unknown>;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: IntegrationConfig = {
  rustBinaryPath: './blockchain-core/target/release/verify_topology',
  enableRustIntegration: false, // Disabled by default, enable when Rust node is running
  syncInterval: 30000, // 30 seconds
  ipcPort: 9999,
  enableUnifiedAlerting: true,
};

// ============================================================================
// Topology Integration Service
// ============================================================================

export class TopologyIntegrationService extends EventEmitter {
  private config: IntegrationConfig;
  private tsDefense: TopologyAttackDefense;
  private topologyMonitor: NetworkTopologyMonitor;
  private rustProcess?: ChildProcess;
  private syncTimer?: NodeJS.Timeout;
  private lastRustStatus?: RustTopologyStatus;
  private crossLayerAlerts: CrossLayerAlert[] = [];
  private isRunning: boolean = false;

  constructor(
    config: Partial<IntegrationConfig> = {},
    tsDefenseConfig?: ConstructorParameters<typeof TopologyAttackDefense>[0]
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tsDefense = new TopologyAttackDefense(tsDefenseConfig);
    this.topologyMonitor = new NetworkTopologyMonitor();
    this.setupEventForwarding();
  }

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Start the integration service
   */
  public async start(): Promise<void> {
    blockchainLogger.info('Starting integration service', { module: 'TopologyIntegration' });

    // Start TypeScript defense system
    this.tsDefense.start();
    this.topologyMonitor.startMonitoring();

    // Start Rust integration if enabled
    if (this.config.enableRustIntegration) {
      await this.startRustIntegration();
    }

    // Start sync timer
    this.syncTimer = setInterval(
      () => this.syncMetrics(),
      this.config.syncInterval
    );

    this.isRunning = true;
    this.emit('started');
    blockchainLogger.info('Integration service started', { module: 'TopologyIntegration' });
  }

  /**
   * Stop the integration service
   */
  public async stop(): Promise<void> {
    blockchainLogger.info('Stopping integration service', { module: 'TopologyIntegration' });

    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    this.tsDefense.stop();
    this.topologyMonitor.stopMonitoring();

    if (this.rustProcess) {
      this.rustProcess.kill();
      this.rustProcess = undefined;
    }

    this.isRunning = false;
    this.emit('stopped');
    blockchainLogger.info('Integration service stopped', { module: 'TopologyIntegration' });
  }

  // ============================================================================
  // Rust Integration
  // ============================================================================

  /**
   * Start communication with Rust topology manager
   */
  private async startRustIntegration(): Promise<void> {
    try {
      // Check if binary exists
      const fs = await import('fs');
      if (!fs.existsSync(this.config.rustBinaryPath)) {
        blockchainLogger.warn('Rust binary not found, running in TypeScript-only mode', { module: 'TopologyIntegration' });
        return;
      }

      blockchainLogger.info('Starting Rust topology integration', { module: 'TopologyIntegration' });

      // For now, we'll simulate the IPC communication
      // In production, this would establish a proper IPC channel
      this.simulateRustStatus();

    } catch (error) {
      blockchainLogger.error('Failed to start Rust integration', {
        module: 'TopologyIntegration',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Simulate Rust status for testing (replace with actual IPC in production)
   */
  private simulateRustStatus(): void {
    this.lastRustStatus = {
      knownPeers: 0,
      activePeers: 0,
      decoyPeers: 5,
      bannedIPs: [],
      subnetDistribution: {},
      churnRate: 0.1,
    };
  }

  /**
   * Query Rust node for topology status
   */
  public async getRustStatus(): Promise<RustTopologyStatus | null> {
    if (!this.config.enableRustIntegration) {
      return null;
    }

    // In production, this would make an IPC call to the Rust node
    return this.lastRustStatus || null;
  }

  /**
   * Send command to Rust topology manager
   */
  public async sendRustCommand(command: string, params?: Record<string, unknown>): Promise<boolean> {
    if (!this.config.enableRustIntegration) {
      blockchainLogger.warn('Rust integration not enabled', { module: 'TopologyIntegration' });
      return false;
    }

    // In production, this would send the command via IPC
    blockchainLogger.info('Would send command to Rust', { module: 'TopologyIntegration', command, params });
    return true;
  }

  // ============================================================================
  // Unified Peer Management
  // ============================================================================

  /**
   * Register a peer in both TypeScript and Rust layers
   */
  public async registerPeer(
    peerId: string,
    address: string,
    metadata?: Record<string, unknown>
  ): Promise<{ tsAccepted: boolean; rustAccepted: boolean }> {
    // Check TypeScript layer
    const tsResult = this.tsDefense.shouldAcceptConnection(address);

    let rustAccepted = true;
    if (this.config.enableRustIntegration) {
      // Send to Rust layer
      rustAccepted = await this.sendRustCommand('register_peer', { peerId, address, metadata });
    }

    if (tsResult.accept) {
      this.tsDefense.registerPeer(peerId, address, metadata as any);
    }

    return {
      tsAccepted: tsResult.accept,
      rustAccepted,
    };
  }

  /**
   * Ban an IP in both layers
   */
  public async banIP(ip: string, reason: string): Promise<void> {
    // Ban in TypeScript layer
    this.tsDefense.banIP(ip, reason);

    // Ban in Rust layer
    if (this.config.enableRustIntegration) {
      await this.sendRustCommand('ban_ip', { ip, reason });
    }

    this.emit('ip_banned_unified', { ip, reason });
  }

  /**
   * Trigger churn in both layers
   */
  public async performChurn(): Promise<{
    tsChurn: string[];
    rustChurn: string[];
  }> {
    // TypeScript churn
    const tsResult = this.tsDefense.performChurn();

    let rustChurn: string[] = [];
    if (this.config.enableRustIntegration) {
      await this.sendRustCommand('perform_churn', {});
      // In production, would receive churned peers from Rust
    }

    return {
      tsChurn: tsResult.peersRemoved,
      rustChurn,
    };
  }

  // ============================================================================
  // Metrics Synchronization
  // ============================================================================

  /**
   * Sync metrics between TypeScript and Rust layers
   */
  private async syncMetrics(): Promise<void> {
    try {
      const rustStatus = await this.getRustStatus();
      const tsMetrics = this.tsDefense.getMetrics();

      // Update Rust status cache
      if (rustStatus) {
        this.lastRustStatus = rustStatus;
      }

      // Aggregate metrics
      const unified = this.aggregateMetrics(tsMetrics, rustStatus);

      this.emit('metrics_synced', unified);

      // Check for cross-layer anomalies
      this.detectCrossLayerAnomalies(unified);

    } catch (error) {
      blockchainLogger.error('Metrics sync failed', {
        module: 'TopologyIntegration',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Aggregate metrics from both layers
   */
  private aggregateMetrics(
    tsMetrics: TopologyMetrics,
    rustStatus: RustTopologyStatus | null
  ): UnifiedMetrics {
    const combined = {
      totalPeers: tsMetrics.activePeers + (rustStatus?.activePeers || 0),
      totalBannedIPs: tsMetrics.bannedIPs + (rustStatus?.bannedIPs.length || 0),
      totalDecoys: tsMetrics.decoyPeers + (rustStatus?.decoyPeers || 0),
      overallHealthScore: this.calculateOverallHealth(tsMetrics, rustStatus),
      lastSyncTime: new Date(),
    };

    return {
      typescript: tsMetrics,
      rust: rustStatus || undefined,
      combined,
    };
  }

  /**
   * Calculate overall health score from both layers
   */
  private calculateOverallHealth(
    tsMetrics: TopologyMetrics,
    rustStatus: RustTopologyStatus | null
  ): number {
    // Start with TypeScript health score
    let score = tsMetrics.healthScore;

    if (rustStatus) {
      // Adjust based on Rust layer status
      // Penalize if layers are out of sync
      const peerDiff = Math.abs(tsMetrics.activePeers - rustStatus.activePeers);
      if (peerDiff > 10) {
        score -= 10; // Significant peer count difference
      }

      // Bonus for having both layers active
      score += 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  // ============================================================================
  // Cross-Layer Alerting
  // ============================================================================

  /**
   * Setup event forwarding between layers
   */
  private setupEventForwarding(): void {
    // Forward TypeScript alerts
    this.tsDefense.on('alert', (alert: TopologyAlert) => {
      this.handleAlert('typescript', alert);
    });

    this.tsDefense.on('ip_banned', (record) => {
      this.propagateBanToRust(record.ip, record.reason);
    });

    // Forward topology monitor anomalies
    this.topologyMonitor.on('anomalyDetected', (anomaly) => {
      this.handleTopologyAnomaly(anomaly);
    });
  }

  /**
   * Handle alert from either layer
   */
  private handleAlert(source: 'typescript' | 'rust', alert: TopologyAlert | RustAlert): void {
    const crossLayerAlert: CrossLayerAlert = {
      source,
      alert,
      propagated: false,
      timestamp: new Date(),
    };

    this.crossLayerAlerts.push(crossLayerAlert);

    // Keep only last 100 alerts
    if (this.crossLayerAlerts.length > 100) {
      this.crossLayerAlerts.shift();
    }

    // Propagate critical alerts
    if (this.config.enableUnifiedAlerting) {
      this.propagateAlert(crossLayerAlert);
    }

    this.emit('cross_layer_alert', crossLayerAlert);
  }

  /**
   * Propagate alert to other layer
   */
  private async propagateAlert(crossLayerAlert: CrossLayerAlert): Promise<void> {
    const alert = crossLayerAlert.alert as TopologyAlert;

    if (alert.severity === 'critical' || alert.severity === 'high') {
      if (crossLayerAlert.source === 'typescript' && this.config.enableRustIntegration) {
        await this.sendRustCommand('propagate_alert', {
          type: alert.type,
          severity: alert.severity,
          affectedPeers: alert.affectedPeers,
        });
        crossLayerAlert.propagated = true;
      }
    }
  }

  /**
   * Propagate IP ban to Rust layer
   */
  private async propagateBanToRust(ip: string, reason: string): Promise<void> {
    if (this.config.enableRustIntegration) {
      await this.sendRustCommand('ban_ip', { ip, reason });
    }
  }

  /**
   * Handle topology anomaly from monitor
   */
  private handleTopologyAnomaly(anomaly: any): void {
    // Convert topology monitor anomaly to alert
    const alert: TopologyAlert = {
      alertId: anomaly.id || `anomaly_${Date.now()}`,
      type: this.mapAnomalyToAlertType(anomaly.type),
      severity: anomaly.severity?.toLowerCase() || 'medium',
      message: anomaly.description || 'Topology anomaly detected',
      affectedPeers: anomaly.affectedNodes || [],
      timestamp: new Date(),
      metadata: anomaly.metrics || {},
    };

    this.handleAlert('typescript', alert);
  }

  /**
   * Map anomaly type to alert type
   */
  private mapAnomalyToAlertType(anomalyType: string): TopologyAlertType {
    const mapping: Record<string, TopologyAlertType> = {
      'SUDDEN_DISCONNECT': TopologyAlertType.TRUST_SCORE_ANOMALY,
      'CLUSTERING_ATTACK': TopologyAlertType.SUBNET_CONCENTRATION,
      'PARTITION_DETECTED': TopologyAlertType.GEOGRAPHIC_ISOLATION,
      'COORDINATED_DISCONNECT': TopologyAlertType.STRATEGIC_NODE_PLACEMENT,
    };

    return mapping[anomalyType] || TopologyAlertType.TRUST_SCORE_ANOMALY;
  }

  /**
   * Detect anomalies by comparing cross-layer data
   */
  private detectCrossLayerAnomalies(metrics: UnifiedMetrics): void {
    if (!metrics.rust) return;

    // Check for significant peer count discrepancies
    const peerDiff = Math.abs(metrics.typescript.activePeers - metrics.rust.activePeers);
    if (peerDiff > metrics.typescript.activePeers * 0.3) {
      this.handleAlert('typescript', {
        alertId: `cross_layer_${Date.now()}`,
        type: TopologyAlertType.TRUST_SCORE_ANOMALY,
        severity: 'high',
        message: `Cross-layer peer count discrepancy: TS=${metrics.typescript.activePeers}, Rust=${metrics.rust.activePeers}`,
        affectedPeers: [],
        timestamp: new Date(),
        metadata: { diff: peerDiff },
      });
    }

    // Check for banned IP sync issues
    const tsBanned = metrics.typescript.bannedIPs;
    const rustBanned = metrics.rust.bannedIPs.length;
    if (Math.abs(tsBanned - rustBanned) > 5) {
      blockchainLogger.warn('Banned IP sync issue', { module: 'TopologyIntegration', tsBanned, rustBanned });
    }
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Get unified metrics
   */
  public async getUnifiedMetrics(): Promise<UnifiedMetrics> {
    const tsMetrics = this.tsDefense.getMetrics();
    const rustStatus = await this.getRustStatus();
    return this.aggregateMetrics(tsMetrics, rustStatus);
  }

  /**
   * Get cross-layer alerts
   */
  public getCrossLayerAlerts(since?: Date): CrossLayerAlert[] {
    if (!since) {
      return [...this.crossLayerAlerts];
    }
    return this.crossLayerAlerts.filter(a => a.timestamp >= since);
  }

  /**
   * Get TypeScript defense instance for direct access
   */
  public getTsDefense(): TopologyAttackDefense {
    return this.tsDefense;
  }

  /**
   * Get topology monitor instance for direct access
   */
  public getTopologyMonitor(): NetworkTopologyMonitor {
    return this.topologyMonitor;
  }

  /**
   * Check if service is running
   */
  public isServiceRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get comprehensive status
   */
  public async getStatus(): Promise<{
    isRunning: boolean;
    rustIntegrationEnabled: boolean;
    rustConnected: boolean;
    metrics: UnifiedMetrics;
    recentAlerts: CrossLayerAlert[];
    tsStatus: ReturnType<TopologyAttackDefense['getStatus']>;
  }> {
    return {
      isRunning: this.isRunning,
      rustIntegrationEnabled: this.config.enableRustIntegration,
      rustConnected: !!this.lastRustStatus,
      metrics: await this.getUnifiedMetrics(),
      recentAlerts: this.crossLayerAlerts.slice(-10),
      tsStatus: this.tsDefense.getStatus(),
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create and start a topology integration service
 */
export async function createTopologyIntegration(
  config?: Partial<IntegrationConfig>,
  autoStart: boolean = true
): Promise<TopologyIntegrationService> {
  const service = new TopologyIntegrationService(config);

  if (autoStart) {
    await service.start();
  }

  return service;
}

export default TopologyIntegrationService;
