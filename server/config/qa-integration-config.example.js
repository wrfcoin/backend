/**
 * Quality Assurance Integration Configuration Example
 *
 * This file shows how to configure the integrated quality assurance pipeline
 * with the real-time data ingestion system. Copy this file to your project
 * configuration and customize the settings according to your needs.
 */

module.exports = {
  // Core Real-time Stream Processor Settings
  realTimeStreamProcessor: {
    // Basic streaming configuration
    noaaPollingInterval: 300000, // 5 minutes
    stationPollingInterval: 60000, // 1 minute
    healthCheckInterval: 30000, // 30 seconds

    // Legacy validation and anomaly detection
    enableRealTimeValidation: true,
    enableAnomalyDetection: true,
    enableAlerts: true,

    // Quality Assurance Pipeline Integration (NEW)
    enableQualityAssurance: true,
    enableQualityScoring: true,
    enableDataProfiling: true,
    enableAdvancedAnomalyDetection: true,

    // Quality thresholds and parameters
    minimumQualityScore: 0.7, // Reject data below this score (0.0-1.0)
    qualityThreshold: 0.6, // Legacy quality threshold
    anomalyThreshold: 2.5, // Standard deviations for statistical anomalies
    anomalyEnsembleThreshold: 0.6, // Ensemble agreement threshold

    // Buffer and processing settings
    dataBufferSize: 100, // Number of items in main data buffer
    profilingBatchSize: 50, // Batch size for data profiling

    // Performance and retention
    maxDataAge: 86400000, // 24 hours
    cleanupInterval: 3600000, // 1 hour
    maxConcurrentStreams: 10,
    connectionTimeout: 10000,
  },

  // Data Quality Engine Configuration
  dataQualityEngine: {
    // Quality scoring weights (must sum to 1.0)
    completenessWeight: 0.25,
    accuracyWeight: 0.35,
    consistencyWeight: 0.25,
    timelinessWeight: 0.15,

    // Quality thresholds
    minimumQualityScore: 0.6,
    outlierThreshold: 2.5,

    // Enrichment settings
    enableDerivedParameters: true,
    enableSpatialInterpolation: true,
    enableTemporalSmoothing: true,

    // Cross-validation settings
    enableCrossValidation: true,
    maxValidationDistance: 50000, // 50km
    maxValidationTime: 3600000, // 1 hour

    // Performance settings
    maxCacheSize: 1000,
    cacheExpiryTime: 300000, // 5 minutes
  },

  // Data Profiling Engine Configuration
  dataProfilingEngine: {
    enableHistograms: true,
    histogramBins: 50,
    temporalAnalysisWindow: 30, // days
    outlierThreshold: 3.0, // standard deviations
    seasonalPeriods: [365.25, 365.25 / 2, 365.25 / 4], // annual, semi-annual, quarterly
  },

  // Advanced Anomaly Detection Engine Configuration
  anomalyDetectionEngine: {
    // Statistical detection parameters
    zScoreThreshold: 3.0,
    iqrMultiplier: 1.5,
    modifiedZScoreThreshold: 3.5,

    // Machine learning parameters
    isolationForestContamination: 0.1,
    localOutlierFactor: 20,

    // Temporal detection parameters
    windowSize: 24, // hours for rolling statistics
    seasonalDecomposition: true,

    // Ensemble parameters
    ensembleThreshold: 0.6, // Fraction of methods that must agree

    // Context-aware parameters
    locationContext: true,
    temporalContext: true,
  },

  // Integration-specific settings
  integration: {
    // Event handling
    enableQualityEventLogging: true,
    enableAnomalyEventLogging: true,
    enableProfilingEventLogging: true,

    // Metrics and monitoring
    enableQualityMetrics: true,
    metricsAggregationInterval: 300000, // 5 minutes

    // Database storage
    storeQualityMetadata: true,
    storeEnrichmentResults: true,
    storeAnomalyResults: true,

    // Processing priorities
    prioritizeQualityOverSpeed: false,
    asyncQualityProcessing: true,

    // Fallback behavior
    continueOnQualityFailure: true,
    continueOnAnomalyFailure: true,
    continueOnProfilingFailure: true,
  },

  // Environment-specific overrides
  environments: {
    development: {
      // More verbose logging and lower thresholds for testing
      dataQualityEngine: {
        minimumQualityScore: 0.4, // Lower threshold for dev testing
      },
      realTimeStreamProcessor: {
        profilingBatchSize: 5, // Smaller batches for faster testing
        enableQualityAssurance: true,
      },
      integration: {
        enableQualityEventLogging: true,
        enableAnomalyEventLogging: true,
        enableProfilingEventLogging: true,
      },
    },

    production: {
      // Optimized for performance and reliability
      dataQualityEngine: {
        minimumQualityScore: 0.8, // Higher threshold for production
        maxCacheSize: 5000, // Larger cache for better performance
      },
      realTimeStreamProcessor: {
        profilingBatchSize: 100, // Larger batches for efficiency
        enableQualityAssurance: true,
      },
      integration: {
        enableQualityEventLogging: false, // Reduce logging overhead
        asyncQualityProcessing: true,
        prioritizeQualityOverSpeed: false,
      },
    },

    testing: {
      // Configuration for automated testing
      dataQualityEngine: {
        minimumQualityScore: 0.5,
        cacheExpiryTime: 10000, // Shorter cache for testing
      },
      realTimeStreamProcessor: {
        profilingBatchSize: 3, // Very small batches for unit tests
        healthCheckInterval: 5000, // Faster health checks
      },
      integration: {
        enableQualityEventLogging: true,
        continueOnQualityFailure: true,
      },
    },
  },
};

/**
 * Usage Example:
 *
 * const config = require('./qa-integration-config');
 * const environment = process.env.NODE_ENV || 'development';
 * const envConfig = config.environments[environment] || {};
 *
 * // Merge environment-specific overrides
 * const streamProcessorConfig = {
 *     ...config.realTimeStreamProcessor,
 *     ...envConfig.realTimeStreamProcessor
 * };
 *
 * const qualityEngineConfig = {
 *     ...config.dataQualityEngine,
 *     ...envConfig.dataQualityEngine
 * };
 *
 * // Initialize with merged configuration
 * const streamProcessor = new RealTimeStreamProcessor(streamProcessorConfig);
 */

/**
 * Configuration Guidelines:
 *
 * 1. Quality Score Thresholds:
 *    - 0.9+: Excellent quality (production-ready)
 *    - 0.7-0.9: Good quality (acceptable for most uses)
 *    - 0.5-0.7: Fair quality (may need additional validation)
 *    - <0.5: Poor quality (reject or flag for manual review)
 *
 * 2. Anomaly Detection Sensitivity:
 *    - Lower ensemble thresholds (0.4-0.6): More sensitive, higher false positives
 *    - Higher ensemble thresholds (0.7-0.9): Less sensitive, lower false positives
 *
 * 3. Profiling Batch Sizes:
 *    - Smaller batches (5-20): Faster feedback, more frequent profiling
 *    - Larger batches (50-200): More efficient, better statistical power
 *
 * 4. Performance Considerations:
 *    - Enable async processing for better throughput
 *    - Adjust cache sizes based on available memory
 *    - Use appropriate cleanup intervals to prevent memory leaks
 *
 * 5. Monitoring and Alerting:
 *    - Monitor rejection rates to detect systematic quality issues
 *    - Track profiling results for data source health
 *    - Set up alerts for high anomaly detection rates
 */
