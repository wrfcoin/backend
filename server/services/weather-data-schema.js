/**
 * Weather Data Schema Definitions
 *
 * Defines standardized schemas for weather data ingestion from multiple sources.
 * Provides transformation mappings between different data formats and the unified
 * WRFCoin weather data format.
 */

/**
 * Unified WRFCoin Weather Data Schema
 * This is the standardized format all ingested data will be transformed to
 */
const WRFCoinWeatherSchema = {
  // Metadata
  metadata: {
    sourceId: 'string', // Unique identifier for data source
    sourceType: 'string', // e.g., 'api', 'station', 'satellite'
    provider: 'string', // e.g., 'NOAA-NWS', 'OpenWeatherMap', 'Local-Station'
    dataType: 'string', // e.g., 'current', 'forecast', 'historical'
    timestamp: 'datetime', // ISO 8601 timestamp
    ingestedAt: 'datetime', // When data was ingested
    qualityScore: 'number', // 0-1 quality score
    validationStatus: 'string', // 'valid', 'warning', 'invalid'
  },

  // Location information
  location: {
    latitude: 'number', // Decimal degrees
    longitude: 'number', // Decimal degrees
    elevation: 'number', // Meters above sea level
    stationId: 'string', // Station identifier (if applicable)
    stationName: 'string', // Human-readable station name
    locationName: 'string', // Human-readable location name
    country: 'string', // ISO country code
    region: 'string', // State/province/region
  },

  // Core weather measurements
  measurements: {
    // Temperature
    temperature: {
      value: 'number', // Celsius
      unit: 'string',
      qualityFlag: 'string',
    },
    temperatureMax: {
      value: 'number',
      unit: 'string',
      qualityFlag: 'string',
    },
    temperatureMin: {
      value: 'number',
      unit: 'string',
      qualityFlag: 'string',
    },
    dewpoint: {
      value: 'number',
      unit: 'string',
      qualityFlag: 'string',
    },

    // Humidity and moisture
    humidity: {
      value: 'number', // Percentage (0-100)
      unit: 'string',
      qualityFlag: 'string',
    },

    // Pressure
    pressure: {
      value: 'number', // hPa (hectopascals)
      unit: 'string',
      qualityFlag: 'string',
    },
    pressureSeaLevel: {
      value: 'number',
      unit: 'string',
      qualityFlag: 'string',
    },

    // Wind
    windSpeed: {
      value: 'number', // m/s (meters per second)
      unit: 'string',
      qualityFlag: 'string',
    },
    windDirection: {
      value: 'number', // Degrees (0-360)
      unit: 'string',
      qualityFlag: 'string',
    },
    windGust: {
      value: 'number',
      unit: 'string',
      qualityFlag: 'string',
    },

    // Precipitation
    precipitation: {
      value: 'number', // mm (millimeters)
      unit: 'string',
      qualityFlag: 'string',
    },
    precipitationAccumulation: {
      value: 'number',
      unit: 'string',
      period: 'string', // e.g., '1h', '24h'
      qualityFlag: 'string',
    },

    // Visibility and clouds
    visibility: {
      value: 'number', // km (kilometers)
      unit: 'string',
      qualityFlag: 'string',
    },
    cloudCoverage: {
      value: 'number', // Percentage (0-100)
      unit: 'string',
      qualityFlag: 'string',
    },

    // Snow and ice
    snowfall: {
      value: 'number', // cm (centimeters)
      unit: 'string',
      qualityFlag: 'string',
    },
    snowDepth: {
      value: 'number',
      unit: 'string',
      qualityFlag: 'string',
    },

    // Solar and UV
    solarRadiation: {
      value: 'number', // W/m² (watts per square meter)
      unit: 'string',
      qualityFlag: 'string',
    },
    uvIndex: {
      value: 'number', // UV Index (0-16)
      unit: 'string',
      qualityFlag: 'string',
    },
  },

  // Validation and quality information
  validation: {
    rangeValidation: {
      passed: 'boolean',
      errors: 'array',
    },
    physicsValidation: {
      passed: 'boolean',
      warnings: 'array',
    },
    completenessValidation: {
      passed: 'boolean',
      completenessRatio: 'number',
      missingParameters: 'array',
    },
    overallScore: 'number',
    qualityLevel: 'string', // 'excellent', 'good', 'fair', 'poor', 'invalid'
  },
};

/**
 * Source-specific schema mappings
 * Maps external data formats to the unified WRFCoin schema
 */
const SourceSchemaMappings = {
  'NOAA-NWS': {
    // NOAA National Weather Service API mapping
    metadata: {
      sourceId: 'properties.station',
      sourceType: () => 'api',
      provider: () => 'NOAA-NWS',
      dataType: () => 'current',
      timestamp: 'properties.timestamp',
    },
    location: {
      latitude: 'geometry.coordinates[1]',
      longitude: 'geometry.coordinates[0]',
      elevation: 'properties.elevation.value',
      stationId: 'properties.station',
      stationName: 'properties.stationName',
    },
    measurements: {
      temperature: {
        path: 'properties.temperature.value',
        unit: 'properties.temperature.unitCode',
        transform: (value, unit) => {
          // Convert from Celsius to Celsius (already correct)
          if (unit && unit.includes('degC')) return value;
          // Convert from Fahrenheit if needed
          if (unit && unit.includes('degF')) return ((value - 32) * 5) / 9;
          return value;
        },
      },
      dewpoint: {
        path: 'properties.dewpoint.value',
        unit: 'properties.dewpoint.unitCode',
        transform: (value, unit) => {
          if (unit && unit.includes('degC')) return value;
          if (unit && unit.includes('degF')) return ((value - 32) * 5) / 9;
          return value;
        },
      },
      humidity: {
        path: 'properties.relativeHumidity.value',
        unit: 'properties.relativeHumidity.unitCode',
      },
      pressure: {
        path: 'properties.barometricPressure.value',
        unit: 'properties.barometricPressure.unitCode',
        transform: (value, unit) => {
          // Convert from Pa to hPa
          if (unit && unit.includes('Pa') && !unit.includes('hPa'))
            return value / 100;
          return value;
        },
      },
      windSpeed: {
        path: 'properties.windSpeed.value',
        unit: 'properties.windSpeed.unitCode',
        transform: (value, unit) => {
          // Convert from km/h to m/s
          if (unit && unit.includes('km_h')) return value / 3.6;
          // Convert from mph to m/s
          if (unit && unit.includes('mile_h')) return value * 0.44704;
          return value;
        },
      },
      windDirection: {
        path: 'properties.windDirection.value',
        unit: 'properties.windDirection.unitCode',
      },
      visibility: {
        path: 'properties.visibility.value',
        unit: 'properties.visibility.unitCode',
        transform: (value, unit) => {
          // Convert from meters to kilometers
          if (unit && unit.includes('m') && !unit.includes('km'))
            return value / 1000;
          return value;
        },
      },
    },
  },

  'NOAA-NCEI': {
    // NOAA National Centers for Environmental Information (historical data)
    metadata: {
      sourceId: 'station',
      sourceType: () => 'api',
      provider: () => 'NOAA-NCEI',
      dataType: () => 'historical',
      timestamp: 'date',
    },
    location: {
      latitude: 'latitude',
      longitude: 'longitude',
      elevation: 'elevation',
      stationId: 'station',
      stationName: 'name',
    },
    measurements: {
      temperatureMax: {
        path: 'TMAX',
        transform: value => value / 10, // NOAA stores in tenths of degrees C
      },
      temperatureMin: {
        path: 'TMIN',
        transform: value => value / 10,
      },
      precipitation: {
        path: 'PRCP',
        transform: value => value / 10, // NOAA stores in tenths of mm
      },
    },
  },

  OpenWeatherMap: {
    // OpenWeatherMap API mapping
    metadata: {
      sourceId: () => 'openweathermap',
      sourceType: () => 'api',
      provider: () => 'OpenWeatherMap',
      dataType: () => 'current',
      timestamp: 'dt',
    },
    location: {
      latitude: 'coord.lat',
      longitude: 'coord.lon',
      locationName: 'name',
      country: 'sys.country',
    },
    measurements: {
      temperature: {
        path: 'main.temp',
        transform: value => value - 273.15, // Convert Kelvin to Celsius
      },
      humidity: {
        path: 'main.humidity',
      },
      pressure: {
        path: 'main.pressure',
      },
      windSpeed: {
        path: 'wind.speed',
      },
      windDirection: {
        path: 'wind.deg',
      },
      visibility: {
        path: 'visibility',
        transform: value => value / 1000, // Convert meters to kilometers
      },
      cloudCoverage: {
        path: 'clouds.all',
      },
    },
  },

  LocalStation: {
    // Local weather station data format
    metadata: {
      sourceId: 'stationId',
      sourceType: () => 'station',
      provider: 'provider',
      dataType: () => 'current',
      timestamp: 'timestamp',
    },
    location: {
      latitude: 'location.latitude',
      longitude: 'location.longitude',
      elevation: 'location.elevation',
      stationId: 'stationId',
      stationName: 'stationName',
    },
    measurements: {
      temperature: {
        path: 'measurements.temperature.value',
        unit: 'measurements.temperature.unit',
      },
      humidity: {
        path: 'measurements.humidity.value',
        unit: 'measurements.humidity.unit',
      },
      pressure: {
        path: 'measurements.pressure.value',
        unit: 'measurements.pressure.unit',
      },
      windSpeed: {
        path: 'measurements.windSpeed.value',
        unit: 'measurements.windSpeed.unit',
      },
      windDirection: {
        path: 'measurements.windDirection.value',
        unit: 'measurements.windDirection.unit',
      },
      precipitation: {
        path: 'measurements.precipitation.value',
        unit: 'measurements.precipitation.unit',
      },
    },
  },
};

/**
 * Data quality flags and their meanings
 */
const QualityFlags = {
  A: 'Excellent - Validated and verified',
  B: 'Good - Validated with minor issues',
  C: 'Fair - Some validation warnings',
  D: 'Poor - Multiple validation issues',
  E: 'Invalid - Failed validation',
  M: 'Missing - No data available',
  I: 'Interpolated - Value estimated from nearby data',
  S: 'Suspected - Questionable accuracy',
};

/**
 * Unit conversion factors to standardized units
 */
const UnitConversions = {
  temperature: {
    // Target unit: Celsius
    fahrenheit: f => ((f - 32) * 5) / 9,
    kelvin: k => k - 273.15,
    rankine: r => ((r - 491.67) * 5) / 9,
  },

  pressure: {
    // Target unit: hPa (hectopascals)
    pa: pa => pa / 100,
    kpa: kpa => kpa * 10,
    mmhg: mmhg => mmhg * 1.33322,
    inhg: inhg => inhg * 33.8639,
    psi: psi => psi * 68.9476,
    bar: bar => bar * 1000,
    mbar: mbar => mbar,
  },

  windSpeed: {
    // Target unit: m/s (meters per second)
    kmh: kmh => kmh / 3.6,
    mph: mph => mph * 0.44704,
    knots: knots => knots * 0.514444,
    fps: fps => fps * 0.3048,
  },

  distance: {
    // Target unit: km (kilometers)
    meters: m => m / 1000,
    miles: mi => mi * 1.60934,
    feet: ft => ft * 0.0003048,
    nauticalMiles: nm => nm * 1.852,
  },

  precipitation: {
    // Target unit: mm (millimeters)
    inches: inches => inches * 25.4,
    cm: cm => cm * 10,
    meters: m => m * 1000,
  },
};

/**
 * Default values and null handling strategies
 */
const DefaultValues = {
  temperature: null, // No default for critical measurements
  humidity: null,
  pressure: null,
  windSpeed: 0, // Wind can default to calm
  windDirection: null, // Direction meaningless without speed
  precipitation: 0, // Precipitation can default to none
  visibility: null, // No default for visibility
  cloudCoverage: null, // No default for clouds
  elevation: 0, // Default to sea level if unknown
};

/**
 * Validation rules for each parameter
 */
const ValidationRules = {
  temperature: { min: -89.2, max: 56.7, unit: 'celsius' },
  humidity: { min: 0, max: 100, unit: 'percent' },
  pressure: { min: 870, max: 1085, unit: 'hPa' },
  windSpeed: { min: 0, max: 113, unit: 'm/s' },
  windDirection: { min: 0, max: 360, unit: 'degrees' },
  precipitation: { min: 0, max: 305, unit: 'mm' },
  visibility: { min: 0, max: 50, unit: 'km' },
  cloudCoverage: { min: 0, max: 100, unit: 'percent' },
  uvIndex: { min: 0, max: 16, unit: 'index' },
};

module.exports = {
  WRFCoinWeatherSchema,
  SourceSchemaMappings,
  QualityFlags,
  UnitConversions,
  DefaultValues,
  ValidationRules,
};
