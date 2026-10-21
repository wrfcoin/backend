/**
 * Weather Data Validation and Quality Assurance Service
 *
 * This service provides comprehensive validation for weather data including:
 * - Range validation for meteorological parameters
 * - Physics-based consistency checks
 * - Temporal consistency validation
 * - Spatial consistency validation
 * - Data completeness checks
 * - Quality scoring
 */

const { logger } = require('../utils/logger');

class WeatherDataValidator {
  constructor() {
    // Define meteorological parameter ranges (based on WMO standards)
    this.validRanges = {
      temperature: { min: -89.2, max: 56.7, unit: 'celsius' }, // World record extremes
      humidity: { min: 0, max: 100, unit: 'percent' },
      pressure: { min: 870, max: 1085, unit: 'hPa' }, // Sea level pressure extremes
      windSpeed: { min: 0, max: 113, unit: 'metersPerSecond' }, // Max sustained wind on record
      windDirection: { min: 0, max: 360, unit: 'degrees' },
      precipitation: { min: 0, max: 305, unit: 'millimeters' }, // Max daily rainfall record
      dewpoint: { min: -89.2, max: 35, unit: 'celsius' },
      visibility: { min: 0, max: 50, unit: 'kilometers' },
      cloudCoverage: { min: 0, max: 100, unit: 'percent' },
      snowfall: { min: 0, max: 193, unit: 'centimeters' }, // Max daily snowfall record
      snowDepth: { min: 0, max: 1182, unit: 'centimeters' }, // Max snow depth record
      solarRadiation: { min: 0, max: 1400, unit: 'wattsPerSquareMeter' },
      uvIndex: { min: 0, max: 16, unit: 'index' },
    };

    // Physics-based relationships for consistency checking
    this.physicsRules = {
      // Dewpoint cannot exceed temperature
      dewpointTemperatureRule: (dewpoint, temperature) =>
        dewpoint <= temperature,

      // Relative humidity calculation consistency
      humidityConsistencyRule: (temperature, dewpoint, humidity) => {
        if (temperature === null || dewpoint === null || humidity === null)
          return true;

        // Calculate expected humidity from temperature and dewpoint
        const expectedHumidity = this.calculateRelativeHumidity(
          temperature,
          dewpoint
        );
        const tolerance = 5; // 5% tolerance

        return Math.abs(humidity - expectedHumidity) <= tolerance;
      },

      // Barometric pressure altitude relationship
      pressureAltitudeRule: (pressure, elevation) => {
        if (pressure === null || elevation === null) return true;

        // Standard atmosphere: pressure decreases ~12 hPa per 100m elevation
        const expectedPressure =
          1013.25 * Math.pow(1 - (0.0065 * elevation) / 288.15, 5.257);
        const tolerance = 50; // 50 hPa tolerance for weather systems

        return Math.abs(pressure - expectedPressure) <= tolerance;
      },

      // Wind speed and gusts relationship
      windGustRule: (windSpeed, windGust) => {
        if (windSpeed === null || windGust === null) return true;

        // Gusts should be greater than or equal to sustained wind speed
        return windGust >= windSpeed;
      },

      // Temperature lapse rate check (for stations at different elevations)
      temperatureLapseRule: (temp1, elevation1, temp2, elevation2) => {
        if (
          temp1 === null ||
          temp2 === null ||
          elevation1 === null ||
          elevation2 === null
        )
          return true;

        const elevationDiff = Math.abs(elevation2 - elevation1);
        const tempDiff = Math.abs(temp2 - temp1);

        // Standard atmospheric lapse rate: 6.5°C per 1000m
        const expectedTempDiff = (elevationDiff / 1000) * 6.5;
        const tolerance = 10; // 10°C tolerance for local effects

        return tempDiff <= expectedTempDiff + tolerance;
      },
    };

    // Data quality thresholds
    this.qualityThresholds = {
      excellent: 0.95,
      good: 0.85,
      fair: 0.7,
      poor: 0.5,
    };
  }

  /**
   * Validate a single weather data record
   */
  validateWeatherRecord(data, options = {}) {
    const {
      enablePhysicsValidation = true,
      enableRangeValidation = true,
      enableCompletenessCheck = true,
      strictMode = false,
    } = options;

    const validationResult = {
      isValid: true,
      score: 1.0,
      errors: [],
      warnings: [],
      qualityLevel: 'excellent',
      checks: {
        rangeValidation: { passed: true, details: [] },
        physicsValidation: { passed: true, details: [] },
        completenessCheck: { passed: true, details: [] },
      },
      timestamp: new Date().toISOString(),
    };

    try {
      // Range validation
      if (enableRangeValidation) {
        const rangeResult = this.validateParameterRanges(data);
        validationResult.checks.rangeValidation = rangeResult;

        if (!rangeResult.passed) {
          validationResult.errors.push(...rangeResult.details);
          validationResult.score *= 0.8;

          if (strictMode) {
            validationResult.isValid = false;
          }
        }
      }

      // Physics-based validation
      if (enablePhysicsValidation) {
        const physicsResult = this.validatePhysicsRules(data);
        validationResult.checks.physicsValidation = physicsResult;

        if (!physicsResult.passed) {
          validationResult.warnings.push(...physicsResult.details);
          validationResult.score *= 0.9;
        }
      }

      // Completeness check
      if (enableCompletenessCheck) {
        const completenessResult = this.checkDataCompleteness(data);
        validationResult.checks.completenessCheck = completenessResult;

        if (!completenessResult.passed) {
          validationResult.warnings.push(...completenessResult.details);
          validationResult.score *= completenessResult.completenessRatio;
        }
      }

      // Determine quality level
      validationResult.qualityLevel = this.determineQualityLevel(
        validationResult.score
      );

      // Overall validation status
      if (validationResult.errors.length > 0 && strictMode) {
        validationResult.isValid = false;
      }

      logger.debug('Weather data validation completed', {
        score: validationResult.score,
        qualityLevel: validationResult.qualityLevel,
        errorCount: validationResult.errors.length,
        warningCount: validationResult.warnings.length,
      });

      return validationResult;
    } catch (error) {
      logger.error('Error during weather data validation:', {
        error: error.message,
        data,
      });

      return {
        isValid: false,
        score: 0,
        errors: [`Validation error: ${error.message}`],
        warnings: [],
        qualityLevel: 'invalid',
        checks: {},
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Validate parameter ranges
   */
  validateParameterRanges(data) {
    const result = {
      passed: true,
      details: [],
    };

    Object.entries(data).forEach(([param, value]) => {
      if (value === null || value === undefined) return;

      const paramConfig = this.validRanges[param];
      if (!paramConfig) return; // Skip unknown parameters

      let numericValue = value;

      // Handle object values with value property
      if (typeof value === 'object' && value.value !== undefined) {
        numericValue = value.value;
      }

      if (typeof numericValue !== 'number') return;

      if (numericValue < paramConfig.min || numericValue > paramConfig.max) {
        const error = `${param} value ${numericValue} ${paramConfig.unit} is outside valid range [${paramConfig.min}, ${paramConfig.max}] ${paramConfig.unit}`;
        result.details.push(error);
        result.passed = false;
      }
    });

    return result;
  }

  /**
   * Validate physics-based rules
   */
  validatePhysicsRules(data) {
    const result = {
      passed: true,
      details: [],
    };

    const getValue = param => {
      const value = data[param];
      if (value === null || value === undefined) return null;
      return typeof value === 'object' ? value.value : value;
    };

    // Check dewpoint-temperature relationship
    const temperature = getValue('temperature');
    const dewpoint = getValue('dewpoint');

    if (temperature !== null && dewpoint !== null) {
      if (!this.physicsRules.dewpointTemperatureRule(dewpoint, temperature)) {
        result.details.push(
          `Dewpoint (${dewpoint}°C) cannot exceed temperature (${temperature}°C)`
        );
        result.passed = false;
      }
    }

    // Check humidity consistency
    const humidity = getValue('humidity');
    if (temperature !== null && dewpoint !== null && humidity !== null) {
      if (
        !this.physicsRules.humidityConsistencyRule(
          temperature,
          dewpoint,
          humidity
        )
      ) {
        result.details.push(
          'Humidity value inconsistent with temperature and dewpoint'
        );
        result.passed = false;
      }
    }

    // Check pressure-altitude relationship
    const pressure = getValue('pressure');
    const elevation = getValue('elevation');

    if (pressure !== null && elevation !== null) {
      if (!this.physicsRules.pressureAltitudeRule(pressure, elevation)) {
        result.details.push(
          'Pressure value inconsistent with station elevation'
        );
        result.passed = false;
      }
    }

    // Check wind speed and gusts
    const windSpeed = getValue('windSpeed');
    const windGust = getValue('windGust');

    if (windSpeed !== null && windGust !== null) {
      if (!this.physicsRules.windGustRule(windSpeed, windGust)) {
        result.details.push(
          `Wind gust (${windGust}) should not be less than sustained wind speed (${windSpeed})`
        );
        result.passed = false;
      }
    }

    return result;
  }

  /**
   * Check data completeness
   */
  checkDataCompleteness(data) {
    const expectedParams = [
      'temperature',
      'humidity',
      'pressure',
      'windSpeed',
      'windDirection',
    ];
    const presentParams = expectedParams.filter(param => {
      const value = data[param];
      return value !== null && value !== undefined;
    });

    const completenessRatio = presentParams.length / expectedParams.length;
    const passed = completenessRatio >= 0.6; // Require at least 60% of expected parameters

    const result = {
      passed,
      completenessRatio,
      details: [],
    };

    if (!passed) {
      const missingParams = expectedParams.filter(
        param => !presentParams.includes(param)
      );
      result.details.push(
        `Missing essential parameters: ${missingParams.join(', ')}`
      );
    }

    return result;
  }

  /**
   * Validate temporal consistency across multiple records
   */
  validateTemporalConsistency(records, options = {}) {
    const { maxTemperatureChange = 20, maxPressureChange = 30 } = options;

    if (records.length < 2) {
      return { passed: true, details: [] };
    }

    const result = {
      passed: true,
      details: [],
    };

    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1];
      const curr = records[i];

      // Check temperature changes
      const prevTemp = this.extractValue(prev.data.temperature);
      const currTemp = this.extractValue(curr.data.temperature);

      if (prevTemp !== null && currTemp !== null) {
        const tempChange = Math.abs(currTemp - prevTemp);
        const timeDiff = this.getTimeDifferenceHours(
          prev.timestamp,
          curr.timestamp
        );

        // Allow higher changes for longer time periods
        const maxAllowedChange = maxTemperatureChange * Math.sqrt(timeDiff);

        if (tempChange > maxAllowedChange) {
          result.details.push(
            `Rapid temperature change: ${tempChange}°C in ${timeDiff} hours`
          );
          result.passed = false;
        }
      }

      // Check pressure changes
      const prevPressure = this.extractValue(prev.data.pressure);
      const currPressure = this.extractValue(curr.data.pressure);

      if (prevPressure !== null && currPressure !== null) {
        const pressureChange = Math.abs(currPressure - prevPressure);
        const timeDiff = this.getTimeDifferenceHours(
          prev.timestamp,
          curr.timestamp
        );

        const maxAllowedChange = maxPressureChange * Math.sqrt(timeDiff);

        if (pressureChange > maxAllowedChange) {
          result.details.push(
            `Rapid pressure change: ${pressureChange} hPa in ${timeDiff} hours`
          );
          result.passed = false;
        }
      }
    }

    return result;
  }

  /**
   * Validate spatial consistency between nearby stations
   */
  validateSpatialConsistency(stationData, options = {}) {
    const {
      maxDistance = 50,
      temperatureTolerance = 5,
      pressureTolerance = 10,
    } = options;

    if (stationData.length < 2) {
      return { passed: true, details: [] };
    }

    const result = {
      passed: true,
      details: [],
    };

    for (let i = 0; i < stationData.length; i++) {
      for (let j = i + 1; j < stationData.length; j++) {
        const station1 = stationData[i];
        const station2 = stationData[j];

        const distance = this.calculateDistance(
          station1.location.latitude,
          station1.location.longitude,
          station2.location.latitude,
          station2.location.longitude
        );

        if (distance <= maxDistance) {
          // Check temperature consistency
          const temp1 = this.extractValue(station1.data.temperature);
          const temp2 = this.extractValue(station2.data.temperature);

          if (temp1 !== null && temp2 !== null) {
            const tempDiff = Math.abs(temp1 - temp2);
            const elevationDiff = Math.abs(
              (station1.location.elevation || 0) -
                (station2.location.elevation || 0)
            );

            // Adjust tolerance for elevation difference (6.5°C per 1000m)
            const adjustedTolerance =
              temperatureTolerance + (elevationDiff / 1000) * 6.5;

            if (tempDiff > adjustedTolerance) {
              result.details.push(
                `Large temperature difference between nearby stations: ${tempDiff}°C at ${distance}km distance`
              );
              result.passed = false;
            }
          }

          // Check pressure consistency
          const pressure1 = this.extractValue(station1.data.pressure);
          const pressure2 = this.extractValue(station2.data.pressure);

          if (pressure1 !== null && pressure2 !== null) {
            const pressureDiff = Math.abs(pressure1 - pressure2);

            if (pressureDiff > pressureTolerance) {
              result.details.push(
                `Large pressure difference between nearby stations: ${pressureDiff} hPa at ${distance}km distance`
              );
              result.passed = false;
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Calculate quality score for a dataset
   */
  calculateDatasetQualityScore(records, validationResults) {
    if (records.length === 0) return 0;

    const scores = validationResults.map(result => result.score);
    const averageScore =
      scores.reduce((sum, score) => sum + score, 0) / scores.length;

    // Additional factors
    const completenessBonus = records.length >= 100 ? 0.05 : 0; // Bonus for large datasets
    const consistencyPenalty =
      (validationResults.filter(r => !r.checks.physicsValidation?.passed)
        .length /
        records.length) *
      0.1;

    const finalScore = Math.max(
      0,
      Math.min(1, averageScore + completenessBonus - consistencyPenalty)
    );

    return {
      overallScore: finalScore,
      averageScore,
      qualityLevel: this.determineQualityLevel(finalScore),
      recordCount: records.length,
      validRecords: validationResults.filter(r => r.isValid).length,
      excellentRecords: validationResults.filter(
        r => r.qualityLevel === 'excellent'
      ).length,
      goodRecords: validationResults.filter(r => r.qualityLevel === 'good')
        .length,
      fairRecords: validationResults.filter(r => r.qualityLevel === 'fair')
        .length,
      poorRecords: validationResults.filter(r => r.qualityLevel === 'poor')
        .length,
    };
  }

  // Helper methods

  extractValue(param) {
    if (param === null || param === undefined) return null;
    return typeof param === 'object' ? param.value : param;
  }

  calculateRelativeHumidity(temperature, dewpoint) {
    // Magnus formula for relative humidity calculation
    const a = 17.27;
    const b = 237.7;

    const alpha = (a * temperature) / (b + temperature) + Math.log(1);
    const beta = (a * dewpoint) / (b + dewpoint) + Math.log(1);

    return 100 * Math.exp(beta - alpha);
  }

  getTimeDifferenceHours(timestamp1, timestamp2) {
    const date1 = new Date(timestamp1);
    const date2 = new Date(timestamp2);
    return Math.abs(date2 - date1) / (1000 * 60 * 60);
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  determineQualityLevel(score) {
    if (score >= this.qualityThresholds.excellent) return 'excellent';
    if (score >= this.qualityThresholds.good) return 'good';
    if (score >= this.qualityThresholds.fair) return 'fair';
    if (score >= this.qualityThresholds.poor) return 'poor';
    return 'invalid';
  }

  /**
   * Get validation configuration for different use cases
   */
  getValidationConfig(useCase = 'general') {
    const configs = {
      general: {
        enablePhysicsValidation: true,
        enableRangeValidation: true,
        enableCompletenessCheck: true,
        strictMode: false,
      },
      research: {
        enablePhysicsValidation: true,
        enableRangeValidation: true,
        enableCompletenessCheck: true,
        strictMode: true,
      },
      realtime: {
        enablePhysicsValidation: true,
        enableRangeValidation: true,
        enableCompletenessCheck: false,
        strictMode: false,
      },
      historical: {
        enablePhysicsValidation: true,
        enableRangeValidation: true,
        enableCompletenessCheck: true,
        strictMode: false,
      },
    };

    return configs[useCase] || configs.general;
  }
}

module.exports = WeatherDataValidator;
