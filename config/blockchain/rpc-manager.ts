/**
 * Blockchain RPC Manager
 * Task 115.4: Centralized RPC Endpoint Management with Failover Support
 *
 * Provides a unified interface for managing blockchain RPC connections
 * with automatic failover, health checking, and load balancing.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getEnvironment, type Environment } from '../environment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Types
// ============================================================================

export type NetworkType = 'mainnet' | 'testnet' | 'devnet';

export interface NetworkEndpoint {
  primary: string;
  fallback: string[];
  explorer?: string;
  name?: string;
  chainId?: number;
}

export interface ChainConfig {
  name: string;
  chainId: number;
  nativeCurrency: string;
  mainnet: NetworkEndpoint;
  testnet?: NetworkEndpoint;
  devnet?: NetworkEndpoint;
}

export interface BridgeProtocolConfig {
  mainnet: {
    api: string;
    scanner?: string;
    guardian?: string;
  };
  testnet: {
    api: string;
    scanner?: string;
    guardian?: string;
  };
}

export interface RPCEndpointsConfig {
  version: string;
  lastUpdated: string;
  chains: Record<string, ChainConfig>;
  bridgeProtocols: Record<string, BridgeProtocolConfig>;
}

export interface RPCManagerOptions {
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Delay between retries in milliseconds */
  retryDelay?: number;
  /** Enable health checking */
  enableHealthCheck?: boolean;
  /** Health check interval in milliseconds */
  healthCheckInterval?: number;
  /** Custom endpoint overrides */
  customEndpoints?: Record<string, string>;
}

export interface EndpointHealth {
  endpoint: string;
  isHealthy: boolean;
  latency: number;
  lastChecked: Date;
  consecutiveFailures: number;
  blockNumber?: number;
}

// ============================================================================
// RPC Manager
// ============================================================================

export class RPCManager {
  private config: RPCEndpointsConfig;
  private networkType: NetworkType;
  private options: Required<RPCManagerOptions>;
  private endpointHealth: Map<string, EndpointHealth> = new Map();
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private currentEndpointIndex: Map<string, number> = new Map();

  constructor(networkType?: NetworkType, options: RPCManagerOptions = {}) {
    // Determine network type from environment
    const environment = getEnvironment();
    this.networkType =
      networkType ||
      (environment === 'production' ? 'mainnet' : 'testnet');

    this.options = {
      timeout: options.timeout ?? 30000,
      maxRetries: options.maxRetries ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      enableHealthCheck: options.enableHealthCheck ?? false,
      healthCheckInterval: options.healthCheckInterval ?? 60000,
      customEndpoints: options.customEndpoints ?? {},
    };

    this.config = this.loadConfig();

    if (this.options.enableHealthCheck) {
      this.startHealthChecks();
    }
  }

  /**
   * Load RPC endpoints configuration
   */
  private loadConfig(): RPCEndpointsConfig {
    try {
      const configPath = path.join(__dirname, 'rpc-endpoints.json');
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.warn('Failed to load RPC endpoints config, using empty config');
      return {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        chains: {},
        bridgeProtocols: {},
      };
    }
  }

  /**
   * Resolve environment variables in endpoint URLs
   */
  private resolveEndpoint(endpoint: string): string {
    // Check for custom override first
    if (this.options.customEndpoints[endpoint]) {
      return this.options.customEndpoints[endpoint];
    }

    // Replace ${VAR_NAME} patterns with environment variables
    return endpoint.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = process.env[varName];
      if (!value) {
        console.warn(`Environment variable ${varName} not set for RPC endpoint`);
        return '';
      }
      return value;
    });
  }

  /**
   * Get RPC endpoint for a chain
   */
  getEndpoint(chainName: string): string {
    const chain = this.config.chains[chainName.toLowerCase()];
    if (!chain) {
      throw new Error(`Unknown chain: ${chainName}`);
    }

    const networkConfig = chain[this.networkType];
    if (!networkConfig) {
      throw new Error(`No ${this.networkType} configuration for chain: ${chainName}`);
    }

    // Try primary endpoint first
    const primary = this.resolveEndpoint(networkConfig.primary);
    if (primary && this.isEndpointHealthy(primary)) {
      return primary;
    }

    // Try fallback endpoints
    for (const fallback of networkConfig.fallback) {
      const resolved = this.resolveEndpoint(fallback);
      if (resolved && this.isEndpointHealthy(resolved)) {
        return resolved;
      }
    }

    // Return primary even if unhealthy (caller can handle errors)
    return primary || this.resolveEndpoint(networkConfig.fallback[0]) || '';
  }

  /**
   * Get all available endpoints for a chain (for load balancing)
   */
  getAllEndpoints(chainName: string): string[] {
    const chain = this.config.chains[chainName.toLowerCase()];
    if (!chain) {
      return [];
    }

    const networkConfig = chain[this.networkType];
    if (!networkConfig) {
      return [];
    }

    const endpoints: string[] = [];
    const primary = this.resolveEndpoint(networkConfig.primary);
    if (primary) {
      endpoints.push(primary);
    }

    for (const fallback of networkConfig.fallback) {
      const resolved = this.resolveEndpoint(fallback);
      if (resolved) {
        endpoints.push(resolved);
      }
    }

    return endpoints;
  }

  /**
   * Get next endpoint using round-robin selection
   */
  getNextEndpoint(chainName: string): string {
    const endpoints = this.getAllEndpoints(chainName);
    if (endpoints.length === 0) {
      throw new Error(`No endpoints available for chain: ${chainName}`);
    }

    const currentIndex = this.currentEndpointIndex.get(chainName) || 0;
    const nextIndex = (currentIndex + 1) % endpoints.length;
    this.currentEndpointIndex.set(chainName, nextIndex);

    return endpoints[nextIndex];
  }

  /**
   * Get a healthy endpoint with automatic failover
   */
  async getHealthyEndpoint(chainName: string): Promise<string> {
    const endpoints = this.getAllEndpoints(chainName);

    for (const endpoint of endpoints) {
      const health = this.endpointHealth.get(endpoint);
      if (!health || health.isHealthy) {
        // Check health if not already known
        if (!health) {
          const isHealthy = await this.checkEndpointHealth(endpoint);
          if (isHealthy) {
            return endpoint;
          }
        } else {
          return endpoint;
        }
      }
    }

    // All endpoints are unhealthy, return the first one anyway
    console.warn(`All endpoints for ${chainName} appear unhealthy, using first available`);
    return endpoints[0] || '';
  }

  /**
   * Get chain configuration
   */
  getChainConfig(chainName: string): ChainConfig | undefined {
    return this.config.chains[chainName.toLowerCase()];
  }

  /**
   * Get bridge protocol configuration
   */
  getBridgeProtocolConfig(protocolName: string): BridgeProtocolConfig | undefined {
    return this.config.bridgeProtocols[protocolName.toLowerCase()];
  }

  /**
   * Get bridge API endpoint
   */
  getBridgeEndpoint(protocolName: string): string {
    const protocol = this.config.bridgeProtocols[protocolName.toLowerCase()];
    if (!protocol) {
      throw new Error(`Unknown bridge protocol: ${protocolName}`);
    }

    const networkConfig = protocol[this.networkType === 'devnet' ? 'testnet' : this.networkType];
    return networkConfig?.api || '';
  }

  /**
   * Get chain explorer URL
   */
  getExplorerUrl(chainName: string): string {
    const chain = this.config.chains[chainName.toLowerCase()];
    if (!chain) {
      return '';
    }

    const networkConfig = chain[this.networkType];
    return networkConfig?.explorer || '';
  }

  /**
   * Check if an endpoint is healthy
   */
  private isEndpointHealthy(endpoint: string): boolean {
    const health = this.endpointHealth.get(endpoint);
    if (!health) {
      return true; // Assume healthy if not checked yet
    }
    return health.isHealthy;
  }

  /**
   * Check endpoint health
   */
  private async checkEndpointHealth(endpoint: string): Promise<boolean> {
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.options.timeout);

      // Simple JSON-RPC health check
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const latency = Date.now() - startTime;
      const data = await response.json() as { result?: string };

      const health: EndpointHealth = {
        endpoint,
        isHealthy: response.ok && data.result !== undefined,
        latency,
        lastChecked: new Date(),
        consecutiveFailures: 0,
        blockNumber: data.result ? parseInt(data.result, 16) : undefined,
      };

      this.endpointHealth.set(endpoint, health);
      return health.isHealthy;
    } catch (error) {
      const latency = Date.now() - startTime;
      const existingHealth = this.endpointHealth.get(endpoint);

      const health: EndpointHealth = {
        endpoint,
        isHealthy: false,
        latency,
        lastChecked: new Date(),
        consecutiveFailures: (existingHealth?.consecutiveFailures || 0) + 1,
      };

      this.endpointHealth.set(endpoint, health);
      return false;
    }
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      const allEndpoints = new Set<string>();

      // Collect all endpoints
      for (const chain of Object.values(this.config.chains)) {
        const networkConfig = chain[this.networkType];
        if (networkConfig) {
          const primary = this.resolveEndpoint(networkConfig.primary);
          if (primary) allEndpoints.add(primary);

          for (const fallback of networkConfig.fallback) {
            const resolved = this.resolveEndpoint(fallback);
            if (resolved) allEndpoints.add(resolved);
          }
        }
      }

      // Check health of all endpoints
      for (const endpoint of allEndpoints) {
        await this.checkEndpointHealth(endpoint);
      }
    }, this.options.healthCheckInterval);
  }

  /**
   * Stop health checks
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Get health status of all endpoints
   */
  getHealthStatus(): Map<string, EndpointHealth> {
    return new Map(this.endpointHealth);
  }

  /**
   * Get supported chains
   */
  getSupportedChains(): string[] {
    return Object.keys(this.config.chains);
  }

  /**
   * Get supported bridge protocols
   */
  getSupportedBridgeProtocols(): string[] {
    return Object.keys(this.config.bridgeProtocols);
  }

  /**
   * Get current network type
   */
  getNetworkType(): NetworkType {
    return this.networkType;
  }

  /**
   * Set network type
   */
  setNetworkType(networkType: NetworkType): void {
    this.networkType = networkType;
  }

  /**
   * Reload configuration
   */
  reload(): void {
    this.config = this.loadConfig();
    this.endpointHealth.clear();
    this.currentEndpointIndex.clear();
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultInstance: RPCManager | null = null;

/**
 * Get the default RPC manager instance
 */
export function getRPCManager(): RPCManager {
  if (!defaultInstance) {
    defaultInstance = new RPCManager();
  }
  return defaultInstance;
}

/**
 * Get RPC endpoint for a chain (convenience function)
 */
export function getRPCEndpoint(chainName: string): string {
  return getRPCManager().getEndpoint(chainName);
}

/**
 * Get all RPC endpoints for a chain (convenience function)
 */
export function getAllRPCEndpoints(chainName: string): string[] {
  return getRPCManager().getAllEndpoints(chainName);
}

// ============================================================================
// Exports
// ============================================================================

export default getRPCManager();
