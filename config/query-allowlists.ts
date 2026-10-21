/**
 * Query Allowlists Configuration
 * Task 104.2: JSONB Query Path Allowlists
 *
 * Defines allowed JSONB paths per entity type to prevent
 * unauthorized access to sensitive data fields.
 */

// ============================================================================
// Weather Data Allowlists
// ============================================================================

/**
 * Allowed JSONB paths for weather measurement data
 */
export const WEATHER_MEASUREMENTS_PATHS = new Set([
  // Core measurements
  'temperature',
  'humidity',
  'pressure',
  'windSpeed',
  'windDirection',
  'precipitation',
  'visibility',
  'cloudCover',
  'dewPoint',
  'uvIndex',

  // Extended measurements
  'measurements.*',
  'measurements.temperature',
  'measurements.humidity',
  'measurements.pressure',
  'measurements.windSpeed',
  'measurements.windDirection',
  'measurements.precipitation',
  'measurements.visibility',
  'measurements.cloudCover',
  'measurements.dewPoint',
  'measurements.uvIndex',
  'measurements.soilTemperature',
  'measurements.soilMoisture',
  'measurements.airQualityIndex',
  'measurements.pm25',
  'measurements.pm10',
  'measurements.co2',
  'measurements.ozone',

  // Historical data
  'historicalData.*',
  'historicalData.daily.*',
  'historicalData.hourly.*',
  'historicalData.monthly.*',

  // Forecast data (read-only)
  'forecast.*',
  'forecast.temperature',
  'forecast.precipitation',
  'forecast.confidence',
]);

/**
 * Allowed JSONB paths for weather station metadata
 */
export const WEATHER_STATION_PATHS = new Set([
  // Location info
  'location.*',
  'location.latitude',
  'location.longitude',
  'location.elevation',
  'location.timezone',
  'location.region',
  'location.country',

  // Station config
  'config.sensorType',
  'config.calibrationDate',
  'config.measurementInterval',
  'config.dataFormat',

  // Status info
  'status.isOnline',
  'status.lastSeen',
  'status.batteryLevel',
  'status.signalStrength',

  // Metadata (non-sensitive)
  'metadata.name',
  'metadata.description',
  'metadata.tags',
  'metadata.owner',
]);

// ============================================================================
// Transaction Allowlists
// ============================================================================

/**
 * Allowed JSONB paths for transaction metadata
 */
export const TRANSACTION_METADATA_PATHS = new Set([
  // Chain information
  'metadata.chain',
  'metadata.chainId',
  'metadata.networkId',
  'metadata.blockNumber',
  'metadata.blockHash',
  'metadata.transactionIndex',

  // Status information
  'metadata.status',
  'metadata.confirmations',
  'metadata.gasUsed',
  'metadata.effectiveGasPrice',

  // Type information
  'metadata.type',
  'metadata.category',
  'metadata.protocol',

  // Timestamps
  'metadata.timestamp',
  'metadata.processedAt',
  'metadata.confirmedAt',

  // Cross-chain specific
  'metadata.sourceChain',
  'metadata.destinationChain',
  'metadata.bridgeId',
  'metadata.bridgeStatus',

  // Amounts and fees (non-sensitive aggregate data)
  'metadata.feeAmount',
  'metadata.feeCurrency',
]);

/**
 * Allowed JSONB paths for wallet transaction details
 */
export const WALLET_TRANSACTION_PATHS = new Set([
  // Transaction basics
  'details.type',
  'details.category',
  'details.memo',

  // Token info
  'details.tokenAddress',
  'details.tokenSymbol',
  'details.tokenDecimals',

  // NFT info
  'details.nftId',
  'details.nftCollection',
  'details.nftMetadata.name',
  'details.nftMetadata.description',
  'details.nftMetadata.image',
]);

// ============================================================================
// Governance Allowlists
// ============================================================================

/**
 * Allowed JSONB paths for governance vote data
 */
export const GOVERNANCE_VOTE_PATHS = new Set([
  // Vote information
  'vote_data.power',
  'vote_data.weight',
  'vote_data.delegated',
  'vote_data.timestamp',

  // Vote breakdown
  'vote_data.breakdown.*',
  'vote_data.breakdown.yes',
  'vote_data.breakdown.no',
  'vote_data.breakdown.abstain',

  // Delegation info
  'vote_data.delegatedFrom',
  'vote_data.delegationChain',
]);

/**
 * Allowed JSONB paths for governance proposal data
 */
export const GOVERNANCE_PROPOSAL_PATHS = new Set([
  // Proposal basics
  'proposal.title',
  'proposal.description',
  'proposal.category',
  'proposal.status',

  // Parameters
  'proposal.parameters.*',
  'proposal.parameters.quorum',
  'proposal.parameters.threshold',
  'proposal.parameters.votingPeriod',
  'proposal.parameters.executionDelay',

  // Timeline
  'proposal.timeline.created',
  'proposal.timeline.votingStart',
  'proposal.timeline.votingEnd',
  'proposal.timeline.executed',

  // Results
  'proposal.results.*',
  'proposal.results.totalVotes',
  'proposal.results.yesVotes',
  'proposal.results.noVotes',
  'proposal.results.abstainVotes',
  'proposal.results.quorumReached',
  'proposal.results.passed',

  // Execution
  'proposal.execution.target',
  'proposal.execution.calldata',
  'proposal.execution.value',
]);

// ============================================================================
// Carbon Credit Allowlists
// ============================================================================

/**
 * Allowed JSONB paths for carbon credit metadata
 */
export const CARBON_CREDIT_PATHS = new Set([
  // Credit information
  'credit.type',
  'credit.standard',
  'credit.vintage',
  'credit.projectId',
  'credit.methodology',

  // Verification
  'verification.status',
  'verification.verifier',
  'verification.date',
  'verification.certificateId',

  // Environmental impact
  'impact.co2Equivalent',
  'impact.projectType',
  'impact.country',
  'impact.sdgGoals',

  // Calculation details
  'calculation.method',
  'calculation.inputData.*',
  'calculation.emissionFactors.*',
  'calculation.uncertainty',
]);

// ============================================================================
// IoT Sensor Allowlists
// ============================================================================

/**
 * Allowed JSONB paths for IoT sensor data
 */
export const IOT_SENSOR_PATHS = new Set([
  // Sensor readings
  'readings.*',
  'readings.value',
  'readings.unit',
  'readings.timestamp',
  'readings.quality',

  // Sensor metadata
  'sensor.type',
  'sensor.manufacturer',
  'sensor.model',
  'sensor.accuracy',
  'sensor.range',

  // Calibration
  'calibration.lastDate',
  'calibration.nextDue',
  'calibration.offset',
  'calibration.factor',

  // Status
  'status.isActive',
  'status.batteryLevel',
  'status.errorCode',
  'status.firmware',
]);

// ============================================================================
// User Profile Allowlists (Limited - Privacy Focused)
// ============================================================================

/**
 * Allowed JSONB paths for user preferences (non-PII)
 */
export const USER_PREFERENCES_PATHS = new Set([
  // Display preferences
  'preferences.theme',
  'preferences.language',
  'preferences.timezone',
  'preferences.dateFormat',
  'preferences.numberFormat',

  // Notification settings
  'preferences.notifications.email',
  'preferences.notifications.push',
  'preferences.notifications.sms',

  // Dashboard settings
  'preferences.dashboard.layout',
  'preferences.dashboard.widgets',
  'preferences.dashboard.defaultView',

  // Privacy settings (non-sensitive flags)
  'preferences.privacy.showProfile',
  'preferences.privacy.showActivity',
]);

// ============================================================================
// System/Admin Allowlists
// ============================================================================

/**
 * Allowed JSONB paths for system configuration (admin only)
 */
export const SYSTEM_CONFIG_PATHS = new Set([
  // Feature flags
  'config.features.*',

  // Rate limits
  'config.rateLimits.*',

  // Service health
  'health.status',
  'health.latency',
  'health.uptime',
  'health.lastCheck',

  // Metrics (non-sensitive)
  'metrics.requestCount',
  'metrics.errorRate',
  'metrics.avgResponseTime',
]);

// ============================================================================
// Entity Type to Allowlist Mapping
// ============================================================================

/**
 * Maps entity types to their corresponding JSONB path allowlists
 */
export const ENTITY_ALLOWLISTS: Record<string, Set<string>> = {
  weather_measurements: WEATHER_MEASUREMENTS_PATHS,
  weather_station: WEATHER_STATION_PATHS,
  transaction: TRANSACTION_METADATA_PATHS,
  wallet_transaction: WALLET_TRANSACTION_PATHS,
  governance_vote: GOVERNANCE_VOTE_PATHS,
  governance_proposal: GOVERNANCE_PROPOSAL_PATHS,
  carbon_credit: CARBON_CREDIT_PATHS,
  iot_sensor: IOT_SENSOR_PATHS,
  user_preferences: USER_PREFERENCES_PATHS,
  system_config: SYSTEM_CONFIG_PATHS,
};

/**
 * Get the allowlist for a given entity type
 */
export function getEntityAllowlist(entityType: string): Set<string> | undefined {
  return ENTITY_ALLOWLISTS[entityType];
}

/**
 * Check if a path is allowed for a given entity type
 */
export function isPathAllowed(entityType: string, path: string): boolean {
  const allowlist = ENTITY_ALLOWLISTS[entityType];
  if (!allowlist) {
    return false;
  }

  // Direct match
  if (allowlist.has(path)) {
    return true;
  }

  // Check wildcard patterns
  for (const allowedPath of allowlist) {
    if (allowedPath.endsWith('.*')) {
      const prefix = allowedPath.slice(0, -2);
      if (path.startsWith(prefix + '.') || path === prefix) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get all paths for an entity type as an array (for documentation)
 */
export function getAllowedPathsArray(entityType: string): string[] {
  const allowlist = ENTITY_ALLOWLISTS[entityType];
  if (!allowlist) {
    return [];
  }
  return Array.from(allowlist).sort();
}

// ============================================================================
// Sensitive Path Blocklist
// ============================================================================

/**
 * Paths that should NEVER be accessible via JSONB queries
 * These are blocked regardless of allowlist configuration
 */
export const BLOCKED_PATHS = new Set([
  // Credentials and secrets
  'password',
  'passwordHash',
  'secret',
  'secretKey',
  'privateKey',
  'apiKey',
  'token',
  'accessToken',
  'refreshToken',
  'credentials',
  'auth',

  // PII fields
  'ssn',
  'socialSecurityNumber',
  'taxId',
  'nationalId',
  'passportNumber',
  'driverLicense',
  'creditCard',
  'bankAccount',

  // Internal system fields
  'internal.*',
  '_internal.*',
  '__internal.*',
  'system.secrets.*',
  'admin.credentials.*',
]);

/**
 * Check if a path is explicitly blocked
 */
export function isPathBlocked(path: string): boolean {
  const normalizedPath = path.toLowerCase();

  for (const blockedPath of BLOCKED_PATHS) {
    if (blockedPath.endsWith('.*')) {
      const prefix = blockedPath.slice(0, -2);
      if (normalizedPath.startsWith(prefix + '.') || normalizedPath === prefix) {
        return true;
      }
    } else if (normalizedPath === blockedPath || normalizedPath.includes('.' + blockedPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Comprehensive path check - must be allowed AND not blocked
 */
export function isPathAccessible(entityType: string, path: string): {
  accessible: boolean;
  reason?: string;
} {
  // First check blocklist
  if (isPathBlocked(path)) {
    return {
      accessible: false,
      reason: 'Path is explicitly blocked for security reasons',
    };
  }

  // Then check allowlist
  if (!isPathAllowed(entityType, path)) {
    return {
      accessible: false,
      reason: `Path is not in the allowlist for entity type "${entityType}"`,
    };
  }

  return { accessible: true };
}

// ============================================================================
// Export
// ============================================================================

export default {
  // Allowlists
  WEATHER_MEASUREMENTS_PATHS,
  WEATHER_STATION_PATHS,
  TRANSACTION_METADATA_PATHS,
  WALLET_TRANSACTION_PATHS,
  GOVERNANCE_VOTE_PATHS,
  GOVERNANCE_PROPOSAL_PATHS,
  CARBON_CREDIT_PATHS,
  IOT_SENSOR_PATHS,
  USER_PREFERENCES_PATHS,
  SYSTEM_CONFIG_PATHS,

  // Blocklist
  BLOCKED_PATHS,

  // Entity mapping
  ENTITY_ALLOWLISTS,

  // Functions
  getEntityAllowlist,
  isPathAllowed,
  getAllowedPathsArray,
  isPathBlocked,
  isPathAccessible,
};
