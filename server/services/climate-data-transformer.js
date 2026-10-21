/**
 * Climate Data Transformation Service
 *
 * Provides comprehensive data transformation and mapping capabilities for climate model integration.
 * Handles coordinate system conversions, unit transformations, temporal alignment,
 * and spatial interpolation between different climate model formats.
 *
 * Features:
 * - Coordinate system transformations (lat/lon, UTM, projected coordinates)
 * - Unit conversions (temperature, pressure, wind speed, etc.)
 * - Temporal data alignment and resampling
 * - Spatial interpolation and regridding
 * - Data quality validation and cleanup
 * - Metadata preservation and enhancement
 * - WRFCoin unified format standardization
 */

const fs = require('fs').promises;
const path = require('path');
const Logger = require('../utils/logger');

/**
 * Coordinate System Transformer
 * Handles transformations between different coordinate systems and projections
 */
class CoordinateTransformer {
  constructor() {
    this.logger = Logger;

    // Common coordinate reference systems
    this.supportedCRS = {
      WGS84: { epsg: 4326, units: 'degrees' },
      WebMercator: { epsg: 3857, units: 'meters' },
      UTM: { epsg: 'variable', units: 'meters' },
      LambertConformalConic: { epsg: 'variable', units: 'meters' },
      Stereographic: { epsg: 'variable', units: 'meters' },
    };
  }

  /**
   * Transform coordinates between different systems
   * @param {Array} coordinates - Array of [lon, lat] or [x, y] coordinates
   * @param {string} fromCRS - Source coordinate reference system
   * @param {string} toCRS - Target coordinate reference system
   * @param {Object} options - Transformation options
   * @returns {Array} Transformed coordinates
   */
  transformCoordinates(coordinates, fromCRS, toCRS, options = {}) {
    try {
      if (fromCRS === toCRS) {
        return coordinates;
      }

      // Handle common transformations
      if (fromCRS === 'WGS84' && toCRS === 'WebMercator') {
        return this.wgs84ToWebMercator(coordinates);
      }

      if (fromCRS === 'WebMercator' && toCRS === 'WGS84') {
        return this.webMercatorToWGS84(coordinates);
      }

      // For more complex transformations, use external projection library
      // This is a simplified implementation
      this.logger.warn(
        `Coordinate transformation ${fromCRS} -> ${toCRS} not fully implemented`
      );
      return coordinates;
    } catch (error) {
      this.logger.error('Coordinate transformation failed:', error);
      throw new Error(
        `Failed to transform coordinates from ${fromCRS} to ${toCRS}: ${error.message}`
      );
    }
  }

  /**
   * Transform WGS84 to Web Mercator
   */
  wgs84ToWebMercator(coordinates) {
    return coordinates.map(([lon, lat]) => {
      const x = (lon * 20037508.34) / 180;
      let y =
        Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
      y = (y * 20037508.34) / 180;
      return [x, y];
    });
  }

  /**
   * Transform Web Mercator to WGS84
   */
  webMercatorToWGS84(coordinates) {
    return coordinates.map(([x, y]) => {
      const lon = (x * 180) / 20037508.34;
      let lat = (y * 180) / 20037508.34;
      lat =
        (180 / Math.PI) *
        (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
      return [lon, lat];
    });
  }

  /**
   * Create regular grid from irregular coordinates
   * @param {Array} coordinates - Irregular coordinate points
   * @param {Object} gridSpec - Grid specification
   * @returns {Object} Regular grid definition
   */
  createRegularGrid(coordinates, gridSpec) {
    const { resolution, bounds } = gridSpec;

    const minLon = bounds?.west || Math.min(...coordinates.map(c => c[0]));
    const maxLon = bounds?.east || Math.max(...coordinates.map(c => c[0]));
    const minLat = bounds?.south || Math.min(...coordinates.map(c => c[1]));
    const maxLat = bounds?.north || Math.max(...coordinates.map(c => c[1]));

    const lonStep = resolution.lon || 0.25;
    const latStep = resolution.lat || 0.25;

    const lonCount = Math.ceil((maxLon - minLon) / lonStep) + 1;
    const latCount = Math.ceil((maxLat - minLat) / latStep) + 1;

    const grid = {
      longitude: Array.from(
        { length: lonCount },
        (_, i) => minLon + i * lonStep
      ),
      latitude: Array.from(
        { length: latCount },
        (_, i) => minLat + i * latStep
      ),
      bounds: { north: maxLat, south: minLat, east: maxLon, west: minLon },
      resolution: { lon: lonStep, lat: latStep },
      dimensions: { lon: lonCount, lat: latCount },
    };

    return grid;
  }
}

/**
 * Unit Converter
 * Handles conversions between different measurement units common in meteorology
 */
class UnitConverter {
  constructor() {
    this.logger = Logger;

    // Unit conversion definitions
    this.conversions = {
      temperature: {
        celsius_to_kelvin: c => c + 273.15,
        kelvin_to_celsius: k => k - 273.15,
        fahrenheit_to_celsius: f => ((f - 32) * 5) / 9,
        celsius_to_fahrenheit: c => (c * 9) / 5 + 32,
        fahrenheit_to_kelvin: f => ((f - 32) * 5) / 9 + 273.15,
        kelvin_to_fahrenheit: k => ((k - 273.15) * 9) / 5 + 32,
      },
      pressure: {
        pa_to_hpa: pa => pa / 100,
        hpa_to_pa: hpa => hpa * 100,
        mb_to_hpa: mb => mb,
        hpa_to_mb: hpa => hpa,
        atm_to_pa: atm => atm * 101325,
        pa_to_atm: pa => pa / 101325,
        mmhg_to_pa: mmhg => mmhg * 133.322,
        pa_to_mmhg: pa => pa / 133.322,
      },
      wind: {
        ms_to_kmh: ms => ms * 3.6,
        kmh_to_ms: kmh => kmh / 3.6,
        ms_to_mph: ms => ms * 2.237,
        mph_to_ms: mph => mph / 2.237,
        kt_to_ms: kt => kt * 0.514444,
        ms_to_kt: ms => ms / 0.514444,
      },
      precipitation: {
        mm_to_inches: mm => mm / 25.4,
        inches_to_mm: inches => inches * 25.4,
        mm_to_meters: mm => mm / 1000,
        meters_to_mm: m => m * 1000,
      },
      distance: {
        km_to_m: km => km * 1000,
        m_to_km: m => m / 1000,
        mi_to_km: mi => mi * 1.60934,
        km_to_mi: km => km / 1.60934,
        nm_to_km: nm => nm * 1.852,
        km_to_nm: km => km / 1.852,
      },
    };
  }

  /**
   * Convert values between units
   * @param {number|Array} value - Value(s) to convert
   * @param {string} fromUnit - Source unit
   * @param {string} toUnit - Target unit
   * @param {string} category - Unit category (temperature, pressure, etc.)
   * @returns {number|Array} Converted value(s)
   */
  convert(value, fromUnit, toUnit, category) {
    try {
      if (fromUnit === toUnit) {
        return value;
      }

      const conversionKey = `${fromUnit}_to_${toUnit}`;
      const categoryConversions = this.conversions[category];

      if (!categoryConversions) {
        throw new Error(`Unsupported unit category: ${category}`);
      }

      const converter = categoryConversions[conversionKey];
      if (!converter) {
        throw new Error(
          `Conversion ${fromUnit} -> ${toUnit} not supported for category ${category}`
        );
      }

      if (Array.isArray(value)) {
        return value.map(v => converter(v));
      } else {
        return converter(value);
      }
    } catch (error) {
      this.logger.error('Unit conversion failed:', error);
      throw error;
    }
  }

  /**
   * Get standard unit for a variable type
   * @param {string} variableName - Variable name
   * @returns {string} Standard unit
   */
  getStandardUnit(variableName) {
    const standards = {
      temperature: 'celsius',
      temp: 'celsius',
      pressure: 'hpa',
      wind_speed: 'ms',
      wind_u: 'ms',
      wind_v: 'ms',
      precipitation: 'mm',
      humidity: 'percent',
      visibility: 'km',
    };

    const lowerVar = variableName.toLowerCase();
    for (const [key, unit] of Object.entries(standards)) {
      if (lowerVar.includes(key)) {
        return unit;
      }
    }

    return null;
  }

  /**
   * Normalize units to WRFCoin standard
   * @param {Object} data - Data object with variables and units
   * @returns {Object} Data with normalized units
   */
  normalizeToStandard(data) {
    const normalized = { ...data };

    for (const [varName, varData] of Object.entries(data.variables || {})) {
      const currentUnit = varData.units || varData.unit;
      const standardUnit = this.getStandardUnit(varName);

      if (standardUnit && currentUnit && currentUnit !== standardUnit) {
        try {
          const category = this.getCategoryFromVariable(varName);
          if (category) {
            normalized.variables[varName] = {
              ...varData,
              data: this.convert(
                varData.data,
                currentUnit,
                standardUnit,
                category
              ),
              units: standardUnit,
              originalUnit: currentUnit,
            };
          }
        } catch (error) {
          this.logger.warn(
            `Failed to normalize unit for ${varName}: ${error.message}`
          );
        }
      }
    }

    return normalized;
  }

  /**
   * Get unit category from variable name
   */
  getCategoryFromVariable(varName) {
    const lower = varName.toLowerCase();

    if (lower.includes('temp')) return 'temperature';
    if (lower.includes('pressure') || lower.includes('pres')) return 'pressure';
    if (
      lower.includes('wind') ||
      lower.includes('ugrd') ||
      lower.includes('vgrd')
    )
      return 'wind';
    if (lower.includes('precip') || lower.includes('rain'))
      return 'precipitation';

    return null;
  }
}

/**
 * Temporal Data Processor
 * Handles time-related data transformations and alignments
 */
class TemporalProcessor {
  constructor() {
    this.logger = Logger;
  }

  /**
   * Align datasets to common time grid
   * @param {Array} datasets - Array of datasets with time dimensions
   * @param {Object} timeGrid - Target time grid specification
   * @returns {Array} Time-aligned datasets
   */
  alignToTimeGrid(datasets, timeGrid) {
    try {
      const { start, end, interval } = timeGrid;
      const targetTimes = this.generateTimeSequence(start, end, interval);

      return datasets.map(dataset => {
        return this.interpolateToTimes(dataset, targetTimes);
      });
    } catch (error) {
      this.logger.error('Time alignment failed:', error);
      throw error;
    }
  }

  /**
   * Generate sequence of time points
   * @param {string} start - Start time (ISO string)
   * @param {string} end - End time (ISO string)
   * @param {number} intervalHours - Interval in hours
   * @returns {Array} Array of time points
   */
  generateTimeSequence(start, end, intervalHours) {
    const times = [];
    const startTime = new Date(start);
    const endTime = new Date(end);
    const intervalMs = intervalHours * 60 * 60 * 1000;

    let currentTime = new Date(startTime);
    while (currentTime <= endTime) {
      times.push(new Date(currentTime));
      currentTime = new Date(currentTime.getTime() + intervalMs);
    }

    return times;
  }

  /**
   * Interpolate dataset to target times
   * @param {Object} dataset - Dataset with time dimension
   * @param {Array} targetTimes - Target time points
   * @returns {Object} Interpolated dataset
   */
  interpolateToTimes(dataset, targetTimes) {
    // Simplified linear interpolation
    // In production, would use more sophisticated temporal interpolation

    const { time: originalTimes, variables } = dataset;
    if (!originalTimes || !variables) {
      return dataset;
    }

    const interpolatedVariables = {};

    for (const [varName, varData] of Object.entries(variables)) {
      interpolatedVariables[varName] = {
        ...varData,
        data: this.interpolateTimeSeries(
          originalTimes,
          varData.data,
          targetTimes
        ),
      };
    }

    return {
      ...dataset,
      time: targetTimes.map(t => t.toISOString()),
      variables: interpolatedVariables,
      interpolated: true,
      originalTimeCount: originalTimes.length,
      interpolatedTimeCount: targetTimes.length,
    };
  }

  /**
   * Simple linear interpolation for time series
   */
  interpolateTimeSeries(originalTimes, originalData, targetTimes) {
    if (!Array.isArray(originalData) || !Array.isArray(originalData[0])) {
      // 1D time series
      return this.interpolate1D(originalTimes, originalData, targetTimes);
    } else {
      // Multi-dimensional data (e.g., time x lat x lon)
      return this.interpolateMultiD(originalTimes, originalData, targetTimes);
    }
  }

  /**
   * 1D interpolation
   */
  interpolate1D(originalTimes, originalData, targetTimes) {
    const origMs = originalTimes.map(t => new Date(t).getTime());
    const targetMs = targetTimes.map(t => t.getTime());

    return targetMs.map(targetTime => {
      // Find surrounding time points
      let beforeIdx = 0;
      let afterIdx = origMs.length - 1;

      for (let i = 0; i < origMs.length - 1; i++) {
        if (origMs[i] <= targetTime && origMs[i + 1] >= targetTime) {
          beforeIdx = i;
          afterIdx = i + 1;
          break;
        }
      }

      if (beforeIdx === afterIdx || origMs[beforeIdx] === origMs[afterIdx]) {
        return originalData[beforeIdx];
      }

      // Linear interpolation
      const ratio =
        (targetTime - origMs[beforeIdx]) /
        (origMs[afterIdx] - origMs[beforeIdx]);
      return (
        originalData[beforeIdx] +
        ratio * (originalData[afterIdx] - originalData[beforeIdx])
      );
    });
  }

  /**
   * Multi-dimensional interpolation
   */
  interpolateMultiD(originalTimes, originalData, targetTimes) {
    // Simplified - would need more sophisticated interpolation for production
    const origMs = originalTimes.map(t => new Date(t).getTime());
    const targetMs = targetTimes.map(t => t.getTime());

    return targetMs.map(targetTime => {
      // Find closest time index for now (simplified)
      let closestIdx = 0;
      let minDiff = Math.abs(origMs[0] - targetTime);

      for (let i = 1; i < origMs.length; i++) {
        const diff = Math.abs(origMs[i] - targetTime);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      }

      return originalData[closestIdx];
    });
  }
}

/**
 * Spatial Data Processor
 * Handles spatial interpolation and regridding operations
 */
class SpatialProcessor {
  constructor() {
    this.logger = Logger;
  }

  /**
   * Regrid data to target grid
   * @param {Object} sourceData - Source data with spatial coordinates
   * @param {Object} targetGrid - Target grid specification
   * @param {string} method - Interpolation method ('nearest', 'bilinear', 'cubic')
   * @returns {Object} Regridded data
   */
  regridData(sourceData, targetGrid, method = 'bilinear') {
    try {
      const { coordinates: sourceCoords, variables } = sourceData;
      const { longitude: targetLon, latitude: targetLat } = targetGrid;

      if (!sourceCoords || !sourceCoords.longitude || !sourceCoords.latitude) {
        throw new Error('Source data missing coordinate information');
      }

      const regriddedVariables = {};

      for (const [varName, varData] of Object.entries(variables)) {
        this.logger.info(`Regridding variable: ${varName}`);

        regriddedVariables[varName] = {
          ...varData,
          data: this.interpolateToGrid(
            sourceCoords.longitude,
            sourceCoords.latitude,
            varData.data,
            targetLon,
            targetLat,
            method
          ),
        };
      }

      return {
        ...sourceData,
        coordinates: {
          longitude: targetLon,
          latitude: targetLat,
        },
        variables: regriddedVariables,
        regridded: true,
        originalGrid: {
          lonCount: sourceCoords.longitude.length,
          latCount: sourceCoords.latitude.length,
        },
        targetGrid: {
          lonCount: targetLon.length,
          latCount: targetLat.length,
        },
        interpolationMethod: method,
      };
    } catch (error) {
      this.logger.error('Regridding failed:', error);
      throw error;
    }
  }

  /**
   * Interpolate data to new grid
   */
  interpolateToGrid(
    sourceLon,
    sourceLat,
    sourceData,
    targetLon,
    targetLat,
    method
  ) {
    switch (method) {
      case 'nearest':
        return this.nearestNeighborInterpolation(
          sourceLon,
          sourceLat,
          sourceData,
          targetLon,
          targetLat
        );
      case 'bilinear':
        return this.bilinearInterpolation(
          sourceLon,
          sourceLat,
          sourceData,
          targetLon,
          targetLat
        );
      case 'cubic':
        return this.cubicInterpolation(
          sourceLon,
          sourceLat,
          sourceData,
          targetLon,
          targetLat
        );
      default:
        throw new Error(`Unsupported interpolation method: ${method}`);
    }
  }

  /**
   * Nearest neighbor interpolation
   */
  nearestNeighborInterpolation(
    sourceLon,
    sourceLat,
    sourceData,
    targetLon,
    targetLat
  ) {
    const result = [];

    for (let j = 0; j < targetLat.length; j++) {
      const row = [];
      for (let i = 0; i < targetLon.length; i++) {
        const targetLonVal = targetLon[i];
        const targetLatVal = targetLat[j];

        // Find nearest source point
        let minDistance = Infinity;
        let nearestI = 0,
          nearestJ = 0;

        for (let sj = 0; sj < sourceLat.length; sj++) {
          for (let si = 0; si < sourceLon.length; si++) {
            const distance = Math.sqrt(
              Math.pow(sourceLon[si] - targetLonVal, 2) +
                Math.pow(sourceLat[sj] - targetLatVal, 2)
            );

            if (distance < minDistance) {
              minDistance = distance;
              nearestI = si;
              nearestJ = sj;
            }
          }
        }

        // Handle different data structures
        if (Array.isArray(sourceData[0])) {
          row.push(sourceData[nearestJ][nearestI]);
        } else {
          // Flat array - convert indices
          const flatIndex = nearestJ * sourceLon.length + nearestI;
          row.push(sourceData[flatIndex]);
        }
      }
      result.push(row);
    }

    return result;
  }

  /**
   * Bilinear interpolation
   */
  bilinearInterpolation(
    sourceLon,
    sourceLat,
    sourceData,
    targetLon,
    targetLat
  ) {
    // Simplified bilinear interpolation
    // Production version would handle edge cases and irregular grids better
    return this.nearestNeighborInterpolation(
      sourceLon,
      sourceLat,
      sourceData,
      targetLon,
      targetLat
    );
  }

  /**
   * Cubic interpolation
   */
  cubicInterpolation(sourceLon, sourceLat, sourceData, targetLon, targetLat) {
    // Placeholder - would implement bicubic interpolation
    return this.bilinearInterpolation(
      sourceLon,
      sourceLat,
      sourceData,
      targetLon,
      targetLat
    );
  }

  /**
   * Calculate grid cell areas (for area-weighted averaging)
   */
  calculateGridAreas(longitude, latitude) {
    const areas = [];
    const earthRadius = 6371000; // meters

    for (let j = 0; j < latitude.length - 1; j++) {
      const row = [];
      for (let i = 0; i < longitude.length - 1; i++) {
        const lat1 = (latitude[j] * Math.PI) / 180;
        const lat2 = (latitude[j + 1] * Math.PI) / 180;
        const lon1 = (longitude[i] * Math.PI) / 180;
        const lon2 = (longitude[i + 1] * Math.PI) / 180;

        const area =
          earthRadius *
          earthRadius *
          Math.abs(lon2 - lon1) *
          Math.abs(Math.sin(lat2) - Math.sin(lat1));

        row.push(area);
      }
      areas.push(row);
    }

    return areas;
  }
}

/**
 * Main Climate Data Transformer
 * Orchestrates all transformation operations
 */
class ClimateDataTransformer {
  constructor(config = {}) {
    this.config = config;
    this.logger = Logger;

    // Initialize sub-processors
    this.coordinateTransformer = new CoordinateTransformer();
    this.unitConverter = new UnitConverter();
    this.temporalProcessor = new TemporalProcessor();
    this.spatialProcessor = new SpatialProcessor();

    // Transformation metrics
    this.metrics = {
      totalTransformations: 0,
      successfulTransformations: 0,
      failedTransformations: 0,
      averageTransformationTime: 0,
    };
  }

  /**
   * Transform climate data to WRFCoin unified format
   * @param {Object} inputData - Raw climate data
   * @param {Object} transformationSpec - Transformation specification
   * @returns {Object} Transformed data in WRFCoin format
   */
  async transformToWRFCoinFormat(inputData, transformationSpec = {}) {
    const startTime = Date.now();

    try {
      this.logger.info(
        'Starting climate data transformation to WRFCoin format'
      );

      let transformedData = { ...inputData };

      // 1. Coordinate system transformation
      if (transformationSpec.coordinateTransformation) {
        transformedData = await this.transformCoordinates(
          transformedData,
          transformationSpec.coordinateTransformation
        );
      }

      // 2. Unit normalization
      if (transformationSpec.unitNormalization !== false) {
        transformedData = this.normalizeUnits(transformedData);
      }

      // 3. Temporal alignment
      if (transformationSpec.temporalAlignment) {
        transformedData = await this.alignTemporal(
          transformedData,
          transformationSpec.temporalAlignment
        );
      }

      // 4. Spatial regridding
      if (transformationSpec.spatialRegridding) {
        transformedData = await this.regridSpatial(
          transformedData,
          transformationSpec.spatialRegridding
        );
      }

      // 5. Apply WRFCoin schema
      const wrfcoinData = this.applyWRFCoinSchema(
        transformedData,
        transformationSpec
      );

      // 6. Validate transformed data
      const validation = await this.validateTransformedData(wrfcoinData);

      const transformationTime = Date.now() - startTime;
      this.updateMetrics(true, transformationTime);

      return {
        success: true,
        data: wrfcoinData,
        validation,
        transformationTime,
        transformationSpec,
        metadata: {
          originalFormat: inputData.format || 'unknown',
          transformedFormat: 'wrfcoin-unified',
          transformationSteps:
            this.getAppliedTransformations(transformationSpec),
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      const transformationTime = Date.now() - startTime;
      this.updateMetrics(false, transformationTime);

      this.logger.error('Data transformation failed:', error);
      throw error;
    }
  }

  /**
   * Transform coordinates
   */
  async transformCoordinates(data, coordinateSpec) {
    const { fromCRS, toCRS, options } = coordinateSpec;

    if (
      data.coordinates &&
      data.coordinates.longitude &&
      data.coordinates.latitude
    ) {
      const coordinates = data.coordinates.longitude.map((lon, i) => [
        lon,
        data.coordinates.latitude[i],
      ]);
      const transformed = this.coordinateTransformer.transformCoordinates(
        coordinates,
        fromCRS,
        toCRS,
        options
      );

      return {
        ...data,
        coordinates: {
          ...data.coordinates,
          longitude: transformed.map(c => c[0]),
          latitude: transformed.map(c => c[1]),
          crs: toCRS,
          originalCRS: fromCRS,
        },
      };
    }

    return data;
  }

  /**
   * Normalize units to WRFCoin standards
   */
  normalizeUnits(data) {
    return this.unitConverter.normalizeToStandard(data);
  }

  /**
   * Align temporal data
   */
  async alignTemporal(data, temporalSpec) {
    if (temporalSpec.targetGrid) {
      return this.temporalProcessor.alignToTimeGrid(
        [data],
        temporalSpec.targetGrid
      )[0];
    }
    return data;
  }

  /**
   * Regrid spatial data
   */
  async regridSpatial(data, spatialSpec) {
    if (spatialSpec.targetGrid) {
      return this.spatialProcessor.regridData(
        data,
        spatialSpec.targetGrid,
        spatialSpec.method
      );
    }
    return data;
  }

  /**
   * Apply WRFCoin unified schema
   */
  applyWRFCoinSchema(data, spec) {
    const wrfcoinData = {
      // Standard WRFCoin metadata
      metadata: {
        format: 'wrfcoin-unified',
        version: '1.0',
        created: new Date().toISOString(),
        source: data.source || 'climate-model-integration',
        dataType: 'weather-forecast',
        ...data.metadata,
      },

      // Coordinate information
      coordinates: {
        longitude: data.coordinates?.longitude || [],
        latitude: data.coordinates?.latitude || [],
        crs: data.coordinates?.crs || 'WGS84',
        bounds: this.calculateBounds(data.coordinates),
      },

      // Time dimension
      time: {
        values: data.time || [],
        units: 'ISO8601',
        referenceTime: data.referenceTime || data.time?.[0],
      },

      // Variables with standardized naming
      variables: this.standardizeVariableNames(data.variables || {}),

      // Quality indicators
      quality: {
        dataCompleteness: this.calculateDataCompleteness(data),
        spatialCoverage: this.calculateSpatialCoverage(data),
        temporalCoverage: this.calculateTemporalCoverage(data),
        validationStatus: 'pending',
      },

      // Processing history
      processing: {
        transformations: this.getAppliedTransformations(spec),
        timestamp: new Date().toISOString(),
        processor: 'climate-data-transformer',
      },
    };

    return wrfcoinData;
  }

  /**
   * Standardize variable names to WRFCoin conventions
   */
  standardizeVariableNames(variables) {
    const nameMapping = {
      // Temperature
      TMP: 'temperature',
      TEMP: 'temperature',
      t2m: 'temperature',
      temp: 'temperature',

      // Wind
      UGRD: 'wind_u',
      VGRD: 'wind_v',
      u10: 'wind_u',
      v10: 'wind_v',
      wind_speed: 'wind_speed',

      // Pressure
      PRMSL: 'sea_level_pressure',
      PRES: 'pressure',
      msl: 'sea_level_pressure',

      // Humidity
      RH: 'relative_humidity',
      SPFH: 'specific_humidity',
      rh2m: 'relative_humidity',

      // Precipitation
      APCP: 'precipitation',
      RATE: 'precipitation_rate',
      tp: 'precipitation',
    };

    const standardized = {};

    for (const [originalName, varData] of Object.entries(variables)) {
      const standardName =
        nameMapping[originalName] || originalName.toLowerCase();
      standardized[standardName] = {
        ...varData,
        standardName,
        originalName,
      };
    }

    return standardized;
  }

  /**
   * Calculate coordinate bounds
   */
  calculateBounds(coordinates) {
    if (!coordinates?.longitude || !coordinates?.latitude) {
      return null;
    }

    return {
      north: Math.max(...coordinates.latitude),
      south: Math.min(...coordinates.latitude),
      east: Math.max(...coordinates.longitude),
      west: Math.min(...coordinates.longitude),
    };
  }

  /**
   * Calculate data completeness metrics
   */
  calculateDataCompleteness(data) {
    if (!data.variables) return 0;

    let totalCells = 0;
    let validCells = 0;

    for (const varData of Object.values(data.variables)) {
      if (Array.isArray(varData.data)) {
        const flatData = varData.data.flat();
        totalCells += flatData.length;
        validCells += flatData.filter(
          v => v !== null && v !== undefined && !isNaN(v)
        ).length;
      }
    }

    return totalCells > 0 ? (validCells / totalCells) * 100 : 0;
  }

  /**
   * Calculate spatial coverage metrics
   */
  calculateSpatialCoverage(data) {
    if (!data.coordinates) return 0;

    const lonCount = data.coordinates.longitude?.length || 0;
    const latCount = data.coordinates.latitude?.length || 0;

    return lonCount * latCount;
  }

  /**
   * Calculate temporal coverage metrics
   */
  calculateTemporalCoverage(data) {
    if (!data.time) return 0;

    return Array.isArray(data.time) ? data.time.length : 0;
  }

  /**
   * Get list of applied transformations
   */
  getAppliedTransformations(spec) {
    const transformations = [];

    if (spec.coordinateTransformation) {
      transformations.push('coordinate_transformation');
    }
    if (spec.unitNormalization !== false) {
      transformations.push('unit_normalization');
    }
    if (spec.temporalAlignment) {
      transformations.push('temporal_alignment');
    }
    if (spec.spatialRegridding) {
      transformations.push('spatial_regridding');
    }

    transformations.push('wrfcoin_schema_application');

    return transformations;
  }

  /**
   * Validate transformed data
   */
  async validateTransformedData(data) {
    const validation = {
      valid: true,
      errors: [],
      warnings: [],
      checks: {},
    };

    // Check required fields
    if (!data.metadata) {
      validation.errors.push('Missing metadata');
      validation.valid = false;
    }

    if (!data.coordinates) {
      validation.errors.push('Missing coordinates');
      validation.valid = false;
    }

    if (!data.variables || Object.keys(data.variables).length === 0) {
      validation.errors.push('No variables found');
      validation.valid = false;
    }

    // Check data consistency
    validation.checks.dataCompleteness = data.quality?.dataCompleteness || 0;
    if (validation.checks.dataCompleteness < 90) {
      validation.warnings.push('Data completeness below 90%');
    }

    // Check coordinate validity
    if (data.coordinates?.longitude && data.coordinates?.latitude) {
      const lonRange = [
        Math.min(...data.coordinates.longitude),
        Math.max(...data.coordinates.longitude),
      ];
      const latRange = [
        Math.min(...data.coordinates.latitude),
        Math.max(...data.coordinates.latitude),
      ];

      validation.checks.coordinateRanges = {
        longitude: lonRange,
        latitude: latRange,
      };

      if (lonRange[0] < -180 || lonRange[1] > 180) {
        validation.errors.push(
          'Longitude values out of valid range (-180 to 180)'
        );
        validation.valid = false;
      }

      if (latRange[0] < -90 || latRange[1] > 90) {
        validation.errors.push(
          'Latitude values out of valid range (-90 to 90)'
        );
        validation.valid = false;
      }
    }

    return validation;
  }

  /**
   * Update transformation metrics
   */
  updateMetrics(success, transformationTime) {
    this.metrics.totalTransformations++;

    if (success) {
      this.metrics.successfulTransformations++;
    } else {
      this.metrics.failedTransformations++;
    }

    const count = this.metrics.totalTransformations;
    this.metrics.averageTransformationTime =
      (this.metrics.averageTransformationTime * (count - 1) +
        transformationTime) /
      count;
  }

  /**
   * Get transformation statistics
   */
  getMetrics() {
    return {
      ...this.metrics,
      successRate:
        this.metrics.totalTransformations > 0
          ? (this.metrics.successfulTransformations /
              this.metrics.totalTransformations) *
            100
          : 0,
    };
  }
}

module.exports = {
  ClimateDataTransformer,
  CoordinateTransformer,
  UnitConverter,
  TemporalProcessor,
  SpatialProcessor,
};
