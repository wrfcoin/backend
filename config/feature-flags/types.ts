/**
 * Feature Flag Type Definitions
 * Task 115.3: Feature Flag System
 */

import type { Environment } from '../environment.js';

/**
 * Supported feature flag value types
 */
export type FeatureFlagValue = boolean | string | number;

/**
 * Feature flag definition with metadata
 */
export interface FeatureFlagDefinition {
  /** Flag description for documentation */
  description: string;
  /** Default value when no override exists */
  default: FeatureFlagValue;
  /** Override values per environment */
  environments?: Partial<Record<Environment, FeatureFlagValue>>;
  /** When the flag was introduced */
  since?: string;
  /** Owner/team responsible for this flag */
  owner?: string;
  /** Whether this flag is deprecated */
  deprecated?: boolean;
  /** Deprecation message */
  deprecationMessage?: string;
  /** Tags for categorization */
  tags?: string[];
}

/**
 * Feature flags configuration file structure
 */
export interface FeatureFlagsConfig {
  /** Configuration version */
  version: string;
  /** Last updated timestamp */
  lastUpdated: string;
  /** Flag definitions */
  flags: Record<string, FeatureFlagDefinition>;
}

/**
 * Runtime flag override (e.g., from API or database)
 */
export interface FlagOverride {
  /** Flag name */
  flagName: string;
  /** Override value */
  value: FeatureFlagValue;
  /** When the override was set */
  setAt: Date;
  /** Who set the override */
  setBy?: string;
  /** When the override expires (optional) */
  expiresAt?: Date;
  /** Reason for the override */
  reason?: string;
}

/**
 * Feature flag evaluation result with metadata
 */
export interface FlagEvaluationResult<T extends FeatureFlagValue = FeatureFlagValue> {
  /** Flag name */
  flagName: string;
  /** Evaluated value */
  value: T;
  /** Source of the value */
  source: 'default' | 'environment' | 'override' | 'env_var';
  /** Whether the flag is deprecated */
  deprecated: boolean;
  /** Evaluation timestamp */
  evaluatedAt: Date;
}

/**
 * Feature flag audit log entry
 */
export interface FlagAuditEntry {
  /** Unique entry ID */
  id: string;
  /** Flag name */
  flagName: string;
  /** Action performed */
  action: 'evaluate' | 'override' | 'clear_override' | 'deprecate';
  /** Previous value */
  previousValue?: FeatureFlagValue;
  /** New value */
  newValue?: FeatureFlagValue;
  /** Source of the change */
  source: string;
  /** User/service that triggered the action */
  actor?: string;
  /** Timestamp */
  timestamp: Date;
  /** Additional context */
  metadata?: Record<string, unknown>;
}

/**
 * Feature flag manager options
 */
export interface FeatureFlagManagerOptions {
  /** Enable audit logging */
  enableAuditLog?: boolean;
  /** Maximum audit log entries to keep */
  maxAuditLogSize?: number;
  /** Enable environment variable overrides */
  enableEnvVarOverrides?: boolean;
  /** Prefix for environment variable overrides */
  envVarPrefix?: string;
  /** Custom flags config (instead of loading from file) */
  customConfig?: FeatureFlagsConfig;
}

/**
 * Predefined flag categories
 */
export const FlagCategories = {
  EXPERIMENTAL: 'experimental',
  BETA: 'beta',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  DEFI: 'defi',
  AI_ML: 'ai-ml',
  IOT: 'iot',
  BLOCKCHAIN: 'blockchain',
} as const;

export type FlagCategory = (typeof FlagCategories)[keyof typeof FlagCategories];
