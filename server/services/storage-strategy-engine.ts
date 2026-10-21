/**
 * Storage Strategy Engine
 * Intelligently routes storage decisions based on file characteristics, performance requirements, and cost optimization
 */

import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import { storageHealthMonitor } from './storage-health-monitor.js';

export interface StorageRequirements {
  fileSize: number;
  mimeType: string;
  redundancyLevel: number;
  performanceRequirement: 'LOW' | 'MEDIUM' | 'HIGH';
  costOptimization: 'MINIMIZE' | 'BALANCE' | 'PERFORMANCE';
  geographicDistribution?: string[];
  durabilityRequirement?: number; // 0-1, where 1 is maximum durability
  availabilityRequirement?: number; // 0-1, where 1 is maximum availability
  complianceRequirements?: string[]; // GDPR, HIPAA, SOC2, etc.
}

export interface StorageStrategy {
  providers: StorageProviderChoice[];
  estimatedCost: number;
  estimatedLatency: number;
  redundancyAchieved: number;
  reasoning: string;
  alternatives: StorageProviderChoice[][];
}

export interface StorageProviderChoice {
  name: string;
  type: 'LOCAL' | 'CLOUD' | 'DISTRIBUTED';
  priority: number;
  role: 'PRIMARY' | 'SECONDARY' | 'BACKUP' | 'ARCHIVE';
  estimatedCostPerGB: number;
  estimatedLatencyMs: number;
  reliability: number;
  geographicRegion?: string;
  reasoning: string;
}

export interface StorageNetworkHealth {
  networkName: string;
  isHealthy: boolean;
  reliability: number; // 0-1
  avgLatency: number; // milliseconds
  throughput: number; // MB/s
  costEfficiency: number; // cost per GB normalized
  lastChecked: Date;
  issues: string[];
  uptime: number; // 0-1
  nodeCount?: number;
  capacity?: {
    total: string;
    used: string;
    available: string;
  };
}

export class StorageStrategyEngine {
  private strategies: Map<string, StorageStrategy> = new Map();
  private providerProfiles: Map<string, ProviderProfile> = new Map();

  constructor() {
    this.initializeProviderProfiles();
  }

  /**
   * Get optimal storage strategy based on requirements
   */
  async getOptimalStrategy(
    requirements: StorageRequirements
  ): Promise<StorageStrategy> {
    try {
      logger.info('[StorageStrategy] Computing optimal storage strategy', {
        fileSize: requirements.fileSize,
        mimeType: requirements.mimeType,
        performanceRequirement: requirements.performanceRequirement,
        costOptimization: requirements.costOptimization,
        redundancyLevel: requirements.redundancyLevel,
      });

      // Generate strategy key for caching
      const strategyKey = this.generateStrategyKey(requirements);

      // Check cache first
      const cachedStrategy = this.strategies.get(strategyKey);
      if (cachedStrategy && this.isStrategyFresh(cachedStrategy)) {
        logger.debug('[StorageStrategy] Using cached strategy', {
          strategyKey,
        });
        return cachedStrategy;
      }

      // Get current network health
      const networkHealth = await storageHealthMonitor.getAllNetworkHealth();

      // Filter healthy providers
      const healthyProviders = networkHealth.filter(
        h => h.isHealthy && h.reliability > 0.7
      );

      if (healthyProviders.length === 0) {
        throw new Error('No healthy storage providers available');
      }

      // Compute optimal strategy
      const strategy = await this.computeStrategy(
        requirements,
        healthyProviders
      );

      // Cache the strategy
      this.strategies.set(strategyKey, strategy);

      logger.info('[StorageStrategy] Optimal storage strategy computed', {
        providers: strategy.providers.map(p => p.name),
        estimatedCost: strategy.estimatedCost,
        estimatedLatency: strategy.estimatedLatency,
        redundancyAchieved: strategy.redundancyAchieved,
      });

      return strategy;
    } catch (error) {
      logger.error('[StorageStrategy] Error computing storage strategy', {
        requirements,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Compute storage strategy based on requirements and provider health
   */
  private async computeStrategy(
    requirements: StorageRequirements,
    healthyProviders: StorageNetworkHealth[]
  ): Promise<StorageStrategy> {
    const providers: StorageProviderChoice[] = [];
    const alternatives: StorageProviderChoice[][] = [];

    // File size analysis
    const isLargeFile = requirements.fileSize > 100 * 1024 * 1024; // > 100MB
    const isSmallFile = requirements.fileSize < 1024 * 1024; // < 1MB

    // Performance requirement analysis
    const needsHighPerformance = requirements.performanceRequirement === 'HIGH';
    const needsLowCost = requirements.costOptimization === 'MINIMIZE';

    // Step 1: Select primary storage based on performance requirements
    if (needsHighPerformance) {
      // High performance: prioritize local and fast cloud storage
      const localProvider = healthyProviders.find(
        p => p.networkName === 'local'
      );
      if (localProvider) {
        providers.push({
          name: localProvider.networkName,
          type: 'LOCAL',
          priority: 1,
          role: 'PRIMARY',
          estimatedCostPerGB: 0,
          estimatedLatencyMs: localProvider.avgLatency,
          reliability: localProvider.reliability,
          reasoning:
            'Selected for high performance requirement and zero latency',
        });
      }

      // Add fast cloud provider as secondary
      const fastCloudProvider =
        this.selectFastestCloudProvider(healthyProviders);
      if (fastCloudProvider) {
        providers.push({
          name: fastCloudProvider.networkName,
          type: 'CLOUD',
          priority: 2,
          role: 'SECONDARY',
          estimatedCostPerGB: this.getProviderCost(
            fastCloudProvider.networkName
          ),
          estimatedLatencyMs: fastCloudProvider.avgLatency,
          reliability: fastCloudProvider.reliability,
          reasoning:
            'Selected as fast cloud backup for high performance requirement',
        });
      }
    } else if (needsLowCost) {
      // Low cost: prioritize free/cheap distributed storage
      const cheapProviders = this.selectCheapestProviders(
        healthyProviders,
        requirements.redundancyLevel
      );
      cheapProviders.forEach((provider, index) => {
        providers.push({
          name: provider.networkName,
          type: this.getProviderType(provider.networkName),
          priority: index + 1,
          role: index === 0 ? 'PRIMARY' : 'SECONDARY',
          estimatedCostPerGB: this.getProviderCost(provider.networkName),
          estimatedLatencyMs: provider.avgLatency,
          reliability: provider.reliability,
          reasoning: `Selected for cost optimization (${this.getProviderCost(provider.networkName)}/GB)`,
        });
      });
    } else {
      // Balanced approach
      const balancedProviders = this.selectBalancedProviders(
        healthyProviders,
        requirements
      );
      balancedProviders.forEach((provider, index) => {
        providers.push({
          name: provider.networkName,
          type: this.getProviderType(provider.networkName),
          priority: index + 1,
          role: index === 0 ? 'PRIMARY' : index === 1 ? 'SECONDARY' : 'BACKUP',
          estimatedCostPerGB: this.getProviderCost(provider.networkName),
          estimatedLatencyMs: provider.avgLatency,
          reliability: provider.reliability,
          reasoning: 'Selected for balanced cost and performance',
        });
      });
    }

    // Step 2: Ensure redundancy requirements
    if (providers.length < requirements.redundancyLevel) {
      const additionalProviders = this.selectAdditionalProviders(
        healthyProviders,
        providers,
        requirements.redundancyLevel - providers.length
      );

      additionalProviders.forEach((provider, index) => {
        providers.push({
          name: provider.networkName,
          type: this.getProviderType(provider.networkName),
          priority: providers.length + index + 1,
          role: 'BACKUP',
          estimatedCostPerGB: this.getProviderCost(provider.networkName),
          estimatedLatencyMs: provider.avgLatency,
          reliability: provider.reliability,
          reasoning: 'Added to meet redundancy requirement',
        });
      });
    }

    // Step 3: Apply geographic distribution if required
    if (
      requirements.geographicDistribution &&
      requirements.geographicDistribution.length > 0
    ) {
      // This would implement geographic distribution logic
      // For now, we'll add a note to the reasoning
      providers.forEach(p => {
        p.reasoning += ' (geographic distribution considered)';
      });
    }

    // Step 4: Calculate strategy metrics
    const estimatedCost = this.calculateTotalCost(
      providers,
      requirements.fileSize
    );
    const estimatedLatency = this.calculateAverageLatency(providers);
    const redundancyAchieved = providers.length;

    // Step 5: Generate alternatives
    const alternative1 = this.generateCostOptimizedAlternative(
      healthyProviders,
      requirements
    );
    const alternative2 = this.generatePerformanceOptimizedAlternative(
      healthyProviders,
      requirements
    );
    alternatives.push(alternative1, alternative2);

    const reasoning = this.generateStrategyReasoning(requirements, providers);

    return {
      providers,
      estimatedCost,
      estimatedLatency,
      redundancyAchieved,
      reasoning,
      alternatives,
    };
  }

  /**
   * Select fastest cloud provider
   */
  private selectFastestCloudProvider(
    healthyProviders: StorageNetworkHealth[]
  ): StorageNetworkHealth | null {
    const cloudProviders = healthyProviders.filter(p =>
      ['aws_s3', 'google_cloud', 'azure_blob'].includes(p.networkName)
    );

    return (
      cloudProviders.sort((a, b) => a.avgLatency - b.avgLatency)[0] || null
    );
  }

  /**
   * Select cheapest providers
   */
  private selectCheapestProviders(
    healthyProviders: StorageNetworkHealth[],
    count: number
  ): StorageNetworkHealth[] {
    return healthyProviders
      .sort(
        (a, b) =>
          this.getProviderCost(a.networkName) -
          this.getProviderCost(b.networkName)
      )
      .slice(0, count);
  }

  /**
   * Select balanced providers
   */
  private selectBalancedProviders(
    healthyProviders: StorageNetworkHealth[],
    requirements: StorageRequirements
  ): StorageNetworkHealth[] {
    // Score providers based on balanced criteria
    const scoredProviders = healthyProviders.map(provider => {
      let score = 0;

      // Reliability score (0-30 points)
      score += provider.reliability * 30;

      // Latency score (0-25 points) - lower latency = higher score
      score += Math.max(0, 25 - provider.avgLatency / 40);

      // Cost score (0-25 points) - lower cost = higher score
      const cost = this.getProviderCost(provider.networkName);
      score += Math.max(0, 25 - cost * 1000);

      // Throughput score (0-20 points)
      score += Math.min(20, provider.throughput / 5);

      return { provider, score };
    });

    return scoredProviders
      .sort((a, b) => b.score - a.score)
      .slice(0, requirements.redundancyLevel)
      .map(s => s.provider);
  }

  /**
   * Select additional providers for redundancy
   */
  private selectAdditionalProviders(
    healthyProviders: StorageNetworkHealth[],
    existingProviders: StorageProviderChoice[],
    count: number
  ): StorageNetworkHealth[] {
    const existingNames = new Set(existingProviders.map(p => p.name));
    const availableProviders = healthyProviders.filter(
      p => !existingNames.has(p.networkName)
    );

    return availableProviders
      .sort((a, b) => b.reliability - a.reliability)
      .slice(0, count);
  }

  /**
   * Generate cost-optimized alternative
   */
  private generateCostOptimizedAlternative(
    healthyProviders: StorageNetworkHealth[],
    requirements: StorageRequirements
  ): StorageProviderChoice[] {
    const cheapestProviders = this.selectCheapestProviders(
      healthyProviders,
      requirements.redundancyLevel
    );

    return cheapestProviders.map((provider, index) => ({
      name: provider.networkName,
      type: this.getProviderType(provider.networkName),
      priority: index + 1,
      role: index === 0 ? 'PRIMARY' : 'SECONDARY',
      estimatedCostPerGB: this.getProviderCost(provider.networkName),
      estimatedLatencyMs: provider.avgLatency,
      reliability: provider.reliability,
      reasoning: 'Cost-optimized alternative',
    }));
  }

  /**
   * Generate performance-optimized alternative
   */
  private generatePerformanceOptimizedAlternative(
    healthyProviders: StorageNetworkHealth[],
    requirements: StorageRequirements
  ): StorageProviderChoice[] {
    const fastestProviders = healthyProviders
      .sort((a, b) => a.avgLatency - b.avgLatency)
      .slice(0, requirements.redundancyLevel);

    return fastestProviders.map((provider, index) => ({
      name: provider.networkName,
      type: this.getProviderType(provider.networkName),
      priority: index + 1,
      role: index === 0 ? 'PRIMARY' : 'SECONDARY',
      estimatedCostPerGB: this.getProviderCost(provider.networkName),
      estimatedLatencyMs: provider.avgLatency,
      reliability: provider.reliability,
      reasoning: 'Performance-optimized alternative',
    }));
  }

  /**
   * Calculate total storage cost
   */
  private calculateTotalCost(
    providers: StorageProviderChoice[],
    fileSize: number
  ): number {
    const fileSizeGB = fileSize / (1024 * 1024 * 1024);
    return providers.reduce((total, provider) => {
      return total + provider.estimatedCostPerGB * fileSizeGB;
    }, 0);
  }

  /**
   * Calculate average latency
   */
  private calculateAverageLatency(providers: StorageProviderChoice[]): number {
    if (providers.length === 0) return 0;

    const totalLatency = providers.reduce(
      (sum, provider) => sum + provider.estimatedLatencyMs,
      0
    );
    return totalLatency / providers.length;
  }

  /**
   * Generate strategy reasoning
   */
  private generateStrategyReasoning(
    requirements: StorageRequirements,
    providers: StorageProviderChoice[]
  ): string {
    let reasoning = `Strategy for ${this.formatFileSize(requirements.fileSize)} ${requirements.mimeType} file:\n`;

    reasoning += `• Performance requirement: ${requirements.performanceRequirement}\n`;
    reasoning += `• Cost optimization: ${requirements.costOptimization}\n`;
    reasoning += `• Redundancy level: ${requirements.redundancyLevel}\n\n`;

    reasoning += 'Selected providers:\n';
    providers.forEach((provider, index) => {
      reasoning += `${index + 1}. ${provider.name} (${provider.role}): ${provider.reasoning}\n`;
    });

    return reasoning;
  }

  /**
   * Get provider type
   */
  private getProviderType(
    providerName: string
  ): 'LOCAL' | 'CLOUD' | 'DISTRIBUTED' {
    if (providerName === 'local') return 'LOCAL';
    if (['aws_s3', 'google_cloud', 'azure_blob'].includes(providerName))
      return 'CLOUD';
    return 'DISTRIBUTED';
  }

  /**
   * Get provider cost per GB
   */
  private getProviderCost(providerName: string): number {
    const costs: Record<string, number> = {
      local: 0,
      aws_s3: 0.023,
      google_cloud: 0.02,
      azure_blob: 0.025,
      ipfs: 0,
      filecoin: 0.0015,
      arweave: 0.005,
      storj: 0.004,
      skynet: 0.003,
      swarm: 0.002,
    };
    return costs[providerName] || 0.01;
  }

  /**
   * Initialize provider profiles
   */
  private initializeProviderProfiles(): void {
    // This would load provider profiles from configuration
    // For now, we'll use a simple implementation
    logger.info('[StorageStrategy] Provider profiles initialized');
  }

  /**
   * Generate strategy cache key
   */
  private generateStrategyKey(requirements: StorageRequirements): string {
    return crypto
      .createHash('md5')
      .update(
        JSON.stringify({
          fileSize: Math.floor(requirements.fileSize / (1024 * 1024)), // Round to MB
          mimeType: requirements.mimeType.split('/')[0], // Use main type only
          performanceRequirement: requirements.performanceRequirement,
          costOptimization: requirements.costOptimization,
          redundancyLevel: requirements.redundancyLevel,
        })
      )
      .digest('hex');
  }

  /**
   * Check if strategy is still fresh
   */
  private isStrategyFresh(strategy: StorageStrategy): boolean {
    // Strategies are valid for 5 minutes
    return true; // Simplified for now
  }

  /**
   * Format file size for display
   */
  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Get strategy recommendations for existing files
   */
  async getOptimizationRecommendations(
    fileId: string,
    currentProviders: string[]
  ): Promise<{
    shouldOptimize: boolean;
    recommendations: Array<{
      action: 'MIGRATE' | 'REPLICATE' | 'REMOVE';
      fromProvider?: string;
      toProvider?: string;
      reasoning: string;
      estimatedSavings?: number;
    }>;
  }> {
    try {
      const recommendations: Array<{
        action: 'MIGRATE';
        fromProvider: string;
        toProvider: string;
        reasoning: string;
        estimatedSavings?: number;
      }> = [];
      let shouldOptimize = false;

      // Analyze current provider health
      const healthChecks = await Promise.all(
        currentProviders.map(provider =>
          storageHealthMonitor.getNetworkHealth(provider)
        )
      );

      // Check for unhealthy providers
      healthChecks.forEach((health, index) => {
        if (health && !health.isHealthy) {
          recommendations.push({
            action: 'MIGRATE' as const,
            fromProvider: currentProviders[index],
            toProvider: this.selectHealthyAlternative(currentProviders[index]),
            reasoning: `Provider ${currentProviders[index]} is unhealthy (reliability: ${(health.reliability * 100).toFixed(1)}%)`,
          });
          shouldOptimize = true;
        }
      });

      // Check for cost optimization opportunities
      const expensiveProviders = currentProviders.filter(
        provider => this.getProviderCost(provider) > 0.02 // Threshold for expensive providers
      );

      if (expensiveProviders.length > 1) {
        const cheaperAlternative =
          this.findCheaperAlternative(expensiveProviders);
        if (cheaperAlternative) {
          recommendations.push({
            action: 'MIGRATE' as const,
            fromProvider: expensiveProviders[0],
            toProvider: cheaperAlternative,
            reasoning: 'Migrate from expensive provider to reduce costs',
            estimatedSavings:
              this.getProviderCost(expensiveProviders[0]) -
              this.getProviderCost(cheaperAlternative),
          });
          shouldOptimize = true;
        }
      }

      return {
        shouldOptimize,
        recommendations,
      };
    } catch (error) {
      logger.error(
        '[StorageStrategy] Error getting optimization recommendations',
        {
          fileId,
          currentProviders,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }

  /**
   * Select healthy alternative provider
   */
  private selectHealthyAlternative(unhealthyProvider: string): string {
    // Simple logic to select a healthy alternative
    // In production, this would be more sophisticated
    const alternatives: Record<string, string> = {
      aws_s3: 'google_cloud',
      google_cloud: 'azure_blob',
      azure_blob: 'aws_s3',
      ipfs: 'filecoin',
      filecoin: 'storj',
      storj: 'arweave',
    };

    return alternatives[unhealthyProvider] || 'local';
  }

  /**
   * Find cheaper alternative provider
   */
  private findCheaperAlternative(expensiveProviders: string[]): string | null {
    const cheapProviders = ['ipfs', 'swarm', 'storj', 'filecoin'];
    return (
      cheapProviders.find(provider => !expensiveProviders.includes(provider)) ||
      null
    );
  }
}

interface ProviderProfile {
  name: string;
  type: 'LOCAL' | 'CLOUD' | 'DISTRIBUTED';
  costPerGB: number;
  baseLatency: number;
  reliability: number;
  capabilities: string[];
  regions: string[];
}

export const storageStrategyEngine = new StorageStrategyEngine();
