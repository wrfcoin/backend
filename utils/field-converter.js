/**
 * Field Name Conversion Utilities for Wrfcoin Core
 *
 * These utilities help convert between camelCase (used in application code)
 * and snake_case (used in database) field naming conventions.
 */

/**
 * Convert a camelCase string to snake_case
 * @param {string} str The string to convert
 * @returns {string} The converted string
 */
function camelToSnake(str) {
  return str.replace(/([A-Z])/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Convert a snake_case string to camelCase
 * @param {string} str The string to convert
 * @returns {string} The converted string
 */
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, match => match[1].toUpperCase());
}

/**
 * Convert an object's keys from camelCase to snake_case
 * @param {Object} obj The object with camelCase keys
 * @returns {Object} A new object with snake_case keys
 */
function objectToDatabaseFormat(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  return Object.keys(obj).reduce((result, key) => {
    const value = obj[key];
    const newKey = camelToSnake(key);

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively convert nested objects
      result[newKey] = objectToDatabaseFormat(value);
    } else {
      result[newKey] = value;
    }

    return result;
  }, {});
}

/**
 * Convert an object's keys from snake_case to camelCase
 * @param {Object} obj The object with snake_case keys
 * @returns {Object} A new object with camelCase keys
 */
function objectToApplicationFormat(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  return Object.keys(obj).reduce((result, key) => {
    const value = obj[key];
    const newKey = snakeToCamel(key);

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively convert nested objects
      result[newKey] = objectToApplicationFormat(value);
    } else {
      result[newKey] = value;
    }

    return result;
  }, {});
}

/**
 * Convert a database result to application format with fallbacks
 * This ensures compatibility between snake_case and camelCase field names
 * @param {Object} dbObj Database object with snake_case or mixed field names
 * @param {Object} fieldMap Optional mapping of known fields and their types
 * @returns {Object} A cleaned object with consistent camelCase field names
 */
function toApplicationFormat(dbObj, fieldMap = {}) {
  if (!dbObj || typeof dbObj !== 'object') {
    return dbObj;
  }

  // First convert all fields to camelCase
  const camelCaseObj = objectToApplicationFormat(dbObj);

  // Create a results object that contains both versions of each field
  // to ensure maximum compatibility
  const result = {};

  // Process all original keys from the DB object
  Object.keys(dbObj).forEach(key => {
    // The snake_case key
    const snakeKey = key;
    // Convert to camelCase
    const camelKey = snakeToCamel(key);

    // Get the value from either the original or already converted object
    const value = dbObj[snakeKey];

    // Store both versions in result
    result[camelKey] = value;

    // Special handling for known field types if provided
    if (fieldMap[camelKey]) {
      const fieldType = fieldMap[camelKey];

      // Perform type conversion if needed
      if (fieldType === 'boolean' && typeof value !== 'boolean') {
        result[camelKey] = value === 'true' || value === 1 || value === '1';
      } else if (fieldType === 'number' && typeof value !== 'number') {
        result[camelKey] = Number(value);
      } else if (fieldType === 'string' && typeof value !== 'string') {
        result[camelKey] = String(value);
      } else if (fieldType === 'json' && typeof value === 'string') {
        try {
          result[camelKey] = JSON.parse(value);
        } catch (e) {
          console.warn(`Failed to parse JSON field ${camelKey}:`, e);
        }
      }
    }
  });

  return result;
}

/**
 * Validate and fix data object for database insertion
 * @param {Object} data The data object to validate and fix
 * @param {Array<string>} requiredFields Array of required field names
 * @param {Object} defaults Default values for fields
 * @returns {Object} A validated and fixed data object
 */
function validateAndFixDataObject(data, requiredFields = [], defaults = {}) {
  const result = { ...data };

  // Check required fields
  for (const field of requiredFields) {
    if (result[field] === undefined) {
      if (defaults[field] !== undefined) {
        result[field] = defaults[field];
      } else {
        throw new Error(
          `Required field ${field} is missing and has no default`
        );
      }
    }
  }

  // Apply defaults for missing fields
  for (const [field, defaultValue] of Object.entries(defaults)) {
    if (result[field] === undefined) {
      result[field] = defaultValue;
    }
  }

  return result;
}

module.exports = {
  camelToSnake,
  snakeToCamel,
  objectToDatabaseFormat,
  objectToApplicationFormat,
  toApplicationFormat,
  validateAndFixDataObject,
};
