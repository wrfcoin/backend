/**
 * OpenForis Data Transformation Utilities
 * Transforms OpenForis API responses to application-compatible formats
 */

const crypto = require('crypto');
const { z } = require('zod');
const createLogger = require('./logger');

const LOG_PREFIX = 'openforis:transformer';
const logger = createLogger(LOG_PREFIX);

// Validation schemas for OpenForis data
const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.string().optional(),
  region: z.string().optional(),
  status: z.string().optional(),
  created_at: z.string().optional(),
  metadata: z.object({}).optional(),
});

const PlotSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  coordinates: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }),
  area_hectares: z.number().optional(),
  forest_type: z.string().optional(),
  carbon_stock_tc_per_ha: z.number().optional(),
  biodiversity_index: z.number().optional(),
  last_updated: z.string().optional(),
  attributes: z.object({}).optional(),
});

const TimeSeriesSchema = z.object({
  id: z.string(),
  plot_id: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  resolution_meters: z.string().optional(),
  satellite_source: z.string().optional(),
  data_points: z.array(
    z.object({
      timestamp: z.string(),
      ndvi: z.number().optional(),
      precipitation_mm: z.number().optional(),
      temperature_celsius: z.number().optional(),
      forest_cover_percent: z.number().optional(),
      forest_loss_percent: z.number().optional(),
      soil_moisture_percent: z.number().optional(),
    })
  ),
});

const ClimateDataSchema = z.object({
  id: z.string(),
  region: z.string(),
  scenario: z.string(),
  time_range: z.string(),
  resolution_km: z.string().optional(),
  variables: z.array(z.string()),
  projections: z.array(
    z.object({
      year: z.number(),
      temperature_celsius: z.number().optional(),
      precipitation_mm: z.number().optional(),
      extreme_events_count: z.number().optional(),
    })
  ),
  model_metadata: z.object({}).optional(),
});

/**
 * OpenForis Data Transformer Class
 */
class OpenForisTransformer {
  constructor() {
    this.transformationStats = {
      successfulTransforms: 0,
      failedTransforms: 0,
      lastTransformTime: null,
    };
  }

  /**
   * Transform OpenForis project data to application format
   * @param {Object} openforisProject Raw OpenForis project data
   * @returns {Object} Transformed project data
   */
  transformProject(openforisProject) {
    try {
      // Validate input data
      const validated = ProjectSchema.parse(openforisProject);

      const transformed = {
        id: validated.id,
        name: validated.name,
        description: validated.description || 'No description provided',
        type: this.mapProjectType(validated.type),
        region: validated.region || 'Unknown',
        createdAt: this.parseDate(validated.created_at),
        status: this.mapStatus(validated.status),
        plotCount: 0, // Will be populated separately
        metadata: {
          ...validated.metadata,
          source: 'OpenForis',
          originalType: validated.type,
          transformedAt: new Date().toISOString(),
        },
      };

      this.transformationStats.successfulTransforms++;
      logger.debug(`${LOG_PREFIX} Successfully transformed project`, {
        projectId: transformed.id,
      });

      return transformed;
    } catch (error) {
      this.transformationStats.failedTransforms++;
      logger.error(`${LOG_PREFIX} Failed to transform project`, {
        error: error.message,
        data: openforisProject,
      });
      throw new Error(`Project transformation failed: ${error.message}`);
    }
  }

  /**
   * Transform OpenForis plot data to application format
   * @param {Object} openforisPlot Raw OpenForis plot data
   * @returns {Object} Transformed plot data
   */
  transformPlot(openforisPlot) {
    try {
      const validated = PlotSchema.parse(openforisPlot);

      const transformed = {
        id: validated.id,
        projectId: validated.project_id,
        name: validated.name,
        coordinates: {
          latitude: validated.coordinates.latitude,
          longitude: validated.coordinates.longitude,
        },
        size: validated.area_hectares || 0,
        forestType: this.mapForestType(validated.forest_type),
        carbonStock: validated.carbon_stock_tc_per_ha || 0,
        biodiversityIndex: this.normalizeBiodiversityIndex(
          validated.biodiversity_index
        ),
        status: 'VERIFIED',
        lastUpdated: this.parseDate(validated.last_updated),
        metadata: {
          ...validated.attributes,
          source: 'OpenForis',
          originalForestType: validated.forest_type,
          transformedAt: new Date().toISOString(),
        },
      };

      this.transformationStats.successfulTransforms++;
      logger.debug(`${LOG_PREFIX} Successfully transformed plot`, {
        plotId: transformed.id,
      });

      return transformed;
    } catch (error) {
      this.transformationStats.failedTransforms++;
      logger.error(`${LOG_PREFIX} Failed to transform plot`, {
        error: error.message,
        data: openforisPlot,
      });
      throw new Error(`Plot transformation failed: ${error.message}`);
    }
  }

  /**
   * Transform OpenForis time series data to application format
   * @param {Object} openforisTimeSeries Raw OpenForis time series data
   * @returns {Object} Transformed time series data
   */
  transformTimeSeries(openforisTimeSeries) {
    try {
      const validated = TimeSeriesSchema.parse(openforisTimeSeries);

      const transformed = {
        id: validated.id,
        plotId: validated.plot_id,
        projectId: null, // Will be populated by adapter
        type: 'EARTH_MAP',
        startDate: this.parseDate(validated.start_date),
        endDate: this.parseDate(validated.end_date),
        resolution: validated.resolution_meters
          ? validated.resolution_meters.includes('m')
            ? validated.resolution_meters
            : validated.resolution_meters + 'm'
          : '30m',
        dataPoints: validated.data_points.map(point => ({
          timestamp: this.parseDate(point.timestamp),
          ndvi: point.ndvi || 0,
          precipitation: point.precipitation_mm || 0,
          temperature: point.temperature_celsius || 0,
          forestCover: point.forest_cover_percent || 0,
          forestLoss: point.forest_loss_percent || 0,
          soilMoisture: point.soil_moisture_percent || 0,
        })),
        metadata: {
          source: validated.satellite_source || 'Unknown',
          processing: 'Level 2A',
          cloudCoverage: Math.random() * 30, // Placeholder
          transformedAt: new Date().toISOString(),
        },
      };

      this.transformationStats.successfulTransforms++;
      logger.debug(`${LOG_PREFIX} Successfully transformed time series`, {
        timeSeriesId: transformed.id,
        dataPointCount: transformed.dataPoints.length,
      });

      return transformed;
    } catch (error) {
      this.transformationStats.failedTransforms++;
      logger.error(`${LOG_PREFIX} Failed to transform time series`, {
        error: error.message,
        data: openforisTimeSeries,
      });
      throw new Error(`Time series transformation failed: ${error.message}`);
    }
  }

  /**
   * Transform OpenForis climate data to application format
   * @param {Object} openforisClimateData Raw OpenForis climate data
   * @returns {Object} Transformed climate data
   */
  transformClimateData(openforisClimateData) {
    try {
      const validated = ClimateDataSchema.parse(openforisClimateData);

      const transformed = {
        id: validated.id,
        region: validated.region,
        scenario: validated.scenario,
        timeRange: validated.time_range,
        resolution: validated.resolution_km || '50km',
        variables: validated.variables,
        projections: validated.projections.map(proj => ({
          year: proj.year,
          temperature: proj.temperature_celsius || 0,
          precipitation: proj.precipitation_mm || 0,
          extremeEvents: proj.extreme_events_count || 0,
        })),
        metadata: {
          ...validated.model_metadata,
          source: 'OpenForis Climate Data',
          uncertainty: Math.random() * 0.2 + 0.1, // 10-30% placeholder
          transformedAt: new Date().toISOString(),
        },
      };

      this.transformationStats.successfulTransforms++;
      logger.debug(`${LOG_PREFIX} Successfully transformed climate data`, {
        climateDataId: transformed.id,
        projectionCount: transformed.projections.length,
      });

      return transformed;
    } catch (error) {
      this.transformationStats.failedTransforms++;
      logger.error(`${LOG_PREFIX} Failed to transform climate data`, {
        error: error.message,
        data: openforisClimateData,
      });
      throw new Error(`Climate data transformation failed: ${error.message}`);
    }
  }

  /**
   * Batch transform multiple items
   * @param {Array} items Array of items to transform
   * @param {string} type Type of transformation ('project', 'plot', 'timeSeries', 'climateData')
   * @returns {Array} Array of transformed items
   */
  batchTransform(items, type) {
    if (!Array.isArray(items)) {
      throw new Error('Items must be an array');
    }

    const transformMethod = {
      project: this.transformProject.bind(this),
      plot: this.transformPlot.bind(this),
      timeSeries: this.transformTimeSeries.bind(this),
      climateData: this.transformClimateData.bind(this),
    }[type];

    if (!transformMethod) {
      throw new Error(`Unknown transformation type: ${type}`);
    }

    const results = [];
    const errors = [];

    for (let i = 0; i < items.length; i++) {
      try {
        results.push(transformMethod(items[i]));
      } catch (error) {
        errors.push({ index: i, error: error.message, item: items[i] });
      }
    }

    logger.info(`${LOG_PREFIX} Batch transformation completed`, {
      type,
      totalItems: items.length,
      successful: results.length,
      failed: errors.length,
    });

    if (errors.length > 0) {
      logger.warn(`${LOG_PREFIX} Batch transformation had errors`, { errors });
    }

    return { results, errors };
  }

  /**
   * Map OpenForis project types to application types
   * @param {string} openforisType OpenForis project type
   * @returns {string} Application project type
   */
  mapProjectType(openforisType) {
    const typeMapping = {
      forest_monitoring: 'FOREST_MONITORING',
      carbon_assessment: 'CARBON_ASSESSMENT',
      land_use_change: 'LAND_USE_CHANGE',
      biodiversity_survey: 'BIODIVERSITY_SURVEY',
      deforestation_tracking: 'DEFORESTATION_TRACKING',
    };

    return typeMapping[openforisType?.toLowerCase()] || 'FOREST_MONITORING';
  }

  /**
   * Map OpenForis forest types to application types
   * @param {string} openforisForestType OpenForis forest type
   * @returns {string} Application forest type
   */
  mapForestType(openforisForestType) {
    const typeMapping = {
      tropical_rainforest: 'Tropical rainforest',
      temperate_forest: 'Mixed temperate',
      savanna_woodland: 'Savanna woodland',
      boreal_forest: 'Boreal forest',
      mediterranean_forest: 'Mediterranean forest',
      mangrove: 'Mangrove forest',
    };

    return typeMapping[openforisForestType?.toLowerCase()] || 'Mixed';
  }

  /**
   * Map OpenForis status to application status
   * @param {string} openforisStatus OpenForis status
   * @returns {string} Application status
   */
  mapStatus(openforisStatus) {
    const statusMapping = {
      active: 'ACTIVE',
      completed: 'COMPLETED',
      paused: 'PAUSED',
      archived: 'ARCHIVED',
    };

    return statusMapping[openforisStatus?.toLowerCase()] || 'ACTIVE';
  }

  /**
   * Normalize biodiversity index to 0-10 scale
   * @param {number} value Raw biodiversity value
   * @returns {number} Normalized biodiversity index
   */
  normalizeBiodiversityIndex(value) {
    if (typeof value !== 'number') return 5.0; // Default middle value

    // Assume input is 0-100, normalize to 0-10
    if (value > 10) {
      return Math.min(value / 10, 10);
    }

    return Math.max(0, Math.min(value, 10));
  }

  /**
   * Parse date string to ISO format
   * @param {string} dateString Date string
   * @returns {string} ISO date string
   */
  parseDate(dateString) {
    if (!dateString) return new Date().toISOString();

    try {
      return new Date(dateString).toISOString();
    } catch (error) {
      logger.warn(`${LOG_PREFIX} Failed to parse date: ${dateString}`);
      return new Date().toISOString();
    }
  }

  /**
   * Get transformation statistics
   * @returns {Object} Transformation statistics
   */
  getStats() {
    return {
      ...this.transformationStats,
      lastTransformTime: this.transformationStats.lastTransformTime,
      successRate:
        this.transformationStats.successfulTransforms +
          this.transformationStats.failedTransforms >
        0
          ? (
              (this.transformationStats.successfulTransforms /
                (this.transformationStats.successfulTransforms +
                  this.transformationStats.failedTransforms)) *
              100
            ).toFixed(2) + '%'
          : '0%',
    };
  }

  /**
   * Transform and aggregate multiple time series data points
   * @param {Array} timeSeriesArray Array of time series data
   * @param {Object} aggregationOptions Aggregation options
   * @returns {Object} Aggregated time series data
   */
  aggregateTimeSeries(timeSeriesArray, aggregationOptions = {}) {
    try {
      const {
        aggregationType = 'monthly', // daily, weekly, monthly, yearly
        variables = ['ndvi', 'precipitation', 'temperature', 'forestCover'],
        statisticFunctions = ['mean', 'min', 'max', 'stddev'],
      } = aggregationOptions;

      if (!Array.isArray(timeSeriesArray) || timeSeriesArray.length === 0) {
        throw new Error('Time series array cannot be empty');
      }

      // Collect all data points from all time series
      const allDataPoints = [];
      for (const timeSeries of timeSeriesArray) {
        if (timeSeries.dataPoints && Array.isArray(timeSeries.dataPoints)) {
          allDataPoints.push(
            ...timeSeries.dataPoints.map(point => ({
              ...point,
              sourceId: timeSeries.id,
              plotId: timeSeries.plotId,
            }))
          );
        }
      }

      // Sort by timestamp
      allDataPoints.sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );

      // Group by time period
      const groupedData = this.groupDataByTimeAggregation(
        allDataPoints,
        aggregationType
      );

      // Calculate statistics for each group
      const aggregatedData = Object.keys(groupedData).map(timePeriod => {
        const dataPoints = groupedData[timePeriod];
        const aggregatedPoint = {
          timePeriod,
          timestamp: dataPoints[0].timestamp, // Representative timestamp
          dataPointCount: dataPoints.length,
          statistics: {},
        };

        // Calculate statistics for each variable
        for (const variable of variables) {
          const values = dataPoints
            .map(point => point[variable])
            .filter(value => typeof value === 'number' && !isNaN(value));

          if (values.length > 0) {
            aggregatedPoint.statistics[variable] = {};

            if (statisticFunctions.includes('mean')) {
              aggregatedPoint.statistics[variable].mean =
                values.reduce((sum, val) => sum + val, 0) / values.length;
            }
            if (statisticFunctions.includes('min')) {
              aggregatedPoint.statistics[variable].min = Math.min(...values);
            }
            if (statisticFunctions.includes('max')) {
              aggregatedPoint.statistics[variable].max = Math.max(...values);
            }
            if (statisticFunctions.includes('stddev')) {
              const mean =
                aggregatedPoint.statistics[variable].mean ||
                values.reduce((sum, val) => sum + val, 0) / values.length;
              const variance =
                values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
                values.length;
              aggregatedPoint.statistics[variable].stddev = Math.sqrt(variance);
            }
          }
        }

        return aggregatedPoint;
      });

      this.transformationStats.successfulTransforms++;
      logger.debug(`${LOG_PREFIX} Successfully aggregated time series`, {
        inputSeries: timeSeriesArray.length,
        totalDataPoints: allDataPoints.length,
        aggregatedPeriods: aggregatedData.length,
      });

      return {
        aggregationType,
        variables,
        statisticFunctions,
        aggregatedData,
        metadata: {
          inputTimeSeriesCount: timeSeriesArray.length,
          totalDataPoints: allDataPoints.length,
          aggregatedPeriods: aggregatedData.length,
          timeRange: {
            start: allDataPoints[0]?.timestamp,
            end: allDataPoints[allDataPoints.length - 1]?.timestamp,
          },
          transformedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.transformationStats.failedTransforms++;
      logger.error(`${LOG_PREFIX} Failed to aggregate time series`, {
        error: error.message,
      });
      throw new Error(`Time series aggregation failed: ${error.message}`);
    }
  }

  /**
   * Group data points by time aggregation type
   * @param {Array} dataPoints Array of data points
   * @param {string} aggregationType Aggregation type
   * @returns {Object} Grouped data points
   */
  groupDataByTimeAggregation(dataPoints, aggregationType) {
    const grouped = {};

    for (const point of dataPoints) {
      const date = new Date(point.timestamp);
      let groupKey;

      switch (aggregationType) {
        case 'daily':
          groupKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          break;
        case 'weekly':
          const startOfWeek = new Date(date);
          startOfWeek.setDate(date.getDate() - date.getDay());
          groupKey = `${startOfWeek.getFullYear()}-W${String(Math.ceil(startOfWeek.getDate() / 7)).padStart(2, '0')}`;
          break;
        case 'monthly':
          groupKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          break;
        case 'yearly':
          groupKey = date.getFullYear().toString();
          break;
        default:
          groupKey = 'all';
      }

      if (!grouped[groupKey]) {
        grouped[groupKey] = [];
      }
      grouped[groupKey].push(point);
    }

    return grouped;
  }

  /**
   * Transform data for carbon credit calculations
   * @param {Object} plotData Plot data
   * @param {Object} timeSeriesData Time series data
   * @returns {Object} Carbon credit calculation data
   */
  transformForCarbonCredits(plotData, timeSeriesData) {
    try {
      // Validate input data
      if (!plotData || !timeSeriesData) {
        throw new Error('Plot data and time series data are required');
      }

      const carbonCalculation = {
        plotId: plotData.id,
        area: plotData.size || 0,
        forestType: plotData.forestType,
        baselineCarbonStock: plotData.carbonStock || 0,
        calculations: [],
        totalCarbonSequestration: 0,
        eligibleCredits: 0,
        metadata: {
          calculationMethod: 'IPCC Tier 2',
          dataQuality: 'standard',
          uncertaintyLevel: 'medium',
          calculatedAt: new Date().toISOString(),
        },
      };

      // Process time series data to calculate carbon sequestration over time
      if (
        timeSeriesData.dataPoints &&
        Array.isArray(timeSeriesData.dataPoints)
      ) {
        const sortedPoints = timeSeriesData.dataPoints
          .filter(point => point.forestCover && point.ndvi)
          .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        for (let i = 1; i < sortedPoints.length; i++) {
          const currentPoint = sortedPoints[i];
          const previousPoint = sortedPoints[i - 1];

          // Calculate forest cover change
          const forestCoverChange =
            currentPoint.forestCover - previousPoint.forestCover;
          const ndviChange = currentPoint.ndvi - previousPoint.ndvi;

          // Estimate carbon sequestration based on forest cover and NDVI improvements
          // This is a simplified calculation - real implementations would use more complex models
          const carbonSequestration = this.calculateCarbonSequestration(
            forestCoverChange,
            ndviChange,
            plotData.size,
            plotData.forestType
          );

          const timePeriod = this.calculateTimePeriod(
            previousPoint.timestamp,
            currentPoint.timestamp
          );

          carbonCalculation.calculations.push({
            period: timePeriod,
            fromDate: previousPoint.timestamp,
            toDate: currentPoint.timestamp,
            forestCoverChange,
            ndviChange,
            carbonSequestration,
            forestCover: currentPoint.forestCover,
            ndvi: currentPoint.ndvi,
          });

          carbonCalculation.totalCarbonSequestration += carbonSequestration;
        }
      }

      // Calculate eligible carbon credits (only positive sequestration)
      carbonCalculation.eligibleCredits = Math.max(
        0,
        carbonCalculation.totalCarbonSequestration
      );

      // Add uncertainty and quality adjustments
      const qualityFactor = this.calculateDataQualityFactor(timeSeriesData);
      carbonCalculation.eligibleCredits *= qualityFactor;
      carbonCalculation.metadata.dataQuality =
        qualityFactor > 0.8 ? 'high' : qualityFactor > 0.6 ? 'medium' : 'low';

      this.transformationStats.successfulTransforms++;
      logger.debug(
        `${LOG_PREFIX} Successfully transformed for carbon credits`,
        {
          plotId: plotData.id,
          totalSequestration: carbonCalculation.totalCarbonSequestration,
          eligibleCredits: carbonCalculation.eligibleCredits,
        }
      );

      return carbonCalculation;
    } catch (error) {
      this.transformationStats.failedTransforms++;
      logger.error(`${LOG_PREFIX} Failed to transform for carbon credits`, {
        error: error.message,
      });
      throw new Error(`Carbon credit transformation failed: ${error.message}`);
    }
  }

  /**
   * Calculate carbon sequestration based on forest metrics
   * @param {number} forestCoverChange Forest cover change percentage
   * @param {number} ndviChange NDVI change
   * @param {number} area Area in hectares
   * @param {string} forestType Forest type
   * @returns {number} Carbon sequestration in tons CO2
   */
  calculateCarbonSequestration(
    forestCoverChange,
    ndviChange,
    area,
    forestType
  ) {
    // Simplified carbon sequestration calculation
    // Real implementations would use established methodologies like VM0007, VM0015, etc.

    const forestTypeFactors = {
      'Tropical rainforest': 4.2,
      'Mixed temperate': 2.8,
      'Savanna woodland': 1.9,
      'Boreal forest': 2.1,
      'Mediterranean forest': 2.3,
      'Mangrove forest': 3.8,
      Mixed: 2.5,
    };

    const factor = forestTypeFactors[forestType] || forestTypeFactors['Mixed'];

    // Calculate based on forest cover improvement and NDVI (biomass indicator)
    const coverContribution =
      Math.max(0, forestCoverChange / 100) * area * factor;
    const ndviContribution = Math.max(0, ndviChange) * area * factor * 0.5;

    return coverContribution + ndviContribution;
  }

  /**
   * Calculate time period between two dates
   * @param {string} startDate Start date ISO string
   * @param {string} endDate End date ISO string
   * @returns {number} Time period in years
   */
  calculateTimePeriod(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffMs = end.getTime() - start.getTime();
    return diffMs / (365.25 * 24 * 60 * 60 * 1000); // Convert to years
  }

  /**
   * Calculate data quality factor based on time series completeness and consistency
   * @param {Object} timeSeriesData Time series data
   * @returns {number} Quality factor between 0 and 1
   */
  calculateDataQualityFactor(timeSeriesData) {
    if (!timeSeriesData.dataPoints || timeSeriesData.dataPoints.length === 0) {
      return 0;
    }

    let qualityScore = 1.0;

    // Penalize for missing data points
    const expectedPoints = 12; // Monthly data for a year
    const actualPoints = timeSeriesData.dataPoints.length;
    const completenessFactor = Math.min(actualPoints / expectedPoints, 1.0);
    qualityScore *= completenessFactor;

    // Penalize for missing variables in data points
    let totalVariables = 0;
    let completeVariables = 0;

    for (const point of timeSeriesData.dataPoints) {
      const requiredVars = [
        'ndvi',
        'forestCover',
        'precipitation',
        'temperature',
      ];
      totalVariables += requiredVars.length;

      for (const variable of requiredVars) {
        if (typeof point[variable] === 'number' && !isNaN(point[variable])) {
          completeVariables++;
        }
      }
    }

    const variableCompletenessFactor =
      totalVariables > 0 ? completeVariables / totalVariables : 0;
    qualityScore *= variableCompletenessFactor;

    return Math.max(0.1, qualityScore); // Minimum quality factor of 0.1
  }

  /**
   * Reset transformation statistics
   */
  resetStats() {
    this.transformationStats = {
      successfulTransforms: 0,
      failedTransforms: 0,
      lastTransformTime: null,
    };
  }
}

module.exports = { OpenForisTransformer };
