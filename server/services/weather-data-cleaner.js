/**
 * Weather Data Cleaning and Preprocessing Service
 *
 * Handles data cleaning operations including:
 * - Missing value detection and handling
 * - Unit conversions to standardized formats
 * - Outlier detection and correction
 * - Data normalization and standardization
 * - Quality flag assignment
 */

const { logger } = require('../utils/logger');
const {
  UnitConversions,
  DefaultValues,
  ValidationRules,
  QualityFlags,
} = require('./weather-data-schema');

class WeatherDataCleaner {
  constructor() {
    this.cleaningStrategies = {
      temperature: {
        missingValueStrategy: 'interpolate',
        outlierDetection: 'zscore',
        outlierThreshold: 3,
        interpolationMethod: 'linear',
      },
      humidity: {
        missingValueStrategy: 'default',
        outlierDetection: 'iqr',
        outlierThreshold: 1.5,
        defaultValue: null,
      },
      pressure: {
        missingValueStrategy: 'interpolate',
        outlierDetection: 'zscore',
        outlierThreshold: 2.5,
        interpolationMethod: 'linear',
      },
      windSpeed: {
        missingValueStrategy: 'default',
        outlierDetection: 'range',
        defaultValue: 0,
      },
      windDirection: {
        missingValueStrategy: 'skip',
        outlierDetection: 'range',
      },
      precipitation: {
        missingValueStrategy: 'default',
        outlierDetection: 'iqr',
        outlierThreshold: 2,
        defaultValue: 0,
      },
    };
  }

  /**
   * Clean a weather data record
   */
  async cleanWeatherRecord(rawData, options = {}) {
    const {
      enableMissingValueHandling = true,
      enableUnitConversion = true,
      enableOutlierDetection = true,
      enableNormalization = true,
      strictMode = false,
    } = options;

    const cleaningResult = {
      originalData: rawData,
      cleanedData: JSON.parse(JSON.stringify(rawData)), // Deep copy
      cleaningActions: [],
      qualityFlags: {},
      errors: [],
      warnings: [],
      overallQuality: 'excellent',
    };

    try {
      // Step 1: Handle missing values
      if (enableMissingValueHandling) {
        await this.handleMissingValues(cleaningResult);
      }

      // Step 2: Convert units to standardized format
      if (enableUnitConversion) {
        await this.convertUnits(cleaningResult);
      }

      // Step 3: Detect and handle outliers
      if (enableOutlierDetection) {
        await this.detectAndHandleOutliers(cleaningResult);
      }

      // Step 4: Normalize and standardize data
      if (enableNormalization) {
        await this.normalizeData(cleaningResult);
      }

      // Step 5: Assign quality flags
      this.assignQualityFlags(cleaningResult);

      // Step 6: Calculate overall quality
      this.calculateOverallQuality(cleaningResult);

      logger.debug('Weather data cleaning completed', {
        originalFields: Object.keys(rawData).length,
        cleanedFields: Object.keys(cleaningResult.cleanedData).length,
        actionsPerformed: cleaningResult.cleaningActions.length,
        overallQuality: cleaningResult.overallQuality,
      });

      return cleaningResult;
    } catch (error) {
      logger.error('Error during weather data cleaning:', {
        error: error.message,
        rawData: rawData,
      });

      cleaningResult.errors.push(`Cleaning error: ${error.message}`);
      cleaningResult.overallQuality = 'invalid';

      return cleaningResult;
    }
  }

  /**
   * Handle missing values using various strategies
   */
  async handleMissingValues(cleaningResult) {
    const { cleanedData, cleaningActions, qualityFlags } = cleaningResult;

    Object.keys(cleanedData.measurements || {}).forEach(param => {
      const measurement = cleanedData.measurements[param];
      const strategy = this.cleaningStrategies[param];

      if (
        !measurement ||
        measurement.value === null ||
        measurement.value === undefined
      ) {
        const action = this.applyMissingValueStrategy(
          param,
          measurement,
          strategy
        );

        if (action.applied) {
          cleaningActions.push({
            type: 'missing_value_handling',
            parameter: param,
            strategy: action.strategy,
            originalValue: null,
            newValue: action.newValue,
            timestamp: new Date().toISOString(),
          });

          // Update the measurement
          if (cleanedData.measurements[param]) {
            cleanedData.measurements[param].value = action.newValue;
            cleanedData.measurements[param].qualityFlag = action.qualityFlag;
          } else {
            cleanedData.measurements[param] = {
              value: action.newValue,
              unit: this.getStandardUnit(param),
              qualityFlag: action.qualityFlag,
            };
          }

          qualityFlags[param] = action.qualityFlag;
        }
      }
    });
  }

  /**
   * Apply missing value strategy for a parameter
   */
  applyMissingValueStrategy(param, measurement, strategy) {
    if (!strategy) {
      return { applied: false };
    }

    switch (strategy.missingValueStrategy) {
      case 'default':
        return {
          applied: true,
          strategy: 'default',
          newValue:
            strategy.defaultValue !== undefined
              ? strategy.defaultValue
              : DefaultValues[param],
          qualityFlag: 'I', // Interpolated/Inferred
        };

      case 'interpolate':
        // For now, use default value. In future, could implement temporal interpolation
        return {
          applied: true,
          strategy: 'interpolate',
          newValue: DefaultValues[param],
          qualityFlag: 'I',
        };

      case 'skip':
        return { applied: false };

      default:
        return { applied: false };
    }
  }

  /**
   * Convert units to standardized format
   */
  async convertUnits(cleaningResult) {
    const { cleanedData, cleaningActions } = cleaningResult;

    Object.keys(cleanedData.measurements || {}).forEach(param => {
      const measurement = cleanedData.measurements[param];

      if (
        !measurement ||
        measurement.value === null ||
        measurement.value === undefined
      ) {
        return;
      }

      const conversion = this.getUnitConversion(
        param,
        measurement.unit,
        measurement.value
      );

      if (conversion.converted) {
        cleaningActions.push({
          type: 'unit_conversion',
          parameter: param,
          originalValue: measurement.value,
          originalUnit: measurement.unit,
          newValue: conversion.newValue,
          newUnit: conversion.newUnit,
          conversionFactor: conversion.factor,
          timestamp: new Date().toISOString(),
        });

        measurement.value = conversion.newValue;
        measurement.unit = conversion.newUnit;
      }
    });
  }

  /**
   * Get unit conversion for a parameter
   */
  getUnitConversion(param, currentUnit, value) {
    if (!currentUnit || !value) {
      return { converted: false };
    }

    const standardUnit = this.getStandardUnit(param);
    const unitLower = currentUnit.toLowerCase();

    // Check if conversion is needed
    if (
      unitLower === standardUnit ||
      this.isEquivalentUnit(unitLower, standardUnit)
    ) {
      return { converted: false };
    }

    // Apply conversion based on parameter type
    let convertedValue = value;
    let factor = 1;

    switch (param) {
      case 'temperature':
      case 'temperatureMax':
      case 'temperatureMin':
      case 'dewpoint':
        if (unitLower.includes('f') || unitLower.includes('fahrenheit')) {
          convertedValue = UnitConversions.temperature.fahrenheit(value);
          factor = 'fahrenheit_to_celsius';
        } else if (unitLower.includes('k') || unitLower.includes('kelvin')) {
          convertedValue = UnitConversions.temperature.kelvin(value);
          factor = 'kelvin_to_celsius';
        } else if (unitLower.includes('r') || unitLower.includes('rankine')) {
          convertedValue = UnitConversions.temperature.rankine(value);
          factor = 'rankine_to_celsius';
        }
        break;

      case 'pressure':
      case 'pressureSeaLevel':
        if (unitLower.includes('pa') && !unitLower.includes('hpa')) {
          convertedValue = UnitConversions.pressure.pa(value);
          factor = 'pa_to_hpa';
        } else if (unitLower.includes('kpa')) {
          convertedValue = UnitConversions.pressure.kpa(value);
          factor = 'kpa_to_hpa';
        } else if (unitLower.includes('mmhg')) {
          convertedValue = UnitConversions.pressure.mmhg(value);
          factor = 'mmhg_to_hpa';
        } else if (unitLower.includes('inhg')) {
          convertedValue = UnitConversions.pressure.inhg(value);
          factor = 'inhg_to_hpa';
        } else if (unitLower.includes('psi')) {
          convertedValue = UnitConversions.pressure.psi(value);
          factor = 'psi_to_hpa';
        } else if (unitLower.includes('bar') && !unitLower.includes('mbar')) {
          convertedValue = UnitConversions.pressure.bar(value);
          factor = 'bar_to_hpa';
        } else if (unitLower.includes('mbar')) {
          convertedValue = UnitConversions.pressure.mbar(value);
          factor = 'mbar_to_hpa';
        }
        break;

      case 'windSpeed':
      case 'windGust':
        if (
          unitLower.includes('km') ||
          unitLower.includes('kmh') ||
          unitLower.includes('km/h')
        ) {
          convertedValue = UnitConversions.windSpeed.kmh(value);
          factor = 'kmh_to_ms';
        } else if (unitLower.includes('mph') || unitLower.includes('mile')) {
          convertedValue = UnitConversions.windSpeed.mph(value);
          factor = 'mph_to_ms';
        } else if (unitLower.includes('knot') || unitLower.includes('kt')) {
          convertedValue = UnitConversions.windSpeed.knots(value);
          factor = 'knots_to_ms';
        } else if (unitLower.includes('fps') || unitLower.includes('ft/s')) {
          convertedValue = UnitConversions.windSpeed.fps(value);
          factor = 'fps_to_ms';
        }
        break;

      case 'visibility':
        if (unitLower.includes('m') && !unitLower.includes('km')) {
          convertedValue = UnitConversions.distance.meters(value);
          factor = 'm_to_km';
        } else if (unitLower.includes('mile') || unitLower.includes('mi')) {
          convertedValue = UnitConversions.distance.miles(value);
          factor = 'miles_to_km';
        } else if (unitLower.includes('ft') || unitLower.includes('feet')) {
          convertedValue = UnitConversions.distance.feet(value);
          factor = 'feet_to_km';
        } else if (unitLower.includes('nm') || unitLower.includes('nautical')) {
          convertedValue = UnitConversions.distance.nauticalMiles(value);
          factor = 'nm_to_km';
        }
        break;

      case 'precipitation':
      case 'precipitationAccumulation':
      case 'snowfall':
        if (unitLower.includes('in') || unitLower.includes('inch')) {
          convertedValue = UnitConversions.precipitation.inches(value);
          factor = 'inches_to_mm';
        } else if (unitLower.includes('cm')) {
          convertedValue = UnitConversions.precipitation.cm(value);
          factor = 'cm_to_mm';
        } else if (unitLower.includes('m') && !unitLower.includes('mm')) {
          convertedValue = UnitConversions.precipitation.meters(value);
          factor = 'm_to_mm';
        }
        break;
    }

    if (convertedValue !== value) {
      return {
        converted: true,
        newValue: Math.round(convertedValue * 100) / 100, // Round to 2 decimal places
        newUnit: standardUnit,
        factor: factor,
      };
    }

    return { converted: false };
  }

  /**
   * Detect and handle outliers
   */
  async detectAndHandleOutliers(cleaningResult) {
    const { cleanedData, cleaningActions, warnings } = cleaningResult;

    Object.keys(cleanedData.measurements || {}).forEach(param => {
      const measurement = cleanedData.measurements[param];
      const strategy = this.cleaningStrategies[param];

      if (
        !measurement ||
        measurement.value === null ||
        measurement.value === undefined ||
        !strategy
      ) {
        return;
      }

      const outlierCheck = this.detectOutlier(
        param,
        measurement.value,
        strategy
      );

      if (outlierCheck.isOutlier) {
        cleaningActions.push({
          type: 'outlier_detection',
          parameter: param,
          value: measurement.value,
          method: strategy.outlierDetection,
          threshold: strategy.outlierThreshold,
          reason: outlierCheck.reason,
          action: 'flagged',
          timestamp: new Date().toISOString(),
        });

        warnings.push(
          `Outlier detected for ${param}: ${measurement.value} (${outlierCheck.reason})`
        );

        // Flag as suspicious but don't modify the value
        measurement.qualityFlag = 'S'; // Suspected
      }
    });
  }

  /**
   * Detect if a value is an outlier
   */
  detectOutlier(param, value, strategy) {
    const validationRule = ValidationRules[param];

    if (!validationRule) {
      return { isOutlier: false };
    }

    // Range-based outlier detection
    if (strategy.outlierDetection === 'range') {
      if (value < validationRule.min || value > validationRule.max) {
        return {
          isOutlier: true,
          reason: `Value ${value} outside valid range [${validationRule.min}, ${validationRule.max}]`,
        };
      }
    }

    // Z-score based detection (simplified - would need historical data for proper implementation)
    if (strategy.outlierDetection === 'zscore') {
      const expectedRange = validationRule.max - validationRule.min;
      const expectedMean = (validationRule.max + validationRule.min) / 2;
      const expectedStd = expectedRange / 6; // Rough approximation

      const zscore = Math.abs(value - expectedMean) / expectedStd;

      if (zscore > strategy.outlierThreshold) {
        return {
          isOutlier: true,
          reason: `Z-score ${zscore.toFixed(2)} exceeds threshold ${strategy.outlierThreshold}`,
        };
      }
    }

    return { isOutlier: false };
  }

  /**
   * Normalize and standardize data
   */
  async normalizeData(cleaningResult) {
    const { cleanedData, cleaningActions } = cleaningResult;

    // Round numeric values to appropriate precision
    Object.keys(cleanedData.measurements || {}).forEach(param => {
      const measurement = cleanedData.measurements[param];

      if (
        !measurement ||
        measurement.value === null ||
        measurement.value === undefined
      ) {
        return;
      }

      const precision = this.getParameterPrecision(param);
      const originalValue = measurement.value;
      const normalizedValue =
        Math.round(measurement.value * Math.pow(10, precision)) /
        Math.pow(10, precision);

      if (originalValue !== normalizedValue) {
        cleaningActions.push({
          type: 'normalization',
          parameter: param,
          originalValue: originalValue,
          normalizedValue: normalizedValue,
          precision: precision,
          timestamp: new Date().toISOString(),
        });

        measurement.value = normalizedValue;
      }
    });
  }

  /**
   * Assign quality flags to measurements
   */
  assignQualityFlags(cleaningResult) {
    const { cleanedData, cleaningActions, qualityFlags } = cleaningResult;

    Object.keys(cleanedData.measurements || {}).forEach(param => {
      const measurement = cleanedData.measurements[param];

      if (!measurement) {
        return;
      }

      // If quality flag not already assigned, determine based on cleaning actions
      if (!measurement.qualityFlag) {
        const paramActions = cleaningActions.filter(
          action => action.parameter === param
        );

        if (paramActions.length === 0) {
          measurement.qualityFlag = 'A'; // Excellent - no modifications needed
        } else if (
          paramActions.some(action => action.type === 'outlier_detection')
        ) {
          measurement.qualityFlag = 'S'; // Suspected
        } else if (
          paramActions.some(action => action.type === 'missing_value_handling')
        ) {
          measurement.qualityFlag = 'I'; // Interpolated
        } else {
          measurement.qualityFlag = 'B'; // Good - minor modifications
        }
      }

      qualityFlags[param] = measurement.qualityFlag;
    });
  }

  /**
   * Calculate overall quality score
   */
  calculateOverallQuality(cleaningResult) {
    const { qualityFlags, errors, warnings } = cleaningResult;

    let totalScore = 0;
    let paramCount = 0;

    Object.values(qualityFlags).forEach(flag => {
      paramCount++;
      switch (flag) {
        case 'A':
          totalScore += 1.0;
          break;
        case 'B':
          totalScore += 0.9;
          break;
        case 'C':
          totalScore += 0.7;
          break;
        case 'I':
          totalScore += 0.6;
          break;
        case 'S':
          totalScore += 0.4;
          break;
        case 'D':
          totalScore += 0.3;
          break;
        case 'E':
          totalScore += 0.1;
          break;
        default:
          totalScore += 0.5;
          break;
      }
    });

    if (paramCount === 0) {
      cleaningResult.overallQuality = 'invalid';
      return;
    }

    const averageScore = totalScore / paramCount;

    // Penalize for errors and warnings
    const errorPenalty = errors.length * 0.2;
    const warningPenalty = warnings.length * 0.1;

    const finalScore = Math.max(
      0,
      averageScore - errorPenalty - warningPenalty
    );

    if (finalScore >= 0.9) {
      cleaningResult.overallQuality = 'excellent';
    } else if (finalScore >= 0.7) {
      cleaningResult.overallQuality = 'good';
    } else if (finalScore >= 0.5) {
      cleaningResult.overallQuality = 'fair';
    } else if (finalScore >= 0.3) {
      cleaningResult.overallQuality = 'poor';
    } else {
      cleaningResult.overallQuality = 'invalid';
    }

    cleaningResult.qualityScore = finalScore;
  }

  // Helper methods

  getStandardUnit(param) {
    const standardUnits = {
      temperature: 'celsius',
      temperatureMax: 'celsius',
      temperatureMin: 'celsius',
      dewpoint: 'celsius',
      humidity: 'percent',
      pressure: 'hpa',
      pressureSeaLevel: 'hpa',
      windSpeed: 'm/s',
      windGust: 'm/s',
      windDirection: 'degrees',
      precipitation: 'mm',
      precipitationAccumulation: 'mm',
      visibility: 'km',
      cloudCoverage: 'percent',
      snowfall: 'mm',
      snowDepth: 'mm',
      solarRadiation: 'w/m2',
      uvIndex: 'index',
    };

    return standardUnits[param] || 'unknown';
  }

  isEquivalentUnit(unit1, unit2) {
    const equivalentUnits = {
      celsius: ['c', 'degc', '°c'],
      fahrenheit: ['f', 'degf', '°f'],
      kelvin: ['k'],
      percent: ['%', 'percentage'],
      hpa: ['hectopascal', 'hpascal'],
      'm/s': ['ms', 'mps', 'meters_per_second'],
      'km/h': ['kmh', 'kph', 'kilometers_per_hour'],
      mph: ['miles_per_hour'],
      degrees: ['deg', '°'],
      mm: ['millimeter', 'millimeters'],
      km: ['kilometer', 'kilometers'],
    };

    for (const [standard, equivalents] of Object.entries(equivalentUnits)) {
      if (
        (unit1 === standard || equivalents.includes(unit1)) &&
        (unit2 === standard || equivalents.includes(unit2))
      ) {
        return true;
      }
    }

    return false;
  }

  getParameterPrecision(param) {
    const precisionMap = {
      temperature: 1,
      temperatureMax: 1,
      temperatureMin: 1,
      dewpoint: 1,
      humidity: 0,
      pressure: 1,
      pressureSeaLevel: 1,
      windSpeed: 1,
      windGust: 1,
      windDirection: 0,
      precipitation: 1,
      precipitationAccumulation: 1,
      visibility: 1,
      cloudCoverage: 0,
      snowfall: 1,
      snowDepth: 1,
      solarRadiation: 0,
      uvIndex: 0,
    };

    return precisionMap[param] || 2;
  }

  /**
   * Clean multiple weather records in batch
   */
  async cleanWeatherBatch(rawDataArray, options = {}) {
    const results = [];

    for (const rawData of rawDataArray) {
      try {
        const result = await this.cleanWeatherRecord(rawData, options);
        results.push(result);
      } catch (error) {
        logger.error('Error cleaning weather record in batch:', {
          error: error.message,
        });
        results.push({
          originalData: rawData,
          cleanedData: null,
          cleaningActions: [],
          qualityFlags: {},
          errors: [`Cleaning failed: ${error.message}`],
          warnings: [],
          overallQuality: 'invalid',
        });
      }
    }

    return results;
  }

  /**
   * Get cleaning statistics for a batch of results
   */
  getCleaningStatistics(cleaningResults) {
    const stats = {
      totalRecords: cleaningResults.length,
      qualityDistribution: {
        excellent: 0,
        good: 0,
        fair: 0,
        poor: 0,
        invalid: 0,
      },
      cleaningActions: {
        missing_value_handling: 0,
        unit_conversion: 0,
        outlier_detection: 0,
        normalization: 0,
      },
      mostCommonIssues: {},
      averageQualityScore: 0,
    };

    cleaningResults.forEach(result => {
      // Quality distribution
      stats.qualityDistribution[result.overallQuality]++;

      // Cleaning actions
      result.cleaningActions.forEach(action => {
        stats.cleaningActions[action.type]++;
      });

      // Quality score
      if (result.qualityScore) {
        stats.averageQualityScore += result.qualityScore;
      }

      // Common issues
      result.warnings.concat(result.errors).forEach(issue => {
        const issueType = issue.split(':')[0]; // Get issue type from message
        stats.mostCommonIssues[issueType] =
          (stats.mostCommonIssues[issueType] || 0) + 1;
      });
    });

    stats.averageQualityScore =
      stats.averageQualityScore / cleaningResults.length;

    return stats;
  }
}

module.exports = WeatherDataCleaner;
