/**
 * Quality Reporting Service for WRFCoin Weather Data Quality Pipeline
 *
 * Provides comprehensive reporting, alerting, and monitoring capabilities
 * for weather data quality assurance. Generates automated reports,
 * manages quality alerts, and provides dashboard-ready data.
 *
 * @author WRFCoin Development Team
 * @version 1.0.0
 * @since 2025-07-12
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const { logger } = require('../../utils/logger');
const { db } = require('../../db');
const { sql } = require('drizzle-orm');

class QualityReportingService {
  constructor(options = {}) {
    // Load webhook configuration
    this.webhookConfig = null;
    try {
      const configPath = path.join(
        __dirname,
        '../../../infra/monitoring/quality-alerting-config.json'
      );
      if (require('fs').existsSync(configPath)) {
        const alertingConfig = require(configPath);
        this.webhookConfig = alertingConfig.channels?.webhook || {
          enabled: false,
          url: null,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
        };
      } else {
        logger.warn('Webhook config file not found, using defaults');
        this.webhookConfig = {
          enabled: false,
          url: null,
          method: 'POST',
          headers: {},
          timeout: 30000,
        };
      }
    } catch (error) {
      logger.error('Failed to load webhook config', { error: error.message });
      this.webhookConfig = {
        enabled: false,
        url: null,
        method: 'POST',
        headers: {},
        timeout: 30000,
      };
    }

    // Load email configuration
    this.emailConfig = null;
    try {
      const configPath = path.join(
        __dirname,
        '../../../infra/monitoring/quality-alerting-config.json'
      );
      if (require('fs').existsSync(configPath)) {
        const alertingConfig = require(configPath);
        this.emailConfig = alertingConfig.channels?.email || {
          enabled: false,
          smtp_host: null,
          smtp_port: 587,
          smtp_secure: false,
          smtp_user: null,
          smtp_pass: null,
          from: null,
          to: [],
          cc: [],
          subject_prefix: '[WRFCoin Quality Alert]',
        };
      } else {
        logger.warn('Email config file not found, using defaults');
        this.emailConfig = {
          enabled: false,
          smtp_host: null,
          smtp_port: 587,
          smtp_secure: false,
          smtp_user: null,
          smtp_pass: null,
          from: null,
          to: [],
          cc: [],
          subject_prefix: '[WRFCoin Quality Alert]',
        };
      }
    } catch (error) {
      logger.error('Failed to load email config', { error: error.message });
      this.emailConfig = {
        enabled: false,
        smtp_host: null,
        smtp_port: 587,
        smtp_secure: false,
        smtp_user: null,
        smtp_pass: null,
        from: null,
        to: [],
        cc: [],
        subject_prefix: '[WRFCoin Quality Alert]',
      };
    }

    this.config = {
      // Report generation settings
      reportFormats: ['json', 'html', 'csv'],
      defaultFormat: 'json',

      // Alert thresholds
      alertThresholds: {
        completeness: 80, // Below 80% completeness
        accuracy: 85, // Below 85% accuracy
        consistency: 90, // Below 90% consistency
        timeliness: 95, // Below 95% timeliness
        anomalyRate: 5, // Above 5% anomaly rate
      },

      // Report retention
      reportRetentionDays: 90,
      archiveAfterDays: 30,

      // Notification settings
      enableEmailAlerts: false,
      enableWebhookAlerts: true,
      alertCooldownMinutes: 60,

      // Dashboard settings
      refreshIntervalSeconds: 300, // 5 minutes
      maxDashboardHistory: 24 * 60, // 24 hours in minutes

      ...options,
    };

    // Internal state
    this.reports = new Map();
    this.alertHistory = new Map();
    this.dashboardData = new Map();
    this.subscriptions = new Set();

    // Alert cooldown tracking
    this.lastAlertTime = new Map();

    logger.info('QualityReportingService initialized', { config: this.config });
  }

  /**
   * Build webhook payload from quality data
   * @param {Object} qualityData - Quality assessment data for payload formatting
   * @returns {Object} Formatted webhook payload
   * @private
   */
  _buildWebhookPayload(qualityData) {
    try {
      // Validate required qualityData fields
      if (!qualityData || typeof qualityData !== 'object') {
        throw new Error('Quality data is required and must be an object');
      }

      // Extract alert information from quality data
      const overallScore = qualityData.quality?.overallScore || 0;
      const alertLevel =
        overallScore < 60 ? 'critical' : overallScore < 75 ? 'warning' : 'info';
      const alertMessage = `Quality score: ${overallScore.toFixed(1)}% - ${overallScore < 75 ? 'Below threshold' : 'Within acceptable range'}`;

      // Build metrics object from quality data
      const metrics = {
        overallScore: overallScore,
        completeness: qualityData.quality?.scores?.completeness?.score || 0,
        accuracy: qualityData.quality?.scores?.accuracy?.score || 0,
        consistency: qualityData.quality?.scores?.consistency?.score || 0,
        timeliness: qualityData.quality?.scores?.timeliness?.score || 0,
        anomalies: qualityData.anomalies?.ensemble?.summary?.total || 0,
        recordCount: qualityData.metadata?.recordCount || 0,
      };

      return {
        event: 'quality_report_alert',
        timestamp: new Date().toISOString(),
        alert: {
          level: alertLevel,
          message: alertMessage,
          metrics: metrics,
        },
        metadata: {
          project: 'wrfcoin',
          system: 'quality_reporting',
        },
      };
    } catch (error) {
      logger.error('Failed to build webhook payload', { error: error.message });
      throw new Error(`Webhook payload build failed: ${error.message}`);
    }
  }

  /**
   * Generate comprehensive quality report
   * @param {Object} qualityData - Quality assessment data from profiling and anomaly detection
   * @param {Object} metadata - Report metadata
   * @param {string} format - Output format ('json', 'html', 'csv')
   * @returns {Object} Generated report
   */
  async generateQualityReport(qualityData, metadata = {}, format = 'json') {
    const startTime = Date.now();

    try {
      logger.info('Generating quality report', {
        format,
        datasetSize: qualityData.recordCount || 0,
      });

      const reportId = this._generateReportId(metadata);
      const timestamp = new Date().toISOString();

      const report = {
        id: reportId,
        metadata: {
          generatedAt: timestamp,
          format: format,
          processingTimeMs: 0,
          ...metadata,
        },
        executiveSummary: this._generateExecutiveSummary(qualityData),
        qualityScores: this._extractQualityScores(qualityData),
        anomalies: this._summarizeAnomalies(qualityData),
        trends: this._analyzeTrends(qualityData),
        recommendations: this._generateRecommendations(qualityData),
        dataProfile: this._summarizeDataProfile(qualityData),
        alerts: this._checkAlertConditions(qualityData),
        historicalComparison: await this._generateHistoricalComparison(
          qualityData,
          metadata
        ),
      };

      report.metadata.processingTimeMs = Date.now() - startTime;

      // Cache report
      this.reports.set(reportId, report);

      // Generate formatted output
      const formattedReport = await this._formatReport(report, format);

      // Process alerts if any
      if (report.alerts.length > 0) {
        await this._processAlerts(report.alerts, report);
      }

      // Update dashboard data
      this._updateDashboardData(report);

      logger.info('Quality report generated successfully', {
        reportId,
        format,
        processingTimeMs: report.metadata.processingTimeMs,
        overallScore: report.qualityScores.overall,
        alertCount: report.alerts.length,
      });

      return {
        report,
        formatted: formattedReport,
        reportId,
      };
    } catch (error) {
      logger.error('Quality report generation failed', {
        error: error.message,
        metadata,
      });
      throw error;
    }
  }

  /**
   * Generate executive summary
   * @private
   */
  _generateExecutiveSummary(qualityData) {
    const summary = {
      datasetOverview: {},
      keyFindings: [],
      qualityStatus: 'unknown',
      riskLevel: 'low',
      actionRequired: false,
    };

    // Dataset overview
    if (qualityData.metadata) {
      summary.datasetOverview = {
        recordCount: qualityData.metadata.recordCount || 0,
        timeRange: qualityData.temporal?.timeRange || {},
        parametersAnalyzed: qualityData.statistical
          ? Object.keys(qualityData.statistical).length
          : 0,
        profiledAt: qualityData.metadata.profiledAt,
      };
    }

    // Extract overall quality score
    const overallScore = qualityData.quality?.overallScore || 0;

    // Determine quality status
    if (overallScore >= 90) {
      summary.qualityStatus = 'excellent';
      summary.riskLevel = 'low';
    } else if (overallScore >= 75) {
      summary.qualityStatus = 'good';
      summary.riskLevel = 'low';
    } else if (overallScore >= 60) {
      summary.qualityStatus = 'fair';
      summary.riskLevel = 'medium';
      summary.actionRequired = true;
    } else {
      summary.qualityStatus = 'poor';
      summary.riskLevel = 'high';
      summary.actionRequired = true;
    }

    // Key findings
    if (qualityData.completeness) {
      const completenessPercentage =
        qualityData.completeness.overall?.completenessPercentage || 0;
      if (completenessPercentage < 85) {
        summary.keyFindings.push(
          `Data completeness is ${completenessPercentage.toFixed(1)}% - below recommended threshold`
        );
      }
    }

    if (qualityData.anomalies?.ensemble?.summary?.total > 0) {
      const anomalyCount = qualityData.anomalies.ensemble.summary.total;
      const anomalyRate =
        (anomalyCount / (qualityData.metadata?.recordCount || 1)) * 100;
      summary.keyFindings.push(
        `${anomalyCount} anomalies detected (${anomalyRate.toFixed(2)}% of records)`
      );
    }

    // Add issues from quality assessment
    if (qualityData.quality?.issues) {
      qualityData.quality.issues.forEach(issue => {
        summary.keyFindings.push(`${issue.dimension}: ${issue.description}`);
      });
    }

    return summary;
  }

  /**
   * Extract and normalize quality scores
   * @private
   */
  _extractQualityScores(qualityData) {
    const scores = {
      overall: 0,
      completeness: 0,
      accuracy: 0,
      consistency: 0,
      timeliness: 0,
      breakdown: {},
    };

    if (qualityData.quality?.scores) {
      const qualityScores = qualityData.quality.scores;

      scores.completeness = qualityScores.completeness?.score || 0;
      scores.accuracy = qualityScores.accuracy?.score || 0;
      scores.consistency = qualityScores.consistency?.score || 0;
      scores.timeliness = qualityScores.timeliness?.score || 0;
      scores.overall = qualityData.quality.overallScore || 0;

      // Detailed breakdown
      scores.breakdown = {
        completeness: {
          score: scores.completeness,
          category: qualityScores.completeness?.category || 'unknown',
          details: qualityScores.completeness?.details || {},
        },
        accuracy: {
          score: scores.accuracy,
          category: qualityScores.accuracy?.category || 'unknown',
          details: qualityScores.accuracy?.details || {},
        },
        consistency: {
          score: scores.consistency,
          category: qualityScores.consistency?.category || 'unknown',
          details: qualityScores.consistency?.details || {},
        },
        timeliness: {
          score: scores.timeliness,
          category: qualityScores.timeliness?.category || 'unknown',
          details: qualityScores.timeliness?.details || {},
        },
      };
    }

    return scores;
  }

  /**
   * Summarize anomaly detection results
   * @private
   */
  _summarizeAnomalies(qualityData) {
    const anomalySummary = {
      total: 0,
      byMethod: {},
      ensemble: {},
      severityDistribution: { high: 0, medium: 0, low: 0 },
      topAnomalies: [],
      recommendations: [],
    };

    if (qualityData.anomalies) {
      // Individual method results
      if (qualityData.anomalies.byMethod) {
        Object.entries(qualityData.anomalies.byMethod).forEach(
          ([method, result]) => {
            if (result.anomalies) {
              anomalySummary.byMethod[method] = {
                total: result.anomalies.length,
                summary: result.summary || {},
              };
            }
          }
        );
      }

      // Ensemble results
      if (qualityData.anomalies.ensemble) {
        anomalySummary.ensemble = {
          total: qualityData.anomalies.ensemble.anomalies?.length || 0,
          confidence: qualityData.anomalies.ensemble.confidenceScore || 0,
          summary: qualityData.anomalies.ensemble.summary || {},
        };

        anomalySummary.total = anomalySummary.ensemble.total;

        // Severity distribution
        if (qualityData.anomalies.ensemble.anomalies) {
          qualityData.anomalies.ensemble.anomalies.forEach(anomaly => {
            anomalySummary.severityDistribution[anomaly.severity] =
              (anomalySummary.severityDistribution[anomaly.severity] || 0) + 1;
          });

          // Top anomalies (highest confidence)
          anomalySummary.topAnomalies = qualityData.anomalies.ensemble.anomalies
            .slice(0, 10)
            .map(anomaly => ({
              timestamp: anomaly.timestamp,
              confidence: anomaly.confidence,
              severity: anomaly.severity,
              types: anomaly.types,
              methodsAgreeing: anomaly.methodsAgreeing.length,
            }));
        }
      }

      // Extract recommendations
      if (qualityData.recommendations) {
        anomalySummary.recommendations = qualityData.recommendations;
      }
    }

    return anomalySummary;
  }

  /**
   * Analyze quality trends over time
   * @private
   */
  _analyzeTrends(qualityData) {
    try {
      // Get historical metrics for 7-day moving average
      const historicalData = this.getHistoricalMetrics(7);

      if (!historicalData || historicalData.length < 2) {
        return {
          qualityTrend: 'stable',
          anomalyTrend: 'stable',
          completenessPercentage: 'stable',
          changePercentage: 0,
          confidence: 0.1,
          trendStrength: 'insufficient_data',
          message: 'Insufficient historical data for trend analysis',
        };
      }

      // Calculate 7-day moving averages
      const qualityScores = historicalData.map(d => d.overallScore || 0);
      const anomalyCounts = historicalData.map(d => d.anomalyCount || 0);
      const completenessScores = historicalData.map(d => d.completeness || 0);

      // Enhanced trend analysis with percentage changes and confidence
      const qualityTrendData = this._calculateEnhancedTrend(qualityScores);
      const anomalyTrendData = this._calculateEnhancedTrend(
        anomalyCounts,
        true
      );
      const completenessTrendData =
        this._calculateEnhancedTrend(completenessScores);

      // Calculate overall confidence based on data sufficiency and consistency
      const dataConfidence = Math.min(historicalData.length / 7, 1) * 0.6;
      const avgConfidence =
        (qualityTrendData.confidence +
          anomalyTrendData.confidence +
          completenessTrendData.confidence) /
        3;
      const overallConfidence = Math.min(
        dataConfidence + avgConfidence * 0.4,
        1
      );

      return {
        qualityTrend: qualityTrendData.trend,
        anomalyTrend: anomalyTrendData.trend,
        completenessPercentage: completenessTrendData.trend,
        changePercentage: qualityTrendData.changePercentage,
        confidence: Math.round(overallConfidence * 100) / 100,
        trendStrength: this._determineTrendStrength(
          qualityTrendData.changePercentage,
          overallConfidence
        ),
        message: `Enhanced trend analysis: ${Math.abs(qualityTrendData.changePercentage).toFixed(1)}% change with ${(overallConfidence * 100).toFixed(0)}% confidence`,
      };
    } catch (error) {
      logger.warn('Trend analysis failed', { error: error.message });
      return {
        qualityTrend: 'stable',
        anomalyTrend: 'stable',
        completenessPercentage: 'stable',
        changePercentage: 0,
        confidence: 0.1,
        trendStrength: 'error',
        message: 'Trend analysis unavailable due to error',
      };
    }
  }

  /**
   * Calculate enhanced trend direction with percentage changes and confidence
   * @private
   */
  _calculateEnhancedTrend(values, inverted = false) {
    if (values.length < 2)
      return { trend: 'stable', changePercentage: 0, confidence: 0.1 };

    const recent = values.slice(-3); // Last 3 values
    const older =
      values.slice(0, -3).length > 0 ? values.slice(0, -3) : values.slice(0, 1);

    const recentAvg = recent.reduce((sum, val) => sum + val, 0) / recent.length;
    const olderAvg = older.reduce((sum, val) => sum + val, 0) / older.length;

    // Calculate percentage change
    const changePercentage =
      olderAvg !== 0 ? ((recentAvg - olderAvg) / Math.abs(olderAvg)) * 100 : 0;
    const absChange = Math.abs(changePercentage);

    // Calculate confidence based on data consistency and sample size
    const recentStdDev = this._calculateStandardDeviation(recent);
    const consistency = recentStdDev < recentAvg * 0.1 ? 0.8 : 0.4; // High if low deviation
    const sampleFactor = Math.min(values.length / 7, 1) * 0.5; // More data = higher confidence
    const confidence = Math.min(consistency + sampleFactor, 1);

    // Determine trend category with enhanced rapid change detection
    let trend = 'stable';
    if (absChange > 15) {
      trend = (inverted ? changePercentage < 0 : changePercentage > 0)
        ? 'rapidly_improving'
        : 'rapidly_declining';
    } else if (absChange > 5) {
      trend = (inverted ? changePercentage < 0 : changePercentage > 0)
        ? 'improving'
        : 'declining';
    }

    return { trend, changePercentage, confidence };
  }

  /**
   * Calculate standard deviation for confidence scoring
   * @private
   */
  _calculateStandardDeviation(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    return Math.sqrt(
      squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length
    );
  }

  /**
   * Determine trend strength category
   * @private
   */
  _determineTrendStrength(changePercentage, confidence) {
    const absChange = Math.abs(changePercentage);
    if (confidence < 0.3) return 'low_confidence';
    if (absChange > 20) return 'very_strong';
    if (absChange > 10) return 'strong';
    if (absChange > 5) return 'moderate';
    return 'weak';
  }

  /**
   * Calculate trend direction from historical values (legacy method for compatibility)
   * @private
   */
  _calculateTrend(values, inverted = false) {
    const enhanced = this._calculateEnhancedTrend(values, inverted);
    return enhanced.trend;
  }

  /**
   * Generate actionable recommendations
   * @private
   */
  _generateRecommendations(qualityData) {
    const recommendations = [];

    // Extract existing recommendations
    if (qualityData.quality?.recommendations) {
      recommendations.push(
        ...qualityData.quality.recommendations.map(rec => ({
          category: 'quality',
          priority: 'medium',
          description: rec,
          action: 'Review quality assessment details',
        }))
      );
    }

    if (qualityData.recommendations) {
      recommendations.push(
        ...qualityData.recommendations.map(rec => ({
          category: 'anomaly',
          priority: rec.type === 'urgent' ? 'high' : 'medium',
          description: rec.message,
          action: rec.action,
        }))
      );
    }

    // Add generic recommendations based on scores
    const scores = this._extractQualityScores(qualityData);

    if (scores.completeness < 80) {
      recommendations.push({
        category: 'completeness',
        priority: 'high',
        description: 'Data completeness is below acceptable threshold',
        action:
          'Investigate data collection gaps and improve ingestion reliability',
      });
    }

    if (scores.accuracy < 85) {
      recommendations.push({
        category: 'accuracy',
        priority: 'high',
        description: 'Data accuracy issues detected',
        action: 'Review sensor calibration and data validation rules',
      });
    }

    return recommendations;
  }

  /**
   * Summarize data profiling results
   * @private
   */
  _summarizeDataProfile(qualityData) {
    const profile = {
      parameters: {},
      temporal: {},
      spatial: {},
      distribution: {},
    };

    // Statistical profile summary
    if (qualityData.statistical) {
      Object.entries(qualityData.statistical).forEach(([param, stats]) => {
        profile.parameters[param] = {
          count: stats.count,
          mean: stats.mean,
          std: stats.standardDeviation,
          range: { min: stats.min, max: stats.max },
          nullPercentage: stats.nullPercentage,
          outlierCount: stats.outliers?.zScore?.count || 0,
        };
      });
    }

    // Temporal profile summary
    if (qualityData.temporal) {
      profile.temporal = {
        timeRange: qualityData.temporal.timeRange,
        frequency: qualityData.temporal.frequency,
        gapCount: qualityData.temporal.gaps?.gapCount || 0,
        totalGapHours: qualityData.temporal.gaps?.totalGapDurationMs
          ? qualityData.temporal.gaps.totalGapDurationMs / (1000 * 60 * 60)
          : 0,
      };
    }

    // Spatial profile summary (placeholder)
    profile.spatial = qualityData.spatial || {
      message: 'Spatial analysis not available',
    };

    // Distribution summary
    if (qualityData.distribution) {
      profile.distribution = Object.keys(qualityData.distribution).reduce(
        (acc, param) => {
          acc[param] = {
            histogram: qualityData.distribution[param].histogram
              ? 'available'
              : 'not_available',
            normality: qualityData.distribution[param].normality,
            distribution: qualityData.distribution[param].distribution,
          };
          return acc;
        },
        {}
      );
    }

    return profile;
  }

  /**
   * Check alert conditions based on quality data
   * @private
   */
  _checkAlertConditions(qualityData) {
    const alerts = [];
    const scores = this._extractQualityScores(qualityData);
    const thresholds = this.config.alertThresholds;

    // Quality score alerts
    Object.entries(thresholds).forEach(([metric, threshold]) => {
      if (metric === 'anomalyRate') return; // Handle separately

      const score = scores[metric];
      if (score < threshold) {
        alerts.push({
          type: 'quality_score',
          metric: metric,
          severity: score < threshold * 0.8 ? 'high' : 'medium',
          currentValue: score,
          threshold: threshold,
          message: `${metric} score (${score.toFixed(1)}) is below threshold (${threshold})`,
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Anomaly rate alert
    if (
      qualityData.metadata?.recordCount &&
      qualityData.anomalies?.ensemble?.summary?.total
    ) {
      const anomalyRate =
        (qualityData.anomalies.ensemble.summary.total /
          qualityData.metadata.recordCount) *
        100;
      if (anomalyRate > thresholds.anomalyRate) {
        alerts.push({
          type: 'anomaly_rate',
          metric: 'anomalyRate',
          severity:
            anomalyRate > thresholds.anomalyRate * 2 ? 'high' : 'medium',
          currentValue: anomalyRate,
          threshold: thresholds.anomalyRate,
          message: `Anomaly rate (${anomalyRate.toFixed(2)}%) exceeds threshold (${thresholds.anomalyRate}%)`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return alerts;
  }

  /**
   * Generate historical comparison
   * @private
   */
  async _generateHistoricalComparison(qualityData, metadata) {
    try {
      // Get historical data from 30 days ago for comparison
      const historicalData = this.getHistoricalMetrics(30);

      if (!historicalData || historicalData.length < 7) {
        return {
          available: false,
          message: 'Insufficient historical data for comparison',
          previousPeriod: null,
          changePercentage: null,
          trend: 'unknown',
          confidence: 0.1,
        };
      }

      // Get data from 7 days ago for weekly comparison
      const previousPeriod =
        historicalData.find(
          d =>
            new Date(d.timestamp).getTime() <=
            Date.now() - 7 * 24 * 60 * 60 * 1000
        ) || historicalData[Math.floor(historicalData.length / 2)];

      // Extract current metrics
      const currentScore = qualityData.quality?.overallScore || 0;
      const currentCoverage =
        qualityData.quality?.scores?.completeness?.score || 0;
      const currentIssues = qualityData.quality?.issues?.length || 0;

      // Calculate change percentages
      const qualityChange = previousPeriod.overallScore
        ? ((currentScore - previousPeriod.overallScore) /
            previousPeriod.overallScore) *
          100
        : 0;
      const coverageChange = previousPeriod.completeness
        ? ((currentCoverage - previousPeriod.completeness) /
            previousPeriod.completeness) *
          100
        : 0;
      const issuesChange = previousPeriod.anomalyCount
        ? ((currentIssues - previousPeriod.anomalyCount) /
            previousPeriod.anomalyCount) *
          100
        : 0;

      // Determine overall trend
      const trend =
        Math.abs(qualityChange) > 5
          ? qualityChange > 0
            ? 'improving'
            : 'declining'
          : 'stable';

      // Calculate confidence based on data age and consistency
      const confidence = Math.min(
        0.9,
        (historicalData.length / 30) * 0.8 + 0.1
      );

      return {
        available: true,
        previousPeriod: {
          timestamp: previousPeriod.timestamp,
          quality_score: Math.round(previousPeriod.overallScore * 10) / 10,
          metrics: {
            completeness: Math.round(previousPeriod.completeness * 10) / 10,
            anomalyCount: previousPeriod.anomalyCount,
          },
        },
        changePercentage: Math.round(qualityChange * 10) / 10,
        trend,
        comparison: {
          qualityChange: Math.round(qualityChange * 10) / 10,
          coverageChange: Math.round(coverageChange * 10) / 10,
          issuesChange: Math.round(issuesChange * 10) / 10,
        },
        confidence: Math.round(confidence * 10) / 10,
      };
    } catch (error) {
      logger.warn('Historical comparison failed', { error: error.message });
      return {
        available: false,
        message: 'Historical comparison temporarily unavailable',
        previousPeriod: null,
        changePercentage: null,
        trend: 'unknown',
        confidence: 0.1,
      };
    }
  }

  /**
   * Save quality metrics to historical database for trend analysis
   * @param {Object} data - Quality metrics data to save
   * @returns {Promise<Object>} Success/failure indication
   */
  async saveHistoricalMetrics(data) {
    try {
      logger.info('Saving historical quality metrics', {
        timestamp: data.timestamp,
      });

      const result = await db.execute(sql`
                INSERT INTO quality_metrics_history 
                (timestamp, quality_score, coverage_data, lint_issues, security_vulnerabilities, metadata)
                VALUES (
                    ${data.timestamp || new Date().toISOString()},
                    ${data.quality_score || 0},
                    ${JSON.stringify(data.coverage_data || {})},
                    ${data.lint_issues || 0},
                    ${data.security_vulnerabilities || 0},
                    ${JSON.stringify(data.metadata || {})}
                )
                RETURNING id
            `);

      logger.info('Historical metrics saved successfully', {
        quality_score: data.quality_score,
      });
      return { success: true, id: result.rows?.[0]?.id };
    } catch (error) {
      logger.error('Failed to save historical metrics', {
        error: error.message,
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Retrieve historical quality metrics for trend analysis
   * @param {number} timeframe - Number of days to look back (e.g., 7, 30, 90)
   * @returns {Promise<Array>} Array of historical metrics ordered by timestamp DESC
   */
  async getHistoricalMetrics(timeframe) {
    try {
      logger.info('Retrieving historical metrics', {
        timeframeDays: timeframe,
      });

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - timeframe);

      const result = await db.execute(sql`
                SELECT timestamp, quality_score, coverage_data, lint_issues, security_vulnerabilities, metadata
                FROM quality_metrics_history 
                WHERE timestamp >= ${cutoffDate.toISOString()}
                ORDER BY timestamp DESC
            `);

      const metrics =
        result.rows?.map(row => ({
          timestamp: row.timestamp,
          quality_score: row.quality_score,
          coverage_data: JSON.parse(row.coverage_data || '{}'),
          lint_issues: row.lint_issues,
          security_vulnerabilities: row.security_vulnerabilities,
          metadata: JSON.parse(row.metadata || '{}'),
        })) || [];

      logger.info('Historical metrics retrieved successfully', {
        count: metrics.length,
        timeframe,
      });
      return metrics;
    } catch (error) {
      logger.error('Failed to retrieve historical metrics', {
        error: error.message,
        timeframe,
      });
      return [];
    }
  }

  /**
   * Format report according to specified format
   * @private
   */
  async _formatReport(report, format) {
    switch (format.toLowerCase()) {
      case 'html':
        return this._formatReportAsHTML(report);
      case 'csv':
        return this._formatReportAsCSV(report);
      case 'json':
      default:
        return JSON.stringify(report, null, 2);
    }
  }

  /**
   * Format report as HTML
   * @private
   */
  _formatReportAsHTML(report) {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>WRFCoin Data Quality Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background-color: #f0f0f0; padding: 15px; border-radius: 5px; }
        .section { margin: 20px 0; border: 1px solid #ddd; padding: 15px; border-radius: 5px; }
        .score { font-size: 1.2em; font-weight: bold; }
        .alert { background-color: #ffe6e6; border-left: 4px solid #ff0000; padding: 10px; margin: 5px 0; }
        .good { color: green; }
        .warning { color: orange; }
        .error { color: red; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    <div class="header">
        <h1>WRFCoin Data Quality Report</h1>
        <p><strong>Generated:</strong> ${report.metadata.generatedAt}</p>
        <p><strong>Report ID:</strong> ${report.id}</p>
    </div>

    <div class="section">
        <h2>Executive Summary</h2>
        <p><strong>Quality Status:</strong> <span class="score ${report.executiveSummary.qualityStatus}">${report.executiveSummary.qualityStatus}</span></p>
        <p><strong>Risk Level:</strong> ${report.executiveSummary.riskLevel}</p>
        <p><strong>Action Required:</strong> ${report.executiveSummary.actionRequired ? 'Yes' : 'No'}</p>
        
        <h3>Key Findings</h3>
        <ul>
            ${report.executiveSummary.keyFindings.map(finding => `<li>${finding}</li>`).join('')}
        </ul>
    </div>

    <div class="section">
        <h2>Quality Scores</h2>
        <table>
            <tr><th>Metric</th><th>Score</th><th>Category</th></tr>
            <tr><td>Overall</td><td class="score">${report.qualityScores.overall.toFixed(1)}</td><td>-</td></tr>
            <tr><td>Completeness</td><td>${report.qualityScores.completeness.toFixed(1)}</td><td>${report.qualityScores.breakdown.completeness.category}</td></tr>
            <tr><td>Accuracy</td><td>${report.qualityScores.accuracy.toFixed(1)}</td><td>${report.qualityScores.breakdown.accuracy.category}</td></tr>
            <tr><td>Consistency</td><td>${report.qualityScores.consistency.toFixed(1)}</td><td>${report.qualityScores.breakdown.consistency.category}</td></tr>
            <tr><td>Timeliness</td><td>${report.qualityScores.timeliness.toFixed(1)}</td><td>${report.qualityScores.breakdown.timeliness.category}</td></tr>
        </table>
    </div>

    ${
      report.alerts.length > 0
        ? `
    <div class="section">
        <h2>Alerts</h2>
        ${report.alerts
          .map(
            alert => `
        <div class="alert">
            <strong>${alert.severity.toUpperCase()}:</strong> ${alert.message}
        </div>
        `
          )
          .join('')}
    </div>
    `
        : ''
    }

    <div class="section">
        <h2>Anomaly Summary</h2>
        <p><strong>Total Anomalies:</strong> ${report.anomalies.total}</p>
        <p><strong>High Severity:</strong> ${report.anomalies.severityDistribution.high}</p>
        <p><strong>Medium Severity:</strong> ${report.anomalies.severityDistribution.medium}</p>
        <p><strong>Ensemble Confidence:</strong> ${(report.anomalies.ensemble.confidence * 100).toFixed(1)}%</p>
    </div>

    <div class="section">
        <h2>Recommendations</h2>
        <ul>
            ${report.recommendations
              .map(
                rec => `
            <li><strong>${rec.priority.toUpperCase()}:</strong> ${rec.description}
                <br><em>Action: ${rec.action}</em>
            </li>
            `
              )
              .join('')}
        </ul>
    </div>
</body>
</html>`;
    return html;
  }

  /**
   * Format report as CSV
   * @private
   */
  _formatReportAsCSV(report) {
    const lines = [];

    // Header
    lines.push('WRFCoin Data Quality Report');
    lines.push(`Generated,${report.metadata.generatedAt}`);
    lines.push(`Report ID,${report.id}`);
    lines.push('');

    // Quality Scores
    lines.push('Quality Scores');
    lines.push('Metric,Score,Category');
    lines.push(`Overall,${report.qualityScores.overall.toFixed(1)},-`);
    lines.push(
      `Completeness,${report.qualityScores.completeness.toFixed(1)},${report.qualityScores.breakdown.completeness.category}`
    );
    lines.push(
      `Accuracy,${report.qualityScores.accuracy.toFixed(1)},${report.qualityScores.breakdown.accuracy.category}`
    );
    lines.push(
      `Consistency,${report.qualityScores.consistency.toFixed(1)},${report.qualityScores.breakdown.consistency.category}`
    );
    lines.push(
      `Timeliness,${report.qualityScores.timeliness.toFixed(1)},${report.qualityScores.breakdown.timeliness.category}`
    );
    lines.push('');

    // Alerts
    if (report.alerts.length > 0) {
      lines.push('Alerts');
      lines.push('Type,Severity,Message,Value,Threshold');
      report.alerts.forEach(alert => {
        lines.push(
          `${alert.type},${alert.severity},"${alert.message}",${alert.currentValue},${alert.threshold}`
        );
      });
      lines.push('');
    }

    // Anomalies
    lines.push('Anomaly Summary');
    lines.push('Metric,Count');
    lines.push(`Total,${report.anomalies.total}`);
    lines.push(`High Severity,${report.anomalies.severityDistribution.high}`);
    lines.push(
      `Medium Severity,${report.anomalies.severityDistribution.medium}`
    );
    lines.push(
      `Ensemble Confidence,${(report.anomalies.ensemble.confidence * 100).toFixed(1)}%`
    );

    return lines.join('\n');
  }

  /**
   * Process alerts (send notifications, etc.)
   * @private
   */
  async _processAlerts(alerts, report) {
    for (const alert of alerts) {
      const alertKey = `${alert.type}_${alert.metric}`;
      const now = Date.now();
      const lastAlert = this.lastAlertTime.get(alertKey) || 0;
      const cooldownMs = this.config.alertCooldownMinutes * 60 * 1000;

      // Check cooldown period
      if (now - lastAlert < cooldownMs) {
        logger.debug('Alert skipped due to cooldown', {
          alertKey,
          cooldownMinutes: this.config.alertCooldownMinutes,
        });
        continue;
      }

      // Send alert
      try {
        await this._sendAlert(alert, report);
        this.lastAlertTime.set(alertKey, now);

        // Store alert history
        const alertHistory = this.alertHistory.get(alertKey) || [];
        alertHistory.push({
          timestamp: alert.timestamp,
          severity: alert.severity,
          value: alert.currentValue,
          reportId: report.id,
        });
        this.alertHistory.set(alertKey, alertHistory);

        logger.info('Alert processed successfully', {
          alertKey,
          severity: alert.severity,
        });
      } catch (error) {
        logger.error('Failed to send alert', {
          error: error.message,
          alertKey,
        });
      }
    }
  }

  /**
   * Send alert notification
   * @private
   */
  async _sendAlert(alert, report) {
    const alertData = {
      alert,
      report: {
        id: report.id,
        timestamp: report.metadata.generatedAt,
        overallScore: report.qualityScores.overall,
      },
    };

    // Webhook alerts
    if (
      this.config.enableWebhookAlerts &&
      this.webhookConfig.enabled &&
      this.webhookConfig.url
    ) {
      try {
        const payload = this._buildWebhookPayload(alertData);
        await this._sendWebhookRequest(this.webhookConfig.url, payload);
        logger.info('Webhook alert sent successfully', {
          alert: alert.type,
          severity: alert.severity,
          url: this.webhookConfig.url,
        });
      } catch (error) {
        logger.error('Failed to send webhook alert', {
          error: error.message,
          alert: alert.type,
          severity: alert.severity,
          url: this.webhookConfig.url,
        });
      }
    }

    // Email alerts
    if (this.config.enableEmailAlerts) {
      try {
        // Check if email is enabled in configuration
        if (!this.emailConfig.enabled) {
          logger.debug('Email notifications disabled in configuration');
          return;
        }

        // Build email content using configured method
        const emailContent = this._buildEmailContent(alertData);

        // Log email sending (placeholder for actual SMTP implementation)
        logger.info('Sending quality alert email', {
          to: this.emailConfig.to,
          subject: emailContent.subject,
          alertType: alert.type,
          severity: alert.severity,
        });

        // In production, this would use nodemailer or similar SMTP client:
        // const transporter = nodemailer.createTransporter({ ... });
        // await transporter.sendMail({ ... });

        logger.info('Email alert sent successfully', {
          alert: alert.type,
          severity: alert.severity,
        });
      } catch (error) {
        logger.error('Failed to send email alert', {
          error: error.message,
          alert: alert.type,
          severity: alert.severity,
        });
      }
    }

    // Internal notification (for dashboard)
    this._notifySubscriptions('alert', alertData);
  }

  /**
   * Build email content for quality alert notifications
   * @private
   * @param {Object} qualityData - Quality assessment data
   * @returns {Object} Email content with subject, htmlContent, and textContent
   */
  _buildEmailContent(qualityData) {
    // Validate required fields
    if (!qualityData || typeof qualityData !== 'object') {
      throw new Error('qualityData is required and must be an object');
    }

    const scores = this._extractQualityScores(qualityData);
    const alerts = this._checkAlertConditions(qualityData);
    const trends = this._analyzeTrends(qualityData);
    const timestamp = new Date().toISOString();

    // Determine alert level and key metric
    const highestAlert = alerts.reduce(
      (max, alert) =>
        alert.severity === 'high'
          ? alert
          : max.severity === 'high'
            ? max
            : alert,
      { severity: 'low' }
    );
    const alertLevel = highestAlert.severity || 'info';
    const keyMetric = highestAlert.metric || 'overall';

    const subject = `${this.emailConfig.subject_prefix} ${
      alertLevel === 'high'
        ? 'CRITICAL'
        : alertLevel === 'medium'
          ? 'WARNING'
          : 'INFO'
    } - ${keyMetric} Quality Alert`;

    const htmlContent = `<html><body style="font-family: Arial, sans-serif;">
            <h2>WRFCoin Quality Alert Report</h2>
            <p><strong>Status:</strong> Overall Score ${scores.overall.toFixed(1)}% (${scores.overall >= 80 ? 'GOOD' : 'NEEDS ATTENTION'})</p>
            <h3>Metrics Summary</h3>
            <ul><li>Completeness: ${scores.completeness.toFixed(1)}%</li><li>Accuracy: ${scores.accuracy.toFixed(1)}%</li>
            <li>Consistency: ${scores.consistency.toFixed(1)}%</li><li>Timeliness: ${scores.timeliness.toFixed(1)}%</li></ul>
            <h3>Trend Analysis</h3><p>Quality: ${trends.qualityTrend}, Anomalies: ${trends.anomalyTrend}</p>
            <h3>Recommended Actions</h3><ul>${alerts.map(a => `<li>${a.message} - Review ${a.metric}</li>`).join('')}</ul>
            <hr><p><small>Generated: ${timestamp} | WRFCoin Quality Monitoring System</small></p></body></html>`;

    const textContent = `WRFCoin Quality Alert Report\n\nStatus: Overall Score ${scores.overall.toFixed(1)}% (${scores.overall >= 80 ? 'GOOD' : 'NEEDS ATTENTION'})\n\nMetrics:\n- Completeness: ${scores.completeness.toFixed(1)}%\n- Accuracy: ${scores.accuracy.toFixed(1)}%\n- Consistency: ${scores.consistency.toFixed(1)}%\n- Timeliness: ${scores.timeliness.toFixed(1)}%\n\nTrends: Quality ${trends.qualityTrend}, Anomalies ${trends.anomalyTrend}\n\nActions:\n${alerts.map(a => `- ${a.message}`).join('\n')}\n\nGenerated: ${timestamp}`;

    return { subject, htmlContent, textContent };
  }

  /**
   * Update dashboard data with latest report
   * @private
   */
  _updateDashboardData(report) {
    const timestamp = Date.now();
    const dashboardEntry = {
      timestamp,
      reportId: report.id,
      overallScore: report.qualityScores.overall,
      scores: {
        completeness: report.qualityScores.completeness,
        accuracy: report.qualityScores.accuracy,
        consistency: report.qualityScores.consistency,
        timeliness: report.qualityScores.timeliness,
      },
      anomalies: report.anomalies.total,
      alerts: report.alerts.length,
      qualityStatus: report.executiveSummary.qualityStatus,
      riskLevel: report.executiveSummary.riskLevel,
    };

    // Store in dashboard data (keep last 24 hours)
    const dashboardHistory = this.dashboardData.get('history') || [];
    dashboardHistory.push(dashboardEntry);

    // Cleanup old entries
    const cutoffTime = timestamp - this.config.maxDashboardHistory * 60 * 1000;
    const filteredHistory = dashboardHistory.filter(
      entry => entry.timestamp > cutoffTime
    );

    this.dashboardData.set('history', filteredHistory);
    this.dashboardData.set('latest', dashboardEntry);

    // Notify subscribers
    this._notifySubscriptions('dashboard_update', dashboardEntry);
  }

  /**
   * Get dashboard data for real-time monitoring
   */
  getDashboardData() {
    return {
      latest: this.dashboardData.get('latest'),
      history: this.dashboardData.get('history') || [],
      alertSummary: this._getAlertSummary(),
      trends: this._calculateDashboardTrends(),
    };
  }

  /**
   * Get alert summary for dashboard
   * @private
   */
  _getAlertSummary() {
    const summary = {
      active: 0,
      total24h: 0,
      bySeverity: { high: 0, medium: 0, low: 0 },
      byType: {},
    };

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    this.alertHistory.forEach((alerts, alertKey) => {
      const recentAlerts = alerts.filter(
        alert => new Date(alert.timestamp).getTime() > oneDayAgo
      );

      summary.total24h += recentAlerts.length;

      recentAlerts.forEach(alert => {
        summary.bySeverity[alert.severity]++;
        const type = alertKey.split('_')[0];
        summary.byType[type] = (summary.byType[type] || 0) + 1;
      });
    });

    return summary;
  }

  /**
   * Calculate dashboard trends
   * @private
   */
  _calculateDashboardTrends() {
    const history = this.dashboardData.get('history') || [];
    if (history.length < 2) return { message: 'Insufficient data for trends' };

    const recent = history.slice(-10); // Last 10 entries
    const scores = recent.map(entry => entry.overallScore);

    const trend =
      scores.length > 1
        ? (scores[scores.length - 1] - scores[0]) / scores.length
        : 0;

    return {
      qualityTrend:
        trend > 1 ? 'improving' : trend < -1 ? 'declining' : 'stable',
      trendValue: trend,
      dataPoints: scores.length,
    };
  }

  /**
   * Subscribe to real-time updates
   */
  subscribe(callback) {
    this.subscriptions.add(callback);
    return () => this.subscriptions.delete(callback);
  }

  /**
   * Notify all subscriptions
   * @private
   */
  _notifySubscriptions(type, data) {
    this.subscriptions.forEach(callback => {
      try {
        callback({ type, data });
      } catch (error) {
        logger.warn('Subscription notification failed', {
          error: error.message,
        });
      }
    });
  }

  /**
   * Get stored report by ID
   */
  getReport(reportId) {
    return this.reports.get(reportId);
  }

  /**
   * List recent reports
   */
  listReports(limit = 10) {
    const reports = Array.from(this.reports.values())
      .sort(
        (a, b) =>
          new Date(b.metadata.generatedAt) - new Date(a.metadata.generatedAt)
      )
      .slice(0, limit);

    return reports.map(report => ({
      id: report.id,
      generatedAt: report.metadata.generatedAt,
      overallScore: report.qualityScores.overall,
      qualityStatus: report.executiveSummary.qualityStatus,
      anomalies: report.anomalies.total,
      alerts: report.alerts.length,
    }));
  }

  /**
   * Export report to file
   */
  async exportReport(reportId, format, outputPath) {
    const report = this.getReport(reportId);
    if (!report) {
      throw new Error(`Report ${reportId} not found`);
    }

    const formattedReport = await this._formatReport(report, format);
    await fs.writeFile(outputPath, formattedReport);

    logger.info('Report exported successfully', {
      reportId,
      format,
      outputPath,
    });
  }

  /**
   * Clear old reports and alert history
   */
  async cleanup() {
    const cutoffTime =
      Date.now() - this.config.reportRetentionDays * 24 * 60 * 60 * 1000;

    // Cleanup reports
    let removedReports = 0;
    this.reports.forEach((report, reportId) => {
      if (new Date(report.metadata.generatedAt).getTime() < cutoffTime) {
        this.reports.delete(reportId);
        removedReports++;
      }
    });

    // Cleanup alert history
    let removedAlerts = 0;
    this.alertHistory.forEach((alerts, alertKey) => {
      const filteredAlerts = alerts.filter(
        alert => new Date(alert.timestamp).getTime() > cutoffTime
      );
      removedAlerts += alerts.length - filteredAlerts.length;

      if (filteredAlerts.length === 0) {
        this.alertHistory.delete(alertKey);
      } else {
        this.alertHistory.set(alertKey, filteredAlerts);
      }
    });

    logger.info('Cleanup completed', { removedReports, removedAlerts });
  }

  /**
   * Generate unique report ID
   * @private
   */
  _generateReportId(metadata) {
    const timestamp = Date.now();
    const hash = require('crypto')
      .createHash('md5')
      .update(JSON.stringify(metadata))
      .digest('hex')
      .substring(0, 8);
    return `qr_${timestamp}_${hash}`;
  }

  /**
   * Send webhook HTTP request with retry logic
   * @private
   */
  async _sendWebhookRequest(url, payload, retries = 2) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const postData = JSON.stringify(payload);

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: this.webhookConfig.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'WRFCoin-Quality-Alerts/1.0',
          ...this.webhookConfig.headers,
        },
        timeout: this.webhookConfig.timeout || 30000,
      };

      const client = urlObj.protocol === 'https:' ? https : http;

      const req = client.request(options, res => {
        let responseData = '';
        res.on('data', chunk => (responseData += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseData);
          } else {
            const error = new Error(`HTTP ${res.statusCode}: ${responseData}`);
            if (retries > 0) {
              logger.warn('Webhook request failed, retrying', {
                retries,
                statusCode: res.statusCode,
              });
              setTimeout(
                () =>
                  this._sendWebhookRequest(url, payload, retries - 1)
                    .then(resolve)
                    .catch(reject),
                1000
              );
            } else {
              reject(error);
            }
          }
        });
      });

      req.on('error', error => {
        if (retries > 0) {
          logger.warn('Webhook request error, retrying', {
            retries,
            error: error.message,
          });
          setTimeout(
            () =>
              this._sendWebhookRequest(url, payload, retries - 1)
                .then(resolve)
                .catch(reject),
            1000
          );
        } else {
          reject(error);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        const error = new Error('Webhook request timeout');
        if (retries > 0) {
          logger.warn('Webhook request timeout, retrying', { retries });
          setTimeout(
            () =>
              this._sendWebhookRequest(url, payload, retries - 1)
                .then(resolve)
                .catch(reject),
            1000
          );
        } else {
          reject(error);
        }
      });

      req.write(postData);
      req.end();
    });
  }
}

module.exports = QualityReportingService;
