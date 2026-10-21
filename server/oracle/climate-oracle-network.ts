import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { eq, and } from 'drizzle-orm';
import { db, pool } from '../../database/db.js';
import { validators } from '../../shared/schema.js';
import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import {
  RustOracleBridge,
  RustOracleRequest,
  ValidatorRequirements,
  CrossChainContext,
} from './rust-oracle-bridge.js';
import { blockchainLogger, logError, crosschainLogger } from '../utils/logger.js';

// Type definitions for Climate Oracle Network
interface Validator {
  id: number;
  validatorId: number;
  name: string;
  public_key: string;
  reputation_score: number;
  reliability: number;
  stake_amount: number;
  is_active: boolean;
  last_activity: string;
  oracle_participation: number;
  data_accuracy_score: number;
  accuracy?: number;
  status?: string;
}

interface BridgeAdapter {
  id: number;
  name: string;
  provider: string;
  source_chain: string;
  target_chain: string;
  contract_address: string;
  status: string;
  provider_api_key?: string;
  config?: any;
  getStatus(): Promise<{
    status: string;
    lastActivity: string;
    successRate: number;
  }>;
}

interface MockBridgeAdapter {
  id: number;
  name: string;
  provider: string;
  source_chain: string;
  target_chain: string;
  contract_address: string;
  status: string;
  initialize(): Promise<boolean>;
  sendData(
    data: any
  ): Promise<{ success: boolean; txHash: string; timestamp: string }>;
  sendTransaction(
    transaction: any
  ): Promise<{ success: boolean; transactionHash?: string; error?: string }>;
  getStatus(): Promise<{
    status: string;
    lastActivity: string;
    successRate: number;
  }>;
}

interface OracleRequest {
  id: string;
  requester: string;
  dataType: string;
  parameters: any;
  timestamp: string;
  status: string;
  responseDeadline: string;
  rewardAmount: number;
  validationThreshold: number;
}

interface OracleResponse {
  id: string;
  requestId: string;
  validatorId: number;
  data: any;
  confidence: number;
  timestamp: string;
  signature: string;
}

interface ValidationResult {
  isValid: boolean;
  score: number;
  reasons: string[];
}

interface ConsensusResult {
  value: any;
  confidence: number;
  participatingValidators: number;
  timestamp: string;
}

interface ClimateData {
  timestamp: string;
  location: string;
  temperature?: number;
  humidity?: number;
  pressure?: number;
  windSpeed?: number;
  windDirection?: number;
  precipitation?: number;
  [key: string]: any;
}

interface ValidatorBLSSignature {
  validatorId: number;
  timestamp: string;
  signature: string;
  publicKey: string;
  messageHash: string;
  scheme: string;
  domain: string;
  dataCommitment: string;
}

interface BLSAggregateProof {
  aggregatedSignature: string;
  publicKeys: string[];
  bitmap: string;
  messageHash: string;
  signerIds: number[];
  validatorSet: number[];
  verification: {
    aggregateSignatureValid: boolean;
    participantCount: number;
    curve: string;
    scheme: string;
    domain: string;
  };
  serialization: {
    format: string;
    payload: string;
    payloadHash: string;
  };
}

const BLS_CURVE_ID = 'BLS12-381';
const BLS_SIGNATURE_SCHEME = 'bls12-381-short-signatures';
const BLS_DOMAIN_TAG = 'WRFCOIN_CLIMATE_ORACLE_BLS_V1';

/**
 * Climate Data Oracle Network
 *
 * This module implements a specialized oracle network for providing verified
 * climate and weather data to other blockchains. It extends the existing
 * validator infrastructure to support cross-chain data verification and
 * distribution.
 *
 * Key features:
 * - Decentralized validator network with PoP requirements
 * - Multi-validator consensus for data integrity
 * - Reputation scoring based on data accuracy over time
 * - Cross-chain data bridges for various ecosystems
 */

import {
  oracleRequests,
  oracleResponses,
  crossChainBridges,
  validatorOracleParticipation,
  bridgeTransactions,
} from '../../shared/oracle-schema.js';

/**
 * Climate Oracle Network Manager
 * Manages the climate data oracle network and its operations
 */
class ClimateOracleNetwork {
  private validators: Validator[];
  private qualifiedValidators: Validator[];
  private bridgeAdapters: Record<string, BridgeAdapter>;
  private isInitialized: boolean;
  private pollingInterval: NodeJS.Timeout | null;
  private requestProcessingQueue: string[];
  private rustOracleBridge: RustOracleBridge | null;
  private blsSignatureSuitePromise: Promise<any> | null;

  constructor() {
    this.validators = [];
    this.qualifiedValidators = [];
    this.bridgeAdapters = {};
    this.isInitialized = false;
    this.pollingInterval = null;
    this.requestProcessingQueue = [];
    this.rustOracleBridge = null;
    this.blsSignatureSuitePromise = null;
  }

  async getBLSSignatureSuite(): Promise<any> {
    if (this.blsSignatureSuitePromise) {
      return this.blsSignatureSuitePromise;
    }

    this.blsSignatureSuitePromise = import(
      '@noble/curves/bls12-381'
    ).then(module => {
      const blsModule = module as any;
      return blsModule.bls12_381.shortSignatures ?? blsModule.bls12_381;
    });

    return this.blsSignatureSuitePromise;
  }

  /**
   * Get all qualified validators in the oracle network
   * @returns {Promise<Validator[]>} Array of validator objects
   */
  async getValidators(): Promise<Validator[]> {
    // Return the validators loaded during initialization
    // If not loaded yet, load them now
    if (!this.validators || this.validators.length === 0) {
      await this.loadQualifiedValidators();
    }
    return this.validators || [];
  }

  /**
   * Get a validator by their ID
   * @param {string|number} id Validator ID
   * @returns {Promise<Validator|null>} Validator object or null if not found
   */
  async getValidatorById(id: string | number): Promise<Validator | null> {
    // Convert id to number if it's a string containing only digits
    const numericId =
      typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id;

    // Make sure validators are loaded
    if (!this.validators || this.validators.length === 0) {
      await this.loadQualifiedValidators();
    }

    // Find the validator with the matching ID
    return this.validators.find(v => v.id === numericId) || null;
  }

  /**
   * Initialize the climate oracle network
   */
  async initialize(): Promise<boolean> {
    try {
      blockchainLogger.info('Initializing Climate Oracle Network');
      await this.loadQualifiedValidators();
      await this.initializeBridgeAdapters();

      // Initialize Rust Oracle Bridge for cross-chain integration
      await this.initializeRustOracleBridge();

      // Start polling for pending oracle requests
      this.pollingInterval = setInterval(() => this.pollForRequests(), 30000); // Poll every 30 seconds

      this.isInitialized = true;
      blockchainLogger.info(
        `Climate Oracle Network initialized with ${this.validators.length} qualified validators`
      );

      return true;
    } catch (error) {
      logError(
        blockchainLogger,
        'Failed to initialize Climate Oracle Network',
        error as Error
      );
      return false;
    }
  }

  /**
   * Load validators that meet the minimum requirements for climate data oracle
   */
  async loadQualifiedValidators(): Promise<void> {
    try {
      // Use Drizzle to check information about validators table safely
      const columnInfo = await db.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'validators'"
      );

      const columnArray = Array.isArray(columnInfo)
        ? columnInfo
        : [];
      blockchainLogger.info(
        `Found ${columnArray.length} columns in validators table`
      );

      // Use Drizzle ORM to select validators with proper security measures
      const qualifiedValidators = await db
        .select({
          id: validators.id,
          name: validators.name,
          status: validators.status,
        })
        .from(validators)
        .limit(10);

      // Map the results to our validator objects with defaults for missing fields
      this.validators = qualifiedValidators.map(validator => ({
        id: validator.id,
        validatorId: validator.id,
        name: validator.name || `Validator ${validator.id}`,
        public_key: `pub_key_${validator.id}`, // Mock public key
        reputation_score: 95, // Default reputation score
        reliability: 0.95, // Default reliability
        stake_amount: 1000, // Default stake amount
        is_active: validator.status === 'active',
        last_activity: new Date().toISOString(),
        oracle_participation: 85, // Default participation score
        data_accuracy_score: 95, // Default accuracy score
      }));

      blockchainLogger.info(
        `Loaded ${this.validators.length} qualified validators for oracle network`
      );
    } catch (error) {
      logError(blockchainLogger, 'Failed to load qualified validators', error as Error);
      // Fallback to empty array
      this.validators = [];
    }
  }

  /**
   * Initialize bridge adapters for cross-chain communication
   */
  async initializeBridgeAdapters(): Promise<void> {
    try {
      // Use Drizzle ORM's secure query builder for bridge adapters
      let bridges: any[] = [];

      try {
        // First check if the table exists using direct string
        const tableExists = await db.execute(
          "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'cross_chain_bridges')"
        );

        const tableExistsArray = Array.isArray(tableExists)
          ? tableExists
          : [];
        if (tableExistsArray.length > 0 && tableExistsArray[0].exists) {
          bridges = await db
            .select({
              id: crossChainBridges.id,
              name: crossChainBridges.name,
              provider: crossChainBridges.provider,
              source_chain: crossChainBridges.sourceChain,
              target_chain: crossChainBridges.targetChain,
              contract_address: crossChainBridges.contractAddress,
              status: crossChainBridges.status,
              provider_api_key: crossChainBridges.providerApiKey,
              config: crossChainBridges.config,
            })
            .from(crossChainBridges);
        } else {
          blockchainLogger.info(
            'cross_chain_bridges table does not exist yet, skipping'
          );
        }
      } catch (error) {
        blockchainLogger.warn(
          'Error fetching bridge adapters, using empty list',
          { error: error instanceof Error ? error.message : String(error) }
        );
        bridges = [];
      }

      // Create a mock bridge adapter class for testing
      class MockBridgeAdapter {
        id: number;
        name: string;
        provider: string;
        source_chain: string;
        target_chain: string;
        contract_address: string;
        status: string;

        constructor(bridge: BridgeAdapter) {
          this.id = bridge.id;
          this.name = bridge.name;
          this.provider = bridge.provider;
          this.source_chain = bridge.source_chain;
          this.target_chain = bridge.target_chain;
          this.contract_address = bridge.contract_address;
          this.status = bridge.status;
        }

        async initialize(): Promise<boolean> {
          blockchainLogger.info(
            `Initialized mock bridge adapter for ${this.name} (${this.provider})`
          );
          return true;
        }

        async sendData(
          data: any
        ): Promise<{ success: boolean; txHash: string; timestamp: string }> {
          crosschainLogger.info(
            `[${this.provider}] Sending data to ${this.target_chain}`
          );
          return {
            success: true,
            txHash: `tx-${Math.random().toString(36).substring(2, 8)}`,
            timestamp: new Date().toISOString(),
          };
        }

        async sendTransaction(
          transaction: any
        ): Promise<{
          success: boolean;
          transactionHash?: string;
          error?: string;
        }> {
          crosschainLogger.info(
            `[${this.provider}] Sending transaction to ${this.target_chain}`
          );
          return {
            success: true,
            transactionHash: `tx-${Math.random().toString(36).substring(2, 10)}`,
          };
        }

        async getStatus(): Promise<{
          status: string;
          lastActivity: string;
          successRate: number;
        }> {
          return {
            status: 'active',
            lastActivity: new Date().toISOString(),
            successRate: 0.95,
          };
        }
      }

      // Initialize a mock adapter for each bridge
      for (const bridge of bridges as any[]) {
        try {
          // Create a mock adapter for now
          const adapter = new MockBridgeAdapter(bridge);
          await adapter.initialize();

          // Store the adapter by bridge ID
          this.bridgeAdapters[bridge.id] = adapter as any;

          blockchainLogger.info(
            `Initialized bridge adapter for ${bridge.name} (${bridge.provider})`
          );
        } catch (error) {
          // If a bridge adapter fails to initialize, log the error and continue
          logError(
            blockchainLogger,
            `Failed to initialize bridge adapter for ${bridge.name}`,
            error as Error
          );
        }
      }

      blockchainLogger.info(
        `Initialized ${Object.keys(this.bridgeAdapters).length} bridge adapters`
      );
    } catch (error) {
      logError(blockchainLogger, 'Failed to initialize bridge adapters', error as Error);
    }
  }

  /**
   * Initialize Rust Oracle Bridge for cross-chain oracle integration
   */
  async initializeRustOracleBridge(): Promise<void> {
    try {
      blockchainLogger.info('Initializing Rust Oracle Bridge integration...');

      // Create Rust Oracle Bridge instance with configuration
      this.rustOracleBridge = new RustOracleBridge({
        websocket_port: 9001,
        max_concurrent_requests: 50,
        request_timeout_ms: 45000,
        validator_pool_size: this.validators.length,
        bridge_health_check_interval: 10000,
      });

      // Set up event listeners for bridge connection events
      this.rustOracleBridge.on('connected', () => {
        blockchainLogger.info('Rust Oracle Bridge connected successfully');
      });

      this.rustOracleBridge.on('disconnected', data => {
        blockchainLogger.warn('Rust Oracle Bridge disconnected', { data });
        // Attempt to reconnect after a delay
        setTimeout(() => this.reconnectRustOracleBridge(), 5000);
      });

      this.rustOracleBridge.on('error', error => {
        logError(blockchainLogger, 'Rust Oracle Bridge error', error as Error);
      });

      // Initialize the bridge connection
      await this.rustOracleBridge.initialize();

      blockchainLogger.info('Rust Oracle Bridge integration completed');
    } catch (error) {
      logError(blockchainLogger, 'Failed to initialize Rust Oracle Bridge', error as Error);
      // Continue without bridge - graceful degradation
      this.rustOracleBridge = null;
      blockchainLogger.warn(
        'Climate Oracle Network will operate without Rust bridge integration'
      );
    }
  }

  /**
   * Attempt to reconnect the Rust Oracle Bridge
   */
  private async reconnectRustOracleBridge(): Promise<void> {
    if (!this.rustOracleBridge) return;

    try {
      blockchainLogger.info('Attempting to reconnect Rust Oracle Bridge...');
      await this.rustOracleBridge.initialize();
      blockchainLogger.info('Rust Oracle Bridge reconnected successfully');
    } catch (error) {
      logError(blockchainLogger, 'Failed to reconnect Rust Oracle Bridge', error as Error);
      // Try again in 10 seconds
      setTimeout(() => this.reconnectRustOracleBridge(), 10000);
    }
  }

  /**
   * Create a new oracle request
   * @param {Object} requestData The oracle request data
   * @returns {Promise<string>} The request ID
   */
  async createRequest(requestData) {
    try {
      const requestId = `oracle-${uuidv4().replace(/-/g, '').substring(0, 16)}`;
      const requestHash = this.hashData({
        dataType: requestData.dataType,
        parameters: requestData.parameters,
        sourceChain: requestData.sourceChain,
        sourceAddress: requestData.sourceAddress,
        timestamp: new Date().toISOString(),
      });

      const requestResult = await db
        .insert(oracleRequests)
        .values({
          id: requestId,
          dataType: requestData.dataType,
          parameters: requestData.parameters,
          sourceChain: requestData.sourceChain,
          sourceAddress: requestData.sourceAddress,
          callbackFunction: requestData.callbackFunction,
          requiredConfidence: requestData.requiredConfidence,
          maxValidatorFee: requestData.maxValidatorFee,
          deadline: requestData.deadline,
          status: 'PENDING',
          priority: requestData.priority || 1,
          createdAt: new Date(),
          requestHash,
        })
        .returning();

      const request = Array.isArray(requestResult)
        ? requestResult[0]
        : requestResult;

      // Add to processing queue
      this.requestProcessingQueue.push(requestId);

      blockchainLogger.info(`Created oracle request: ${requestId}`);

      // Start processing immediately if high priority
      if ((requestData.priority || 1) > 5) {
        this.processOracleRequest(request);
      }

      return requestId;
    } catch (error) {
      logError(blockchainLogger, 'Failed to create oracle request', error as Error);
      throw error;
    }
  }

  /**
   * Cancel an oracle request
   * @param {string} requestId The request ID to cancel
   * @returns {Promise<Object>} Result object
   */
  async cancelRequest(requestId) {
    try {
      // Check if request exists and is in a cancellable state
      const [request] = await db
        .select()
        .from(oracleRequests)
        .where(eq(oracleRequests.id, requestId));

      if (!request) {
        return { success: false, error: 'Oracle request not found' };
      }

      if (request.status !== 'PENDING' && request.status !== 'PROCESSING') {
        return {
          success: false,
          error: `Cannot cancel request in ${request.status} state`,
        };
      }

      // Update request status to CANCELLED
      await db
        .update(oracleRequests)
        .set({ status: 'CANCELLED' })
        .where(eq(oracleRequests.id, requestId));

      // Remove from processing queue if present
      this.requestProcessingQueue = this.requestProcessingQueue.filter(
        id => id !== requestId
      );

      blockchainLogger.info(`Cancelled oracle request: ${requestId}`);

      return { success: true };
    } catch (error) {
      logError(
        blockchainLogger,
        `Failed to cancel oracle request ${requestId}`,
        error as Error
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Create a cross-chain oracle request using the Rust Oracle Bridge
   * @param {Object} requestData The cross-chain oracle request data
   * @returns {Promise<Object>} The oracle response from Rust bridge
   */
  async createCrossChainRequest(requestData: {
    dataType: string;
    parameters: any;
    sourceChain: string;
    targetChain: string;
    sourceAddress: string;
    callbackFunction?: string;
    requiredConfidence: number;
    maxValidatorFee: number;
    deadline: string;
    priority?: number;
  }): Promise<any> {
    try {
      if (!this.rustOracleBridge || !this.rustOracleBridge.isHealthy()) {
        throw new Error(
          'Rust Oracle Bridge not available - falling back to local processing'
        );
      }

      crosschainLogger.info(
        `Creating cross-chain oracle request: ${requestData.sourceChain} → ${requestData.targetChain}`
      );

      // Map Climate Oracle data types to Rust Oracle computation types
      const computationType = this.mapDataTypeToComputationType(
        requestData.dataType
      );

      // Create validator requirements based on request
      const validatorRequirements: ValidatorRequirements = {
        min_reputation_score: 0.8, // 80% minimum reputation
        min_stake_amount: 1000, // Minimum stake in tokens
        required_data_accuracy: requestData.requiredConfidence || 0.85,
        delegation_chain_validation: true, // Enable liquid democracy validation
        oracle_performance_threshold: 0.7, // 70% performance threshold
      };

      // Create cross-chain context
      const crossChainContext: CrossChainContext = {
        bridge_protocol: this.determineBridgeProtocol(
          requestData.sourceChain,
          requestData.targetChain
        ),
        source_block_height: 0, // Will be filled by bridge
        confirmation_requirements: 3, // Number of confirmations needed
        gas_limit: 200000, // Gas limit for execution
        priority_fee: 1000000000, // 1 gwei priority fee
        execution_deadline: new Date(requestData.deadline).getTime(),
      };

      // Submit the cross-chain oracle request to Rust bridge
      const response =
        await this.rustOracleBridge.submitCrossChainOracleRequest(
          computationType,
          requestData.sourceChain,
          requestData.targetChain,
          {
            dataType: requestData.dataType,
            parameters: requestData.parameters,
            sourceAddress: requestData.sourceAddress,
            callbackFunction: requestData.callbackFunction,
          },
          validatorRequirements,
          crossChainContext
        );

      crosschainLogger.info(
        `Cross-chain oracle request completed with ${response.validator_consensus.achieved_consensus}% consensus`
      );

      // Store the cross-chain response in our database for tracking
      await this.storeCrossChainResponse(requestData, response);

      return {
        success: true,
        requestId: response.request_id,
        result: response.result,
        consensus: response.validator_consensus,
        executionMetrics: response.execution_metrics,
        liquidDemocracyAttestation: response.liquid_democracy_attestation,
        crossChainProof: response.cross_chain_proof,
      };
    } catch (error) {
      logError(crosschainLogger, 'Cross-chain oracle request failed', error as Error);

      // Fallback to local processing if Rust bridge fails
      if (error instanceof Error && error.message.includes('not available')) {
        blockchainLogger.info('Falling back to local oracle processing...');
        return await this.createRequest(requestData);
      }

      throw error;
    }
  }

  /**
   * Map Climate Oracle data types to Rust Oracle computation types
   */
  private mapDataTypeToComputationType(
    dataType: string
  ): RustOracleRequest['computation_type'] {
    switch (dataType.toUpperCase()) {
      case 'TEMPERATURE':
      case 'PRECIPITATION':
      case 'HUMIDITY':
      case 'WIND':
      case 'PRESSURE':
      case 'AIR_QUALITY':
      case 'FORECAST':
      case 'HISTORICAL':
        return 'Weather';
      case 'CLIMATE_IMPACT':
      case 'AGGREGATE':
        return 'Scientific';
      default:
        return 'DataAnalysis';
    }
  }

  /**
   * Determine the appropriate bridge protocol for cross-chain communication
   */
  private determineBridgeProtocol(
    sourceChain: string,
    targetChain: string
  ): string {
    // Map chain pairs to optimal bridge protocols
    const chainPairToBridge: Record<string, string> = {
      ethereum: 'LayerZero',
      polygon: 'Polygon PoS Bridge',
      bsc: 'LayerZero',
      avalanche: 'Axelar',
      arbitrum: 'LayerZero',
      optimism: 'LayerZero',
      cosmos: 'IBC',
      osmosis: 'IBC',
      solana: 'Wormhole',
      sui: 'Wormhole',
      base: 'LayerZero',
    };

    return chainPairToBridge[targetChain.toLowerCase()] || 'LayerZero';
  }

  /**
   * Store cross-chain response data for tracking and auditing
   */
  private async storeCrossChainResponse(
    requestData: any,
    response: any
  ): Promise<void> {
    try {
      // Create a local oracle response record for cross-chain requests
      const responseId = `xchain-resp-${uuidv4().replace(/-/g, '').substring(0, 16)}`;

      await db.insert(oracleResponses).values({
        id: responseId,
        requestId: response.request_id,
        dataType: requestData.dataType,
        data: response.result,
        confidence: response.validator_consensus.achieved_consensus / 100,
        validatorCount:
          response.validator_consensus.participating_validators.length,
        timestamp: new Date(),
        respondedAt: new Date(),
        status: 'DELIVERED',
        sourceChain: requestData.sourceChain,
        sourceAddress: requestData.sourceAddress,
        hash: this.hashData({
          requestId: response.request_id,
          result: response.result,
          consensus: response.validator_consensus,
        }),
      });

      crosschainLogger.info(`Stored cross-chain response: ${responseId}`);
    } catch (error) {
      logError(crosschainLogger, 'Failed to store cross-chain response', error as Error);
      // Non-fatal error - don't throw
    }
  }

  /**
   * Process a climate data oracle request
   * @param {Object} request The oracle request to process
   * @returns {Promise<Object>} The processed oracle response
   */
  async processOracleRequest(request) {
    try {
      blockchainLogger.info(`Processing oracle request ${request.id}`);

      // Update request status to PROCESSING
      await db
        .update(oracleRequests)
        .set({ status: 'PROCESSING', processedAt: new Date() })
        .where(eq(oracleRequests.id, request.id));

      // Validate the request
      this.validateRequest(request);

      // Check if this is a cross-chain request that should use Rust Oracle Bridge
      if (this.shouldUseCrossChainBridge(request)) {
        blockchainLogger.info(
          `Routing request ${request.id} to Rust Oracle Bridge for cross-chain processing`
        );

        try {
          const crossChainResponse =
            await this.processCrossChainRequest(request);

          // Update request status to COMPLETED
          await db
            .update(oracleRequests)
            .set({ status: 'COMPLETED' })
            .where(eq(oracleRequests.id, request.id));

          return crossChainResponse;
        } catch (bridgeError) {
          blockchainLogger.warn(
            `Cross-chain bridge failed for request ${request.id}, falling back to local processing`,
            { error: bridgeError }
          );
          // Continue with local processing as fallback
        }
      }

      // Local processing for non-cross-chain requests or fallback
      blockchainLogger.info(
        `Processing request ${request.id} locally with TypeScript validator network`
      );

      // Collect data from validators
      const validatorResponses = await this.collectValidatorData(request);

      // Reach consensus among validator responses
      const consensusResult = await this.reachConsensus(validatorResponses);

      // Create and store the oracle response
      const response = await this.createOracleResponse(
        request,
        consensusResult
      );

      // Update validator reputations based on data accuracy
      await this.updateValidatorReputations(
        validatorResponses,
        consensusResult
      );

      // Submit response via bridge if source chain is specified
      if (request.sourceChain && request.sourceAddress) {
        await this.submitResponseToBridge(response);
      }

      // Update request status to COMPLETED
      await db
        .update(oracleRequests)
        .set({ status: 'COMPLETED' })
        .where(eq(oracleRequests.id, request.id));

      blockchainLogger.info(`Completed oracle request ${request.id}`);

      return response;
    } catch (error) {
      logError(
        blockchainLogger,
        `Failed to process oracle request ${request.id}`,
        error as Error
      );

      // Update request status to ERROR
      await db
        .update(oracleRequests)
        .set({
          status: 'ERROR',
          error: error instanceof Error ? error.message : String(error),
        })
        .where(eq(oracleRequests.id, request.id));

      throw error;
    }
  }

  /**
   * Determine if a request should use the cross-chain Rust Oracle Bridge
   */
  private shouldUseCrossChainBridge(request: any): boolean {
    // Use Rust bridge for:
    // 1. Cross-chain requests (sourceChain specified and different from wrfcoin)
    // 2. High-priority requests requiring enhanced security
    // 3. Requests requiring liquid democracy validation

    if (!this.rustOracleBridge || !this.rustOracleBridge.isHealthy()) {
      return false; // Bridge not available
    }

    // Cross-chain requests
    if (
      request.sourceChain &&
      request.sourceChain.toLowerCase() !== 'wrfcoin'
    ) {
      return true;
    }

    // High-priority requests (priority > 5)
    if (request.priority && request.priority > 5) {
      return true;
    }

    // Requests requiring high confidence (> 90%)
    if (request.requiredConfidence && request.requiredConfidence > 0.9) {
      return true;
    }

    return false;
  }

  /**
   * Process a request using the Rust Oracle Bridge for enhanced validation
   */
  private async processCrossChainRequest(request: any): Promise<any> {
    if (!this.rustOracleBridge) {
      throw new Error('Rust Oracle Bridge not available');
    }

    const computationType = this.mapDataTypeToComputationType(request.dataType);

    const validatorRequirements: ValidatorRequirements = {
      min_reputation_score: 0.8,
      min_stake_amount: 1000,
      required_data_accuracy: request.requiredConfidence || 0.85,
      delegation_chain_validation: true,
      oracle_performance_threshold: 0.7,
    };

    const crossChainContext: CrossChainContext = {
      bridge_protocol: this.determineBridgeProtocol(
        'wrfcoin',
        request.sourceChain || 'ethereum'
      ),
      source_block_height: 0,
      confirmation_requirements: 3,
      gas_limit: 200000,
      priority_fee: 1000000000,
      execution_deadline: new Date(
        request.deadline || Date.now() + 3600000
      ).getTime(),
    };

    const response = await this.rustOracleBridge.submitCrossChainOracleRequest(
      computationType,
      'wrfcoin',
      request.sourceChain || 'ethereum',
      {
        dataType: request.dataType,
        parameters: request.parameters,
        sourceAddress: request.sourceAddress,
      },
      validatorRequirements,
      crossChainContext
    );

    // Convert Rust response to our format
    return {
      id: `rust-resp-${uuidv4().replace(/-/g, '').substring(0, 16)}`,
      requestId: request.id,
      dataType: request.dataType,
      data: response.result,
      confidence: response.validator_consensus.achieved_consensus / 100,
      validatorCount:
        response.validator_consensus.participating_validators.length,
      timestamp: new Date(),
      respondedAt: new Date(),
      status: 'READY',
      sourceChain: request.sourceChain,
      sourceAddress: request.sourceAddress,
      rustBridgeResponse: response, // Include full Rust response for auditing
    };
  }

  /**
   * Validate an oracle request before processing
   * @param {Object} request The request to validate
   */
  validateRequest(request) {
    // Check if request has valid data type
    if (!request.dataType) {
      throw new Error('Invalid request: Missing data type');
    }

    // Check if parameters are present
    if (!request.parameters) {
      throw new Error('Invalid request: Missing parameters');
    }

    // Check if deadline is in the past
    if (request.deadline && new Date(request.deadline) < new Date()) {
      throw new Error('Invalid request: Deadline has already passed');
    }

    // Add specific validations for each data type
    switch (request.dataType) {
      case 'TEMPERATURE':
      case 'PRECIPITATION':
      case 'HUMIDITY':
      case 'WIND':
      case 'PRESSURE':
      case 'AIR_QUALITY':
        // These require location parameters
        if (!request.parameters.latitude || !request.parameters.longitude) {
          throw new Error(
            `Invalid request: ${request.dataType} requires latitude and longitude parameters`
          );
        }
        break;

      case 'FORECAST':
        // Forecast requires location and time range
        if (
          !request.parameters.region &&
          (!request.parameters.latitude || !request.parameters.longitude)
        ) {
          throw new Error(
            'Invalid request: FORECAST requires either region or latitude/longitude parameters'
          );
        }
        if (
          !request.parameters.forecastHours &&
          !request.parameters.forecastDays
        ) {
          throw new Error(
            'Invalid request: FORECAST requires forecastHours or forecastDays parameter'
          );
        }
        break;

      case 'HISTORICAL':
        // Historical requires location and time range
        if (
          !request.parameters.region &&
          (!request.parameters.latitude || !request.parameters.longitude)
        ) {
          throw new Error(
            'Invalid request: HISTORICAL requires either region or latitude/longitude parameters'
          );
        }
        if (!request.parameters.startDate || !request.parameters.endDate) {
          throw new Error(
            'Invalid request: HISTORICAL requires startDate and endDate parameters'
          );
        }
        break;

      case 'AGGREGATE':
        // Aggregate requires data types to aggregate
        if (
          !request.parameters.dataTypes ||
          !Array.isArray(request.parameters.dataTypes) ||
          request.parameters.dataTypes.length === 0
        ) {
          throw new Error(
            'Invalid request: AGGREGATE requires dataTypes parameter as a non-empty array'
          );
        }
        break;

      case 'CLIMATE_IMPACT':
        // Climate impact requires impact type
        if (!request.parameters.impactType) {
          throw new Error(
            'Invalid request: CLIMATE_IMPACT requires impactType parameter'
          );
        }
        break;

      default:
        throw new Error(
          `Invalid request: Unknown data type "${request.dataType}"`
        );
    }
  }

  /**
   * Collect data from multiple validators for an oracle request
   * @param {Object} request The oracle request
   * @returns {Promise<Array>} Array of validator responses
   */
  async collectValidatorData(request) {
    blockchainLogger.info(`Collecting validator data for request ${request.id}`);

    // In a real implementation, this would query all validators in the network
    // For simulation, we'll generate responses based on the validators we loaded

    // Generate base data for the request
    const baseData = this.generateBaseDataForRequest(request);
    const canonicalMessageHash = this.createCanonicalBLSMessageHash({
      requestId: request.id,
      dataType: request.dataType,
      parameters: request.parameters || {},
      sourceChain: request.sourceChain || 'wrfcoin',
      responseDeadline: request.responseDeadline || null,
    });

    // Simulate collecting responses from validators
    const validatorResponses: any[] = [];

    for (const validator of this.validators) {
      // Skip validators that are unreliable (simulated)
      if (Math.random() > validator.reliability) {
        blockchainLogger.debug(
          `Validator ${validator.name} did not respond (simulated reliability check)`
        );
        continue;
      }

      // Apply some variance to the data to simulate different validator readings
      const variance = Math.random() * 0.1; // Up to 10% variance
      const validatorData = this.applyVarianceToData(baseData, variance);

      // Create a signature for the data
      const signature = await this.createValidatorSignature(
        validator,
        validatorData,
        canonicalMessageHash
      );

      // Add to responses
      validatorResponses.push({
        validatorId: validator.validatorId,
        name: validator.name,
        data: validatorData,
        signature,
        timestamp: new Date().toISOString(),
        confidence: 0.8 + Math.random() * 0.2, // 0.8 to 1.0 confidence
      });

      // Store validator participation in the database
      await db.insert(validatorOracleParticipation).values({
        validatorId: String(validator.validatorId),
        requestId: request.id,
        responseData: validatorData,
        confidence: 0.8 + Math.random() * 0.2,
        timestamp: new Date(),
        signature: signature.signature,
      });
    }

    blockchainLogger.info(
      `Collected ${validatorResponses.length} validator responses for request ${request.id}`
    );

    return validatorResponses;
  }

  /**
   * Generate base data for a request (for simulation purposes)
   * @param {Object} request The oracle request
   * @returns {Object} Generated base data
   */
  generateBaseDataForRequest(request) {
    const baseData: any = { timestamp: new Date().toISOString() };

    switch (request.dataType) {
      case 'TEMPERATURE':
        baseData.temperature = 15 + Math.random() * 15; // 15-30°C
        baseData.unit = 'celsius';
        if (request.parameters.includeFeelsLike) {
          baseData.feelsLike = baseData.temperature - 2 + Math.random() * 4;
        }
        break;

      case 'PRECIPITATION':
        baseData.precipitation = Math.random() * 25; // 0-25mm
        baseData.unit = 'mm';
        baseData.type = Math.random() > 0.7 ? 'rain' : 'snow';
        break;

      case 'HUMIDITY':
        baseData.humidity = 30 + Math.random() * 70; // 30-100%
        baseData.unit = 'percent';
        break;

      case 'WIND':
        baseData.speed = 5 + Math.random() * 20; // 5-25 km/h
        baseData.direction = Math.floor(Math.random() * 360); // 0-359 degrees
        baseData.gust = baseData.speed + Math.random() * 15; // Higher than speed
        baseData.unit = 'km/h';
        break;

      case 'PRESSURE':
        baseData.pressure = 980 + Math.random() * 40; // 980-1020 hPa
        baseData.unit = 'hPa';
        baseData.trend = Math.random() > 0.5 ? 'rising' : 'falling';
        break;

      case 'AIR_QUALITY':
        baseData.aqi = Math.floor(Math.random() * 300); // 0-300 AQI
        baseData.pm25 = Math.random() * 150; // PM2.5 concentration
        baseData.pm10 = baseData.pm25 * (1.2 + Math.random() * 0.5); // PM10 concentration
        baseData.o3 = Math.random() * 70; // Ozone
        baseData.no2 = Math.random() * 100; // Nitrogen dioxide
        baseData.so2 = Math.random() * 20; // Sulfur dioxide
        baseData.co = Math.random() * 10; // Carbon monoxide
        break;

      case 'FORECAST':
        const hours =
          request.parameters.forecastHours ||
          request.parameters.forecastDays * 24 ||
          24;
        baseData.region =
          request.parameters.region ||
          `${request.parameters.latitude},${request.parameters.longitude}`;
        baseData.forecastPeriod = `${hours}h`;
        baseData.intervals = [];

        // Generate forecast intervals
        for (let i = 0; i < hours; i += 3) {
          // Every 3 hours
          baseData.intervals.push({
            time: new Date(Date.now() + i * 60 * 60 * 1000).toISOString(),
            temperature:
              15 + Math.random() * 15 - Math.cos((i / 24) * Math.PI) * 5, // Day/night cycle
            precipitation: Math.random() > 0.7 ? Math.random() * 5 : 0,
            humidity: 30 + Math.random() * 70,
            windSpeed: 5 + Math.random() * 20,
            windDirection: Math.floor(Math.random() * 360),
            pressure: 980 + Math.random() * 40,
            cloudCover: Math.floor(Math.random() * 100),
            precipitationProbability: Math.floor(Math.random() * 100),
          });
        }
        break;

      case 'HISTORICAL':
        const startDate = new Date(request.parameters.startDate);
        const endDate = new Date(request.parameters.endDate);
        const days = Math.ceil(
          (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
        );

        baseData.region =
          request.parameters.region ||
          `${request.parameters.latitude},${request.parameters.longitude}`;
        baseData.period = `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`;
        baseData.days = [];

        // Generate historical data for each day
        for (let i = 0; i < days; i++) {
          const date = new Date(startDate);
          date.setDate(date.getDate() + i);

          baseData.days.push({
            date: date.toISOString().split('T')[0],
            temperature: {
              min: 10 + Math.random() * 10,
              max: 20 + Math.random() * 15,
              avg: 15 + Math.random() * 10,
            },
            precipitation: Math.random() > 0.6 ? Math.random() * 10 : 0,
            humidity: {
              min: 30 + Math.random() * 20,
              max: 60 + Math.random() * 40,
              avg: 50 + Math.random() * 30,
            },
            windSpeed: {
              min: 2 + Math.random() * 5,
              max: 10 + Math.random() * 15,
              avg: 5 + Math.random() * 10,
            },
          });
        }
        break;

      case 'AGGREGATE':
        baseData.aggregationType =
          request.parameters.aggregationType || 'average';
        baseData.region = request.parameters.region || 'global';
        baseData.period = request.parameters.period || 'daily';
        baseData.dataPoints = Math.floor(10 + Math.random() * 90); // 10-100 data points

        // Generate aggregated values for each requested data type
        baseData.values = {};
        for (const dataType of request.parameters.dataTypes) {
          switch (dataType) {
            case 'TEMPERATURE':
              baseData.values.temperature = 15 + Math.random() * 10;
              break;
            case 'PRECIPITATION':
              baseData.values.precipitation = Math.random() * 20;
              break;
            case 'HUMIDITY':
              baseData.values.humidity = 40 + Math.random() * 60;
              break;
            case 'WIND':
              baseData.values.windSpeed = 5 + Math.random() * 15;
              break;
            case 'PRESSURE':
              baseData.values.pressure = 990 + Math.random() * 30;
              break;
            case 'AIR_QUALITY':
              baseData.values.aqi = Math.floor(Math.random() * 200);
              break;
          }
        }
        break;

      case 'CLIMATE_IMPACT':
        baseData.impactType = request.parameters.impactType;
        baseData.region = request.parameters.region || 'global';
        baseData.timeframe = request.parameters.timeframe || '2020-2050';

        // Generate impact data based on impact type
        switch (request.parameters.impactType) {
          case 'SEA_LEVEL_RISE':
            baseData.projection = {
              min: 0.3 + Math.random() * 0.2,
              max: 0.8 + Math.random() * 0.4,
              avg: 0.5 + Math.random() * 0.3,
            };
            baseData.unit = 'meters';
            baseData.confidenceLevel = 80 + Math.floor(Math.random() * 15);
            break;

          case 'TEMPERATURE_INCREASE':
            baseData.projection = {
              min: 1.0 + Math.random() * 0.5,
              max: 2.5 + Math.random() * 1.5,
              avg: 1.5 + Math.random() * 1.0,
            };
            baseData.unit = 'celsius';
            baseData.confidenceLevel = 75 + Math.floor(Math.random() * 20);
            break;

          case 'EXTREME_WEATHER':
            baseData.projection = {
              frequency: 1.5 + Math.random() * 1.0, // Multiplier of current frequency
              intensity: 1.2 + Math.random() * 0.8, // Multiplier of current intensity
            };
            baseData.events = ['floods', 'droughts', 'hurricanes', 'heatwaves'];
            baseData.confidenceLevel = 70 + Math.floor(Math.random() * 15);
            break;

          default:
            baseData.projection = {
              impact: 'medium',
              confidence: 'medium',
            };
        }
        break;

      default:
        // Generic data for unknown types
        baseData.value = Math.random() * 100;
        baseData.confidence = 50 + Math.floor(Math.random() * 50);
    }

    return baseData;
  }

  /**
   * Apply random variance to simulate different validator readings
   * @param {Object} baseData The base data
   * @param {number} variance The variance percentage (0-1)
   * @returns {Object} Data with applied variance
   */
  applyVarianceToData(baseData, variance) {
    // Clone the base data
    const data = JSON.parse(JSON.stringify(baseData));

    // Find and modify numeric values with variance
    const applyVarianceToObject = obj => {
      for (const key in obj) {
        if (typeof obj[key] === 'number') {
          // Apply random variance within the specified percentage
          const varianceFactor = 1 + (Math.random() * 2 * variance - variance);
          obj[key] = obj[key] * varianceFactor;
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          // Recurse into nested objects and arrays
          applyVarianceToObject(obj[key]);
        }
      }
    };

    applyVarianceToObject(data);

    return data;
  }

  /**
   * Create a cryptographic signature for validator data
   * @param {Object} validator The validator
   * @param {Object} data The data to sign
   * @param {string} canonicalMessageHash Optional canonical message hash
   * @returns {Object} The signature object
   */
  async createValidatorSignature(
    validator,
    data,
    canonicalMessageHash?: string
  ): Promise<ValidatorBLSSignature> {
    const blsShortSigs = await this.getBLSSignatureSuite();
    const validatorId = Number(validator.validatorId || validator.id);
    const messageHash =
      canonicalMessageHash ||
      this.createCanonicalBLSMessageHash({
        validatorId,
        dataType: 'VALIDATOR_DATA',
        data,
      });

    const privateKey = this.deriveValidatorBLSPrivateKey(validator);
    const messageBytes = Buffer.from(messageHash, 'hex');
    const messagePoint = blsShortSigs.hash(messageBytes);
    const signatureBytes = blsShortSigs.sign(messagePoint, privateKey).toBytes();
    const publicKeyBytes = blsShortSigs.getPublicKey(privateKey).toBytes();

    return {
      validatorId,
      timestamp: new Date().toISOString(),
      signature: this.bytesToHex(signatureBytes),
      publicKey: this.bytesToHex(publicKeyBytes),
      messageHash,
      scheme: BLS_SIGNATURE_SCHEME,
      domain: BLS_DOMAIN_TAG,
      dataCommitment: this.hashData(data),
    };
  }

  createCanonicalBLSMessageHash(payload: unknown): string {
    return crypto
      .createHash('sha256')
      .update(`${BLS_DOMAIN_TAG}:${this.canonicalJSONStringify(payload)}`)
      .digest('hex');
  }

  canonicalJSONStringify(payload: unknown): string {
    return JSON.stringify(this.canonicalizeObject(payload));
  }

  canonicalizeObject(value: any): any {
    if (Array.isArray(value)) {
      return value.map(entry => this.canonicalizeObject(entry));
    }

    if (value && typeof value === 'object') {
      const sortedKeys = Object.keys(value).sort();
      const canonicalObject: Record<string, unknown> = {};
      for (const key of sortedKeys) {
        canonicalObject[key] = this.canonicalizeObject(value[key]);
      }
      return canonicalObject;
    }

    return value;
  }

  deriveValidatorBLSPrivateKey(validator): Uint8Array {
    const seedMaterial = `${BLS_DOMAIN_TAG}:${validator.validatorId || validator.id}:${validator.public_key || validator.name || 'validator'}`;
    const seed = crypto.createHash('sha256').update(seedMaterial).digest();
    const privateKey = new Uint8Array(seed);

    // Noble rejects zero key material; enforce non-zero scalar deterministically.
    if (privateKey.every(value => value === 0)) {
      privateKey[privateKey.length - 1] = 1;
    }

    return privateKey;
  }

  normalizeBlsHex(value: string, expectedBytes?: number): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('BLS field must be a non-empty hex string');
    }

    const normalized = value.startsWith('0x') ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]+$/.test(normalized)) {
      throw new Error('BLS field contains non-hex characters');
    }
    if (normalized.length % 2 !== 0) {
      throw new Error('BLS field must have an even-length hex encoding');
    }

    if (expectedBytes && normalized.length !== expectedBytes * 2) {
      throw new Error(
        `BLS field has invalid length; expected ${expectedBytes} bytes`
      );
    }

    return normalized.toLowerCase();
  }

  bytesToHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
  }

  hexToBytes(value: string, expectedBytes?: number): Uint8Array {
    return Buffer.from(this.normalizeBlsHex(value, expectedBytes), 'hex');
  }

  /**
   * Reach consensus among validator responses
   * @param {Array} validatorResponses Array of validator responses
   * @returns {Promise<Object>} Consensus result
   */
  async reachConsensus(validatorResponses) {
    if (validatorResponses.length === 0) {
      throw new Error('No validator responses to reach consensus');
    }

    blockchainLogger.info(
      `Reaching consensus among ${validatorResponses.length} validator responses`
    );

    // Extract the data from each validator response
    const datasets = validatorResponses.map(response => response.data);

    // Get the first dataset as a template
    const template = datasets[0];

    // Calculate consensus values
    const consensusData = this.calculateConsensusValues(template, datasets);

    // Calculate agreement level among datasets
    const agreementLevel = this.calculateAgreementLevel(datasets);

    const consensusResult = {
      data: consensusData,
      validatorCount: validatorResponses.length,
      confidence: Math.min(1, Math.max(0.5, agreementLevel)), // Scale 0.5-1.0
      timestamp: new Date().toISOString(),
    };

    blockchainLogger.info(
      `Reached consensus with confidence ${consensusResult.confidence.toFixed(4)}`
    );

    return consensusResult;
  }

  /**
   * Calculate consensus values from multiple datasets
   * @param {Object} template The data structure template
   * @param {Array} datasets Array of data objects
   * @returns {Object} Consensus data
   */
  calculateConsensusValues(template: any, datasets: any[]) {
    // Clone the template to maintain structure
    const consensusData = JSON.parse(JSON.stringify(template));

    // Find all numeric values in the template and their paths
    const numericPaths = this.findNumericValuesAndPaths(template);

    // Calculate median for each numeric value
    for (const { path } of numericPaths) {
      const values = datasets
        .map(dataset => {
          return this.getValueAtPath(dataset, path);
        })
        .filter(value => typeof value === 'number');

      // Update the consensus data with the median value
      if (values.length > 0) {
        const medianValue = this.calculateMedian(values);

        // Set the value at the path
        let current = consensusData;
        const pathParts = path.split('.');

        for (let i = 0; i < pathParts.length - 1; i++) {
          const part = pathParts[i];

          if (part.includes('[')) {
            const [arrayName, indexStr] = part.split('[');
            const index = parseInt(indexStr.replace(']', ''));
            current = current[arrayName][index];
          } else {
            current = current[part];
          }
        }

        const lastPart = pathParts[pathParts.length - 1];
        if (lastPart.includes('[')) {
          const [arrayName, indexStr] = lastPart.split('[');
          const index = parseInt(indexStr.replace(']', ''));
          current[arrayName][index] = medianValue;
        } else {
          current[lastPart] = medianValue;
        }
      }
    }

    return consensusData;
  }

  /**
   * Find all numeric values and their paths in an object
   * @param {Object} obj The object to search
   * @param {string} basePath The base path
   * @returns {Array} Array of {value, path} objects
   */
  findNumericValuesAndPaths(obj: any, basePath = '') {
    let results: any[] = [];

    for (const key in obj) {
      const value = obj[key];
      const path = basePath ? `${basePath}.${key}` : key;

      if (typeof value === 'number') {
        results.push({ value, path });
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (typeof value[i] === 'object' && value[i] !== null) {
            results = results.concat(
              this.findNumericValuesAndPaths(value[i], `${path}[${i}]`)
            );
          } else if (typeof value[i] === 'number') {
            results.push({ value: value[i], path: `${path}[${i}]` });
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        results = results.concat(this.findNumericValuesAndPaths(value, path));
      }
    }

    return results;
  }

  /**
   * Get value at a given path in an object
   * @param {Object} obj The object
   * @param {string} path The path
   * @returns {any} The value at the path
   */
  getValueAtPath(obj, path) {
    const pathParts = path.split('.');
    let current = obj;

    for (const part of pathParts) {
      if (part.includes('[')) {
        const [arrayName, indexStr] = part.split('[');
        const index = parseInt(indexStr.replace(']', ''));

        if (
          !current[arrayName] ||
          !Array.isArray(current[arrayName]) ||
          index >= current[arrayName].length
        ) {
          return undefined;
        }

        current = current[arrayName][index];
      } else {
        if (!current.hasOwnProperty(part)) {
          return undefined;
        }

        current = current[part];
      }
    }

    return current;
  }

  /**
   * Calculate median of numeric values
   * @param {Array<number>} values Array of numbers
   * @returns {number} The median value
   */
  calculateMedian(values) {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      return (sorted[middle - 1] + sorted[middle]) / 2;
    } else {
      return sorted[middle];
    }
  }

  /**
   * Calculate agreement level among datasets
   * @param {Array} datasets Array of data objects
   * @returns {number} Agreement level (0-1)
   */
  calculateAgreementLevel(datasets) {
    if (datasets.length <= 1) return 1; // Perfect agreement with only one dataset

    // Find numeric values in the first dataset
    const numericPaths = this.findNumericValuesAndPaths(datasets[0]);

    if (numericPaths.length === 0) return 1; // No numeric values to compare

    let totalVariance = 0;
    let comparisonCount = 0;

    // For each numeric path, calculate the variance between datasets
    for (const { path } of numericPaths) {
      const values = datasets
        .map(dataset => this.getValueAtPath(dataset, path))
        .filter(value => typeof value === 'number');

      if (values.length <= 1) continue;

      // Calculate average value
      const average = values.reduce((sum, val) => sum + val, 0) / values.length;

      // Skip very small values to avoid division issues
      if (Math.abs(average) < 0.00001) continue;

      // Calculate variance as percentage of average
      const deviations = values.map(
        val => Math.abs(val - average) / Math.abs(average)
      );
      const pathVariance =
        deviations.reduce((sum, dev) => sum + dev, 0) / deviations.length;

      totalVariance += pathVariance;
      comparisonCount++;
    }

    if (comparisonCount === 0) return 1;

    // Calculate average variance and convert to agreement level (0-1)
    const averageVariance = totalVariance / comparisonCount;
    const agreementLevel = Math.max(0, 1 - averageVariance);

    return agreementLevel;
  }

  /**
   * Create and store an oracle response
   * @param {Object} request The original oracle request
   * @param {Object} consensusResult The consensus result
   * @returns {Promise<Object>} The created oracle response
   */
  async createOracleResponse(request, consensusResult) {
    // Generate a response ID and hash
    const responseId = `resp-${uuidv4().replace(/-/g, '').substring(0, 16)}`;
    const responseHash = this.hashData({
      requestId: request.id,
      data: consensusResult.data,
      timestamp: consensusResult.timestamp,
    });

    // Create the response record
    const responseResult = await db
      .insert(oracleResponses)
      .values({
        id: responseId,
        requestId: request.id,
        dataType: request.dataType,
        data: consensusResult.data,
        confidence: consensusResult.confidence,
        validatorCount: consensusResult.validatorCount,
        timestamp: new Date(consensusResult.timestamp),
        respondedAt: new Date(),
        status: 'READY',
        sourceChain: request.sourceChain,
        sourceAddress: request.sourceAddress,
        hash: responseHash,
      })
      .returning();

    const response = Array.isArray(responseResult)
      ? responseResult[0]
      : responseResult;

    blockchainLogger.info(
      `Created oracle response ${responseId} for request ${request.id}`
    );

    return response;
  }

  /**
   * Generate cryptographic hash of data
   * @param {Object} data The data to hash
   * @returns {string} The hash value
   */
  hashData(data) {
    const dataString = JSON.stringify(data);
    return crypto.createHash('sha256').update(dataString).digest('hex');
  }

  /**
   * Submit oracle response to the source chain via enhanced bridge adapter
   * @param {Object} response The oracle response
   * @returns {Promise<Object>} The result of the submission
   */
  async submitResponseToBridge(response) {
    try {
      // Check if we have a bridge for the source chain
      const [bridge] = await db
        .select()
        .from(crossChainBridges)
        .where(
          and(
            eq(crossChainBridges.targetChain, response.sourceChain),
            eq(crossChainBridges.status, 'ACTIVE')
          )
        );

      if (!bridge) {
        throw new Error(
          `No active bridge found for chain ${response.sourceChain}`
        );
      }

      // Get the bridge adapter
      const adapter = this.bridgeAdapters[bridge.id] as any;

      if (!adapter) {
        throw new Error(`Bridge adapter not initialized for ${bridge.name}`);
      }

      // Enhanced cross-chain message preparation with proof generation
      const crossChainMessage: any = {
        id: crypto.randomUUID(),
        sourceChain: 'wrfcoin',
        destinationChain: response.sourceChain,
        payload: {
          type: 'ORACLE_RESULT',
          responseId: response.id,
          requestId: response.requestId,
          dataType: response.dataType,
          result: response.data,
          confidence: response.confidence,
          timestamp: response.timestamp.toISOString(),
          validationProof: await this.generateValidationProof(response),
          consensusMetadata: response.consensusData || {},
        },
        priority: this.determinePriority(response),
        timestamp: new Date(),
        expiresAt: new Date(Date.now() + 3600000), // 1 hour expiry
        retryConfig: {
          maxRetries: 5,
          baseDelayMs: 1000,
          maxDelayMs: 60000,
          backoffMultiplier: 2.0,
        },
      };

      // Calculate message hash for deduplication
      crossChainMessage.messageHash =
        this.calculateMessageHash(crossChainMessage);

      // Create transaction record with enhanced metadata
      const transactionResult = await db
        .insert(bridgeTransactions)
        .values({
          bridgeId: bridge.id,
          sourceChain: 'wrfcoin',
          targetChain: response.sourceChain,
          targetAddress: response.sourceAddress,
          data: crossChainMessage,
          status: 'PENDING',
          timestamp: new Date(),
        })
        .returning();

      const transaction = Array.isArray(transactionResult)
        ? transactionResult[0]
        : transactionResult;

      // Submit to enhanced bridge with retry logic
      crosschainLogger.info(
        `Submitting enhanced response ${response.id} to ${bridge.name} (${bridge.provider}) with validation proof`
      );

      const result = await this.submitWithRetryLogic(
        adapter,
        transaction,
        crossChainMessage.retryConfig
      );

      // Update transaction with enhanced result tracking
      await db
        .update(bridgeTransactions)
        .set({
          status: result.success ? 'COMPLETED' : 'FAILED',
          targetTxHash: result.transactionHash,
          completedAt: result.success ? new Date() : null,
          error: result.error,
        })
        .where(eq(bridgeTransactions.id, transaction.id));

      // Update oracle response status with enhanced tracking
      await db
        .update(oracleResponses)
        .set({
          status: result.success ? 'DELIVERED' : 'ERROR',
          deliveredAt: result.success ? new Date() : null,
          transactionHash: result.transactionHash,
          error: result.error,
        })
        .where(eq(oracleResponses.id, response.id));

      crosschainLogger.info(
        `Enhanced response ${response.id} ${result.success ? 'delivered' : 'failed to deliver'} to ${response.sourceChain} (attempts: ${result.deliveryAttempts})`
      );

      return result;
    } catch (error) {
      logError(
        crosschainLogger,
        `Failed to submit enhanced response ${response.id} to bridge`,
        error as Error
      );

      // Update oracle response with error
      await db
        .update(oracleResponses)
        .set({
          status: 'ERROR',
          error: error instanceof Error ? error.message : String(error),
        })
        .where(eq(oracleResponses.id, response.id));

      throw error;
    }
  }

  /**
   * Generate validation proof for cross-chain oracle result
   * @param {Object} response The oracle response
   * @returns {Promise<Object>} Validation proof object
   */
  async generateValidationProof(response) {
    try {
      const proof: any = {
        type: 'MERKLE_PROOF',
        hash: this.calculateResultHash(response),
        merkleRoot: await this.generateMerkleRoot(response),
        validatorSignatures: response.validatorSignatures || [],
        consensusProof: response.consensusData
          ? await this.generateConsensusProof(response.consensusData)
          : null,
        timestamp: new Date().toISOString(),
      };

      // Add BLS signature if available
      if (
        response.validatorSignatures &&
        response.validatorSignatures.length > 0
      ) {
        proof.blsAggregateSignature = await this.generateBLSProof(
          response.validatorSignatures
        );
      }

      return proof;
    } catch (error) {
      blockchainLogger.warn(
        `Failed to generate validation proof for response ${response.id}`,
        { error: error instanceof Error ? error.message : String(error) }
      );
      return null;
    }
  }

  /**
   * Generate Merkle root for oracle result data integrity
   * @param {Object} response The oracle response
   * @returns {Promise<string>} Merkle root hash
   */
  async generateMerkleRoot(response) {
    const dataElements = [
      response.id,
      response.requestId,
      JSON.stringify(response.data),
      response.confidence.toString(),
      response.timestamp.toISOString(),
    ];

    // Simple Merkle tree construction
    let currentLevel = dataElements.map(element =>
      crypto.createHash('sha256').update(element).digest('hex')
    );

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || currentLevel[i]; // Handle odd number of elements
        const combined = crypto
          .createHash('sha256')
          .update(left + right)
          .digest('hex');
        nextLevel.push(combined);
      }
      currentLevel = nextLevel;
    }

    return currentLevel[0];
  }

  /**
   * Generate consensus proof for validator agreement
   * @param {Object} consensusData The consensus data
   * @returns {Promise<Object>} Consensus proof
   */
  async generateConsensusProof(consensusData) {
    return {
      method: consensusData.method || 'WEIGHTED_MEDIAN',
      participantCount: consensusData.validatorCount || 0,
      agreementLevel: consensusData.agreement || 0,
      confidence: consensusData.confidence || 0,
      byzantineFaultTolerance: consensusData.byzantineFaultTolerance || 0,
      proofHash: crypto
        .createHash('sha256')
        .update(JSON.stringify(consensusData))
        .digest('hex'),
    };
  }

  /**
   * Generate BLS aggregate signature proof using BLS12-381 short signatures
   * @param {Array} validatorSignatures Array of validator signatures
   * @returns {Promise<Object>} BLS proof
   */
  async generateBLSProof(
    validatorSignatures
  ): Promise<BLSAggregateProof> {
    const blsShortSigs = await this.getBLSSignatureSuite();
    const normalizedSignatures =
      this.normalizeValidatorBLSSignatures(validatorSignatures);
    const messageHash = normalizedSignatures[0].messageHash;
    const messageBytes = Buffer.from(messageHash, 'hex');
    const messagePoint = blsShortSigs.hash(messageBytes);

    const signatureBytes = normalizedSignatures.map(sig =>
      this.hexToBytes(sig.signature, 48)
    );
    const publicKeyBytes = normalizedSignatures.map(sig =>
      this.hexToBytes(sig.publicKey, 96)
    );

    // Validate each signature before aggregation to reject malformed inputs early.
    for (let i = 0; i < normalizedSignatures.length; i += 1) {
      const isValid = blsShortSigs.verify(
        signatureBytes[i],
        messagePoint,
        publicKeyBytes[i]
      );
      if (!isValid) {
        throw new Error(
          `Invalid validator BLS signature for signer ${normalizedSignatures[i].validatorId}`
        );
      }
    }

    const aggregatedSignatureBytes =
      blsShortSigs.aggregateSignatures(signatureBytes).toBytes();
    const aggregatedPublicKey =
      blsShortSigs.aggregatePublicKeys(publicKeyBytes);
    const aggregateSignatureValid = blsShortSigs.verify(
      aggregatedSignatureBytes,
      messagePoint,
      aggregatedPublicKey
    );

    if (!aggregateSignatureValid) {
      throw new Error('BLS aggregate signature verification failed');
    }

    const bitmapData = this.createSignatureBitmapData(normalizedSignatures);
    const aggregatedSignature = this.bytesToHex(aggregatedSignatureBytes);
    const publicKeys = normalizedSignatures.map(sig => sig.publicKey);

    const canonicalPayload = this.canonicalJSONStringify({
      curve: BLS_CURVE_ID,
      scheme: BLS_SIGNATURE_SCHEME,
      domain: BLS_DOMAIN_TAG,
      messageHash,
      signerIds: bitmapData.signerIds,
      validatorSet: bitmapData.validatorSet,
      bitmap: bitmapData.bitmap,
      publicKeys,
      aggregatedSignature,
    });

    const proof: BLSAggregateProof = {
      aggregatedSignature,
      publicKeys,
      bitmap: bitmapData.bitmap,
      messageHash,
      signerIds: bitmapData.signerIds,
      validatorSet: bitmapData.validatorSet,
      verification: {
        aggregateSignatureValid,
        participantCount: normalizedSignatures.length,
        curve: BLS_CURVE_ID,
        scheme: BLS_SIGNATURE_SCHEME,
        domain: BLS_DOMAIN_TAG,
      },
      serialization: {
        format: 'wrfcoin-bls-aggregate-proof-v1',
        payload: canonicalPayload,
        payloadHash: crypto
          .createHash('sha256')
          .update(canonicalPayload)
          .digest('hex'),
      },
    };

    if (!(await this.verifyBLSAggregateProof(proof))) {
      throw new Error(
        'Generated BLS aggregate proof did not pass post-generation verification'
      );
    }

    return proof;
  }

  normalizeValidatorBLSSignatures(validatorSignatures: any[]): ValidatorBLSSignature[] {
    if (!Array.isArray(validatorSignatures) || validatorSignatures.length === 0) {
      throw new Error('BLS proof requires at least one validator signature');
    }

    const normalized = validatorSignatures.map((entry, index) => {
      const source =
        entry && typeof entry.signature === 'object' ? entry.signature : entry;
      const validatorId = Number(source?.validatorId ?? entry?.validatorId);
      if (!Number.isInteger(validatorId) || validatorId < 0) {
        throw new Error(`Invalid validatorId at signature index ${index}`);
      }

      return {
        validatorId,
        timestamp: source?.timestamp || entry?.timestamp || new Date().toISOString(),
        signature: this.normalizeBlsHex(source?.signature, 48),
        publicKey: this.normalizeBlsHex(source?.publicKey, 96),
        messageHash: this.normalizeBlsHex(source?.messageHash, 32),
        scheme: source?.scheme || BLS_SIGNATURE_SCHEME,
        domain: source?.domain || BLS_DOMAIN_TAG,
        dataCommitment: this.normalizeBlsHex(
          source?.dataCommitment || crypto.createHash('sha256').update(`${validatorId}`).digest('hex'),
          32
        ),
      } as ValidatorBLSSignature;
    });

    normalized.sort((a, b) => a.validatorId - b.validatorId);
    const seenSignerIds = new Set<number>();
    for (const signer of normalized) {
      if (seenSignerIds.has(signer.validatorId)) {
        throw new Error(`Duplicate validator signer detected: ${signer.validatorId}`);
      }
      seenSignerIds.add(signer.validatorId);
    }

    const canonicalMessageHash = normalized[0].messageHash;
    for (const signer of normalized) {
      if (signer.messageHash !== canonicalMessageHash) {
        throw new Error(
          `BLS aggregate requires a single canonical message hash; signer ${signer.validatorId} does not match`
        );
      }

      if (signer.scheme !== BLS_SIGNATURE_SCHEME) {
        throw new Error(
          `Unsupported BLS signature scheme for signer ${signer.validatorId}: ${signer.scheme}`
        );
      }

      if (signer.domain !== BLS_DOMAIN_TAG) {
        throw new Error(
          `Unsupported BLS signature domain for signer ${signer.validatorId}: ${signer.domain}`
        );
      }
    }

    return normalized;
  }

  createSignatureBitmapData(
    validatorSignatures: Array<{ validatorId: number }>,
    validatorSetOverride?: number[]
  ): { bitmap: string; signerIds: number[]; validatorSet: number[] } {
    const signerIds = validatorSignatures
      .map(signature => Number(signature.validatorId))
      .sort((a, b) => a - b);

    const signerSet = new Set<number>();
    for (const signerId of signerIds) {
      if (!Number.isInteger(signerId) || signerId < 0) {
        throw new Error(`Invalid signer ID in bitmap generation: ${signerId}`);
      }
      if (signerSet.has(signerId)) {
        throw new Error(`Duplicate signer ID in bitmap generation: ${signerId}`);
      }
      signerSet.add(signerId);
    }

    const validatorSet =
      validatorSetOverride && validatorSetOverride.length > 0
        ? [...validatorSetOverride]
            .map(id => Number(id))
            .filter((id, idx, arr) => Number.isInteger(id) && id >= 0 && arr.indexOf(id) === idx)
            .sort((a, b) => a - b)
        : [
            ...new Set(
              [
                ...this.validators.map(v => Number(v.validatorId || v.id)),
                ...signerIds,
              ].filter(id => Number.isInteger(id) && id >= 0)
            ),
          ].sort((a, b) => a - b);

    if (validatorSet.length === 0) {
      throw new Error('Cannot build signature bitmap without validator set');
    }

    const validatorIndexMap = new Map<number, number>();
    validatorSet.forEach((validatorId, index) => {
      validatorIndexMap.set(validatorId, index);
    });

    const bitmap = new Uint8Array(Math.ceil(validatorSet.length / 8));
    for (const signerId of signerIds) {
      const validatorIndex = validatorIndexMap.get(signerId);
      if (validatorIndex === undefined) {
        throw new Error(`Signer ${signerId} is not present in validator set`);
      }
      const byteIndex = Math.floor(validatorIndex / 8);
      const bitIndex = validatorIndex % 8;
      bitmap[byteIndex] |= 1 << bitIndex;
    }

    return {
      bitmap: this.bytesToHex(bitmap),
      signerIds,
      validatorSet,
    };
  }

  /**
   * Create signature bitmap for BLS proof
   * @param {Array} validatorSignatures Array of validator signatures
   * @returns {string} Hexadecimal bitmap
   */
  createSignatureBitmap(validatorSignatures) {
    return this.createSignatureBitmapData(validatorSignatures).bitmap;
  }

  async verifyBLSAggregateProof(proof: Partial<BLSAggregateProof>): Promise<boolean> {
    try {
      const blsShortSigs = await this.getBLSSignatureSuite();
      const messageHash = this.normalizeBlsHex(proof.messageHash || '', 32);
      const aggregatedSignatureBytes = this.hexToBytes(
        proof.aggregatedSignature || '',
        48
      );
      const publicKeyBytes = (proof.publicKeys || []).map(publicKey =>
        this.hexToBytes(publicKey, 96)
      );
      const signerIds = (proof.signerIds || []).map(id => Number(id));
      const validatorSet = (proof.validatorSet || []).map(id => Number(id));
      if (publicKeyBytes.length === 0 || publicKeyBytes.length !== signerIds.length) {
        return false;
      }

      const expectedBitmap = this.createSignatureBitmapData(
        signerIds.map(validatorId => ({ validatorId })),
        validatorSet
      ).bitmap;
      const receivedBitmap = this.normalizeBlsHex(proof.bitmap || '');
      if (expectedBitmap !== receivedBitmap) {
        return false;
      }

      if (proof.serialization?.payload) {
        const payloadHash = crypto
          .createHash('sha256')
          .update(proof.serialization.payload)
          .digest('hex');
        if (proof.serialization.payloadHash !== payloadHash) {
          return false;
        }
      }

      const messagePoint = blsShortSigs.hash(Buffer.from(messageHash, 'hex'));
      const aggregatedPublicKey = blsShortSigs.aggregatePublicKeys(publicKeyBytes);
      return blsShortSigs.verify(
        aggregatedSignatureBytes,
        messagePoint,
        aggregatedPublicKey
      );
    } catch {
      return false;
    }
  }

  /**
   * Determine message priority based on response characteristics
   * @param {Object} response The oracle response
   * @returns {string} Priority level
   */
  determinePriority(response) {
    // Critical priority for high-value or time-sensitive responses
    if (
      response.confidence > 0.95 ||
      response.dataType === 'EMERGENCY_WEATHER'
    ) {
      return 'CRITICAL';
    }

    // High priority for important weather data
    if (response.confidence > 0.8 || response.dataType?.includes('SEVERE')) {
      return 'HIGH';
    }

    return 'NORMAL';
  }

  /**
   * Submit message with exponential backoff retry logic
   * @param {Object} adapter The bridge adapter
   * @param {Object} transaction The transaction object
   * @param {Object} retryConfig Retry configuration
   * @returns {Promise<Object>} Submission result
   */
  async submitWithRetryLogic(adapter, transaction, retryConfig) {
    const startTime = Date.now();
    let lastError;

    for (let attempt = 1; attempt <= retryConfig.maxRetries; attempt++) {
      try {
        crosschainLogger.info(
          `Bridge submission attempt ${attempt}/${retryConfig.maxRetries} for transaction ${transaction.id}`
        );

        const result = await (adapter as any).sendTransaction(transaction);

        // Success
        if (result.success) {
          const totalLatency = Date.now() - startTime;
          crosschainLogger.info(
            `Bridge submission successful on attempt ${attempt} (latency: ${totalLatency}ms)`
          );

          return {
            ...result,
            deliveryAttempts: attempt,
            totalLatencyMs: totalLatency,
            proofVerified: true, // Would be actual verification result
          };
        }

        lastError = new Error(result.error || 'Bridge submission failed');
      } catch (error) {
        lastError = error;
        crosschainLogger.warn(
          `Bridge submission attempt ${attempt} failed`,
          { error: (error as Error).message }
        );
      }

      // Wait before retry (exponential backoff with jitter)
      if (attempt < retryConfig.maxRetries) {
        const delay = Math.min(
          retryConfig.baseDelayMs *
            Math.pow(retryConfig.backoffMultiplier, attempt - 1),
          retryConfig.maxDelayMs
        );

        // Add jitter to prevent thundering herd
        const jitteredDelay = delay * (0.5 + Math.random() * 0.5);

        crosschainLogger.info(
          `Waiting ${Math.round(jitteredDelay)}ms before retry attempt ${attempt + 1}`
        );
        await new Promise(resolve => setTimeout(resolve, jitteredDelay));
      }
    }

    // All retries failed
    const totalLatency = Date.now() - startTime;
    crosschainLogger.error(
      `All ${retryConfig.maxRetries} bridge submission attempts failed`
    );

    return {
      success: false,
      error: lastError?.message || 'Maximum retry attempts exceeded',
      deliveryAttempts: retryConfig.maxRetries,
      totalLatencyMs: totalLatency,
      proofVerified: false,
    };
  }

  /**
   * Calculate message hash for deduplication
   * @param {Object} message The cross-chain message
   * @returns {string} Message hash
   */
  calculateMessageHash(message) {
    const hashData = {
      sourceChain: message.sourceChain,
      destinationChain: message.destinationChain,
      payloadHash: this.calculateResultHash(message.payload),
      timestamp: message.timestamp.toISOString(),
    };

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(hashData))
      .digest('hex');
  }

  /**
   * Calculate hash for oracle result data
   * @param {Object} data The data to hash
   * @returns {string} Data hash
   */
  calculateResultHash(data) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  /**
   * Update validator reputations based on data accuracy
   * @param {Array} validatorResponses Array of validator responses
   * @param {Object} consensusResult The consensus result
   * @returns {Promise<void>}
   */
  async updateValidatorReputations(validatorResponses, consensusResult) {
    // For each validator, calculate accuracy and update reputation
    for (const response of validatorResponses) {
      try {
        const accuracy = this.calculateValidatorAccuracy(
          response.data,
          consensusResult.data
        );

        // Get the validator participation record
        const [participation] = await db
          .select()
          .from(validatorOracleParticipation)
          .where(
            and(
              eq(
                validatorOracleParticipation.validatorId,
                response.validatorId
              ),
              eq(
                validatorOracleParticipation.requestId,
                validatorResponses[0].requestId
              )
            )
          );

        if (participation) {
          // Update participation record with accuracy
          await db
            .update(validatorOracleParticipation)
            .set({ accuracy })
            .where(eq(validatorOracleParticipation.id, participation.id));

          // Note: Validator data accuracy is tracked in the participation table
        }
      } catch (error) {
        logError(
          blockchainLogger,
          `Failed to update reputation for validator ${response.validatorId}`,
          error as Error
        );
      }
    }
  }

  /**
   * Calculate validator data accuracy compared to consensus
   * @param {Object} validatorData The validator data
   * @param {Object} consensusData The consensus data
   * @returns {number} Accuracy score (0-1)
   */
  calculateValidatorAccuracy(validatorData, consensusData) {
    const numericPaths = this.findNumericValuesAndPaths(consensusData);

    if (numericPaths.length === 0) return 1; // No numeric values to compare

    let totalAccuracy = 0;
    let comparisonCount = 0;

    for (const { path } of numericPaths) {
      const consensusValue = this.getValueAtPath(consensusData, path);
      const validatorValue = this.getValueAtPath(validatorData, path);

      if (
        typeof consensusValue !== 'number' ||
        typeof validatorValue !== 'number'
      ) {
        continue;
      }

      // Skip very small values to avoid division issues
      if (Math.abs(consensusValue) < 0.00001) continue;

      // Calculate accuracy as 1 - (relative deviation)
      const relativeDeviation =
        Math.abs(validatorValue - consensusValue) / Math.abs(consensusValue);
      const accuracy = Math.max(0, 1 - relativeDeviation);

      totalAccuracy += accuracy;
      comparisonCount++;
    }

    if (comparisonCount === 0) return 1;

    return totalAccuracy / comparisonCount;
  }

  /**
   * Poll for and process pending oracle requests
   * @returns {Promise<number>} Number of requests processed
   */
  async pollForRequests() {
    if (!this.isInitialized) {
      blockchainLogger.warn(
        'Cannot poll for requests, oracle network not initialized'
      );
      return 0;
    }

    try {
      // Get pending requests, prioritized by priority and creation time
      const pendingRequests = await db
        .select()
        .from(oracleRequests)
        .where(eq(oracleRequests.status, 'PENDING'))
        .limit(5); // Process up to 5 requests at a time

      if (pendingRequests.length === 0) {
        return 0;
      }

      blockchainLogger.info(
        `Processing ${pendingRequests.length} pending oracle requests`
      );

      // Process each request
      for (const request of pendingRequests) {
        try {
          await this.processOracleRequest(request);
        } catch (error) {
          logError(
            blockchainLogger,
            `Failed to process oracle request ${request.id}`,
            error as Error
          );
        }
      }

      return pendingRequests.length;
    } catch (error) {
      logError(blockchainLogger, 'Error polling for oracle requests', error as Error);
      return 0;
    }
  }

  /**
   * Get oracle network metrics
   * @returns {Promise<Object>} Network metrics
   */
  async getMetrics() {
    try {
      const [
        pendingRequests,
        processingRequests,
        completedRequests,
        errorRequests,
        readyResponses,
        deliveredResponses,
        errorResponses,
        activeBridges,
      ] = await Promise.all([
        db
          .select()
          .from(oracleRequests)
          .where(eq(oracleRequests.status, 'PENDING'))
          .then(r => r.length),
        db
          .select()
          .from(oracleRequests)
          .where(eq(oracleRequests.status, 'PROCESSING'))
          .then(r => r.length),
        db
          .select()
          .from(oracleRequests)
          .where(eq(oracleRequests.status, 'COMPLETED'))
          .then(r => r.length),
        db
          .select()
          .from(oracleRequests)
          .where(eq(oracleRequests.status, 'ERROR'))
          .then(r => r.length),
        db
          .select()
          .from(oracleResponses)
          .where(eq(oracleResponses.status, 'READY'))
          .then(r => r.length),
        db
          .select()
          .from(oracleResponses)
          .where(eq(oracleResponses.status, 'DELIVERED'))
          .then(r => r.length),
        db
          .select()
          .from(oracleResponses)
          .where(eq(oracleResponses.status, 'ERROR'))
          .then(r => r.length),
        db
          .select()
          .from(crossChainBridges)
          .where(eq(crossChainBridges.status, 'ACTIVE'))
          .then(r => r.length),
      ]);

      // Get statistics by data type
      const dataTypeStats = await db.execute(
        `SELECT data_type, COUNT(*) as count 
         FROM oracle_requests 
         GROUP BY data_type 
         ORDER BY count DESC`
      );

      // Get average confidence by data type
      const confidenceStats = await db.execute(
        `SELECT data_type, AVG(confidence) as avg_confidence 
         FROM oracle_responses 
         GROUP BY data_type
         ORDER BY data_type`
      );

      // Get validator participation stats
      const validatorStats = await db.execute(
        `SELECT validator_id, COUNT(*) as participation_count, AVG(accuracy) as avg_accuracy
         FROM validator_oracle_participation
         WHERE accuracy IS NOT NULL
         GROUP BY validator_id
         ORDER BY participation_count DESC
         LIMIT 10`
      );

      return {
        requests: {
          pending: Number(pendingRequests),
          processing: Number(processingRequests),
          completed: Number(completedRequests),
          error: Number(errorRequests),
          total:
            Number(pendingRequests) +
            Number(processingRequests) +
            Number(completedRequests) +
            Number(errorRequests),
        },
        responses: {
          ready: Number(readyResponses),
          delivered: Number(deliveredResponses),
          error: Number(errorResponses),
          total:
            Number(readyResponses) +
            Number(deliveredResponses) +
            Number(errorResponses),
        },
        bridges: {
          active: Number(activeBridges),
          total: Object.keys(this.bridgeAdapters).length,
        },
        validators: {
          active: this.validators.length,
          averageAccuracy:
            this.validators.reduce((sum, v) => sum + (v.accuracy || 0), 0) /
            Math.max(1, this.validators.length),
        },
        dataTypes: dataTypeStats,
        confidence: confidenceStats,
        topValidators: validatorStats,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      logError(blockchainLogger, 'Failed to get oracle network metrics', error as Error);

      // Return basic metrics on error
      return {
        requests: {
          pending: 0,
          processing: 0,
          completed: 0,
          error: 0,
          total: 0,
        },
        responses: {
          ready: 0,
          delivered: 0,
          error: 0,
          total: 0,
        },
        bridges: {
          active: 0,
          total: Object.keys(this.bridgeAdapters).length,
        },
        validators: {
          active: this.validators.length,
          averageAccuracy: 0,
        },
        error: error instanceof Error ? error.message : String(error),
        lastUpdated: new Date().toISOString(),
      };
    }
  }

  /**
   * Get the current status of the Oracle Network
   * @returns {string} 'online' if initialized, 'offline' otherwise
   */
  getNetworkStatus() {
    return this.isInitialized ? 'online' : 'offline';
  }

  /**
   * Get total data points processed by the network
   * @returns {Promise<number>} Total data points
   */
  async getTotalDataPoints() {
    try {
      // In production, this would query the database
      // For now, we'll return a mock value
      return 12487 + Math.floor(Math.random() * 1000);
    } catch (error) {
      logError(blockchainLogger, 'Failed to get total data points', error as Error);
      return 0;
    }
  }

  /**
   * Get average accuracy across all validators
   * @returns {Promise<number>} Average accuracy (0-1)
   */
  async getAverageAccuracy() {
    try {
      if (!this.validators || this.validators.length === 0) {
        return 0;
      }

      const sum = this.validators.reduce(
        (total, validator) => total + (validator.accuracy || 0),
        0
      );
      return sum / this.validators.length;
    } catch (error) {
      logError(blockchainLogger, 'Failed to calculate average accuracy', error as Error);
      return 0;
    }
  }

  /**
   * Get count of active validators
   * @returns {number} Count of active validators
   */
  getActiveValidatorCount() {
    return this.validators.filter(v => v.status === 'active').length;
  }

  /**
   * Get count of pending oracle requests
   * @returns {Promise<number>} Count of pending requests
   */
  async getPendingRequestCount() {
    try {
      // In production, this would query the database
      const count = this.requestProcessingQueue.length;
      return count;
    } catch (error) {
      logError(blockchainLogger, 'Failed to get pending request count', error as Error);
      return 0;
    }
  }

  /**
   * Get count of processed requests in the last 24 hours
   * @returns {Promise<number>} Count of processed requests
   */
  async getProcessedRequests24h() {
    try {
      // In production, this would query the database
      return 542 + Math.floor(Math.random() * 100); // Mock value for development
    } catch (error) {
      logError(blockchainLogger, 'Failed to get processed requests', error as Error);
      return 0;
    }
  }

  /**
   * Get detailed reputation data for a validator
   * @param {string} validatorId Validator ID
   * @returns {Promise<Object|null>} Reputation data object or null if not found
   */
  async getValidatorReputation(validatorId) {
    try {
      // This would normally query the database for detailed metrics

      // Find the validator
      const validator = this.validators.find(v => v.id === validatorId);
      if (!validator) {
        return null;
      }

      // Generate reputation data
      return {
        uptime: 0.96 + Math.random() * 0.04, // 96-100%
        consensusParticipation: 0.85 + Math.random() * 0.15, // 85-100%
        dataVarianceScore: 0.88 + Math.random() * 0.12, // 88-100%
        networkContribution: 0.75 + Math.random() * 0.25, // 75-100%
        anomalyDetection: 0.8 + Math.random() * 0.2, // 80-100%
        reputationScore: Math.min(
          0.98,
          ((validator.accuracy ?? validator.data_accuracy_score ?? 0.5) +
            validator.reliability) /
            2
        ), // Composite score
      };
    } catch (error) {
      logError(
        blockchainLogger,
        `Failed to get validator reputation for ID ${validatorId}`,
        error as Error
      );
      return null;
    }
  }

  /**
   * Get number of data points submitted by a validator
   * @param {string} validatorId Validator ID
   * @returns {Promise<number>} Number of data points
   */
  async getValidatorDataPoints(validatorId) {
    try {
      // In production, this would query the database
      return 1500 + Math.floor(Math.random() * 1500); // Mock value for development
    } catch (error) {
      logError(
        blockchainLogger,
        `Failed to get data points for validator ${validatorId}`,
        error as Error
      );
      return 0;
    }
  }

  /**
   * Get number of verified predictions made by a validator
   * @param {string} validatorId Validator ID
   * @returns {Promise<number>} Number of verified predictions
   */
  async getValidatorVerifiedPredictions(validatorId) {
    try {
      // In production, this would query the database
      return 500 + Math.floor(Math.random() * 500); // Mock value for development
    } catch (error) {
      logError(
        blockchainLogger,
        `Failed to get verified predictions for validator ${validatorId}`,
        error as Error
      );
      return 0;
    }
  }

  /**
   * Get validator history length in days
   * @param {string} validatorId Validator ID
   * @returns {Promise<number>} History length in days
   */
  async getValidatorHistoryLength(validatorId) {
    try {
      // In production, this would query the database
      return 30 + Math.floor(Math.random() * 90); // 1-3 months (mock value)
    } catch (error) {
      logError(
        blockchainLogger,
        `Failed to get history length for validator ${validatorId}`,
        error as Error
      );
      return 0;
    }
  }

  /**
   * Get validator specialties
   * @param {string} validatorId Validator ID
   * @returns {Promise<string[]>} Array of specialty names
   */
  async getValidatorSpecialties(validatorId) {
    try {
      // These would be retrieved from the database in production
      const allSpecialties = [
        'temperature',
        'precipitation',
        'humidity',
        'wind',
        'pressure',
        'air quality',
        'soil moisture',
        'radiation',
        'ice coverage',
        'sea level',
      ];

      // Randomly select 2-4 specialties for this validator
      const count = 2 + Math.floor(Math.random() * 3);
      const shuffled = [...allSpecialties].sort(() => 0.5 - Math.random());
      return shuffled.slice(0, count);
    } catch (error) {
      logError(
        blockchainLogger,
        `Failed to get specialties for validator ${validatorId}`,
        error as Error
      );
      return [];
    }
  }

  /**
   * Get bridge status for all cross-chain bridges
   * @returns {Promise<Array>} Array of bridge status objects
   */
  async getBridgeStatus() {
    try {
      // In production, this would query all bridge adapters
      // For now, we'll return enhanced mock bridge data with climate-specific details
      return [
        {
          id: 'bridge-1',
          name: 'Ethereum Climate Bridge',
          provider: 'LayerZero',
          status: 'online',
          sourceChain: 'wrfcoin',
          targetChain: 'ethereum',
          lastSync: new Date(Date.now() - 120000).toISOString(),
          transactionsLast24h: 142,
          totalDataPoints: 8756,
          latency: 2.3,
        },
        {
          id: 'bridge-2',
          name: 'Cosmos Weather Oracle',
          provider: 'IBC',
          status: 'online',
          sourceChain: 'wrfcoin',
          targetChain: 'cosmos-hub',
          lastSync: new Date(Date.now() - 300000).toISOString(),
          transactionsLast24h: 87,
          totalDataPoints: 5421,
          latency: 3.1,
        },
        {
          id: 'bridge-3',
          name: 'Avalanche Climate Data Feed',
          provider: 'Axelar',
          status: 'degraded',
          sourceChain: 'wrfcoin',
          targetChain: 'avalanche',
          lastSync: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
          transactionsLast24h: 51,
          totalDataPoints: 3218,
          latency: 4.2,
        },
        {
          id: 'bridge-4',
          name: 'Solana Weather Oracle',
          provider: 'Wormhole',
          status: 'offline',
          sourceChain: 'wrfcoin',
          targetChain: 'solana',
          lastSync: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
          transactionsLast24h: 0,
          totalDataPoints: 2987,
          latency: null,
        },
        {
          id: 'bridge-5',
          name: 'Polygon Climate Data Feed',
          provider: 'Polygon PoS Bridge',
          status: 'online',
          sourceChain: 'wrfcoin',
          targetChain: 'polygon',
          lastSync: new Date(Date.now() - 240000).toISOString(),
          transactionsLast24h: 94,
          totalDataPoints: 4623,
          latency: 2.8,
        },
      ];
    } catch (error) {
      logError(crosschainLogger, 'Failed to get bridge status', error as Error);
      return [];
    }
  }

  /**
   * Submit data to the oracle network for validation
   * @param {Object} data Data object to submit
   * @returns {Promise<Object>} Submission object
   */
  async submitData(data) {
    try {
      // In production, this would validate and store the data in the database

      const submission = {
        id: `sub-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`,
        timestamp: new Date().toISOString(),
        type: data.dataType,
        location: data.location,
        value: data.value,
        status: 'pending',
        confidence: 0,
        validations: 0,
        source: data.source || 'api',
      };

      blockchainLogger.info(`Data submission created: ${submission.id}`);

      return submission;
    } catch (error) {
      logError(blockchainLogger, 'Failed to submit data', error as Error);
      throw error;
    }
  }

  /**
   * Get oracle network status
   * @returns {Promise<Object>} The network status information
   */
  async getStatus() {
    try {
      // Get active validators count
      const activeValidators = this.validators.filter(
        v => v.status === 'ACTIVE'
      ).length;

      // Get bridge statuses (using the mock bridge adapters)
      const bridgeStatuses: Record<string, any> = {};
      let activeBridges = 0;

      for (const [bridgeId, adapter] of Object.entries(this.bridgeAdapters)) {
        try {
          const status = await (adapter as any).getStatus();
          bridgeStatuses[bridgeId] = status;
          if (status.status === 'active') {
            activeBridges++;
          }
        } catch (error) {
          logError(
            crosschainLogger,
            `Failed to get status for bridge ${bridgeId}`,
            error as Error
          );
          bridgeStatuses[bridgeId] = {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // Determine overall network health based on number of validators and bridges
      let networkHealth = 'healthy';

      if (activeValidators < 3) {
        networkHealth = 'warning';
      }

      if (activeValidators < 1) {
        networkHealth = 'critical';
      }

      // Mock request counts for demonstration
      const pendingRequests = Math.floor(Math.random() * 5);
      const processingRequests = Math.floor(Math.random() * 3);

      return {
        status: networkHealth,
        activeValidators,
        totalValidators: this.validators.length,
        pendingRequests,
        processingRequests,
        bridgeCount: Object.keys(this.bridgeAdapters).length,
        activeBridges,
        latency: Math.round(Math.random() * 500 + 200), // 200-700ms (simulated)
        uptime: '99.98%',
        lastUpdateTime: new Date().toISOString(),
      };
    } catch (error) {
      logError(blockchainLogger, 'Failed to get oracle network status', error as Error);
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        lastUpdateTime: new Date().toISOString(),
      };
    }
  }

  /**
   * Get recent data submissions from the oracle network
   * @param {number} limit Maximum number of submissions to return
   * @returns {Promise<Array>} Array of recent data submissions
   */
  async getRecentDataSubmissions(limit = 10) {
    try {
      // In a production system, we would query the database
      // For demonstration, we'll generate simulated data

      const dataTypes = [
        'TEMPERATURE',
        'PRECIPITATION',
        'HUMIDITY',
        'WIND',
        'AIR_QUALITY',
        'FORECAST',
      ];
      const statuses = ['VERIFIED', 'PENDING', 'REJECTED'];
      const submissions: Array<{
        id: string;
        validatorId: number;
        validatorName: string;
        dataType: string;
        submittedAt: string;
        status: string;
        confidenceScore: number;
        verificationCount: number;
      }> = [];

      for (let i = 0; i < limit; i++) {
        const validator =
          this.validators[Math.floor(Math.random() * this.validators.length)];
        const dataType =
          dataTypes[Math.floor(Math.random() * dataTypes.length)];
        const status = statuses[Math.floor(Math.random() * statuses.length)];

        submissions.push({
          id: `sub-${Math.random().toString(36).substring(2, 10)}`,
          validatorId: validator.id,
          validatorName: validator.name,
          dataType,
          submittedAt: new Date(
            Date.now() - Math.floor(Math.random() * 86400000)
          ).toISOString(), // Within last 24 hours
          status,
          confidenceScore: Math.floor(Math.random() * 30) + 70, // 70-99%
          verificationCount: Math.floor(Math.random() * 5) + 1, // 1-5 verifications
        });
      }

      // Sort by submitted time, most recent first
      submissions.sort(
        (a, b) =>
          new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
      );

      return submissions;
    } catch (error) {
      logError(blockchainLogger, 'Failed to get recent data submissions', error as Error);
      return [];
    }
  }
}

// This module uses ESM `import` syntax, so under the package's
// `"type": "module"` setting it is ESM-classified. A CommonJS
// `module.exports =` assignment is a no-op here and leaves the named
// export empty, which made `require('./climate-oracle-network')` return
// `{}` (and `new ClimateOracleNetwork()` throw "not a constructor") on the
// compiled prod build. Use a real ESM export so both `import` and
// Node's `require(esm)` interop expose the class. (#791)
export { ClimateOracleNetwork };
