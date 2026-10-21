/**
 * Data Quality Controller for WRFCoin Weather Data Quality Pipeline
 *
 * Provides RESTful API endpoints for data quality operations including
 * profiling, anomaly detection, reporting, and real-time monitoring.
 *
 * @author WRFCoin Development Team
 * @version 1.0.0
 * @since 2025-07-12
 */

const DataProfilingEngine = require('../services/data-profiling-engine');
const AnomalyDetectionEngine = require('../services/anomaly-detection-engine');
const QualityReportingService = require('../services/quality-reporting-service');
const {
  getSharedAntiFraudQualityPipeline,
} = require('../services/anti-fraud-quality-pipeline');
const { logger } = require('../utils/logger');

class DataQualityController {
  constructor() {
    // Initialize services
    this.profilingEngine = new DataProfilingEngine({
      enableHistograms: true,
      temporalAnalysisWindow: 24,
      outlierThreshold: 3.0,
    });

    this.anomalyDetectionEngine = new AnomalyDetectionEngine({
      zScoreThreshold: 3.0,
      iqrMultiplier: 1.5,
      ensembleThreshold: 0.6,
      isolationForestContamination: 0.1,
    });

    this.reportingService = new QualityReportingService({
      reportFormats: ['json', 'html', 'csv'],
      alertThresholds: {
        completeness: 80,
        accuracy: 85,
        consistency: 90,
        timeliness: 95,
        anomalyRate: 5,
      },
      enableWebhookAlerts: true,
      alertCooldownMinutes: 60,
    });
    this.antiFraudPipeline = getSharedAntiFraudQualityPipeline();

    logger.info('DataQualityController initialized');
  }

  /**
   * Generate comprehensive data profile
   * POST /api/data-quality/profile
   */
  async generateProfile(req, res) {
    try {
      const { data, metadata = {} } = req.body;

      if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or empty data array provided',
        });
      }

      logger.info('Profile generation requested', {
        recordCount: data.length,
        metadata,
      });

      const profile = await this.profilingEngine.generateProfile(data, {
        ...metadata,
        requestedBy: req.user?.id || 'anonymous',
        requestedAt: new Date().toISOString(),
      });

      res.json({
        success: true,
        profile,
        message: 'Data profile generated successfully',
      });
    } catch (error) {
      logger.error('Profile generation failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Profile generation failed',
        details: error.message,
      });
    }
  }

  /**
   * Detect anomalies in weather data
   * POST /api/data-quality/anomalies
   */
  async detectAnomalies(req, res) {
    try {
      const { data, options = {} } = req.body;

      if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or empty data array provided',
        });
      }

      logger.info('Anomaly detection requested', {
        recordCount: data.length,
        options,
      });

      const results = await this.anomalyDetectionEngine.detectAnomalies(
        data,
        options
      );

      res.json({
        success: true,
        results,
        message: 'Anomaly detection completed successfully',
      });
    } catch (error) {
      logger.error('Anomaly detection failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Anomaly detection failed',
        details: error.message,
      });
    }
  }

  /**
   * Generate comprehensive quality report
   * POST /api/data-quality/report
   */
  async generateReport(req, res) {
    try {
      const { data, metadata = {}, format = 'json' } = req.body;

      if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or empty data array provided',
        });
      }

      logger.info('Quality report generation requested', {
        recordCount: data.length,
        format,
        metadata,
      });

      // Step 1: Generate data profile
      const profile = await this.profilingEngine.generateProfile(
        data,
        metadata
      );

      // Step 2: Detect anomalies
      const anomalies = await this.anomalyDetectionEngine.detectAnomalies(data);

      // Step 3: Combine results for comprehensive quality data
      const qualityData = {
        ...profile,
        anomalies: anomalies.anomalies,
        recommendations: anomalies.recommendations,
      };

      // Step 4: Generate report
      const reportResult = await this.reportingService.generateQualityReport(
        qualityData,
        {
          ...metadata,
          requestedBy: req.user?.id || 'anonymous',
          requestedAt: new Date().toISOString(),
        },
        format
      );

      // Set appropriate content type for different formats
      if (format === 'html') {
        res.set('Content-Type', 'text/html');
        res.send(reportResult.formatted);
      } else if (format === 'csv') {
        res.set('Content-Type', 'text/csv');
        res.set(
          'Content-Disposition',
          `attachment; filename="quality-report-${reportResult.reportId}.csv"`
        );
        res.send(reportResult.formatted);
      } else {
        res.json({
          success: true,
          report: reportResult.report,
          reportId: reportResult.reportId,
          message: 'Quality report generated successfully',
        });
      }
    } catch (error) {
      logger.error('Quality report generation failed', {
        error: error.message,
      });
      res.status(500).json({
        success: false,
        error: 'Quality report generation failed',
        details: error.message,
      });
    }
  }

  /**
   * Run comprehensive quality analysis (profile + anomalies + report)
   * POST /api/data-quality/analyze
   */
  async analyzeQuality(req, res) {
    try {
      const { data, metadata = {}, options = {} } = req.body;

      if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or empty data array provided',
        });
      }

      logger.info('Comprehensive quality analysis requested', {
        recordCount: data.length,
        metadata,
        options,
      });

      const analysisStart = Date.now();

      // Step 1: Data profiling
      const profile = await this.profilingEngine.generateProfile(
        data,
        metadata
      );

      // Step 2: Anomaly detection
      const anomalies = await this.anomalyDetectionEngine.detectAnomalies(
        data,
        options
      );

      // Step 3: Combine results
      const qualityData = {
        ...profile,
        anomalies: anomalies.anomalies,
        recommendations: anomalies.recommendations,
      };

      // Step 4: Generate lightweight report
      const reportResult = await this.reportingService.generateQualityReport(
        qualityData,
        {
          ...metadata,
          requestedBy: req.user?.id || 'anonymous',
          requestedAt: new Date().toISOString(),
        },
        'json'
      );

      const analysisTime = Date.now() - analysisStart;

      res.json({
        success: true,
        analysis: {
          profile: profile,
          anomalies: anomalies,
          report: reportResult.report,
          reportId: reportResult.reportId,
          processingTimeMs: analysisTime,
        },
        message: 'Comprehensive quality analysis completed successfully',
      });
    } catch (error) {
      logger.error('Quality analysis failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Quality analysis failed',
        details: error.message,
      });
    }
  }

  /**
   * Get dashboard data for real-time monitoring
   * GET /api/data-quality/dashboard
   */
  async getDashboard(req, res) {
    try {
      const dashboardData = this.reportingService.getDashboardData();

      res.json({
        success: true,
        dashboard: dashboardData,
        message: 'Dashboard data retrieved successfully',
      });
    } catch (error) {
      logger.error('Dashboard data retrieval failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Dashboard data retrieval failed',
        details: error.message,
      });
    }
  }

  /**
   * Get sanitized anti-fraud risk status
   * GET /api/data-quality/risk-status
   */
  async getRiskStatus(req, res) {
    try {
      const riskStatus = this.antiFraudPipeline.getPublicRiskStatus();
      res.json({
        success: true,
        riskStatus,
        message: 'Risk status retrieved successfully',
      });
    } catch (error) {
      logger.error('Risk status retrieval failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Risk status retrieval failed',
      });
    }
  }

  /**
   * List sanitized anti-fraud audit events
   * GET /api/data-quality/risk-events
   */
  async getRiskEvents(req, res) {
    try {
      const requestedLimit = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 100)
        : 20;
      const events = this.antiFraudPipeline.getPublicAuditEvents(limit);

      res.json({
        success: true,
        events,
        count: events.length,
        message: 'Risk events retrieved successfully',
      });
    } catch (error) {
      logger.error('Risk events retrieval failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Risk events retrieval failed',
      });
    }
  }

  /**
   * Get stored report by ID
   * GET /api/data-quality/reports/:reportId
   */
  async getReport(req, res) {
    try {
      const { reportId } = req.params;
      const { format = 'json' } = req.query;

      const report = this.reportingService.getReport(reportId);

      if (!report) {
        return res.status(404).json({
          success: false,
          error: 'Report not found',
        });
      }

      // Format report if different format requested
      if (format !== 'json') {
        const formattedReport = await this.reportingService._formatReport(
          report,
          format
        );

        if (format === 'html') {
          res.set('Content-Type', 'text/html');
          res.send(formattedReport);
        } else if (format === 'csv') {
          res.set('Content-Type', 'text/csv');
          res.set(
            'Content-Disposition',
            `attachment; filename="quality-report-${reportId}.csv"`
          );
          res.send(formattedReport);
        } else {
          res.send(formattedReport);
        }
      } else {
        res.json({
          success: true,
          report,
          message: 'Report retrieved successfully',
        });
      }
    } catch (error) {
      logger.error('Report retrieval failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Report retrieval failed',
        details: error.message,
      });
    }
  }

  /**
   * List recent reports
   * GET /api/data-quality/reports
   */
  async listReports(req, res) {
    try {
      const { limit = 10 } = req.query;

      const reports = this.reportingService.listReports(parseInt(limit, 10));

      res.json({
        success: true,
        reports,
        count: reports.length,
        message: 'Reports listed successfully',
      });
    } catch (error) {
      logger.error('Report listing failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Report listing failed',
        details: error.message,
      });
    }
  }

  /**
   * Get quality metrics for specific parameters
   * POST /api/data-quality/metrics
   */
  async getQualityMetrics(req, res) {
    try {
      const { data, parameters = [] } = req.body;

      if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or empty data array provided',
        });
      }

      logger.info('Quality metrics requested', {
        recordCount: data.length,
        parameters,
      });

      // Generate focused profile for specific parameters
      const profile = await this.profilingEngine.generateProfile(data, {
        focusParameters: parameters,
      });

      // Extract metrics
      const metrics = {
        completeness: {},
        accuracy: {},
        consistency: {},
        distribution: {},
      };

      // Completeness metrics
      if (profile.completeness?.byParameter) {
        Object.entries(profile.completeness.byParameter).forEach(
          ([param, data]) => {
            if (parameters.length === 0 || parameters.includes(param)) {
              metrics.completeness[param] = {
                percentage: data.completenessPercentage,
                missingCount: data.missingCount,
                validCount: data.validCount,
              };
            }
          }
        );
      }

      // Statistical metrics
      if (profile.statistical) {
        Object.entries(profile.statistical).forEach(([param, stats]) => {
          if (parameters.length === 0 || parameters.includes(param)) {
            metrics.distribution[param] = {
              mean: stats.mean,
              median: stats.median,
              standardDeviation: stats.standardDeviation,
              range: { min: stats.min, max: stats.max },
              outlierCount: stats.outliers?.zScore?.count || 0,
              outlierPercentage: stats.outliers?.zScore?.percentage || 0,
            };
          }
        });
      }

      res.json({
        success: true,
        metrics,
        summary: {
          parametersAnalyzed: Object.keys(metrics.distribution),
          totalRecords: data.length,
          profiledAt: profile.metadata?.profiledAt,
        },
        message: 'Quality metrics calculated successfully',
      });
    } catch (error) {
      logger.error('Quality metrics calculation failed', {
        error: error.message,
      });
      res.status(500).json({
        success: false,
        error: 'Quality metrics calculation failed',
        details: error.message,
      });
    }
  }

  /**
   * Validate data against quality thresholds
   * POST /api/data-quality/validate
   */
  async validateQuality(req, res) {
    try {
      const { data, thresholds = {}, metadata = {} } = req.body;

      if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or empty data array provided',
        });
      }

      const defaultThresholds = {
        completeness: 85,
        accuracy: 90,
        consistency: 95,
        maxAnomalyRate: 3,
      };

      const finalThresholds = { ...defaultThresholds, ...thresholds };

      logger.info('Quality validation requested', {
        recordCount: data.length,
        thresholds: finalThresholds,
      });

      // Generate profile and detect anomalies
      const profile = await this.profilingEngine.generateProfile(
        data,
        metadata
      );
      const anomalies = await this.anomalyDetectionEngine.detectAnomalies(data);

      // Validation results
      const validation = {
        passed: true,
        scores: {},
        violations: [],
        anomalyRate: 0,
        summary: {},
      };

      // Check quality scores
      if (profile.quality?.scores) {
        const scores = profile.quality.scores;
        validation.scores = {
          completeness: scores.completeness?.score || 0,
          accuracy: scores.accuracy?.score || 0,
          consistency: scores.consistency?.score || 0,
        };

        // Check violations
        Object.entries(validation.scores).forEach(([metric, score]) => {
          if (score < finalThresholds[metric]) {
            validation.passed = false;
            validation.violations.push({
              metric,
              score,
              threshold: finalThresholds[metric],
              severity:
                score < finalThresholds[metric] * 0.8 ? 'high' : 'medium',
            });
          }
        });
      }

      // Check anomaly rate
      if (anomalies.anomalies?.ensemble?.summary?.total) {
        validation.anomalyRate =
          (anomalies.anomalies.ensemble.summary.total / data.length) * 100;

        if (validation.anomalyRate > finalThresholds.maxAnomalyRate) {
          validation.passed = false;
          validation.violations.push({
            metric: 'anomalyRate',
            score: validation.anomalyRate,
            threshold: finalThresholds.maxAnomalyRate,
            severity:
              validation.anomalyRate > finalThresholds.maxAnomalyRate * 2
                ? 'high'
                : 'medium',
          });
        }
      }

      validation.summary = {
        recordsValidated: data.length,
        violationCount: validation.violations.length,
        highSeverityViolations: validation.violations.filter(
          v => v.severity === 'high'
        ).length,
        overallScore: profile.quality?.overallScore || 0,
      };

      res.json({
        success: true,
        validation,
        message: validation.passed
          ? 'Data quality validation passed'
          : 'Data quality validation failed',
      });
    } catch (error) {
      logger.error('Quality validation failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Quality validation failed',
        details: error.message,
      });
    }
  }

  /**
   * Subscribe to real-time quality updates
   * GET /api/data-quality/stream (WebSocket endpoint)
   */
  streamQualityUpdates(ws, req) {
    try {
      logger.info('Quality stream subscription started');

      // Subscribe to reporting service updates
      const unsubscribe = this.reportingService.subscribe(update => {
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'quality_update',
              timestamp: new Date().toISOString(),
              data: update,
            })
          );
        }
      });

      // Send initial dashboard data
      const dashboardData = this.reportingService.getDashboardData();
      ws.send(
        JSON.stringify({
          type: 'initial_data',
          timestamp: new Date().toISOString(),
          data: dashboardData,
        })
      );

      // Handle client disconnect
      ws.on('close', () => {
        unsubscribe();
        logger.info('Quality stream subscription ended');
      });

      ws.on('error', error => {
        logger.error('Quality stream error', { error: error.message });
        unsubscribe();
      });
    } catch (error) {
      logger.error('Quality stream setup failed', { error: error.message });
      if (ws.readyState === ws.OPEN) {
        ws.close(1011, 'Stream setup failed');
      }
    }
  }

  /**
   * Health check endpoint
   * GET /api/data-quality/health
   */
  async healthCheck(req, res) {
    try {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
          profilingEngine: 'ready',
          anomalyDetectionEngine: 'ready',
          reportingService: 'ready',
          antiFraudPipeline: 'ready',
        },
        metrics: {
          cachedProfiles: this.profilingEngine.profiles.size,
          cachedReports: this.reportingService.reports.size,
          activeSubscriptions: this.reportingService.subscriptions.size,
          antiFraudEvaluated:
            this.antiFraudPipeline.getPublicRiskStatus().totalEvaluated,
        },
      };

      res.json({
        success: true,
        health,
        message: 'Data quality service is healthy',
      });
    } catch (error) {
      logger.error('Health check failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Health check failed',
        details: error.message,
      });
    }
  }
}

module.exports = DataQualityController;
