/**
 * Physics-Based Validation Engine for Weather Data
 *
 * Implements comprehensive atmospheric and thermodynamic validation based on
 * fundamental physical laws and meteorological principles.
 *
 * Features:
 * - Thermodynamic consistency validation
 * - Atmospheric stability analysis
 * - Radiation physics validation
 * - Psychrometric relationships
 * - Energy balance checks
 * - Spatial and temporal consistency
 *
 * @author WRFCoin Development Team
 * @version 1.0.0
 */

const {
  ValidationResult,
  PhysicsConstants,
  AtmosphericUtils,
} = require('./physics-utils');
const { weatherLogger } = require('../utils/logger.js');
const {
  TEMPERATURE_THRESHOLDS,
  DEWPOINT_THRESHOLDS,
  PRESSURE_THRESHOLDS,
  HUMIDITY_THRESHOLDS,
  WIND_THRESHOLDS,
  RADIATION_THRESHOLDS,
  PRECIPITATION_THRESHOLDS,
  STABILITY_THRESHOLDS,
  QUALITY_CONTROL,
  getValidationProfile,
  getClimateAdjustedThresholds,
  getAltitudeAdjustedThresholds,
} = require('../config/physics-validation-thresholds');

class PhysicsValidationEngine {
  constructor(options = {}) {
    // Load validation profile (default: operational)
    const profile = getValidationProfile(
      options.validationProfile || 'operational'
    );

    this.options = {
      // Validation thresholds based on meteorological standards
      temperatureTolerance:
        options.temperatureTolerance || profile.temperatureTolerance,
      pressureTolerance: options.pressureTolerance || profile.pressureTolerance,
      humidityTolerance: options.humidityTolerance || profile.humidityTolerance,
      windTolerance: options.windTolerance || profile.windTolerance,
      radiationTolerance:
        options.radiationTolerance || profile.radiationTolerance,

      // Physics validation modes
      strictMode:
        options.strictMode !== undefined
          ? options.strictMode
          : profile.strictMode,
      enableDebug: options.enableDebug || false,

      // Confidence thresholds
      minConfidence: options.minConfidence || profile.confidence.minimum,
      targetConfidence: options.targetConfidence || profile.confidence.target,

      // Environmental context
      climateZone: options.climateZone || null,
      season: options.season || 'spring',
      altitude: options.altitude || 0,

      // Validation profile
      validationProfile: options.validationProfile || 'operational',

      ...options,
    };

    this.physicsConstants = new PhysicsConstants();
    this.atmosphericUtils = new AtmosphericUtils();

    // Load meteorological thresholds
    this.thresholds = this._loadCalibrationThresholds();

    // Initialize validation rules
    this.validationRules = this._initializeValidationRules();
  }

  /**
   * Load and calibrate validation thresholds based on environmental context
   */
  _loadCalibrationThresholds() {
    let thresholds = {
      temperature: TEMPERATURE_THRESHOLDS,
      dewpoint: DEWPOINT_THRESHOLDS,
      pressure: PRESSURE_THRESHOLDS,
      humidity: HUMIDITY_THRESHOLDS,
      wind: WIND_THRESHOLDS,
      radiation: RADIATION_THRESHOLDS,
      precipitation: PRECIPITATION_THRESHOLDS,
      stability: STABILITY_THRESHOLDS,
    };

    // Apply climate zone adjustments if specified
    if (this.options.climateZone) {
      const climateAdjusted = getClimateAdjustedThresholds(
        this.options.climateZone,
        this.options.season
      );
      thresholds = { ...thresholds, ...climateAdjusted };
    }

    // Apply altitude adjustments if specified
    if (this.options.altitude > 0) {
      const altitudeAdjusted = getAltitudeAdjustedThresholds(
        this.options.altitude
      );
      thresholds.pressure = altitudeAdjusted.pressure;
      thresholds.temperature = altitudeAdjusted.temperature;
    }

    return thresholds;
  }

  /**
   * Main physics validation entry point
   */
  async validateData(data, location = null, timestamp = null) {
    try {
      const results = {
        overallValid: true,
        overallConfidence: 1.0,
        violations: [],
        validations: {},
        metadata: {
          totalChecks: 0,
          passedChecks: 0,
          failedChecks: 0,
          timestamp: new Date().toISOString(),
          location: location,
          dataTimestamp: timestamp,
        },
      };

      // Validate single record or array
      if (Array.isArray(data)) {
        return await this._validateDataArray(data, results);
      } else {
        return await this._validateSingleRecord(data, results);
      }
    } catch (error) {
      this._logError('Physics validation error:', error);
      return this._createErrorResult(error);
    }
  }

  /**
   * Validate array of weather records
   */
  async _validateDataArray(dataArray, results) {
    const recordResults = [];

    for (let i = 0; i < dataArray.length; i++) {
      const record = dataArray[i];
      const recordResult = await this._validateSingleRecord(record, {
        ...results,
        violations: [],
        validations: {},
      });

      recordResults.push(recordResult);

      // Aggregate results
      results.metadata.totalChecks += recordResult.metadata.totalChecks;
      results.metadata.passedChecks += recordResult.metadata.passedChecks;
      results.metadata.failedChecks += recordResult.metadata.failedChecks;

      if (!recordResult.overallValid) {
        results.overallValid = false;
        results.violations.push(...recordResult.violations);
      }
    }

    // Calculate overall confidence
    results.overallConfidence =
      recordResults.reduce((sum, r) => sum + r.overallConfidence, 0) /
      recordResults.length;
    results.recordResults = recordResults;

    return results;
  }

  /**
   * Validate single weather record
   */
  async _validateSingleRecord(record, results) {
    const validations = [];

    // 1. Thermodynamic Consistency
    validations.push(await this._validateThermodynamics(record));

    // 2. Atmospheric Stability
    validations.push(await this._validateAtmosphericStability(record));

    // 3. Psychrometric Relationships
    validations.push(await this._validatePsychrometrics(record));

    // 4. Radiation Physics
    validations.push(await this._validateRadiation(record));

    // 5. Pressure-Altitude Relationships
    validations.push(await this._validatePressureAltitude(record));

    // 6. Wind Physics
    validations.push(await this._validateWindPhysics(record));

    // 7. Energy Balance
    validations.push(await this._validateEnergyBalance(record));

    // 8. Temporal Consistency (if previous data available)
    if (record.previousData) {
      validations.push(
        await this._validateTemporalConsistency(record, record.previousData)
      );
    }

    // Process validation results
    return this._processValidationResults(validations, results);
  }

  /**
   * Validate thermodynamic relationships
   */
  async _validateThermodynamics(record) {
    const result = new ValidationResult('thermodynamics');

    try {
      result.confidence = this._calculateThermodynamicConfidence(record);
      const { temperature, dewpoint, pressure, humidity } = record;

      if (!this._hasRequiredFields(record, ['temperature', 'dewpoint'])) {
        result.addWarning('Insufficient data for thermodynamic validation');
        return result;
      }

      // 1. Dewpoint-Temperature Relationship (using calibrated thresholds)
      const dewpointThreshold =
        this.thresholds.dewpoint.temperatureRelation.maxExceedance;
      if (dewpoint > temperature + dewpointThreshold) {
        result.addViolation(
          'dewpoint_exceeds_temperature',
          `Dewpoint (${dewpoint}°C) exceeds temperature (${temperature}°C) by ${(dewpoint - temperature).toFixed(2)}°C (max allowed: ${dewpointThreshold}°C)`,
          'critical'
        );
      }

      // Check for extreme dewpoint-temperature differences
      const tempDewpointDiff = temperature - dewpoint;
      if (
        tempDewpointDiff >
        this.thresholds.dewpoint.temperatureRelation.aridDifference
      ) {
        result.addViolation(
          'extreme_temperature_dewpoint_difference',
          `Temperature-dewpoint difference (${tempDewpointDiff.toFixed(1)}°C) exceeds arid climate maximum (${this.thresholds.dewpoint.temperatureRelation.aridDifference}°C)`,
          'minor'
        );
      }

      // 2. Clausius-Clapeyron Relationship Validation (using calibrated thresholds)
      if (humidity && this._isValidNumber(humidity)) {
        const expectedHumidity = this._calculateRelativeHumidity(
          temperature,
          dewpoint
        );
        const humidityDiff = Math.abs(humidity - expectedHumidity);
        const psychrometricTolerance =
          this.thresholds.humidity.psychrometric.temperatureDewpointTolerance;

        if (humidityDiff > psychrometricTolerance) {
          result.addViolation(
            'humidity_inconsistency',
            `Calculated humidity (${expectedHumidity.toFixed(1)}%) differs from measured (${humidity}%) by ${humidityDiff.toFixed(1)}% (tolerance: ${psychrometricTolerance}%)`,
            humidityDiff > psychrometricTolerance * 2 ? 'major' : 'minor'
          );
        }

        // Check for extreme humidity values
        if (
          humidity < this.thresholds.humidity.operational.min ||
          humidity > this.thresholds.humidity.operational.max
        ) {
          result.addViolation(
            'humidity_out_of_operational_range',
            `Humidity (${humidity}%) outside operational range (${this.thresholds.humidity.operational.min}-${this.thresholds.humidity.operational.max}%)`,
            humidity < this.thresholds.humidity.range.min ||
              humidity > this.thresholds.humidity.range.max
              ? 'critical'
              : 'major'
          );
        }
      }

      // 3. Magnus Formula Validation
      const saturationVaporPressure =
        this._calculateSaturationVaporPressure(temperature);
      const actualVaporPressure =
        this._calculateSaturationVaporPressure(dewpoint);

      if (actualVaporPressure > saturationVaporPressure * 1.01) {
        // 1% tolerance
        result.addViolation(
          'vapor_pressure_inconsistency',
          'Actual vapor pressure exceeds saturation pressure',
          'major'
        );
      }

      // 4. Wet Bulb Temperature Validation
      const wetBulbTemp = this._calculateWetBulbTemperature(
        temperature,
        dewpoint,
        pressure
      );
      if (wetBulbTemp > temperature + 0.1) {
        result.addViolation(
          'wet_bulb_inconsistency',
          'Wet bulb temperature cannot exceed dry bulb temperature',
          'major'
        );
      }

      result.confidence = this._calculateThermodynamicConfidence(record);
      result.setValid(result.violations.length === 0);
    } catch (error) {
      result.addError('thermodynamic_validation_error', error.message);
    }

    return result;
  }

  /**
   * Validate atmospheric stability
   */
  async _validateAtmosphericStability(record) {
    const result = new ValidationResult('atmospheric_stability');

    try {
      result.confidence = this._calculateStabilityConfidence(record);
      const { temperature, pressure, altitude, windSpeed } = record;

      if (!this._hasRequiredFields(record, ['temperature', 'pressure'])) {
        result.addWarning('Insufficient data for stability validation');
        return result;
      }

      // 1. Standard Lapse Rate Validation
      if (altitude && this._isValidNumber(altitude)) {
        const expectedTemp = this._calculateStandardTemperature(altitude);
        const tempDifference = Math.abs(temperature - expectedTemp);

        // Allow for reasonable deviation from standard atmosphere
        const maxDeviation = 15.0; // °C - reasonable for surface conditions

        if (tempDifference > maxDeviation) {
          result.addViolation(
            'extreme_temperature_deviation',
            `Temperature deviates ${tempDifference.toFixed(1)}°C from standard atmosphere`,
            tempDifference > maxDeviation * 1.5 ? 'major' : 'minor'
          );
        }
      }

      // 2. Potential Temperature Consistency
      const potentialTemp = this._calculatePotentialTemperature(
        temperature,
        pressure
      );

      // Basic sanity check - potential temperature should be reasonable
      if (potentialTemp < 200 || potentialTemp > 400) {
        result.addViolation(
          'invalid_potential_temperature',
          `Potential temperature (${potentialTemp.toFixed(1)}K) outside reasonable range`,
          'major'
        );
      }

      // 3. Static Stability Assessment
      if (
        record.previousData &&
        record.previousData.temperature &&
        record.previousData.pressure
      ) {
        const stability = this._assessStaticStability(
          record,
          record.previousData
        );

        if (stability.isExtreme) {
          result.addViolation(
            'extreme_stability',
            `Extreme atmospheric stability detected: ${stability.description}`,
            'minor'
          );
        }
      }

      result.confidence = this._calculateStabilityConfidence(record);
      result.setValid(result.violations.length === 0);
    } catch (error) {
      result.addError('stability_validation_error', error.message);
    }

    return result;
  }

  /**
   * Validate psychrometric relationships
   */
  async _validatePsychrometrics(record) {
    const result = new ValidationResult('psychrometrics');

    try {
      result.confidence = this._calculatePsychrometricConfidence(record);
      const { temperature, dewpoint, humidity, pressure } = record;

      if (!this._hasRequiredFields(record, ['temperature', 'dewpoint'])) {
        result.addWarning('Insufficient data for psychrometric validation');
        return result;
      }

      // 1. Relative Humidity Consistency
      const calculatedRH = this._calculateRelativeHumidity(
        temperature,
        dewpoint
      );

      if (humidity && this._isValidNumber(humidity)) {
        const rhDifference = Math.abs(humidity - calculatedRH);

        if (rhDifference > this.options.humidityTolerance) {
          result.addViolation(
            'relative_humidity_inconsistency',
            `Measured RH (${humidity}%) vs calculated (${calculatedRH.toFixed(1)}%)`,
            rhDifference > this.options.humidityTolerance * 2
              ? 'major'
              : 'minor'
          );
        }
      }

      // 2. Vapor Pressure Deficit
      const vpd = this._calculateVaporPressureDeficit(temperature, dewpoint);

      if (vpd < 0) {
        result.addViolation(
          'negative_vapor_pressure_deficit',
          `Vapor pressure deficit cannot be negative (${vpd.toFixed(3)} kPa)`,
          'major'
        );
      }

      // 3. Mixing Ratio Validation
      if (pressure && this._isValidNumber(pressure)) {
        const mixingRatio = this._calculateMixingRatio(dewpoint, pressure);

        if (mixingRatio < 0 || mixingRatio > 0.04) {
          // 40 g/kg is extremely high
          result.addViolation(
            'invalid_mixing_ratio',
            `Mixing ratio (${(mixingRatio * 1000).toFixed(1)} g/kg) outside valid range`,
            'major'
          );
        }
      }

      // 4. Absolute Humidity Check
      const absoluteHumidity = this._calculateAbsoluteHumidity(
        temperature,
        dewpoint
      );

      if (absoluteHumidity < 0 || absoluteHumidity > 50) {
        // g/m³
        result.addViolation(
          'invalid_absolute_humidity',
          `Absolute humidity (${absoluteHumidity.toFixed(1)} g/m³) outside valid range`,
          'major'
        );
      }

      result.confidence = this._calculatePsychrometricConfidence(record);
      result.setValid(result.violations.length === 0);
    } catch (error) {
      result.addError('psychrometric_validation_error', error.message);
    }

    return result;
  }

  /**
   * Validate radiation physics
   */
  async _validateRadiation(record) {
    const result = new ValidationResult('radiation');

    try {
      result.confidence = this._calculateRadiationConfidence(record);
      const { solarRadiation, temperature, timestamp, latitude, longitude } =
        record;

      if (!solarRadiation || !this._isValidNumber(solarRadiation)) {
        result.addWarning('No solar radiation data for validation');
        return result;
      }

      // 1. Solar Radiation Range Check
      const maxPossibleRadiation = 1400; // W/m² - theoretical maximum at Earth's surface

      if (solarRadiation > maxPossibleRadiation) {
        result.addViolation(
          'excessive_solar_radiation',
          `Solar radiation (${solarRadiation} W/m²) exceeds physical maximum`,
          'critical'
        );
      }

      if (solarRadiation < 0) {
        result.addViolation(
          'negative_solar_radiation',
          `Solar radiation cannot be negative (${solarRadiation} W/m²)`,
          'major'
        );
      }

      // 2. Solar Angle Validation
      if (timestamp && latitude && longitude) {
        const solarData = this._calculateSolarPosition(
          timestamp,
          latitude,
          longitude
        );
        const expectedMaxRadiation = this._calculateMaxSolarRadiation(
          solarData.elevation
        );

        if (solarData.elevation < 0 && solarRadiation > 10) {
          result.addViolation(
            'nighttime_solar_radiation',
            `Solar radiation detected during nighttime (elevation: ${solarData.elevation.toFixed(1)}°)`,
            'major'
          );
        }

        if (solarRadiation > expectedMaxRadiation * 1.1) {
          result.addViolation(
            'radiation_exceeds_solar_angle_limit',
            'Radiation exceeds expected maximum for solar angle',
            'minor'
          );
        }
      }

      // Temperature alone cannot establish a radiation limit. The former
      // heuristic called an undefined helper and made every warm record error.
      result.addWarning('Temperature-radiation consistency is not evaluated');

      result.confidence = this._calculateRadiationConfidence(record);
      result.setValid(result.violations.length === 0);
    } catch (error) {
      result.addError('radiation_validation_error', error.message);
    }

    return result;
  }

  /**
   * Validate pressure-altitude relationships
   */
  async _validatePressureAltitude(record) {
    const result = new ValidationResult('pressure_altitude');

    try {
      result.confidence = this._calculatePressureConfidence(record);
      const { pressure, altitude, temperature } = record;

      if (!pressure || !this._isValidNumber(pressure)) {
        result.addWarning('No pressure data for validation');
        return result;
      }

      // 1. Pressure Range Check
      if (pressure < 300 || pressure > 1100) {
        // hPa
        result.addViolation(
          'pressure_out_of_range',
          `Pressure (${pressure} hPa) outside typical atmospheric range`,
          pressure < 200 || pressure > 1200 ? 'major' : 'minor'
        );
      }

      // 2. Barometric Formula Validation
      if (altitude && this._isValidNumber(altitude)) {
        const expectedPressure = this._calculateExpectedPressure(
          altitude,
          temperature
        );
        const pressureDifference = Math.abs(pressure - expectedPressure);
        const tolerance = expectedPressure * 0.05; // 5% tolerance

        if (pressureDifference > tolerance) {
          result.addViolation(
            'pressure_altitude_inconsistency',
            `Pressure-altitude relationship violation: expected ${expectedPressure.toFixed(1)} hPa, got ${pressure} hPa`,
            pressureDifference > tolerance * 2 ? 'major' : 'minor'
          );
        }
      }

      // 3. Altimeter Setting Validation
      const altimeterSetting = this._calculateAltimeterSetting(
        pressure,
        altitude || 0
      );

      if (altimeterSetting < 28.0 || altimeterSetting > 31.5) {
        // inHg
        result.addViolation(
          'extreme_altimeter_setting',
          `Altimeter setting (${altimeterSetting.toFixed(2)} inHg) outside typical range`,
          'minor'
        );
      }

      result.confidence = this._calculatePressureConfidence(record);
      result.setValid(result.violations.length === 0);
    } catch (error) {
      result.addError('pressure_validation_error', error.message);
    }

    return result;
  }

  /**
   * Validate wind physics
   */
  async _validateWindPhysics(record) {
    const result = new ValidationResult('wind_physics');

    try {
      result.confidence = this._calculateWindConfidence(record);
      const { windSpeed, windGust, windDirection, pressure } = record;

      if (!windSpeed && !windGust) {
        result.addWarning('No wind data for validation');
        return result;
      }

      // 1. Wind Speed Validation
      if (windSpeed && this._isValidNumber(windSpeed)) {
        if (windSpeed < 0) {
          result.addViolation(
            'negative_wind_speed',
            `Wind speed cannot be negative (${windSpeed} m/s)`,
            'major'
          );
        }

        if (windSpeed > 150) {
          // m/s - extreme wind speed threshold
          result.addViolation(
            'extreme_wind_speed',
            `Wind speed (${windSpeed} m/s) exceeds extreme threshold`,
            'major'
          );
        }
      }

      // 2. Gust-Speed Relationship
      if (
        windSpeed &&
        windGust &&
        this._isValidNumber(windSpeed) &&
        this._isValidNumber(windGust)
      ) {
        if (windGust < windSpeed - this.options.windTolerance) {
          result.addViolation(
            'gust_less_than_speed',
            `Wind gust (${windGust} m/s) cannot be less than sustained wind (${windSpeed} m/s)`,
            'major'
          );
        }

        // Gust factor validation (typical range 1.2-2.0)
        const gustFactor = windGust / (windSpeed || 0.1);
        if (gustFactor > 3.0) {
          result.addViolation(
            'excessive_gust_factor',
            `Gust factor (${gustFactor.toFixed(1)}) is unusually high`,
            'minor'
          );
        }
      }

      // 3. Wind Direction Validation
      if (windDirection && this._isValidNumber(windDirection)) {
        if (windDirection < 0 || windDirection >= 360) {
          result.addViolation(
            'invalid_wind_direction',
            `Wind direction (${windDirection}°) must be between 0-359°`,
            'major'
          );
        }
      }

      result.confidence = this._calculateWindConfidence(record);
      result.setValid(result.violations.length === 0);
    } catch (error) {
      result.addError('wind_validation_error', error.message);
    }

    return result;
  }

  /**
   * Validate energy balance
   */
  async _validateEnergyBalance(record) {
    const result = new ValidationResult('energy_balance');

    try {
      result.confidence = this._calculateEnergyBalanceConfidence(record);
      const {
        solarRadiation,
        netRadiation,
        temperature,
        humidity,
        windSpeed,
        soilTemperature,
      } = record;

      if (
        !this._isValidNumber(solarRadiation) &&
        !this._isValidNumber(netRadiation)
      ) {
        result.addWarning(
          'Insufficient radiation data for energy balance validation'
        );
        return result;
      }

      // 1. Net Radiation Consistency
      if (
        this._isValidNumber(solarRadiation) &&
        this._isValidNumber(netRadiation)
      ) {
        // Net radiation should generally be less than incoming solar radiation
        if (netRadiation > solarRadiation + 50) {
          // 50 W/m² tolerance
          result.addViolation(
            'net_radiation_exceeds_solar',
            `Net radiation (${netRadiation} W/m²) exceeds solar radiation (${solarRadiation} W/m²)`,
            'minor'
          );
        }

        // Nighttime net radiation should be negative
        if (solarRadiation < 10 && netRadiation > 10) {
          result.addViolation(
            'positive_nighttime_net_radiation',
            'Positive net radiation during low solar input',
            'minor'
          );
        }
      }

      // 2. Sensible Heat Flux Estimation
      if (
        this._isValidNumber(temperature) &&
        this._isValidNumber(windSpeed)
      ) {
        const sensibleHeat = this.atmosphericUtils.calculateSensibleHeatFlux(
          temperature,
          windSpeed,
          soilTemperature
        );

        // Basic sanity check for sensible heat flux
        if (Math.abs(sensibleHeat) > 1000) {
          // W/m²
          result.addViolation(
            'extreme_sensible_heat_flux',
            `Estimated sensible heat flux (${sensibleHeat.toFixed(0)} W/m²) seems extreme`,
            'minor'
          );
        }
      }

      // Humidity alone cannot establish sensible-to-latent heat flux ratio.
      // The existing utility is humidity-blind; do not classify it as evidence.
      if (this._isValidNumber(temperature) && this._isValidNumber(humidity)) {
        result.addWarning(
          'Bowen ratio is not evaluated: measured sensible and latent heat fluxes are unavailable'
        );
      }

      result.confidence = this._calculateEnergyBalanceConfidence(record);
      result.setValid(result.violations.length === 0);
    } catch (error) {
      result.addError('energy_balance_validation_error', error.message);
    }

    return result;
  }

  /**
   * Validate temporal consistency
   */
  async _validateTemporalConsistency(currentRecord, previousRecord) {
    const result = new ValidationResult('temporal_consistency');

    try {
      const timeDiff = this._calculateTimeDifference(
        currentRecord.timestamp,
        previousRecord.timestamp
      );

      if (!Number.isFinite(timeDiff) || timeDiff <= 0) {
        result.confidence = 0;
        result.addViolation(
          'invalid_time_sequence',
          'Current record timestamp is not after previous record',
          'major'
        );
        return result;
      }

      // Calculate maximum reasonable change rates
      const maxTempChangeRate = 10 / 3600; // °C per second (10°C per hour)
      const maxPressureChangeRate = 10 / 3600; // hPa per second
      const maxHumidityChangeRate = 20 / 3600; // % per second

      // Temperature rate validation
      if (
        this._isValidNumber(currentRecord.temperature) &&
        this._isValidNumber(previousRecord.temperature)
      ) {
        const tempChangeRate =
          Math.abs(currentRecord.temperature - previousRecord.temperature) /
          timeDiff;

        if (tempChangeRate > maxTempChangeRate) {
          result.addViolation(
            'excessive_temperature_change_rate',
            `Temperature change rate (${(tempChangeRate * 3600).toFixed(2)}°C/hr) exceeds reasonable limit`,
            'minor'
          );
        }
      }

      // Pressure rate validation
      if (
        this._isValidNumber(currentRecord.pressure) &&
        this._isValidNumber(previousRecord.pressure)
      ) {
        const pressureChangeRate =
          Math.abs(currentRecord.pressure - previousRecord.pressure) / timeDiff;

        if (pressureChangeRate > maxPressureChangeRate) {
          result.addViolation(
            'excessive_pressure_change_rate',
            `Pressure change rate (${(pressureChangeRate * 3600).toFixed(2)} hPa/hr) exceeds reasonable limit`,
            'minor'
          );
        }
      }

      // Humidity rate validation
      if (
        this._isValidNumber(currentRecord.humidity) &&
        this._isValidNumber(previousRecord.humidity)
      ) {
        const humidityChangeRate =
          Math.abs(currentRecord.humidity - previousRecord.humidity) / timeDiff;

        if (humidityChangeRate > maxHumidityChangeRate) {
          result.addViolation(
            'excessive_humidity_change_rate',
            `Humidity change rate (${(humidityChangeRate * 3600).toFixed(1)}%/hr) exceeds reasonable limit`,
            'minor'
          );
        }
      }

      result.confidence = this._calculateTemporalConfidence(
        currentRecord,
        previousRecord
      );
      result.setValid(result.violations.length === 0);
    } catch (error) {
      result.addError('temporal_validation_error', error.message);
    }

    return result;
  }

  // ==============================================
  // PHYSICS CALCULATION METHODS
  // ==============================================

  /**
   * Calculate relative humidity from temperature and dewpoint
   */
  _calculateRelativeHumidity(temperature, dewpoint) {
    const satVaporPress = this._calculateSaturationVaporPressure(temperature);
    const actVaporPress = this._calculateSaturationVaporPressure(dewpoint);
    return (actVaporPress / satVaporPress) * 100;
  }

  /**
   * Calculate saturation vapor pressure using Magnus formula
   */
  _calculateSaturationVaporPressure(temperature) {
    // Magnus formula: es = 6.112 * exp((17.67 * T) / (T + 243.5))
    return 6.112 * Math.exp((17.67 * temperature) / (temperature + 243.5));
  }

  /**
   * Calculate vapor pressure deficit
   */
  _calculateVaporPressureDeficit(temperature, dewpoint) {
    const satVaporPress = this._calculateSaturationVaporPressure(temperature);
    const actVaporPress = this._calculateSaturationVaporPressure(dewpoint);
    return (satVaporPress - actVaporPress) / 1000; // Convert to kPa
  }

  /**
   * Calculate mixing ratio
   */
  _calculateMixingRatio(dewpoint, pressure) {
    const vaporPressure = this._calculateSaturationVaporPressure(dewpoint);
    const { MOLECULAR_WEIGHT_WATER, MOLECULAR_WEIGHT_DRY_AIR } =
      this.physicsConstants;

    return (
      (MOLECULAR_WEIGHT_WATER / MOLECULAR_WEIGHT_DRY_AIR) *
      (vaporPressure / (pressure - vaporPressure))
    );
  }

  /**
   * Calculate absolute humidity
   */
  _calculateAbsoluteHumidity(temperature, dewpoint) {
    const vaporPressure = this._calculateSaturationVaporPressure(dewpoint);
    const tempKelvin = this.physicsConstants.celsiusToKelvin(temperature);

    // Using ideal gas law: ρ = (P * M) / (R * T)
    return (
      (vaporPressure * 100 * this.physicsConstants.MOLECULAR_WEIGHT_WATER) /
      (this.physicsConstants.R_VAPOR * tempKelvin * 1000)
    ); // g/m³
  }

  /**
   * Calculate wet bulb temperature
   */
  _calculateWetBulbTemperature(temperature, dewpoint, pressure = 1013.25) {
    // Simplified Stull formula for wet bulb temperature
    const rh = this._calculateRelativeHumidity(temperature, dewpoint);
    return (
      temperature * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
      Math.atan(temperature + rh) -
      Math.atan(rh - 1.676331) +
      0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
      4.686035
    );
  }

  /**
   * Calculate potential temperature
   */
  _calculatePotentialTemperature(temperature, pressure) {
    const T_K = temperature + 273.15; // Convert to Kelvin
    const P0 = 1000; // Reference pressure in hPa
    const kappa = 0.286; // R/cp for dry air

    return T_K * Math.pow(P0 / pressure, kappa);
  }

  /**
   * Calculate standard atmosphere temperature at altitude
   */
  _calculateStandardTemperature(altitude) {
    const T0 = 15.0; // Standard sea level temperature (°C)
    const lapseRate = 6.5; // Standard lapse rate (°C/km)

    return T0 - lapseRate * (altitude / 1000);
  }

  /**
   * Calculate expected pressure at altitude
   */
  _calculateExpectedPressure(altitude, temperature = null) {
    const P0 = 1013.25; // Sea level pressure (hPa)
    const T0 = temperature ? temperature + 273.15 : 288.15; // Temperature in Kelvin
    const g = 9.80665; // Gravitational acceleration
    const M = 0.0289644; // Molar mass of dry air (kg/mol)
    const R = 8.31432; // Universal gas constant

    // Barometric formula
    return P0 * Math.exp((-g * M * altitude) / (R * T0));
  }

  /**
   * Calculate altimeter setting
   */
  _calculateAltimeterSetting(pressure, altitude) {
    const pressureInHg = pressure * 0.02953; // Convert hPa to inHg
    const altitudeFt = altitude * 3.28084; // Convert m to ft

    // Standard correction for altitude
    const correction = (altitudeFt / 1000) * 1.0; // Approximate correction

    return pressureInHg + correction;
  }

  /**
   * Calculate solar position
   */
  _calculateSolarPosition(timestamp, latitude, longitude) {
    const date = new Date(timestamp);
    const dayOfYear = this._getDayOfYear(date);
    const hour = date.getUTCHours() + date.getUTCMinutes() / 60;

    // Solar declination
    const declination =
      23.45 * Math.sin((((Math.PI * (284 + dayOfYear)) / 365) * Math.PI) / 180);

    // Hour angle
    const hourAngle = 15 * (hour - 12 + longitude / 15);

    // Solar elevation
    const elevation =
      (Math.asin(
        Math.sin((declination * Math.PI) / 180) *
          Math.sin((latitude * Math.PI) / 180) +
          Math.cos((declination * Math.PI) / 180) *
            Math.cos((latitude * Math.PI) / 180) *
            Math.cos((hourAngle * Math.PI) / 180)
      ) *
        180) /
      Math.PI;

    return { elevation, declination, hourAngle };
  }

  /**
   * Calculate maximum solar radiation for given solar elevation
   */
  _calculateMaxSolarRadiation(elevation) {
    if (elevation <= 0) return 0;

    const solarConstant = 1367; // W/m²
    const atmosphericTransmittance = 0.75; // Typical clear sky value

    return (
      solarConstant *
      atmosphericTransmittance *
      Math.sin((elevation * Math.PI) / 180)
    );
  }

  // ==============================================
  // CONFIDENCE CALCULATION METHODS
  // ==============================================

  _calculateThermodynamicConfidence(record) {
    let confidence = 1.0;
    const { temperature, dewpoint, humidity, pressure } = record;

    // Reduce confidence based on missing data
    if (!this._isValidNumber(temperature)) confidence *= 0.5;
    if (!this._isValidNumber(dewpoint)) confidence *= 0.7;
    if (!this._isValidNumber(humidity)) confidence *= 0.9;
    if (!this._isValidNumber(pressure)) confidence *= 0.9;

    // Reduce confidence for extreme values
    if (temperature && (temperature < -50 || temperature > 60))
      confidence *= 0.8;
    if (dewpoint && (dewpoint < -60 || dewpoint > 40)) confidence *= 0.8;

    return Math.max(confidence, 0.1);
  }

  _calculateStabilityConfidence(record) {
    let confidence = 1.0;
    const { temperature, pressure, altitude } = record;

    if (!this._isValidNumber(temperature)) confidence *= 0.6;
    if (!this._isValidNumber(pressure)) confidence *= 0.8;
    if (!this._isValidNumber(altitude)) confidence *= 0.9;

    return Math.max(confidence, 0.1);
  }

  _calculatePsychrometricConfidence(record) {
    let confidence = 1.0;
    const { temperature, dewpoint, humidity } = record;

    if (!this._isValidNumber(temperature)) confidence *= 0.5;
    if (!this._isValidNumber(dewpoint)) confidence *= 0.6;
    if (!this._isValidNumber(humidity)) confidence *= 0.8;

    return Math.max(confidence, 0.1);
  }

  _calculateRadiationConfidence(record) {
    let confidence = 1.0;
    const { solarRadiation, timestamp, latitude, longitude } = record;

    if (!this._isValidNumber(solarRadiation)) confidence *= 0.3;
    if (!timestamp) confidence *= 0.8;
    if (!latitude || !longitude) confidence *= 0.9;

    return Math.max(confidence, 0.1);
  }

  _calculatePressureConfidence(record) {
    let confidence = 1.0;
    const { pressure, altitude, temperature } = record;

    if (!this._isValidNumber(pressure)) confidence *= 0.5;
    if (!this._isValidNumber(altitude)) confidence *= 0.8;
    if (!this._isValidNumber(temperature)) confidence *= 0.9;

    return Math.max(confidence, 0.1);
  }

  _calculateWindConfidence(record) {
    let confidence = 1.0;
    const { windSpeed, windGust, windDirection } = record;

    if (!this._isValidNumber(windSpeed)) confidence *= 0.7;
    if (!this._isValidNumber(windGust)) confidence *= 0.9;
    if (!this._isValidNumber(windDirection)) confidence *= 0.8;

    return Math.max(confidence, 0.1);
  }

  _calculateEnergyBalanceConfidence(record) {
    let confidence = 1.0;
    const { solarRadiation, netRadiation, temperature } = record;

    if (!this._isValidNumber(solarRadiation)) confidence *= 0.6;
    if (!this._isValidNumber(netRadiation)) confidence *= 0.8;
    if (!this._isValidNumber(temperature)) confidence *= 0.9;

    return Math.max(confidence, 0.1);
  }

  _calculateTemporalConfidence(currentRecord, previousRecord) {
    // Base confidence on data completeness and time interval
    let confidence = 1.0;

    const timeDiff = this._calculateTimeDifference(
      currentRecord.timestamp,
      previousRecord.timestamp
    );

    // Reduce confidence for very large time gaps
    if (timeDiff > 3600) confidence *= 0.8; // > 1 hour
    if (timeDiff > 86400) confidence *= 0.6; // > 1 day

    return Math.max(confidence, 0.1);
  }

  // ==============================================
  // UTILITY METHODS
  // ==============================================

  _hasRequiredFields(record, fields) {
    return fields.every(
      field => record[field] !== undefined && record[field] !== null
    );
  }

  _isValidNumber(value) {
    return typeof value === 'number' && !isNaN(value) && isFinite(value);
  }

  _calculateTimeDifference(timestamp1, timestamp2) {
    const isTimestamp = value =>
      (typeof value === 'string' && value.trim() !== '') ||
      this._isValidNumber(value) ||
      value instanceof Date;
    if (!isTimestamp(timestamp1) || !isTimestamp(timestamp2)) return NaN;
    const date1 = new Date(timestamp1);
    const date2 = new Date(timestamp2);
    return (date1.getTime() - date2.getTime()) / 1000; // signed seconds
  }

  _getDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  _processValidationResults(validations, results) {
    let totalViolations = 0;
    let totalConfidence = 0;
    let validCount = 0;

    validations.forEach((validation, index) => {
      results.validations[validation.category] = validation;
      results.metadata.totalChecks++;

      if (validation.isValid) {
        results.metadata.passedChecks++;
        validCount++;
      } else {
        results.metadata.failedChecks++;
        results.violations.push(...validation.violations);
        totalViolations += validation.violations.length;
      }

      totalConfidence += validation.confidence;
    });

    results.overallValid = totalViolations === 0;
    results.overallConfidence = totalConfidence / validations.length;

    return results;
  }

  _createErrorResult(error) {
    return {
      overallValid: false,
      overallConfidence: 0.0,
      violations: [
        {
          type: 'validation_error',
          message: error.message,
          severity: 'critical',
        },
      ],
      validations: {},
      metadata: {
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: 1,
        timestamp: new Date().toISOString(),
        error: error.message,
      },
    };
  }

  _logError(message, error) {
    if (this.options.enableDebug) {
      weatherLogger.error(`[PhysicsValidationEngine] ${message}`, { error });
    }
  }

  _initializeValidationRules() {
    // Initialize any static validation rules or lookup tables
    return {
      temperatureRanges: {
        extreme: { min: -90, max: 70 },
        typical: { min: -40, max: 50 },
      },
      pressureRanges: {
        extreme: { min: 200, max: 1200 },
        typical: { min: 950, max: 1050 },
      },
      humidityRanges: {
        extreme: { min: 0, max: 100 },
        typical: { min: 10, max: 95 },
      },
    };
  }
}

// Export the PhysicsValidationEngine
module.exports = PhysicsValidationEngine;
