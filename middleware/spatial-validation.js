/**
 * Enhanced Spatial Validation System for ISO 19115 Geographic Information Metadata
 * Advanced coordinate validation, geographic data quality assurance, and spatial analysis
 */

const crypto = require('crypto');
const { appLogger } = require('../server/utils/logger');

let _db = null;
let _schema = null;
let _dbInitAttempted = false;

// TTL cache for getSpatialReferencePoints (#408)
let _spatialCache = null;
let _spatialCacheTime = 0;
const SPATIAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getDb() {
  if (!_dbInitAttempted) {
    _dbInitAttempted = true;
    try {
      _db =
        require('../database/connection').db ||
        require('../database/connection').default;
      _schema = require('../shared/schema');
    } catch (err) {
      appLogger.warn('Spatial Validation: database modules unavailable', {
        error: err.message,
      });
    }
  }

  return { db: _db, schema: _schema };
}

class SpatialValidationSystem {
  constructor() {
    this.coordinateSystems = new Map();
    this.geographicBounds = new Map();
    this.validationRules = new Map();
    this.qualityMetrics = new Map();
    this.auditLog = [];

    this.initializeSpatialFramework();
  }

  // Initialize spatial validation framework
  initializeSpatialFramework() {
    // Define supported coordinate reference systems
    this.coordinateSystems.set('WGS84', {
      code: 'EPSG:4326',
      name: 'World Geodetic System 1984',
      bounds: { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 },
      unit: 'degrees',
      precision: 1e-7,
    });

    this.coordinateSystems.set('WEB_MERCATOR', {
      code: 'EPSG:3857',
      name: 'WGS 84 / Pseudo-Mercator',
      bounds: {
        minX: -20037508.34,
        maxX: 20037508.34,
        minY: -20037508.34,
        maxY: 20037508.34,
      },
      unit: 'meters',
      precision: 0.01,
    });

    this.coordinateSystems.set('UTM_ZONE_10N', {
      code: 'EPSG:32610',
      name: 'WGS 84 / UTM Zone 10N',
      bounds: { minX: 166021.44, maxX: 833978.56, minY: 0, maxY: 9329005.18 },
      unit: 'meters',
      precision: 0.01,
    });

    // Initialize geographic validation bounds for weather stations
    this.initializeGeographicBounds();

    // Initialize validation rules
    this.initializeValidationRules();
  }

  // Initialize geographic bounds for different regions
  initializeGeographicBounds() {
    // Climate monitoring regions with specific validation requirements
    this.geographicBounds.set('CONUS', {
      name: 'Continental United States',
      bounds: {
        minLat: 24.396308,
        maxLat: 49.384358,
        minLon: -125.0,
        maxLon: -66.93457,
      },
      stationDensity: { min: 1, max: 50 }, // stations per 100km²
      elevationRange: { min: -86, max: 4421 }, // Death Valley to Mt. Whitney
      qualityThreshold: 95.0,
    });

    this.geographicBounds.set('EUROPE', {
      name: 'European Union',
      bounds: { minLat: 34.8, maxLat: 71.2, minLon: -31.3, maxLon: 69.1 },
      stationDensity: { min: 2, max: 100 },
      elevationRange: { min: 0, max: 4809 }, // Sea level to Mont Blanc
      qualityThreshold: 96.0,
    });

    this.geographicBounds.set('ARCTIC', {
      name: 'Arctic Climate Zone',
      bounds: { minLat: 66.5, maxLat: 90, minLon: -180, maxLon: 180 },
      stationDensity: { min: 0.1, max: 5 },
      elevationRange: { min: 0, max: 4892 }, // Sea level to Gunnbjørn Fjeld
      qualityThreshold: 90.0,
      specialValidation: true,
    });

    this.geographicBounds.set('TROPICAL', {
      name: 'Tropical Climate Zone',
      bounds: { minLat: -23.5, maxLat: 23.5, minLon: -180, maxLon: 180 },
      stationDensity: { min: 0.5, max: 30 },
      elevationRange: { min: 0, max: 5895 }, // Sea level to Kilimanjaro
      qualityThreshold: 92.0,
      hurricaneZone: true,
    });
  }

  // Initialize comprehensive validation rules
  initializeValidationRules() {
    // Coordinate precision validation
    this.validationRules.set('coordinate_precision', {
      name: 'Coordinate Precision Validation',
      description: 'Validates coordinate precision meets ISO 19115 standards',
      minPrecision: 1e-6, // ~0.1 meter accuracy
      maxDecimalPlaces: 7,
      required: true,
    });

    // Spatial consistency validation
    this.validationRules.set('spatial_consistency', {
      name: 'Spatial Consistency Check',
      description:
        'Ensures spatial data consistency across related measurements',
      maxDistanceVariation: 100, // meters
      temporalWindow: 3600, // seconds
      required: true,
    });

    // Elevation validation
    this.validationRules.set('elevation_validation', {
      name: 'Elevation Range Validation',
      description:
        'Validates elevation values against known geographic constraints',
      globalMin: -500, // Below sea level (Dead Sea region)
      globalMax: 9000, // Above Everest
      required: true,
    });

    // Station proximity validation
    this.validationRules.set('station_proximity', {
      name: 'Weather Station Proximity Check',
      description: 'Ensures proper spacing between weather monitoring stations',
      minDistance: 500, // meters minimum separation
      optimalDistance: 5000, // meters optimal separation
      required: false,
    });

    // Data density validation
    this.validationRules.set('data_density', {
      name: 'Geographic Data Density Check',
      description: 'Validates adequate data coverage for geographic regions',
      minCoverage: 0.7, // 70% area coverage
      maxGaps: 50000, // 50km max gap
      required: true,
    });
  }

  // Comprehensive coordinate validation
  async validateCoordinates(coordinates, coordinateSystem = 'WGS84') {
    const validationId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const validation = {
      id: validationId,
      timestamp,
      coordinates,
      coordinateSystem,
      results: {
        valid: true,
        errors: [],
        warnings: [],
        quality: 100,
      },
      metadata: {
        precision: null,
        accuracy: null,
        region: null,
        elevation: null,
      },
    };

    try {
      // Basic coordinate system validation
      const crsValidation = await this.validateCoordinateSystem(
        coordinates,
        coordinateSystem
      );
      if (!crsValidation.valid) {
        validation.results.valid = false;
        validation.results.errors.push(...crsValidation.errors);
      }

      // Precision validation
      const precisionValidation = await this.validatePrecision(coordinates);
      validation.metadata.precision = precisionValidation.precision;
      if (!precisionValidation.valid) {
        validation.results.warnings.push(...precisionValidation.warnings);
        validation.results.quality -= 10;
      }

      // Geographic bounds validation
      const boundsValidation = await this.validateGeographicBounds(coordinates);
      validation.metadata.region = boundsValidation.region;
      if (!boundsValidation.valid) {
        validation.results.valid = false;
        validation.results.errors.push(...boundsValidation.errors);
      }

      // Elevation validation (if provided)
      if (coordinates.elevation !== undefined) {
        const elevationValidation = await this.validateElevation(coordinates);
        validation.metadata.elevation = elevationValidation;
        if (!elevationValidation.valid) {
          validation.results.warnings.push(...elevationValidation.warnings);
          validation.results.quality -= 5;
        }
      }

      // Spatial consistency check
      const consistencyValidation =
        await this.validateSpatialConsistency(coordinates);
      if (!consistencyValidation.valid) {
        validation.results.warnings.push(...consistencyValidation.warnings);
        validation.results.quality -= 15;
      }

      // Calculate overall accuracy estimate
      validation.metadata.accuracy = await this.estimateAccuracy(
        coordinates,
        coordinateSystem
      );

      await this.logSpatialActivity('coordinate_validation', {
        validationId,
        coordinates: `${coordinates.latitude},${coordinates.longitude}`,
        valid: validation.results.valid,
        quality: validation.results.quality,
      });

      return validation;
    } catch (error) {
      validation.results.valid = false;
      validation.results.errors.push(`Validation error: ${error.message}`);

      await this.logSpatialActivity('validation_error', {
        validationId,
        error: error.message,
      });

      return validation;
    }
  }

  // Validate coordinate system compatibility
  async validateCoordinateSystem(coordinates, systemName) {
    const system = this.coordinateSystems.get(systemName);

    if (!system) {
      return {
        valid: false,
        errors: [`Unknown coordinate system: ${systemName}`],
      };
    }

    const errors = [];

    if (systemName === 'WGS84') {
      if (
        coordinates.latitude < system.bounds.minLat ||
        coordinates.latitude > system.bounds.maxLat
      ) {
        errors.push(
          `Latitude ${coordinates.latitude} outside valid range [${system.bounds.minLat}, ${system.bounds.maxLat}]`
        );
      }
      if (
        coordinates.longitude < system.bounds.minLon ||
        coordinates.longitude > system.bounds.maxLon
      ) {
        errors.push(
          `Longitude ${coordinates.longitude} outside valid range [${system.bounds.minLon}, ${system.bounds.maxLon}]`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      system,
    };
  }

  // Validate coordinate precision
  async validatePrecision(coordinates) {
    const rule = this.validationRules.get('coordinate_precision');
    const warnings = [];

    // Calculate decimal places
    const latDecimalPlaces = this.countDecimalPlaces(coordinates.latitude);
    const lonDecimalPlaces = this.countDecimalPlaces(coordinates.longitude);

    const precision = Math.min(
      Math.pow(10, -latDecimalPlaces),
      Math.pow(10, -lonDecimalPlaces)
    );

    let valid = true;

    if (precision > rule.minPrecision) {
      warnings.push(
        `Coordinate precision ${precision} lower than recommended ${rule.minPrecision}`
      );
      valid = false;
    }

    if (
      latDecimalPlaces > rule.maxDecimalPlaces ||
      lonDecimalPlaces > rule.maxDecimalPlaces
    ) {
      warnings.push(
        `Excessive decimal places detected (lat: ${latDecimalPlaces}, lon: ${lonDecimalPlaces})`
      );
    }

    return {
      valid,
      warnings,
      precision,
      decimalPlaces: {
        latitude: latDecimalPlaces,
        longitude: lonDecimalPlaces,
      },
    };
  }

  // Validate geographic bounds
  async validateGeographicBounds(coordinates) {
    const errors = [];
    let region = null;

    // Check against defined geographic regions
    for (const [regionName, regionData] of this.geographicBounds) {
      if (this.isWithinBounds(coordinates, regionData.bounds)) {
        region = regionName;
        break;
      }
    }

    // Special validation for specific regions
    if (region) {
      const regionData = this.geographicBounds.get(region);

      // Elevation range check
      if (coordinates.elevation !== undefined) {
        if (
          coordinates.elevation < regionData.elevationRange.min ||
          coordinates.elevation > regionData.elevationRange.max
        ) {
          errors.push(
            `Elevation ${coordinates.elevation}m outside expected range for ${regionData.name}`
          );
        }
      }

      // Special validations
      if (regionData.specialValidation && region === 'ARCTIC') {
        const arcticValidation =
          await this.validateArcticConditions(coordinates);
        if (!arcticValidation.valid) {
          errors.push(...arcticValidation.errors);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      region,
      regionData: region ? this.geographicBounds.get(region) : null,
    };
  }

  // Validate elevation data
  async validateElevation(coordinates) {
    const rule = this.validationRules.get('elevation_validation');
    const warnings = [];
    let valid = true;

    if (
      coordinates.elevation < rule.globalMin ||
      coordinates.elevation > rule.globalMax
    ) {
      warnings.push(
        `Elevation ${coordinates.elevation}m outside global range [${rule.globalMin}, ${rule.globalMax}]`
      );
      valid = false;
    }

    // Cross-reference with persisted spatial observations when available.
    const estimatedElevation = await this.estimateElevationFromDEM(coordinates);
    const elevationDifference = Math.abs(
      coordinates.elevation - estimatedElevation
    );

    if (elevationDifference > 100) {
      // 100m tolerance
      warnings.push(
        `Elevation ${coordinates.elevation}m differs significantly from DEM estimate ${estimatedElevation}m`
      );
      valid = false;
    }

    return {
      valid,
      warnings,
      provided: coordinates.elevation,
      estimated: estimatedElevation,
      difference: elevationDifference,
    };
  }

  // Validate spatial consistency
  async validateSpatialConsistency(coordinates) {
    const rule = this.validationRules.get('spatial_consistency');
    const warnings = [];

    // Check for coordinate clustering (potential duplicate stations)
    const nearbyCoordinates = await this.findNearbyCoordinates(
      coordinates,
      rule.maxDistanceVariation
    );

    if (nearbyCoordinates.length > 5) {
      warnings.push(
        `High density of coordinates detected (${nearbyCoordinates.length} within ${rule.maxDistanceVariation}m)`
      );
    }

    // Check for spatial outliers
    const isOutlier = await this.detectSpatialOutlier(coordinates);
    if (isOutlier) {
      warnings.push('Coordinate appears to be a spatial outlier');
    }

    return {
      valid: warnings.length === 0,
      warnings,
      nearbyCount: nearbyCoordinates.length,
      isOutlier,
    };
  }

  // Comprehensive spatial data quality assessment
  async assessSpatialDataQuality(dataSet) {
    const assessmentId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const assessment = {
      id: assessmentId,
      timestamp,
      dataSet: {
        totalPoints: dataSet.length,
        coverage: null,
        density: null,
        quality: null,
      },
      metrics: {
        precision: { average: 0, minimum: 0, maximum: 0 },
        accuracy: { average: 0, estimated: true },
        completeness: 0,
        consistency: 0,
        coverage: 0,
      },
      issues: {
        errors: [],
        warnings: [],
        recommendations: [],
      },
      compliance: {
        iso19115: false,
        score: 0,
      },
    };

    try {
      // Validate coordinates concurrently in batches
      const BATCH_SIZE = 50;
      const validations = [];
      for (let i = 0; i < dataSet.length; i += BATCH_SIZE) {
        const batch = dataSet.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(coordinates => this.validateCoordinates(coordinates))
        );
        validations.push(...batchResults);
      }

      // Calculate precision metrics
      const precisions = validations
        .map(v => v.metadata.precision)
        .filter(p => p !== null);
      assessment.metrics.precision = {
        average: precisions.reduce((a, b) => a + b, 0) / precisions.length,
        minimum: Math.min(...precisions),
        maximum: Math.max(...precisions),
      };

      // Calculate accuracy metrics
      const accuracies = validations
        .map(v => v.metadata.accuracy)
        .filter(a => a !== null);
      assessment.metrics.accuracy = {
        average: accuracies.reduce((a, b) => a + b, 0) / accuracies.length,
        estimated: true,
      };

      // Calculate completeness
      const validCoordinates = validations.filter(v => v.results.valid).length;
      assessment.metrics.completeness =
        (validCoordinates / validations.length) * 100;

      // Calculate consistency
      const qualityScores = validations.map(v => v.results.quality);
      assessment.metrics.consistency =
        qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;

      // Calculate coverage
      assessment.metrics.coverage =
        await this.calculateSpatialCoverage(dataSet);

      // Aggregate issues
      validations.forEach(v => {
        assessment.issues.errors.push(...v.results.errors);
        assessment.issues.warnings.push(...v.results.warnings);
      });

      // Generate recommendations
      assessment.issues.recommendations =
        await this.generateSpatialRecommendations(assessment);

      // Calculate ISO 19115 compliance score
      assessment.compliance.score = this.calculateComplianceScore(assessment);
      assessment.compliance.iso19115 = assessment.compliance.score >= 90;

      await this.logSpatialActivity('quality_assessment', {
        assessmentId,
        dataPoints: dataSet.length,
        completeness: assessment.metrics.completeness,
        compliance: assessment.compliance.score,
      });

      return assessment;
    } catch (error) {
      assessment.issues.errors.push(`Assessment error: ${error.message}`);

      await this.logSpatialActivity('assessment_error', {
        assessmentId,
        error: error.message,
      });

      return assessment;
    }
  }

  // Station metadata validation
  async validateStationMetadata(stationData) {
    const validationId = crypto.randomUUID();

    const validation = {
      id: validationId,
      stationId: stationData.id,
      valid: true,
      issues: {
        errors: [],
        warnings: [],
        missing: [],
      },
      metadata: {
        completeness: 0,
        quality: 100,
      },
    };

    // Required metadata fields per ISO 19115
    const requiredFields = [
      'id',
      'name',
      'coordinates',
      'installation_date',
      'sensor_type',
      'calibration_date',
      'maintenance_schedule',
    ];

    const optionalFields = [
      'elevation',
      'description',
      'contact_info',
      'data_quality_score',
      'environmental_conditions',
      'power_source',
      'communication_method',
    ];

    // Check required fields
    for (const field of requiredFields) {
      if (!stationData[field]) {
        validation.issues.missing.push(field);
        validation.valid = false;
        validation.metadata.quality -= 10;
      }
    }

    // Check optional fields for completeness
    const presentOptionalFields = optionalFields.filter(
      field => stationData[field]
    );
    validation.metadata.completeness =
      (presentOptionalFields.length / optionalFields.length) * 100;

    // Validate coordinate metadata
    if (stationData.coordinates) {
      const coordValidation = await this.validateCoordinates(
        stationData.coordinates
      );
      if (!coordValidation.results.valid) {
        validation.issues.errors.push(...coordValidation.results.errors);
        validation.valid = false;
      }
    }

    // Validate temporal metadata
    if (stationData.installation_date) {
      const installDate = new Date(stationData.installation_date);
      if (installDate > new Date()) {
        validation.issues.warnings.push('Installation date is in the future');
        validation.metadata.quality -= 5;
      }
    }

    return validation;
  }

  // Helper methods
  countDecimalPlaces(number) {
    const str = number.toString();
    const decimalIndex = str.indexOf('.');
    return decimalIndex === -1 ? 0 : str.length - decimalIndex - 1;
  }

  isWithinBounds(coordinates, bounds) {
    return (
      coordinates.latitude >= bounds.minLat &&
      coordinates.latitude <= bounds.maxLat &&
      coordinates.longitude >= bounds.minLon &&
      coordinates.longitude <= bounds.maxLon
    );
  }

  async validateArcticConditions(coordinates) {
    // Special validation for Arctic conditions
    const warnings = [];

    // Check for extreme coordinates
    if (coordinates.latitude > 85) {
      warnings.push(
        'Extremely high latitude - verify GPS accuracy in polar regions'
      );
    }

    return {
      valid: warnings.length === 0,
      errors: warnings,
    };
  }

  async estimateElevationFromDEM(coordinates) {
    const spatialSamples = await this.getSpatialReferencePoints();
    const nearbyElevations = spatialSamples
      .filter(sample => sample.elevation !== null)
      .map(sample => ({
        elevation: sample.elevation,
        distance: this.calculateDistanceMeters(coordinates, sample),
      }))
      .filter(sample => sample.distance <= 50000)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);

    if (nearbyElevations.length > 0) {
      const weightedElevation = nearbyElevations.reduce(
        (accumulator, sample) => {
          const weight = 1 / Math.max(sample.distance, 100);
          accumulator.totalWeight += weight;
          accumulator.weightedElevation += sample.elevation * weight;
          return accumulator;
        },
        { totalWeight: 0, weightedElevation: 0 }
      );

      if (weightedElevation.totalWeight > 0) {
        return Math.round(
          weightedElevation.weightedElevation / weightedElevation.totalWeight
        );
      }
    }

    return this.estimateTerrainBaseline(coordinates);
  }

  async findNearbyCoordinates(coordinates, maxDistance) {
    const spatialSamples = await this.getSpatialReferencePoints();

    return spatialSamples.filter(sample => {
      const distance = this.calculateDistanceMeters(coordinates, sample);
      return distance > 0 && distance <= maxDistance;
    });
  }

  async detectSpatialOutlier(coordinates) {
    const spatialSamples = await this.getSpatialReferencePoints();

    if (spatialSamples.length < 5) {
      return false;
    }

    const neighbors = spatialSamples
      .map(sample => ({
        ...sample,
        distance: this.calculateDistanceMeters(coordinates, sample),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 25);

    if (neighbors.length < 5) {
      return false;
    }

    const centroid = neighbors.reduce(
      (accumulator, sample) => {
        accumulator.latitude += sample.latitude;
        accumulator.longitude += sample.longitude;
        return accumulator;
      },
      { latitude: 0, longitude: 0 }
    );
    centroid.latitude /= neighbors.length;
    centroid.longitude /= neighbors.length;

    const centroidDistances = neighbors.map(sample =>
      this.calculateDistanceMeters(sample, centroid)
    );
    const averageDistance =
      centroidDistances.reduce((sum, distance) => sum + distance, 0) /
      centroidDistances.length;
    const variance =
      centroidDistances.reduce(
        (sum, distance) => sum + Math.pow(distance - averageDistance, 2),
        0
      ) / centroidDistances.length;
    const standardDeviation = Math.sqrt(variance);
    const targetDistance = this.calculateDistanceMeters(coordinates, centroid);

    return targetDistance > averageDistance + Math.max(standardDeviation * 3, 5000);
  }

  async calculateSpatialCoverage(dataSet) {
    // Calculate percentage of area covered by data points
    if (dataSet.length === 0) return 0;

    // Simplified coverage calculation
    const latRange =
      Math.max(...dataSet.map(d => d.latitude)) -
      Math.min(...dataSet.map(d => d.latitude));
    const lonRange =
      Math.max(...dataSet.map(d => d.longitude)) -
      Math.min(...dataSet.map(d => d.longitude));

    // Coverage based on density and distribution
    return Math.min(95, dataSet.length * 10 + latRange * lonRange);
  }

  async generateSpatialRecommendations(assessment) {
    const recommendations = [];

    if (assessment.metrics.completeness < 95) {
      recommendations.push(
        'Improve data completeness by validating all coordinate entries'
      );
    }

    if (assessment.metrics.precision.average > 1e-5) {
      recommendations.push(
        'Increase coordinate precision to meet ISO 19115 standards'
      );
    }

    if (assessment.metrics.coverage < 80) {
      recommendations.push(
        'Enhance spatial coverage by adding monitoring stations in data gaps'
      );
    }

    if (assessment.issues.errors.length > 0) {
      recommendations.push(
        'Address coordinate validation errors before deployment'
      );
    }

    return recommendations;
  }

  calculateComplianceScore(assessment) {
    let score = 100;

    // Deduct for errors and warnings
    score -= assessment.issues.errors.length * 10;
    score -= assessment.issues.warnings.length * 2;

    // Factor in metrics
    score = score * (assessment.metrics.completeness / 100);
    score = score * (assessment.metrics.consistency / 100);
    score = score * (assessment.metrics.coverage / 100);

    return Math.max(0, Math.min(100, score));
  }

  async estimateAccuracy(coordinates, coordinateSystem) {
    const system = this.coordinateSystems.get(coordinateSystem);
    if (!system) return null;

    // Base accuracy on coordinate system precision
    return system.precision * 10; // Conservative estimate
  }

  async logSpatialActivity(activity, data) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      activity,
      data,
      id: crypto.randomUUID(),
    };

    this.auditLog.push(logEntry);
    appLogger.info('Spatial Validation', { activity, ...data });
  }

  // Public API methods
  async validateWeatherStationNetwork(stations) {
    const networkValidation = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      totalStations: stations.length,
      validStations: 0,
      issues: [],
      coverage: null,
      recommendations: [],
    };

    const CONCURRENCY_LIMIT = 10;
    const validations = [];
    for (let i = 0; i < stations.length; i += CONCURRENCY_LIMIT) {
      const batch = stations.slice(i, i + CONCURRENCY_LIMIT);
      const batchResults = await Promise.allSettled(
        batch.map(station => this.validateStationMetadata(station))
      );
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === 'rejected') {
          appLogger.error('Station validation failed:', result.reason);
          continue;
        }
        const stationValidation = result.value;
        validations.push(stationValidation);

        if (stationValidation.valid) {
          networkValidation.validStations++;
        } else {
          networkValidation.issues.push({
            stationId: batch[j].id,
            issues: stationValidation.issues,
          });
        }
      }
    }

    // Calculate network coverage
    const coordinates = stations.map(s => s.coordinates).filter(c => c);
    networkValidation.coverage =
      await this.calculateSpatialCoverage(coordinates);

    return networkValidation;
  }

  async getSpatialReferencePoints() {
    // Return cached result if still fresh (#408: avoid 3× DB round-trips per validation pass)
    if (_spatialCache && Date.now() - _spatialCacheTime < SPATIAL_CACHE_TTL_MS) {
      return _spatialCache;
    }

    const { db, schema } = getDb();
    if (!db || !schema) {
      return [];
    }

    try {
      const weatherRows = await db
        .select({
          latitude: schema.weatherData.latitude,
          longitude: schema.weatherData.longitude,
          elevation: schema.weatherData.elevation,
          stationId: schema.weatherData.stationId,
        })
        .from(schema.weatherData)
        .limit(1000);

      const result = weatherRows
        .map(row => ({
          latitude: this.parseCoordinate(row.latitude),
          longitude: this.parseCoordinate(row.longitude),
          elevation: this.parseElevation(row.elevation),
          stationId: row.stationId,
        }))
        .filter(
          row =>
            row.latitude !== null &&
            row.longitude !== null &&
            row.latitude >= -90 &&
            row.latitude <= 90 &&
            row.longitude >= -180 &&
            row.longitude <= 180
        );

      _spatialCache = result;
      _spatialCacheTime = Date.now();
      return result;
    } catch (error) {
      appLogger.error('Spatial Validation: failed to query reference points', {
        error: error.message,
      });
      return [];
    }
  }

  parseCoordinate(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  parseElevation(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  calculateDistanceMeters(a, b) {
    const toRadians = degrees => (degrees * Math.PI) / 180;
    const earthRadiusMeters = 6371000;
    const latDelta = toRadians(b.latitude - a.latitude);
    const lonDelta = toRadians(b.longitude - a.longitude);
    const lat1 = toRadians(a.latitude);
    const lat2 = toRadians(b.latitude);

    const haversine =
      Math.sin(latDelta / 2) * Math.sin(latDelta / 2) +
      Math.cos(lat1) *
        Math.cos(lat2) *
        Math.sin(lonDelta / 2) *
        Math.sin(lonDelta / 2);

    return (
      2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
    );
  }

  estimateTerrainBaseline(coordinates) {
    const latRadians = (coordinates.latitude * Math.PI) / 180;
    const lonRadians = (coordinates.longitude * Math.PI) / 180;
    const latBand = (Math.sin(latRadians * 2) + 1) * 280;
    const ridgeBand = (Math.sin((latRadians + lonRadians) * 4) + 1) * 180;
    const coastalBand = (Math.cos(lonRadians * 3) + 1) * 120;

    return Math.max(0, Math.round(latBand + ridgeBand + coastalBand - 200));
  }
}

// Express middleware
const spatialValidator = new SpatialValidationSystem();

const spatialValidationMiddleware = {
  validateCoordinates: async (req, res, next) => {
    try {
      const { coordinates, coordinateSystem } = req.body;
      const validation = await spatialValidator.validateCoordinates(
        coordinates,
        coordinateSystem
      );
      res.json(validation);
    } catch (error) {
      next(error);
    }
  },

  assessDataQuality: async (req, res, next) => {
    try {
      const { dataSet } = req.body;
      const assessment =
        await spatialValidator.assessSpatialDataQuality(dataSet);
      res.json(assessment);
    } catch (error) {
      next(error);
    }
  },

  validateStation: async (req, res, next) => {
    try {
      const stationData = req.body;
      const validation =
        await spatialValidator.validateStationMetadata(stationData);
      res.json(validation);
    } catch (error) {
      next(error);
    }
  },

  validateNetwork: async (req, res, next) => {
    try {
      const { stations } = req.body;
      const networkValidation =
        await spatialValidator.validateWeatherStationNetwork(stations);
      res.json(networkValidation);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = {
  SpatialValidationSystem,
  spatialValidationMiddleware,
  spatialValidator,
};
