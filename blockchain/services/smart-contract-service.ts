/**
 * Smart Contract Service
 * Task 76: Replace Mock Smart Contract API with Real Blockchain Integration
 *
 * Main orchestration service for all blockchain contract operations:
 * - Contract deployment with HSM-backed signing
 * - Contract function calls (read and write)
 * - Gas estimation
 * - Event retrieval
 * - Contract registry management
 */

import {
  Contract,
  ContractFactory,
  Interface,
  keccak256,
  toUtf8Bytes,
  formatUnits,
  parseUnits,
  type Provider,
} from 'ethers';
import { blockchainLogger, securityLogger } from '../../server/utils/logger.js';
import type {
  NetworkId,
  DeployedContract,
  DeployContractParams,
  DeployContractResult,
  CallContractParams,
  CallContractResult,
  ContractEvent,
  GetEventsParams,
  GasEstimateResult,
  EstimateGasParams,
  ServiceStatus,
  HSMCredentials,
} from '../types/index.js';
import { HSMSigner, HSMSessionManager, createHSMSigner } from '../signers/hsm-signer.js';
import { providerManager, MultiChainProviderManager } from '../providers/multi-chain-manager.js';
import { getDefaultNetworkId, USE_REAL_BLOCKCHAIN, getNetworkConfig } from '../config/networks.js';

/**
 * Main service for blockchain contract operations
 */
export class SmartContractService {
  /** HSM-backed signer for transactions */
  private signer: HSMSigner | null = null;

  /** Provider manager for multi-chain support */
  private providers: MultiChainProviderManager;

  /** Registry of deployed contracts */
  private contractRegistry: Map<string, DeployedContract> = new Map();

  /** ABI registry for external contracts */
  private abiRegistry: Map<string, object[]> = new Map();

  /** Whether the service has been initialized */
  private initialized = false;

  /** Default network for operations */
  private defaultNetwork: NetworkId;

  constructor() {
    this.providers = providerManager;
    this.defaultNetwork = getDefaultNetworkId();
  }

  /**
   * Initialize the service
   * Sets up HSM signer and provider manager
   */
  async initialize(credentials?: HSMCredentials): Promise<void> {
    if (this.initialized) {
      blockchainLogger.info('SmartContractService already initialized');
      return;
    }

    blockchainLogger.info('SmartContractService initializing');

    // Initialize provider manager
    await this.providers.initialize();

    // Initialize HSM signer
    const provider = await this.providers.getProvider(this.defaultNetwork);
    this.signer = await createHSMSigner(provider, credentials);

    this.initialized = true;
    blockchainLogger.info('SmartContractService initialized successfully');
  }

  /**
   * Ensure the service is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.signer) {
      throw new Error('SmartContractService not initialized. Call initialize() first.');
    }
  }

  /**
   * Get a signer connected to the specified network
   */
  private async getNetworkSigner(networkId: NetworkId): Promise<HSMSigner> {
    this.ensureInitialized();

    const provider = await this.providers.getProvider(networkId);
    return this.signer!.connect(provider);
  }

  /**
   * Deploy a smart contract to the blockchain
   * Uses HSM for transaction signing - private key never leaves HSM
   */
  async deployContract(params: DeployContractParams): Promise<DeployContractResult> {
    this.ensureInitialized();

    const networkId = params.networkId || this.defaultNetwork;
    blockchainLogger.info('Deploying contract', { networkId });

    const signer = await this.getNetworkSigner(networkId);
    const signerAddress = await signer.getAddress();

    try {
      // Create contract factory
      const factory = new ContractFactory(params.abi, params.bytecode, signer);

      // Deploy with constructor arguments
      const constructorArgs = params.constructorArgs || [];
      const deployOptions: { gasLimit?: bigint; value?: bigint } = {};

      if (params.gasLimit) {
        deployOptions.gasLimit = BigInt(params.gasLimit);
      }

      if (params.value) {
        deployOptions.value = BigInt(params.value);
      }

      blockchainLogger.info('Deploying from address', { signerAddress });
      const contract = await factory.deploy(...constructorArgs, deployOptions);

      // Wait for deployment
      const deploymentTx = contract.deploymentTransaction();
      if (!deploymentTx) {
        throw new Error('Deployment transaction not found');
      }

      blockchainLogger.info('Deployment transaction submitted', { txHash: deploymentTx.hash });
      await contract.waitForDeployment();

      const contractAddress = await contract.getAddress();
      const receipt = await deploymentTx.wait();

      if (!receipt) {
        throw new Error('Deployment receipt not found');
      }

      // Register the deployed contract
      const deployedContract: DeployedContract = {
        address: contractAddress,
        networkId,
        abi: params.abi,
        transactionHash: deploymentTx.hash,
        blockNumber: receipt.blockNumber,
        deployer: signerAddress,
        deployedAt: new Date().toISOString(),
        gasUsed: receipt.gasUsed.toString(),
        bytecode: params.bytecode,
        constructorArgs: params.constructorArgs,
        name: params.name,
      };

      this.contractRegistry.set(contractAddress.toLowerCase(), deployedContract);
      this.abiRegistry.set(contractAddress.toLowerCase(), params.abi);

      blockchainLogger.info('Contract deployed successfully', { contractAddress, networkId });

      return {
        success: true,
        contractAddress,
        transactionHash: deploymentTx.hash,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber,
        networkId,
      };
    } catch (error) {
      blockchainLogger.error('Contract deployment failed', {
        error: (error as Error).message,
        stack: (error as Error).stack,
        networkId,
      });
      throw error;
    }
  }

  /**
   * Call a contract function
   * Supports both read-only (view/pure) and state-changing calls
   */
  async callContract(params: CallContractParams): Promise<CallContractResult> {
    this.ensureInitialized();

    const networkId = params.networkId || this.defaultNetwork;
    const contractAddress = params.contractAddress.toLowerCase();

    // Get ABI from params or registry
    const abi = params.abi || this.abiRegistry.get(contractAddress);
    if (!abi) {
      throw new Error(
        `ABI not found for contract ${params.contractAddress}. Register it first or provide in params.`
      );
    }

    const iface = new Interface(abi);
    const fragment = iface.getFunction(params.functionName);
    if (!fragment) {
      throw new Error(`Function ${params.functionName} not found in contract ABI`);
    }

    const args = params.args || [];

    // Read-only calls use the provider directly
    if (params.isReadOnly || fragment.stateMutability === 'view' || fragment.stateMutability === 'pure') {
      return this.readContract(networkId, params.contractAddress, abi, params.functionName, args);
    }

    // State-changing calls use the signer
    return this.writeContract(networkId, params.contractAddress, abi, params.functionName, args, {
      gasLimit: params.gasLimit,
      value: params.value,
    });
  }

  /**
   * Read-only contract call (view/pure functions)
   */
  private async readContract(
    networkId: NetworkId,
    contractAddress: string,
    abi: object[],
    functionName: string,
    args: unknown[]
  ): Promise<CallContractResult> {
    const provider = await this.providers.getProvider(networkId);
    const contract = new Contract(contractAddress, abi, provider);

    try {
      const result = await contract[functionName](...args);
      return {
        success: true,
        result: this.formatResult(result),
      };
    } catch (error) {
      blockchainLogger.error('Read contract call failed', {
        error: (error as Error).message,
        functionName,
        contractAddress,
        networkId,
      });
      throw error;
    }
  }

  /**
   * State-changing contract call
   */
  private async writeContract(
    networkId: NetworkId,
    contractAddress: string,
    abi: object[],
    functionName: string,
    args: unknown[],
    options: { gasLimit?: number; value?: string }
  ): Promise<CallContractResult> {
    const signer = await this.getNetworkSigner(networkId);
    const contract = new Contract(contractAddress, abi, signer);

    try {
      const txOptions: { gasLimit?: bigint; value?: bigint } = {};
      if (options.gasLimit) {
        txOptions.gasLimit = BigInt(options.gasLimit);
      }
      if (options.value) {
        txOptions.value = BigInt(options.value);
      }

      const tx = await contract[functionName](...args, txOptions);
      blockchainLogger.info('Transaction submitted', { txHash: tx.hash, functionName });

      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error('Transaction receipt not found');
      }

      // Parse events from the transaction
      const events = this.parseTransactionEvents(receipt, abi);

      return {
        success: true,
        result: null,
        gasUsed: receipt.gasUsed.toString(),
        transactionHash: tx.hash,
        events,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      blockchainLogger.error('Write contract call failed', {
        component: 'smart-contract-service',
        functionName,
        contractAddress,
        networkId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Estimate gas for a contract operation
   */
  async estimateGas(params: EstimateGasParams): Promise<GasEstimateResult> {
    this.ensureInitialized();

    const networkId = params.networkId || this.defaultNetwork;
    const provider = await this.providers.getProvider(networkId);
    const signer = await this.getNetworkSigner(networkId);
    const signerAddress = await signer.getAddress();

    let gasEstimate: bigint;

    if (params.bytecode) {
      // Estimate deployment gas
      const factory = new ContractFactory(params.abi || [], params.bytecode, signer);
      const deployTx = await factory.getDeployTransaction(...(params.args || []));

      if (params.value) {
        deployTx.value = BigInt(params.value);
      }

      gasEstimate = await provider.estimateGas({
        ...deployTx,
        from: signerAddress,
      });
    } else if (params.contractAddress && params.functionName) {
      // Estimate call gas
      const abi = params.abi || this.abiRegistry.get(params.contractAddress.toLowerCase());
      if (!abi) {
        throw new Error('ABI required for gas estimation');
      }

      const contract = new Contract(params.contractAddress, abi, signer);
      const txData = contract.interface.encodeFunctionData(params.functionName, params.args || []);

      gasEstimate = await provider.estimateGas({
        to: params.contractAddress,
        data: txData,
        from: signerAddress,
        value: params.value ? BigInt(params.value) : undefined,
      });
    } else {
      throw new Error('Either bytecode or contractAddress/functionName required');
    }

    // Get gas price info
    const gasPriceInfo = await this.providers.getGasPrice(networkId);

    // Calculate estimated cost
    let estimatedCost: bigint;
    if (gasPriceInfo.isEip1559 && gasPriceInfo.maxFeePerGas) {
      estimatedCost = gasEstimate * gasPriceInfo.maxFeePerGas;
    } else if (gasPriceInfo.gasPrice) {
      estimatedCost = gasEstimate * gasPriceInfo.gasPrice;
    } else {
      estimatedCost = 0n;
    }

    const config = getNetworkConfig(networkId);

    return {
      gasEstimate: gasEstimate.toString(),
      gasPrice: gasPriceInfo.gasPrice?.toString() || '0',
      maxFeePerGas: gasPriceInfo.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: gasPriceInfo.maxPriorityFeePerGas?.toString(),
      estimatedCost: estimatedCost.toString(),
      networkId,
      isEip1559: gasPriceInfo.isEip1559,
    };
  }

  /**
   * Get contract events/logs
   */
  async getContractEvents(params: GetEventsParams): Promise<ContractEvent[]> {
    this.ensureInitialized();

    const networkId = params.networkId || this.defaultNetwork;
    const contractAddress = params.contractAddress.toLowerCase();

    // Get ABI from params or registry
    const abi = params.abi || this.abiRegistry.get(contractAddress);
    if (!abi) {
      throw new Error(
        `ABI not found for contract ${params.contractAddress}. Register it first or provide in params.`
      );
    }

    const iface = new Interface(abi);

    // Build filter
    const filter: {
      address: string;
      topics?: (string | string[] | null)[];
      fromBlock?: number | string;
      toBlock?: number | string;
    } = {
      address: params.contractAddress,
    };

    // Add event topic filter if specified
    if (params.eventName) {
      const eventFragment = iface.getEvent(params.eventName);
      if (eventFragment) {
        filter.topics = [eventFragment.topicHash];
      }
    }

    // Set block range
    if (params.fromBlock !== undefined) {
      filter.fromBlock =
        typeof params.fromBlock === 'string' ? params.fromBlock : params.fromBlock;
    }
    if (params.toBlock !== undefined) {
      filter.toBlock = typeof params.toBlock === 'string' ? params.toBlock : params.toBlock;
    }

    // Get logs from provider
    const logs = await this.providers.getLogs(networkId, filter);

    // Parse logs into events
    const events: ContractEvent[] = [];
    for (const log of logs) {
      try {
        const parsed = iface.parseLog({
          topics: log.topics,
          data: log.data,
        });

        if (parsed) {
          const args: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(parsed.args)) {
            // Skip numeric indices
            if (!/^\d+$/.test(key)) {
              args[key] = this.formatValue(value);
            }
          }

          events.push({
            event: parsed.name,
            address: log.address,
            args,
            topics: log.topics,
            data: log.data,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
          });
        }
      } catch {
        // Skip unparseable logs
        continue;
      }
    }

    return events;
  }

  /**
   * Register an ABI for an external contract
   */
  registerContractABI(address: string, abi: object[]): void {
    const normalizedAddress = address.toLowerCase();
    this.abiRegistry.set(normalizedAddress, abi);
    blockchainLogger.info('ABI registered', {
      component: 'smart-contract-service',
      address,
    });
  }

  /**
   * Get registered ABI for a contract
   */
  getContractABI(address: string): object[] | undefined {
    return this.abiRegistry.get(address.toLowerCase());
  }

  /**
   * Register a deployed contract
   */
  registerDeployedContract(contract: DeployedContract): void {
    const normalizedAddress = contract.address.toLowerCase();
    this.contractRegistry.set(normalizedAddress, contract);

    if (Array.isArray(contract.abi)) {
      this.abiRegistry.set(normalizedAddress, contract.abi);
    }

    blockchainLogger.info('Contract registered', {
      component: 'smart-contract-service',
      address: contract.address,
    });
  }

  /**
   * Get deployed contract info
   */
  getDeployedContract(address: string): DeployedContract | undefined {
    return this.contractRegistry.get(address.toLowerCase());
  }

  /**
   * List all tracked contracts
   */
  listContracts(): DeployedContract[] {
    return Array.from(this.contractRegistry.values());
  }

  /**
   * Get service status
   */
  async getStatus(): Promise<ServiceStatus> {
    const signerAddress = this.signer
      ? await this.signer.getAddress().catch(() => undefined)
      : undefined;

    const healthyNetworks = this.providers.getHealthyNetworks();

    return {
      initialized: this.initialized,
      hsmConnected: this.signer?.getStatus().initialized || false,
      hsmMode: USE_REAL_BLOCKCHAIN ? 'hardware' : 'mock',
      activeNetworks: healthyNetworks,
      contractCount: this.contractRegistry.size,
      signerAddress,
    };
  }

  /**
   * Get current block number for a network
   */
  async getBlockNumber(networkId?: NetworkId): Promise<number> {
    return this.providers.getBlockNumber(networkId || this.defaultNetwork);
  }

  /**
   * Wait for a transaction to be confirmed
   */
  async waitForTransaction(
    txHash: string,
    networkId?: NetworkId,
    confirmations?: number
  ): Promise<{
    blockNumber: number;
    status: number;
    gasUsed: bigint;
  }> {
    return this.providers.waitForTransaction(
      networkId || this.defaultNetwork,
      txHash,
      confirmations
    );
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    blockchainLogger.info('Shutting down service', {
      component: 'smart-contract-service',
    });

    if (this.signer) {
      await this.signer.shutdown();
    }

    await this.providers.shutdown();

    this.initialized = false;
    blockchainLogger.info('Shutdown complete', {
      component: 'smart-contract-service',
    });
  }

  /**
   * Parse events from a transaction receipt
   */
  private parseTransactionEvents(receipt: any, abi: object[]): ContractEvent[] {
    const iface = new Interface(abi);
    const events: ContractEvent[] = [];

    for (const log of receipt.logs || []) {
      try {
        const parsed = iface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });

        if (parsed) {
          const args: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(parsed.args)) {
            if (!/^\d+$/.test(key)) {
              args[key] = this.formatValue(value);
            }
          }

          events.push({
            event: parsed.name,
            address: log.address,
            args,
            topics: [...log.topics],
            data: log.data,
            blockNumber: receipt.blockNumber,
            transactionHash: receipt.hash,
            logIndex: log.index,
          });
        }
      } catch {
        continue;
      }
    }

    return events;
  }

  /**
   * Format a contract call result for JSON serialization
   */
  private formatResult(result: unknown): unknown {
    if (result === null || result === undefined) {
      return result;
    }

    if (typeof result === 'bigint') {
      return result.toString();
    }

    if (Array.isArray(result)) {
      // Check if it's a tuple with named properties
      const hasNamedProps = Object.keys(result).some((key) => !/^\d+$/.test(key));
      if (hasNamedProps) {
        const obj: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(result)) {
          if (!/^\d+$/.test(key)) {
            obj[key] = this.formatValue(value);
          }
        }
        return obj;
      }
      return result.map((item) => this.formatValue(item));
    }

    if (typeof result === 'object') {
      const formatted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result)) {
        formatted[key] = this.formatValue(value);
      }
      return formatted;
    }

    return result;
  }

  /**
   * Format a single value for JSON serialization
   */
  private formatValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.formatValue(item));
    }

    if (typeof value === 'object' && value !== null) {
      // Check for ethers Result/tuple
      if ('toArray' in value && typeof (value as any).toArray === 'function') {
        return this.formatResult(value);
      }

      const formatted: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        if (!/^\d+$/.test(key)) {
          formatted[key] = this.formatValue(val);
        }
      }
      return formatted;
    }

    return value;
  }
}

// Export singleton instance
export const smartContractService = new SmartContractService();
