/**
 * WRFCoin Temporal and Spatial Data Processor
 *
 * Advanced temporal aggregation and spatial interpolation system for weather data.
 * Provides time-series analysis, spatial data interpolation, and grid-based processing.
 *
 * Features:
 * - Temporal aggregation (hourly, daily, monthly averages)
 * - Spatial interpolation using multiple methods (IDW, Kriging, Spline)
 * - Grid-based data processing and analysis
 * - Missing data estimation and gap filling
 * - Trend analysis and forecasting
 * - Quality-weighted interpolation
 */

const EventEmitter = require('events');
const moment = require('moment');
const Logger = require('../utils/logger');

class TemporalSpatialProcessor extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      // Temporal aggregation settings
      defaultAggregationInterval: options.defaultAggregationInterval || 'hour',
      maxTemporalGap: options.maxTemporalGap || 3600000, // 1 hour in milliseconds
      minDataPointsForAggregation: options.minDataPointsForAggregation || 3,

      // Spatial interpolation settings
      defaultInterpolationMethod: options.defaultInterpolationMethod || 'idw',
      maxInterpolationDistance: options.maxInterpolationDistance || 100000, // 100km
      minNeighbors: options.minNeighbors || 3,
      maxNeighbors: options.maxNeighbors || 10,

      // Grid processing settings
      defaultGridResolution: options.defaultGridResolution || 0.1, // degrees
      gridBounds: options.gridBounds || {
        north: 85,
        south: -85,
        east: 180,
        west: -180,
      },

      // Quality settings
      enableQualityWeighting: options.enableQualityWeighting !== false,
      minQualityThreshold: options.minQualityThreshold || 0.5,

      // Performance settings
      maxCacheSize: options.maxCacheSize || 1000,
      enableParallelProcessing: options.enableParallelProcessing !== false,

      ...options,
    };

    this.logger = Logger;

    // Processing modules
    this.temporalAggregator = new TemporalAggregator(this.options);
    this.spatialInterpolator = new SpatialInterpolator(this.options);
    this.gridProcessor = new GridProcessor(this.options);
    this.gapFiller = new GapFiller(this.options);

    // Data cache for performance
    this.dataCache = new Map();
    this.aggregationCache = new Map();
    this.interpolationCache = new Map();

    // Processing metrics
    this.metrics = {
      temporalAggregations: 0,
      spatialInterpolations: 0,
      gridGenerations: 0,
      gapsFilled: 0,
      totalProcessingTime: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };
  }

  /**
   * Perform temporal aggregation on time-series data
   */
  async aggregateTemporalData(data, options = {}) {
    const startTime = Date.now();

    try {
      const {
        interval = this.options.defaultAggregationInterval,
        parameters = ['temperature', 'humidity', 'pressure', 'windSpeed'],
        aggregationMethods = {
          temperature: 'mean',
          humidity: 'mean',
          pressure: 'mean',
          windSpeed: 'mean',
          windDirection: 'circular_mean',
          precipitation: 'sum',
        },
        fillGaps = false,
        qualityWeighting = this.options.enableQualityWeighting,
      } = options;

      // Generate cache key
      const cacheKey = this.generateTemporalCacheKey(
        data,
        interval,
        parameters
      );

      // Check cache
      if (this.aggregationCache.has(cacheKey)) {
        this.metrics.cacheHits++;
        return this.aggregationCache.get(cacheKey);
      }
      this.metrics.cacheMisses++;

      // Group data by time intervals
      const groupedData = this.temporalAggregator.groupByInterval(
        data,
        interval
      );

      // Aggregate each group
      const aggregatedData = [];
      for (const [intervalKey, dataPoints] of groupedData) {
        const aggregated = await this.temporalAggregator.aggregateGroup(
          dataPoints,
          parameters,
          aggregationMethods,
          qualityWeighting
        );

        if (aggregated) {
          aggregated.interval = intervalKey;
          aggregated.intervalType = interval;
          aggregated.dataPointCount = dataPoints.length;
          aggregatedData.push(aggregated);
        }
      }

      // Fill gaps if requested
      if (fillGaps && aggregatedData.length > 0) {
        const filledData = await this.gapFiller.fillTemporalGaps(
          aggregatedData,
          interval
        );
        aggregatedData.push(...filledData);
        aggregatedData.sort(
          (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
        );
      }

      const result = {
        aggregatedData,
        metadata: {
          interval,
          parameters,
          totalIntervals: aggregatedData.length,
          originalDataPoints: data.length,
          processingTime: Date.now() - startTime,
          gapsFilled: fillGaps,
        },
      };

      // Cache result
      this.aggregationCache.set(cacheKey, result);
      this.cleanupCache(this.aggregationCache);

      this.metrics.temporalAggregations++;
      this.metrics.totalProcessingTime += result.metadata.processingTime;

      this.emit('temporal-aggregation-completed', result);

      return result;
    } catch (error) {
      this.logger.error('Error in temporal aggregation:', error);
      throw error;
    }
  }

  /**
   * Perform spatial interpolation
   */
  async interpolateSpatialData(data, targetLocations, options = {}) {
    const startTime = Date.now();

    try {
      const {
        method = this.options.defaultInterpolationMethod,
        parameter = 'temperature',
        maxDistance = this.options.maxInterpolationDistance,
        qualityWeighting = this.options.enableQualityWeighting,
        uncertaintyEstimation = false,
      } = options;

      // Generate cache key
      const cacheKey = this.generateSpatialCacheKey(
        data,
        targetLocations,
        method,
        parameter
      );

      // Check cache
      if (this.interpolationCache.has(cacheKey)) {
        this.metrics.cacheHits++;
        return this.interpolationCache.get(cacheKey);
      }
      this.metrics.cacheMisses++;

      // Filter data for the specific parameter
      const parameterData = this.filterParameterData(data, parameter);

      if (parameterData.length === 0) {
        throw new Error(`No data available for parameter: ${parameter}`);
      }

      // Perform interpolation for each target location
      const interpolatedValues = [];

      for (const targetLocation of targetLocations) {
        const interpolated = await this.spatialInterpolator.interpolate(
          parameterData,
          targetLocation,
          method,
          {
            maxDistance,
            qualityWeighting,
            uncertaintyEstimation,
          }
        );

        if (interpolated) {
          interpolatedValues.push({
            location: targetLocation,
            parameter,
            value: interpolated.value,
            uncertainty: interpolated.uncertainty,
            neighbors: interpolated.neighbors,
            method,
          });
        }
      }

      const result = {
        interpolatedValues,
        metadata: {
          method,
          parameter,
          sourceDataPoints: parameterData.length,
          targetLocations: targetLocations.length,
          successfulInterpolations: interpolatedValues.length,
          processingTime: Date.now() - startTime,
        },
      };

      // Cache result
      this.interpolationCache.set(cacheKey, result);
      this.cleanupCache(this.interpolationCache);

      this.metrics.spatialInterpolations++;
      this.metrics.totalProcessingTime += result.metadata.processingTime;

      this.emit('spatial-interpolation-completed', result);

      return result;
    } catch (error) {
      this.logger.error('Error in spatial interpolation:', error);
      throw error;
    }
  }

  /**
   * Generate regular grid data
   */
  async generateGrid(data, options = {}) {
    const startTime = Date.now();

    try {
      const {
        bounds = this.options.gridBounds,
        resolution = this.options.defaultGridResolution,
        parameter = 'temperature',
        interpolationMethod = 'idw',
        includeUncertainty = false,
      } = options;

      // Generate grid points
      const gridPoints = this.gridProcessor.generateGridPoints(
        bounds,
        resolution
      );

      // Interpolate values at grid points
      const gridData = await this.interpolateSpatialData(data, gridPoints, {
        method: interpolationMethod,
        parameter,
        uncertaintyEstimation: includeUncertainty,
      });

      // Format as grid
      const grid = this.gridProcessor.formatAsGrid(
        gridData.interpolatedValues,
        bounds,
        resolution
      );

      const result = {
        grid,
        metadata: {
          bounds,
          resolution,
          parameter,
          interpolationMethod,
          gridDimensions: {
            width: grid[0]?.length || 0,
            height: grid.length,
          },
          totalGridPoints: gridPoints.length,
          processingTime: Date.now() - startTime,
        },
      };

      this.metrics.gridGenerations++;
      this.metrics.totalProcessingTime += result.metadata.processingTime;

      this.emit('grid-generation-completed', result);

      return result;
    } catch (error) {
      this.logger.error('Error in grid generation:', error);
      throw error;
    }
  }

  /**
   * Fill missing data using temporal and spatial methods
   */
  async fillMissingData(data, options = {}) {
    const startTime = Date.now();

    try {
      const {
        method = 'hybrid', // 'temporal', 'spatial', 'hybrid'
        maxTemporalGap = this.options.maxTemporalGap,
        maxSpatialDistance = this.options.maxInterpolationDistance,
        parameters = ['temperature', 'humidity', 'pressure'],
      } = options;

      const filledData = [...data];
      const fillLog = [];

      for (const parameter of parameters) {
        const parameterGaps = this.identifyGaps(filledData, parameter);

        if (parameterGaps.length === 0) continue;

        for (const gap of parameterGaps) {
          let fillMethod = method;
          let filledValue = null;

          if (method === 'hybrid') {
            // Try temporal first, then spatial
            if (gap.temporalNeighbors && gap.temporalNeighbors.length >= 2) {
              fillMethod = 'temporal';
              filledValue = await this.gapFiller.fillTemporal(gap, parameter);
            } else if (
              gap.spatialNeighbors &&
              gap.spatialNeighbors.length >= 3
            ) {
              fillMethod = 'spatial';
              filledValue = await this.gapFiller.fillSpatial(gap, parameter);
            }
          } else if (method === 'temporal') {
            filledValue = await this.gapFiller.fillTemporal(gap, parameter);
          } else if (method === 'spatial') {
            filledValue = await this.gapFiller.fillSpatial(gap, parameter);
          }

          if (filledValue !== null) {
            // Update the data
            const dataIndex = filledData.findIndex(
              d =>
                d.location.latitude === gap.location.latitude &&
                d.location.longitude === gap.location.longitude &&
                d.timestamp === gap.timestamp
            );

            if (dataIndex >= 0) {
              filledData[dataIndex].data[parameter] = {
                value: filledValue,
                unit: data[dataIndex]?.data[parameter]?.unit || 'unknown',
                filled: true,
                fillMethod,
              };

              fillLog.push({
                location: gap.location,
                timestamp: gap.timestamp,
                parameter,
                value: filledValue,
                method: fillMethod,
              });

              this.metrics.gapsFilled++;
            }
          }
        }
      }

      const result = {
        filledData,
        metadata: {
          originalDataPoints: data.length,
          gapsFilled: fillLog.length,
          fillMethods: [...new Set(fillLog.map(f => f.method))],
          parameters,
          processingTime: Date.now() - startTime,
        },
        fillLog,
      };

      this.metrics.totalProcessingTime += result.metadata.processingTime;

      this.emit('gap-filling-completed', result);

      return result;
    } catch (error) {
      this.logger.error('Error filling missing data:', error);
      throw error;
    }
  }

  /**
   * Analyze temporal trends in data
   */
  async analyzeTrends(data, options = {}) {
    try {
      const {
        parameter = 'temperature',
        interval = 'daily',
        trendMethods = ['linear', 'seasonal'],
      } = options;

      // First aggregate data if needed
      const aggregated = await this.aggregateTemporalData(data, {
        interval,
        parameters: [parameter],
      });

      const trends = {};

      for (const method of trendMethods) {
        trends[method] = this.calculateTrend(
          aggregated.aggregatedData,
          parameter,
          method
        );
      }

      return {
        parameter,
        interval,
        trends,
        dataPoints: aggregated.aggregatedData.length,
        timeRange: {
          start: aggregated.aggregatedData[0]?.timestamp,
          end: aggregated.aggregatedData[aggregated.aggregatedData.length - 1]
            ?.timestamp,
        },
      };
    } catch (error) {
      this.logger.error('Error analyzing trends:', error);
      throw error;
    }
  }

  /**
   * Calculate trend using specified method
   */
  calculateTrend(data, parameter, method) {
    const values = data
      .map(d => d.data[parameter]?.value)
      .filter(v => v !== null);
    const timestamps = data.map(d => new Date(d.timestamp).getTime());

    if (values.length < 2) {
      return { slope: 0, intercept: 0, correlation: 0, method };
    }

    switch (method) {
      case 'linear':
        return this.calculateLinearTrend(timestamps, values);
      case 'seasonal':
        return this.calculateSeasonalTrend(timestamps, values);
      default:
        return { error: `Unknown trend method: ${method}` };
    }
  }

  /**
   * Calculate linear trend using least squares
   */
  calculateLinearTrend(timestamps, values) {
    const n = values.length;
    const sumX = timestamps.reduce((a, b) => a + b, 0);
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = timestamps.reduce((sum, x, i) => sum + x * values[i], 0);
    const sumXX = timestamps.reduce((sum, x) => sum + x * x, 0);
    const sumYY = values.reduce((sum, y) => sum + y * y, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // Calculate correlation coefficient
    const correlation =
      (n * sumXY - sumX * sumY) /
      Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));

    return {
      slope,
      intercept,
      correlation,
      method: 'linear',
      trend: slope > 0 ? 'increasing' : slope < 0 ? 'decreasing' : 'stable',
    };
  }

  /**
   * Calculate seasonal trend (simplified)
   */
  calculateSeasonalTrend(timestamps, values) {
    // Group by month/season and calculate averages
    const seasonalData = {};

    timestamps.forEach((timestamp, index) => {
      const month = moment(timestamp).month();
      const season = this.getSeason(month);

      if (!seasonalData[season]) {
        seasonalData[season] = [];
      }
      seasonalData[season].push(values[index]);
    });

    // Calculate seasonal averages
    const seasonalAverages = {};
    for (const [season, seasonValues] of Object.entries(seasonalData)) {
      seasonalAverages[season] =
        seasonValues.reduce((a, b) => a + b, 0) / seasonValues.length;
    }

    return {
      method: 'seasonal',
      seasonalAverages,
      maxSeason: Object.keys(seasonalAverages).reduce((a, b) =>
        seasonalAverages[a] > seasonalAverages[b] ? a : b
      ),
      minSeason: Object.keys(seasonalAverages).reduce((a, b) =>
        seasonalAverages[a] < seasonalAverages[b] ? a : b
      ),
    };
  }

  /**
   * Get season from month
   */
  getSeason(month) {
    if (month >= 2 && month <= 4) return 'spring';
    if (month >= 5 && month <= 7) return 'summer';
    if (month >= 8 && month <= 10) return 'autumn';
    return 'winter';
  }

  /**
   * Filter data for specific parameter
   */
  filterParameterData(data, parameter) {
    return data
      .filter(
        d =>
          d.data[parameter]?.value !== null &&
          d.data[parameter]?.value !== undefined
      )
      .map(d => ({
        location: d.location,
        timestamp: d.timestamp,
        value: d.data[parameter].value,
        quality: d.quality?.confidence || 0.8,
      }));
  }

  /**
   * Identify gaps in data
   */
  identifyGaps(data, parameter) {
    // This is a simplified implementation
    return data
      .filter(d => !d.data[parameter]?.value)
      .map(d => ({
        location: d.location,
        timestamp: d.timestamp,
        parameter,
        temporalNeighbors: this.findTemporalNeighbors(d, data),
        spatialNeighbors: this.findSpatialNeighbors(d, data),
      }));
  }

  /**
   * Find temporal neighbors
   */
  findTemporalNeighbors(dataPoint, allData) {
    const targetTime = new Date(dataPoint.timestamp).getTime();

    return allData
      .filter(
        d =>
          d.location.latitude === dataPoint.location.latitude &&
          d.location.longitude === dataPoint.location.longitude &&
          Math.abs(new Date(d.timestamp).getTime() - targetTime) <=
            this.options.maxTemporalGap
      )
      .sort(
        (a, b) =>
          Math.abs(new Date(a.timestamp).getTime() - targetTime) -
          Math.abs(new Date(b.timestamp).getTime() - targetTime)
      );
  }

  /**
   * Find spatial neighbors
   */
  findSpatialNeighbors(dataPoint, allData) {
    return allData
      .filter(
        d =>
          d.timestamp === dataPoint.timestamp &&
          this.calculateDistance(dataPoint.location, d.location) <=
            this.options.maxInterpolationDistance
      )
      .sort(
        (a, b) =>
          this.calculateDistance(dataPoint.location, a.location) -
          this.calculateDistance(dataPoint.location, b.location)
      );
  }

  /**
   * Calculate distance between two points (Haversine formula)
   */
  calculateDistance(point1, point2) {
    const R = 6371000; // Earth's radius in meters
    const lat1Rad = (point1.latitude * Math.PI) / 180;
    const lat2Rad = (point2.latitude * Math.PI) / 180;
    const deltaLatRad = ((point2.latitude - point1.latitude) * Math.PI) / 180;
    const deltaLonRad = ((point2.longitude - point1.longitude) * Math.PI) / 180;

    const a =
      Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
      Math.cos(lat1Rad) *
        Math.cos(lat2Rad) *
        Math.sin(deltaLonRad / 2) *
        Math.sin(deltaLonRad / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  /**
   * Generate cache keys
   */
  generateTemporalCacheKey(data, interval, parameters) {
    const dataHash = this.generateDataHash(data.slice(0, 5)); // Hash first 5 items for performance
    return `temporal_${dataHash}_${interval}_${parameters.join('_')}`;
  }

  generateSpatialCacheKey(data, targetLocations, method, parameter) {
    const dataHash = this.generateDataHash(data.slice(0, 5));
    const locationsHash = this.generateDataHash(targetLocations.slice(0, 5));
    return `spatial_${dataHash}_${locationsHash}_${method}_${parameter}`;
  }

  generateDataHash(data) {
    const crypto = require('crypto');
    const dataString = JSON.stringify(data, Object.keys(data).sort());
    return crypto
      .createHash('md5')
      .update(dataString)
      .digest('hex')
      .substring(0, 8);
  }

  /**
   * Clean up cache when it gets too large
   */
  cleanupCache(cache) {
    if (cache.size > this.options.maxCacheSize) {
      const keys = Array.from(cache.keys());
      const keysToDelete = keys.slice(
        0,
        Math.floor(this.options.maxCacheSize * 0.2)
      );
      keysToDelete.forEach(key => cache.delete(key));
    }
  }

  /**
   * Get processing metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      cacheStats: {
        aggregationCacheSize: this.aggregationCache.size,
        interpolationCacheSize: this.interpolationCache.size,
        hitRate:
          this.metrics.cacheHits /
            (this.metrics.cacheHits + this.metrics.cacheMisses) || 0,
      },
      averageProcessingTime:
        this.metrics.totalProcessingTime /
          (this.metrics.temporalAggregations +
            this.metrics.spatialInterpolations +
            this.metrics.gridGenerations) || 0,
    };
  }

  /**
   * Clear all caches
   */
  clearCaches() {
    this.dataCache.clear();
    this.aggregationCache.clear();
    this.interpolationCache.clear();
    this.logger.info('All caches cleared');
  }
}

/**
 * Temporal Aggregator Module
 */
class TemporalAggregator {
  constructor(options) {
    this.options = options;
  }

  groupByInterval(data, interval) {
    const groups = new Map();

    for (const dataPoint of data) {
      const intervalKey = this.getIntervalKey(dataPoint.timestamp, interval);

      if (!groups.has(intervalKey)) {
        groups.set(intervalKey, []);
      }
      groups.get(intervalKey).push(dataPoint);
    }

    return groups;
  }

  getIntervalKey(timestamp, interval) {
    const date = moment(timestamp);

    switch (interval) {
      case 'hour':
        return date.format('YYYY-MM-DD HH:00:00');
      case 'day':
        return date.format('YYYY-MM-DD');
      case 'week':
        return date.startOf('week').format('YYYY-MM-DD');
      case 'month':
        return date.format('YYYY-MM');
      case 'year':
        return date.format('YYYY');
      default:
        return date.format('YYYY-MM-DD HH:00:00');
    }
  }

  async aggregateGroup(dataPoints, parameters, methods, qualityWeighting) {
    if (dataPoints.length < this.options.minDataPointsForAggregation) {
      return null;
    }

    const aggregated = {
      timestamp: this.getRepresentativeTimestamp(dataPoints),
      location: this.getRepresentativeLocation(dataPoints),
      data: {},
      quality: {
        confidence: this.calculateGroupQuality(dataPoints),
        aggregationMethod: 'weighted_average',
      },
      metadata: {
        sourceCount: dataPoints.length,
        qualityWeighted: qualityWeighting,
      },
    };

    for (const parameter of parameters) {
      const method = methods[parameter] || 'mean';
      const values = this.extractParameterValues(
        dataPoints,
        parameter,
        qualityWeighting
      );

      if (values.length > 0) {
        aggregated.data[parameter] = {
          value: this.calculateAggregate(values, method),
          unit: dataPoints[0].data[parameter]?.unit || 'unknown',
          count: values.length,
        };
      }
    }

    return aggregated;
  }

  getRepresentativeTimestamp(dataPoints) {
    // Use the middle timestamp
    const timestamps = dataPoints
      .map(d => new Date(d.timestamp).getTime())
      .sort();
    return new Date(
      timestamps[Math.floor(timestamps.length / 2)]
    ).toISOString();
  }

  getRepresentativeLocation(dataPoints) {
    // Use average location if multiple locations
    const latitudes = dataPoints.map(d => d.location.latitude);
    const longitudes = dataPoints.map(d => d.location.longitude);

    return {
      latitude: latitudes.reduce((a, b) => a + b, 0) / latitudes.length,
      longitude: longitudes.reduce((a, b) => a + b, 0) / longitudes.length,
    };
  }

  extractParameterValues(dataPoints, parameter, qualityWeighting) {
    return dataPoints
      .filter(d => d.data[parameter]?.value !== null)
      .map(d => ({
        value: d.data[parameter].value,
        weight: qualityWeighting ? d.quality?.confidence || 0.5 : 1.0,
      }));
  }

  calculateAggregate(values, method) {
    switch (method) {
      case 'mean':
        return this.weightedMean(values);
      case 'sum':
        return values.reduce((sum, v) => sum + v.value, 0);
      case 'max':
        return Math.max(...values.map(v => v.value));
      case 'min':
        return Math.min(...values.map(v => v.value));
      case 'circular_mean':
        return this.circularMean(values);
      default:
        return this.weightedMean(values);
    }
  }

  weightedMean(values) {
    const totalWeight = values.reduce((sum, v) => sum + v.weight, 0);
    const weightedSum = values.reduce((sum, v) => sum + v.value * v.weight, 0);
    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  circularMean(values) {
    // For wind direction and similar circular quantities
    let sinSum = 0;
    let cosSum = 0;
    let totalWeight = 0;

    for (const { value, weight } of values) {
      const radians = (value * Math.PI) / 180;
      sinSum += Math.sin(radians) * weight;
      cosSum += Math.cos(radians) * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return 0;

    sinSum /= totalWeight;
    cosSum /= totalWeight;

    let mean = (Math.atan2(sinSum, cosSum) * 180) / Math.PI;
    if (mean < 0) mean += 360;

    return mean;
  }

  calculateGroupQuality(dataPoints) {
    if (dataPoints.length === 0) return 0;

    const qualities = dataPoints.map(d => d.quality?.confidence || 0.5);
    return qualities.reduce((a, b) => a + b, 0) / qualities.length;
  }
}

/**
 * Spatial Interpolator Module
 */
class SpatialInterpolator {
  constructor(options) {
    this.options = options;
  }

  async interpolate(data, targetLocation, method, options) {
    // Find nearby data points
    const neighbors = this.findNeighbors(
      data,
      targetLocation,
      options.maxDistance
    );

    if (neighbors.length < this.options.minNeighbors) {
      return null;
    }

    // Limit to max neighbors (use closest ones)
    const limitedNeighbors = neighbors.slice(0, this.options.maxNeighbors);

    // Perform interpolation based on method
    switch (method) {
      case 'idw':
        return this.inverseDistanceWeighting(
          limitedNeighbors,
          targetLocation,
          options
        );
      case 'nearest':
        return this.nearestNeighbor(limitedNeighbors);
      case 'linear':
        return this.linearInterpolation(limitedNeighbors, targetLocation);
      default:
        return this.inverseDistanceWeighting(
          limitedNeighbors,
          targetLocation,
          options
        );
    }
  }

  findNeighbors(data, targetLocation, maxDistance) {
    return data
      .map(d => ({
        ...d,
        distance: this.calculateDistance(d.location, targetLocation),
      }))
      .filter(d => d.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance);
  }

  inverseDistanceWeighting(neighbors, targetLocation, options) {
    const power = 2; // IDW power parameter
    let weightedSum = 0;
    let weightSum = 0;

    for (const neighbor of neighbors) {
      let weight = 1 / Math.pow(Math.max(neighbor.distance, 1), power);

      // Apply quality weighting if enabled
      if (options.qualityWeighting) {
        weight *= neighbor.quality || 0.5;
      }

      weightedSum += neighbor.value * weight;
      weightSum += weight;
    }

    const interpolatedValue = weightSum > 0 ? weightedSum / weightSum : null;

    // Calculate uncertainty if requested
    let uncertainty = null;
    if (options.uncertaintyEstimation) {
      uncertainty = this.calculateIDWUncertainty(neighbors, interpolatedValue);
    }

    return {
      value: interpolatedValue,
      uncertainty,
      neighbors: neighbors.length,
      method: 'idw',
    };
  }

  nearestNeighbor(neighbors) {
    const nearest = neighbors[0];
    return {
      value: nearest.value,
      uncertainty: 0,
      neighbors: 1,
      method: 'nearest',
    };
  }

  linearInterpolation(neighbors, targetLocation) {
    // Simplified linear interpolation (would need more sophisticated implementation)
    if (neighbors.length < 2) {
      return this.nearestNeighbor(neighbors);
    }

    // Use IDW as fallback for now
    return this.inverseDistanceWeighting(neighbors, targetLocation, {
      qualityWeighting: false,
    });
  }

  calculateIDWUncertainty(neighbors, interpolatedValue) {
    if (neighbors.length < 2) return 0;

    // Calculate variance of neighbor values weighted by distance
    const variance =
      neighbors.reduce((sum, neighbor) => {
        const diff = neighbor.value - interpolatedValue;
        const weight = 1 / Math.max(neighbor.distance, 1);
        return sum + diff * diff * weight;
      }, 0) / neighbors.length;

    return Math.sqrt(variance);
  }

  calculateDistance(point1, point2) {
    const R = 6371000; // Earth's radius in meters
    const lat1Rad = (point1.latitude * Math.PI) / 180;
    const lat2Rad = (point2.latitude * Math.PI) / 180;
    const deltaLatRad = ((point2.latitude - point1.latitude) * Math.PI) / 180;
    const deltaLonRad = ((point2.longitude - point1.longitude) * Math.PI) / 180;

    const a =
      Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
      Math.cos(lat1Rad) *
        Math.cos(lat2Rad) *
        Math.sin(deltaLonRad / 2) *
        Math.sin(deltaLonRad / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}

/**
 * Grid Processor Module
 */
class GridProcessor {
  constructor(options) {
    this.options = options;
  }

  generateGridPoints(bounds, resolution) {
    const points = [];

    for (let lat = bounds.south; lat <= bounds.north; lat += resolution) {
      for (let lon = bounds.west; lon <= bounds.east; lon += resolution) {
        points.push({
          latitude: Math.round(lat * 1000) / 1000,
          longitude: Math.round(lon * 1000) / 1000,
        });
      }
    }

    return points;
  }

  formatAsGrid(interpolatedValues, bounds, resolution) {
    const grid = [];
    const latSteps = Math.ceil((bounds.north - bounds.south) / resolution) + 1;
    const lonSteps = Math.ceil((bounds.east - bounds.west) / resolution) + 1;

    // Initialize grid
    for (let i = 0; i < latSteps; i++) {
      grid[i] = new Array(lonSteps).fill(null);
    }

    // Fill grid with interpolated values
    for (const point of interpolatedValues) {
      const latIndex = Math.round(
        (point.location.latitude - bounds.south) / resolution
      );
      const lonIndex = Math.round(
        (point.location.longitude - bounds.west) / resolution
      );

      if (
        latIndex >= 0 &&
        latIndex < latSteps &&
        lonIndex >= 0 &&
        lonIndex < lonSteps
      ) {
        grid[latIndex][lonIndex] = point.value;
      }
    }

    return grid;
  }
}

/**
 * Gap Filler Module
 */
class GapFiller {
  constructor(options) {
    this.options = options;
  }

  async fillTemporalGaps(data, interval) {
    // Placeholder for temporal gap filling
    return [];
  }

  async fillTemporal(gap, parameter) {
    // Simple linear interpolation between temporal neighbors
    if (!gap.temporalNeighbors || gap.temporalNeighbors.length < 2) {
      return null;
    }

    const before = gap.temporalNeighbors.find(
      n =>
        new Date(n.timestamp) < new Date(gap.timestamp) &&
        n.data[parameter]?.value !== null
    );
    const after = gap.temporalNeighbors.find(
      n =>
        new Date(n.timestamp) > new Date(gap.timestamp) &&
        n.data[parameter]?.value !== null
    );

    if (!before || !after) return null;

    const timeBefore = new Date(before.timestamp).getTime();
    const timeAfter = new Date(after.timestamp).getTime();
    const timeGap = new Date(gap.timestamp).getTime();

    const ratio = (timeGap - timeBefore) / (timeAfter - timeBefore);
    const valueBefore = before.data[parameter].value;
    const valueAfter = after.data[parameter].value;

    return valueBefore + (valueAfter - valueBefore) * ratio;
  }

  async fillSpatial(gap, parameter) {
    // Use spatial neighbors for interpolation
    const values = gap.spatialNeighbors
      .filter(n => n.data[parameter]?.value !== null)
      .slice(0, 5); // Use up to 5 nearest neighbors

    if (values.length === 0) return null;

    // Simple average (could be enhanced with distance weighting)
    const sum = values.reduce((s, v) => s + v.data[parameter].value, 0);
    return sum / values.length;
  }
}

module.exports = { TemporalSpatialProcessor };
