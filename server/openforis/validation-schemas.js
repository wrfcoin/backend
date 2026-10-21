/**
 * OpenForis API Validation Schemas
 *
 * Comprehensive validation schemas for OpenForis API requests and responses
 * using express-validator and custom validation logic.
 */

const { body, param, query, check } = require('express-validator');

// Constants for OpenForis API
const VALID_PROJECT_TYPES = [
  'FOREST_MONITORING',
  'CARBON_ASSESSMENT',
  'LAND_USE_CHANGE',
  'BIODIVERSITY_MONITORING',
  'REFORESTATION',
  'CONSERVATION',
];

const VALID_FOREST_TYPES = [
  'Tropical rainforest',
  'Temperate forest',
  'Boreal forest',
  'Mixed temperate',
  'Savanna woodland',
  'Mangrove',
  'Cloud forest',
  'Dry forest',
];

const VALID_REGIONS = [
  'North America',
  'South America',
  'Europe',
  'Africa',
  'Asia',
  'Oceania',
  'Central America',
  'Caribbean',
];

const VALID_CLIMATE_SCENARIOS = [
  'RCP2.6',
  'RCP4.5',
  'RCP6.0',
  'RCP8.5',
  'SSP1-2.6',
  'SSP2-4.5',
  'SSP3-7.0',
  'SSP5-8.5',
];

const VALID_COORDINATE_SYSTEMS = ['WGS84', 'EPSG:4326', 'EPSG:3857', 'UTM'];

const VALID_RESOLUTIONS = [
  '10m',
  '30m',
  '100m',
  '250m',
  '500m',
  '1km',
  '10km',
  '50km',
];

const VALID_DATA_SOURCES = [
  'Sentinel-2',
  'Landsat-8',
  'Landsat-9',
  'MODIS',
  'Planet',
  'Worldview',
  'Spot',
];

// API Key validation
const validateApiKey = apiKey => {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('API key must be a non-empty string');
  }

  if (apiKey.length < 32 || apiKey.length > 128) {
    throw new Error('API key must be between 32 and 128 characters');
  }

  // Check for valid API key format (alphanumeric with possible special chars)
  if (!/^[A-Za-z0-9\-_.+=\/]+$/.test(apiKey)) {
    throw new Error('API key contains invalid characters');
  }

  return true;
};

// Endpoint URL validation
const validateEndpointUrl = url => {
  if (!url || typeof url !== 'string') {
    throw new Error('Endpoint URL must be a string');
  }

  try {
    const parsedUrl = new URL(url);

    // Must use HTTPS in production
    if (
      process.env.NODE_ENV === 'production' &&
      parsedUrl.protocol !== 'https:'
    ) {
      throw new Error('Endpoint URL must use HTTPS in production');
    }

    // Validate hostname is not localhost/127.0.0.1 in production
    if (process.env.NODE_ENV === 'production') {
      const hostname = parsedUrl.hostname.toLowerCase();
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0'
      ) {
        throw new Error('Cannot use localhost URLs in production');
      }
    }

    return true;
  } catch (error) {
    throw new Error(`Invalid endpoint URL: ${error.message}`);
  }
};

// Project validation schemas
const createProjectValidation = [
  body('name')
    .isLength({ min: 3, max: 100 })
    .withMessage('Project name must be between 3 and 100 characters')
    .matches(/^[a-zA-Z0-9\s\-_().,]+$/)
    .withMessage('Project name contains invalid characters'),

  body('description')
    .isLength({ min: 10, max: 1000 })
    .withMessage('Project description must be between 10 and 1000 characters')
    .trim(),

  body('type')
    .isIn(VALID_PROJECT_TYPES)
    .withMessage(
      `Project type must be one of: ${VALID_PROJECT_TYPES.join(', ')}`
    ),

  body('region')
    .isIn(VALID_REGIONS)
    .withMessage(`Region must be one of: ${VALID_REGIONS.join(', ')}`),

  body('coordinateSystem')
    .optional()
    .isIn(VALID_COORDINATE_SYSTEMS)
    .withMessage(
      `Coordinate system must be one of: ${VALID_COORDINATE_SYSTEMS.join(', ')}`
    ),

  body('surveyTemplate')
    .optional()
    .isLength({ min: 1, max: 50 })
    .withMessage('Survey template must be between 1 and 50 characters'),

  body('metadata')
    .optional()
    .isObject()
    .withMessage('Metadata must be an object')
    .custom(metadata => {
      if (
        metadata.forestType &&
        !VALID_FOREST_TYPES.includes(metadata.forestType)
      ) {
        throw new Error(
          `Forest type must be one of: ${VALID_FOREST_TYPES.join(', ')}`
        );
      }

      if (metadata.timespan && !/^\d{4}-\d{4}$/.test(metadata.timespan)) {
        throw new Error('Timespan must be in format YYYY-YYYY');
      }

      if (metadata.collaborators && !Array.isArray(metadata.collaborators)) {
        throw new Error('Collaborators must be an array');
      }

      return true;
    }),
];

// Plot validation schemas
const createPlotValidation = [
  body('name')
    .isLength({ min: 3, max: 100 })
    .withMessage('Plot name must be between 3 and 100 characters')
    .matches(/^[a-zA-Z0-9\s\-_().,]+$/)
    .withMessage('Plot name contains invalid characters'),

  body('projectId')
    .matches(/^ce-project-[a-f0-9]{8}$/)
    .withMessage('Invalid project ID format'),

  body('coordinates')
    .isObject()
    .withMessage('Coordinates must be an object')
    .custom(coords => {
      if (
        typeof coords.latitude !== 'number' ||
        coords.latitude < -90 ||
        coords.latitude > 90
      ) {
        throw new Error('Latitude must be a number between -90 and 90');
      }

      if (
        typeof coords.longitude !== 'number' ||
        coords.longitude < -180 ||
        coords.longitude > 180
      ) {
        throw new Error('Longitude must be a number between -180 and 180');
      }

      return true;
    }),

  body('size')
    .isFloat({ min: 0.1, max: 100000 })
    .withMessage('Plot size must be between 0.1 and 100,000 hectares'),

  body('forestType')
    .optional()
    .isIn(VALID_FOREST_TYPES)
    .withMessage(
      `Forest type must be one of: ${VALID_FOREST_TYPES.join(', ')}`
    ),

  body('carbonStock')
    .optional()
    .isFloat({ min: 0, max: 1000 })
    .withMessage('Carbon stock must be between 0 and 1000 tC/ha'),

  body('biodiversityIndex')
    .optional()
    .isFloat({ min: 0, max: 10 })
    .withMessage('Biodiversity index must be between 0 and 10'),

  body('metadata')
    .optional()
    .isObject()
    .withMessage('Metadata must be an object')
    .custom(metadata => {
      if (
        metadata.soilType &&
        !['Sandy', 'Clay', 'Loam', 'Silt', 'Rocky', 'Organic'].includes(
          metadata.soilType
        )
      ) {
        throw new Error('Invalid soil type');
      }

      if (
        metadata.elevation &&
        (typeof metadata.elevation !== 'number' ||
          metadata.elevation < -500 ||
          metadata.elevation > 9000)
      ) {
        throw new Error('Elevation must be between -500 and 9000 meters');
      }

      if (
        metadata.precipitation &&
        (typeof metadata.precipitation !== 'number' ||
          metadata.precipitation < 0 ||
          metadata.precipitation > 5000)
      ) {
        throw new Error('Precipitation must be between 0 and 5000 mm');
      }

      return true;
    }),
];

// Time series analysis validation
const timeSeriesAnalysisValidation = [
  param('plotId')
    .matches(/^ce-plot-[a-f0-9]{8}$/)
    .withMessage('Invalid plot ID format'),

  body('startDate')
    .optional()
    .isISO8601()
    .withMessage('Start date must be in ISO 8601 format')
    .custom(startDate => {
      const date = new Date(startDate);
      const now = new Date();
      const tenYearsAgo = new Date(
        now.getFullYear() - 10,
        now.getMonth(),
        now.getDate()
      );

      if (date < tenYearsAgo || date > now) {
        throw new Error(
          'Start date must be within the last 10 years and not in the future'
        );
      }

      return true;
    }),

  body('endDate')
    .optional()
    .isISO8601()
    .withMessage('End date must be in ISO 8601 format')
    .custom((endDate, { req }) => {
      const end = new Date(endDate);
      const now = new Date();

      if (end > now) {
        throw new Error('End date cannot be in the future');
      }

      if (req.body.startDate) {
        const start = new Date(req.body.startDate);
        if (end <= start) {
          throw new Error('End date must be after start date');
        }

        // Check reasonable time range (max 5 years)
        const diffYears = (end - start) / (365.25 * 24 * 60 * 60 * 1000);
        if (diffYears > 5) {
          throw new Error('Time range cannot exceed 5 years');
        }
      }

      return true;
    }),

  body('resolution')
    .optional()
    .isIn(VALID_RESOLUTIONS)
    .withMessage(`Resolution must be one of: ${VALID_RESOLUTIONS.join(', ')}`),

  body('metadata')
    .optional()
    .isObject()
    .withMessage('Metadata must be an object')
    .custom(metadata => {
      if (metadata.source && !VALID_DATA_SOURCES.includes(metadata.source)) {
        throw new Error(
          `Data source must be one of: ${VALID_DATA_SOURCES.join(', ')}`
        );
      }

      if (
        metadata.cloudCoverage &&
        (typeof metadata.cloudCoverage !== 'number' ||
          metadata.cloudCoverage < 0 ||
          metadata.cloudCoverage > 100)
      ) {
        throw new Error('Cloud coverage must be between 0 and 100 percent');
      }

      return true;
    }),
];

// Climate projection validation
const climateProjectionValidation = [
  body('region')
    .isIn(VALID_REGIONS)
    .withMessage(`Region must be one of: ${VALID_REGIONS.join(', ')}`),

  body('scenario')
    .isIn(VALID_CLIMATE_SCENARIOS)
    .withMessage(
      `Climate scenario must be one of: ${VALID_CLIMATE_SCENARIOS.join(', ')}`
    ),

  body('startYear')
    .optional()
    .isInt({ min: 2020, max: 2100 })
    .withMessage('Start year must be between 2020 and 2100'),

  body('endYear')
    .optional()
    .isInt({ min: 2020, max: 2100 })
    .withMessage('End year must be between 2020 and 2100')
    .custom((endYear, { req }) => {
      const startYear = req.body.startYear || 2025;
      if (endYear <= startYear) {
        throw new Error('End year must be after start year');
      }

      if (endYear - startYear > 100) {
        throw new Error('Projection period cannot exceed 100 years');
      }

      return true;
    }),

  body('resolution')
    .optional()
    .isIn(VALID_RESOLUTIONS)
    .withMessage(`Resolution must be one of: ${VALID_RESOLUTIONS.join(', ')}`),

  body('model')
    .optional()
    .isIn(['CMIP6', 'CMIP5', 'ECMWF', 'NASA-GISS', 'NCAR-CESM', 'UKMO-HadGEM'])
    .withMessage('Invalid climate model'),
];

// Response validation schemas
const validateProjectResponse = projectData => {
  const errors = [];

  if (!projectData || typeof projectData !== 'object') {
    errors.push('Project data must be an object');
    return errors;
  }

  if (!projectData.id || typeof projectData.id !== 'string') {
    errors.push('Project must have a valid ID');
  }

  if (
    !projectData.name ||
    typeof projectData.name !== 'string' ||
    projectData.name.length < 3
  ) {
    errors.push('Project must have a valid name');
  }

  if (
    !projectData.status ||
    !['ACTIVE', 'INACTIVE', 'COMPLETED', 'PENDING'].includes(projectData.status)
  ) {
    errors.push('Project must have a valid status');
  }

  if (projectData.createdAt && !Date.parse(projectData.createdAt)) {
    errors.push('Project creation date must be a valid date');
  }

  return errors;
};

const validatePlotResponse = plotData => {
  const errors = [];

  if (!plotData || typeof plotData !== 'object') {
    errors.push('Plot data must be an object');
    return errors;
  }

  if (!plotData.id || typeof plotData.id !== 'string') {
    errors.push('Plot must have a valid ID');
  }

  if (!plotData.projectId || typeof plotData.projectId !== 'string') {
    errors.push('Plot must have a valid project ID');
  }

  if (!plotData.coordinates || typeof plotData.coordinates !== 'object') {
    errors.push('Plot must have valid coordinates');
  } else {
    if (
      typeof plotData.coordinates.latitude !== 'number' ||
      plotData.coordinates.latitude < -90 ||
      plotData.coordinates.latitude > 90
    ) {
      errors.push('Plot latitude must be between -90 and 90');
    }

    if (
      typeof plotData.coordinates.longitude !== 'number' ||
      plotData.coordinates.longitude < -180 ||
      plotData.coordinates.longitude > 180
    ) {
      errors.push('Plot longitude must be between -180 and 180');
    }
  }

  return errors;
};

const validateTimeSeriesResponse = timeSeriesData => {
  const errors = [];

  if (!timeSeriesData || typeof timeSeriesData !== 'object') {
    errors.push('Time series data must be an object');
    return errors;
  }

  if (!timeSeriesData.id || typeof timeSeriesData.id !== 'string') {
    errors.push('Time series must have a valid ID');
  }

  if (!timeSeriesData.plotId || typeof timeSeriesData.plotId !== 'string') {
    errors.push('Time series must have a valid plot ID');
  }

  if (timeSeriesData.dataPoints && Array.isArray(timeSeriesData.dataPoints)) {
    timeSeriesData.dataPoints.forEach((point, index) => {
      if (!point.timestamp || !Date.parse(point.timestamp)) {
        errors.push(`Data point ${index} must have a valid timestamp`);
      }

      if (
        typeof point.ndvi !== 'undefined' &&
        (typeof point.ndvi !== 'number' || point.ndvi < -1 || point.ndvi > 1)
      ) {
        errors.push(`Data point ${index} NDVI must be between -1 and 1`);
      }

      if (
        typeof point.temperature !== 'undefined' &&
        (typeof point.temperature !== 'number' ||
          point.temperature < -50 ||
          point.temperature > 60)
      ) {
        errors.push(
          `Data point ${index} temperature must be between -50 and 60°C`
        );
      }
    });
  }

  return errors;
};

const validateClimateResponse = climateData => {
  const errors = [];

  if (!climateData || typeof climateData !== 'object') {
    errors.push('Climate data must be an object');
    return errors;
  }

  if (!climateData.id || typeof climateData.id !== 'string') {
    errors.push('Climate data must have a valid ID');
  }

  if (!climateData.region || !VALID_REGIONS.includes(climateData.region)) {
    errors.push('Climate data must have a valid region');
  }

  if (
    !climateData.scenario ||
    !VALID_CLIMATE_SCENARIOS.includes(climateData.scenario)
  ) {
    errors.push('Climate data must have a valid scenario');
  }

  if (climateData.projections && Array.isArray(climateData.projections)) {
    climateData.projections.forEach((projection, index) => {
      if (
        typeof projection.year !== 'number' ||
        projection.year < 2020 ||
        projection.year > 2100
      ) {
        errors.push(`Projection ${index} year must be between 2020 and 2100`);
      }

      if (
        typeof projection.temperature !== 'number' ||
        projection.temperature < -50 ||
        projection.temperature > 60
      ) {
        errors.push(
          `Projection ${index} temperature must be between -50 and 60°C`
        );
      }
    });
  }

  return errors;
};

module.exports = {
  // Validation functions
  validateApiKey,
  validateEndpointUrl,

  // Request validation schemas
  createProjectValidation,
  createPlotValidation,
  timeSeriesAnalysisValidation,
  climateProjectionValidation,

  // Response validation functions
  validateProjectResponse,
  validatePlotResponse,
  validateTimeSeriesResponse,
  validateClimateResponse,

  // Constants
  VALID_PROJECT_TYPES,
  VALID_FOREST_TYPES,
  VALID_REGIONS,
  VALID_CLIMATE_SCENARIOS,
  VALID_COORDINATE_SYSTEMS,
  VALID_RESOLUTIONS,
  VALID_DATA_SOURCES,
};
