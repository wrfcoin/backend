/**
 * Field Mapper Utility for Wrfcoin
 *
 * This utility provides functions to convert between database (snake_case) and
 * application (camelCase) field formats, ensuring consistent field mapping across
 * the application.
 */

/**
 * Converts a camelCase string to snake_case
 * @param {string} str - The camelCase string to convert
 * @returns {string} The snake_case version of the string
 */
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Converts a snake_case string to camelCase
 * @param {string} str - The snake_case string to convert
 * @returns {string} The camelCase version of the string
 */
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Converts an object's keys from camelCase to snake_case
 * @param {Object} obj - The object with camelCase keys
 * @returns {Object} A new object with snake_case keys
 */
function objectToDatabaseFormat(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  return Object.entries(obj).reduce((result, [key, value]) => {
    // Skip null or undefined values
    if (value === null || value === undefined) {
      return result;
    }

    // Handle nested objects (but not arrays or dates)
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !(value.hasOwnProperty('x') && value.hasOwnProperty('y'))
    ) {
      value = objectToDatabaseFormat(value);
    }

    // Convert key to snake_case
    const snakeKey = camelToSnake(key);
    result[snakeKey] = value;

    return result;
  }, {});
}

/**
 * Converts an object's keys from snake_case to camelCase
 * @param {Object} obj - The object with snake_case keys
 * @returns {Object} A new object with camelCase keys
 */
function objectToApplicationFormat(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  return Object.entries(obj).reduce((result, [key, value]) => {
    // Skip null or undefined values
    if (value === null || value === undefined) {
      return result;
    }

    // Special handling for location point object from PostgreSQL
    if (
      key === 'location' &&
      value &&
      typeof value === 'object' &&
      value.hasOwnProperty('x') &&
      value.hasOwnProperty('y')
    ) {
      result.location = {
        latitude: parseFloat(value.x),
        longitude: parseFloat(value.y),
      };
      return result;
    }

    // Handle nested objects (but not arrays or dates)
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      value = objectToApplicationFormat(value);
    }

    // Convert key to camelCase
    const camelKey = snakeToCamel(key);
    result[camelKey] = value;

    return result;
  }, {});
}

/**
 * Field mapping definitions for specific tables
 * This maps application field names to database column names
 */
const tableFieldMappings = {
  environmentalSubmissions: {
    submissionId: 'submission_id',
    submitterId: 'submitter',
    dataType: 'data_type',
    deviceType: 'device_type',
    deviceId: 'device_id',
    sensorAccuracy: 'sensor_accuracy',
    batteryLevel: 'battery_level',
    signalStrength: 'signal_strength',
    maintenanceStatus: 'maintenance_status',
    firmwareVersion: 'firmware_version',
    calibrationDate: 'calibration_date',
    // For specific field name differences that don't follow the standard pattern
  },
  computationalNFTs: {
    nftId: 'nft_id',
    computationType: 'computation_type',
    computationComplexity: 'computation_complexity',
    isVerified: 'is_verified',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    // Add other specific mappings
  },
  computationalTasks: {
    taskId: 'task_id',
    regionCode: 'region_code',
    baseReward: 'base_reward',
    createdAt: 'created_at',
    requiresVerification: 'requires_verification',
    assignedNodeId: 'assigned_node_id',
    nftId: 'nft_id',
    taskType: 'task_type',
    // Add other specific mappings
  },
};

/**
 * Gets the database column name for a specific table and field
 * @param {string} table - The table name
 * @param {string} field - The application field name
 * @returns {string} The corresponding database column name
 */
function getDbColumnName(table, field) {
  if (tableFieldMappings[table] && tableFieldMappings[table][field]) {
    return tableFieldMappings[table][field];
  }

  // Default to camelToSnake conversion if no specific mapping exists
  return camelToSnake(field);
}

/**
 * Gets the application field name for a specific table and column
 * @param {string} table - The table name
 * @param {string} column - The database column name
 * @returns {string} The corresponding application field name
 */
function getAppFieldName(table, column) {
  const tableMapping = tableFieldMappings[table];
  if (tableMapping) {
    // Find the field whose mapped column matches the given column
    const field = Object.keys(tableMapping).find(
      key => tableMapping[key] === column
    );
    if (field) {
      return field;
    }
  }

  // Default to snakeToCamel conversion if no specific mapping exists
  return snakeToCamel(column);
}

/**
 * Convert object to database format using specific table mappings
 * @param {string} table - The table name
 * @param {Object} obj - The application object
 * @returns {Object} The database-formatted object
 */
function toDbFormat(table, obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  // Use specific field mappings for the table
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      continue;
    }

    // Handle location specially if it's in the format of {latitude, longitude}
    if (
      key === 'location' &&
      value &&
      value.latitude !== undefined &&
      value.longitude !== undefined
    ) {
      // Format as PostgreSQL point string
      result['location'] = `(${value.latitude},${value.longitude})`;
      continue;
    }

    // Get database column name
    const dbColumn = getDbColumnName(table, key);

    // Handle nested objects recursively
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      result[dbColumn] = objectToDatabaseFormat(value);
    } else {
      result[dbColumn] = value;
    }
  }

  return result;
}

/**
 * Convert object from database format to application format using specific table mappings
 * @param {string} table - The table name
 * @param {Object} obj - The database object
 * @returns {Object} The application-formatted object
 */
function toAppFormat(table, obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  // Use specific field mappings for the table
  const result = {};
  for (const [column, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      continue;
    }

    // Special handling for location
    if (column === 'location') {
      if (typeof value === 'string') {
        // Parse PostgreSQL point string format
        try {
          const [lat, lng] = value.slice(1, -1).split(',');
          result.location = {
            latitude: parseFloat(lat),
            longitude: parseFloat(lng),
          };
        } catch (e) {
          console.error('Error parsing location string:', e);
          result.location = { latitude: 0, longitude: 0 };
        }
      } else if (
        typeof value === 'object' &&
        value.x !== undefined &&
        value.y !== undefined
      ) {
        // Handle object with x,y properties
        result.location = {
          latitude: parseFloat(value.x),
          longitude: parseFloat(value.y),
        };
      } else {
        result.location = { latitude: 0, longitude: 0 };
      }
      continue;
    }

    // Get application field name
    const appField = getAppFieldName(table, column);

    // Handle nested objects recursively
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      result[appField] = objectToApplicationFormat(value);
    } else {
      result[appField] = value;
    }
  }

  return result;
}

// Export the main functions
module.exports = {
  camelToSnake,
  snakeToCamel,
  objectToDatabaseFormat,
  objectToApplicationFormat,
  toDbFormat,
  toAppFormat,
  getDbColumnName,
  getAppFieldName,
};
