/**
 * Sensor.Community Data Validator
 *
 * This module is responsible for validating data from Sensor.Community sensors
 * before it is included in the blockchain. It performs various checks to ensure
 * data quality and reliability.
 */

const logger = require('../../utils/logger')('sensor-community:validator');

// Validation thresholds for different measurement types
const VALIDATION_THRESHOLDS = {
  // PM2.5 thresholds (in µg/m³)
  PM25: {
    MIN: 0,
    MAX: 1000, // Extreme upper limit
    SUSPICIOUS: 500, // Value that should trigger additional validation
    RATE_OF_CHANGE: 100, // Maximum allowable change per hour
  },
  // PM10 thresholds (in µg/m³)
  PM10: {
    MIN: 0,
    MAX: 2000, // Extreme upper limit
    SUSPICIOUS: 800, // Value that should trigger additional validation
    RATE_OF_CHANGE: 200, // Maximum allowable change per hour
  },
  // Temperature thresholds (in °C)
  TEMPERATURE: {
    MIN: -40,
    MAX: 60,
    SUSPICIOUS: 50, // Value that should trigger additional validation
    RATE_OF_CHANGE: 10, // Maximum allowable change per hour
  },
  // Humidity thresholds (in %)
  HUMIDITY: {
    MIN: 0,
    MAX: 100,
    SUSPICIOUS: 100, // Value that should trigger additional validation
    RATE_OF_CHANGE: 30, // Maximum allowable change per hour
  },
  // Pressure thresholds (in hPa)
  PRESSURE: {
    MIN: 870,
    MAX: 1090,
    SUSPICIOUS: 1050, // Value that should trigger additional validation
    RATE_OF_CHANGE: 20, // Maximum allowable change per hour
  },
};

/**
 * Levels of data quality
 */
const QUALITY_LEVELS = {
  HIGH: 'high', // High quality data, suitable for all uses
  MEDIUM: 'medium', // Medium quality, may need additional verification
  LOW: 'low', // Low quality, should be used with caution
  INVALID: 'invalid', // Invalid data, should not be used
};

class SensorCommunityValidator {
  constructor() {
    logger.info('Initializing Sensor.Community data validator');
  }

  /**
   * Validate a single data point from a sensor
   * @param {Object} sensorData - Sensor data in Wrfcoin format
   * @param {Object} historicalData - Historical data for the sensor (optional)
   * @returns {Object} - Validation results
   */
  validateDataPoint(sensorData, historicalData = null) {
    if (!sensorData || !sensorData.measurements) {
      return {
        isValid: false,
        qualityLevel: QUALITY_LEVELS.INVALID,
        issues: ['Missing or invalid data structure'],
        timestamp: new Date().toISOString(),
      };
    }

    const validationResults = {
      isValid: true,
      qualityLevel: QUALITY_LEVELS.HIGH,
      issues: [],
      warnings: [],
      anomalyScores: {},
      timestamp: new Date().toISOString(),
    };

    // Validate each measurement type
    for (const [measurementType, value] of Object.entries(
      sensorData.measurements
    )) {
      const result = this._validateMeasurement(
        measurementType,
        value,
        historicalData
          ? this._getHistoricalValues(historicalData, measurementType)
          : null
      );

      // Store results
      validationResults.anomalyScores[measurementType] = result.anomalyScore;

      // Update overall quality level
      if (!result.isValid) {
        validationResults.isValid = false;
        validationResults.qualityLevel = QUALITY_LEVELS.INVALID;
        validationResults.issues.push(result.issue);
      } else if (
        result.qualityLevel === QUALITY_LEVELS.LOW &&
        validationResults.qualityLevel !== QUALITY_LEVELS.INVALID
      ) {
        validationResults.qualityLevel = QUALITY_LEVELS.LOW;
        validationResults.issues.push(result.issue);
      } else if (
        result.qualityLevel === QUALITY_LEVELS.MEDIUM &&
        validationResults.qualityLevel === QUALITY_LEVELS.HIGH
      ) {
        validationResults.qualityLevel = QUALITY_LEVELS.MEDIUM;
        validationResults.warnings.push(result.issue);
      }
    }

    // Cross-validate measurements if we have multiple types
    if (Object.keys(sensorData.measurements).length > 1) {
      const crossValidationResult = this._crossValidateMeasurements(
        sensorData.measurements
      );

      if (!crossValidationResult.isValid) {
        validationResults.isValid = false;
        validationResults.qualityLevel = QUALITY_LEVELS.INVALID;
        validationResults.issues.push(crossValidationResult.issue);
      } else if (crossValidationResult.hasWarning) {
        validationResults.warnings.push(crossValidationResult.warning);
      }
    }

    // Spatial validation if we have nearby sensors in the historical data
    if (historicalData && historicalData.nearbySensors) {
      const spatialResult = this._performSpatialValidation(
        sensorData.measurements,
        historicalData.nearbySensors
      );

      if (spatialResult.hasAnomaly) {
        validationResults.warnings.push(spatialResult.warning);

        if (validationResults.qualityLevel === QUALITY_LEVELS.HIGH) {
          validationResults.qualityLevel = QUALITY_LEVELS.MEDIUM;
        }
      }
    }

    logger.debug(`Validated data point from sensor ${sensorData.sourceId}`, {
      qualityLevel: validationResults.qualityLevel,
      issueCount: validationResults.issues.length,
      warningCount: validationResults.warnings.length,
    });

    return validationResults;
  }

  /**
   * Validate a measurement value
   * @private
   * @param {string} type - Measurement type (PM25, PM10, TEMPERATURE, etc.)
   * @param {number} value - Measured value
   * @param {Array} historicalValues - Historical values for this measurement type
   * @returns {Object} - Validation result for this measurement
   */
  _validateMeasurement(type, value, historicalValues) {
    // Get the appropriate thresholds
    const thresholds = this._getThresholdsForMeasurement(type);

    // Basic result structure
    const result = {
      isValid: true,
      qualityLevel: QUALITY_LEVELS.HIGH,
      issue: null,
      anomalyScore: 0,
    };

    // Check if value is a number
    if (typeof value !== 'number' || isNaN(value)) {
      result.isValid = false;
      result.qualityLevel = QUALITY_LEVELS.INVALID;
      result.issue = `Invalid ${type} value: not a number`;
      result.anomalyScore = 1;
      return result;
    }

    // Range validation
    if (value < thresholds.MIN) {
      result.isValid = false;
      result.qualityLevel = QUALITY_LEVELS.INVALID;
      result.issue = `${type} value ${value} is below minimum threshold ${thresholds.MIN}`;
      result.anomalyScore = 1;
      return result;
    }

    if (value > thresholds.MAX) {
      result.isValid = false;
      result.qualityLevel = QUALITY_LEVELS.INVALID;
      result.issue = `${type} value ${value} exceeds maximum threshold ${thresholds.MAX}`;
      result.anomalyScore = 1;
      return result;
    }

    // Suspicious value check
    if (value > thresholds.SUSPICIOUS) {
      result.qualityLevel = QUALITY_LEVELS.MEDIUM;
      result.issue = `${type} value ${value} is suspiciously high`;
      result.anomalyScore = 0.6;
    }

    // Rate of change validation (only if we have historical data)
    if (historicalValues && historicalValues.length > 0) {
      const recentValue = historicalValues[0];
      const rateOfChange = Math.abs(value - recentValue);

      if (rateOfChange > thresholds.RATE_OF_CHANGE) {
        result.qualityLevel = QUALITY_LEVELS.LOW;
        result.issue = `${type} changed by ${rateOfChange.toFixed(2)} which exceeds rate of change threshold ${thresholds.RATE_OF_CHANGE}`;
        result.anomalyScore = 0.8;
      }

      // Check for stuck sensors (exactly same value for multiple readings)
      if (
        historicalValues.length >= 3 &&
        historicalValues.slice(0, 3).every(v => v === value)
      ) {
        result.qualityLevel = QUALITY_LEVELS.LOW;
        result.issue = `${type} shows identical values across multiple readings, sensor may be stuck`;
        result.anomalyScore = 0.7;
      }

      // Statistical anomaly detection (if we have enough data points)
      if (historicalValues.length >= 10) {
        const stats = this._calculateStats(historicalValues);
        const zScore = Math.abs((value - stats.mean) / stats.stdDev);

        // Z-score above 3 is considered an anomaly in normal distribution
        if (zScore > 3) {
          if (result.qualityLevel === QUALITY_LEVELS.HIGH) {
            result.qualityLevel = QUALITY_LEVELS.MEDIUM;
            result.issue = `${type} value is a statistical outlier (z-score: ${zScore.toFixed(2)})`;
          }
          result.anomalyScore = Math.max(
            result.anomalyScore,
            0.5 + (zScore - 3) / 10
          );
        }
      }
    }

    return result;
  }

  /**
   * Cross-validate measurements to check for consistency
   * @private
   * @param {Object} measurements - Map of measurement type to value
   * @returns {Object} - Cross-validation result
   */
  _crossValidateMeasurements(measurements) {
    const result = {
      isValid: true,
      hasWarning: false,
      issue: null,
      warning: null,
    };

    // Example: Check if PM2.5 is greater than PM10 (physically impossible)
    if (measurements.pm25 !== undefined && measurements.pm10 !== undefined) {
      if (measurements.pm25 > measurements.pm10) {
        result.isValid = false;
        result.issue = `PM2.5 value (${measurements.pm25}) is greater than PM10 (${measurements.pm10}), which is physically impossible`;
      }
      // Check for suspicious PM2.5/PM10 ratio
      else if (measurements.pm10 > 0) {
        const ratio = measurements.pm25 / measurements.pm10;
        if (ratio < 0.2 || ratio > 0.8) {
          result.hasWarning = true;
          result.warning = `Unusual PM2.5/PM10 ratio (${ratio.toFixed(2)})`;
        }
      }
    }

    // Example: Check if humidity and temperature relationship is reasonable
    if (
      measurements.temperature !== undefined &&
      measurements.humidity !== undefined
    ) {
      // High temperature with 100% humidity is suspicious
      if (measurements.temperature > 35 && measurements.humidity > 95) {
        result.hasWarning = true;
        result.warning = `Suspicious combination of high temperature (${measurements.temperature}°C) and high humidity (${measurements.humidity}%)`;
      }
    }

    return result;
  }

  /**
   * Perform spatial validation by comparing with nearby sensors
   * @private
   * @param {Object} measurements - Map of measurement type to value
   * @param {Array} nearbySensors - Array of data from nearby sensors
   * @returns {Object} - Spatial validation result
   */
  _performSpatialValidation(measurements, nearbySensors) {
    const result = {
      hasAnomaly: false,
      warning: null,
    };

    if (!nearbySensors || nearbySensors.length === 0) {
      return result;
    }

    // For each measurement type, compare with nearby sensors
    for (const [type, value] of Object.entries(measurements)) {
      // Calculate the mean and std deviation of this measurement from nearby sensors
      const nearbyValues = nearbySensors
        .filter(s => s.measurements && s.measurements[type] !== undefined)
        .map(s => s.measurements[type]);

      if (nearbyValues.length < 2) {
        continue; // Not enough data for comparison
      }

      const stats = this._calculateStats(nearbyValues);
      const zScore = Math.abs((value - stats.mean) / stats.stdDev);

      // If this sensor differs significantly from its neighbors
      if (zScore > 3) {
        result.hasAnomaly = true;
        result.warning = `${type} value (${value}) differs significantly from nearby sensors (mean: ${stats.mean.toFixed(2)}, z-score: ${zScore.toFixed(2)})`;
        break;
      }
    }

    return result;
  }

  /**
   * Calculate basic statistics for an array of values
   * @private
   * @param {Array<number>} values - Array of numeric values
   * @returns {Object} - Statistics: mean, stdDev, min, max
   */
  _calculateStats(values) {
    const sum = values.reduce((acc, val) => acc + val, 0);
    const mean = sum / values.length;

    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance =
      squaredDiffs.reduce((acc, val) => acc + val, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    return {
      mean,
      stdDev,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  /**
   * Get thresholds for a specific measurement type
   * @private
   * @param {string} type - Measurement type
   * @returns {Object} - Thresholds for this measurement
   */
  _getThresholdsForMeasurement(type) {
    // Convert type to match our threshold keys
    let normalizedType = type.toUpperCase();

    // Handle special cases
    if (
      normalizedType === 'PM25' ||
      normalizedType === 'PM2.5' ||
      normalizedType === 'P2'
    ) {
      normalizedType = 'PM25';
    } else if (normalizedType === 'PM10' || normalizedType === 'P1') {
      normalizedType = 'PM10';
    }

    // Return the appropriate thresholds or a default
    return (
      VALIDATION_THRESHOLDS[normalizedType] || {
        MIN: -10000,
        MAX: 10000,
        SUSPICIOUS: 5000,
        RATE_OF_CHANGE: 1000,
      }
    );
  }

  /**
   * Extract historical values for a specific measurement type
   * @private
   * @param {Object} historicalData - Historical data object
   * @param {string} measurementType - Measurement type to extract
   * @returns {Array} - Array of historical values
   */
  _getHistoricalValues(historicalData, measurementType) {
    if (!historicalData || !historicalData.measurements) {
      return [];
    }

    return historicalData.measurements
      .filter(m => m[measurementType] !== undefined)
      .map(m => m[measurementType]);
  }

  /**
   * Determine if a data point should be permanently stored
   * based on its quality and other factors
   * @param {Object} validationResult - The result from validateDataPoint
   * @param {Object} options - Storage options
   * @returns {boolean} - True if the data should be permanently stored
   */
  shouldPermanentlyStore(validationResult, options = {}) {
    // Default storage policy options
    const storageOptions = {
      storeAllValidData: false, // Store all valid data regardless of quality
      storeInvalidWithWarning: false, // Store invalid data that only has warnings
      storageAnomalyThreshold: 0.6, // Store data with anomaly score above this
      ...options,
    };

    // Don't store invalid data unless option is enabled
    if (!validationResult.isValid && !storageOptions.storeInvalidWithWarning) {
      return false;
    }

    // Store all valid data if the option is enabled
    if (validationResult.isValid && storageOptions.storeAllValidData) {
      return true;
    }

    // Store data with significant anomalies (they may be interesting)
    const maxAnomalyScore = Math.max(
      ...Object.values(validationResult.anomalyScores),
      0
    );

    if (maxAnomalyScore >= storageOptions.storageAnomalyThreshold) {
      return true;
    }

    // Default storage decision based on quality level
    switch (validationResult.qualityLevel) {
      case QUALITY_LEVELS.HIGH:
        return true;
      case QUALITY_LEVELS.MEDIUM:
        return options.storeMediumQuality !== false; // Store medium by default
      case QUALITY_LEVELS.LOW:
        return options.storeLowQuality === true; // Don't store low by default
      case QUALITY_LEVELS.INVALID:
        return false; // Never store invalid
      default:
        return false;
    }
  }
}

module.exports = {
  SensorCommunityValidator,
  QUALITY_LEVELS,
  VALIDATION_THRESHOLDS,
};
