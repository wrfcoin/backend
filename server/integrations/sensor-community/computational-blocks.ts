// TypeScript interfaces for sensor community computational blocks
interface SensorDataPoint {
  timestamp: number;
  pm25: number;
  pm10: number;
  temperature: number;
  humidity: number;
  pressure: number;
  latitude: number;
  longitude: number;
  sensorId: string;
  quality?: number;
  sourceId?: string;
  location?: {
    latitude: number;
    longitude: number;
  };
  measurements?: {
    pm25: number;
    pm10: number;
    temperature: number;
    humidity: number;
    pressure: number;
  };
}

interface ComputationalBlockOptions {
  windowSize?: number;
  threshold?: number;
  minDataPoints?: number;
  maxIterations?: number;
  learningRate?: number;
  regularization?: number;
}

interface ComputationalBlockMetadata {
  blockId: string;
  version: string;
  description: string;
  author: string;
  created: number;
  modified: number;
  dependencies?: string[];
}

interface ComputationalBlock {
  id: string;
  name: string;
  description: string;
  type: string;
  metadata: ComputationalBlockMetadata;
  options: ComputationalBlockOptions;
  execute(data: SensorDataPoint[]): Promise<any>;
  validate(data: SensorDataPoint[]): boolean;
  getRequiredFields(): string[];
}

interface AirQualityPrediction {
  timestamp: number;
  predictedPM25: number;
  predictedPM10: number;
  confidence: number;
  factors: {
    temperature: number;
    humidity: number;
    pressure: number;
    windSpeed?: number;
    windDirection?: number;
  };
}

interface PollutionForecast {
  location: {
    latitude: number;
    longitude: number;
  };
  timeRange: {
    start: number;
    end: number;
  };
  predictions: AirQualityPrediction[];
  uncertainty: number;
  methodology: string;
}

interface AnomalyDetectionResult {
  timestamp: number;
  anomalyScore: number;
  isAnomaly: boolean;
  anomalyType: string;
  confidence: number;
  affectedSensors: string[];
  metadata: {
    algorithm: string;
    parameters: ComputationalBlockOptions;
    processingTime: number;
  };
}

interface SpatialInterpolationResult {
  grid: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
    resolution: number;
  };
  interpolatedValues: Array<{
    latitude: number;
    longitude: number;
    pm25: number;
    pm10: number;
    uncertainty: number;
  }>;
  method: string;
  timestamp: number;
}

interface TrendAnalysisResult {
  metric: string;
  timeRange: {
    start: number;
    end: number;
  };
  trend: {
    direction: 'increasing' | 'decreasing' | 'stable';
    magnitude: number;
    confidence: number;
    significance: number;
  };
  seasonality: {
    detected: boolean;
    period?: number;
    amplitude?: number;
  };
  changePoints: Array<{
    timestamp: number;
    significance: number;
    changeType: string;
  }>;
}

interface WeatherCorrelationResult {
  correlations: {
    temperature: number;
    humidity: number;
    pressure: number;
    windSpeed?: number;
    windDirection?: number;
  };
  significance: {
    temperature: number;
    humidity: number;
    pressure: number;
    windSpeed?: number;
    windDirection?: number;
  };
  timeRange: {
    start: number;
    end: number;
  };
  sampleSize: number;
}

interface ModelValidationResult {
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  rmse: number;
  mae: number;
  crossValidationScores: number[];
  confusionMatrix?: number[][];
  validationMethod: string;
}

interface ComputationalModel {
  id: string;
  name: string;
  version: string;
  type: string;
  parameters: any;
  trained: boolean;
  accuracy: number;
  lastTraining: number;
  train(data: SensorDataPoint[]): Promise<void>;
  predict(data: SensorDataPoint[]): Promise<any>;
  validate(testData: SensorDataPoint[]): Promise<ModelValidationResult>;
  serialize(): string;
  deserialize(data: string): void;
}

interface ProcessingPipeline {
  id: string;
  name: string;
  description: string;
  steps: ComputationalBlock[];
  input: SensorDataPoint[];
  output: any;
  execute(): Promise<any>;
  addStep(block: ComputationalBlock): void;
  removeStep(blockId: string): void;
  getStep(blockId: string): ComputationalBlock | undefined;
}

interface SensorCommunityConfig {
  apiEndpoint: string;
  apiKey: string;
  refreshInterval: number;
  maxRetries: number;
  timeout: number;
  cacheDuration: number;
  enableValidation: boolean;
  qualityThreshold: number;
  spatialRange: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  };
  enabledModels: string[];
  defaultPruningPeriod: number;
  pruningConfig: {
    [key: string]: {
      pruningPeriod: number;
      defaultPruningPeriod: number;
      additionalMetadata: any;
    };
  };
}

/**
 * Sensor.Community Computational Blocks
 *
 * This module implements specialized computational blocks for processing
 * environmental data from Sensor.Community sensors. It supports configurable
 * pruning periods and different computational models for the data.
 */

const { v4: uuidv4 } = require('uuid');
const computationalBlocksLogger = require('../../utils/logger')(
  'sensor-community:computational-blocks'
);

// Available pruning periods in months
const PRUNING_PERIODS = {
  SHORT: 3, // 3 months
  MEDIUM: 6, // 6 months
  STANDARD: 12, // 12 months (1 year)
  EXTENDED: 36, // 36 months (3 years)
};

// Computational models for environmental data
const COMPUTATIONAL_MODELS = {
  AIR_QUALITY_INDEX: 'air-quality-index', // Computes standardized AQI
  POLLUTION_FORECAST: 'pollution-forecast', // Predictive model for pollution levels
  ANOMALY_DETECTION: 'anomaly-detection', // Detects unusual patterns in data
  SPATIAL_INTERPOLATION: 'spatial-interpolation', // Generates estimates for locations between sensors
  TREND_ANALYSIS: 'trend-analysis', // Long-term trend identification
};

class SensorCommunityComputationalBlocks {
  private options: SensorCommunityConfig;
  private computationalCache: Map<string, any>;

  constructor(options: Partial<SensorCommunityConfig> = {}) {
    this.options = {
      apiEndpoint: 'https://api.sensor.community',
      apiKey: '',
      refreshInterval: 300000,
      maxRetries: 3,
      timeout: 30000,
      cacheDuration: 600000,
      enableValidation: true,
      qualityThreshold: 0.8,
      spatialRange: {
        minLat: -90,
        maxLat: 90,
        minLon: -180,
        maxLon: 180,
      },
      enabledModels: Object.values(COMPUTATIONAL_MODELS),
      defaultPruningPeriod: PRUNING_PERIODS.STANDARD,
      pruningConfig: {},
      ...options,
    };

    // Initialize storage for computational results
    this.computationalCache = new Map();

    computationalBlocksLogger.info(
      'Initializing Sensor.Community computational blocks',
      {
        refreshInterval: this.options.refreshInterval,
        enabledModels: Object.values(COMPUTATIONAL_MODELS).length,
      }
    );
  }

  /**
   * Create a new computational block from sensor data
   * @param {Array} sensorDataPoints - Array of validated sensor data points
   * @param {string} computationalModel - The model to apply
   * @param {Object} options - Additional options for the computation
   * @returns {Object} - A computational block ready for blockchain storage
   */
  createComputationalBlock(
    sensorDataPoints: SensorDataPoint[],
    computationalModel: string,
    options: any = {}
  ) {
    if (
      !sensorDataPoints ||
      !Array.isArray(sensorDataPoints) ||
      sensorDataPoints.length === 0
    ) {
      throw new Error('Invalid or empty sensor data points');
    }

    if (!this.options.enabledModels.includes(computationalModel)) {
      throw new Error(
        `Computational model ${computationalModel} is not enabled`
      );
    }

    // Compute a result based on the requested model
    const computationResult = this._computeResult(
      sensorDataPoints,
      computationalModel,
      options
    );

    // Generate a unique ID for this computational block
    const blockId = `sc-comp-${uuidv4()}`;

    // Create metadata for the computation
    const metadata = {
      source: 'Sensor.Community',
      model: computationalModel,
      timestamp: new Date().toISOString(),
      dataPointCount: sensorDataPoints.length,
      sensorCount: new Set(sensorDataPoints.map(p => p.sourceId)).size,
      geographicBounds: this._calculateGeographicBounds(sensorDataPoints),
      timeRange: {
        start: new Date(
          Math.min(
            ...sensorDataPoints.map(p => new Date(p.timestamp).getTime())
          )
        ).toISOString(),
        end: new Date(
          Math.max(
            ...sensorDataPoints.map(p => new Date(p.timestamp).getTime())
          )
        ).toISOString(),
      },
      pruningPeriod: options.pruningPeriod || this.options.defaultPruningPeriod,
      pruningDate: this._calculatePruningDate(
        options.pruningPeriod || this.options.defaultPruningPeriod
      ),
      ...options.additionalMetadata,
    };

    // Construct the computational block
    const computationalBlock = {
      id: blockId,
      type: 'sensor-community-computational',
      metadata,
      result: computationResult,
      dataHashes: this._generateDataHashes(sensorDataPoints),
      timestamp: new Date().toISOString(),
      version: '1.0',
    };

    // Cache the result for future reference
    this.computationalCache.set(blockId, {
      result: computationResult,
      timestamp: new Date().toISOString(),
    });

    computationalBlocksLogger.info(
      `Created computational block ${blockId} using model ${computationalModel}`,
      {
        dataPointCount: sensorDataPoints.length,
        resultSize: JSON.stringify(computationResult).length,
      }
    );

    return computationalBlock;
  }

  /**
   * Verify a computational block against its source data
   * @param {Object} computationalBlock - The block to verify
   * @param {Array} sensorDataPoints - The original sensor data points
   * @returns {Object} - Verification result
   */
  verifyComputationalBlock(computationalBlock, sensorDataPoints) {
    if (
      !computationalBlock ||
      !computationalBlock.id ||
      !computationalBlock.result
    ) {
      return {
        isValid: false,
        reason: 'Invalid computational block structure',
      };
    }

    if (
      !sensorDataPoints ||
      !Array.isArray(sensorDataPoints) ||
      sensorDataPoints.length === 0
    ) {
      return { isValid: false, reason: 'Invalid or empty sensor data points' };
    }

    // Verify data hashes
    const dataHashes = this._generateDataHashes(sensorDataPoints);
    const hashesMatch =
      JSON.stringify(dataHashes) ===
      JSON.stringify(computationalBlock.dataHashes);

    if (!hashesMatch) {
      return { isValid: false, reason: 'Data hashes do not match' };
    }

    // Recompute the result
    const recomputedResult = this._computeResult(
      sensorDataPoints,
      computationalBlock.metadata.model,
      {
        additionalMetadata: computationalBlock.metadata,
        ...computationalBlock.metadata,
      }
    );

    // Compare the results (allowing for small floating-point differences)
    const resultsMatch = this._deepCompareResults(
      recomputedResult,
      computationalBlock.result
    );

    if (!resultsMatch) {
      return { isValid: false, reason: 'Computed results do not match' };
    }

    return {
      isValid: true,
      reason: 'Block successfully verified',
    };
  }

  /**
   * Check if a computational block should be pruned
   * @param {Object} computationalBlock - The block to check
   * @returns {boolean} - True if the block should be pruned
   */
  shouldPruneBlock(computationalBlock) {
    if (
      !computationalBlock ||
      !computationalBlock.metadata ||
      !computationalBlock.metadata.pruningDate
    ) {
      return false;
    }

    const pruningDate = new Date(computationalBlock.metadata.pruningDate);
    const currentDate = new Date();

    return currentDate >= pruningDate;
  }

  /**
   * Generate a pruning recommendation based on data characteristics
   * @param {Array} sensorDataPoints - The sensor data points
   * @returns {number} - Recommended pruning period in months
   */
  recommendPruningPeriod(sensorDataPoints) {
    if (!sensorDataPoints || sensorDataPoints.length === 0) {
      return this.options.defaultPruningPeriod;
    }

    // Calculate the geographic spread of the data
    const bounds = this._calculateGeographicBounds(sensorDataPoints);
    const geographicSpread = Math.max(
      Math.abs(bounds.north - bounds.south),
      Math.abs(bounds.east - bounds.west)
    );

    // Calculate the time range covered by the data
    const timestamps = sensorDataPoints.map(p =>
      new Date(p.timestamp).getTime()
    );
    const timeRangeHours =
      (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60);

    // Check for presence of valuable data types
    const hasParticulateMatter = sensorDataPoints.some(
      p =>
        p.measurements &&
        (p.measurements.pm25 !== undefined || p.measurements.pm10 !== undefined)
    );

    const hasWeatherData = sensorDataPoints.some(
      p =>
        p.measurements &&
        p.measurements.temperature !== undefined &&
        p.measurements.humidity !== undefined
    );

    // Decision logic for pruning period
    if (geographicSpread > 10 && timeRangeHours > 24 * 30 * 6) {
      // Large geographic area and long time range - likely valuable for long-term analysis
      return PRUNING_PERIODS.EXTENDED;
    }

    if (
      hasParticulateMatter &&
      hasWeatherData &&
      timeRangeHours > 24 * 30 * 3
    ) {
      // Contains both air quality and weather data over several months
      return PRUNING_PERIODS.STANDARD;
    }

    if (hasParticulateMatter && geographicSpread > 5) {
      // Air quality data over a reasonable area
      return PRUNING_PERIODS.MEDIUM;
    }

    // Default case for data that doesn't meet special criteria
    return PRUNING_PERIODS.SHORT;
  }

  /**
   * Compute a result using the specified model
   * @private
   * @param {Array} dataPoints - The sensor data points
   * @param {string} model - The computational model
   * @param {Object} options - Additional options
   * @returns {Object} - The computation result
   */
  _computeResult(
    dataPoints: SensorDataPoint[],
    model: string,
    options: any = {}
  ) {
    switch (model) {
      case COMPUTATIONAL_MODELS.AIR_QUALITY_INDEX:
        return this._computeAirQualityIndex(dataPoints, options);

      case COMPUTATIONAL_MODELS.POLLUTION_FORECAST:
        return this._computePollutionForecast(dataPoints, options);

      case COMPUTATIONAL_MODELS.ANOMALY_DETECTION:
        return this._detectAnomalies(dataPoints, options);

      case COMPUTATIONAL_MODELS.SPATIAL_INTERPOLATION:
        return this._computeSpatialInterpolation(dataPoints, options);

      case COMPUTATIONAL_MODELS.TREND_ANALYSIS:
        return this._analyzeTrends(dataPoints, options);

      default:
        throw new Error(`Unsupported computational model: ${model}`);
    }
  }

  /**
   * Compute Air Quality Index from sensor data
   * @private
   * @param {Array} dataPoints - The sensor data points
   * @param {Object} options - Additional options
   * @returns {Object} - The AQI computation result
   */
  _computeAirQualityIndex(dataPoints: SensorDataPoint[], options: any = {}) {
    // Group data by region or grid cell
    const regions = this._groupDataByRegion(dataPoints);

    const results = {};

    // For each region, compute AQI
    for (const [regionId, regionData] of Object.entries(regions)) {
      const pm25Values = regionData
        .filter(d => d.measurements && d.measurements.pm25 !== undefined)
        .map(d => d.measurements!.pm25);

      const pm10Values = regionData
        .filter(d => d.measurements && d.measurements.pm10 !== undefined)
        .map(d => d.measurements!.pm10);

      if (pm25Values.length === 0 && pm10Values.length === 0) {
        continue; // Skip regions with no PM data
      }

      // Calculate mean PM values
      const pm25Mean =
        pm25Values.length > 0
          ? pm25Values.reduce((sum, val) => sum + val, 0) / pm25Values.length
          : null;

      const pm10Mean =
        pm10Values.length > 0
          ? pm10Values.reduce((sum, val) => sum + val, 0) / pm10Values.length
          : null;

      // Compute AQI for each pollutant using standard formulas
      // This is a simplified AQI calculation
      // Reference: https://www.airnow.gov/sites/default/files/2018-05/aqi-technical-assistance-document-may2016.pdf

      let pm25Aqi = null;
      if (pm25Mean !== null) {
        if (pm25Mean <= 12) {
          pm25Aqi = this._linearScale(pm25Mean, 0, 12, 0, 50);
        } else if (pm25Mean <= 35.4) {
          pm25Aqi = this._linearScale(pm25Mean, 12.1, 35.4, 51, 100);
        } else if (pm25Mean <= 55.4) {
          pm25Aqi = this._linearScale(pm25Mean, 35.5, 55.4, 101, 150);
        } else if (pm25Mean <= 150.4) {
          pm25Aqi = this._linearScale(pm25Mean, 55.5, 150.4, 151, 200);
        } else if (pm25Mean <= 250.4) {
          pm25Aqi = this._linearScale(pm25Mean, 150.5, 250.4, 201, 300);
        } else if (pm25Mean <= 350.4) {
          pm25Aqi = this._linearScale(pm25Mean, 250.5, 350.4, 301, 400);
        } else {
          pm25Aqi = this._linearScale(pm25Mean, 350.5, 500, 401, 500);
        }
      }

      let pm10Aqi = null;
      if (pm10Mean !== null) {
        if (pm10Mean <= 54) {
          pm10Aqi = this._linearScale(pm10Mean, 0, 54, 0, 50);
        } else if (pm10Mean <= 154) {
          pm10Aqi = this._linearScale(pm10Mean, 55, 154, 51, 100);
        } else if (pm10Mean <= 254) {
          pm10Aqi = this._linearScale(pm10Mean, 155, 254, 101, 150);
        } else if (pm10Mean <= 354) {
          pm10Aqi = this._linearScale(pm10Mean, 255, 354, 151, 200);
        } else if (pm10Mean <= 424) {
          pm10Aqi = this._linearScale(pm10Mean, 355, 424, 201, 300);
        } else if (pm10Mean <= 504) {
          pm10Aqi = this._linearScale(pm10Mean, 425, 504, 301, 400);
        } else {
          pm10Aqi = this._linearScale(pm10Mean, 505, 604, 401, 500);
        }
      }

      // The overall AQI is the highest of the individual pollutant AQIs
      const overallAqi = Math.max(
        pm25Aqi !== null ? pm25Aqi : 0,
        pm10Aqi !== null ? pm10Aqi : 0
      );

      // Add to results
      results[regionId] = {
        aqi: Math.round(overallAqi),
        category: this._getAqiCategory(overallAqi),
        pollutants: {
          pm25:
            pm25Mean !== null
              ? {
                  concentration: pm25Mean.toFixed(1),
                  aqi: Math.round(pm25Aqi || 0),
                }
              : null,
          pm10:
            pm10Mean !== null
              ? {
                  concentration: pm10Mean.toFixed(1),
                  aqi: Math.round(pm10Aqi || 0),
                }
              : null,
        },
        sampleCount: regionData.length,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      type: 'air-quality-index',
      regions: results,
      aggregated: this._aggregateRegionalResults(results),
    };
  }

  /**
   * Compute pollution forecast based on historical data
   * @private
   * @param {Array} dataPoints - The sensor data points
   * @param {Object} options - Additional options
   * @returns {Object} - The pollution forecast result
   */
  _computePollutionForecast(dataPoints: SensorDataPoint[], options: any = {}) {
    // Group data by region and sort by timestamp
    const regions = this._groupDataByRegion(dataPoints);

    const forecastHours = options.forecastHours || 24;
    const results = {};

    for (const [regionId, regionData] of Object.entries(regions)) {
      // Sort data by timestamp
      const sortedData = [...regionData].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // Extract time series data for PM2.5 and PM10
      const pm25Series = sortedData
        .filter(d => d.measurements && d.measurements.pm25 !== undefined)
        .map(d => ({
          timestamp: new Date(d.timestamp).getTime(),
          value: d.measurements!.pm25,
        }));

      const pm10Series = sortedData
        .filter(d => d.measurements && d.measurements.pm10 !== undefined)
        .map(d => ({
          timestamp: new Date(d.timestamp).getTime(),
          value: d.measurements!.pm10,
        }));

      if (pm25Series.length < 10 && pm10Series.length < 10) {
        continue; // Not enough data for forecasting
      }

      // Simple forecasting using linear regression
      const pm25Forecast =
        pm25Series.length >= 10
          ? this._linearForecast(pm25Series, forecastHours)
          : null;

      const pm10Forecast =
        pm10Series.length >= 10
          ? this._linearForecast(pm10Series, forecastHours)
          : null;

      // Add results
      results[regionId] = {
        forecasts: {
          pm25: pm25Forecast,
          pm10: pm10Forecast,
        },
        forecastHours,
        baseTimestamp: new Date().toISOString(),
        confidenceLevel: this._calculateConfidenceLevel(
          pm25Series.length + pm10Series.length,
          pm25Forecast,
          pm10Forecast
        ),
      };
    }

    return {
      type: 'pollution-forecast',
      regions: results,
      forecastPeriod: `${forecastHours} hours`,
    };
  }

  /**
   * Detect anomalies in sensor data
   * @private
   * @param {Array} dataPoints - The sensor data points
   * @param {Object} options - Additional options
   * @returns {Object} - The anomaly detection result
   */
  _detectAnomalies(dataPoints: SensorDataPoint[], options: any = {}) {
    const anomalyThreshold = options.anomalyThreshold || 3.0; // Z-score threshold
    const results = {};

    // Group data by sensor
    const sensorGroups: Record<string, SensorDataPoint[]> = {};
    for (const dataPoint of dataPoints) {
      if (!dataPoint.sourceId) continue;

      if (!sensorGroups[dataPoint.sourceId]) {
        sensorGroups[dataPoint.sourceId] = [];
      }

      sensorGroups[dataPoint.sourceId].push(dataPoint);
    }

    // For each sensor, detect anomalies in each measurement type
    for (const [sensorId, sensorData] of Object.entries(sensorGroups)) {
      if (sensorData.length < 5) continue; // Not enough data

      const anomalies = {};

      // Sort data by timestamp
      const sortedData = [...sensorData].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // For each measurement type, detect anomalies
      const measurementTypes = new Set();
      for (const dataPoint of sortedData) {
        if (!dataPoint.measurements) continue;

        for (const measurementType of Object.keys(dataPoint.measurements)) {
          measurementTypes.add(measurementType);
        }
      }

      for (const measurementType of measurementTypes) {
        // Extract values for this measurement
        const values = sortedData
          .filter(
            d =>
              d.measurements &&
              d.measurements[measurementType as keyof typeof d.measurements] !==
                undefined
          )
          .map((d, index) => ({
            value:
              d.measurements![measurementType as keyof typeof d.measurements],
            index,
            timestamp: d.timestamp,
          }));

        if (values.length < 5) continue;

        // Calculate mean and standard deviation
        const mean =
          values.reduce((sum, item) => sum + item.value, 0) / values.length;
        const variance =
          values.reduce(
            (sum, item) => sum + Math.pow(item.value - mean, 2),
            0
          ) / values.length;
        const stdDev = Math.sqrt(variance);

        // Detect anomalies using Z-score
        const anomalyIndices: number[] = [];
        const anomalyValues: number[] = [];
        const anomalyTimestamps: number[] = [];

        for (const { value, index, timestamp } of values) {
          const zScore = Math.abs((value - mean) / stdDev);

          if (zScore > anomalyThreshold) {
            anomalyIndices.push(index);
            anomalyValues.push(value);
            anomalyTimestamps.push(timestamp);
          }
        }

        if (anomalyIndices.length > 0) {
          anomalies[measurementType as string] = {
            mean,
            stdDev,
            anomalyThreshold,
            anomalyCount: anomalyIndices.length,
            anomalyIndices,
            anomalyValues,
            anomalyTimestamps,
          };
        }
      }

      if (Object.keys(anomalies).length > 0) {
        results[sensorId] = {
          anomalies,
          dataPointCount: sortedData.length,
          firstTimestamp: sortedData[0].timestamp,
          lastTimestamp: sortedData[sortedData.length - 1].timestamp,
        };
      }
    }

    return {
      type: 'anomaly-detection',
      detections: results,
      anomalyThreshold,
      totalSensorsAnalyzed: Object.keys(sensorGroups).length,
      sensorsWithAnomalies: Object.keys(results).length,
    };
  }

  /**
   * Compute spatial interpolation for areas between sensors
   * @private
   * @param {Array} dataPoints - The sensor data points
   * @param {Object} options - Additional options
   * @returns {Object} - The spatial interpolation result
   */
  _computeSpatialInterpolation(
    dataPoints: SensorDataPoint[],
    options: any = {}
  ) {
    const gridResolution = options.gridResolution || 0.01; // Approximately 1km
    const bounds = this._calculateGeographicBounds(dataPoints);

    // Make sure we have enough geographic spread to interpolate
    if (
      Math.abs(bounds.north - bounds.south) < 0.02 ||
      Math.abs(bounds.east - bounds.west) < 0.02
    ) {
      return {
        type: 'spatial-interpolation',
        error: 'Geographic area too small for meaningful interpolation',
        bounds,
      };
    }

    // Prepare sensor locations and values for interpolation
    const sensorLocations: Array<{ latitude: number; longitude: number }> = [];
    const pm25Values: Array<number | null> = [];
    const pm10Values: Array<number | null> = [];

    for (const dataPoint of dataPoints) {
      if (!dataPoint.location || !dataPoint.measurements) continue;

      const { latitude, longitude } = dataPoint.location;

      if (latitude === undefined || longitude === undefined) continue;

      sensorLocations.push({ latitude, longitude });

      // Add values for PM2.5 and PM10 interpolation
      pm25Values.push(
        dataPoint.measurements.pm25 !== undefined
          ? dataPoint.measurements.pm25
          : null
      );

      pm10Values.push(
        dataPoint.measurements.pm10 !== undefined
          ? dataPoint.measurements.pm10
          : null
      );
    }

    if (sensorLocations.length < 3) {
      return {
        type: 'spatial-interpolation',
        error: 'Not enough sensor locations for interpolation',
        sensorCount: sensorLocations.length,
      };
    }

    // Generate grid points
    const gridPoints: Array<{ latitude: number; longitude: number }> = [];
    for (let lat = bounds.south; lat <= bounds.north; lat += gridResolution) {
      for (let lng = bounds.west; lng <= bounds.east; lng += gridResolution) {
        gridPoints.push({ latitude: lat, longitude: lng });
      }
    }

    // Simple IDW (Inverse Distance Weighting) interpolation
    const interpolatedPm25 = this._idwInterpolation(
      sensorLocations,
      pm25Values,
      gridPoints,
      2 // Power parameter
    );

    const interpolatedPm10 = this._idwInterpolation(
      sensorLocations,
      pm10Values,
      gridPoints,
      2 // Power parameter
    );

    // Generate GeoJSON feature collection
    const features = gridPoints.map((point, index) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [point.longitude, point.latitude],
      },
      properties: {
        pm25: interpolatedPm25[index],
        pm10: interpolatedPm10[index],
      },
    }));

    return {
      type: 'spatial-interpolation',
      interpolationMethod: 'IDW',
      gridResolution,
      bounds,
      sensorCount: sensorLocations.length,
      gridPointCount: gridPoints.length,
      geojson: {
        type: 'FeatureCollection',
        features,
      },
    };
  }

  /**
   * Analyze trends in the sensor data
   * @private
   * @param {Array} dataPoints - The sensor data points
   * @param {Object} options - Additional options
   * @returns {Object} - The trend analysis result
   */
  _analyzeTrends(dataPoints: SensorDataPoint[], options: any = {}) {
    // Group data by region or grid cell
    const regions = this._groupDataByRegion(dataPoints);

    const results = {};

    for (const [regionId, regionData] of Object.entries(regions)) {
      // Sort data by timestamp
      const sortedData = [...regionData].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      if (sortedData.length < 10) continue; // Not enough data

      // Group data by time period (day or week)
      const timeGroup = options.timeGroup || 'day';
      const groupedData = this._groupDataByTimePeriod(sortedData, timeGroup);

      // For each measurement type, calculate trends
      const measurementTypes = new Set();
      for (const dataPoint of sortedData) {
        if (!dataPoint.measurements) continue;

        for (const measurementType of Object.keys(dataPoint.measurements)) {
          measurementTypes.add(measurementType);
        }
      }

      const trends = {};

      for (const measurementType of measurementTypes) {
        const timeSeries: Array<{ timestamp: string; value: number }> = [];

        // For each time period, calculate average value
        for (const [timestamp, group] of Object.entries(groupedData)) {
          const values = group
            .filter(
              d =>
                d.measurements &&
                d.measurements[
                  measurementType as keyof typeof d.measurements
                ] !== undefined
            )
            .map(
              d =>
                d.measurements![measurementType as keyof typeof d.measurements]
            );

          if (values.length === 0) continue;

          const avgValue =
            values.reduce((sum, val) => sum + val, 0) / values.length;

          timeSeries.push({
            timestamp,
            value: avgValue,
          });
        }

        if (timeSeries.length < 3) continue;

        // Calculate trend statistics
        const xValues = timeSeries.map((d, i) => i);
        const yValues = timeSeries.map(d => d.value);

        const linearTrend = this._calculateLinearTrend(xValues, yValues);

        trends[measurementType as string] = {
          timeSeries,
          trend: linearTrend.slope,
          trendDirection:
            linearTrend.slope > 0
              ? 'increasing'
              : linearTrend.slope < 0
                ? 'decreasing'
                : 'stable',
          trendStrength: Math.abs(linearTrend.r2),
          rSquared: linearTrend.r2,
          timeUnit: timeGroup,
        };
      }

      if (Object.keys(trends).length > 0) {
        results[regionId] = {
          trends,
          dataPointCount: sortedData.length,
          firstTimestamp: sortedData[0].timestamp,
          lastTimestamp: sortedData[sortedData.length - 1].timestamp,
          timeSpanDays:
            (new Date(sortedData[sortedData.length - 1].timestamp).getTime() -
              new Date(sortedData[0].timestamp).getTime()) /
            (1000 * 60 * 60 * 24),
        };
      }
    }

    return {
      type: 'trend-analysis',
      regions: results,
      timeGroup: options.timeGroup || 'day',
      regionsAnalyzed: Object.keys(regions).length,
      regionsWithTrends: Object.keys(results).length,
    };
  }

  /**
   * Linear scaling function for AQI calculation
   * @private
   * @param {number} value - The value to scale
   * @param {number} inMin - Input range minimum
   * @param {number} inMax - Input range maximum
   * @param {number} outMin - Output range minimum
   * @param {number} outMax - Output range maximum
   * @returns {number} - The scaled value
   */
  _linearScale(value, inMin, inMax, outMin, outMax) {
    return ((value - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin;
  }

  /**
   * Get AQI category from numeric value
   * @private
   * @param {number} aqi - The AQI value
   * @returns {string} - The category description
   */
  _getAqiCategory(aqi) {
    if (aqi <= 50) {
      return 'Good';
    } else if (aqi <= 100) {
      return 'Moderate';
    } else if (aqi <= 150) {
      return 'Unhealthy for Sensitive Groups';
    } else if (aqi <= 200) {
      return 'Unhealthy';
    } else if (aqi <= 300) {
      return 'Very Unhealthy';
    } else {
      return 'Hazardous';
    }
  }

  /**
   * Group data points by geographic region
   * @private
   * @param {Array} dataPoints - The data points to group
   * @returns {Object} - Map of region ID to data points
   */
  _groupDataByRegion(
    dataPoints: SensorDataPoint[]
  ): Record<string, SensorDataPoint[]> {
    const regions: Record<string, SensorDataPoint[]> = {};

    for (const dataPoint of dataPoints) {
      if (!dataPoint.location) continue;

      // Create a grid cell ID based on rounded coordinates
      // Approximately 0.1 degree = 11 km at the equator
      const gridSize = 0.1;
      const latGrid =
        Math.floor(dataPoint.location.latitude / gridSize) * gridSize;
      const lngGrid =
        Math.floor(dataPoint.location.longitude / gridSize) * gridSize;

      const regionId = `${latGrid.toFixed(1)},${lngGrid.toFixed(1)}`;

      if (!regions[regionId]) {
        regions[regionId] = [];
      }

      regions[regionId].push(dataPoint);
    }

    return regions;
  }

  /**
   * Group data by time period (day or week)
   * @private
   * @param {Array} dataPoints - The data points to group
   * @param {string} period - The period type ('day' or 'week')
   * @returns {Object} - Map of period ID to data points
   */
  _groupDataByTimePeriod(
    dataPoints: SensorDataPoint[],
    period: string
  ): Record<string, SensorDataPoint[]> {
    const groups: Record<string, SensorDataPoint[]> = {};

    for (const dataPoint of dataPoints) {
      if (!dataPoint.timestamp) continue;

      const date = new Date(dataPoint.timestamp);
      let groupId;

      if (period === 'week') {
        // Get start of week (Sunday)
        const day = date.getUTCDay();
        const diff = date.getUTCDate() - day;
        const startOfWeek = new Date(date);
        startOfWeek.setUTCDate(diff);
        startOfWeek.setUTCHours(0, 0, 0, 0);

        groupId = startOfWeek.toISOString().split('T')[0];
      } else {
        // Default to day
        groupId = date.toISOString().split('T')[0];
      }

      if (!groups[groupId]) {
        groups[groupId] = [];
      }

      groups[groupId].push(dataPoint);
    }

    return groups;
  }

  /**
   * Forecast future values using linear regression
   * @private
   * @param {Array} timeSeries - The time series data
   * @param {number} hoursAhead - Hours to forecast
   * @returns {Array} - Array of forecast points
   */
  _linearForecast(timeSeries, hoursAhead) {
    if (timeSeries.length < 2) return null;

    // Convert to relative hours for calculation
    const baseTime = timeSeries[0].timestamp;
    const xValues = timeSeries.map(
      point => (point.timestamp - baseTime) / (1000 * 60 * 60)
    );
    const yValues = timeSeries.map(point => point.value);

    // Calculate linear regression
    const trend = this._calculateLinearTrend(xValues, yValues);

    // Generate forecast points
    const lastHour = xValues[xValues.length - 1];
    const forecast: Array<{ timestamp: string; value: number; hour: number }> =
      [];

    for (let i = 1; i <= hoursAhead; i++) {
      const hour = lastHour + i;
      const value = trend.slope * hour + trend.intercept;

      forecast.push({
        timestamp: new Date(baseTime + hour * 60 * 60 * 1000).toISOString(),
        value: Math.max(0, value), // Ensure no negative values
        hour,
      });
    }

    return {
      forecast,
      trend: {
        slope: trend.slope,
        intercept: trend.intercept,
        rSquared: trend.r2,
      },
    };
  }

  /**
   * Calculate linear trend (slope, intercept, r-squared)
   * @private
   * @param {Array} xValues - The x values
   * @param {Array} yValues - The y values
   * @returns {Object} - Trend parameters
   */
  _calculateLinearTrend(xValues, yValues) {
    if (xValues.length !== yValues.length || xValues.length < 2) {
      return { slope: 0, intercept: 0, r2: 0 };
    }

    const n = xValues.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    let sumYY = 0;

    for (let i = 0; i < n; i++) {
      sumX += xValues[i];
      sumY += yValues[i];
      sumXY += xValues[i] * yValues[i];
      sumXX += xValues[i] * xValues[i];
      sumYY += yValues[i] * yValues[i];
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // Calculate r-squared
    const meanY = sumY / n;
    let totalVariation = 0;
    let explainedVariation = 0;

    for (let i = 0; i < n; i++) {
      totalVariation += Math.pow(yValues[i] - meanY, 2);
      explainedVariation += Math.pow(slope * xValues[i] + intercept - meanY, 2);
    }

    const r2 = explainedVariation / totalVariation;

    return { slope, intercept, r2 };
  }

  /**
   * Perform IDW (Inverse Distance Weighting) interpolation
   * @private
   * @param {Array} locations - Array of known locations
   * @param {Array} values - Array of known values
   * @param {Array} interpolationPoints - Points to interpolate
   * @param {number} power - Power parameter for IDW
   * @returns {Array} - Interpolated values
   */
  _idwInterpolation(locations, values, interpolationPoints, power = 2) {
    const result: Array<number | null> = [];

    for (const point of interpolationPoints) {
      let numerator = 0;
      let denominator = 0;

      for (let i = 0; i < locations.length; i++) {
        if (values[i] === null) continue;

        // Calculate distance using Haversine formula
        const distance = this._haversineDistance(
          point.latitude,
          point.longitude,
          locations[i].latitude,
          locations[i].longitude
        );

        // Avoid division by zero
        const weight = distance === 0 ? 1 : 1 / Math.pow(distance, power);

        numerator += values[i] * weight;
        denominator += weight;
      }

      const interpolatedValue =
        denominator !== 0 ? numerator / denominator : null;
      result.push(interpolatedValue);
    }

    return result;
  }

  /**
   * Calculate Haversine distance between two points
   * @private
   * @param {number} lat1 - Latitude of first point
   * @param {number} lon1 - Longitude of first point
   * @param {number} lat2 - Latitude of second point
   * @param {number} lon2 - Longitude of second point
   * @returns {number} - Distance in kilometers
   */
  _haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = this._toRadians(lat2 - lat1);
    const dLon = this._toRadians(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this._toRadians(lat1)) *
        Math.cos(this._toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Convert degrees to radians
   * @private
   * @param {number} degrees - Angle in degrees
   * @returns {number} - Angle in radians
   */
  _toRadians(degrees) {
    return (degrees * Math.PI) / 180;
  }

  /**
   * Calculate confidence level for forecast
   * @private
   * @param {number} sampleCount - Number of data points
   * @param {Object} pm25Forecast - PM2.5 forecast
   * @param {Object} pm10Forecast - PM10 forecast
   * @returns {string} - Confidence level
   */
  _calculateConfidenceLevel(sampleCount, pm25Forecast, pm10Forecast) {
    // Get R-squared values if available
    const pm25R2 =
      pm25Forecast && pm25Forecast.trend ? pm25Forecast.trend.rSquared : 0;
    const pm10R2 =
      pm10Forecast && pm10Forecast.trend ? pm10Forecast.trend.rSquared : 0;

    // Average R-squared
    const avgR2 = (pm25R2 + pm10R2) / (pm25Forecast && pm10Forecast ? 2 : 1);

    // Factor in sample size
    let confidence = 'low';

    if (sampleCount >= 50 && avgR2 >= 0.7) {
      confidence = 'high';
    } else if (sampleCount >= 20 && avgR2 >= 0.5) {
      confidence = 'medium';
    }

    return confidence;
  }

  /**
   * Aggregate regional results into an overall summary
   * @private
   * @param {Object} regionalResults - Results by region
   * @returns {Object} - Aggregated summary
   */
  _aggregateRegionalResults(regionalResults: any): any {
    const regions = Object.values(regionalResults) as Array<{
      aqi?: number;
      category?: string;
      [key: string]: any;
    }>;

    if (regions.length === 0) {
      return null;
    }

    // Calculate average AQI
    const aqiValues = regions
      .filter(r => r.aqi !== undefined)
      .map(r => r.aqi!)
      .filter(aqi => aqi !== undefined);

    const avgAqi =
      aqiValues.length > 0
        ? aqiValues.reduce((sum, aqi) => sum + aqi, 0) / aqiValues.length
        : null;

    // Find min and max AQI
    const minAqi = aqiValues.length > 0 ? Math.min(...aqiValues) : null;
    const maxAqi = aqiValues.length > 0 ? Math.max(...aqiValues) : null;

    // Count regions by category
    const categories: Record<string, number> = {};
    for (const region of regions) {
      if (!region.category) continue;

      if (!categories[region.category]) {
        categories[region.category] = 0;
      }

      categories[region.category]++;
    }

    return {
      avgAqi: avgAqi !== null ? Math.round(avgAqi) : null,
      minAqi,
      maxAqi,
      regionCount: regions.length,
      categories,
      dominantCategory:
        Object.entries(categories)
          .sort((a, b) => b[1] - a[1])
          .map(entry => entry[0])[0] || null,
    };
  }

  /**
   * Calculate geographic bounds for a set of data points
   * @private
   * @param {Array} dataPoints - The data points
   * @returns {Object} - Geographic bounds
   */
  _calculateGeographicBounds(dataPoints: SensorDataPoint[]) {
    let minLat = 90;
    let maxLat = -90;
    let minLng = 180;
    let maxLng = -180;

    for (const dataPoint of dataPoints) {
      if (!dataPoint.location) continue;

      const { latitude, longitude } = dataPoint.location;

      if (latitude === undefined || longitude === undefined) continue;

      minLat = Math.min(minLat, latitude);
      maxLat = Math.max(maxLat, latitude);
      minLng = Math.min(minLng, longitude);
      maxLng = Math.max(maxLng, longitude);
    }

    return {
      north: maxLat,
      south: minLat,
      east: maxLng,
      west: minLng,
    };
  }

  /**
   * Calculate pruning date based on pruning period
   * @private
   * @param {number} pruningPeriod - Pruning period in months
   * @returns {string} - ISO formatted date string
   */
  _calculatePruningDate(pruningPeriod: number) {
    const now = new Date();
    const pruningDate = new Date(now);
    pruningDate.setMonth(now.getMonth() + pruningPeriod);
    return pruningDate.toISOString();
  }

  /**
   * Generate data hashes for verification
   * @private
   * @param {Array} dataPoints - The data points
   * @returns {Array} - Array of hashes
   */
  _generateDataHashes(dataPoints: SensorDataPoint[]) {
    return dataPoints.map(dataPoint => {
      // Create a stable representation for hashing
      const dataToHash = {
        sourceId: dataPoint.sourceId,
        timestamp: dataPoint.timestamp,
        measurements: dataPoint.measurements,
        location: dataPoint.location,
      };

      // Simple hash function for demonstration
      // In a real system, use a cryptographic hash function
      return this._simpleHash(JSON.stringify(dataToHash));
    });
  }

  /**
   * Simple hash function
   * @private
   * @param {string} str - String to hash
   * @returns {string} - Hash value
   */
  _simpleHash(str) {
    let hash = 0;
    if (str.length === 0) return hash.toString(16);

    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    return hash.toString(16);
  }

  /**
   * Deep compare results for verification
   * @private
   * @param {Object} a - First result
   * @param {Object} b - Second result
   * @returns {boolean} - True if results are equivalent
   */
  _deepCompareResults(a, b) {
    // Convert to strings for comparison, allowing some leeway for floating-point differences
    const aStr = JSON.stringify(a, (key, value) => {
      return typeof value === 'number' ? parseFloat(value.toFixed(4)) : value;
    });

    const bStr = JSON.stringify(b, (key, value) => {
      return typeof value === 'number' ? parseFloat(value.toFixed(4)) : value;
    });

    return aStr === bStr;
  }
}

module.exports = {
  SensorCommunityComputationalBlocks,
  PRUNING_PERIODS,
  COMPUTATIONAL_MODELS,
};
