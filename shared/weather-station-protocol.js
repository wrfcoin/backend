/**
 * Wrfcoin Weather Station Protocol
 *
 * Inspired by WeatherXM's weather station compatibility layer, this module provides
 * a standardized protocol for weather stations to submit data to the Wrfcoin blockchain.
 * It handles different types of weather stations, data formats, and validation rules.
 */

const { createWeatherDataMerkleTree } = require('./merkle-verification');
const { DataBlockType, DataStorageProvider } = require('./data-aware-block');

// Supported weather station protocols
const StationProtocol = {
  WXM: 'wxm', // WeatherXM protocol
  DAVIS: 'davis', // Davis Instruments protocol
  ECOWITT: 'ecowitt', // Ecowitt protocol
  NETATMO: 'netatmo', // Netatmo protocol
  AMBIENT: 'ambient', // Ambient Weather protocol
  CUSTOM: 'custom', // Custom protocol (defined by user)
};

// Supported weather station models
const StationModel = {
  WXM_M5: 'wxm_m5', // WeatherXM M5 station
  WXM_WS1000: 'wxm_ws1000', // WeatherXM WS1000 station
  DAVIS_VANTAGE: 'davis_vantage', // Davis Vantage Pro2
  ECOWITT_GW1000: 'ecowitt_gw1000', // Ecowitt GW1000
  NETATMO_SMART: 'netatmo_smart', // Netatmo Smart Weather Station
  AMBIENT_WS2000: 'ambient_ws2000', // Ambient Weather WS-2000
  CUSTOM: 'custom', // Custom station model
};

// Required sensor types for full compliance
const RequiredSensors = {
  BASIC: ['temperature', 'humidity', 'pressure'],
  STANDARD: [
    'temperature',
    'humidity',
    'pressure',
    'wind_speed',
    'wind_direction',
    'rainfall',
  ],
  ADVANCED: [
    'temperature',
    'humidity',
    'pressure',
    'wind_speed',
    'wind_direction',
    'rainfall',
    'solar_radiation',
    'uv_index',
  ],
};

// Station registration details
class StationRegistration {
  constructor(options = {}) {
    this.id = options.id || `wxm-${Date.now().toString(36)}`;
    this.name = options.name || 'Unnamed Station';
    this.model = options.model || StationModel.CUSTOM;
    this.protocol = options.protocol || StationProtocol.CUSTOM;
    this.location = options.location || {
      latitude: 0,
      longitude: 0,
      elevation: 0,
    };
    this.owner = options.owner || '';
    this.sensors = options.sensors || [];
    this.registrationDate =
      options.registrationDate || new Date().toISOString();
    this.lastSeen = options.lastSeen || this.registrationDate;
    this.firmware = options.firmware || '1.0.0';
    this.status = options.status || 'active';
  }

  // Validate station registration data
  validate() {
    const errors = [];

    if (!this.id) errors.push('Station ID is required');
    if (!this.name) errors.push('Station name is required');
    if (!this.location.latitude || !this.location.longitude)
      errors.push('Location coordinates are required');

    // Check if the station has minimum required sensors
    const sensorTypes = this.sensors.map(s => s.type);
    const hasMissingBasicSensors = RequiredSensors.BASIC.some(
      type => !sensorTypes.includes(type)
    );

    if (hasMissingBasicSensors) {
      errors.push(
        `Missing basic required sensors: ${RequiredSensors.BASIC.filter(type => !sensorTypes.includes(type)).join(', ')}`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Weather data submission
class WeatherDataSubmission {
  constructor(options = {}) {
    this.stationId = options.stationId;
    this.timestamp = options.timestamp || new Date().toISOString();
    this.readings = options.readings || [];
    this.signature = options.signature || ''; // Station signature for verification
    this.batchId = options.batchId || `batch-${Date.now().toString(36)}`;
    this.metadata = options.metadata || {};
  }

  // Add a new sensor reading
  addReading(sensor, value, unit, metadata = {}) {
    this.readings.push({
      sensor,
      value,
      unit,
      timestamp: metadata.timestamp || this.timestamp,
      metadata,
    });
  }

  // Validate the submission
  validate() {
    const errors = [];

    if (!this.stationId) errors.push('Station ID is required');
    if (!this.timestamp) errors.push('Timestamp is required');
    if (this.readings.length === 0)
      errors.push('At least one reading is required');

    // Check for required sensors based on station type (would require station info)
    // For this example, we'll do a basic check for duplicates
    const sensorCounts = {};
    this.readings.forEach(reading => {
      sensorCounts[reading.sensor] = (sensorCounts[reading.sensor] || 0) + 1;
    });

    const duplicates = Object.entries(sensorCounts)
      .filter(([_, count]) => count > 1)
      .map(([sensor]) => sensor);

    if (duplicates.length > 0) {
      errors.push(`Duplicate readings for sensors: ${duplicates.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // Generate a Merkle tree for this submission
  generateMerkleTree() {
    // Transform readings to a format suitable for Merkle tree generation
    const data = this.readings.map(reading => ({
      stationId: this.stationId,
      timestamp: reading.timestamp,
      type: reading.sensor,
      value: reading.value,
      unit: reading.unit,
      metadata: reading.metadata,
    }));

    return createWeatherDataMerkleTree(data);
  }

  // Prepare for blockchain submission
  prepareForBlockchain() {
    // Generate Merkle tree for data verification
    const merkleTree = this.generateMerkleTree();

    // Prepare the data block
    return {
      data_type: DataBlockType.SENSOR_COLLECTION,
      station_id: this.stationId,
      timestamp: this.timestamp,
      batch_id: this.batchId,
      reading_count: this.readings.length,
      merkle_root: merkleTree.hash,
      sensors: this.readings
        .map(r => r.sensor)
        .filter((v, i, a) => a.indexOf(v) === i), // unique sensors
      metadata: this.metadata,
      signature: this.signature,
    };
  }
}

/**
 * Protocol adapter for different weather station formats
 */
class WeatherStationProtocolAdapter {
  /**
   * Convert from a specific protocol format to the standard format
   * @param {string} protocol The station protocol
   * @param {Object} data The raw data from the station
   * @returns {WeatherDataSubmission} Standardized data submission
   */
  static fromProtocol(protocol, data) {
    switch (protocol.toLowerCase()) {
      case StationProtocol.WXM:
        return this._fromWXM(data);
      case StationProtocol.DAVIS:
        return this._fromDavis(data);
      case StationProtocol.ECOWITT:
        return this._fromEcowitt(data);
      case StationProtocol.NETATMO:
        return this._fromNetatmo(data);
      case StationProtocol.AMBIENT:
        return this._fromAmbient(data);
      case StationProtocol.CUSTOM:
      default:
        // Assume already in standard format
        return new WeatherDataSubmission(data);
    }
  }

  /**
   * Convert from WeatherXM protocol
   * @private
   */
  static _fromWXM(data) {
    // Parse WeatherXM format
    const submission = new WeatherDataSubmission({
      stationId: data.device_id,
      timestamp: data.timestamp,
      batchId: data.batch_id,
      metadata: data.metadata || {},
    });

    // Convert sensor readings
    if (data.sensors) {
      for (const [sensor, reading] of Object.entries(data.sensors)) {
        submission.addReading(sensor, reading.value, reading.unit, {
          accuracy: reading.accuracy,
          timestamp: reading.timestamp || data.timestamp,
        });
      }
    }

    return submission;
  }

  /**
   * Convert from Davis Instruments protocol
   * @private
   */
  static _fromDavis(data) {
    // Parse Davis format
    const submission = new WeatherDataSubmission({
      stationId: data.station_id || data.id,
      timestamp: data.timestamp || new Date().toISOString(),
    });

    // Map Davis keys to standard keys
    const sensorMap = {
      temp_out: 'temperature',
      hum_out: 'humidity',
      bar: 'pressure',
      wind_speed: 'wind_speed',
      wind_dir: 'wind_direction',
      rain_rate: 'rainfall',
      solar_rad: 'solar_radiation',
      uv: 'uv_index',
    };

    // Unit conversion map
    const unitMap = {
      temp_out: 'fahrenheit', // Davis typically uses imperial
      hum_out: 'percent',
      bar: 'inHg',
      wind_speed: 'mph',
      wind_dir: 'degrees',
      rain_rate: 'inHr',
      solar_rad: 'W/m²',
      uv: 'index',
    };

    // Convert readings
    for (const [davisKey, value] of Object.entries(data)) {
      if (sensorMap[davisKey]) {
        submission.addReading(
          sensorMap[davisKey],
          value,
          unitMap[davisKey] || 'unknown'
        );
      }
    }

    return submission;
  }

  /**
   * Convert from Ecowitt protocol
   * @private
   */
  static _fromEcowitt(data) {
    // Implementation similar to Davis but with Ecowitt specifics
    const submission = new WeatherDataSubmission({
      stationId: data.PASSKEY || data.stationId,
      timestamp: data.dateutc
        ? new Date(data.dateutc * 1000).toISOString()
        : new Date().toISOString(),
    });

    // Map Ecowitt keys to standard keys
    const sensorMap = {
      tempf: 'temperature',
      humidity: 'humidity',
      baromrelin: 'pressure',
      windspeedmph: 'wind_speed',
      winddir: 'wind_direction',
      hourlyrainin: 'rainfall',
      solarradiation: 'solar_radiation',
      uv: 'uv_index',
    };

    // Unit conversion map
    const unitMap = {
      tempf: 'fahrenheit',
      humidity: 'percent',
      baromrelin: 'inHg',
      windspeedmph: 'mph',
      winddir: 'degrees',
      hourlyrainin: 'inHr',
      solarradiation: 'W/m²',
      uv: 'index',
    };

    // Convert readings
    for (const [ecowittKey, value] of Object.entries(data)) {
      if (sensorMap[ecowittKey]) {
        submission.addReading(
          sensorMap[ecowittKey],
          value,
          unitMap[ecowittKey] || 'unknown'
        );
      }
    }

    return submission;
  }

  /**
   * Convert from Netatmo protocol
   * @private
   */
  static _fromNetatmo(data) {
    // Implementation for Netatmo format
    const submission = new WeatherDataSubmission({
      stationId: data.device_id || data._id,
      timestamp: data.time_utc
        ? new Date(data.time_utc * 1000).toISOString()
        : new Date().toISOString(),
    });

    // Map Netatmo data structure to our format
    if (data.dashboard_data) {
      const dashboard = data.dashboard_data;

      if (dashboard.Temperature !== undefined) {
        submission.addReading('temperature', dashboard.Temperature, 'celsius');
      }

      if (dashboard.Humidity !== undefined) {
        submission.addReading('humidity', dashboard.Humidity, 'percent');
      }

      if (dashboard.Pressure !== undefined) {
        submission.addReading('pressure', dashboard.Pressure, 'mbar');
      }

      if (dashboard.WindStrength !== undefined) {
        submission.addReading('wind_speed', dashboard.WindStrength, 'kph');
      }

      if (dashboard.WindAngle !== undefined) {
        submission.addReading('wind_direction', dashboard.WindAngle, 'degrees');
      }

      if (dashboard.Rain !== undefined) {
        submission.addReading('rainfall', dashboard.Rain, 'mm');
      }
    }

    // Process modules data if available
    if (data.modules) {
      for (const module of data.modules) {
        if (module.dashboard_data) {
          const moduleData = module.dashboard_data;

          // Handle outdoor module
          if (
            module.type === 'NAModule1' &&
            moduleData.Temperature !== undefined
          ) {
            submission.addReading(
              'outdoor_temperature',
              moduleData.Temperature,
              'celsius'
            );
            if (moduleData.Humidity !== undefined) {
              submission.addReading(
                'outdoor_humidity',
                moduleData.Humidity,
                'percent'
              );
            }
          }

          // Handle rain gauge
          if (module.type === 'NAModule3' && moduleData.Rain !== undefined) {
            submission.addReading('rainfall', moduleData.Rain, 'mm');
          }
        }
      }
    }

    return submission;
  }

  /**
   * Convert from Ambient Weather protocol
   * @private
   */
  static _fromAmbient(data) {
    const submission = new WeatherDataSubmission({
      stationId: data.macAddress || data.station_id,
      timestamp: data.date
        ? new Date(data.date).toISOString()
        : new Date().toISOString(),
    });

    // Map Ambient Weather keys to standard keys
    const sensorMap = {
      tempf: 'temperature',
      humidity: 'humidity',
      baromrelin: 'pressure',
      windspeedmph: 'wind_speed',
      winddir: 'wind_direction',
      hourlyrainin: 'rainfall',
      solarradiation: 'solar_radiation',
      uv: 'uv_index',
    };

    // Unit conversion map
    const unitMap = {
      tempf: 'fahrenheit',
      humidity: 'percent',
      baromrelin: 'inHg',
      windspeedmph: 'mph',
      winddir: 'degrees',
      hourlyrainin: 'inHr',
      solarradiation: 'W/m²',
      uv: 'index',
    };

    // Convert readings
    for (const [ambientKey, value] of Object.entries(data)) {
      if (sensorMap[ambientKey]) {
        submission.addReading(
          sensorMap[ambientKey],
          value,
          unitMap[ambientKey] || 'unknown'
        );
      }
    }

    return submission;
  }
}

// Station quality assessment and reliability score
class StationQualityAssessment {
  constructor(stationId) {
    this.stationId = stationId;
    this.assessments = [];
    this.recentAnomalies = [];
    this.reliabilityScore = 1.0; // Start with perfect score
  }

  /**
   * Add a new quality assessment
   * @param {Object} assessment Assessment details
   */
  addAssessment(assessment) {
    this.assessments.push({
      ...assessment,
      timestamp: assessment.timestamp || new Date().toISOString(),
    });

    // Check for anomalies
    if (assessment.anomalies && assessment.anomalies.length > 0) {
      this.recentAnomalies.push(...assessment.anomalies);

      // Update reliability score
      const anomalyPenalty = assessment.anomalies.length * 0.05;
      this.reliabilityScore = Math.max(
        0,
        this.reliabilityScore - anomalyPenalty
      );
    } else {
      // Slowly recover reliability if no anomalies
      this.reliabilityScore = Math.min(1.0, this.reliabilityScore + 0.01);
    }

    // Keep only recent anomalies (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    this.recentAnomalies = this.recentAnomalies.filter(
      anomaly => new Date(anomaly.timestamp) > thirtyDaysAgo
    );
  }

  /**
   * Get the current reliability assessment
   */
  getReliabilityReport() {
    return {
      stationId: this.stationId,
      reliabilityScore: this.reliabilityScore,
      assessmentCount: this.assessments.length,
      recentAnomalyCount: this.recentAnomalies.length,
      lastUpdated:
        this.assessments.length > 0
          ? this.assessments[this.assessments.length - 1].timestamp
          : null,
    };
  }
}

module.exports = {
  StationProtocol,
  StationModel,
  RequiredSensors,
  StationRegistration,
  WeatherDataSubmission,
  WeatherStationProtocolAdapter,
  StationQualityAssessment,
};
