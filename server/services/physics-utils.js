/**
 * Physics Utilities for Weather Data Validation
 *
 * Provides utility classes and constants for atmospheric physics calculations
 * and validation result management.
 *
 * @author WRFCoin Development Team
 * @version 1.0.0
 */

/**
 * Validation Result Container
 */
class ValidationResult {
  constructor(category) {
    this.category = category;
    this.isValid = true;
    this.confidence = 1.0;
    this.violations = [];
    this.warnings = [];
    this.errors = [];
    this.metadata = {
      timestamp: new Date().toISOString(),
      category: category,
    };
  }

  setValid(valid) {
    this.isValid = valid;
  }

  addViolation(type, message, severity = 'minor') {
    this.violations.push({
      type,
      message,
      severity,
      timestamp: new Date().toISOString(),
    });
    this.isValid = false;
  }

  addWarning(message) {
    this.warnings.push({
      message,
      timestamp: new Date().toISOString(),
    });
  }

  addError(type, message) {
    this.errors.push({
      type,
      message,
      timestamp: new Date().toISOString(),
    });
    this.isValid = false;
  }

  setConfidence(confidence) {
    this.confidence = Math.max(0, Math.min(1, confidence));
  }

  toJSON() {
    return {
      category: this.category,
      isValid: this.isValid,
      confidence: this.confidence,
      violations: this.violations,
      warnings: this.warnings,
      errors: this.errors,
      metadata: this.metadata,
    };
  }
}

/**
 * Physical Constants for Atmospheric Calculations
 */
class PhysicsConstants {
  constructor() {
    // Thermodynamic constants
    this.R_DRY = 287.05; // Specific gas constant for dry air (J/kg/K)
    this.R_VAPOR = 461.5; // Specific gas constant for water vapor (J/kg/K)
    this.CP_DRY = 1005.0; // Specific heat capacity of dry air at constant pressure (J/kg/K)
    this.CV_DRY = 718.0; // Specific heat capacity of dry air at constant volume (J/kg/K)
    this.CP_VAPOR = 1846.0; // Specific heat capacity of water vapor (J/kg/K)

    // Physical constants
    this.G = 9.80665; // Standard gravitational acceleration (m/s²)
    this.STEFAN_BOLTZMANN = 5.670374419e-8; // Stefan-Boltzmann constant (W/m²/K⁴)
    this.SOLAR_CONSTANT = 1367.0; // Solar constant (W/m²)

    // Atmospheric composition
    this.MOLECULAR_WEIGHT_DRY_AIR = 28.9644; // g/mol
    this.MOLECULAR_WEIGHT_WATER = 18.01528; // g/mol

    // Standard atmospheric conditions
    this.STANDARD_PRESSURE = 1013.25; // hPa
    this.STANDARD_TEMPERATURE = 288.15; // K (15°C)
    this.STANDARD_DENSITY = 1.225; // kg/m³

    // Lapse rates
    this.STANDARD_LAPSE_RATE = 0.0065; // K/m
    this.DRY_ADIABATIC_LAPSE_RATE = 0.00976; // K/m
    this.MOIST_ADIABATIC_LAPSE_RATE = 0.006; // K/m (approximate)

    // Conversion factors
    this.KELVIN_OFFSET = 273.15;
    this.HPA_TO_PA = 100.0;
    this.HPA_TO_INHG = 0.02953;
    this.MS_TO_KMH = 3.6;
    this.MS_TO_MPH = 2.237;
    this.M_TO_FT = 3.28084;

    // Magnus formula constants
    this.MAGNUS_A = 17.67;
    this.MAGNUS_B = 243.5; // °C
    this.MAGNUS_C = 6.112; // hPa

    // Radiation constants
    this.EMISSIVITY_EARTH = 0.97; // Earth's surface emissivity
    this.ALBEDO_TYPICAL = 0.3; // Typical surface albedo
  }

  /**
   * Get all constants as object
   */
  getAllConstants() {
    return { ...this };
  }

  /**
   * Convert temperature units
   */
  celsiusToKelvin(celsius) {
    return celsius + this.KELVIN_OFFSET;
  }

  kelvinToCelsius(kelvin) {
    return kelvin - this.KELVIN_OFFSET;
  }

  celsiusToFahrenheit(celsius) {
    return (celsius * 9) / 5 + 32;
  }

  fahrenheitToCelsius(fahrenheit) {
    return ((fahrenheit - 32) * 5) / 9;
  }

  /**
   * Convert pressure units
   */
  hpaToInhg(hpa) {
    return hpa * this.HPA_TO_INHG;
  }

  inhgToHpa(inhg) {
    return inhg / this.HPA_TO_INHG;
  }

  hpaToPa(hpa) {
    return hpa * this.HPA_TO_PA;
  }

  paToHpa(pa) {
    return pa / this.HPA_TO_PA;
  }

  /**
   * Convert wind speed units
   */
  msToKmh(ms) {
    return ms * this.MS_TO_KMH;
  }

  kmhToMs(kmh) {
    return kmh / this.MS_TO_KMH;
  }

  msToMph(ms) {
    return ms * this.MS_TO_MPH;
  }

  mphToMs(mph) {
    return mph / this.MS_TO_MPH;
  }

  /**
   * Convert length units
   */
  mToFt(meters) {
    return meters * this.M_TO_FT;
  }

  ftToM(feet) {
    return feet / this.M_TO_FT;
  }
}

/**
 * Atmospheric Utility Functions
 */
class AtmosphericUtils {
  constructor() {
    this.constants = new PhysicsConstants();
  }

  /**
   * Calculate vapor pressure deficit
   */
  calculateVaporPressureDeficit(temperature, dewpoint) {
    const satVaporPress = this.calculateSaturationVaporPressure(temperature);
    const actVaporPress = this.calculateSaturationVaporPressure(dewpoint);
    return (satVaporPress - actVaporPress) / 1000; // Convert to kPa
  }

  /**
   * Calculate saturation vapor pressure using Magnus formula
   */
  calculateSaturationVaporPressure(temperature) {
    const { MAGNUS_A, MAGNUS_B, MAGNUS_C } = this.constants;
    return (
      MAGNUS_C * Math.exp((MAGNUS_A * temperature) / (temperature + MAGNUS_B))
    );
  }

  /**
   * Calculate mixing ratio
   */
  calculateMixingRatio(dewpoint, pressure) {
    const vaporPressure = this.calculateSaturationVaporPressure(dewpoint);
    const { MOLECULAR_WEIGHT_WATER, MOLECULAR_WEIGHT_DRY_AIR } = this.constants;

    return (
      (MOLECULAR_WEIGHT_WATER / MOLECULAR_WEIGHT_DRY_AIR) *
      (vaporPressure / (pressure - vaporPressure))
    );
  }

  /**
   * Calculate absolute humidity
   */
  calculateAbsoluteHumidity(temperature, dewpoint) {
    const vaporPressure = this.calculateSaturationVaporPressure(dewpoint);
    const tempKelvin = this.constants.celsiusToKelvin(temperature);

    // Using ideal gas law: ρ = (P * M) / (R * T)
    return (
      (vaporPressure * 100 * this.constants.MOLECULAR_WEIGHT_WATER) /
      (this.constants.R_VAPOR * tempKelvin * 1000)
    ); // g/m³
  }

  /**
   * Calculate potential temperature
   */
  calculatePotentialTemperature(temperature, pressure) {
    const tempKelvin = this.constants.celsiusToKelvin(temperature);
    const pressureRatio = this.constants.STANDARD_PRESSURE / pressure;
    const kappa = this.constants.R_DRY / this.constants.CP_DRY;

    return tempKelvin * Math.pow(pressureRatio, kappa);
  }

  /**
   * Calculate equivalent potential temperature
   */
  calculateEquivalentPotentialTemperature(temperature, pressure, dewpoint) {
    const potentialTemp = this.calculatePotentialTemperature(
      temperature,
      pressure
    );
    const mixingRatio = this.calculateMixingRatio(dewpoint, pressure);
    const tempKelvin = this.constants.celsiusToKelvin(temperature);

    // Simplified Bolton formula
    const L = 2.501e6; // Latent heat of vaporization (J/kg)

    return (
      potentialTemp *
      Math.exp((L * mixingRatio) / (this.constants.CP_DRY * tempKelvin))
    );
  }

  /**
   * Calculate density of dry air
   */
  calculateDryAirDensity(temperature, pressure) {
    const tempKelvin = this.constants.celsiusToKelvin(temperature);
    const pressurePa = this.constants.hpaToPa(pressure);

    return pressurePa / (this.constants.R_DRY * tempKelvin);
  }

  /**
   * Calculate virtual temperature
   */
  calculateVirtualTemperature(temperature, pressure, dewpoint) {
    const mixingRatio = this.calculateMixingRatio(dewpoint, pressure);
    const tempKelvin = this.constants.celsiusToKelvin(temperature);

    return tempKelvin * (1 + 0.61 * mixingRatio);
  }

  /**
   * Calculate Bowen ratio
   */
  calculateBowenRatio(temperature, humidity, windSpeed = 2.0) {
    // Simplified Bowen ratio calculation
    // B = sensible heat flux / latent heat flux

    const satVaporPress = this.calculateSaturationVaporPressure(temperature);
    const vaporPressure = (satVaporPress * humidity) / 100;
    const vpd = this.calculateVaporPressureDeficit(
      temperature,
      temperature - 5
    ); // Approximate

    // Simplified estimation
    const psychrometricConstant = 0.66; // kPa/°C
    const delta = this._calculateSlopeVaporPressureCurve(temperature);

    return psychrometricConstant / delta;
  }

  /**
   * Calculate sensible heat flux (simplified)
   */
  calculateSensibleHeatFlux(temperature, windSpeed, surfaceTemperature = null) {
    if (surfaceTemperature == null) {
      surfaceTemperature = temperature + 2; // Assume surface is warmer
    }

    const airDensity = this.calculateDryAirDensity(
      temperature,
      this.constants.STANDARD_PRESSURE
    );
    const tempDifference = surfaceTemperature - temperature;

    // Simplified bulk transfer formula
    const transferCoeff = 0.004 * windSpeed; // Simplified transfer coefficient

    return airDensity * this.constants.CP_DRY * transferCoeff * tempDifference;
  }

  /**
   * Calculate Richardson number (atmospheric stability)
   */
  calculateRichardsonNumber(
    temperature1,
    temperature2,
    windSpeed1,
    windSpeed2,
    height1,
    height2
  ) {
    const tempKelvin = this.constants.celsiusToKelvin(
      (temperature1 + temperature2) / 2
    );
    const deltaT = temperature2 - temperature1;
    const deltaZ = height2 - height1;
    const deltaU = Math.abs(windSpeed2 - windSpeed1);

    if (deltaU === 0 || deltaZ === 0) return 0;

    return (
      ((this.constants.G / tempKelvin) * (deltaT / deltaZ)) /
      Math.pow(deltaU / deltaZ, 2)
    );
  }

  /**
   * Assess static stability
   */
  assessStaticStability(currentRecord, previousRecord) {
    const { temperature: T1, pressure: P1 } = previousRecord;
    const { temperature: T2, pressure: P2 } = currentRecord;

    if (!T1 || !T2 || !P1 || !P2) {
      return { isExtreme: false, description: 'Insufficient data' };
    }

    // Calculate potential temperatures
    const theta1 = this.calculatePotentialTemperature(T1, P1);
    const theta2 = this.calculatePotentialTemperature(T2, P2);

    const deltaTheta = theta2 - theta1;
    const deltaPressure = P2 - P1;

    if (Math.abs(deltaPressure) < 1) {
      return {
        isExtreme: false,
        description: 'Insufficient pressure difference',
      };
    }

    // Stability assessment
    if (deltaTheta > 5 && deltaPressure < -10) {
      return {
        isExtreme: true,
        description: 'Strong stable stratification',
        stability: 'very_stable',
      };
    } else if (deltaTheta < -3 && deltaPressure > 10) {
      return {
        isExtreme: true,
        description: 'Strong unstable stratification',
        stability: 'very_unstable',
      };
    } else if (Math.abs(deltaTheta) < 1) {
      return {
        isExtreme: false,
        description: 'Neutral stability',
        stability: 'neutral',
      };
    }

    return {
      isExtreme: false,
      description: `Moderate stability (ΔΘ=${deltaTheta.toFixed(1)}K)`,
      stability: deltaTheta > 0 ? 'stable' : 'unstable',
    };
  }

  /**
   * Validate radiation-temperature consistency
   */
  validateRadiationTemperatureConsistency(radiation, temperature, timestamp) {
    // Simple consistency check based on empirical relationships

    if (!timestamp) {
      return {
        consistent: true,
        message: 'No timestamp for detailed validation',
      };
    }

    const hour = new Date(timestamp).getHours();
    const isDay = hour >= 6 && hour <= 18;

    // Nighttime checks
    if (!isDay && radiation > 50) {
      return {
        consistent: false,
        message: `High radiation (${radiation} W/m²) during nighttime hours`,
      };
    }

    // Daytime checks
    if (isDay && radiation > 100) {
      // Check if temperature is reasonable for high radiation
      const expectedMinTemp = 5 + (radiation - 100) / 50; // Rough correlation

      if (temperature < expectedMinTemp - 10) {
        return {
          consistent: false,
          message: `Low temperature (${temperature}°C) for high radiation (${radiation} W/m²)`,
        };
      }
    }

    return {
      consistent: true,
      message: 'Temperature-radiation relationship appears consistent',
    };
  }

  /**
   * Calculate pressure at altitude using barometric formula
   */
  calculatePressureAtAltitude(seaLevelPressure, altitude, temperature = null) {
    const temp = temperature
      ? this.constants.celsiusToKelvin(temperature)
      : this.constants.STANDARD_TEMPERATURE;
    const pressurePa = this.constants.hpaToPa(seaLevelPressure);

    // Barometric formula
    const exponent =
      (-this.constants.G * this.constants.MOLECULAR_WEIGHT_DRY_AIR * altitude) /
      (this.constants.R_DRY * 1000 * temp);

    return this.constants.paToHpa(pressurePa * Math.exp(exponent));
  }

  /**
   * Calculate altitude from pressure using inverse barometric formula
   */
  calculateAltitudeFromPressure(
    seaLevelPressure,
    currentPressure,
    temperature = null
  ) {
    const temp = temperature
      ? this.constants.celsiusToKelvin(temperature)
      : this.constants.STANDARD_TEMPERATURE;
    const pressureRatio = currentPressure / seaLevelPressure;

    if (pressureRatio <= 0) return NaN;

    return (
      (-this.constants.R_DRY * 1000 * temp * Math.log(pressureRatio)) /
      (this.constants.G * this.constants.MOLECULAR_WEIGHT_DRY_AIR)
    );
  }

  /**
   * Calculate solar radiation at top of atmosphere
   */
  calculateExtraterrestrialRadiation(dayOfYear, latitude) {
    const solarDeclination =
      23.45 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
    const latRad = (latitude * Math.PI) / 180;
    const declRad = (solarDeclination * Math.PI) / 180;

    const cosZenith =
      Math.sin(latRad) * Math.sin(declRad) +
      Math.cos(latRad) * Math.cos(declRad);

    return this.constants.SOLAR_CONSTANT * Math.max(0, cosZenith);
  }

  // Private helper methods

  _calculateSlopeVaporPressureCurve(temperature) {
    // Slope of saturation vapor pressure curve
    const { MAGNUS_A, MAGNUS_B } = this.constants;
    const es = this.calculateSaturationVaporPressure(temperature);

    return (MAGNUS_A * MAGNUS_B * es) / Math.pow(temperature + MAGNUS_B, 2);
  }
}

/**
 * Meteorological Validation Thresholds
 */
class ValidationThresholds {
  constructor() {
    this.temperature = {
      extreme: { min: -90, max: 70 }, // °C
      typical: { min: -40, max: 50 },
      changeRate: { max: 10 }, // °C/hour
    };

    this.pressure = {
      extreme: { min: 200, max: 1200 }, // hPa
      typical: { min: 870, max: 1085 },
      changeRate: { max: 10 }, // hPa/hour
    };

    this.humidity = {
      extreme: { min: 0, max: 100 }, // %
      typical: { min: 5, max: 95 },
      changeRate: { max: 20 }, // %/hour
    };

    this.wind = {
      speed: { max: 150 }, // m/s
      gust: { maxFactor: 3.0 },
      direction: { min: 0, max: 359 },
    };

    this.radiation = {
      solar: { max: 1400 }, // W/m²
      net: { min: -200, max: 800 },
      clearSkyFactor: { max: 1.2 },
    };

    this.physics = {
      dewpointTolerance: 0.5, // °C
      humidityTolerance: 5.0, // %
      pressureTolerance: 1.0, // hPa
      radiationTolerance: 50.0, // W/m²
    };
  }

  getThreshold(category, parameter, type = 'typical') {
    if (this[category] && this[category][parameter]) {
      return this[category][parameter][type] || this[category][parameter];
    }
    return null;
  }

  isWithinRange(value, category, parameter, type = 'typical') {
    const threshold = this.getThreshold(category, parameter, type);
    if (!threshold) return true;

    if (threshold.min !== undefined && value < threshold.min) return false;
    if (threshold.max !== undefined && value > threshold.max) return false;

    return true;
  }
}

module.exports = {
  ValidationResult,
  PhysicsConstants,
  AtmosphericUtils,
  ValidationThresholds,
};
