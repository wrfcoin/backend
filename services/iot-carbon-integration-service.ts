/**
 * IoT Carbon Integration Service
 * Processes sensor data from weather stations and calculates carbon credits
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

// Sensor Types
export enum SensorType {
  TEMPERATURE = 'TEMPERATURE',
  HUMIDITY = 'HUMIDITY',
  PRESSURE = 'PRESSURE',
  CO2 = 'CO2',
  PM25 = 'PM25', // Particulate Matter 2.5
  PM10 = 'PM10', // Particulate Matter 10
  WIND_SPEED = 'WIND_SPEED',
  WIND_DIRECTION = 'WIND_DIRECTION',
  RAINFALL = 'RAINFALL',
  UV_INDEX = 'UV_INDEX',
  SOLAR_RADIATION = 'SOLAR_RADIATION',
}

// Quality Tier for Carbon Credits
export enum QualityTier {
  PREMIUM = 1, // Highest quality data
  HIGH = 2,
  STANDARD = 3,
  BASIC = 4,
}

// Sensor Reading Structure
export interface SensorReading {
  stationId: string;
  sensorType: SensorType;
  value: number;
  unit: string;
  timestamp: Date;
  accuracy?: number; // Sensor accuracy percentage
  calibrationDate?: Date;
  metadata?: {
    firmwareVersion?: string;
    batteryLevel?: number;
    signalStrength?: number;
  };
}

// Validated Reading
export interface ValidatedReading extends SensorReading {
  isValid: boolean;
  qualityScore: number;
  anomalyFlags: string[];
  adjustedValue?: number;
}

// Station Configuration
export interface WeatherStationConfig {
  stationId: string;
  ownerId: string;
  walletAddress: string;
  location: {
    latitude: number;
    longitude: number;
    elevation: number; // meters
    timezone: string;
  };
  sensors: Array<{
    type: SensorType;
    model: string;
    accuracy: number;
    calibrationDate: Date;
    calibrationExpiry: Date;
  }>;
  certifications: string[];
  networkType: 'wifi' | 'lorawan' | 'cellular' | 'satellite';
  lastHeartbeat?: Date;
  status: 'active' | 'inactive' | 'maintenance';
}

// Carbon Calculation Result
export interface CarbonCalculation {
  stationId: string;
  periodStart: Date;
  periodEnd: Date;
  dataPoints: number;
  qualityTier: QualityTier;
  qualityScore: number;
  carbonCreditsEarned: bigint; // In smallest unit (18 decimals)
  carbonMetrics: {
    avgTemperature: number;
    avgHumidity: number;
    avgPressure: number;
    avgCO2?: number;
    avgAirQualityIndex?: number;
    dataCompleteness: number; // 0-100%
    measurementAccuracy: number; // Average sensor accuracy
  };
  breakdown: {
    dataCollectionCredits: bigint;
    dataQualityBonus: bigint;
    networkContribution: bigint;
    certificationBonus: bigint;
  };
  verificationHash: string;
}

// Validation Rules
interface ValidationRule {
  min: number;
  max: number;
  maxDelta: number; // Max change per reading
  unit: string;
}

const VALIDATION_RULES: Record<SensorType, ValidationRule> = {
  [SensorType.TEMPERATURE]: { min: -89.2, max: 70.7, maxDelta: 10, unit: '°C' },
  [SensorType.HUMIDITY]: { min: 0, max: 100, maxDelta: 30, unit: '%' },
  [SensorType.PRESSURE]: { min: 870, max: 1084, maxDelta: 20, unit: 'hPa' },
  [SensorType.CO2]: { min: 200, max: 5000, maxDelta: 500, unit: 'ppm' },
  [SensorType.PM25]: { min: 0, max: 1000, maxDelta: 200, unit: 'µg/m³' },
  [SensorType.PM10]: { min: 0, max: 2000, maxDelta: 400, unit: 'µg/m³' },
  [SensorType.WIND_SPEED]: { min: 0, max: 150, maxDelta: 30, unit: 'm/s' },
  [SensorType.WIND_DIRECTION]: { min: 0, max: 360, maxDelta: 180, unit: '°' },
  [SensorType.RAINFALL]: { min: 0, max: 500, maxDelta: 100, unit: 'mm' },
  [SensorType.UV_INDEX]: { min: 0, max: 15, maxDelta: 5, unit: '' },
  [SensorType.SOLAR_RADIATION]: { min: 0, max: 1500, maxDelta: 500, unit: 'W/m²' },
};

// Credit calculation constants
const CREDITS_PER_VALID_READING = 100000000000000n; // 0.0001 WRF
const QUALITY_MULTIPLIER = {
  [QualityTier.PREMIUM]: 2.0,
  [QualityTier.HIGH]: 1.5,
  [QualityTier.STANDARD]: 1.0,
  [QualityTier.BASIC]: 0.75,
};
const NETWORK_CONTRIBUTION_RATE = 50000000000000n; // 0.00005 WRF per contribution
const CERTIFICATION_BONUS = {
  'ISO-17025': 500000000000000n, // 0.0005 WRF
  'WMO-CERTIFIED': 300000000000000n, // 0.0003 WRF
  'NOAA-PARTNER': 400000000000000n, // 0.0004 WRF
};

/**
 * IoT Carbon Integration Service
 */
export class IoTCarbonIntegrationService extends EventEmitter {
  /** #977: cleanup timer handle — previously discarded, so unclearable. */
  private cleanupTimer?: ReturnType<typeof setInterval>;

  // Station registry
  private stations: Map<string, WeatherStationConfig> = new Map();

  // Recent readings for validation
  private recentReadings: Map<string, ValidatedReading[]> = new Map();

  // Pending credits
  private pendingCredits: Map<string, CarbonCalculation[]> = new Map();

  constructor() {
    super();
    this.startCleanupTask();
  }

  /**
   * Register a new weather station
   */
  async registerStation(config: WeatherStationConfig): Promise<{ success: boolean; stationId: string }> {
    // Validate location
    if (!this.isValidLocation(config.location)) {
      throw new Error('Invalid station location');
    }

    // Validate wallet address
    if (!ethers.isAddress(config.walletAddress)) {
      throw new Error('Invalid wallet address');
    }

    // Validate sensors
    for (const sensor of config.sensors) {
      if (!Object.values(SensorType).includes(sensor.type)) {
        throw new Error(`Invalid sensor type: ${sensor.type}`);
      }
    }

    // Store station configuration
    this.stations.set(config.stationId, {
      ...config,
      status: 'active',
      lastHeartbeat: new Date(),
    });

    this.recentReadings.set(config.stationId, []);

    logger.info('Weather station registered', {
      stationId: config.stationId,
      location: config.location,
      sensorCount: config.sensors.length,
    });

    this.emit('stationRegistered', config);

    return {
      success: true,
      stationId: config.stationId,
    };
  }

  /**
   * Process incoming sensor data
   */
  async processSensorData(reading: SensorReading): Promise<ValidatedReading> {
    const station = this.stations.get(reading.stationId);
    if (!station) {
      throw new Error('Station not registered');
    }

    // Update heartbeat
    station.lastHeartbeat = new Date();
    this.stations.set(reading.stationId, station);

    // Validate the reading
    const validated = this.validateSensorReading(reading, station);

    // Store validated reading
    const readings = this.recentReadings.get(reading.stationId) || [];
    readings.push(validated);

    // Keep only last 24 hours of readings
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const filteredReadings = readings.filter(r => r.timestamp > cutoff);
    this.recentReadings.set(reading.stationId, filteredReadings);

    if (validated.isValid) {
      this.emit('validReading', validated);
    } else {
      this.emit('invalidReading', validated);
    }

    return validated;
  }

  /**
   * Validate a sensor reading
   */
  private validateSensorReading(reading: SensorReading, station: WeatherStationConfig): ValidatedReading {
    const anomalyFlags: string[] = [];
    let qualityScore = 100;
    let isValid = true;
    let adjustedValue = reading.value;

    const rule = VALIDATION_RULES[reading.sensorType];
    if (!rule) {
      return {
        ...reading,
        isValid: false,
        qualityScore: 0,
        anomalyFlags: ['UNKNOWN_SENSOR_TYPE'],
      };
    }

    // Range validation
    if (reading.value < rule.min || reading.value > rule.max) {
      anomalyFlags.push('OUT_OF_RANGE');
      qualityScore -= 50;
      isValid = false;
    }

    // Check against recent readings for sudden changes
    const recentReadings = this.recentReadings.get(reading.stationId) || [];
    const sameTypeReadings = recentReadings
      .filter(r => r.sensorType === reading.sensorType)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (sameTypeReadings.length > 0) {
      const lastReading = sameTypeReadings[0];
      const delta = Math.abs(reading.value - lastReading.value);
      const timeDiff = (reading.timestamp.getTime() - lastReading.timestamp.getTime()) / 1000 / 60; // minutes

      // Adjust max delta based on time since last reading
      const adjustedMaxDelta = rule.maxDelta * Math.max(1, timeDiff / 10);

      if (delta > adjustedMaxDelta) {
        anomalyFlags.push('SUDDEN_CHANGE');
        qualityScore -= 25;
      }
    }

    // Check sensor calibration
    const sensor = station.sensors.find(s => s.type === reading.sensorType);
    if (sensor) {
      if (new Date() > sensor.calibrationExpiry) {
        anomalyFlags.push('CALIBRATION_EXPIRED');
        qualityScore -= 20;
      }

      // Apply accuracy penalty
      if (sensor.accuracy < 90) {
        qualityScore -= Math.round((100 - sensor.accuracy) / 2);
      }
    }

    // Check battery and signal if available
    if (reading.metadata?.batteryLevel !== undefined && reading.metadata.batteryLevel < 20) {
      anomalyFlags.push('LOW_BATTERY');
      qualityScore -= 10;
    }
    if (reading.metadata?.signalStrength !== undefined && reading.metadata.signalStrength < -85) {
      anomalyFlags.push('WEAK_SIGNAL');
      qualityScore -= 5;
    }

    // Physics-based validation for related sensors
    const physicsResult = this.validatePhysicsConsistency(reading, sameTypeReadings, station);
    if (!physicsResult.consistent) {
      anomalyFlags.push(...physicsResult.flags);
      qualityScore -= physicsResult.penalty;
    }

    // Ensure quality score is within bounds
    qualityScore = Math.max(0, Math.min(100, qualityScore));

    return {
      ...reading,
      isValid: isValid && qualityScore >= 50,
      qualityScore,
      anomalyFlags,
      adjustedValue: adjustedValue !== reading.value ? adjustedValue : undefined,
    };
  }

  /**
   * Physics-based validation for sensor consistency
   */
  private validatePhysicsConsistency(
    reading: SensorReading,
    recentReadings: ValidatedReading[],
    station: WeatherStationConfig
  ): { consistent: boolean; flags: string[]; penalty: number } {
    const flags: string[] = [];
    let penalty = 0;

    // Temperature-humidity relationship at elevation
    if (reading.sensorType === SensorType.TEMPERATURE) {
      const humidityReadings = recentReadings.filter(r => r.sensorType === SensorType.HUMIDITY);
      if (humidityReadings.length > 0) {
        const avgHumidity = humidityReadings.reduce((sum, r) => sum + r.value, 0) / humidityReadings.length;

        // Very high humidity with extreme temperatures is rare
        if ((reading.value > 45 || reading.value < -30) && avgHumidity > 95) {
          flags.push('PHYSICS_INCONSISTENCY');
          penalty += 15;
        }
      }
    }

    // Pressure-elevation validation
    if (reading.sensorType === SensorType.PRESSURE) {
      const expectedPressure = 1013.25 * Math.pow(
        1 - (0.0065 * station.location.elevation) / 288.15,
        5.255
      );
      const deviation = Math.abs(reading.value - expectedPressure);
      if (deviation > 50) {
        flags.push('PRESSURE_ELEVATION_MISMATCH');
        penalty += 10;
      }
    }

    // Wind speed and direction consistency
    if (reading.sensorType === SensorType.WIND_SPEED && reading.value === 0) {
      // If wind speed is 0, direction should be stable
      const directionReadings = recentReadings.filter(r => r.sensorType === SensorType.WIND_DIRECTION);
      if (directionReadings.length >= 3) {
        const directions = directionReadings.slice(-3).map(r => r.value);
        const variance = this.calculateVariance(directions);
        if (variance > 100) {
          flags.push('WIND_INCONSISTENCY');
          penalty += 10;
        }
      }
    }

    return {
      consistent: flags.length === 0,
      flags,
      penalty,
    };
  }

  /**
   * Calculate carbon credits for a station over a period
   */
  async calculateCarbonCredits(
    stationId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<CarbonCalculation> {
    const station = this.stations.get(stationId);
    if (!station) {
      throw new Error('Station not found');
    }

    const readings = this.recentReadings.get(stationId) || [];
    const periodReadings = readings.filter(
      r => r.timestamp >= periodStart && r.timestamp <= periodEnd && r.isValid
    );

    if (periodReadings.length === 0) {
      throw new Error('No valid readings in period');
    }

    // Calculate quality metrics
    const avgQualityScore = periodReadings.reduce((sum, r) => sum + r.qualityScore, 0) / periodReadings.length;
    const qualityTier = this.determineQualityTier(avgQualityScore, station);

    // Calculate metrics by sensor type
    const metrics = this.calculateMetrics(periodReadings);

    // Calculate data completeness
    const expectedReadings = this.calculateExpectedReadings(periodStart, periodEnd, station);
    const dataCompleteness = Math.min(100, (periodReadings.length / expectedReadings) * 100);

    // Calculate credits
    const dataCollectionCredits = BigInt(periodReadings.length) * CREDITS_PER_VALID_READING;
    const qualityMultiplier = QUALITY_MULTIPLIER[qualityTier];
    const dataQualityBonus = BigInt(Math.floor(Number(dataCollectionCredits) * (qualityMultiplier - 1)));

    // Network contribution based on data sharing
    const networkContribution = NETWORK_CONTRIBUTION_RATE * BigInt(Math.floor(dataCompleteness));

    // Certification bonuses
    let certificationBonus = 0n;
    for (const cert of station.certifications) {
      const bonus = CERTIFICATION_BONUS[cert as keyof typeof CERTIFICATION_BONUS];
      if (bonus) {
        certificationBonus += bonus;
      }
    }

    const totalCredits = dataCollectionCredits + dataQualityBonus + networkContribution + certificationBonus;

    // Create verification hash
    const verificationData = JSON.stringify({
      stationId,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      readingCount: periodReadings.length,
      avgQualityScore,
      totalCredits: totalCredits.toString(),
    });
    const verificationHash = ethers.keccak256(ethers.toUtf8Bytes(verificationData));

    const calculation: CarbonCalculation = {
      stationId,
      periodStart,
      periodEnd,
      dataPoints: periodReadings.length,
      qualityTier,
      qualityScore: avgQualityScore,
      carbonCreditsEarned: totalCredits,
      carbonMetrics: {
        ...metrics,
        dataCompleteness,
        measurementAccuracy: this.calculateAverageAccuracy(station),
      },
      breakdown: {
        dataCollectionCredits,
        dataQualityBonus,
        networkContribution,
        certificationBonus,
      },
      verificationHash,
    };

    // Store pending credits
    const pending = this.pendingCredits.get(stationId) || [];
    pending.push(calculation);
    this.pendingCredits.set(stationId, pending);

    this.emit('creditsCalculated', calculation);

    logger.info('Carbon credits calculated', {
      stationId,
      credits: totalCredits.toString(),
      qualityTier,
      dataPoints: periodReadings.length,
    });

    return calculation;
  }

  /**
   * Determine quality tier based on score and station status
   */
  private determineQualityTier(avgQualityScore: number, station: WeatherStationConfig): QualityTier {
    // Check for expired calibrations
    const hasExpiredCalibration = station.sensors.some(
      s => new Date() > s.calibrationExpiry
    );
    if (hasExpiredCalibration) {
      return avgQualityScore >= 80 ? QualityTier.STANDARD : QualityTier.BASIC;
    }

    // Check certifications
    const hasPremiumCerts = station.certifications.some(
      c => ['ISO-17025', 'WMO-CERTIFIED'].includes(c)
    );

    if (avgQualityScore >= 95 && hasPremiumCerts) {
      return QualityTier.PREMIUM;
    }
    if (avgQualityScore >= 85) {
      return QualityTier.HIGH;
    }
    if (avgQualityScore >= 70) {
      return QualityTier.STANDARD;
    }
    return QualityTier.BASIC;
  }

  /**
   * Calculate aggregated metrics from readings
   */
  private calculateMetrics(readings: ValidatedReading[]): {
    avgTemperature: number;
    avgHumidity: number;
    avgPressure: number;
    avgCO2?: number;
    avgAirQualityIndex?: number;
  } {
    const byType: Record<string, number[]> = {};

    for (const reading of readings) {
      if (!byType[reading.sensorType]) {
        byType[reading.sensorType] = [];
      }
      byType[reading.sensorType].push(reading.adjustedValue ?? reading.value);
    }

    const avg = (arr: number[] | undefined) =>
      arr && arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    // Calculate Air Quality Index from PM2.5 and PM10
    let avgAirQualityIndex: number | undefined;
    if (byType[SensorType.PM25] || byType[SensorType.PM10]) {
      const pm25 = avg(byType[SensorType.PM25]) || 0;
      const pm10 = avg(byType[SensorType.PM10]) || 0;
      avgAirQualityIndex = this.calculateAQI(pm25, pm10);
    }

    return {
      avgTemperature: avg(byType[SensorType.TEMPERATURE]),
      avgHumidity: avg(byType[SensorType.HUMIDITY]),
      avgPressure: avg(byType[SensorType.PRESSURE]),
      avgCO2: byType[SensorType.CO2] ? avg(byType[SensorType.CO2]) : undefined,
      avgAirQualityIndex,
    };
  }

  /**
   * Calculate Air Quality Index from PM2.5 and PM10
   */
  private calculateAQI(pm25: number, pm10: number): number {
    // Simplified AQI calculation based on US EPA standards
    const pm25AQI = this.pmToAQI(pm25, [
      { breakpoint: 12, aqi: 50 },
      { breakpoint: 35.4, aqi: 100 },
      { breakpoint: 55.4, aqi: 150 },
      { breakpoint: 150.4, aqi: 200 },
      { breakpoint: 250.4, aqi: 300 },
      { breakpoint: 500, aqi: 500 },
    ]);

    const pm10AQI = this.pmToAQI(pm10, [
      { breakpoint: 54, aqi: 50 },
      { breakpoint: 154, aqi: 100 },
      { breakpoint: 254, aqi: 150 },
      { breakpoint: 354, aqi: 200 },
      { breakpoint: 424, aqi: 300 },
      { breakpoint: 604, aqi: 500 },
    ]);

    return Math.max(pm25AQI, pm10AQI);
  }

  /**
   * Convert PM concentration to AQI
   */
  private pmToAQI(
    concentration: number,
    breakpoints: Array<{ breakpoint: number; aqi: number }>
  ): number {
    for (let i = 0; i < breakpoints.length; i++) {
      if (concentration <= breakpoints[i].breakpoint) {
        const prevBreakpoint = i > 0 ? breakpoints[i - 1] : { breakpoint: 0, aqi: 0 };
        const aqiRange = breakpoints[i].aqi - prevBreakpoint.aqi;
        const concRange = breakpoints[i].breakpoint - prevBreakpoint.breakpoint;
        const concOffset = concentration - prevBreakpoint.breakpoint;
        return prevBreakpoint.aqi + (aqiRange * concOffset) / concRange;
      }
    }
    return 500; // Max AQI
  }

  /**
   * Calculate expected readings for a period
   */
  private calculateExpectedReadings(
    start: Date,
    end: Date,
    station: WeatherStationConfig
  ): number {
    const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    const readingsPerHour = 6; // Expect reading every 10 minutes
    return Math.floor(hours * readingsPerHour * station.sensors.length);
  }

  /**
   * Calculate average sensor accuracy for station
   */
  private calculateAverageAccuracy(station: WeatherStationConfig): number {
    if (station.sensors.length === 0) return 0;
    return station.sensors.reduce((sum, s) => sum + s.accuracy, 0) / station.sensors.length;
  }

  /**
   * Calculate variance of an array
   */
  private calculateVariance(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  }

  /**
   * Validate location coordinates
   */
  private isValidLocation(location: { latitude: number; longitude: number; elevation: number }): boolean {
    return (
      location.latitude >= -90 &&
      location.latitude <= 90 &&
      location.longitude >= -180 &&
      location.longitude <= 180 &&
      location.elevation >= -500 && // Below sea level possible
      location.elevation <= 9000 // Highest point on Earth
    );
  }

  /**
   * Get station status
   */
  getStationStatus(stationId: string): WeatherStationConfig | undefined {
    return this.stations.get(stationId);
  }

  /**
   * Get pending credits for a station
   */
  getPendingCredits(stationId: string): CarbonCalculation[] {
    return this.pendingCredits.get(stationId) || [];
  }

  /**
   * Clear pending credits after distribution
   */
  clearPendingCredits(stationId: string, verificationHash: string): boolean {
    const pending = this.pendingCredits.get(stationId) || [];
    const index = pending.findIndex(c => c.verificationHash === verificationHash);
    if (index !== -1) {
      pending.splice(index, 1);
      this.pendingCredits.set(stationId, pending);
      return true;
    }
    return false;
  }

  /**
   * Cleanup old readings
   */
  private startCleanupTask(): void {
    // #977: stored and unref'd — constructor-started behind a module-scope
    // singleton, so importing this file leaked a 48h-window cleanup timer.
    this.cleanupTimer = setInterval(() => {
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours

      for (const [stationId, readings] of this.recentReadings) {
        const filtered = readings.filter(r => r.timestamp > cutoff);
        this.recentReadings.set(stationId, filtered);
      }
    }, 60 * 60 * 1000); // Run every hour
    this.cleanupTimer.unref();
  }
}

// Singleton instance
export const iotCarbonIntegrationService = new IoTCarbonIntegrationService();
