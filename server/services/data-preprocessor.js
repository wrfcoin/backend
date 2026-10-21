/**
 * WRFCoin Data Preprocessor
 *
 * Comprehensive data preprocessing service for weather data normalization,
 * unit conversion, format standardization, and data enrichment.
 *
 * Features:
 * - Multi-format input support (JSON, CSV, XML)
 * - Comprehensive unit normalization
 * - Data format standardization to WRFCoin schema
 * - Missing value interpolation
 * - Data enrichment with derived parameters
 * - Quality assessment and flagging
 * - Temporal and spatial data enhancement
 */

const moment = require('moment');
const Logger = require('../utils/logger');

class DataPreprocessor {
  constructor(options = {}) {
    this.options = {
      // Unit conversion settings
      temperatureUnit: options.temperatureUnit || 'celsius',
      pressureUnit: options.pressureUnit || 'hPa',
      windSpeedUnit: options.windSpeedUnit || 'm/s',
      precipitationUnit: options.precipitationUnit || 'mm',
      distanceUnit: options.distanceUnit || 'meters',

      // Processing settings
      enableInterpolation: options.enableInterpolation || true,
      enableEnrichment: options.enableEnrichment || true,
      enableQualityFlags: options.enableQualityFlags || true,

      // Validation thresholds
      maxTemperature: options.maxTemperature || 60, // Celsius
      minTemperature: options.minTemperature || -90, // Celsius
      maxWindSpeed: options.maxWindSpeed || 150, // m/s
      maxPressure: options.maxPressure || 1100, // hPa
      minPressure: options.minPressure || 800, // hPa

      ...options,
    };

    this.logger = Logger;

    // Unit conversion factors
    this.conversionFactors = {
      temperature: {
        fahrenheit_to_celsius: f => ((f - 32) * 5) / 9,
        kelvin_to_celsius: k => k - 273.15,
        celsius_to_celsius: c => c,
      },
      pressure: {
        inhg_to_hpa: inhg => inhg * 33.8639,
        mmhg_to_hpa: mmhg => mmhg * 1.33322,
        atm_to_hpa: atm => atm * 1013.25,
        pa_to_hpa: pa => pa / 100,
        hpa_to_hpa: hpa => hpa,
        mb_to_hpa: mb => mb,
      },
      windSpeed: {
        mph_to_ms: mph => mph * 0.44704,
        kmh_to_ms: kmh => kmh / 3.6,
        knots_to_ms: knots => knots * 0.514444,
        ms_to_ms: ms => ms,
      },
      precipitation: {
        inches_to_mm: inches => inches * 25.4,
        cm_to_mm: cm => cm * 10,
        mm_to_mm: mm => mm,
      },
      distance: {
        miles_to_meters: miles => miles * 1609.34,
        feet_to_meters: feet => feet * 0.3048,
        km_to_meters: km => km * 1000,
        meters_to_meters: m => m,
      },
    };

    // Standard WRFCoin data schema
    this.standardSchema = {
      source: null,
      dataType: null,
      timestamp: null,
      location: {
        latitude: null,
        longitude: null,
        stationId: null,
        elevation: null,
      },
      data: {
        temperature: { value: null, unit: 'celsius' },
        humidity: { value: null, unit: 'percent' },
        pressure: { value: null, unit: 'hPa' },
        windSpeed: { value: null, unit: 'm/s' },
        windDirection: { value: null, unit: 'degrees' },
        precipitation: { value: null, unit: 'mm' },
        cloudCover: { value: null, unit: 'percent' },
        visibility: { value: null, unit: 'meters' },
        dewPoint: { value: null, unit: 'celsius' },
        uvIndex: { value: null, unit: 'index' },
        snowDepth: { value: null, unit: 'mm' },
      },
      quality: {
        source: 'preprocessed',
        confidence: null,
        validationPassed: null,
        flags: [],
      },
      metadata: {},
    };
  }

  /**
   * Main processing method - handles multiple input formats
   */
  async process(inputData, options = {}) {
    try {
      const startTime = Date.now();

      // Determine input format and parse
      const parsedData = await this.parseInput(inputData, options);

      // Normalize to array format for consistent processing
      const dataArray = Array.isArray(parsedData) ? parsedData : [parsedData];

      // Process each data item
      const processedData = [];
      for (const dataItem of dataArray) {
        const processed = await this.processDataItem(dataItem, options);
        if (processed) {
          processedData.push(processed);
        }
      }

      const processingTime = Date.now() - startTime;
      this.logger.debug(
        `Preprocessed ${processedData.length} data items in ${processingTime}ms`
      );

      // Return single item if input was single item
      return Array.isArray(parsedData) ? processedData : processedData[0];
    } catch (error) {
      this.logger.error('Error during data preprocessing:', error);
      throw error;
    }
  }

  /**
   * Parse input data based on format
   */
  async parseInput(inputData, options) {
    const { source } = options;

    if (!inputData) {
      throw new Error('Input data is null or undefined');
    }

    // If already a JavaScript object, return as-is
    if (typeof inputData === 'object' && !Buffer.isBuffer(inputData)) {
      return inputData;
    }

    // If string, try to parse as JSON
    if (typeof inputData === 'string') {
      try {
        return JSON.parse(inputData);
      } catch (error) {
        // If JSON parsing fails, check for CSV or other formats
        return await this.parseNonJsonFormat(inputData, source);
      }
    }

    throw new Error(`Unsupported input data format: ${typeof inputData}`);
  }

  /**
   * Parse non-JSON formats (CSV, XML, etc.)
   */
  async parseNonJsonFormat(inputData, source) {
    // For now, implement basic CSV parsing
    // This could be extended to support XML, GRIB, NetCDF, etc.

    if (source === 'csv' || inputData.includes(',')) {
      return this.parseCSV(inputData);
    }

    throw new Error(`Unsupported data format for source: ${source}`);
  }

  /**
   * Simple CSV parser for weather data
   */
  parseCSV(csvData) {
    const lines = csvData.trim().split('\n');
    if (lines.length < 2) {
      throw new Error('Invalid CSV format: insufficient data');
    }

    const headers = lines[0].split(',').map(h => h.trim());
    const data = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const row = {};

      headers.forEach((header, index) => {
        row[header] = values[index];
      });

      data.push(row);
    }

    return data;
  }

  /**
   * Process individual data item
   */
  async processDataItem(dataItem, options) {
    try {
      // Create standardized data structure
      const standardizedData = this.createStandardStructure();

      // Populate basic metadata
      await this.populateMetadata(standardizedData, dataItem, options);

      // Normalize and convert units
      await this.normalizeUnits(standardizedData, dataItem, options);

      // Enrich data with derived parameters
      if (this.options.enableEnrichment) {
        await this.enrichData(standardizedData);
      }

      // Perform quality assessment
      if (this.options.enableQualityFlags) {
        await this.assessQuality(standardizedData);
      }

      // Handle missing values
      if (this.options.enableInterpolation) {
        await this.handleMissingValues(standardizedData, options);
      }

      return standardizedData;
    } catch (error) {
      this.logger.error('Error processing data item:', error);
      return null;
    }
  }

  /**
   * Create standard data structure
   */
  createStandardStructure() {
    return JSON.parse(JSON.stringify(this.standardSchema));
  }

  /**
   * Populate metadata from source data
   */
  async populateMetadata(standardData, sourceData, options) {
    const { source } = options;

    // Set source information
    standardData.source = source || 'unknown';
    standardData.dataType = this.determineDataType(sourceData);

    // Handle different source formats
    switch (source) {
      case 'noaa-nws':
        await this.populateNOAANWSMetadata(standardData, sourceData);
        break;
      case 'noaa-ncei':
        await this.populateNOAANCEIMetadata(standardData, sourceData);
        break;
      case 'weather-station':
        await this.populateWeatherStationMetadata(standardData, sourceData);
        break;
      default:
        await this.populateGenericMetadata(standardData, sourceData);
    }
  }

  /**
   * Determine data type from source data
   */
  determineDataType(sourceData) {
    if (sourceData.forecastPeriod || sourceData.forecast) {
      return 'forecast';
    }
    if (sourceData.observationTime || sourceData.timestamp) {
      return 'observation';
    }
    if (sourceData.historical || sourceData.date) {
      return 'historical';
    }
    return 'current_observation';
  }

  /**
   * Populate NOAA NWS metadata
   */
  async populateNOAANWSMetadata(standardData, sourceData) {
    // Handle NOAA NWS API response format
    if (sourceData.properties) {
      const props = sourceData.properties;

      standardData.timestamp =
        props.timestamp || props.observationTime || new Date().toISOString();

      if (sourceData.geometry && sourceData.geometry.coordinates) {
        const [lon, lat] = sourceData.geometry.coordinates;
        standardData.location.latitude = lat;
        standardData.location.longitude = lon;
      }

      standardData.location.stationId = props.station || sourceData.id;
      standardData.location.elevation = props.elevation
        ? props.elevation.value
        : null;

      standardData.metadata.nws = {
        station: props.station,
        observationTime: props.timestamp,
        rawTemperature: props.temperature,
        rawHumidity: props.relativeHumidity,
        rawPressure: props.barometricPressure,
        rawWindSpeed: props.windSpeed,
        rawWindDirection: props.windDirection,
      };
    }
  }

  /**
   * Populate NOAA NCEI metadata
   */
  async populateNOAANCEIMetadata(standardData, sourceData) {
    // Handle NOAA NCEI Data Service format
    standardData.timestamp =
      sourceData.date || sourceData.DATE || new Date().toISOString();

    if (sourceData.latitude && sourceData.longitude) {
      standardData.location.latitude = parseFloat(sourceData.latitude);
      standardData.location.longitude = parseFloat(sourceData.longitude);
    }

    standardData.location.stationId = sourceData.station || sourceData.STATION;
    standardData.location.elevation =
      sourceData.elevation || sourceData.ELEVATION;

    standardData.metadata.ncei = {
      station: sourceData.station,
      datatype: sourceData.datatype,
      attributes: sourceData.attributes,
    };
  }

  /**
   * Populate weather station metadata
   */
  async populateWeatherStationMetadata(standardData, sourceData) {
    // Handle weather station protocol format
    standardData.timestamp = sourceData.timestamp || new Date().toISOString();
    standardData.location.latitude = sourceData.lat || sourceData.latitude;
    standardData.location.longitude = sourceData.lon || sourceData.longitude;
    standardData.location.stationId = sourceData.stationId || sourceData.id;
    standardData.location.elevation = sourceData.elevation;

    standardData.metadata.station = {
      protocol: sourceData.protocol,
      model: sourceData.model,
      firmware: sourceData.firmware,
    };
  }

  /**
   * Populate generic metadata
   */
  async populateGenericMetadata(standardData, sourceData) {
    // Handle generic data format
    standardData.timestamp =
      sourceData.timestamp || sourceData.time || new Date().toISOString();
    standardData.location.latitude = sourceData.lat || sourceData.latitude;
    standardData.location.longitude = sourceData.lon || sourceData.longitude;
    standardData.location.stationId = sourceData.station || sourceData.id;
    standardData.location.elevation = sourceData.elevation;
  }

  /**
   * Normalize units for all measurements
   */
  async normalizeUnits(standardData, sourceData, options) {
    const { source } = options;

    try {
      // Temperature normalization
      await this.normalizeTemperature(standardData, sourceData, source);

      // Pressure normalization
      await this.normalizePressure(standardData, sourceData, source);

      // Wind speed normalization
      await this.normalizeWindSpeed(standardData, sourceData, source);

      // Precipitation normalization
      await this.normalizePrecipitation(standardData, sourceData, source);

      // Distance/visibility normalization
      await this.normalizeDistance(standardData, sourceData, source);

      // Humidity (typically already in percentage)
      await this.normalizeHumidity(standardData, sourceData, source);

      // Wind direction (typically already in degrees)
      await this.normalizeWindDirection(standardData, sourceData, source);

      // Cloud cover (typically already in percentage)
      await this.normalizeCloudCover(standardData, sourceData, source);
    } catch (error) {
      this.logger.error('Error normalizing units:', error);
      throw error;
    }
  }

  /**
   * Normalize temperature to Celsius
   */
  async normalizeTemperature(standardData, sourceData, source) {
    const tempValue = this.extractValue(sourceData, [
      'temperature',
      'temp',
      'TOBS',
      'TMAX',
      'TMIN',
      'properties.temperature.value',
      'air_temperature',
    ]);

    if (tempValue === null || tempValue === undefined) return;

    const tempUnit =
      this.extractUnit(sourceData, [
        'temperature.unit',
        'tempUnit',
        'properties.temperature.unitCode',
      ]) || this.inferTemperatureUnit(tempValue, source);

    const convertedTemp = this.convertTemperature(tempValue, tempUnit);

    if (this.isValidTemperature(convertedTemp)) {
      standardData.data.temperature.value =
        Math.round(convertedTemp * 100) / 100;
    }
  }

  /**
   * Normalize pressure to hPa
   */
  async normalizePressure(standardData, sourceData, source) {
    const pressureValue = this.extractValue(sourceData, [
      'pressure',
      'barometricPressure',
      'PRES',
      'SLP',
      'properties.barometricPressure.value',
      'sea_level_pressure',
    ]);

    if (pressureValue === null || pressureValue === undefined) return;

    const pressureUnit =
      this.extractUnit(sourceData, [
        'pressure.unit',
        'pressureUnit',
        'properties.barometricPressure.unitCode',
      ]) || this.inferPressureUnit(pressureValue, source);

    const convertedPressure = this.convertPressure(pressureValue, pressureUnit);

    if (this.isValidPressure(convertedPressure)) {
      standardData.data.pressure.value =
        Math.round(convertedPressure * 100) / 100;
    }
  }

  /**
   * Normalize wind speed to m/s
   */
  async normalizeWindSpeed(standardData, sourceData, source) {
    const windSpeedValue = this.extractValue(sourceData, [
      'windSpeed',
      'wind_speed',
      'AWND',
      'WSF2',
      'WSF5',
      'properties.windSpeed.value',
    ]);

    if (windSpeedValue === null || windSpeedValue === undefined) return;

    const windSpeedUnit =
      this.extractUnit(sourceData, [
        'windSpeed.unit',
        'windSpeedUnit',
        'properties.windSpeed.unitCode',
      ]) || this.inferWindSpeedUnit(windSpeedValue, source);

    const convertedWindSpeed = this.convertWindSpeed(
      windSpeedValue,
      windSpeedUnit
    );

    if (this.isValidWindSpeed(convertedWindSpeed)) {
      standardData.data.windSpeed.value =
        Math.round(convertedWindSpeed * 100) / 100;
    }
  }

  /**
   * Normalize precipitation to mm
   */
  async normalizePrecipitation(standardData, sourceData, source) {
    const precipValue = this.extractValue(sourceData, [
      'precipitation',
      'precip',
      'PRCP',
      'rainfall',
      'properties.precipitationLastHour.value',
    ]);

    if (precipValue === null || precipValue === undefined) return;

    const precipUnit =
      this.extractUnit(sourceData, [
        'precipitation.unit',
        'precipUnit',
        'properties.precipitationLastHour.unitCode',
      ]) || this.inferPrecipitationUnit(precipValue, source);

    const convertedPrecip = this.convertPrecipitation(precipValue, precipUnit);

    if (convertedPrecip >= 0) {
      standardData.data.precipitation.value =
        Math.round(convertedPrecip * 100) / 100;
    }
  }

  /**
   * Normalize distance/visibility to meters
   */
  async normalizeDistance(standardData, sourceData, source) {
    const visibilityValue = this.extractValue(sourceData, [
      'visibility',
      'vis',
      'properties.visibility.value',
    ]);

    if (visibilityValue === null || visibilityValue === undefined) return;

    const visibilityUnit =
      this.extractUnit(sourceData, [
        'visibility.unit',
        'visibilityUnit',
        'properties.visibility.unitCode',
      ]) || this.inferDistanceUnit(visibilityValue, source);

    const convertedVisibility = this.convertDistance(
      visibilityValue,
      visibilityUnit
    );

    if (convertedVisibility >= 0) {
      standardData.data.visibility.value = Math.round(convertedVisibility);
    }
  }

  /**
   * Normalize humidity (already in percentage typically)
   */
  async normalizeHumidity(standardData, sourceData, source) {
    const humidityValue = this.extractValue(sourceData, [
      'humidity',
      'relativeHumidity',
      'RH',
      'properties.relativeHumidity.value',
    ]);

    if (humidityValue === null || humidityValue === undefined) return;

    // Convert to percentage if needed
    let normalizedHumidity = humidityValue;
    if (normalizedHumidity > 1 && normalizedHumidity <= 100) {
      // Already in percentage
    } else if (normalizedHumidity <= 1) {
      // Convert from decimal to percentage
      normalizedHumidity = normalizedHumidity * 100;
    }

    if (normalizedHumidity >= 0 && normalizedHumidity <= 100) {
      standardData.data.humidity.value =
        Math.round(normalizedHumidity * 10) / 10;
    }
  }

  /**
   * Normalize wind direction (already in degrees typically)
   */
  async normalizeWindDirection(standardData, sourceData, source) {
    const windDirValue = this.extractValue(sourceData, [
      'windDirection',
      'wind_direction',
      'WDF2',
      'WDF5',
      'properties.windDirection.value',
    ]);

    if (windDirValue === null || windDirValue === undefined) return;

    // Ensure wind direction is between 0-360 degrees
    let normalizedWindDir = windDirValue % 360;
    if (normalizedWindDir < 0) {
      normalizedWindDir += 360;
    }

    standardData.data.windDirection.value = Math.round(normalizedWindDir);
  }

  /**
   * Normalize cloud cover (already in percentage typically)
   */
  async normalizeCloudCover(standardData, sourceData, source) {
    const cloudCoverValue = this.extractValue(sourceData, [
      'cloudCover',
      'cloud_cover',
      'sky_cover',
      'properties.cloudLayers',
    ]);

    if (cloudCoverValue === null || cloudCoverValue === undefined) return;

    let normalizedCloudCover = cloudCoverValue;

    // Handle different cloud cover formats
    if (Array.isArray(cloudCoverValue)) {
      // Take highest cloud cover layer
      normalizedCloudCover = Math.max(
        ...cloudCoverValue.map(layer => layer.amount || layer.coverage || 0)
      );
    }

    // Convert to percentage if needed
    if (normalizedCloudCover <= 1) {
      normalizedCloudCover = normalizedCloudCover * 100;
    }

    if (normalizedCloudCover >= 0 && normalizedCloudCover <= 100) {
      standardData.data.cloudCover.value = Math.round(normalizedCloudCover);
    }
  }

  /**
   * Extract value from nested object paths
   */
  extractValue(obj, paths) {
    for (const path of paths) {
      const value = this.getNestedValue(obj, path);
      if (value !== null && value !== undefined && value !== '') {
        return typeof value === 'string' ? parseFloat(value) : value;
      }
    }
    return null;
  }

  /**
   * Extract unit from nested object paths
   */
  extractUnit(obj, paths) {
    for (const path of paths) {
      const unit = this.getNestedValue(obj, path);
      if (unit && typeof unit === 'string') {
        return unit.toLowerCase();
      }
    }
    return null;
  }

  /**
   * Get nested value from object using dot notation
   */
  getNestedValue(obj, path) {
    if (!obj) return null;

    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return null;
      }
    }

    return current;
  }

  /**
   * Convert temperature to Celsius
   */
  convertTemperature(value, unit) {
    unit = unit?.toLowerCase() || 'celsius';

    if (unit.includes('f') || unit.includes('fahrenheit')) {
      return this.conversionFactors.temperature.fahrenheit_to_celsius(value);
    } else if (unit.includes('k') || unit.includes('kelvin')) {
      return this.conversionFactors.temperature.kelvin_to_celsius(value);
    } else {
      return value; // Assume Celsius
    }
  }

  /**
   * Convert pressure to hPa
   */
  convertPressure(value, unit) {
    unit = unit?.toLowerCase() || 'hpa';

    if (unit.includes('inhg') || unit.includes('in')) {
      return this.conversionFactors.pressure.inhg_to_hpa(value);
    } else if (unit.includes('mmhg') || unit.includes('torr')) {
      return this.conversionFactors.pressure.mmhg_to_hpa(value);
    } else if (unit.includes('atm')) {
      return this.conversionFactors.pressure.atm_to_hpa(value);
    } else if (unit.includes('pa') && !unit.includes('hpa')) {
      return this.conversionFactors.pressure.pa_to_hpa(value);
    } else if (unit.includes('mb') || unit.includes('millibar')) {
      return this.conversionFactors.pressure.mb_to_hpa(value);
    } else {
      return value; // Assume hPa
    }
  }

  /**
   * Convert wind speed to m/s
   */
  convertWindSpeed(value, unit) {
    unit = unit?.toLowerCase() || 'ms';

    if (unit.includes('mph') || unit.includes('mi/h')) {
      return this.conversionFactors.windSpeed.mph_to_ms(value);
    } else if (unit.includes('kmh') || unit.includes('km/h')) {
      return this.conversionFactors.windSpeed.kmh_to_ms(value);
    } else if (unit.includes('knot') || unit.includes('kt')) {
      return this.conversionFactors.windSpeed.knots_to_ms(value);
    } else {
      return value; // Assume m/s
    }
  }

  /**
   * Convert precipitation to mm
   */
  convertPrecipitation(value, unit) {
    unit = unit?.toLowerCase() || 'mm';

    if (unit.includes('in') || unit.includes('inch')) {
      return this.conversionFactors.precipitation.inches_to_mm(value);
    } else if (unit.includes('cm')) {
      return this.conversionFactors.precipitation.cm_to_mm(value);
    } else {
      return value; // Assume mm
    }
  }

  /**
   * Convert distance to meters
   */
  convertDistance(value, unit) {
    unit = unit?.toLowerCase() || 'meters';

    if (unit.includes('mi') || unit.includes('mile')) {
      return this.conversionFactors.distance.miles_to_meters(value);
    } else if (unit.includes('ft') || unit.includes('feet')) {
      return this.conversionFactors.distance.feet_to_meters(value);
    } else if (unit.includes('km')) {
      return this.conversionFactors.distance.km_to_meters(value);
    } else {
      return value; // Assume meters
    }
  }

  /**
   * Infer temperature unit from value and source
   */
  inferTemperatureUnit(value, source) {
    if (source?.includes('noaa') || source?.includes('nws')) {
      return value > 50 ? 'fahrenheit' : 'celsius';
    }
    return value > 50 ? 'fahrenheit' : 'celsius';
  }

  /**
   * Infer pressure unit from value and source
   */
  inferPressureUnit(value, source) {
    if (value < 50) return 'inhg';
    if (value > 50000) return 'pa';
    return 'hpa';
  }

  /**
   * Infer wind speed unit from value and source
   */
  inferWindSpeedUnit(value, source) {
    if (source?.includes('noaa') || source?.includes('nws')) {
      return 'mph';
    }
    return value > 50 ? 'kmh' : 'ms';
  }

  /**
   * Infer precipitation unit from value and source
   */
  inferPrecipitationUnit(value, source) {
    if (source?.includes('noaa') || source?.includes('nws')) {
      return 'inches';
    }
    return 'mm';
  }

  /**
   * Infer distance unit from value and source
   */
  inferDistanceUnit(value, source) {
    if (source?.includes('noaa') || source?.includes('nws')) {
      return value > 50 ? 'miles' : 'meters';
    }
    return value > 1000 ? 'km' : 'meters';
  }

  /**
   * Validate temperature value
   */
  isValidTemperature(temp) {
    return (
      temp >= this.options.minTemperature && temp <= this.options.maxTemperature
    );
  }

  /**
   * Validate pressure value
   */
  isValidPressure(pressure) {
    return (
      pressure >= this.options.minPressure &&
      pressure <= this.options.maxPressure
    );
  }

  /**
   * Validate wind speed value
   */
  isValidWindSpeed(windSpeed) {
    return windSpeed >= 0 && windSpeed <= this.options.maxWindSpeed;
  }

  /**
   * Enrich data with derived parameters
   */
  async enrichData(standardData) {
    try {
      // Calculate dew point if temperature and humidity are available
      this.calculateDewPoint(standardData);

      // Calculate heat index if temperature and humidity are available
      this.calculateHeatIndex(standardData);

      // Calculate wind chill if temperature and wind speed are available
      this.calculateWindChill(standardData);

      // Calculate apparent temperature
      this.calculateApparentTemperature(standardData);

      // Add temporal information
      this.addTemporalData(standardData);
    } catch (error) {
      this.logger.error('Error enriching data:', error);
    }
  }

  /**
   * Calculate dew point temperature
   */
  calculateDewPoint(standardData) {
    const temp = standardData.data.temperature.value;
    const humidity = standardData.data.humidity.value;

    if (temp !== null && humidity !== null) {
      // Magnus formula approximation
      const a = 17.27;
      const b = 237.7;
      const alpha = (a * temp) / (b + temp) + Math.log(humidity / 100.0);
      const dewPoint = (b * alpha) / (a - alpha);

      standardData.data.dewPoint.value = Math.round(dewPoint * 10) / 10;
    }
  }

  /**
   * Calculate heat index
   */
  calculateHeatIndex(standardData) {
    const temp = standardData.data.temperature.value;
    const humidity = standardData.data.humidity.value;

    if (temp !== null && humidity !== null && temp >= 27) {
      // Only relevant above 27°C
      // Convert to Fahrenheit for calculation
      const tempF = (temp * 9) / 5 + 32;
      const rh = humidity;

      // Rothfusz regression
      const hi =
        -42.379 +
        2.04901523 * tempF +
        10.14333127 * rh -
        0.22475541 * tempF * rh -
        0.00683783 * tempF * tempF -
        0.05481717 * rh * rh +
        0.00122874 * tempF * tempF * rh +
        0.00085282 * tempF * rh * rh -
        0.00000199 * tempF * tempF * rh * rh;

      // Convert back to Celsius
      const heatIndexC = ((hi - 32) * 5) / 9;

      standardData.metadata.heatIndex = Math.round(heatIndexC * 10) / 10;
    }
  }

  /**
   * Calculate wind chill
   */
  calculateWindChill(standardData) {
    const temp = standardData.data.temperature.value;
    const windSpeed = standardData.data.windSpeed.value;

    if (temp !== null && windSpeed !== null && temp <= 10 && windSpeed >= 4.8) {
      // Wind chill formula (Celsius and km/h)
      const windSpeedKmh = windSpeed * 3.6;
      const windChill =
        13.12 +
        0.6215 * temp -
        11.37 * Math.pow(windSpeedKmh, 0.16) +
        0.3965 * temp * Math.pow(windSpeedKmh, 0.16);

      standardData.metadata.windChill = Math.round(windChill * 10) / 10;
    }
  }

  /**
   * Calculate apparent temperature
   */
  calculateApparentTemperature(standardData) {
    const temp = standardData.data.temperature.value;
    const humidity = standardData.data.humidity.value;
    const windSpeed = standardData.data.windSpeed.value;

    if (temp !== null && humidity !== null && windSpeed !== null) {
      // Australian Apparent Temperature formula
      const e =
        (humidity / 100) * 6.105 * Math.exp((17.27 * temp) / (237.7 + temp));
      const at = temp + 0.33 * e - 0.7 * windSpeed - 4.0;

      standardData.metadata.apparentTemperature = Math.round(at * 10) / 10;
    }
  }

  /**
   * Add temporal data enrichment
   */
  addTemporalData(standardData) {
    if (standardData.timestamp) {
      const timestamp = moment(standardData.timestamp);

      standardData.metadata.temporal = {
        hour: timestamp.hour(),
        dayOfWeek: timestamp.day(),
        dayOfYear: timestamp.dayOfYear(),
        month: timestamp.month() + 1,
        season: this.getSeason(
          timestamp.month() + 1,
          standardData.location.latitude
        ),
        isWeekend: timestamp.day() === 0 || timestamp.day() === 6,
      };
    }
  }

  /**
   * Determine season based on month and hemisphere
   */
  getSeason(month, latitude = 0) {
    const isNorthern = latitude >= 0;

    if (isNorthern) {
      if (month >= 3 && month <= 5) return 'spring';
      if (month >= 6 && month <= 8) return 'summer';
      if (month >= 9 && month <= 11) return 'autumn';
      return 'winter';
    } else {
      if (month >= 3 && month <= 5) return 'autumn';
      if (month >= 6 && month <= 8) return 'winter';
      if (month >= 9 && month <= 11) return 'spring';
      return 'summer';
    }
  }

  /**
   * Assess data quality and add flags
   */
  async assessQuality(standardData) {
    const flags = [];

    // Check for missing critical values
    const criticalFields = ['temperature', 'humidity', 'pressure'];
    const missingCritical = criticalFields.filter(
      field =>
        standardData.data[field].value === null ||
        standardData.data[field].value === undefined
    );

    if (missingCritical.length > 0) {
      flags.push(`missing_critical_data: ${missingCritical.join(', ')}`);
    }

    // Check for extreme values
    if (standardData.data.temperature.value !== null) {
      if (standardData.data.temperature.value > 55) {
        flags.push('extreme_high_temperature');
      }
      if (standardData.data.temperature.value < -80) {
        flags.push('extreme_low_temperature');
      }
    }

    if (standardData.data.windSpeed.value !== null) {
      if (standardData.data.windSpeed.value > 100) {
        flags.push('extreme_wind_speed');
      }
    }

    if (standardData.data.pressure.value !== null) {
      if (
        standardData.data.pressure.value > 1080 ||
        standardData.data.pressure.value < 870
      ) {
        flags.push('extreme_pressure');
      }
    }

    // Check for inconsistent relationships
    if (
      standardData.data.temperature.value !== null &&
      standardData.data.humidity.value !== null
    ) {
      const dewPoint = standardData.data.dewPoint.value;
      if (dewPoint !== null && dewPoint > standardData.data.temperature.value) {
        flags.push('impossible_dewpoint');
      }
    }

    standardData.quality.flags = flags;
    standardData.quality.confidence = this.calculateConfidence(
      standardData,
      flags
    );
  }

  /**
   * Calculate confidence score based on data completeness and quality flags
   */
  calculateConfidence(standardData, flags) {
    let confidence = 1.0;

    // Reduce confidence for missing data
    const totalFields = Object.keys(standardData.data).length;
    const missingFields = Object.values(standardData.data).filter(
      field => field.value === null || field.value === undefined
    ).length;

    const completeness = (totalFields - missingFields) / totalFields;
    confidence *= completeness;

    // Reduce confidence for quality flags
    const flagPenalty = flags.length * 0.1;
    confidence = Math.max(0, confidence - flagPenalty);

    return Math.round(confidence * 100) / 100;
  }

  /**
   * Handle missing values with interpolation/estimation
   */
  async handleMissingValues(standardData, options) {
    // Simple missing value handling - could be enhanced with more sophisticated methods

    // If humidity is missing but dewpoint and temperature are available
    if (
      standardData.data.humidity.value === null &&
      standardData.data.temperature.value !== null &&
      standardData.data.dewPoint.value !== null
    ) {
      const temp = standardData.data.temperature.value;
      const dewPoint = standardData.data.dewPoint.value;

      // Calculate relative humidity from temperature and dew point
      const rh =
        (100 * Math.exp((17.625 * dewPoint) / (243.04 + dewPoint))) /
        Math.exp((17.625 * temp) / (243.04 + temp));

      standardData.data.humidity.value = Math.round(rh * 10) / 10;
      standardData.quality.flags.push('humidity_estimated');
    }
  }

  /**
   * Get processing statistics
   */
  getStats() {
    return {
      conversionFactors: Object.keys(this.conversionFactors),
      standardSchema: Object.keys(this.standardSchema),
      options: this.options,
    };
  }
}

module.exports = { DataPreprocessor };
