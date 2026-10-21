/**
 * WRFCoin Real-Time Stream Processor
 *
 * Continuous data streaming and processing system for real-time weather data ingestion.
 * Handles live data feeds, station monitoring, and real-time data validation.
 *
 * Features:
 * - Continuous NOAA API monitoring with configurable intervals
 * - Weather station data streaming via WebSocket/HTTP polling
 * - Real-time data validation and quality assessment
 * - Live data alerts and anomaly detection
 * - Configurable data retention and cleanup
 * - Performance monitoring and health checks
 */

const EventEmitter = require('events');
const WebSocket = require('ws');
const axios = require('axios');
const moment = require('moment');
const { DataPreprocessor } = require('./data-preprocessor');
const { DataIngestionPipeline } = require('./data-ingestion-pipeline');
const { NOAANWSApiService } = require('./noaa-nws-api-service');
const {
  WeatherDataValidator,
} = require('../utils/testing/weather-data-validation');
const { DatabaseManager } = require('../database/database-manager');
const Logger = require('../utils/logger');

// Import Quality Assurance Pipeline Components
const DataProfilingEngine = require('./data-profiling-engine');
const AnomalyDetectionEngine = require('./anomaly-detection-engine');
const { DataQualityEngine } = require('./data-quality-engine');

class RealTimeStreamProcessor extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      // Streaming intervals
      noaaPollingInterval: options.noaaPollingInterval || 300000, // 5 minutes
      stationPollingInterval: options.stationPollingInterval || 60000, // 1 minute
      healthCheckInterval: options.healthCheckInterval || 30000, // 30 seconds

      // Data processing
      enableRealTimeValidation: options.enableRealTimeValidation !== false,
      enableAnomalyDetection: options.enableAnomalyDetection !== false,
      enableAlerts: options.enableAlerts !== false,

      // Quality thresholds
      qualityThreshold: options.qualityThreshold || 0.6,
      anomalyThreshold: options.anomalyThreshold || 2.5, // Standard deviations

      // Quality Assurance Pipeline settings
      enableQualityAssurance: options.enableQualityAssurance !== false,
      enableDataProfiling: options.enableDataProfiling !== false,
      enableAdvancedAnomalyDetection:
        options.enableAdvancedAnomalyDetection !== false,
      enableQualityScoring: options.enableQualityScoring !== false,

      // Quality pipeline thresholds
      minimumQualityScore: options.minimumQualityScore || 0.7,
      profilingBatchSize: options.profilingBatchSize || 100,
      anomalyEnsembleThreshold: options.anomalyEnsembleThreshold || 0.6,

      // Data retention
      maxDataAge: options.maxDataAge || 86400000, // 24 hours in milliseconds
      cleanupInterval: options.cleanupInterval || 3600000, // 1 hour

      // Connection settings
      maxRetries: options.maxRetries || 5,
      retryDelay: options.retryDelay || 5000,
      connectionTimeout: options.connectionTimeout || 10000,

      // Performance settings
      maxConcurrentStreams: options.maxConcurrentStreams || 10,
      dataBufferSize: options.dataBufferSize || 100,

      ...options,
    };

    this.logger = Logger;
    this.preprocessor = new DataPreprocessor();
    this.validator = new WeatherDataValidator();
    this.noaaApiService = new NOAANWSApiService();
    this.databaseManager = new DatabaseManager();
    this.ingestionPipeline = null;

    // Initialize Quality Assurance Pipeline Components
    this.qualityEngine = null;
    this.profilingEngine = null;
    this.anomalyDetectionEngine = null;

    // Stream management
    this.isStreaming = false;
    this.activeStreams = new Map();
    this.monitoredLocations = new Map();
    this.webSocketConnections = new Map();

    // Data buffers
    this.dataBuffer = [];
    this.anomalyBuffer = [];
    this.alertBuffer = [];

    // Quality Assurance buffers
    this.qualityBuffer = [];
    this.profilingBuffer = [];
    this.qualityMetricsBuffer = [];

    // Timers
    this.timers = new Map();

    // Performance metrics
    this.metrics = {
      totalStreams: 0,
      activeConnections: 0,
      dataPointsProcessed: 0,
      averageLatency: 0,
      errorRate: 0,
      lastProcessedAt: null,
      anomaliesDetected: 0,
      alertsGenerated: 0,

      // Quality Assurance metrics
      qualityAssessments: 0,
      averageQualityScore: 0,
      rejectedLowQuality: 0,
      profilingOperations: 0,
      advancedAnomaliesDetected: 0,
    };

    // Historical data for anomaly detection
    this.historicalData = new Map();
    this.baselineCalculated = false;
  }

  /**
   * Initialize the real-time stream processor
   */
  async initialize() {
    try {
      this.logger.info('Initializing Real-Time Stream Processor...');

      // Initialize database connection
      await this.databaseManager.connect();

      // Initialize ingestion pipeline
      this.ingestionPipeline = new DataIngestionPipeline({
        realTimeEnabled: true,
        batchEnabled: false,
      });
      await this.ingestionPipeline.initialize();

      // Initialize Quality Assurance Pipeline Components
      if (this.options.enableQualityAssurance) {
        await this.initializeQualityAssurancePipeline();
      }

      // Setup event listeners
      this.setupEventListeners();

      // Load baseline data for anomaly detection
      if (this.options.enableAnomalyDetection) {
        await this.loadBaselineData();
      }

      this.logger.info('Real-Time Stream Processor initialized successfully');
      this.emit('initialized');
    } catch (error) {
      this.logger.error(
        'Failed to initialize Real-Time Stream Processor:',
        error
      );
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Initialize Quality Assurance Pipeline Components
   */
  async initializeQualityAssurancePipeline() {
    try {
      this.logger.info('Initializing Quality Assurance Pipeline...');

      // Initialize Data Quality Engine
      if (this.options.enableQualityScoring) {
        this.qualityEngine = new DataQualityEngine({
          minimumQualityScore: this.options.minimumQualityScore,
          enableDerivedParameters: true,
          enableSpatialInterpolation: true,
          enableTemporalSmoothing: true,
          enableCrossValidation: true,
        });
        this.logger.info('Data Quality Engine initialized');
      }

      // Initialize Data Profiling Engine
      if (this.options.enableDataProfiling) {
        this.profilingEngine = new DataProfilingEngine({
          enableHistograms: true,
          temporalAnalysisWindow: 30,
          outlierThreshold: this.options.anomalyThreshold,
        });
        this.logger.info('Data Profiling Engine initialized');
      }

      // Initialize Advanced Anomaly Detection Engine
      if (this.options.enableAdvancedAnomalyDetection) {
        this.anomalyDetectionEngine = new AnomalyDetectionEngine({
          ensembleThreshold: this.options.anomalyEnsembleThreshold,
          zScoreThreshold: this.options.anomalyThreshold,
          locationContext: true,
          temporalContext: true,
        });
        this.logger.info('Advanced Anomaly Detection Engine initialized');
      }

      // Setup quality assurance event listeners
      this.setupQualityAssuranceEventListeners();

      this.logger.info('Quality Assurance Pipeline initialized successfully');
    } catch (error) {
      this.logger.error(
        'Failed to initialize Quality Assurance Pipeline:',
        error
      );
      throw error;
    }
  }

  /**
   * Setup Quality Assurance event listeners
   */
  setupQualityAssuranceEventListeners() {
    if (this.qualityEngine) {
      this.qualityEngine.on('quality-assessed', assessment => {
        this.handleQualityAssessment(assessment);
      });

      this.qualityEngine.on('data-enriched', enrichment => {
        this.handleDataEnrichment(enrichment);
      });
    }

    if (this.anomalyDetectionEngine) {
      // Enhanced anomaly detection events will be handled in the processing pipeline
    }

    if (this.profilingEngine) {
      // Profiling events will be handled in batch operations
    }
  }

  /**
   * Start real-time streaming
   */
  async startStreaming(config = {}) {
    if (this.isStreaming) {
      this.logger.warn('Stream processor is already running');
      return;
    }

    try {
      this.isStreaming = true;
      this.logger.info('Starting real-time streaming...');

      const {
        locations = [],
        enableNOAAStreaming = true,
        enableStationStreaming = true,
        enableWebSocketStreaming = false,
      } = config;

      // Start NOAA API polling
      if (enableNOAAStreaming) {
        await this.startNOAAStreaming(locations);
      }

      // Start weather station polling
      if (enableStationStreaming) {
        await this.startStationStreaming(locations);
      }

      // Start WebSocket connections for real-time station data
      if (enableWebSocketStreaming) {
        await this.startWebSocketStreaming(locations);
      }

      // Start data processing timer
      this.startDataProcessing();

      // Start health monitoring
      this.startHealthMonitoring();

      // Start data cleanup
      this.startDataCleanup();

      // Start quality assurance processing timers
      if (this.options.enableQualityAssurance) {
        this.startQualityProcessingTimers();
      }

      this.logger.info('Real-time streaming started successfully');
      this.emit('streaming-started');
    } catch (error) {
      this.isStreaming = false;
      this.logger.error('Failed to start real-time streaming:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Start NOAA API streaming
   */
  async startNOAAStreaming(locations) {
    const timer = setInterval(async () => {
      try {
        await this.pollNOAAData(locations);
      } catch (error) {
        this.logger.error('Error in NOAA polling:', error);
        this.metrics.errorRate++;
      }
    }, this.options.noaaPollingInterval);

    this.timers.set('noaa-polling', timer);
    this.logger.info(
      `NOAA streaming started with ${this.options.noaaPollingInterval}ms interval`
    );
  }

  /**
   * Start weather station streaming
   */
  async startStationStreaming(locations) {
    const timer = setInterval(async () => {
      try {
        await this.pollStationData(locations);
      } catch (error) {
        this.logger.error('Error in station polling:', error);
        this.metrics.errorRate++;
      }
    }, this.options.stationPollingInterval);

    this.timers.set('station-polling', timer);
    this.logger.info(
      `Station streaming started with ${this.options.stationPollingInterval}ms interval`
    );
  }

  /**
   * Start WebSocket streaming
   */
  async startWebSocketStreaming(locations) {
    for (const location of locations) {
      if (location.websocketUrl) {
        await this.connectWebSocket(location);
      }
    }
  }

  /**
   * Poll NOAA data for multiple locations
   */
  async pollNOAAData(locations) {
    const promises = locations.map(location => this.fetchNOAAData(location));
    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        this.addToBuffer(result.value, 'noaa-realtime');
      }
    }
  }

  /**
   * Fetch NOAA data for a single location
   */
  async fetchNOAAData(location) {
    try {
      const startTime = Date.now();

      // Get current weather data
      const currentData = await this.noaaApiService.getCurrentWeather(location);

      if (currentData && currentData.data) {
        const latency = Date.now() - startTime;
        this.updateLatencyMetrics(latency);

        return {
          source: 'noaa-nws-realtime',
          location,
          data: currentData,
          timestamp: new Date().toISOString(),
          latency,
        };
      }
    } catch (error) {
      this.logger.error(`Error fetching NOAA data for ${location.id}:`, error);
      return null;
    }
  }

  /**
   * Poll weather station data
   */
  async pollStationData(locations) {
    const stationLocations = locations.filter(
      loc => loc.type === 'weather_station'
    );

    for (const station of stationLocations) {
      try {
        const data = await this.fetchStationData(station);
        if (data) {
          this.addToBuffer(data, 'station-realtime');
        }
      } catch (error) {
        this.logger.error(
          `Error fetching station data for ${station.id}:`,
          error
        );
      }
    }
  }

  /**
   * Fetch data from weather station
   */
  async fetchStationData(station) {
    try {
      const startTime = Date.now();

      // Make HTTP request to station endpoint
      const response = await axios.get(station.dataUrl, {
        timeout: this.options.connectionTimeout,
        headers: station.headers || {},
      });

      const latency = Date.now() - startTime;
      this.updateLatencyMetrics(latency);

      return {
        source: 'weather-station-realtime',
        location: station,
        data: response.data,
        timestamp: new Date().toISOString(),
        latency,
      };
    } catch (error) {
      this.logger.error(
        `HTTP polling error for station ${station.id}:`,
        error.message
      );
      return null;
    }
  }

  /**
   * Connect to WebSocket for real-time station data
   */
  async connectWebSocket(location) {
    try {
      const ws = new WebSocket(location.websocketUrl);
      const connectionId = `${location.id}_ws`;

      ws.on('open', () => {
        this.logger.info(`WebSocket connected for ${location.id}`);
        this.webSocketConnections.set(connectionId, ws);
        this.metrics.activeConnections++;

        // Send authentication if required
        if (location.authMessage) {
          ws.send(JSON.stringify(location.authMessage));
        }
      });

      ws.on('message', data => {
        try {
          const parsedData = JSON.parse(data);
          this.handleWebSocketData(parsedData, location);
        } catch (error) {
          this.logger.error(
            `Error parsing WebSocket data from ${location.id}:`,
            error
          );
        }
      });

      ws.on('error', error => {
        this.logger.error(`WebSocket error for ${location.id}:`, error);
        this.metrics.errorRate++;
      });

      ws.on('close', () => {
        this.logger.warn(`WebSocket closed for ${location.id}`);
        this.webSocketConnections.delete(connectionId);
        this.metrics.activeConnections--;

        // Attempt reconnection after delay
        setTimeout(() => {
          if (this.isStreaming) {
            this.connectWebSocket(location);
          }
        }, this.options.retryDelay);
      });
    } catch (error) {
      this.logger.error(
        `Failed to connect WebSocket for ${location.id}:`,
        error
      );
    }
  }

  /**
   * Handle WebSocket data
   */
  handleWebSocketData(data, location) {
    this.addToBuffer(
      {
        source: 'websocket-realtime',
        location,
        data,
        timestamp: new Date().toISOString(),
      },
      'websocket'
    );

    this.metrics.dataPointsProcessed++;
  }

  /**
   * Add data to processing buffer
   */
  addToBuffer(data, sourceType) {
    this.dataBuffer.push({
      ...data,
      sourceType,
      receivedAt: Date.now(),
    });

    // Process buffer if it reaches maximum size
    if (this.dataBuffer.length >= this.options.dataBufferSize) {
      this.processDataBuffer();
    }
  }

  /**
   * Start data processing timer
   */
  startDataProcessing() {
    const timer = setInterval(() => {
      if (this.dataBuffer.length > 0) {
        this.processDataBuffer();
      }
    }, 5000); // Process every 5 seconds

    this.timers.set('data-processing', timer);
  }

  /**
   * Process data buffer
   */
  async processDataBuffer() {
    if (this.dataBuffer.length === 0) return;

    const dataToProcess = [...this.dataBuffer];
    this.dataBuffer = [];

    try {
      for (const item of dataToProcess) {
        await this.processRealTimeData(item);
      }
    } catch (error) {
      this.logger.error('Error processing data buffer:', error);
    }
  }

  /**
   * Process individual real-time data item
   */
  async processRealTimeData(item) {
    try {
      const startTime = Date.now();

      // Preprocess data
      const preprocessed = await this.preprocessor.process(item.data, {
        source: item.source,
        normalizeUnits: true,
        validateFormat: true,
        enrichData: true,
      });

      if (!preprocessed) {
        this.logger.warn('Preprocessing failed for real-time data');
        return;
      }

      // Validate data quality
      if (this.options.enableRealTimeValidation) {
        const validationResult =
          await this.validator.validateData(preprocessed);
        if (!validationResult.passed) {
          this.logger.warn(
            'Real-time data validation failed:',
            validationResult.errors
          );
          return;
        }
      }

      // Enhanced Quality Assurance Pipeline Integration
      let qualityAssessment = null;
      let enrichedData = preprocessed;

      // 1. Data Quality Assessment & Scoring
      if (this.options.enableQualityScoring && this.qualityEngine) {
        try {
          qualityAssessment =
            await this.qualityEngine.assessQuality(preprocessed);
          this.metrics.qualityAssessments++;

          // Update average quality score
          const currentAvg = this.metrics.averageQualityScore;
          const count = this.metrics.qualityAssessments;
          this.metrics.averageQualityScore =
            (currentAvg * (count - 1) + qualityAssessment.overallScore) / count;

          // Reject data below quality threshold
          if (
            qualityAssessment.overallScore < this.options.minimumQualityScore
          ) {
            this.logger.warn('Data quality below threshold:', {
              score: qualityAssessment.overallScore,
              threshold: this.options.minimumQualityScore,
              location: preprocessed.location,
              flags: qualityAssessment.flags,
            });
            this.metrics.rejectedLowQuality++;
            this.addToQualityBuffer({
              data: preprocessed,
              assessment: qualityAssessment,
              action: 'rejected',
              timestamp: new Date().toISOString(),
            });
            return; // Skip processing low-quality data
          }

          // Data enrichment for good quality data
          enrichedData = await this.qualityEngine.enrichData(
            preprocessed,
            qualityAssessment
          );
        } catch (error) {
          this.logger.error('Quality assessment failed:', error);
          // Continue with original data if quality assessment fails
        }
      }

      // 2. Advanced Anomaly Detection
      if (
        this.options.enableAdvancedAnomalyDetection &&
        this.anomalyDetectionEngine
      ) {
        try {
          const anomalyResults =
            await this.anomalyDetectionEngine.detectAnomalies([enrichedData]);

          if (
            anomalyResults.anomalies.ensemble.anomalies &&
            anomalyResults.anomalies.ensemble.anomalies.length > 0
          ) {
            this.metrics.advancedAnomaliesDetected++;
            this.handleAdvancedAnomalyDetection(anomalyResults, enrichedData);
          }
        } catch (error) {
          this.logger.error('Advanced anomaly detection failed:', error);
        }
      }

      // 3. Add to profiling buffer for batch analysis
      if (this.options.enableDataProfiling && this.profilingEngine) {
        this.addToProfilingBuffer(enrichedData, qualityAssessment);
      }

      // 4. Legacy anomaly detection (keep for compatibility)
      if (this.options.enableAnomalyDetection) {
        const anomaly = this.detectAnomaly(enrichedData);
        if (anomaly) {
          this.handleAnomaly(anomaly, enrichedData);
        }
      }

      // Store enriched data (or original if enrichment not enabled)
      await this.storeRealTimeData(enrichedData, item, qualityAssessment);

      // Generate alerts if needed
      if (this.options.enableAlerts) {
        this.checkForAlerts(enrichedData);
      }

      const processingTime = Date.now() - startTime;
      this.updateProcessingMetrics(processingTime);

      // Add quality metadata to processed data event
      this.emit('data-processed', {
        data: enrichedData,
        originalData: preprocessed,
        qualityAssessment,
        processingTime,
        source: item.source,
      });
    } catch (error) {
      this.logger.error('Error processing real-time data:', error);
      this.metrics.errorRate++;
    }
  }

  /**
   * Detect anomalies in real-time data
   */
  detectAnomaly(data) {
    if (!this.baselineCalculated) return null;

    const locationKey = `${data.location.latitude}_${data.location.longitude}`;
    const baseline = this.historicalData.get(locationKey);

    if (!baseline) return null;

    const anomalies = [];

    // Check temperature anomaly
    if (data.data.temperature.value !== null && baseline.temperature) {
      const tempDeviation =
        Math.abs(data.data.temperature.value - baseline.temperature.mean) /
        baseline.temperature.stdDev;
      if (tempDeviation > this.options.anomalyThreshold) {
        anomalies.push({
          parameter: 'temperature',
          value: data.data.temperature.value,
          expected: baseline.temperature.mean,
          deviation: tempDeviation,
          severity: this.getAnomalySeverity(tempDeviation),
        });
      }
    }

    // Check pressure anomaly
    if (data.data.pressure.value !== null && baseline.pressure) {
      const pressureDeviation =
        Math.abs(data.data.pressure.value - baseline.pressure.mean) /
        baseline.pressure.stdDev;
      if (pressureDeviation > this.options.anomalyThreshold) {
        anomalies.push({
          parameter: 'pressure',
          value: data.data.pressure.value,
          expected: baseline.pressure.mean,
          deviation: pressureDeviation,
          severity: this.getAnomalySeverity(pressureDeviation),
        });
      }
    }

    return anomalies.length > 0
      ? {
          location: data.location,
          timestamp: data.timestamp,
          anomalies,
        }
      : null;
  }

  /**
   * Handle detected anomaly
   */
  handleAnomaly(anomaly, data) {
    this.logger.warn('Anomaly detected:', anomaly);
    this.metrics.anomaliesDetected++;

    this.anomalyBuffer.push({
      ...anomaly,
      data,
      detectedAt: new Date().toISOString(),
    });

    this.emit('anomaly-detected', anomaly);
  }

  /**
   * Check for alert conditions
   */
  checkForAlerts(data) {
    const alerts = [];

    // Temperature alerts
    if (data.data.temperature.value !== null) {
      if (data.data.temperature.value > 45) {
        alerts.push({
          type: 'extreme_heat',
          severity: 'high',
          parameter: 'temperature',
          value: data.data.temperature.value,
          threshold: 45,
        });
      } else if (data.data.temperature.value < -30) {
        alerts.push({
          type: 'extreme_cold',
          severity: 'high',
          parameter: 'temperature',
          value: data.data.temperature.value,
          threshold: -30,
        });
      }
    }

    // Wind speed alerts
    if (data.data.windSpeed.value !== null && data.data.windSpeed.value > 33) {
      // 33 m/s = ~120 km/h
      alerts.push({
        type: 'high_wind',
        severity: 'medium',
        parameter: 'windSpeed',
        value: data.data.windSpeed.value,
        threshold: 33,
      });
    }

    // Generate alerts
    for (const alert of alerts) {
      this.generateAlert(alert, data);
    }
  }

  /**
   * Generate alert
   */
  generateAlert(alert, data) {
    const alertData = {
      ...alert,
      location: data.location,
      timestamp: data.timestamp,
      generatedAt: new Date().toISOString(),
    };

    this.alertBuffer.push(alertData);
    this.metrics.alertsGenerated++;

    this.logger.warn('Alert generated:', alertData);
    this.emit('alert-generated', alertData);
  }

  /**
   * Handle quality assessment results
   */
  handleQualityAssessment(assessment) {
    this.addToQualityBuffer({
      assessment,
      action: 'assessed',
      timestamp: new Date().toISOString(),
    });

    this.emit('quality-assessment', assessment);
  }

  /**
   * Handle data enrichment results
   */
  handleDataEnrichment(enrichment) {
    this.emit('data-enrichment', enrichment);
  }

  /**
   * Handle advanced anomaly detection results
   */
  handleAdvancedAnomalyDetection(anomalyResults, data) {
    this.logger.warn('Advanced anomalies detected:', {
      anomalyCount: anomalyResults.anomalies.ensemble.anomalies.length,
      confidenceScore: anomalyResults.anomalies.ensemble.confidenceScore,
      location: data.location,
      timestamp: data.timestamp,
    });

    // Add to anomaly buffer for further analysis
    this.anomalyBuffer.push({
      type: 'advanced',
      results: anomalyResults,
      data,
      detectedAt: new Date().toISOString(),
    });

    this.emit('advanced-anomaly-detected', {
      anomalyResults,
      data,
    });
  }

  /**
   * Add data to quality buffer
   */
  addToQualityBuffer(qualityData) {
    this.qualityBuffer.push({
      ...qualityData,
      bufferedAt: Date.now(),
    });

    // Process buffer if it reaches maximum size
    if (this.qualityBuffer.length >= this.options.dataBufferSize) {
      this.processQualityBuffer();
    }
  }

  /**
   * Add data to profiling buffer
   */
  addToProfilingBuffer(data, qualityAssessment) {
    this.profilingBuffer.push({
      data,
      qualityAssessment,
      timestamp: new Date().toISOString(),
      bufferedAt: Date.now(),
    });

    // Process buffer if it reaches profiling batch size
    if (this.profilingBuffer.length >= this.options.profilingBatchSize) {
      this.processProfilingBuffer();
    }
  }

  /**
   * Process quality buffer
   */
  async processQualityBuffer() {
    if (this.qualityBuffer.length === 0) return;

    const qualityData = [...this.qualityBuffer];
    this.qualityBuffer = [];

    try {
      // Generate quality metrics report
      const qualityMetrics = this.generateQualityMetrics(qualityData);
      this.qualityMetricsBuffer.push(qualityMetrics);

      this.emit('quality-metrics-generated', qualityMetrics);
    } catch (error) {
      this.logger.error('Error processing quality buffer:', error);
    }
  }

  /**
   * Process profiling buffer
   */
  async processProfilingBuffer() {
    if (this.profilingBuffer.length === 0 || !this.profilingEngine) return;

    const profilingData = [...this.profilingBuffer];
    this.profilingBuffer = [];

    try {
      // Extract data array for profiling
      const dataArray = profilingData.map(item => item.data);

      // Generate profile
      const profile = await this.profilingEngine.generateProfile(dataArray, {
        source: 'realtime_stream',
        batchSize: dataArray.length,
        profiledAt: new Date().toISOString(),
      });

      this.metrics.profilingOperations++;

      this.emit('data-profiled', {
        profile,
        dataCount: dataArray.length,
      });

      this.logger.debug('Profiling batch completed:', {
        recordCount: dataArray.length,
        qualityScore: profile.quality?.overallScore,
      });
    } catch (error) {
      this.logger.error('Error processing profiling buffer:', error);
    }
  }

  /**
   * Generate quality metrics from buffer data
   */
  generateQualityMetrics(qualityData) {
    const assessments = qualityData
      .filter(item => item.assessment)
      .map(item => item.assessment);
    const rejected = qualityData.filter(item => item.action === 'rejected');

    return {
      timestamp: new Date().toISOString(),
      totalAssessments: assessments.length,
      averageQualityScore:
        assessments.length > 0
          ? assessments.reduce((sum, a) => sum + a.overallScore, 0) /
            assessments.length
          : 0,
      rejectedCount: rejected.length,
      rejectionRate:
        qualityData.length > 0 ? rejected.length / qualityData.length : 0,
      qualityDistribution: this.calculateQualityDistribution(assessments),
      commonFlags: this.extractCommonQualityFlags(assessments),
    };
  }

  /**
   * Calculate quality score distribution
   */
  calculateQualityDistribution(assessments) {
    const distribution = { excellent: 0, good: 0, fair: 0, poor: 0 };

    assessments.forEach(assessment => {
      const level = assessment.qualityLevel;
      if (distribution.hasOwnProperty(level)) {
        distribution[level]++;
      }
    });

    return distribution;
  }

  /**
   * Extract common quality flags
   */
  extractCommonQualityFlags(assessments) {
    const flagCounts = {};

    assessments.forEach(assessment => {
      if (assessment.flags) {
        assessment.flags.forEach(flag => {
          const key = `${flag.type}_${flag.severity}`;
          flagCounts[key] = (flagCounts[key] || 0) + 1;
        });
      }
    });

    // Return top 5 most common flags
    return Object.entries(flagCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([flag, count]) => ({ flag, count }));
  }

  /**
   * Store real-time data
   */
  async storeRealTimeData(data, metadata, qualityAssessment = null) {
    try {
      const dbRecord = {
        data_id: this.generateDataId(data),
        timestamp: data.timestamp,
        latitude: data.location.latitude.toString(),
        longitude: data.location.longitude.toString(),
        elevation: data.location.elevation || null,
        station_id: data.location.stationId || null,
        temperature: data.data.temperature
          ? JSON.stringify(data.data.temperature)
          : null,
        humidity: data.data.humidity
          ? JSON.stringify(data.data.humidity)
          : null,
        pressure: data.data.pressure
          ? JSON.stringify(data.data.pressure)
          : null,
        wind_speed: data.data.windSpeed
          ? JSON.stringify(data.data.windSpeed)
          : null,
        wind_direction: data.data.windDirection
          ? JSON.stringify(data.data.windDirection)
          : null,
        precipitation: data.data.precipitation
          ? JSON.stringify(data.data.precipitation)
          : null,
        data_hash: this.calculateDataHash(data),
        source_type: 'realtime_stream',
        metadata: {
          sourceType: metadata.sourceType,
          latency: metadata.latency,
          receivedAt: new Date(metadata.receivedAt).toISOString(),
          processingTimestamp: new Date().toISOString(),

          // Quality Assurance metadata
          qualityAssurance: qualityAssessment
            ? {
                overallScore: qualityAssessment.overallScore,
                qualityLevel: qualityAssessment.qualityLevel,
                assessmentId: qualityAssessment.dataId,
                flags: qualityAssessment.flags,
                enriched: data.quality?.enrichment?.enabled || false,
                derived: data.quality?.enrichment?.log || [],
              }
            : null,
        },
      };

      await this.databaseManager.insertWeatherData(dbRecord);
    } catch (error) {
      if (error.code !== '23505') {
        // Ignore duplicates
        this.logger.error('Error storing real-time data:', error);
        throw error;
      }
    }
  }

  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    const timer = setInterval(() => {
      this.performHealthCheck();
    }, this.options.healthCheckInterval);

    this.timers.set('health-monitoring', timer);
  }

  /**
   * Perform health check
   */
  performHealthCheck() {
    const health = {
      isStreaming: this.isStreaming,
      activeConnections: this.metrics.activeConnections,
      bufferSize: this.dataBuffer.length,
      errorRate: this.metrics.errorRate,
      lastProcessedAt: this.metrics.lastProcessedAt,
      memoryUsage: process.memoryUsage(),
    };

    this.emit('health-check', health);

    // Check for potential issues
    if (this.dataBuffer.length > this.options.dataBufferSize * 2) {
      this.logger.warn('Data buffer is overflowing');
      this.emit('buffer-overflow');
    }

    if (this.metrics.errorRate > 10) {
      this.logger.warn('High error rate detected');
      this.emit('high-error-rate');
    }
  }

  /**
   * Start quality assurance processing timers
   */
  startQualityProcessingTimers() {
    // Quality buffer processing timer
    if (this.options.enableQualityScoring) {
      const qualityTimer = setInterval(() => {
        if (this.qualityBuffer.length > 0) {
          this.processQualityBuffer();
        }
      }, 10000); // Process every 10 seconds

      this.timers.set('quality-processing', qualityTimer);
    }

    // Profiling buffer processing timer
    if (this.options.enableDataProfiling) {
      const profilingTimer = setInterval(() => {
        if (this.profilingBuffer.length > 0) {
          this.processProfilingBuffer();
        }
      }, 30000); // Process every 30 seconds

      this.timers.set('profiling-processing', profilingTimer);
    }

    // Quality metrics cleanup timer
    const cleanupTimer = setInterval(() => {
      this.cleanupQualityBuffers();
    }, 300000); // Cleanup every 5 minutes

    this.timers.set('quality-cleanup', cleanupTimer);

    this.logger.info('Quality assurance processing timers started');
  }

  /**
   * Cleanup old quality data from buffers
   */
  cleanupQualityBuffers() {
    const cutoffTime = Date.now() - this.options.maxDataAge;

    // Clean quality metrics buffer
    this.qualityMetricsBuffer = this.qualityMetricsBuffer.filter(
      item => new Date(item.timestamp).getTime() > cutoffTime
    );

    // Clean quality buffer of old entries
    this.qualityBuffer = this.qualityBuffer.filter(
      item => item.bufferedAt > cutoffTime
    );

    // Clean profiling buffer of old entries
    this.profilingBuffer = this.profilingBuffer.filter(
      item => item.bufferedAt > cutoffTime
    );

    this.logger.debug('Quality assurance buffers cleaned up');
  }

  /**
   * Start data cleanup
   */
  startDataCleanup() {
    const timer = setInterval(() => {
      this.cleanupOldData();
    }, this.options.cleanupInterval);

    this.timers.set('data-cleanup', timer);
  }

  /**
   * Cleanup old data from buffers
   */
  cleanupOldData() {
    const cutoffTime = Date.now() - this.options.maxDataAge;

    // Clean anomaly buffer
    this.anomalyBuffer = this.anomalyBuffer.filter(
      item => new Date(item.detectedAt).getTime() > cutoffTime
    );

    // Clean alert buffer
    this.alertBuffer = this.alertBuffer.filter(
      item => new Date(item.generatedAt).getTime() > cutoffTime
    );

    this.logger.debug('Old data cleaned up');
  }

  /**
   * Load baseline data for anomaly detection
   */
  async loadBaselineData() {
    try {
      // This would load historical statistics from database
      // For now, use placeholder data
      this.baselineCalculated = true;
      this.logger.info('Baseline data loaded for anomaly detection');
    } catch (error) {
      this.logger.error('Error loading baseline data:', error);
    }
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    this.on('data-processed', () => {
      this.metrics.lastProcessedAt = new Date().toISOString();
    });
  }

  /**
   * Update latency metrics
   */
  updateLatencyMetrics(latency) {
    const count = this.metrics.dataPointsProcessed;
    this.metrics.averageLatency =
      (this.metrics.averageLatency * count + latency) / (count + 1);
  }

  /**
   * Update processing metrics
   */
  updateProcessingMetrics(processingTime) {
    this.metrics.dataPointsProcessed++;
  }

  /**
   * Get anomaly severity
   */
  getAnomalySeverity(deviation) {
    if (deviation > 5) return 'critical';
    if (deviation > 3) return 'high';
    if (deviation > 2) return 'medium';
    return 'low';
  }

  /**
   * Generate unique data ID
   */
  generateDataId(data) {
    const { location, timestamp, source } = data;
    return `realtime_${source}_${location.latitude}_${location.longitude}_${timestamp}`;
  }

  /**
   * Calculate data hash
   */
  calculateDataHash(data) {
    const crypto = require('crypto');
    const dataString = JSON.stringify(data, Object.keys(data).sort());
    return crypto.createHash('sha256').update(dataString).digest('hex');
  }

  /**
   * Stop streaming
   */
  async stopStreaming() {
    if (!this.isStreaming) {
      this.logger.warn('Stream processor is not running');
      return;
    }

    try {
      this.isStreaming = false;
      this.logger.info('Stopping real-time streaming...');

      // Clear all timers
      for (const [name, timer] of this.timers) {
        clearInterval(timer);
        this.logger.info(`Timer ${name} cleared`);
      }
      this.timers.clear();

      // Close WebSocket connections
      for (const [id, ws] of this.webSocketConnections) {
        ws.close();
        this.logger.info(`WebSocket ${id} closed`);
      }
      this.webSocketConnections.clear();

      // Process remaining data in buffer
      if (this.dataBuffer.length > 0) {
        await this.processDataBuffer();
      }

      this.metrics.activeConnections = 0;

      this.logger.info('Real-time streaming stopped');
      this.emit('streaming-stopped');
    } catch (error) {
      this.logger.error('Error stopping streaming:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get current metrics (enhanced with quality assurance data)
   */
  getMetrics() {
    return {
      ...this.metrics,
      bufferSizes: {
        data: this.dataBuffer.length,
        anomaly: this.anomalyBuffer.length,
        alert: this.alertBuffer.length,
        quality: this.qualityBuffer.length,
        profiling: this.profilingBuffer.length,
        qualityMetrics: this.qualityMetricsBuffer.length,
      },
      connections: {
        active: this.webSocketConnections.size,
        total: this.metrics.totalStreams,
      },

      // Quality Assurance metrics
      qualityAssurance: {
        enabled: this.options.enableQualityAssurance,
        totalAssessments: this.metrics.qualityAssessments,
        averageQualityScore: this.metrics.averageQualityScore,
        rejectedLowQuality: this.metrics.rejectedLowQuality,
        rejectionRate:
          this.metrics.qualityAssessments > 0
            ? (this.metrics.rejectedLowQuality /
                this.metrics.qualityAssessments) *
              100
            : 0,
        profilingOperations: this.metrics.profilingOperations,
        advancedAnomaliesDetected: this.metrics.advancedAnomaliesDetected,
        components: {
          qualityEngine: !!this.qualityEngine,
          profilingEngine: !!this.profilingEngine,
          anomalyDetectionEngine: !!this.anomalyDetectionEngine,
        },
      },
    };
  }

  /**
   * Get quality metrics summary
   */
  getQualityMetrics() {
    if (!this.options.enableQualityAssurance) {
      return { enabled: false };
    }

    const recentMetrics = this.qualityMetricsBuffer.slice(-10); // Last 10 metric periods

    return {
      enabled: true,
      currentMetrics: this.metrics,
      recentTrends: recentMetrics,
      qualityTrends: this.qualityEngine
        ? this.qualityEngine.getQualityTrends()
        : null,
      bufferStatus: {
        quality: this.qualityBuffer.length,
        profiling: this.profilingBuffer.length,
        processing: this.dataBuffer.length,
      },
    };
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      isStreaming: this.isStreaming,
      metrics: this.getMetrics(),
      activeTimers: Array.from(this.timers.keys()),
      activeConnections: Array.from(this.webSocketConnections.keys()),
    };
  }
}

module.exports = { RealTimeStreamProcessor };
