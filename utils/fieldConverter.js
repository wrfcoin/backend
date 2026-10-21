/**
 * Wrfcoin Core Field Converter
 *
 * Utilities for converting between database field names (snake_case) and
 * application field names (camelCase), with special handling for specific field mappings.
 */

/**
 * Convert snake_case database field names to camelCase application field names
 * with special handling for specific field mappings
 *
 * @param {Object} dbObject - Database object with snake_case field names
 * @returns {Object} Application object with camelCase field names
 */
function dbToApp(dbObject) {
  if (!dbObject) return null;

  const appObject = {};

  // Field name mapping from db to app (for special cases)
  const fieldMapping = {
    // Computational NFTs fields - db values on left, app values on right
    // We now use name consistently in both DB and application
    computation_type: 'computationType', // Database uses 'computation_type', app uses 'computationType'
    computation_complexity: 'computationComplexity',
    resource_requirements: 'resourceRequirements',
    is_verified: 'isVerified',
    creator_reputation: 'creatorReputation',
    verification_signatures: 'verificationSignatures',
    execution_result_hash: 'executionResultHash',
    input_data: 'inputData',
    content_uri: 'contentUri',
    version_tag: 'versionTag',

    // Computational Tasks fields
    task_type: 'taskType', // Database uses 'task_type', app uses 'taskType'
    base_reward: 'baseReward',
    data_metrics: 'dataMetrics',
    region_code: 'regionCode',
    requires_verification: 'requiresVerification',
    computation_type: 'taskType', // Support legacy field name in case it still exists in DB
  };

  for (const [key, value] of Object.entries(dbObject)) {
    // Check if this key has a special mapping
    if (fieldMapping[key]) {
      appObject[fieldMapping[key]] = value;
    } else {
      // Convert snake_case to camelCase
      const camelKey = key.replace(/_([a-z])/g, (match, p1) =>
        p1.toUpperCase()
      );
      appObject[camelKey] = value;
    }
  }

  return appObject;
}

/**
 * Convert camelCase application field names to snake_case database field names
 * with special handling for specific field mappings
 *
 * @param {Object} appObject - Application object with camelCase field names
 * @returns {Object} Database object with snake_case field names
 */
function appToDb(appObject) {
  if (!appObject) return null;

  const dbObject = {};

  // Field name mapping from app to db (for special cases)
  const fieldMapping = {
    // Computational NFTs fields - app values on left, db values on right
    // We now use name consistently in both DB and application
    computationType: 'computation_type', // For NFTs, application uses 'computationType', database uses 'computation_type'
    computationComplexity: 'computation_complexity',
    resourceRequirements: 'resource_requirements',
    isVerified: 'is_verified',
    creatorReputation: 'creator_reputation',
    verificationSignatures: 'verification_signatures',
    executionResultHash: 'execution_result_hash',
    inputData: 'input_data',
    contentUri: 'content_uri',
    versionTag: 'version_tag',

    // Computational Tasks fields
    taskType: 'task_type', // Application uses 'taskType', db uses 'task_type'
    computationType: 'task_type', // Also map computationType to task_type for backward compatibility
    // 'name': 'title', // We now use 'name' consistently in both app and database
    baseReward: 'base_reward',
    dataMetrics: 'data_metrics',
    regionCode: 'region_code',
    requiresVerification: 'requires_verification',
  };

  for (const [key, value] of Object.entries(appObject)) {
    // Check if this key has a special mapping
    if (fieldMapping[key]) {
      dbObject[fieldMapping[key]] = value;
    } else {
      // Convert camelCase to snake_case
      const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      dbObject[snakeKey] = value;
    }
  }

  return dbObject;
}

module.exports = {
  dbToApp,
  appToDb,
};
