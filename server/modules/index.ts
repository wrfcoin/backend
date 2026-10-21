/**
 * Module Index
 *
 * TypeScript implementation providing centralized module exports
 * for the Wrfcoin blockchain platform.
 */

// Blockchain core modules
export {
  BlockchainCore,
  ConsensusModule,
  NetworkModule,
  blockchainCore,
  consensusModule,
  networkModule,
  type Block,
  type Transaction,
  type ChainState,
} from './blockchain_modules.js';

// Computational modules
export {
  computationalManager,
  type ComputationalNFT,
  type ExecutionResult,
  COMPUTATION_TYPES,
  RESOURCE_TIERS,
} from '../computational/manager.js';

// Utility modules
export {
  CryptoUtils,
  generateSecureHash,
  generateKeyPair,
  signData,
  verifySignature,
  encryptData,
  decryptData,
  type KeyPair,
  type SignatureResult,
  type EncryptionResult,
} from '../utils/crypto.js';

export {
  StorageProvider,
  DataStructures,
  HashAlgorithms,
  NetworkConfig,
  TokenConstants,
  WeatherConstants,
  ComputationalNFTConstants,
  APIConstants,
  BridgeConstants,
  ErrorCodes,
  StatusCodes,
  type StorageProviderType,
  type DataStructureType,
  type HashAlgorithmType,
  type ErrorCode,
} from '../utils/constants.js';

// Re-export default constants
export { default as Constants } from '../utils/constants.js';

/**
 * Module initialization and configuration
 */
export class ModuleManager {
  private static instance: ModuleManager;
  private modules: Map<string, any> = new Map();

  private constructor() {
    this.initializeModules();
  }

  public static getInstance(): ModuleManager {
    if (!ModuleManager.instance) {
      ModuleManager.instance = new ModuleManager();
    }
    return ModuleManager.instance;
  }

  private initializeModules(): void {
    // Import modules from their exports
    const {
      blockchainCore,
      consensusModule,
      networkModule,
    } = require('./blockchain_modules');
    const { computationalManager } = require('../computational/manager');
    const { CryptoUtils } = require('../utils/crypto');

    // Initialize core blockchain modules
    this.modules.set('blockchain', blockchainCore);
    this.modules.set('consensus', consensusModule);
    this.modules.set('network', networkModule);
    this.modules.set('computational', computationalManager);
    this.modules.set('crypto', CryptoUtils.getInstance());
  }

  public getModule(name: string): any {
    return this.modules.get(name);
  }

  public getAllModules(): Map<string, any> {
    return new Map(this.modules);
  }

  public getModuleStatus(): Record<string, string> {
    const status: Record<string, string> = {};

    for (const [name, module] of this.modules) {
      try {
        // Basic health check
        if (module && typeof module === 'object') {
          status[name] = 'active';
        } else {
          status[name] = 'inactive';
        }
      } catch (error) {
        status[name] = 'error';
      }
    }

    return status;
  }
}

// Export singleton instance
export const moduleManager = ModuleManager.getInstance();
