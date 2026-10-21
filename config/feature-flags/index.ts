/**
 * Feature Flag Manager
 * Task 115.3: Feature Flag System
 *
 * Provides a lightweight, environment-aware feature flag system
 * for controlling feature availability across environments.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getEnvironment, type Environment } from '../environment.js';
import type {
  FeatureFlagDefinition,
  FeatureFlagsConfig,
  FeatureFlagValue,
  FeatureFlagManagerOptions,
  FlagEvaluationResult,
  FlagOverride,
  FlagAuditEntry,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Feature Flag Manager
// ============================================================================

export class FeatureFlagManager {
  private config: FeatureFlagsConfig;
  private environment: Environment;
  private overrides: Map<string, FlagOverride> = new Map();
  private auditLog: FlagAuditEntry[] = [];
  private options: Required<FeatureFlagManagerOptions>;

  constructor(
    environment?: Environment,
    options: FeatureFlagManagerOptions = {}
  ) {
    this.environment = environment || getEnvironment();
    this.options = {
      enableAuditLog: options.enableAuditLog ?? false,
      maxAuditLogSize: options.maxAuditLogSize ?? 1000,
      enableEnvVarOverrides: options.enableEnvVarOverrides ?? true,
      envVarPrefix: options.envVarPrefix ?? 'WRFCOIN_FLAG_',
      customConfig: options.customConfig ?? null as any,
    };

    this.config = this.options.customConfig || this.loadConfig();
  }

  /**
   * Load flags configuration from JSON file
   */
  private loadConfig(): FeatureFlagsConfig {
    try {
      const configPath = path.join(__dirname, 'flags.json');
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.warn('Failed to load feature flags config, using empty config');
      return {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        flags: {},
      };
    }
  }

  /**
   * Check if a boolean feature flag is enabled
   */
  isEnabled(flagName: string): boolean {
    const value = this.getValue(flagName);
    return Boolean(value);
  }

  /**
   * Get the value of a feature flag
   */
  getValue<T extends FeatureFlagValue = FeatureFlagValue>(flagName: string): T {
    const result = this.evaluate<T>(flagName);
    return result.value;
  }

  /**
   * Get detailed evaluation result for a flag
   */
  evaluate<T extends FeatureFlagValue = FeatureFlagValue>(
    flagName: string
  ): FlagEvaluationResult<T> {
    const definition = this.config.flags[flagName];

    if (!definition) {
      // Unknown flag - return false for booleans, empty string for strings, 0 for numbers
      const result: FlagEvaluationResult<T> = {
        flagName,
        value: false as T,
        source: 'default',
        deprecated: false,
        evaluatedAt: new Date(),
      };
      this.logAudit('evaluate', flagName, undefined, result.value);
      return result;
    }

    // Check for deprecation
    if (definition.deprecated) {
      console.warn(
        `Feature flag "${flagName}" is deprecated. ${definition.deprecationMessage || ''}`
      );
    }

    let value: FeatureFlagValue;
    let source: FlagEvaluationResult['source'];

    // Priority 1: Runtime overrides
    const override = this.overrides.get(flagName);
    if (override && (!override.expiresAt || override.expiresAt > new Date())) {
      value = override.value;
      source = 'override';
    }
    // Priority 2: Environment variable overrides
    else if (this.options.enableEnvVarOverrides) {
      const envVarName = `${this.options.envVarPrefix}${flagName.toUpperCase()}`;
      const envValue = process.env[envVarName];
      if (envValue !== undefined) {
        value = this.parseEnvValue(envValue, typeof definition.default);
        source = 'env_var';
      } else if (definition.environments?.[this.environment] !== undefined) {
        value = definition.environments[this.environment]!;
        source = 'environment';
      } else {
        value = definition.default;
        source = 'default';
      }
    }
    // Priority 3: Environment-specific value
    else if (definition.environments?.[this.environment] !== undefined) {
      value = definition.environments[this.environment]!;
      source = 'environment';
    }
    // Priority 4: Default value
    else {
      value = definition.default;
      source = 'default';
    }

    const result: FlagEvaluationResult<T> = {
      flagName,
      value: value as T,
      source,
      deprecated: definition.deprecated ?? false,
      evaluatedAt: new Date(),
    };

    this.logAudit('evaluate', flagName, undefined, value);
    return result;
  }

  /**
   * Set a runtime override for a flag
   */
  setOverride(
    flagName: string,
    value: FeatureFlagValue,
    options?: {
      expiresAt?: Date;
      setBy?: string;
      reason?: string;
    }
  ): void {
    const previousValue = this.getValue(flagName);

    const override: FlagOverride = {
      flagName,
      value,
      setAt: new Date(),
      setBy: options?.setBy,
      expiresAt: options?.expiresAt,
      reason: options?.reason,
    };

    this.overrides.set(flagName, override);
    this.logAudit('override', flagName, previousValue, value, options?.setBy);
  }

  /**
   * Clear a runtime override
   */
  clearOverride(flagName: string, clearedBy?: string): void {
    const previousValue = this.overrides.get(flagName)?.value;
    this.overrides.delete(flagName);
    this.logAudit('clear_override', flagName, previousValue, undefined, clearedBy);
  }

  /**
   * Clear all runtime overrides
   */
  clearAllOverrides(): void {
    this.overrides.clear();
  }

  /**
   * Get all flags with their current values
   */
  getAllFlags(): Record<string, FlagEvaluationResult> {
    const result: Record<string, FlagEvaluationResult> = {};

    for (const flagName of Object.keys(this.config.flags)) {
      result[flagName] = this.evaluate(flagName);
    }

    return result;
  }

  /**
   * Get flags by tag
   */
  getFlagsByTag(tag: string): Record<string, FlagEvaluationResult> {
    const result: Record<string, FlagEvaluationResult> = {};

    for (const [flagName, definition] of Object.entries(this.config.flags)) {
      if (definition.tags?.includes(tag)) {
        result[flagName] = this.evaluate(flagName);
      }
    }

    return result;
  }

  /**
   * Get flag definition
   */
  getDefinition(flagName: string): FeatureFlagDefinition | undefined {
    return this.config.flags[flagName];
  }

  /**
   * Check if a flag exists
   */
  hasFlag(flagName: string): boolean {
    return flagName in this.config.flags;
  }

  /**
   * Get the current environment
   */
  getEnvironment(): Environment {
    return this.environment;
  }

  /**
   * Get audit log entries
   */
  getAuditLog(limit?: number): FlagAuditEntry[] {
    if (limit) {
      return this.auditLog.slice(-limit);
    }
    return [...this.auditLog];
  }

  /**
   * Reload configuration from file
   */
  reload(): void {
    if (!this.options.customConfig) {
      this.config = this.loadConfig();
    }
  }

  /**
   * Parse environment variable value to appropriate type
   */
  private parseEnvValue(value: string, expectedType: string): FeatureFlagValue {
    switch (expectedType) {
      case 'boolean':
        return value.toLowerCase() === 'true' || value === '1';
      case 'number':
        const parsed = parseFloat(value);
        return isNaN(parsed) ? 0 : parsed;
      default:
        return value;
    }
  }

  /**
   * Log audit entry
   */
  private logAudit(
    action: FlagAuditEntry['action'],
    flagName: string,
    previousValue?: FeatureFlagValue,
    newValue?: FeatureFlagValue,
    actor?: string
  ): void {
    if (!this.options.enableAuditLog) {
      return;
    }

    const entry: FlagAuditEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      flagName,
      action,
      previousValue,
      newValue,
      source: this.environment,
      actor,
      timestamp: new Date(),
    };

    this.auditLog.push(entry);

    // Trim audit log if needed
    if (this.auditLog.length > this.options.maxAuditLogSize) {
      this.auditLog = this.auditLog.slice(-this.options.maxAuditLogSize);
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultInstance: FeatureFlagManager | null = null;

/**
 * Get the default feature flag manager instance
 */
export function getFeatureFlags(): FeatureFlagManager {
  if (!defaultInstance) {
    defaultInstance = new FeatureFlagManager();
  }
  return defaultInstance;
}

/**
 * Check if a feature flag is enabled (convenience function)
 */
export function isFeatureEnabled(flagName: string): boolean {
  return getFeatureFlags().isEnabled(flagName);
}

/**
 * Get a feature flag value (convenience function)
 */
export function getFeatureFlagValue<T extends FeatureFlagValue = FeatureFlagValue>(
  flagName: string
): T {
  return getFeatureFlags().getValue<T>(flagName);
}

// ============================================================================
// Exports
// ============================================================================

export { type FeatureFlagValue, type FeatureFlagDefinition, type FlagEvaluationResult } from './types.js';

export default getFeatureFlags();
