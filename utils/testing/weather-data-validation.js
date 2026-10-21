/**
 * Weather Data Validation Testing Utilities
 *
 * Specialized utilities for testing and validating weather data processing:
 * - Data format validation
 * - Consistency checks across time series
 * - Outlier detection
 * - Reference data comparison
 * - Statistical validation
 */

const crypto = require('crypto');

/**
 * Base validator for weather data
 */
class WeatherDataValidator {
  constructor(config = {}) {
    this.tolerances = {
      temperature: config.temperatureTolerance || 0.5, // °C
      humidity: config.humidityTolerance || 2.0, // %
      pressure: config.pressureTolerance || 1.0, // hPa
      windSpeed: config.windSpeedTolerance || 0.5, // m/s
      precipitation: config.precipTolerance || 0.1, // mm
    };

    // Common range limits for weather variables
    this.ranges = {
      temperature: { min: -90, max: 60 }, // °C
      humidity: { min: 0, max: 100 }, // %
      pressure: { min: 870, max: 1085 }, // hPa
      windSpeed: { min: 0, max: 135 }, // m/s
      precipitation: { min: 0, max: 2000 }, // mm (extreme daily value)
    };
  }

  /**
   * Validate a single weather data point
   *
   * @param {Object} dataPoint - Weather data point to validate
   * @returns {Object} Validation result with errors
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

    // Check timestamp format
    if (dataPoint.timestamp && isNaN(new Date(dataPoint.timestamp).getTime())) {
      result.isValid = false;
      result.errors.push('Invalid timestamp format');
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
   * Validate a time series of weather data
   *
   * @param {Array<Object>} timeSeries - Array of weather data points
   * @returns {Object} Validation result with errors
   */
  validateTimeSeries(timeSeries) {
    const result = {
      isValid: true,
      pointErrors: [],
      seriesErrors: [],
    };

    // No data provided
    if (!Array.isArray(timeSeries) || timeSeries.length === 0) {
      result.isValid = false;
      result.seriesErrors.push('No data points provided');
      return result;
    }

    // Validate each data point
    timeSeries.forEach((point, index) => {
      const pointResult = this.validateDataPoint(point);

      if (!pointResult.isValid) {
        result.isValid = false;
        result.pointErrors.push({
          index,
          timestamp: point.timestamp,
          errors: pointResult.errors,
        });
      }
    });

    // Check chronological order
    let lastTimestamp = new Date(timeSeries[0].timestamp).getTime();
    for (let i = 1; i < timeSeries.length; i++) {
      const currentTimestamp = new Date(timeSeries[i].timestamp).getTime();

      if (currentTimestamp <= lastTimestamp) {
        result.isValid = false;
        result.seriesErrors.push(`Non-chronological timestamps at index ${i}`);
      }

      lastTimestamp = currentTimestamp;
    }

    // Check for temporal consistency (no large gaps)
    // This assumes regular time intervals in the data
    const intervals = [];
    for (let i = 1; i < timeSeries.length; i++) {
      const t1 = new Date(timeSeries[i - 1].timestamp).getTime();
      const t2 = new Date(timeSeries[i].timestamp).getTime();
      intervals.push(t2 - t1);
    }

    // Calculate median interval
    const sortedIntervals = [...intervals].sort((a, b) => a - b);
    const medianInterval =
      sortedIntervals[Math.floor(sortedIntervals.length / 2)];

    // Check for gaps (intervals > 3x median)
    for (let i = 0; i < intervals.length; i++) {
      if (intervals[i] > medianInterval * 3) {
        result.seriesErrors.push(
          `Large gap detected between indices ${i} and ${i + 1} (${intervals[i] / 60000} mins)`
        );
      }
    }

    return result;
  }

  /**
   * Detect outliers in a time series using Z-score method
   *
   * @param {Array<Object>} timeSeries - Array of weather data points
   * @param {string} field - Weather variable to check
   * @param {number} threshold - Z-score threshold (default: 3.0)
   * @returns {Array<Object>} Detected outliers with indices
   */
  detectOutliers(timeSeries, field, threshold = 3.0) {
    const outliers = [];

    // Extract values for the specified field
    const values = timeSeries
      .map(point => point[field])
      .filter(val => val !== undefined);

    // Not enough data or field doesn't exist
    if (values.length < 3) {
      return outliers;
    }

    // Calculate mean and standard deviation
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;

    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    const variance =
      squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    // Detect outliers using Z-score
    timeSeries.forEach((point, index) => {
      const value = point[field];

      if (value !== undefined) {
        const zScore = Math.abs((value - mean) / stdDev);

        if (zScore > threshold) {
          outliers.push({
            index,
            timestamp: point.timestamp,
            value,
            zScore,
            mean,
            stdDev,
          });
        }
      }
    });

    return outliers;
  }

  /**
   * Check consistency between different variables (e.g., temperature vs humidity)
   *
   * @param {Array<Object>} timeSeries - Array of weather data points
   * @returns {Array<Object>} Consistency issues found
   */
  checkVariableConsistency(timeSeries) {
    const issues = [];

    timeSeries.forEach((point, index) => {
      // Check temperature and humidity consistency
      if (point.temperature !== undefined && point.humidity !== undefined) {
        // Very high temperature with very high humidity is physically unlikely
        if (point.temperature > 35 && point.humidity > 90) {
          issues.push({
            index,
            timestamp: point.timestamp,
            message: `Unusual combination: high temperature (${point.temperature}°C) with high humidity (${point.humidity}%)`,
          });
        }
      }

      // Check precipitation and humidity
      if (point.precipitation !== undefined && point.humidity !== undefined) {
        // Significant precipitation with low humidity is unusual
        if (point.precipitation > 5 && point.humidity < 50) {
          issues.push({
            index,
            timestamp: point.timestamp,
            message: `Unusual combination: precipitation (${point.precipitation}mm) with low humidity (${point.humidity}%)`,
          });
        }
      }

      // Check pressure changes - rapid changes may indicate sensor issues
      if (
        index > 0 &&
        point.pressure !== undefined &&
        timeSeries[index - 1].pressure !== undefined
      ) {
        const pressureChange = Math.abs(
          point.pressure - timeSeries[index - 1].pressure
        );
        const hoursDiff =
          (new Date(point.timestamp) -
            new Date(timeSeries[index - 1].timestamp)) /
          3600000;

        // Typical max rate of pressure change is ~5-6 hPa per hour
        if (hoursDiff > 0 && pressureChange / hoursDiff > 7) {
          issues.push({
            index,
            timestamp: point.timestamp,
            message: `Unusually rapid pressure change: ${pressureChange.toFixed(1)} hPa in ${hoursDiff.toFixed(1)} hours`,
          });
        }
      }
    });

    return issues;
  }

  /**
   * Calculate temporal consistency metrics for a time series
   *
   * @param {Array<Object>} timeSeries - Array of weather data points
   * @param {string} field - Weather variable to check
   * @returns {Object} Consistency metrics
   */
  calculateTemporalConsistency(timeSeries, field) {
    const result = {
      field,
      meanAbsoluteChange: null,
      maxChange: null,
      changeDistribution: null,
      analysisResult: 'insufficient_data',
    };

    // Need at least 3 data points
    if (!Array.isArray(timeSeries) || timeSeries.length < 3) {
      return result;
    }

    // Calculate point-to-point changes
    const changes = [];
    for (let i = 1; i < timeSeries.length; i++) {
      const prev = timeSeries[i - 1][field];
      const curr = timeSeries[i][field];

      if (prev !== undefined && curr !== undefined) {
        changes.push(Math.abs(curr - prev));
      }
    }

    if (changes.length === 0) {
      return result;
    }

    // Calculate metrics
    result.meanAbsoluteChange =
      changes.reduce((sum, val) => sum + val, 0) / changes.length;
    result.maxChange = Math.max(...changes);

    // Change distribution
    const sorted = [...changes].sort((a, b) => a - b);
    result.changeDistribution = {
      p25: sorted[Math.floor(sorted.length * 0.25)],
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p75: sorted[Math.floor(sorted.length * 0.75)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
    };

    // Set analysis result
    if (result.maxChange > result.changeDistribution.p95 * 5) {
      result.analysisResult = 'possible_anomaly';
    } else {
      result.analysisResult = 'consistent';
    }

    return result;
  }
}

/**
 * Station data validator specifically for weather stations
 */
class StationDataValidator extends WeatherDataValidator {
  constructor(config = {}) {
    super(config);

    // Additional station-specific settings
    this.requiredFields = config.requiredFields || [
      'station_id',
      'timestamp',
      'temperature',
    ];

    // Station metadata validation
    this.metadataFields = config.metadataFields || [
      'station_id',
      'name',
      'latitude',
      'longitude',
      'elevation',
      'station_type',
      'sensors',
    ];
  }

  /**
   * Validate station metadata
   *
   * @param {Object} metadata - Station metadata
   * @returns {Object} Validation result with errors
   */
  validateStationMetadata(metadata) {
    const result = {
      isValid: true,
      errors: [],
    };

    // Check required fields
    for (const field of ['station_id', 'latitude', 'longitude']) {
      if (metadata[field] === undefined) {
        result.isValid = false;
        result.errors.push(`Missing required metadata field: ${field}`);
      }
    }

    // Validate station_id format
    if (
      metadata.station_id &&
      !/^[A-Za-z0-9\-_]{3,32}$/.test(metadata.station_id)
    ) {
      result.isValid = false;
      result.errors.push('Invalid station_id format');
    }

    // Validate coordinates
    if (
      metadata.latitude !== undefined &&
      (typeof metadata.latitude !== 'number' ||
        metadata.latitude < -90 ||
        metadata.latitude > 90)
    ) {
      result.isValid = false;
      result.errors.push(`Invalid latitude: ${metadata.latitude}`);
    }

    if (
      metadata.longitude !== undefined &&
      (typeof metadata.longitude !== 'number' ||
        metadata.longitude < -180 ||
        metadata.longitude > 180)
    ) {
      result.isValid = false;
      result.errors.push(`Invalid longitude: ${metadata.longitude}`);
    }

    // Validate elevation if present
    if (
      metadata.elevation !== undefined &&
      (typeof metadata.elevation !== 'number' ||
        metadata.elevation < -430 || // Dead Sea
        metadata.elevation > 8900)
    ) {
      // Mount Everest + margin
      result.isValid = false;
      result.errors.push(`Invalid elevation: ${metadata.elevation}`);
    }

    // Validate sensors list if present
    if (metadata.sensors) {
      if (!Array.isArray(metadata.sensors)) {
        result.isValid = false;
        result.errors.push('sensors field must be an array');
      } else {
        // Check each sensor
        metadata.sensors.forEach((sensor, index) => {
          if (!sensor.type) {
            result.isValid = false;
            result.errors.push(`Sensor at index ${index} missing type`);
          }

          if (
            sensor.accuracy !== undefined &&
            (typeof sensor.accuracy !== 'number' || sensor.accuracy <= 0)
          ) {
            result.isValid = false;
            result.errors.push(`Invalid accuracy for sensor at index ${index}`);
          }
        });
      }
    }

    return result;
  }

  /**
   * Validate station data records against metadata
   *
   * @param {Array<Object>} dataRecords - Station data records
   * @param {Object} metadata - Station metadata
   * @returns {Object} Validation result
   */
  validateAgainstMetadata(dataRecords, metadata) {
    const result = {
      isValid: true,
      errors: [],
    };

    // Verify station_id matches
    for (const record of dataRecords) {
      if (record.station_id && record.station_id !== metadata.station_id) {
        result.isValid = false;
        result.errors.push(
          `Mismatched station_id: ${record.station_id} (expected ${metadata.station_id})`
        );
        break;
      }
    }

    // Verify coordinates consistency (if present in data)
    for (const record of dataRecords) {
      if (record.latitude !== undefined && record.longitude !== undefined) {
        const latDiff = Math.abs(record.latitude - metadata.latitude);
        const lonDiff = Math.abs(record.longitude - metadata.longitude);

        if (latDiff > 0.01 || lonDiff > 0.01) {
          result.isValid = false;
          result.errors.push(
            `Coordinates mismatch at ${record.timestamp}: [${record.latitude}, ${record.longitude}]`
          );
        }
      }
    }

    // Verify sensor capabilities match reported data
    const availableSensors = new Set(
      (metadata.sensors || []).map(sensor => sensor.type)
    );

    // Check if data contains values for sensors not listed in metadata
    const dataFields = new Set();
    for (const record of dataRecords) {
      for (const field of [
        'temperature',
        'humidity',
        'pressure',
        'windSpeed',
        'precipitation',
      ]) {
        if (record[field] !== undefined) {
          dataFields.add(field);
        }
      }
    }

    // Map data fields to sensor types
    const fieldToSensor = {
      temperature: 'temperature',
      humidity: 'humidity',
      pressure: 'barometer',
      windSpeed: 'anemometer',
      precipitation: 'rain_gauge',
    };

    // Check for data with no corresponding sensor
    for (const field of dataFields) {
      const sensorType = fieldToSensor[field];
      if (sensorType && !availableSensors.has(sensorType)) {
        result.isValid = false;
        result.errors.push(
          `Data contains ${field} readings but no ${sensorType} sensor is registered`
        );
      }
    }

    return result;
  }
}

/**
 * Grid data validator for gridded weather products
 */
class GridDataValidator extends WeatherDataValidator {
  constructor(config = {}) {
    super(config);

    // Grid-specific settings
    this.validateSpatialConsistency =
      config.validateSpatialConsistency !== false;
    this.gridResolution = config.gridResolution || 0.1; // degrees
  }

  /**
   * Validate grid metadata
   *
   * @param {Object} metadata - Grid metadata
   * @returns {Object} Validation result
   */
  validateGridMetadata(metadata) {
    const result = {
      isValid: true,
      errors: [],
    };

    // Check required metadata fields
    for (const field of ['grid_id', 'variable', 'resolution', 'units']) {
      if (!metadata[field]) {
        result.isValid = false;
        result.errors.push(`Missing required grid metadata field: ${field}`);
      }
    }

    // Validate bounds if present
    if (metadata.bounds) {
      const { north, south, east, west } = metadata.bounds;

      if (north <= south) {
        result.isValid = false;
        result.errors.push(
          `Invalid bounds: north (${north}) must be > south (${south})`
        );
      }

      if (north > 90 || south < -90) {
        result.isValid = false;
        result.errors.push(
          `Latitude bounds outside valid range: [${south}, ${north}]`
        );
      }

      if (east < west && Math.abs(east - west) < 359) {
        result.isValid = false;
        result.errors.push(
          `Invalid bounds: east (${east}) must be > west (${west})`
        );
      }

      if (east > 180 || west < -180) {
        result.isValid = false;
        result.errors.push(
          `Longitude bounds outside valid range: [${west}, ${east}]`
        );
      }
    }

    // Validate resolution
    if (metadata.resolution) {
      if (typeof metadata.resolution !== 'number' || metadata.resolution <= 0) {
        result.isValid = false;
        result.errors.push(`Invalid resolution: ${metadata.resolution}`);
      }
    }

    return result;
  }

  /**
   * Validate grid data points
   *
   * @param {Array<Object>} gridPoints - Array of grid data points
   * @returns {Object} Validation result
   */
  validateGridPoints(gridPoints) {
    const result = {
      isValid: true,
      errors: [],
    };

    if (!Array.isArray(gridPoints) || gridPoints.length === 0) {
      result.isValid = false;
      result.errors.push('No grid points provided');
      return result;
    }

    // Check required fields
    for (const point of gridPoints) {
      if (
        point.latitude === undefined ||
        point.longitude === undefined ||
        point.value === undefined
      ) {
        result.isValid = false;
        result.errors.push(
          'Grid point missing required fields (latitude, longitude, value)'
        );
      }
    }

    // Check for duplicate coordinates
    const coordSet = new Set();
    for (const point of gridPoints) {
      const coordKey = `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;

      if (coordSet.has(coordKey)) {
        result.isValid = false;
        result.errors.push(`Duplicate grid point at ${coordKey}`);
      }

      coordSet.add(coordKey);
    }

    // Check grid regularity if there are enough points
    if (gridPoints.length > 10 && this.validateSpatialConsistency) {
      const latitudes = new Set();
      const longitudes = new Set();

      for (const point of gridPoints) {
        latitudes.add(parseFloat(point.latitude.toFixed(6)));
        longitudes.add(parseFloat(point.longitude.toFixed(6)));
      }

      const latArray = Array.from(latitudes).sort((a, b) => a - b);
      const lonArray = Array.from(longitudes).sort((a, b) => a - b);

      // Check if grid is regular by examining intervals
      if (latArray.length > 1) {
        const latIntervals = [];
        for (let i = 1; i < latArray.length; i++) {
          latIntervals.push(
            parseFloat((latArray[i] - latArray[i - 1]).toFixed(6))
          );
        }

        const commonLatInterval = this._getMostCommonValue(latIntervals);
        for (const interval of latIntervals) {
          // Allow small floating point differences
          if (Math.abs(interval - commonLatInterval) > 0.000001) {
            result.isValid = false;
            result.errors.push('Irregular latitude grid spacing detected');
            break;
          }
        }
      }

      if (lonArray.length > 1) {
        const lonIntervals = [];
        for (let i = 1; i < lonArray.length; i++) {
          lonIntervals.push(
            parseFloat((lonArray[i] - lonArray[i - 1]).toFixed(6))
          );
        }

        const commonLonInterval = this._getMostCommonValue(lonIntervals);
        for (const interval of lonIntervals) {
          // Allow small floating point differences
          if (Math.abs(interval - commonLonInterval) > 0.000001) {
            result.isValid = false;
            result.errors.push('Irregular longitude grid spacing detected');
            break;
          }
        }
      }
    }

    return result;
  }

  /**
   * Validate spatial consistency of grid data values
   *
   * @param {Array<Object>} gridPoints - Array of grid data points
   * @returns {Array<Object>} Spatial inconsistencies
   */
  checkSpatialConsistency(gridPoints) {
    const inconsistencies = [];

    // Not enough points for spatial consistency check
    if (!Array.isArray(gridPoints) || gridPoints.length < 10) {
      return inconsistencies;
    }

    // Index gridPoints by lat/lon for efficient lookup
    const gridIndex = new Map();
    for (const point of gridPoints) {
      gridIndex.set(`${point.latitude},${point.longitude}`, point);
    }

    // Check each point against its neighbors
    for (const point of gridPoints) {
      const neighbors = this._getNeighbors(point, gridPoints, gridIndex);

      // Need at least 3 neighbors for a meaningful check
      if (neighbors.length >= 3) {
        const neighborValues = neighbors.map(n => n.value);
        const mean =
          neighborValues.reduce((sum, val) => sum + val, 0) /
          neighborValues.length;
        const diff = Math.abs(point.value - mean);

        // Calculate standard deviation of neighbors
        const squaredDiffs = neighborValues.map(val => Math.pow(val - mean, 2));
        const variance =
          squaredDiffs.reduce((sum, val) => sum + val, 0) /
          neighborValues.length;
        const stdDev = Math.sqrt(variance);

        // Flag if value is significantly different from neighbors (>3 stdDev)
        if (diff > stdDev * 3) {
          inconsistencies.push({
            latitude: point.latitude,
            longitude: point.longitude,
            value: point.value,
            neighborMean: mean,
            neighborStdDev: stdDev,
            zScore: diff / stdDev,
          });
        }
      }
    }

    return inconsistencies;
  }

  /**
   * Find neighbors of a grid point
   *
   * @param {Object} point - Grid point
   * @param {Array<Object>} allPoints - All grid points
   * @param {Map} gridIndex - Index of grid points by coordinates
   * @returns {Array<Object>} Neighboring points
   */
  _getNeighbors(point, allPoints, gridIndex) {
    const neighbors = [];
    const { latitude, longitude } = point;

    // Check the 8 surrounding grid cells
    for (
      let dLat = -this.gridResolution;
      dLat <= this.gridResolution;
      dLat += this.gridResolution
    ) {
      for (
        let dLon = -this.gridResolution;
        dLon <= this.gridResolution;
        dLon += this.gridResolution
      ) {
        // Skip the center point
        if (dLat === 0 && dLon === 0) continue;

        const neighborLat = parseFloat((latitude + dLat).toFixed(6));
        const neighborLon = parseFloat((longitude + dLon).toFixed(6));
        const key = `${neighborLat},${neighborLon}`;

        if (gridIndex.has(key)) {
          neighbors.push(gridIndex.get(key));
        }
      }
    }

    return neighbors;
  }

  /**
   * Get the most common value in an array
   *
   * @param {Array<number>} values - Array of values
   * @returns {number} Most common value
   */
  _getMostCommonValue(values) {
    const counts = {};
    let maxCount = 0;
    let mostCommon = null;

    for (const value of values) {
      counts[value] = (counts[value] || 0) + 1;

      if (counts[value] > maxCount) {
        maxCount = counts[value];
        mostCommon = value;
      }
    }

    return mostCommon;
  }
}

/**
 * Reference data comparator for validating against trusted sources
 */
class ReferenceDataComparator {
  constructor(config = {}) {
    this.tolerances = {
      temperature: config.temperatureTolerance || 2.0, // °C
      humidity: config.humidityTolerance || 5.0, // %
      pressure: config.pressureTolerance || 2.0, // hPa
      windSpeed: config.windSpeedTolerance || 2.0, // m/s
      precipitation: config.precipTolerance || 2.0, // mm
    };

    // Time window for matching reference data (ms)
    this.timeWindow = config.timeWindow || 3600000; // 1 hour

    // Distance threshold for spatial matching (km)
    this.distanceThreshold = config.distanceThreshold || 50.0;
  }

  /**
   * Compare weather data against reference data
   *
   * @param {Array<Object>} testData - Data to validate
   * @param {Array<Object>} referenceData - Trusted reference data
   * @returns {Object} Comparison results
   */
  compareData(testData, referenceData) {
    const results = {
      total: testData.length,
      matched: 0,
      errors: [],
      fieldStats: {},
    };

    // Initialize field stats for commonly compared fields
    for (const field of [
      'temperature',
      'humidity',
      'pressure',
      'windSpeed',
      'precipitation',
    ]) {
      results.fieldStats[field] = {
        compared: 0,
        withinTolerance: 0,
        meanAbsError: 0,
        maxAbsError: 0,
        totalError: 0,
      };
    }

    // Compare each test data point
    for (const testPoint of testData) {
      // Find matching reference data (by time and location)
      const matches = this._findMatches(testPoint, referenceData);

      if (matches.length === 0) {
        results.errors.push({
          timestamp: testPoint.timestamp,
          error: 'No matching reference data found',
        });
        continue;
      }

      results.matched++;

      // For each field, calculate error against reference
      for (const field of Object.keys(this.tolerances)) {
        if (testPoint[field] !== undefined) {
          const fieldResults = this._compareField(testPoint, matches, field);

          // Update field stats
          const stats = results.fieldStats[field];
          stats.compared++;
          stats.totalError += fieldResults.error;
          stats.maxAbsError = Math.max(
            stats.maxAbsError,
            Math.abs(fieldResults.error)
          );

          if (fieldResults.withinTolerance) {
            stats.withinTolerance++;
          } else {
            results.errors.push({
              timestamp: testPoint.timestamp,
              field,
              testValue: testPoint[field],
              referenceValue: fieldResults.referenceValue,
              error: fieldResults.error,
              tolerance: this.tolerances[field],
            });
          }
        }
      }
    }

    // Calculate mean absolute error for each field
    for (const field in results.fieldStats) {
      const stats = results.fieldStats[field];
      if (stats.compared > 0) {
        stats.meanAbsError = stats.totalError / stats.compared;
      }
    }

    return results;
  }

  /**
   * Find matching reference data points for a test point
   *
   * @param {Object} testPoint - Test data point
   * @param {Array<Object>} referenceData - Reference data
   * @returns {Array<Object>} Matching reference points
   */
  _findMatches(testPoint, referenceData) {
    const matches = [];
    const testTime = new Date(testPoint.timestamp).getTime();

    for (const refPoint of referenceData) {
      const refTime = new Date(refPoint.timestamp).getTime();
      const timeDiff = Math.abs(testTime - refTime);

      // Check if within time window
      if (timeDiff <= this.timeWindow) {
        // If coordinates are present, check spatial match
        if (
          testPoint.latitude !== undefined &&
          testPoint.longitude !== undefined &&
          refPoint.latitude !== undefined &&
          refPoint.longitude !== undefined
        ) {
          const distance = this._calculateDistance(
            testPoint.latitude,
            testPoint.longitude,
            refPoint.latitude,
            refPoint.longitude
          );

          if (distance <= this.distanceThreshold) {
            matches.push(refPoint);
          }
        } else {
          // If coordinates not present, match by time only
          matches.push(refPoint);
        }
      }
    }

    return matches;
  }

  /**
   * Compare a specific field against reference data
   *
   * @param {Object} testPoint - Test data point
   * @param {Array<Object>} matches - Matching reference points
   * @param {string} field - Field to compare
   * @returns {Object} Comparison results
   */
  _compareField(testPoint, matches, field) {
    const result = {
      withinTolerance: false,
      error: 0,
      referenceValue: null,
    };

    // Extract reference values for this field
    const refValues = matches.map(m => m[field]).filter(v => v !== undefined);

    if (refValues.length === 0) {
      return result;
    }

    // Calculate average reference value
    const avgRefValue =
      refValues.reduce((sum, val) => sum + val, 0) / refValues.length;
    result.referenceValue = avgRefValue;

    // Calculate error
    const error = Math.abs(testPoint[field] - avgRefValue);
    result.error = error;

    // Check if within tolerance
    if (error <= this.tolerances[field]) {
      result.withinTolerance = true;
    }

    return result;
  }

  /**
   * Calculate distance between two coordinates (Haversine formula)
   *
   * @param {number} lat1 - Latitude of first point
   * @param {number} lon1 - Longitude of first point
   * @param {number} lat2 - Latitude of second point
   * @param {number} lon2 - Longitude of second point
   * @returns {number} Distance in kilometers
   */
  _calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = this._degToRad(lat2 - lat1);
    const dLon = this._degToRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this._degToRad(lat1)) *
        Math.cos(this._degToRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return distance;
  }

  /**
   * Convert degrees to radians
   *
   * @param {number} degrees - Angle in degrees
   * @returns {number} Angle in radians
   */
  _degToRad(degrees) {
    return degrees * (Math.PI / 180);
  }
}

/**
 * Data integrity checker for weather data
 */
class DataIntegrityChecker {
  constructor() {
    this.hashAlgorithm = 'sha256';
  }

  /**
   * Compute hash for a data set
   *
   * @param {Array<Object>} data - Data to hash
   * @returns {string} Hash of the data
   */
  computeDataHash(data) {
    const sortedData = this._sortData(data);
    const jsonString = JSON.stringify(sortedData);

    const hash = crypto.createHash(this.hashAlgorithm);
    hash.update(jsonString);
    return hash.digest('hex');
  }

  /**
   * Sort data consistently for reliable hashing
   *
   * @param {Array<Object>} data - Data to sort
   * @returns {Array<Object>} Sorted data
   */
  _sortData(data) {
    // Clone to avoid modifying original
    const clone = JSON.parse(JSON.stringify(data));

    // First sort by timestamp
    clone.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeA - timeB;
    });

    // Then ensure object keys are in consistent order
    return clone.map(item => {
      const sortedItem = {};
      const keys = Object.keys(item).sort();

      for (const key of keys) {
        sortedItem[key] = item[key];
      }

      return sortedItem;
    });
  }

  /**
   * Check integrity of a segment against known hash
   *
   * @param {Array<Object>} data - Data segment to verify
   * @param {string} expectedHash - Expected hash value
   * @returns {Object} Verification result
   */
  verifyIntegrity(data, expectedHash) {
    const actualHash = this.computeDataHash(data);

    return {
      match: actualHash === expectedHash,
      expectedHash,
      actualHash,
    };
  }

  /**
   * Generate integrity report for a dataset
   *
   * @param {Array<Object>} data - Complete dataset
   * @param {number} segmentSize - Size of each data segment
   * @returns {Object} Integrity report with segment hashes
   */
  generateIntegrityReport(data, segmentSize = 100) {
    const report = {
      createdAt: new Date().toISOString(),
      algorithm: this.hashAlgorithm,
      totalRecords: data.length,
      segmentSize,
      segments: [],
      fullDataHash: this.computeDataHash(data),
    };

    // Process data in segments
    for (let i = 0; i < data.length; i += segmentSize) {
      const segmentEnd = Math.min(i + segmentSize, data.length);
      const segment = data.slice(i, segmentEnd);

      report.segments.push({
        index: Math.floor(i / segmentSize),
        startIndex: i,
        endIndex: segmentEnd - 1,
        records: segment.length,
        hash: this.computeDataHash(segment),
      });
    }

    return report;
  }
}

module.exports = {
  WeatherDataValidator,
  StationDataValidator,
  GridDataValidator,
  ReferenceDataComparator,
  DataIntegrityChecker,
};
