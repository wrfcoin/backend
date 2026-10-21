/**
 * Physics Validation Thresholds Configuration
 *
 * Defines scientifically-based validation thresholds for atmospheric and
 * thermodynamic parameters based on World Meteorological Organization (WMO)
 * standards and established meteorological practices.
 *
 * References:
 * - WMO Guide to Meteorological Instruments and Methods of Observation (CIMO)
 * - NOAA/NWS Observation Standards
 * - International Standard Atmosphere (ISO 2533)
 * - American Meteorological Society standards
 *
 * @author WRFCoin Development Team
 * @version 1.0.0
 */

/**
 * Temperature validation thresholds based on meteorological standards
 */
const TEMPERATURE_THRESHOLDS = {
  // Absolute physical limits
  extreme: {
    min: -89.4, // Record low: Vostok Station, Antarctica (1983)
    max: 56.7, // Record high: Death Valley, USA (1913)
  },

  // Typical operational ranges for most weather stations
  operational: {
    min: -60.0, // Typical cold weather station limit
    max: 50.0, // Typical hot weather station limit
  },

  // Standard measurement tolerances (WMO standards)
  tolerance: {
    accuracy: 0.1, // ±0.1°C accuracy requirement for Class 1 stations
    precision: 0.05, // ±0.05°C precision for high-quality sensors
    calibration: 0.2, // ±0.2°C calibration uncertainty
  },

  // Rate of change limits (°C per hour)
  changeRates: {
    typical: 5.0, // Normal diurnal variation
    storm: 10.0, // During severe weather events
    extreme: 20.0, // Absolute maximum realistic rate
    microclimate: 15.0, // Urban heat island effects
  },

  // Spatial consistency (°C difference between nearby stations)
  spatialConsistency: {
    sameElevation: 3.0, // Within same elevation band
    per100mElevation: 0.65, // Standard lapse rate tolerance
    urbanRural: 5.0, // Urban heat island allowance
    coastal: 8.0, // Land-sea temperature difference
  },
};

/**
 * Dewpoint validation thresholds
 */
const DEWPOINT_THRESHOLDS = {
  // Physical relationship constraints
  temperatureRelation: {
    maxExceedance: 0.1, // Dewpoint can exceed temperature by max 0.1°C (sensor uncertainty)
    typicalDifference: 2.0, // Typical temp-dewpoint spread for humid conditions
    aridDifference: 30.0, // Maximum spread in very dry conditions
  },

  // Absolute limits
  extreme: {
    min: -80.0, // Theoretical minimum in very cold, dry air
    max: 35.0, // Maximum sustainable dewpoint in tropical conditions
  },

  // Measurement tolerances
  tolerance: {
    accuracy: 0.3, // ±0.3°C typical dewpoint accuracy
    precision: 0.1, // ±0.1°C for high-quality sensors
    calibration: 0.5, // ±0.5°C calibration uncertainty
  },

  // Rate of change limits
  changeRates: {
    typical: 3.0, // Normal dewpoint variation per hour
    frontal: 8.0, // During frontal passages
    extreme: 15.0, // Maximum realistic rate
  },
};

/**
 * Pressure validation thresholds (hPa)
 */
const PRESSURE_THRESHOLDS = {
  // Absolute pressure limits (sea level equivalent)
  extreme: {
    min: 870.0, // Record low: Typhoon Tip (1979)
    max: 1085.7, // Record high: Agata, Siberia (1968)
  },

  // Operational ranges
  operational: {
    min: 900.0, // Typical storm minimum
    max: 1050.0, // Typical high pressure maximum
  },

  // Standard atmosphere pressure by altitude
  standardAtmosphere: {
    seaLevel: 1013.25,
    tolerance: 1.0, // ±1.0 hPa tolerance for standard conditions
    lapseRate: 12.0, // hPa per 100m altitude (standard atmosphere)
  },

  // Measurement tolerances
  tolerance: {
    accuracy: 0.1, // ±0.1 hPa for precision barometers
    precision: 0.05, // ±0.05 hPa for research-grade instruments
    calibration: 0.3, // ±0.3 hPa calibration uncertainty
  },

  // Rate of change limits (hPa per hour)
  changeRates: {
    typical: 2.0, // Normal pressure tendency
    storm: 6.0, // During storm development
    extreme: 12.0, // Hurricane/typhoon pressure falls
    microseismic: 0.1, // High-frequency pressure oscillations
  },

  // Altitude-pressure relationship tolerances
  altitudeRelation: {
    standardDeviation: 5.0, // ±5 hPa from standard atmosphere
    localTopography: 10.0, // Additional tolerance for complex terrain
    microclimateFactor: 1.2, // Multiplier for microclimate effects
  },
};

/**
 * Humidity validation thresholds
 */
const HUMIDITY_THRESHOLDS = {
  // Absolute limits
  range: {
    min: 0.0, // Theoretical minimum
    max: 100.0, // Saturation limit
  },

  // Operational limits (very dry and very humid conditions)
  operational: {
    min: 1.0, // Practical minimum for most environments
    max: 99.0, // Practical maximum (avoid condensation issues)
    indoor: { min: 10.0, max: 90.0 }, // Indoor environment limits
    outdoor: { min: 5.0, max: 95.0 }, // Outdoor environment limits
  },

  // Psychrometric consistency tolerances
  psychrometric: {
    temperatureDewpointTolerance: 5.0, // RH calculation tolerance (%)
    vaporPressureTolerance: 0.5, // kPa tolerance for vapor pressure
    mixingRatioTolerance: 1.0, // g/kg tolerance for mixing ratio
    saturationTolerance: 3.0, // % tolerance near saturation
  },

  // Measurement tolerances
  tolerance: {
    accuracy: 3.0, // ±3% RH accuracy for standard sensors
    precision: 1.0, // ±1% RH precision for quality sensors
    calibration: 5.0, // ±5% RH calibration uncertainty
    hysteresis: 2.0, // ±2% RH hysteresis effect
  },

  // Rate of change limits (% per hour)
  changeRates: {
    typical: 10.0, // Normal humidity variation
    frontal: 25.0, // During frontal passages
    extreme: 40.0, // Maximum realistic rate
    dewfall: 15.0, // During dew formation/evaporation
  },
};

/**
 * Wind validation thresholds
 */
const WIND_THRESHOLDS = {
  // Speed limits (m/s)
  speed: {
    min: 0.0, // Calm conditions
    max: 150.0, // Extreme hurricane winds
    operational: 100.0, // Typical anemometer operational limit
    gustThreshold: 3.0, // Minimum speed to register gusts
  },

  // Gust-to-speed relationship
  gustFactor: {
    min: 1.0, // Gust factor cannot be less than 1.0
    typical: 1.3, // Normal gust factor range
    max: 3.0, // Maximum realistic gust factor
    extreme: 5.0, // Absolute maximum (very short duration gusts)
  },

  // Direction validation
  direction: {
    min: 0.0, // Minimum direction (degrees)
    max: 359.9, // Maximum direction
    variability: 30.0, // Typical direction variability (±degrees)
    gustDirection: 60.0, // Maximum gust direction difference
  },

  // Measurement tolerances
  tolerance: {
    speedAccuracy: 0.5, // ±0.5 m/s speed accuracy
    speedPrecision: 0.1, // ±0.1 m/s precision
    directionAccuracy: 5.0, // ±5° direction accuracy
    directionPrecision: 1.0, // ±1° direction precision
    gustAccuracy: 1.0, // ±1.0 m/s gust accuracy
  },

  // Rate of change limits
  changeRates: {
    speedPerMinute: 10.0, // m/s change per minute
    directionPerMinute: 45.0, // degree change per minute
    gustDuration: 3.0, // seconds for gust duration
  },
};

/**
 * Solar radiation validation thresholds (W/m²)
 */
const RADIATION_THRESHOLDS = {
  // Solar radiation limits
  solar: {
    min: 0.0, // Nighttime minimum
    max: 1400.0, // Theoretical maximum at Earth's surface
    clearSkyMax: 1200.0, // Clear sky maximum at sea level
    typicalMax: 1000.0, // Typical maximum for most locations
    nightThreshold: 10.0, // Threshold for detecting nighttime radiation
  },

  // Net radiation limits
  net: {
    min: -250.0, // Maximum nighttime cooling
    max: 800.0, // Maximum daytime net radiation
    nighttimeMax: 50.0, // Maximum net radiation during night
    clearSkyFactor: 0.85, // Fraction of solar radiation for clear sky net
  },

  // Solar angle and time consistency
  solarGeometry: {
    elevationThreshold: 5.0, // Minimum solar elevation for significant radiation
    azimuthTolerance: 15.0, // Tolerance for solar azimuth calculations
    atmosphericTransmittance: {
      // Atmospheric transmittance factors
      min: 0.2, // Heavy overcast/pollution
      max: 0.9, // Very clear conditions
      typical: 0.65, // Average clear sky conditions
    },
  },

  // Measurement tolerances
  tolerance: {
    accuracy: 50.0, // ±50 W/m² typical pyranometer accuracy
    precision: 10.0, // ±10 W/m² precision for quality instruments
    calibration: 25.0, // ±25 W/m² calibration uncertainty
    cosineResponse: 5.0, // ±5% cosine response error
  },

  // Temporal consistency
  changeRates: {
    typical: 200.0, // W/m² change per minute (clouds)
    extreme: 500.0, // W/m² change per minute (severe weather)
    sunrise: 300.0, // W/m² change per minute during sunrise
    sunset: 300.0, // W/m² change per minute during sunset
  },
};

/**
 * Precipitation validation thresholds
 */
const PRECIPITATION_THRESHOLDS = {
  // Intensity limits (mm/hr)
  intensity: {
    min: 0.0, // No precipitation
    light: 2.5, // Light precipitation threshold
    moderate: 10.0, // Moderate precipitation threshold
    heavy: 50.0, // Heavy precipitation threshold
    extreme: 200.0, // Extreme precipitation intensity
    worldRecord: 305.0, // World record: Foc-Foc, Réunion (1966)
  },

  // Accumulation limits (mm)
  accumulation: {
    hourly: 300.0, // Maximum realistic hourly accumulation
    daily: 1000.0, // Maximum realistic daily accumulation
    storm: 2000.0, // Maximum storm total
    worldRecord: 1825.0, // World record 24-hour: Foc-Foc, Réunion (1966)
  },

  // Measurement tolerances
  tolerance: {
    accuracy: 0.1, // ±0.1 mm accuracy for tipping bucket
    precision: 0.05, // ±0.05 mm precision
    windEffect: 10.0, // % undercatch due to wind
    evaporation: 0.2, // mm/hour evaporation loss
  },

  // Temporal consistency
  changeRates: {
    startThreshold: 0.1, // mm to register precipitation start
    endThreshold: 0.05, // mm threshold for precipitation end
    gapTolerance: 300, // seconds gap tolerance
  },
};

/**
 * Atmospheric stability and derived parameter thresholds
 */
const STABILITY_THRESHOLDS = {
  // Potential temperature
  potentialTemperature: {
    min: 200.0, // Minimum realistic potential temperature (K)
    max: 400.0, // Maximum realistic potential temperature (K)
    lapseRate: 0.0098, // Dry adiabatic lapse rate (K/m)
    stabilityIndex: 2.0, // K/100m stability threshold
  },

  // Richardson number
  richardsonNumber: {
    stable: 0.25, // Threshold for stable conditions
    neutral: 0.0, // Neutral stability
    unstable: -0.25, // Threshold for unstable conditions
    extreme: 10.0, // Extreme stability value
  },

  // Atmospheric boundary layer
  boundaryLayer: {
    mixingHeight: { min: 50.0, max: 3000.0 }, // meters
    friction: { min: 0.0, max: 2.0 }, // m/s
    heatFlux: { min: -500.0, max: 1000.0 }, // W/m²
  },
};

/**
 * Quality control flags and thresholds
 */
const QUALITY_CONTROL = {
  // Data completeness requirements
  completeness: {
    minimum: 0.75, // Minimum 75% data completeness
    good: 0.9, // 90% completeness for good quality
    excellent: 0.95, // 95% completeness for excellent quality
  },

  // Consistency check tolerances
  consistency: {
    temporal: 0.95, // 95% temporal consistency required
    spatial: 0.85, // 85% spatial consistency required
    physics: 0.9, // 90% physics consistency required
  },

  // Outlier detection sensitivity
  outlierDetection: {
    zScoreThreshold: 3.5, // Z-score threshold for outliers
    iqrMultiplier: 1.5, // IQR multiplier for outliers
    physicsSeverity: 'medium', // Minimum severity for physics violations
    ensembleAgreement: 0.6, // Ensemble agreement threshold
  },
};

/**
 * Environmental and geographic adjustment factors
 */
const ENVIRONMENTAL_FACTORS = {
  // Altitude adjustments
  altitude: {
    seaLevel: 0,
    lowAltitude: 500, // meters
    mediumAltitude: 1500, // meters
    highAltitude: 3000, // meters
    temperatureAdjustment: 0.65, // °C per 100m
    pressureAdjustment: 12.0, // hPa per 100m
    humidityAdjustment: 0.02, // factor per 100m
  },

  // Climate zone adjustments
  climateZones: {
    tropical: {
      temperatureRange: { min: 15.0, max: 40.0 },
      humidityRange: { min: 40.0, max: 95.0 },
      precipitationMax: 100.0, // mm/hr
    },
    temperate: {
      temperatureRange: { min: -30.0, max: 45.0 },
      humidityRange: { min: 20.0, max: 90.0 },
      precipitationMax: 50.0,
    },
    arctic: {
      temperatureRange: { min: -60.0, max: 25.0 },
      humidityRange: { min: 40.0, max: 90.0 },
      precipitationMax: 10.0,
    },
    arid: {
      temperatureRange: { min: -10.0, max: 55.0 },
      humidityRange: { min: 5.0, max: 70.0 },
      precipitationMax: 25.0,
    },
  },

  // Seasonal adjustments
  seasonal: {
    winter: { temperatureAdjustment: -5.0, humidityAdjustment: 1.1 },
    spring: { temperatureAdjustment: 0.0, humidityAdjustment: 1.0 },
    summer: { temperatureAdjustment: 5.0, humidityAdjustment: 0.9 },
    autumn: { temperatureAdjustment: 0.0, humidityAdjustment: 1.0 },
  },
};

/**
 * Configuration profiles for different use cases
 */
const VALIDATION_PROFILES = {
  // Research-grade validation (strictest)
  research: {
    temperatureTolerance: 0.1,
    pressureTolerance: 0.1,
    humidityTolerance: 1.0,
    windTolerance: 0.5,
    radiationTolerance: 10.0,
    strictMode: true,
    confidence: { minimum: 0.95, target: 0.99 },
  },

  // Operational weather services
  operational: {
    temperatureTolerance: 0.5,
    pressureTolerance: 1.0,
    humidityTolerance: 5.0,
    windTolerance: 2.0,
    radiationTolerance: 50.0,
    strictMode: false,
    confidence: { minimum: 0.85, target: 0.95 },
  },

  // Climate monitoring
  climate: {
    temperatureTolerance: 0.2,
    pressureTolerance: 0.5,
    humidityTolerance: 3.0,
    windTolerance: 1.0,
    radiationTolerance: 25.0,
    strictMode: true,
    confidence: { minimum: 0.9, target: 0.97 },
  },

  // Real-time applications
  realtime: {
    temperatureTolerance: 1.0,
    pressureTolerance: 2.0,
    humidityTolerance: 10.0,
    windTolerance: 3.0,
    radiationTolerance: 100.0,
    strictMode: false,
    confidence: { minimum: 0.75, target: 0.9 },
  },

  // Aviation weather
  aviation: {
    temperatureTolerance: 0.3,
    pressureTolerance: 0.3,
    humidityTolerance: 5.0,
    windTolerance: 1.0,
    radiationTolerance: 50.0,
    strictMode: true,
    confidence: { minimum: 0.92, target: 0.98 },
  },
};

/**
 * Export all threshold configurations
 */
module.exports = {
  TEMPERATURE_THRESHOLDS,
  DEWPOINT_THRESHOLDS,
  PRESSURE_THRESHOLDS,
  HUMIDITY_THRESHOLDS,
  WIND_THRESHOLDS,
  RADIATION_THRESHOLDS,
  PRECIPITATION_THRESHOLDS,
  STABILITY_THRESHOLDS,
  QUALITY_CONTROL,
  ENVIRONMENTAL_FACTORS,
  VALIDATION_PROFILES,

  /**
   * Get validation profile by name
   */
  getValidationProfile: profileName => {
    return VALIDATION_PROFILES[profileName] || VALIDATION_PROFILES.operational;
  },

  /**
   * Get climate-adjusted thresholds
   */
  getClimateAdjustedThresholds: (climateZone, season = 'spring') => {
    const baseThresholds = {
      temperature: TEMPERATURE_THRESHOLDS,
      pressure: PRESSURE_THRESHOLDS,
      humidity: HUMIDITY_THRESHOLDS,
      wind: WIND_THRESHOLDS,
      radiation: RADIATION_THRESHOLDS,
    };

    const climateAdjustments = ENVIRONMENTAL_FACTORS.climateZones[climateZone];
    const seasonalAdjustments = ENVIRONMENTAL_FACTORS.seasonal[season];

    if (!climateAdjustments) {
      return baseThresholds;
    }

    // Apply climate and seasonal adjustments
    const adjustedThresholds = JSON.parse(JSON.stringify(baseThresholds));

    // Apply temperature adjustments
    if (climateAdjustments.temperatureRange) {
      adjustedThresholds.temperature.operational =
        climateAdjustments.temperatureRange;
    }

    // Apply humidity adjustments
    if (climateAdjustments.humidityRange) {
      adjustedThresholds.humidity.operational =
        climateAdjustments.humidityRange;
    }

    return adjustedThresholds;
  },

  /**
   * Get altitude-adjusted thresholds
   */
  getAltitudeAdjustedThresholds: altitude => {
    const altitudeFactors = ENVIRONMENTAL_FACTORS.altitude;
    const pressureAdjustment =
      (altitude / 100) * altitudeFactors.pressureAdjustment;
    const temperatureAdjustment =
      (altitude / 100) * altitudeFactors.temperatureAdjustment;

    const adjustedThresholds = {
      pressure: {
        ...PRESSURE_THRESHOLDS,
        operational: {
          min: PRESSURE_THRESHOLDS.operational.min - pressureAdjustment,
          max: PRESSURE_THRESHOLDS.operational.max - pressureAdjustment,
        },
      },
      temperature: {
        ...TEMPERATURE_THRESHOLDS,
        operational: {
          min: TEMPERATURE_THRESHOLDS.operational.min - temperatureAdjustment,
          max: TEMPERATURE_THRESHOLDS.operational.max - temperatureAdjustment,
        },
      },
    };

    return adjustedThresholds;
  },
};
