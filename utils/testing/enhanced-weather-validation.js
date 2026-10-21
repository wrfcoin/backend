/**
 * Enhanced Weather Data Validator with Comprehensive Timestamp Validation
 * Extends the basic weather data validation with stricter timestamp checks
 */

const { WeatherDataValidator } = require('./weather-data-validation');

class EnhancedWeatherDataValidator extends WeatherDataValidator {
  constructor(config = {}) {
    super(config);

    // Enhanced timestamp validation settings
    this.timestampValidation = {
      maxFutureMinutes: config.maxFutureMinutes || 5, // Allow 5 minutes in future for clock skew
      maxPastDays: config.maxPastDays || 30, // Allow up to 30 days old data
      ...config.timestampValidation,
    };
  }

  /**
   * Enhanced validation with proper timestamp checks
   */
  validateDataPoint(dataPoint) {
    const result = {
      isValid: true,
      errors: [],
    };

    // Check required fields
    if (!dataPoint.timestamp) {
      result.isValid = false;
      result.errors.push('Missing required field: timestamp');
    }

    // Enhanced timestamp validation
    if (dataPoint.timestamp) {
      const timestampValidation = this.validateTimestamp(dataPoint.timestamp);
      if (!timestampValidation.isValid) {
        result.isValid = false;
        result.errors.push(...timestampValidation.errors);
      }
    }

    // Validate values within acceptable ranges
    for (const [field, range] of Object.entries(this.ranges)) {
      if (dataPoint[field] !== undefined) {
        if (typeof dataPoint[field] !== 'number') {
          result.isValid = false;
          result.errors.push(`Field ${field} must be a number`);
        } else if (
          dataPoint[field] < range.min ||
          dataPoint[field] > range.max
        ) {
          result.isValid = false;
          result.errors.push(
            `Field ${field} outside acceptable range: ${dataPoint[field]}`
          );
        }
      }
    }

    // Check for station_id if it's for a specific station
    if (dataPoint.type === 'station' && !dataPoint.station_id) {
      result.isValid = false;
      result.errors.push('Station data requires station_id field');
    }

    // Check coordinate format if provided
    if (dataPoint.latitude !== undefined || dataPoint.longitude !== undefined) {
      if (
        typeof dataPoint.latitude !== 'number' ||
        dataPoint.latitude < -90 ||
        dataPoint.latitude > 90
      ) {
        result.isValid = false;
        result.errors.push('Invalid latitude value');
      }

      if (
        typeof dataPoint.longitude !== 'number' ||
        dataPoint.longitude < -180 ||
        dataPoint.longitude > 180
      ) {
        result.isValid = false;
        result.errors.push('Invalid longitude value');
      }
    }

    return result;
  }

  /**
   * Comprehensive timestamp validation
   */
  validateTimestamp(timestamp) {
    const result = {
      isValid: true,
      errors: [],
    };

    // Check timestamp format
    let parsedTimestamp;
    try {
      parsedTimestamp = new Date(timestamp);
      if (isNaN(parsedTimestamp.getTime())) {
        throw new Error('Invalid date format');
      }
    } catch (error) {
      result.isValid = false;
      result.errors.push('Invalid timestamp format');
      return result;
    }

    const now = new Date();

    // Check if timestamp is too far in the future
    const maxFutureTime = new Date(
      now.getTime() + this.timestampValidation.maxFutureMinutes * 60 * 1000
    );
    if (parsedTimestamp > maxFutureTime) {
      result.isValid = false;
      result.errors.push(
        `Timestamp is too far in the future (more than ${this.timestampValidation.maxFutureMinutes} minutes)`
      );
    }

    // Check if timestamp is too old
    const maxPastTime = new Date(
      now.getTime() - this.timestampValidation.maxPastDays * 24 * 60 * 60 * 1000
    );
    if (parsedTimestamp < maxPastTime) {
      result.isValid = false;
      result.errors.push(
        `Timestamp is too old (more than ${this.timestampValidation.maxPastDays} days)`
      );
    }

    return result;
  }

  /**
   * Validate environmental data submission specifically for IoT consolidated schema
   */
  validateEnvironmentalSubmission(submissionData) {
    const result = {
      isValid: true,
      errors: [],
      warnings: [],
    };

    // Required fields for environmental data submission
    const requiredFields = ['deviceId', 'deviceType', 'timestamp'];

    for (const field of requiredFields) {
      if (!submissionData[field]) {
        result.isValid = false;
        result.errors.push(`Missing required field: ${field}`);
      }
    }

    // Validate device type
    const validDeviceTypes = ['acurite', 'luftdaten', 'ttn', 'foam', 'streamr'];
    if (
      submissionData.deviceType &&
      !validDeviceTypes.includes(submissionData.deviceType)
    ) {
      result.warnings.push(`Unknown device type: ${submissionData.deviceType}`);
    }

    // Validate measurement data
    const measurementFields = [
      'temperature',
      'humidity',
      'pressure',
      'windSpeed',
      'windDirection',
      'precipitation',
    ];
    let hasValidMeasurements = false;

    for (const field of measurementFields) {
      if (submissionData[field] !== undefined) {
        hasValidMeasurements = true;
        if (typeof submissionData[field] !== 'number') {
          result.isValid = false;
          result.errors.push(`${field} must be a number`);
        }
      }
    }

    if (!hasValidMeasurements) {
      result.warnings.push('No measurement data provided');
    }

    // Validate location data if provided
    if (submissionData.locationLat !== undefined) {
      if (
        typeof submissionData.locationLat !== 'number' ||
        submissionData.locationLat < -90 ||
        submissionData.locationLat > 90
      ) {
        result.isValid = false;
        result.errors.push('Invalid latitude in locationLat field');
      }
    }

    if (submissionData.locationLon !== undefined) {
      if (
        typeof submissionData.locationLon !== 'number' ||
        submissionData.locationLon < -180 ||
        submissionData.locationLon > 180
      ) {
        result.isValid = false;
        result.errors.push('Invalid longitude in locationLon field');
      }
    }

    // Validate timestamp
    if (submissionData.timestamp) {
      const timestampValidation = this.validateTimestamp(
        submissionData.timestamp
      );
      if (!timestampValidation.isValid) {
        result.isValid = false;
        result.errors.push(...timestampValidation.errors);
      }
    }

    return result;
  }

  /**
   * Validate reward calculation accuracy
   */
  validateRewardCalculation(weatherData, calculatedReward) {
    const result = {
      isValid: true,
      errors: [],
      expectedReward: null,
      rewardBreakdown: {},
    };

    try {
      // Recreate reward calculation logic from environmental_sensor_api.js
      const baseReward = 50;
      let qualityMultiplier = 1.0;

      // Bonus for complete data set
      if (
        weatherData.temperature &&
        weatherData.humidity &&
        weatherData.windSpeed &&
        weatherData.pressure
      ) {
        qualityMultiplier += 0.5;
        result.rewardBreakdown.completeDataBonus = 0.5;
      }

      // Bonus for extreme weather conditions
      if (
        weatherData.windSpeed > 25 ||
        weatherData.temperature < 32 ||
        weatherData.temperature > 95
      ) {
        qualityMultiplier += 0.3;
        result.rewardBreakdown.extremeWeatherBonus = 0.3;
      }

      const expectedReward = Math.floor(baseReward * qualityMultiplier);
      result.expectedReward = expectedReward;
      result.rewardBreakdown.baseReward = baseReward;
      result.rewardBreakdown.qualityMultiplier = qualityMultiplier;
      result.rewardBreakdown.totalReward = expectedReward;

      // Validate calculated reward matches expected
      if (calculatedReward !== expectedReward) {
        result.isValid = false;
        result.errors.push(
          `Reward calculation mismatch: expected ${expectedReward}, got ${calculatedReward}`
        );
      }
    } catch (error) {
      result.isValid = false;
      result.errors.push(`Reward calculation error: ${error.message}`);
    }

    return result;
  }
}

module.exports = { EnhancedWeatherDataValidator };
