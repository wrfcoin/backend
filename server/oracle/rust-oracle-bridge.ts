/**
 * Rust Oracle Bridge Interface for WRFCoin - Phase 3: Enhanced Queue Integration
 *
 * This module provides the integration between the TypeScript ClimateOracleNetwork
 * and the Rust cross-chain oracle system. It enables seamless communication
 * between the backend services and the blockchain core oracle infrastructure.
 *
 * Features:
 * - Real-time oracle request forwarding to Rust blockchain core
 * - Cross-chain bridge coordination with liquid democracy integration
 * - High-performance request batching and validation
 * - Oracle performance metrics collection for delegation weighting
 * - Byzantine fault tolerance coordination between TypeScript and Rust layers
 * - Enhanced message queue processing with backpressure handling
 * - Dead letter queue management and retry mechanisms
 * - Load balancer coordination for distributed oracle processing
 * - Real-time queue metrics and performance monitoring
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs/promises';
import WebSocket from 'ws';
import * as WebSocketNS from 'ws';
import axios from 'axios';
import { blockchainLogger, logError, crosschainLogger } from '../utils/logger.js';

// Type definitions for Rust Oracle Bridge
interface RustOracleRequest {
  id: string;
  computation_type:
    | 'Weather'
    | 'Finance'
    | 'Scientific'
    | 'MachineLearning'
    | 'DataAnalysis';
  source_chain: string;
  target_chain: string;
  input_data: any;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  timeout_seconds: number;
  validator_requirements: ValidatorRequirements;
  cross_chain_context: CrossChainContext;
}

interface ValidatorRequirements {
  min_reputation_score: number;
  min_stake_amount: number;
  required_data_accuracy: number;
  delegation_chain_validation: boolean;
  oracle_performance_threshold: number;
}

interface CrossChainContext {
  bridge_protocol: string;
  source_block_height: number;
  confirmation_requirements: number;
  gas_limit?: number;
  priority_fee?: number;
  execution_deadline: number;
}

interface RustOracleResponse {
  request_id: string;
  result: any;
  validator_consensus: ValidatorConsensus;
  execution_metrics: ExecutionMetrics;
  cross_chain_proof: CrossChainProof;
  liquid_democracy_attestation: LiquidDemocracyAttestation;
}

interface ValidatorConsensus {
  participating_validators: string[];
  consensus_threshold: number;
  achieved_consensus: number;
  delegation_weighted_consensus: number;
  byzantine_fault_tolerance: boolean;
}

interface ExecutionMetrics {
  computation_time_ms: number;
  gas_consumed: number;
  memory_usage_mb: number;
  cross_chain_latency_ms: number;
  validator_performance_scores: Record<string, number>;
}

interface CrossChainProof {
  proof_type: 'Merkle' | 'STARK' | 'SNARK' | 'BLS';
  proof_data: string;
  verification_requirements: string[];
  bridge_attestation: string;
}

interface LiquidDemocracyAttestation {
  delegation_chains_verified: string[][];
  total_delegated_power: number;
  validator_credentials_verified: boolean;
  oracle_performance_weights: Record<string, number>;
}

// Enhanced queue integration interfaces
interface QueueMetrics {
  messages_per_second: number;
  average_processing_time_ms: number;
  queue_depths: Record<string, number>;
  dead_letter_count: number;
  backpressure_active: boolean;
  priority_distribution: Record<string, number>;
  success_rate: number;
  error_rate: number;
  latency_p95_ms: number;
  latency_p99_ms: number;
  throughput_capacity: number;
  load_balancer_status: LoadBalancerStatus;
}

interface LoadBalancerStatus {
  active_workers: number;
  worker_utilization: Record<string, number>;
  pending_assignments: number;
  failover_active: boolean;
  replication_factor: number;
}

interface CoordinationEvent {
  type:
    | 'RequestQueued'
    | 'ProcessingStarted'
    | 'RequestCompleted'
    | 'RequestFailed'
    | 'BackpressureEvent'
    | 'DeadLetterEvent'
    | 'PerformanceAlert';
  payload: {
    request_id?: string;
    priority?: string;
    queue_position?: number;
    estimated_processing_time_ms?: number;
    worker_id?: string;
    started_at?: number;
    result_size?: number;
    processing_time_ms?: number;
    completed_at?: number;
    error_code?: string;
    error_message?: string;
    retry_count?: number;
    failed_at?: number;
    queue_depth?: number;
    capacity?: number;
    recommended_delay_ms?: number;
    final_error?: string;
    attempts?: number;
    moved_to_dlq_at?: number;
    metric_name?: string;
    current_value?: number;
    threshold?: number;
    severity?: string;
    timestamp?: number;
  };
}

interface QueueHealthStatus {
  healthy: boolean;
  throughput_utilization_percent: number;
  load_balancer_active: boolean;
  oracle_healthy: boolean;
  oracle_messages_processed: number;
  oracle_messages_failed: number;
  oracle_messages_in_queue: number;
  oracle_dead_letter_count: number;
}

interface RustOracleConfig {
  rust_binary_path: string;
  ipc_socket_path: string;
  websocket_port: number;
  max_concurrent_requests: number;
  request_timeout_ms: number;
  validator_pool_size: number;
  bridge_health_check_interval: number;
  // Enhanced queue integration settings
  queue_metrics_interval: number;
  backpressure_threshold: number;
  dead_letter_retention_hours: number;
  load_balancer_enabled: boolean;
  performance_alert_thresholds: Record<string, number>;
  retry_configuration: Record<string, RetryConfig>;
}

interface RetryConfig {
  max_retries: number;
  backoff_base_ms: number;
  max_backoff_ms: number;
  exponential_backoff: boolean;
}

/**
 * Rust Oracle Bridge Service - Enhanced with Queue Coordination
 *
 * Manages the communication between TypeScript ClimateOracleNetwork and
 * Rust blockchain core oracle system for cross-chain computational requests.
 * Now includes enhanced queue processing, backpressure handling, and load balancing.
 */
export class RustOracleBridge extends EventEmitter {
  private config: RustOracleConfig;
  private rustProcess: ChildProcess | null = null;
  private websocketServer: WebSocketNS.WebSocketServer | null = null;
  private websocketConnection: WebSocket | null = null;
  private pendingRequests: Map<
    string,
    {
      resolve: (value: RustOracleResponse) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
      timestamp: number;
      priority: string;
      retryCount: number;
    }
  > = new Map();
  private isConnected = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private performanceMetrics: Map<string, number[]> = new Map();

  // Enhanced queue integration
  private queueMetrics: QueueMetrics | null = null;
  private coordinationEvents: CoordinationEvent[] = [];
  private backpressureActive = false;
  private metricsCollectionInterval: NodeJS.Timeout | null = null;
  private eventProcessingInterval: NodeJS.Timeout | null = null;
  private lastMetricsUpdate: number = 0;

  constructor(config: Partial<RustOracleConfig> = {}) {
    super();

    this.config = {
      rust_binary_path:
        config.rust_binary_path ||
        process.env.ORACLE_BRIDGE_BINARY_PATH ||
        path.join(
          process.cwd(),
          'core4/target/release/oracle-bridge'
        ),
      ipc_socket_path: config.ipc_socket_path || '/tmp/wrfcoin-oracle.sock',
      websocket_port: config.websocket_port || 9001,
      max_concurrent_requests: config.max_concurrent_requests || 100,
      request_timeout_ms: config.request_timeout_ms || 30000,
      validator_pool_size: config.validator_pool_size || 21,
      bridge_health_check_interval: config.bridge_health_check_interval || 5000,
      // Enhanced queue integration settings
      queue_metrics_interval: config.queue_metrics_interval || 1000,
      backpressure_threshold: config.backpressure_threshold || 800,
      dead_letter_retention_hours: config.dead_letter_retention_hours || 24,
      load_balancer_enabled: config.load_balancer_enabled || true,
      performance_alert_thresholds: config.performance_alert_thresholds || {
        latency_p95_ms: 5000,
        latency_p99_ms: 10000,
        error_rate_percent: 5.0,
        throughput_capacity_percent: 90.0,
      },
      retry_configuration: config.retry_configuration || {
        Critical: {
          max_retries: 3,
          backoff_base_ms: 100,
          max_backoff_ms: 1000,
          exponential_backoff: true,
        },
        High: {
          max_retries: 2,
          backoff_base_ms: 200,
          max_backoff_ms: 2000,
          exponential_backoff: true,
        },
        Normal: {
          max_retries: 1,
          backoff_base_ms: 500,
          max_backoff_ms: 5000,
          exponential_backoff: true,
        },
        Low: {
          max_retries: 0,
          backoff_base_ms: 1000,
          max_backoff_ms: 10000,
          exponential_backoff: false,
        },
      },
    };

    blockchainLogger.info('Rust Oracle Bridge initialized with config', {
      websocket_port: this.config.websocket_port,
      max_concurrent_requests: this.config.max_concurrent_requests,
      validator_pool_size: this.config.validator_pool_size,
      queue_metrics_interval: this.config.queue_metrics_interval,
      backpressure_threshold: this.config.backpressure_threshold,
    });
  }

  /**
   * Initialize the Rust Oracle Bridge
   *
   * Starts the Rust blockchain core oracle process and establishes
   * WebSocket communication for high-performance request handling.
   */
  async initialize(): Promise<void> {
    try {
      blockchainLogger.info('Initializing Rust Oracle Bridge...');

      // Start the Rust oracle process
      await this.startRustOracleProcess();

      // Initialize WebSocket server for communication
      await this.initializeWebSocketServer();

      // Establish connection to Rust process
      await this.connectToRustOracle();

      // Start health monitoring
      this.startHealthMonitoring();

      // Start enhanced queue integration
      this.startQueueMetricsCollection();
      this.startCoordinationEventProcessing();

      this.isConnected = true;
      this.emit('connected');

      blockchainLogger.info(
        'Rust Oracle Bridge initialized successfully with queue coordination'
      );
    } catch (error) {
      logError(blockchainLogger, 'Failed to initialize Rust Oracle Bridge', error as Error);
      throw error;
    }
  }

  /**
   * Start the Rust blockchain core oracle process
   */
  private async startRustOracleProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Check if Rust binary exists
        const binaryExists = require('fs').existsSync(
          this.config.rust_binary_path
        );
        if (!binaryExists) {
          throw new Error(
            `Rust oracle binary not found at: ${this.config.rust_binary_path}`
          );
        }

        // Start the Rust oracle process
        this.rustProcess = spawn(
          this.config.rust_binary_path,
          [
            '--mode',
            'bridge',
            '--websocket-port',
            this.config.websocket_port.toString(),
            '--validator-pool-size',
            this.config.validator_pool_size.toString(),
            '--ipc-socket',
            this.config.ipc_socket_path,
            '--log-level',
            'info',
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              RUST_LOG: 'info',
              WRFCOIN_ORACLE_MODE: 'bridge',
            },
          }
        );

        this.rustProcess.stdout?.on('data', data => {
          const output = data.toString();
          blockchainLogger.debug('Rust Oracle output', { output: output.trim() });

          // Check for initialization complete message
          if (output.includes('Oracle bridge server listening')) {
            resolve();
          }
        });

        this.rustProcess.stderr?.on('data', data => {
          blockchainLogger.error('Rust Oracle Error', { message: data.toString().trim() });
        });

        this.rustProcess.on('error', error => {
          logError(blockchainLogger, 'Rust oracle process error', error);
          reject(error);
        });

        this.rustProcess.on('exit', (code, signal) => {
          blockchainLogger.info(
            `Rust oracle process exited with code ${code}, signal ${signal}`
          );
          this.isConnected = false;
          this.emit('disconnected', { code, signal });
        });

        // Timeout if process doesn't start within 10 seconds
        setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('Rust oracle process startup timeout'));
          }
        }, 10000);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Initialize WebSocket server for high-performance communication
   */
  private async initializeWebSocketServer(): Promise<void> {
    return new Promise(resolve => {
      this.websocketServer = new WebSocketNS.WebSocketServer({
        port: this.config.websocket_port + 1, // TypeScript server on port + 1
        perMessageDeflate: false,
      });

      this.websocketServer.on('connection', ws => {
        blockchainLogger.info('WebSocket connection established with Rust oracle');

        this.websocketConnection = ws;

        ws.on('message', data => {
          this.handleRustOracleMessage(data.toString());
        });

        ws.on('close', () => {
          blockchainLogger.info('WebSocket connection closed');
          this.websocketConnection = null;
          this.isConnected = false;
          this.emit('disconnected');
        });

        ws.on('error', error => {
          logError(blockchainLogger, 'WebSocket error', error);
          this.emit('error', error);
        });
      });

      blockchainLogger.info(
        `WebSocket server listening on port ${this.config.websocket_port + 1}`
      );
      resolve();
    });
  }

  /**
   * Connect to the Rust oracle process via WebSocket
   */
  private async connectToRustOracle(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Give Rust process time to start WebSocket server
      setTimeout(() => {
        const ws = new WebSocket(
          `ws://${process.env.ORACLE_WS_HOST || 'localhost'}:${this.config.websocket_port}`
        );

        ws.on('open', () => {
          blockchainLogger.info('Connected to Rust oracle WebSocket');
          this.websocketConnection = ws;
          resolve();
        });

        ws.on('message', data => {
          this.handleRustOracleMessage(data.toString());
        });

        ws.on('error', error => {
          logError(blockchainLogger, 'Failed to connect to Rust oracle', error);
          reject(error);
        });

        ws.on('close', () => {
          blockchainLogger.info('Connection to Rust oracle closed');
          this.websocketConnection = null;
          this.isConnected = false;
        });
      }, 2000);
    });
  }

  /**
   * Handle incoming messages from Rust oracle
   */
  private handleRustOracleMessage(message: string): void {
    try {
      const data = JSON.parse(message);

      if (data.type === 'response' && data.request_id) {
        // Handle oracle response
        const pendingRequest = this.pendingRequests.get(data.request_id);
        if (pendingRequest) {
          clearTimeout(pendingRequest.timeout);
          this.pendingRequests.delete(data.request_id);

          // Update performance metrics
          this.updatePerformanceMetrics(
            data.request_id,
            Date.now() - pendingRequest.timestamp
          );

          pendingRequest.resolve(data.payload as RustOracleResponse);
        }
      } else if (data.type === 'health') {
        // Handle health check response
        this.emit('health', data.payload);
      } else if (data.type === 'error') {
        // Handle error response
        const pendingRequest = this.pendingRequests.get(data.request_id);
        if (pendingRequest) {
          clearTimeout(pendingRequest.timeout);
          this.pendingRequests.delete(data.request_id);
          pendingRequest.reject(new Error(data.error));
        }
      } else if (data.type === 'queue_metrics') {
        // Handle queue metrics update
        this.handleQueueMetricsUpdate(data.payload as QueueMetrics);
      } else if (data.type === 'coordination_event') {
        // Handle coordination events from Rust queue coordinator
        this.handleCoordinationEvent(data.payload as CoordinationEvent);
      } else if (data.type === 'backpressure_event') {
        // Handle backpressure notifications
        this.handleBackpressureEvent(data.payload);
      }
    } catch (error) {
      logError(blockchainLogger, 'Failed to parse Rust oracle message', error as Error);
    }
  }

  /**
   * Submit a computational request to the Rust oracle system
   *
   * This method integrates liquid democracy validation and cross-chain
   * consensus to ensure high-quality oracle responses.
   */
  async submitOracleRequest(
    request: RustOracleRequest
  ): Promise<RustOracleResponse> {
    if (!this.isConnected || !this.websocketConnection) {
      throw new Error('Rust oracle bridge not connected');
    }

    if (this.pendingRequests.size >= this.config.max_concurrent_requests) {
      throw new Error('Maximum concurrent requests exceeded');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`Oracle request timeout: ${request.id}`));
      }, this.config.request_timeout_ms);

      this.pendingRequests.set(request.id, {
        resolve,
        reject,
        timeout,
        timestamp: Date.now(),
        priority: request.priority,
        retryCount: 0,
      });

      // Send request to Rust oracle
      const message = {
        type: 'request',
        request_id: request.id,
        payload: request,
      };

      this.websocketConnection!.send(JSON.stringify(message));

      blockchainLogger.info(
        `Oracle request submitted: ${request.id} (${request.computation_type})`
      );
    });
  }

  /**
   * Submit a cross-chain oracle request with liquid democracy integration
   *
   * This method specifically handles cross-chain computational requests
   * by coordinating with the liquid democracy system for validator selection
   * and performance weighting.
   */
  async submitCrossChainOracleRequest(
    computationType: RustOracleRequest['computation_type'],
    sourceChain: string,
    targetChain: string,
    inputData: any,
    validatorRequirements: ValidatorRequirements,
    crossChainContext: CrossChainContext
  ): Promise<RustOracleResponse> {
    const requestId = `oracle_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const request: RustOracleRequest = {
      id: requestId,
      computation_type: computationType,
      source_chain: sourceChain,
      target_chain: targetChain,
      input_data: inputData,
      priority: this.determinePriority(computationType, crossChainContext),
      timeout_seconds: Math.floor(this.config.request_timeout_ms / 1000),
      validator_requirements: validatorRequirements,
      cross_chain_context: crossChainContext,
    };

    crosschainLogger.info(
      `Submitting cross-chain oracle request: ${sourceChain} → ${targetChain}`
    );
    crosschainLogger.info(
      `Computation type: ${computationType}, Priority: ${request.priority}`
    );

    try {
      const response = await this.submitOracleRequest(request);

      // Validate liquid democracy attestation
      if (validatorRequirements.delegation_chain_validation) {
        this.validateLiquidDemocracyAttestation(
          response.liquid_democracy_attestation
        );
      }

      crosschainLogger.info(`Cross-chain oracle request completed: ${requestId}`);
      crosschainLogger.info(
        `Consensus achieved: ${response.validator_consensus.achieved_consensus}%`
      );

      return response;
    } catch (error) {
      logError(
        crosschainLogger,
        `Cross-chain oracle request failed: ${requestId}`,
        error as Error
      );
      throw error;
    }
  }

  /**
   * Determine request priority based on computation type and context
   */
  private determinePriority(
    computationType: RustOracleRequest['computation_type'],
    context: CrossChainContext
  ): 'Low' | 'Medium' | 'High' | 'Critical' {
    // Emergency weather alerts get critical priority
    if (
      computationType === 'Weather' &&
      context.execution_deadline < Date.now() + 300000
    ) {
      return 'Critical';
    }

    // Financial computations get high priority
    if (computationType === 'Finance') {
      return 'High';
    }

    // Time-sensitive operations get high priority
    if (context.execution_deadline < Date.now() + 900000) {
      // 15 minutes
      return 'High';
    }

    // Machine learning and data analysis get medium priority
    if (['MachineLearning', 'DataAnalysis'].includes(computationType)) {
      return 'Medium';
    }

    return 'Low';
  }

  /**
   * Validate liquid democracy attestation from Rust oracle
   */
  private validateLiquidDemocracyAttestation(
    attestation: LiquidDemocracyAttestation
  ): void {
    if (!attestation.validator_credentials_verified) {
      throw new Error(
        'Validator credentials not verified through liquid democracy'
      );
    }

    if (attestation.total_delegated_power === 0) {
      blockchainLogger.warn('No delegated power in oracle consensus');
    }

    blockchainLogger.info(
      `Liquid democracy validation: ${attestation.delegation_chains_verified.length} chains verified`
    );
    blockchainLogger.info(
      `Total delegated power: ${attestation.total_delegated_power}`
    );
  }

  /**
   * Update performance metrics for oracle validators
   */
  private updatePerformanceMetrics(
    requestId: string,
    responseTimeMs: number
  ): void {
    const key = 'response_time';
    if (!this.performanceMetrics.has(key)) {
      this.performanceMetrics.set(key, []);
    }

    const metrics = this.performanceMetrics.get(key)!;
    metrics.push(responseTimeMs);

    // Keep only last 100 measurements
    if (metrics.length > 100) {
      metrics.shift();
    }
  }

  /**
   * Get average oracle performance metrics
   */
  getPerformanceMetrics(): {
    averageResponseTime: number;
    requestCount: number;
  } {
    const responseTimes = this.performanceMetrics.get('response_time') || [];
    const averageResponseTime =
      responseTimes.length > 0
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
        : 0;

    return {
      averageResponseTime,
      requestCount: responseTimes.length,
    };
  }

  /**
   * Start health monitoring for the Rust oracle bridge
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        if (this.websocketConnection) {
          const healthCheck = {
            type: 'health_check',
            timestamp: Date.now(),
          };

          this.websocketConnection.send(JSON.stringify(healthCheck));
        }
      } catch (error) {
        logError(blockchainLogger, 'Health check failed', error as Error);
      }
    }, this.config.bridge_health_check_interval);
  }

  /**
   * Shutdown the Rust Oracle Bridge
   */
  async shutdown(): Promise<void> {
    blockchainLogger.info('Shutting down Rust Oracle Bridge...');

    // Clear health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Clear queue metrics collection
    if (this.metricsCollectionInterval) {
      clearInterval(this.metricsCollectionInterval);
      this.metricsCollectionInterval = null;
    }

    // Clear coordination event processing
    if (this.eventProcessingInterval) {
      clearInterval(this.eventProcessingInterval);
      this.eventProcessingInterval = null;
    }

    // Close WebSocket connection
    if (this.websocketConnection) {
      this.websocketConnection.close();
    }

    // Close WebSocket server
    if (this.websocketServer) {
      this.websocketServer.close();
    }

    // Terminate Rust process
    if (this.rustProcess) {
      this.rustProcess.kill('SIGTERM');

      // Force kill if doesn't terminate gracefully
      setTimeout(() => {
        if (this.rustProcess && !this.rustProcess.killed) {
          this.rustProcess.kill('SIGKILL');
        }
      }, 5000);
    }

    // Clear pending requests
    for (const [requestId, pendingRequest] of this.pendingRequests) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(new Error('Bridge shutdown'));
    }
    this.pendingRequests.clear();

    this.isConnected = false;
    this.emit('shutdown');

    blockchainLogger.info('Rust Oracle Bridge shutdown complete');
  }

  /**
   * Check if the bridge is connected and operational
   */
  isHealthy(): boolean {
    return (
      this.isConnected &&
      this.websocketConnection !== null &&
      this.websocketConnection.readyState === WebSocket.OPEN &&
      this.rustProcess !== null
    );
  }

  /**
   * Get bridge status and metrics
   */
  getStatus(): {
    connected: boolean;
    pendingRequests: number;
    performanceMetrics: any;
    rustProcessPid?: number;
    queueMetrics?: QueueMetrics;
    backpressureActive: boolean;
    coordinationEventsCount: number;
  } {
    return {
      connected: this.isConnected,
      pendingRequests: this.pendingRequests.size,
      performanceMetrics: this.getPerformanceMetrics(),
      rustProcessPid: this.rustProcess?.pid,
      queueMetrics: this.queueMetrics || undefined,
      backpressureActive: this.backpressureActive,
      coordinationEventsCount: this.coordinationEvents.length,
    };
  }

  /**
   * Enhanced Queue Integration Methods
   */

  /**
   * Start queue metrics collection from Rust coordinator
   */
  private startQueueMetricsCollection(): void {
    this.metricsCollectionInterval = setInterval(async () => {
      try {
        if (
          this.websocketConnection &&
          this.websocketConnection.readyState === WebSocket.OPEN
        ) {
          const metricsRequest = {
            type: 'get_queue_metrics',
            timestamp: Date.now(),
          };

          this.websocketConnection.send(JSON.stringify(metricsRequest));
        }
      } catch (error) {
        logError(blockchainLogger, 'Queue metrics collection failed', error as Error);
      }
    }, this.config.queue_metrics_interval);
  }

  /**
   * Start coordination event processing
   */
  private startCoordinationEventProcessing(): void {
    this.eventProcessingInterval = setInterval(() => {
      try {
        // Process accumulated coordination events
        if (this.coordinationEvents.length > 0) {
          // Keep only the last 1000 events to prevent memory issues
          if (this.coordinationEvents.length > 1000) {
            this.coordinationEvents = this.coordinationEvents.slice(-1000);
          }

          // Emit processed events for external monitoring
          this.emit('coordination_events_processed', {
            count: this.coordinationEvents.length,
            latest: this.coordinationEvents[this.coordinationEvents.length - 1],
            timestamp: Date.now(),
          });
        }
      } catch (error) {
        logError(blockchainLogger, 'Coordination event processing failed', error as Error);
      }
    }, 5000); // Process events every 5 seconds
  }

  /**
   * Handle queue metrics updates from Rust coordinator
   */
  private handleQueueMetricsUpdate(metrics: QueueMetrics): void {
    this.queueMetrics = metrics;
    this.lastMetricsUpdate = Date.now();

    // Check for performance alerts
    this.checkPerformanceAlerts(metrics);

    // Emit metrics update event
    this.emit('queue_metrics_updated', metrics);

    blockchainLogger.debug('Queue metrics updated', {
      messagesPerSecond: metrics.messages_per_second,
      latencyP95Ms: metrics.latency_p95_ms,
      successRate: (metrics.success_rate * 100).toFixed(1),
    });
  }

  /**
   * Handle coordination events from Rust queue coordinator
   */
  private handleCoordinationEvent(event: CoordinationEvent): void {
    this.coordinationEvents.push(event);

    // Handle specific event types
    switch (event.type) {
      case 'BackpressureEvent':
        this.handleBackpressureEvent({
          queue_depth: event.payload.queue_depth,
          capacity: event.payload.capacity,
          recommended_delay_ms: event.payload.recommended_delay_ms,
        });
        break;

      case 'PerformanceAlert':
        blockchainLogger.warn('Performance alert triggered', {
          metricName: event.payload.metric_name,
          currentValue: event.payload.current_value,
          threshold: event.payload.threshold,
        });
        break;

      case 'DeadLetterEvent':
        blockchainLogger.error('Request moved to dead letter queue', {
          requestId: event.payload.request_id,
          attempts: event.payload.attempts,
        });
        break;

      case 'RequestCompleted':
        blockchainLogger.debug('Request completed', {
          requestId: event.payload.request_id,
          processingTimeMs: event.payload.processing_time_ms,
        });
        break;
    }

    // Emit coordination event for external listeners
    this.emit('coordination_event', event);
  }

  /**
   * Handle backpressure events from queue coordinator
   */
  private handleBackpressureEvent(payload: any): void {
    const queueUtilization = payload.queue_depth / payload.capacity;

    if (queueUtilization >= 0.8) {
      // 80% threshold
      if (!this.backpressureActive) {
        this.backpressureActive = true;
        blockchainLogger.warn('Backpressure activated', {
          queueUtilization: (queueUtilization * 100).toFixed(1),
        });

        // Emit backpressure event
        this.emit('backpressure_activated', {
          queueUtilization,
          recommendedDelay: payload.recommended_delay_ms || 1000,
        });
      }
    } else if (queueUtilization < 0.6 && this.backpressureActive) {
      // 60% recovery threshold
      this.backpressureActive = false;
      blockchainLogger.info('Backpressure deactivated', {
        queueUtilization: (queueUtilization * 100).toFixed(1),
      });

      // Emit backpressure recovery event
      this.emit('backpressure_deactivated', {
        queueUtilization,
      });
    }
  }

  /**
   * Check performance metrics against alert thresholds
   */
  private checkPerformanceAlerts(metrics: QueueMetrics): void {
    const thresholds = this.config.performance_alert_thresholds;

    // Check latency thresholds
    if (metrics.latency_p95_ms > thresholds.latency_p95_ms) {
      this.emit('performance_alert', {
        type: 'latency_p95_exceeded',
        current: metrics.latency_p95_ms,
        threshold: thresholds.latency_p95_ms,
        severity: 'warning',
      });
    }

    if (metrics.latency_p99_ms > thresholds.latency_p99_ms) {
      this.emit('performance_alert', {
        type: 'latency_p99_exceeded',
        current: metrics.latency_p99_ms,
        threshold: thresholds.latency_p99_ms,
        severity: 'critical',
      });
    }

    // Check error rate threshold
    if (metrics.error_rate > thresholds.error_rate_percent / 100) {
      this.emit('performance_alert', {
        type: 'error_rate_exceeded',
        current: metrics.error_rate * 100,
        threshold: thresholds.error_rate_percent,
        severity: 'high',
      });
    }

    // Check throughput capacity threshold
    const capacityUtilization =
      (metrics.messages_per_second / metrics.throughput_capacity) * 100;
    if (capacityUtilization > thresholds.throughput_capacity_percent) {
      this.emit('performance_alert', {
        type: 'throughput_capacity_exceeded',
        current: capacityUtilization,
        threshold: thresholds.throughput_capacity_percent,
        severity: 'warning',
      });
    }
  }

  /**
   * Get current queue metrics
   */
  getQueueMetrics(): QueueMetrics | null {
    return this.queueMetrics;
  }

  /**
   * Get recent coordination events
   */
  getCoordinationEvents(limit: number = 100): CoordinationEvent[] {
    return this.coordinationEvents.slice(-limit);
  }

  /**
   * Get queue health status
   */
  getQueueHealthStatus(): QueueHealthStatus {
    const metrics = this.queueMetrics;

    if (!metrics) {
      return {
        healthy: false,
        throughput_utilization_percent: 0,
        load_balancer_active: false,
        oracle_healthy: this.isHealthy(),
        oracle_messages_processed: 0,
        oracle_messages_failed: 0,
        oracle_messages_in_queue: this.pendingRequests.size,
        oracle_dead_letter_count: 0,
      };
    }

    const throughputUtilization =
      (metrics.messages_per_second / metrics.throughput_capacity) * 100;
    const healthy =
      metrics.success_rate > 0.95 &&
      metrics.latency_p95_ms <
        this.config.performance_alert_thresholds.latency_p95_ms &&
      !this.backpressureActive;

    return {
      healthy,
      throughput_utilization_percent: throughputUtilization,
      load_balancer_active: metrics.load_balancer_status.active_workers > 1,
      oracle_healthy: this.isHealthy(),
      oracle_messages_processed: Math.floor(metrics.messages_per_second * 60), // Approximate per minute
      oracle_messages_failed: Math.floor(
        metrics.error_rate * metrics.messages_per_second * 60
      ),
      oracle_messages_in_queue: Object.values(metrics.queue_depths).reduce(
        (a, b) => a + b,
        0
      ),
      oracle_dead_letter_count: metrics.dead_letter_count,
    };
  }

  /**
   * Request queue statistics from Rust coordinator
   */
  async requestQueueStatistics(): Promise<QueueMetrics | null> {
    if (
      !this.websocketConnection ||
      this.websocketConnection.readyState !== WebSocket.OPEN
    ) {
      return null;
    }

    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        resolve(this.queueMetrics);
      }, 5000);

      const requestId = `stats_${Date.now()}`;
      const handleResponse = (message: string) => {
        try {
          const data = JSON.parse(message);
          if (
            data.type === 'queue_statistics' &&
            data.request_id === requestId
          ) {
            clearTimeout(timeout);
            this.websocketConnection?.removeListener('message', handleResponse);
            resolve(data.payload as QueueMetrics);
          }
        } catch (error) {
          // Ignore parsing errors for other messages
        }
      };

      this.websocketConnection!.on('message', handleResponse);

      // Send statistics request
      this.websocketConnection!.send(
        JSON.stringify({
          type: 'get_queue_statistics',
          request_id: requestId,
          timestamp: Date.now(),
        })
      );
    });
  }

  /**
   * Force queue metrics refresh
   */
  async refreshQueueMetrics(): Promise<void> {
    if (
      this.websocketConnection &&
      this.websocketConnection.readyState === WebSocket.OPEN
    ) {
      const metricsRequest = {
        type: 'refresh_queue_metrics',
        timestamp: Date.now(),
      };

      this.websocketConnection.send(JSON.stringify(metricsRequest));
    }
  }
}

// Export types for use in other modules
export {
  RustOracleRequest,
  RustOracleResponse,
  ValidatorRequirements,
  CrossChainContext,
  ValidatorConsensus,
  ExecutionMetrics,
  CrossChainProof,
  LiquidDemocracyAttestation,
  RustOracleConfig,
  QueueMetrics,
  LoadBalancerStatus,
  CoordinationEvent,
  QueueHealthStatus,
  RetryConfig,
};
