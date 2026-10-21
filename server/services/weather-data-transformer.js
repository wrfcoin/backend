/**
 * Weather Data Transformation Pipeline
 *
 * Transforms weather data from various sources into the unified WRFCoin format.
 * Handles mapping between different data structures, applying transformations,
 * and ensuring data consistency across all sources.
 */

const { logger } = require('../utils/logger');
const {
  WRFCoinWeatherSchema,
  SourceSchemaMappings,
} = require('./weather-data-schema');
const WeatherDataCleaner = require('./weather-data-cleaner');

class WeatherDataTransformer {
  constructor() {
    this.dataCleaner = new WeatherDataCleaner();
    this.supportedSources = Object.keys(SourceSchemaMappings);

    // Transformation rules and mappings
    this.transformationRules = {
      'NOAA-NWS': this.transformNOAANWS.bind(this),
      'NOAA-NCEI': this.transformNOAANCEI.bind(this),
      OpenWeatherMap: this.transformOpenWeatherMap.bind(this),
      LocalStation: this.transformLocalStation.bind(this),
      default: this.transformGeneric.bind(this),
    };
  }

  /**
   * Transform weather data from any supported source to WRFCoin format
   */
  async transformWeatherData(rawData, sourceType, options = {}) {
    const {
      enableCleaning = true,
      enableValidation = true,
      strictMode = false,
      preserveOriginal = true,
    } = options;

    const transformationResult = {
      sourceType,
      originalData: preserveOriginal ? rawData : null,
      transformedData: null,
      transformationSteps: [],
      warnings: [],
      errors: [],
      success: false,
      timestamp: new Date().toISOString(),
    };

    try {
      // Step 1: Validate source type
      if (
        !this.supportedSources.includes(sourceType) &&
        sourceType !== 'default'
      ) {
        throw new Error(`Unsupported source type: ${sourceType}`);
      }

      transformationResult.transformationSteps.push({
        step: 'source_validation',
        status: 'completed',
        message: `Source type ${sourceType} validated`,
      });

      // Step 2: Apply source-specific transformation
      const transformer =
        this.transformationRules[sourceType] ||
        this.transformationRules.default;
      const baseTransform = await transformer(rawData, options);

      transformationResult.transformedData = baseTransform.data;
      transformationResult.transformationSteps.push(...baseTransform.steps);
      transformationResult.warnings.push(...baseTransform.warnings);

      if (baseTransform.errors.length > 0) {
        transformationResult.errors.push(...baseTransform.errors);
        if (strictMode) {
          throw new Error(
            `Transformation errors: ${baseTransform.errors.join(', ')}`
          );
        }
      }

      // Step 3: Apply data cleaning if enabled
      if (enableCleaning) {
        const cleaningResult = await this.dataCleaner.cleanWeatherRecord(
          transformationResult.transformedData,
          { strictMode }
        );

        transformationResult.transformedData = cleaningResult.cleanedData;
        transformationResult.cleaningActions = cleaningResult.cleaningActions;
        transformationResult.qualityFlags = cleaningResult.qualityFlags;
        transformationResult.overallQuality = cleaningResult.overallQuality;

        transformationResult.transformationSteps.push({
          step: 'data_cleaning',
          status: 'completed',
          message: `Data cleaning applied with quality: ${cleaningResult.overallQuality}`,
          details: {
            actionsPerformed: cleaningResult.cleaningActions.length,
            qualityScore: cleaningResult.score,
          },
        });

        if (cleaningResult.errors.length > 0) {
          transformationResult.errors.push(...cleaningResult.errors);
        }
        if (cleaningResult.warnings.length > 0) {
          transformationResult.warnings.push(...cleaningResult.warnings);
        }
      }

      // Step 4: Final structure validation
      const structureValidation = this.validateWRFCoinStructure(
        transformationResult.transformedData
      );
      transformationResult.transformationSteps.push({
        step: 'structure_validation',
        status: structureValidation.valid ? 'completed' : 'failed',
        message: structureValidation.message,
        details: structureValidation.details,
      });

      if (!structureValidation.valid) {
        transformationResult.errors.push(
          `Structure validation failed: ${structureValidation.message}`
        );
        if (strictMode) {
          throw new Error(
            `Invalid WRFCoin structure: ${structureValidation.message}`
          );
        }
      }

      transformationResult.success =
        transformationResult.errors.length === 0 || !strictMode;

      logger.debug('Weather data transformation completed', {
        sourceType,
        success: transformationResult.success,
        warnings: transformationResult.warnings.length,
        errors: transformationResult.errors.length,
        overallQuality: transformationResult.overallQuality,
      });

      return transformationResult;
    } catch (error) {
      logger.error('Weather data transformation failed:', {
        sourceType,
        error: error.message,
        rawData: preserveOriginal ? null : 'not preserved',
      });

      transformationResult.errors.push(
        `Transformation failed: ${error.message}`
      );
      transformationResult.success = false;

      return transformationResult;
    }
  }

  /**
   * Transform NOAA NWS API data
   */
  async transformNOAANWS(rawData, options = {}) {
    const result = {
      data: this.createEmptyWRFCoinRecord(),
      steps: [],
      warnings: [],
      errors: [],
    };

    try {
      // Handle both single observations and arrays
      const observations = Array.isArray(rawData) ? rawData : [rawData];

      if (observations.length === 0) {
        throw new Error('No observations provided');
      }

      // Use the first observation for transformation
      const obs = observations[0];
      const props = obs.properties || obs;

      result.steps.push({
        step: 'noaa_nws_parsing',
        status: 'in_progress',
        message: 'Parsing NOAA NWS observation data',
      });

      // Transform metadata
      result.data.metadata = {
        sourceId: this.getNestedValue(props, 'station') || 'unknown',
        sourceType: 'api',
        provider: 'NOAA-NWS',
        dataType: 'current',
        timestamp:
          this.getNestedValue(props, 'timestamp') || new Date().toISOString(),
        ingestedAt: new Date().toISOString(),
        qualityScore: 1.0,
        validationStatus: 'pending',
      };

      // Transform location
      result.data.location = {
        latitude: this.getNestedValue(obs, 'geometry.coordinates[1]'),
        longitude: this.getNestedValue(obs, 'geometry.coordinates[0]'),
        elevation: this.getNestedValue(props, 'elevation.value'),
        stationId: this.getNestedValue(props, 'station'),
        stationName:
          this.getNestedValue(props, 'stationName') || 'Unknown Station',
        locationName:
          this.getNestedValue(props, 'stationName') || 'Unknown Location',
      };

      // Transform measurements
      result.data.measurements = {};

      // Temperature
      const temp = this.getNestedValue(props, 'temperature.value');
      if (temp !== null) {
        result.data.measurements.temperature = {
          value: this.convertTemperature(
            temp,
            this.getNestedValue(props, 'temperature.unitCode')
          ),
          unit: 'celsius',
          qualityFlag:
            this.getNestedValue(props, 'temperature.qualityControl') || 'A',
        };
      }

      // Dewpoint
      const dewpoint = this.getNestedValue(props, 'dewpoint.value');
      if (dewpoint !== null) {
        result.data.measurements.dewpoint = {
          value: this.convertTemperature(
            dewpoint,
            this.getNestedValue(props, 'dewpoint.unitCode')
          ),
          unit: 'celsius',
          qualityFlag:
            this.getNestedValue(props, 'dewpoint.qualityControl') || 'A',
        };
      }

      // Humidity
      const humidity = this.getNestedValue(props, 'relativeHumidity.value');
      if (humidity !== null) {
        result.data.measurements.humidity = {
          value: humidity,
          unit: 'percent',
          qualityFlag:
            this.getNestedValue(props, 'relativeHumidity.qualityControl') ||
            'A',
        };
      }

      // Pressure
      const pressure = this.getNestedValue(props, 'barometricPressure.value');
      if (pressure !== null) {
        result.data.measurements.pressure = {
          value: this.convertPressure(
            pressure,
            this.getNestedValue(props, 'barometricPressure.unitCode')
          ),
          unit: 'hPa',
          qualityFlag:
            this.getNestedValue(props, 'barometricPressure.qualityControl') ||
            'A',
        };
      }

      // Wind Speed
      const windSpeed = this.getNestedValue(props, 'windSpeed.value');
      if (windSpeed !== null) {
        result.data.measurements.windSpeed = {
          value: this.convertWindSpeed(
            windSpeed,
            this.getNestedValue(props, 'windSpeed.unitCode')
          ),
          unit: 'm/s',
          qualityFlag:
            this.getNestedValue(props, 'windSpeed.qualityControl') || 'A',
        };
      }

      // Wind Direction
      const windDirection = this.getNestedValue(props, 'windDirection.value');
      if (windDirection !== null) {
        result.data.measurements.windDirection = {
          value: windDirection,
          unit: 'degrees',
          qualityFlag:
            this.getNestedValue(props, 'windDirection.qualityControl') || 'A',
        };
      }

      // Visibility
      const visibility = this.getNestedValue(props, 'visibility.value');
      if (visibility !== null) {
        result.data.measurements.visibility = {
          value: this.convertDistance(
            visibility,
            this.getNestedValue(props, 'visibility.unitCode')
          ),
          unit: 'km',
          qualityFlag:
            this.getNestedValue(props, 'visibility.qualityControl') || 'A',
        };
      }

      result.steps.push({
        step: 'noaa_nws_parsing',
        status: 'completed',
        message: 'NOAA NWS data successfully transformed',
      });
    } catch (error) {
      result.errors.push(`NOAA NWS transformation error: ${error.message}`);
      result.steps.push({
        step: 'noaa_nws_parsing',
        status: 'failed',
        message: error.message,
      });
    }

    return result;
  }

  /**
   * Transform NOAA NCEI historical data
   */
  async transformNOAANCEI(rawData, options = {}) {
    const result = {
      data: this.createEmptyWRFCoinRecord(),
      steps: [],
      warnings: [],
      errors: [],
    };

    try {
      result.steps.push({
        step: 'noaa_ncei_parsing',
        status: 'in_progress',
        message: 'Parsing NOAA NCEI historical data',
      });

      // Handle both single records and arrays
      const records = Array.isArray(rawData) ? rawData : [rawData];

      if (records.length === 0) {
        throw new Error('No records provided');
      }

      // Use the first record for transformation
      const record = records[0];

      // Transform metadata
      result.data.metadata = {
        sourceId: record.station || 'unknown',
        sourceType: 'api',
        provider: 'NOAA-NCEI',
        dataType: 'historical',
        timestamp: record.date || new Date().toISOString(),
        ingestedAt: new Date().toISOString(),
        qualityScore: 1.0,
        validationStatus: 'pending',
      };

      // Transform location
      result.data.location = {
        latitude: record.latitude,
        longitude: record.longitude,
        elevation: record.elevation,
        stationId: record.station,
        stationName: record.name || 'Unknown Station',
        locationName: record.name || 'Unknown Location',
      };

      // Transform measurements
      result.data.measurements = {};

      // Temperature Max (TMAX in tenths of degrees C)
      if (record.TMAX !== undefined && record.TMAX !== null) {
        result.data.measurements.temperatureMax = {
          value: record.TMAX / 10,
          unit: 'celsius',
          qualityFlag: record.TMAX_ATTRIBUTES || 'A',
        };
      }

      // Temperature Min (TMIN in tenths of degrees C)
      if (record.TMIN !== undefined && record.TMIN !== null) {
        result.data.measurements.temperatureMin = {
          value: record.TMIN / 10,
          unit: 'celsius',
          qualityFlag: record.TMIN_ATTRIBUTES || 'A',
        };
      }

      // Precipitation (PRCP in tenths of mm)
      if (record.PRCP !== undefined && record.PRCP !== null) {
        result.data.measurements.precipitation = {
          value: record.PRCP / 10,
          unit: 'mm',
          qualityFlag: record.PRCP_ATTRIBUTES || 'A',
        };
      }

      // Snowfall (SNOW in mm)
      if (record.SNOW !== undefined && record.SNOW !== null) {
        result.data.measurements.snowfall = {
          value: record.SNOW,
          unit: 'mm',
          qualityFlag: record.SNOW_ATTRIBUTES || 'A',
        };
      }

      // Snow Depth (SNWD in mm)
      if (record.SNWD !== undefined && record.SNWD !== null) {
        result.data.measurements.snowDepth = {
          value: record.SNWD,
          unit: 'mm',
          qualityFlag: record.SNWD_ATTRIBUTES || 'A',
        };
      }

      result.steps.push({
        step: 'noaa_ncei_parsing',
        status: 'completed',
        message: 'NOAA NCEI data successfully transformed',
      });
    } catch (error) {
      result.errors.push(`NOAA NCEI transformation error: ${error.message}`);
      result.steps.push({
        step: 'noaa_ncei_parsing',
        status: 'failed',
        message: error.message,
      });
    }

    return result;
  }

  /**
   * Transform OpenWeatherMap data
   */
  async transformOpenWeatherMap(rawData, options = {}) {
    const result = {
      data: this.createEmptyWRFCoinRecord(),
      steps: [],
      warnings: [],
      errors: [],
    };

    try {
      result.steps.push({
        step: 'openweathermap_parsing',
        status: 'in_progress',
        message: 'Parsing OpenWeatherMap data',
      });

      // Transform metadata
      result.data.metadata = {
        sourceId: 'openweathermap',
        sourceType: 'api',
        provider: 'OpenWeatherMap',
        dataType: 'current',
        timestamp: rawData.dt
          ? new Date(rawData.dt * 1000).toISOString()
          : new Date().toISOString(),
        ingestedAt: new Date().toISOString(),
        qualityScore: 0.8, // Lower quality score for commercial aggregated data
        validationStatus: 'pending',
      };

      // Transform location
      result.data.location = {
        latitude: this.getNestedValue(rawData, 'coord.lat'),
        longitude: this.getNestedValue(rawData, 'coord.lon'),
        locationName: rawData.name,
        country: this.getNestedValue(rawData, 'sys.country'),
      };

      // Transform measurements
      result.data.measurements = {};

      // Temperature (convert from Kelvin)
      const temp = this.getNestedValue(rawData, 'main.temp');
      if (temp !== null) {
        result.data.measurements.temperature = {
          value: temp - 273.15,
          unit: 'celsius',
          qualityFlag: 'B', // Good quality for commercial data
        };
      }

      // Humidity
      const humidity = this.getNestedValue(rawData, 'main.humidity');
      if (humidity !== null) {
        result.data.measurements.humidity = {
          value: humidity,
          unit: 'percent',
          qualityFlag: 'B',
        };
      }

      // Pressure
      const pressure = this.getNestedValue(rawData, 'main.pressure');
      if (pressure !== null) {
        result.data.measurements.pressure = {
          value: pressure,
          unit: 'hPa',
          qualityFlag: 'B',
        };
      }

      // Wind Speed
      const windSpeed = this.getNestedValue(rawData, 'wind.speed');
      if (windSpeed !== null) {
        result.data.measurements.windSpeed = {
          value: windSpeed,
          unit: 'm/s',
          qualityFlag: 'B',
        };
      }

      // Wind Direction
      const windDirection = this.getNestedValue(rawData, 'wind.deg');
      if (windDirection !== null) {
        result.data.measurements.windDirection = {
          value: windDirection,
          unit: 'degrees',
          qualityFlag: 'B',
        };
      }

      // Visibility (convert from meters to km)
      const visibility = this.getNestedValue(rawData, 'visibility');
      if (visibility !== null) {
        result.data.measurements.visibility = {
          value: visibility / 1000,
          unit: 'km',
          qualityFlag: 'B',
        };
      }

      // Cloud Coverage
      const cloudCoverage = this.getNestedValue(rawData, 'clouds.all');
      if (cloudCoverage !== null) {
        result.data.measurements.cloudCoverage = {
          value: cloudCoverage,
          unit: 'percent',
          qualityFlag: 'B',
        };
      }

      result.steps.push({
        step: 'openweathermap_parsing',
        status: 'completed',
        message: 'OpenWeatherMap data successfully transformed',
      });
    } catch (error) {
      result.errors.push(
        `OpenWeatherMap transformation error: ${error.message}`
      );
      result.steps.push({
        step: 'openweathermap_parsing',
        status: 'failed',
        message: error.message,
      });
    }

    return result;
  }

  /**
   * Transform local weather station data
   */
  async transformLocalStation(rawData, options = {}) {
    const result = {
      data: this.createEmptyWRFCoinRecord(),
      steps: [],
      warnings: [],
      errors: [],
    };

    try {
      result.steps.push({
        step: 'local_station_parsing',
        status: 'in_progress',
        message: 'Parsing local weather station data',
      });

      // Transform metadata
      result.data.metadata = {
        sourceId: rawData.stationId || 'unknown',
        sourceType: 'station',
        provider: rawData.provider || 'Local-Station',
        dataType: 'current',
        timestamp: rawData.timestamp || new Date().toISOString(),
        ingestedAt: new Date().toISOString(),
        qualityScore: rawData.qualityScore || 0.9,
        validationStatus: 'pending',
      };

      // Transform location
      result.data.location = {
        latitude: this.getNestedValue(rawData, 'location.latitude'),
        longitude: this.getNestedValue(rawData, 'location.longitude'),
        elevation: this.getNestedValue(rawData, 'location.elevation'),
        stationId: rawData.stationId,
        stationName: rawData.stationName,
        locationName: rawData.stationName || rawData.locationName,
      };

      // Transform measurements
      result.data.measurements = {};

      const measurements = rawData.measurements || {};
      Object.keys(measurements).forEach(param => {
        const measurement = measurements[param];
        if (
          measurement &&
          measurement.value !== null &&
          measurement.value !== undefined
        ) {
          result.data.measurements[param] = {
            value: measurement.value,
            unit: measurement.unit || this.getStandardUnit(param),
            qualityFlag: measurement.qualityFlag || 'A',
          };
        }
      });

      result.steps.push({
        step: 'local_station_parsing',
        status: 'completed',
        message: 'Local station data successfully transformed',
      });
    } catch (error) {
      result.errors.push(
        `Local station transformation error: ${error.message}`
      );
      result.steps.push({
        step: 'local_station_parsing',
        status: 'failed',
        message: error.message,
      });
    }

    return result;
  }

  /**
   * Generic transformation for unknown source types
   */
  async transformGeneric(rawData, options = {}) {
    const result = {
      data: this.createEmptyWRFCoinRecord(),
      steps: [],
      warnings: [],
      errors: [],
    };

    try {
      result.steps.push({
        step: 'generic_parsing',
        status: 'in_progress',
        message: 'Applying generic transformation',
      });

      // Basic metadata
      result.data.metadata = {
        sourceId: rawData.id || rawData.sourceId || 'unknown',
        sourceType: rawData.sourceType || 'unknown',
        provider: rawData.provider || 'Unknown',
        dataType: rawData.dataType || 'current',
        timestamp: rawData.timestamp || new Date().toISOString(),
        ingestedAt: new Date().toISOString(),
        qualityScore: rawData.qualityScore || 0.5,
        validationStatus: 'pending',
      };

      // Basic location
      result.data.location = {
        latitude: rawData.latitude || rawData.lat,
        longitude: rawData.longitude || rawData.lng || rawData.lon,
        elevation: rawData.elevation,
        stationId: rawData.stationId,
        stationName: rawData.stationName,
        locationName: rawData.locationName || rawData.location,
      };

      // Try to map common measurement fields
      result.data.measurements = {};
      const commonFields = [
        'temperature',
        'humidity',
        'pressure',
        'windSpeed',
        'windDirection',
        'precipitation',
        'visibility',
        'cloudCoverage',
        'dewpoint',
      ];

      commonFields.forEach(field => {
        if (rawData[field] !== undefined && rawData[field] !== null) {
          result.data.measurements[field] = {
            value:
              typeof rawData[field] === 'object'
                ? rawData[field].value
                : rawData[field],
            unit:
              typeof rawData[field] === 'object'
                ? rawData[field].unit
                : this.getStandardUnit(field),
            qualityFlag:
              typeof rawData[field] === 'object'
                ? rawData[field].qualityFlag
                : 'C',
          };
        }
      });

      result.warnings.push(
        'Generic transformation applied - data quality may be reduced'
      );

      result.steps.push({
        step: 'generic_parsing',
        status: 'completed',
        message: 'Generic transformation completed with warnings',
      });
    } catch (error) {
      result.errors.push(`Generic transformation error: ${error.message}`);
      result.steps.push({
        step: 'generic_parsing',
        status: 'failed',
        message: error.message,
      });
    }

    return result;
  }

  /**
   * Transform multiple weather records in batch
   */
  async transformWeatherBatch(rawDataArray, sourceType, options = {}) {
    const results = [];

    for (const rawData of rawDataArray) {
      try {
        const result = await this.transformWeatherData(
          rawData,
          sourceType,
          options
        );
        results.push(result);
      } catch (error) {
        logger.error('Error transforming weather record in batch:', {
          error: error.message,
        });
        results.push({
          sourceType,
          originalData: rawData,
          transformedData: null,
          transformationSteps: [],
          warnings: [],
          errors: [`Transformation failed: ${error.message}`],
          success: false,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return results;
  }

  // Helper methods

  createEmptyWRFCoinRecord() {
    return {
      metadata: {},
      location: {},
      measurements: {},
      validation: {
        rangeValidation: { passed: false, errors: [] },
        physicsValidation: { passed: false, warnings: [] },
        completenessValidation: {
          passed: false,
          completenessRatio: 0,
          missingParameters: [],
        },
        overallScore: 0,
        qualityLevel: 'invalid',
      },
    };
  }

  getNestedValue(obj, path) {
    if (!obj || !path) return null;

    // Handle array indexing in path like 'coordinates[1]'
    const pathWithArrays = path.replace(/\[(\d+)\]/g, '.$1');
    const keys = pathWithArrays.split('.');

    let current = obj;
    for (const key of keys) {
      if (current === null || current === undefined) return null;

      if (Array.isArray(current) && !isNaN(key)) {
        current = current[parseInt(key)];
      } else {
        current = current[key];
      }
    }

    return current !== undefined ? current : null;
  }

  convertTemperature(value, unitCode) {
    if (value === null || value === undefined) return null;

    if (!unitCode) return value;

    const unit = unitCode.toLowerCase();
    if (unit.includes('degf') || unit.includes('fahrenheit')) {
      return ((value - 32) * 5) / 9;
    } else if (unit.includes('k') || unit.includes('kelvin')) {
      return value - 273.15;
    }

    return value; // Assume Celsius
  }

  convertPressure(value, unitCode) {
    if (value === null || value === undefined) return null;

    if (!unitCode) return value;

    const unit = unitCode.toLowerCase();
    if (unit.includes('pa') && !unit.includes('hpa')) {
      return value / 100; // Convert Pa to hPa
    } else if (unit.includes('mmhg')) {
      return value * 1.33322; // Convert mmHg to hPa
    } else if (unit.includes('inhg')) {
      return value * 33.8639; // Convert inHg to hPa
    }

    return value; // Assume hPa
  }

  convertWindSpeed(value, unitCode) {
    if (value === null || value === undefined) return null;

    if (!unitCode) return value;

    const unit = unitCode.toLowerCase();
    if (unit.includes('km') || unit.includes('kmh')) {
      return value / 3.6; // Convert km/h to m/s
    } else if (unit.includes('mph') || unit.includes('mile')) {
      return value * 0.44704; // Convert mph to m/s
    } else if (unit.includes('knot') || unit.includes('kt')) {
      return value * 0.514444; // Convert knots to m/s
    }

    return value; // Assume m/s
  }

  convertDistance(value, unitCode) {
    if (value === null || value === undefined) return null;

    if (!unitCode) return value;

    const unit = unitCode.toLowerCase();
    if (unit.includes('m') && !unit.includes('km')) {
      return value / 1000; // Convert m to km
    } else if (unit.includes('mile') || unit.includes('mi')) {
      return value * 1.60934; // Convert miles to km
    } else if (unit.includes('ft') || unit.includes('feet')) {
      return value * 0.0003048; // Convert feet to km
    }

    return value; // Assume km
  }

  getStandardUnit(param) {
    const standardUnits = {
      temperature: 'celsius',
      temperatureMax: 'celsius',
      temperatureMin: 'celsius',
      dewpoint: 'celsius',
      humidity: 'percent',
      pressure: 'hPa',
      pressureSeaLevel: 'hPa',
      windSpeed: 'm/s',
      windGust: 'm/s',
      windDirection: 'degrees',
      precipitation: 'mm',
      precipitationAccumulation: 'mm',
      visibility: 'km',
      cloudCoverage: 'percent',
      snowfall: 'mm',
      snowDepth: 'mm',
      solarRadiation: 'W/m²',
      uvIndex: 'index',
    };

    return standardUnits[param] || 'unknown';
  }

  validateWRFCoinStructure(data) {
    const requiredSections = ['metadata', 'location', 'measurements'];
    const requiredMetadataFields = [
      'sourceId',
      'sourceType',
      'provider',
      'timestamp',
    ];
    const requiredLocationFields = ['latitude', 'longitude'];

    // Check required sections
    for (const section of requiredSections) {
      if (!data[section]) {
        return {
          valid: false,
          message: `Missing required section: ${section}`,
          details: { missingSection: section },
        };
      }
    }

    // Check required metadata fields
    for (const field of requiredMetadataFields) {
      if (!data.metadata[field]) {
        return {
          valid: false,
          message: `Missing required metadata field: ${field}`,
          details: { missingField: field, section: 'metadata' },
        };
      }
    }

    // Check required location fields
    for (const field of requiredLocationFields) {
      if (data.location[field] === null || data.location[field] === undefined) {
        return {
          valid: false,
          message: `Missing required location field: ${field}`,
          details: { missingField: field, section: 'location' },
        };
      }
    }

    // Check if measurements exist
    if (Object.keys(data.measurements).length === 0) {
      return {
        valid: false,
        message: 'No measurements provided',
        details: { section: 'measurements', count: 0 },
      };
    }

    return {
      valid: true,
      message: 'WRFCoin structure validation passed',
      details: {
        sections: requiredSections.length,
        measurements: Object.keys(data.measurements).length,
      },
    };
  }

  /**
   * Get transformation statistics for a batch of results
   */
  getTransformationStatistics(transformationResults) {
    const stats = {
      totalRecords: transformationResults.length,
      successfulTransformations: 0,
      failedTransformations: 0,
      sourceTypeDistribution: {},
      qualityDistribution: {},
      commonErrors: {},
      averageProcessingSteps: 0,
    };

    transformationResults.forEach(result => {
      if (result.success) {
        stats.successfulTransformations++;
      } else {
        stats.failedTransformations++;
      }

      // Source type distribution
      stats.sourceTypeDistribution[result.sourceType] =
        (stats.sourceTypeDistribution[result.sourceType] || 0) + 1;

      // Quality distribution
      if (result.overallQuality) {
        stats.qualityDistribution[result.overallQuality] =
          (stats.qualityDistribution[result.overallQuality] || 0) + 1;
      }

      // Processing steps
      stats.averageProcessingSteps += result.transformationSteps.length;

      // Common errors
      result.errors.forEach(error => {
        const errorType = error.split(':')[0];
        stats.commonErrors[errorType] =
          (stats.commonErrors[errorType] || 0) + 1;
      });
    });

    stats.averageProcessingSteps =
      stats.averageProcessingSteps / transformationResults.length;

    return stats;
  }
}

module.exports = WeatherDataTransformer;
