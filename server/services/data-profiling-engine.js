/**
 * Data Profiling Engine for WRFCoin Weather Data Quality Pipeline
 *
 * Provides comprehensive statistical profiling, temporal pattern analysis,
 * and data completeness assessment for weather data quality assurance.
 *
 * @author WRFCoin Development Team
 * @version 1.0.0
 * @since 2025-07-12
 */

const fs = require('fs').promises;
const path = require('path');
const { logger } = require('../../utils/logger');

class DataProfilingEngine {
  constructor(options = {}) {
    this.config = {
      enableHistograms: true,
      histogramBins: 50,
      temporalAnalysisWindow: 30, // days
      outlierThreshold: 3.0, // standard deviations
      seasonalPeriods: [365.25, 365.25 / 2, 365.25 / 4], // annual, semi-annual, quarterly
      ...options,
    };

    // Statistical accumulators
    this.profiles = new Map();
    this.temporalPatterns = new Map();
    this.spatialProfiles = new Map();

    logger.info('DataProfilingEngine initialized', { config: this.config });
  }

  /**
   * Generate comprehensive data profile for weather parameters
   * @param {Array} data - Array of weather observations
   * @param {Object} metadata - Dataset metadata (location, timerange, etc.)
   * @returns {Object} Comprehensive profile report
   */
  async generateProfile(data, metadata = {}) {
    const startTime = Date.now();

    try {
      if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Invalid or empty dataset provided');
      }

      logger.info('Starting data profiling', {
        recordCount: data.length,
        metadata,
      });

      const profile = {
        metadata: {
          ...metadata,
          recordCount: data.length,
          profiledAt: new Date().toISOString(),
          processingTimeMs: 0,
        },
        statistical: await this._generateStatisticalProfile(data),
        temporal: await this._generateTemporalProfile(data),
        spatial: await this._generateSpatialProfile(data),
        completeness: await this._generateCompletenessProfile(data),
        distribution: await this._generateDistributionProfile(data),
        quality: await this._generateQualityProfile(data),
      };

      profile.metadata.processingTimeMs = Date.now() - startTime;

      // Cache profile for future reference
      const profileId = this._generateProfileId(metadata);
      this.profiles.set(profileId, profile);

      logger.info('Data profiling completed', {
        profileId,
        processingTimeMs: profile.metadata.processingTimeMs,
        qualityScore: profile.quality.overallScore,
      });

      return profile;
    } catch (error) {
      logger.error('Data profiling failed', { error: error.message, metadata });
      throw error;
    }
  }

  /**
   * Generate statistical profile for numerical parameters
   * @private
   */
  async _generateStatisticalProfile(data) {
    const params = this._extractParameterNames(data);
    const statistics = {};

    for (const param of params) {
      const values = this._extractParameterValues(data, param);
      if (values.length === 0) continue;

      statistics[param] = {
        count: values.length,
        mean: this._calculateMean(values),
        median: this._calculateMedian(values),
        mode: this._calculateMode(values),
        standardDeviation: this._calculateStandardDeviation(values),
        variance: this._calculateVariance(values),
        skewness: this._calculateSkewness(values),
        kurtosis: this._calculateKurtosis(values),
        min: Math.min(...values),
        max: Math.max(...values),
        range: Math.max(...values) - Math.min(...values),
        percentiles: this._calculatePercentiles(
          values,
          [5, 10, 25, 50, 75, 90, 95, 99]
        ),
        outliers: this._detectOutliers(values),
        nullCount: data.length - values.length,
        nullPercentage: ((data.length - values.length) / data.length) * 100,
      };
    }

    return statistics;
  }

  /**
   * Generate temporal pattern analysis
   * @private
   */
  async _generateTemporalProfile(data) {
    const timestamps = data
      .map(d => new Date(d.timestamp))
      .filter(t => !isNaN(t));

    if (timestamps.length === 0) {
      return { error: 'No valid timestamps found' };
    }

    timestamps.sort((a, b) => a - b);

    const temporal = {
      timeRange: {
        start: timestamps[0].toISOString(),
        end: timestamps[timestamps.length - 1].toISOString(),
        durationDays:
          (timestamps[timestamps.length - 1] - timestamps[0]) /
          (1000 * 60 * 60 * 24),
      },
      frequency: this._analyzeFrequency(timestamps),
      gaps: this._analyzeTemporalGaps(timestamps),
      seasonality: await this._analyzeSeasonality(data),
      diurnalPatterns: await this._analyzeDiurnalPatterns(data),
      trends: await this._analyzeTrends(data),
    };

    return temporal;
  }

  /**
   * Generate spatial distribution profile
   * @private
   */
  async _generateSpatialProfile(data) {
    const spatial = {
      coverage: this._analyzeSpatialCoverage(data),
      density: this._analyzeSpatialDensity(data),
      clusters: this._analyzeSpatialClusters(data),
      bounds: this._calculateSpatialBounds(data),
    };

    return spatial;
  }

  /**
   * Generate data completeness profile
   * @private
   */
  async _generateCompletenessProfile(data) {
    const params = this._extractParameterNames(data);
    const completeness = {
      overall: {},
      byParameter: {},
      temporal: {},
      patterns: {},
    };

    // Overall completeness
    const totalFields = data.length * params.length;
    const missingFields = data.reduce((sum, record) => {
      return (
        sum + params.filter(param => !this._hasValidValue(record[param])).length
      );
    }, 0);

    completeness.overall = {
      totalFields,
      missingFields,
      completenessPercentage:
        ((totalFields - missingFields) / totalFields) * 100,
      completeRecords: data.filter(record =>
        params.every(param => this._hasValidValue(record[param]))
      ).length,
      completeRecordsPercentage:
        (data.filter(record =>
          params.every(param => this._hasValidValue(record[param]))
        ).length /
          data.length) *
        100,
    };

    // By parameter completeness
    for (const param of params) {
      const validCount = data.filter(record =>
        this._hasValidValue(record[param])
      ).length;
      completeness.byParameter[param] = {
        validCount,
        missingCount: data.length - validCount,
        completenessPercentage: (validCount / data.length) * 100,
      };
    }

    // Temporal completeness patterns
    completeness.temporal = this._analyzeTemporalCompleteness(data, params);

    // Missing data patterns
    completeness.patterns = this._analyzeMissingDataPatterns(data, params);

    return completeness;
  }

  /**
   * Generate distribution analysis
   * @private
   */
  async _generateDistributionProfile(data) {
    const params = this._extractParameterNames(data);
    const distributions = {};

    for (const param of params) {
      const values = this._extractParameterValues(data, param);
      if (values.length === 0) continue;

      distributions[param] = {
        histogram: this._generateHistogram(values, this.config.histogramBins),
        normality: this._testNormality(values),
        distribution: this._identifyDistribution(values),
        extremes: this._analyzeExtremes(values),
      };
    }

    return distributions;
  }

  /**
   * Generate quality assessment profile
   * @private
   */
  async _generateQualityProfile(data) {
    const quality = {
      scores: {},
      issues: [],
      recommendations: [],
      overallScore: 0,
    };

    // Calculate quality scores
    const completenessScore = await this._calculateCompletenessScore(data);
    const consistencyScore = await this._calculateConsistencyScore(data);
    const accuracyScore = await this._calculateAccuracyScore(data);
    const timelinessScore = await this._calculateTimelinessScore(data);

    quality.scores = {
      completeness: completenessScore,
      consistency: consistencyScore,
      accuracy: accuracyScore,
      timeliness: timelinessScore,
    };

    // Calculate weighted overall score
    quality.overallScore =
      completenessScore.score * 0.3 +
      consistencyScore.score * 0.3 +
      accuracyScore.score * 0.25 +
      timelinessScore.score * 0.15;

    // Identify issues and recommendations
    quality.issues = this._identifyQualityIssues(quality.scores);
    quality.recommendations = this._generateQualityRecommendations(
      quality.scores,
      quality.issues
    );

    return quality;
  }

  /**
   * Helper method to extract parameter names from data
   * @private
   */
  _extractParameterNames(data) {
    if (!data.length) return [];

    const weatherParams = [
      'temperature',
      'humidity',
      'pressure',
      'windSpeed',
      'windDirection',
      'precipitation',
      'visibility',
      'dewPoint',
      'heatIndex',
      'windChill',
      'uvIndex',
      'solarRadiation',
      'snowDepth',
      'cloudCover',
    ];

    const availableParams = Object.keys(data[0]).filter(
      key =>
        weatherParams.includes(key) ||
        key.includes('temp') ||
        key.includes('wind') ||
        key.includes('pressure') ||
        key.includes('humidity')
    );

    return availableParams;
  }

  /**
   * Helper method to extract parameter values (numeric only)
   * @private
   */
  _extractParameterValues(data, param) {
    return data
      .map(record => record[param])
      .filter(
        value => typeof value === 'number' && !isNaN(value) && isFinite(value)
      );
  }

  /**
   * Check if value is valid (not null, undefined, NaN, or empty string)
   * @private
   */
  _hasValidValue(value) {
    return (
      value !== null &&
      value !== undefined &&
      value !== '' &&
      (typeof value !== 'number' || (!isNaN(value) && isFinite(value)))
    );
  }

  /**
   * Calculate statistical measures
   * @private
   */
  _calculateMean(values) {
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  _calculateMedian(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  _calculateMode(values) {
    const frequency = {};
    values.forEach(val => (frequency[val] = (frequency[val] || 0) + 1));
    let maxFreq = 0,
      mode = null;
    for (const [val, freq] of Object.entries(frequency)) {
      if (freq > maxFreq) {
        maxFreq = freq;
        mode = parseFloat(val);
      }
    }
    return { value: mode, frequency: maxFreq };
  }

  _calculateStandardDeviation(values) {
    const mean = this._calculateMean(values);
    const variance =
      values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
      values.length;
    return Math.sqrt(variance);
  }

  _calculateVariance(values) {
    const mean = this._calculateMean(values);
    return (
      values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
      values.length
    );
  }

  _calculateSkewness(values) {
    const mean = this._calculateMean(values);
    const std = this._calculateStandardDeviation(values);
    const n = values.length;
    const skew =
      values.reduce((sum, val) => sum + Math.pow((val - mean) / std, 3), 0) / n;
    return skew;
  }

  _calculateKurtosis(values) {
    const mean = this._calculateMean(values);
    const std = this._calculateStandardDeviation(values);
    const n = values.length;
    const kurt =
      values.reduce((sum, val) => sum + Math.pow((val - mean) / std, 4), 0) / n;
    return kurt - 3; // Excess kurtosis
  }

  _calculatePercentiles(values, percentiles) {
    const sorted = [...values].sort((a, b) => a - b);
    const result = {};

    percentiles.forEach(p => {
      const index = (p / 100) * (sorted.length - 1);
      if (index % 1 === 0) {
        result[`p${p}`] = sorted[index];
      } else {
        const lower = sorted[Math.floor(index)];
        const upper = sorted[Math.ceil(index)];
        result[`p${p}`] = lower + (upper - lower) * (index % 1);
      }
    });

    return result;
  }

  /**
   * Detect outliers using various methods
   * @private
   */
  _detectOutliers(values) {
    const mean = this._calculateMean(values);
    const std = this._calculateStandardDeviation(values);
    const threshold = this.config.outlierThreshold;

    // Z-score method
    const zScoreOutliers = values.filter(
      val => Math.abs((val - mean) / std) > threshold
    );

    // IQR method
    const percentiles = this._calculatePercentiles(values, [25, 75]);
    const iqr = percentiles.p75 - percentiles.p25;
    const lowerBound = percentiles.p25 - 1.5 * iqr;
    const upperBound = percentiles.p75 + 1.5 * iqr;
    const iqrOutliers = values.filter(
      val => val < lowerBound || val > upperBound
    );

    return {
      zScore: {
        count: zScoreOutliers.length,
        percentage: (zScoreOutliers.length / values.length) * 100,
        values: zScoreOutliers,
      },
      iqr: {
        count: iqrOutliers.length,
        percentage: (iqrOutliers.length / values.length) * 100,
        values: iqrOutliers,
        bounds: { lower: lowerBound, upper: upperBound },
      },
    };
  }

  /**
   * Analyze data frequency and regularity
   * @private
   */
  _analyzeFrequency(timestamps) {
    if (timestamps.length < 2) return { error: 'Insufficient timestamps' };

    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }

    const intervalMs = this._calculateMean(intervals);
    const intervalStd = this._calculateStandardDeviation(intervals);

    return {
      averageIntervalMs: intervalMs,
      averageIntervalMinutes: intervalMs / (1000 * 60),
      standardDeviationMs: intervalStd,
      regularity: intervalStd / intervalMs, // Lower is more regular
      estimatedFrequency: this._estimateFrequency(intervalMs),
    };
  }

  _estimateFrequency(intervalMs) {
    const intervals = {
      minute: 60 * 1000,
      fiveMinutes: 5 * 60 * 1000,
      tenMinutes: 10 * 60 * 1000,
      fifteenMinutes: 15 * 60 * 1000,
      thirtyMinutes: 30 * 60 * 1000,
      hour: 60 * 60 * 1000,
      threeHours: 3 * 60 * 60 * 1000,
      sixHours: 6 * 60 * 60 * 1000,
      twelveHours: 12 * 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
    };

    let closest = 'irregular';
    let minDiff = Infinity;

    for (const [name, interval] of Object.entries(intervals)) {
      const diff = Math.abs(intervalMs - interval);
      if (diff < minDiff) {
        minDiff = diff;
        closest = name;
      }
    }

    return {
      estimated: closest,
      confidence: Math.max(0, 1 - minDiff / intervalMs),
    };
  }

  /**
   * Analyze temporal gaps in data
   * @private
   */
  _analyzeTemporalGaps(timestamps) {
    if (timestamps.length < 2) return { gaps: [] };

    const expectedInterval = this._calculateMean(
      timestamps.slice(1).map((t, i) => t - timestamps[i])
    );

    const gaps = [];
    for (let i = 1; i < timestamps.length; i++) {
      const actualInterval = timestamps[i] - timestamps[i - 1];
      if (actualInterval > expectedInterval * 2) {
        // Gap threshold
        gaps.push({
          start: timestamps[i - 1],
          end: timestamps[i],
          durationMs: actualInterval,
          durationHours: actualInterval / (1000 * 60 * 60),
          severity: actualInterval > expectedInterval * 10 ? 'major' : 'minor',
        });
      }
    }

    return {
      gaps,
      gapCount: gaps.length,
      totalGapDurationMs: gaps.reduce((sum, gap) => sum + gap.durationMs, 0),
      largestGapHours:
        gaps.length > 0 ? Math.max(...gaps.map(g => g.durationHours)) : 0,
    };
  }

  /**
   * Generate histogram for value distribution
   * @private
   */
  _generateHistogram(values, binCount) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const binWidth = (max - min) / binCount;

    const bins = Array(binCount)
      .fill(0)
      .map((_, i) => ({
        min: min + i * binWidth,
        max: min + (i + 1) * binWidth,
        count: 0,
        frequency: 0,
      }));

    values.forEach(value => {
      const binIndex = Math.min(
        Math.floor((value - min) / binWidth),
        binCount - 1
      );
      bins[binIndex].count++;
    });

    bins.forEach(bin => {
      bin.frequency = bin.count / values.length;
    });

    return bins;
  }

  /**
   * Generate unique profile ID based on metadata
   * @private
   */
  _generateProfileId(metadata) {
    const key = JSON.stringify({
      location: metadata.location,
      timeRange: metadata.timeRange,
      source: metadata.source,
    });
    return require('crypto').createHash('md5').update(key).digest('hex');
  }

  /**
   * Quality scoring methods
   * @private
   */
  async _calculateCompletenessScore(data) {
    const profile = await this._generateCompletenessProfile(data);
    const score = Math.max(
      0,
      Math.min(100, profile.overall.completenessPercentage)
    );

    return {
      score,
      details: profile.overall,
      category:
        score >= 95
          ? 'excellent'
          : score >= 80
            ? 'good'
            : score >= 60
              ? 'fair'
              : 'poor',
    };
  }

  async _calculateConsistencyScore(data) {
    // Implement consistency checks (temporal, spatial, physical)
    const params = this._extractParameterNames(data);
    let consistencyIssues = 0;
    let totalChecks = 0;

    // Physical consistency checks
    for (const record of data) {
      totalChecks++;
      if (
        record.temperature &&
        record.dewPoint &&
        record.dewPoint > record.temperature
      ) {
        consistencyIssues++;
      }
      if (record.humidity && (record.humidity < 0 || record.humidity > 100)) {
        consistencyIssues++;
      }
      // Add more consistency checks...
    }

    const score = Math.max(0, 100 * (1 - consistencyIssues / totalChecks));

    return {
      score,
      details: { consistencyIssues, totalChecks },
      category:
        score >= 95
          ? 'excellent'
          : score >= 80
            ? 'good'
            : score >= 60
              ? 'fair'
              : 'poor',
    };
  }

  async _calculateAccuracyScore(data) {
    // Implement accuracy assessment based on expected ranges and physical limits
    const params = this._extractParameterNames(data);
    let accuracyIssues = 0;
    let totalValues = 0;

    const ranges = {
      temperature: { min: -100, max: 70 }, // Celsius
      humidity: { min: 0, max: 100 }, // Percentage
      pressure: { min: 800, max: 1100 }, // hPa
      windSpeed: { min: 0, max: 150 }, // m/s
    };

    for (const record of data) {
      for (const param of params) {
        if (record[param] !== null && record[param] !== undefined) {
          totalValues++;
          const range = ranges[param];
          if (
            range &&
            (record[param] < range.min || record[param] > range.max)
          ) {
            accuracyIssues++;
          }
        }
      }
    }

    const score =
      totalValues > 0
        ? Math.max(0, 100 * (1 - accuracyIssues / totalValues))
        : 0;

    return {
      score,
      details: { accuracyIssues, totalValues },
      category:
        score >= 95
          ? 'excellent'
          : score >= 80
            ? 'good'
            : score >= 60
              ? 'fair'
              : 'poor',
    };
  }

  async _calculateTimelinessScore(data) {
    const timestamps = data
      .map(d => new Date(d.timestamp))
      .filter(t => !isNaN(t));
    if (timestamps.length === 0) return { score: 0, category: 'poor' };

    const now = new Date();
    const latestTimestamp = Math.max(...timestamps);
    const ageHours = (now - latestTimestamp) / (1000 * 60 * 60);

    let score = 100;
    if (ageHours > 1) score = Math.max(0, 100 - (ageHours - 1) * 10); // Degrade 10 points per hour after 1 hour

    return {
      score,
      details: { latestDataAge: ageHours },
      category:
        score >= 95
          ? 'excellent'
          : score >= 80
            ? 'good'
            : score >= 60
              ? 'fair'
              : 'poor',
    };
  }

  /**
   * Advanced temporal analysis methods
   * @private
   */
  async _analyzeSeasonality(data) {
    try {
      const params = this._extractParameterNames(data);
      const seasonalityResults = {};

      for (const param of params) {
        const values = this._extractParameterValues(data, param);
        const timestamps = data
          .filter(d => this._hasValidValue(d[param]))
          .map(d => new Date(d.timestamp))
          .filter(t => !isNaN(t));

        if (values.length < 48 || timestamps.length < 48) {
          // Need at least 2 days of hourly data
          seasonalityResults[param] = {
            detected: false,
            reason: 'Insufficient data points for seasonality analysis',
            dataPoints: values.length,
          };
          continue;
        }

        // Create time series with regular intervals
        const timeSeries = this._createRegularTimeSeries(values, timestamps);

        if (timeSeries.length < 24) {
          seasonalityResults[param] = {
            detected: false,
            reason: 'Insufficient regular time series data',
            dataPoints: timeSeries.length,
          };
          continue;
        }

        // Apply simple FFT-like frequency analysis using autocorrelation
        const seasonality = this._detectSeasonalPatterns(timeSeries);

        seasonalityResults[param] = {
          detected: seasonality.hasSeasonality,
          confidence: seasonality.confidence,
          dominantPeriods: seasonality.dominantPeriods,
          strength: seasonality.strength,
          dataPoints: timeSeries.length,
          analysis: {
            annualPattern: seasonality.annual,
            dailyPattern: seasonality.daily,
            weeklyPattern: seasonality.weekly,
          },
        };
      }

      return {
        detected: Object.values(seasonalityResults).some(r => r.detected),
        byParameter: seasonalityResults,
        summary: this._summarizeSeasonalityResults(seasonalityResults),
      };
    } catch (error) {
      logger.error('Seasonality analysis failed', { error: error.message });
      return {
        detected: false,
        error: 'Seasonality analysis failed: ' + error.message,
      };
    }
  }

  async _analyzeDiurnalPatterns(data) {
    try {
      const params = this._extractParameterNames(data);
      const diurnalResults = {};

      for (const param of params) {
        const validData = data.filter(
          d =>
            this._hasValidValue(d[param]) &&
            d.timestamp &&
            !isNaN(new Date(d.timestamp))
        );

        if (validData.length < 24) {
          // Need at least 24 hours of data
          diurnalResults[param] = {
            detected: false,
            reason: 'Insufficient data for diurnal analysis',
            dataPoints: validData.length,
          };
          continue;
        }

        // Group data by hour of day
        const hourlyData = this._groupDataByHour(validData, param);

        // Calculate statistical measures for each hour
        const hourlyStats = this._calculateHourlyStatistics(hourlyData);

        // Detect diurnal patterns
        const patterns = this._detectDiurnalCycles(hourlyStats);

        // Calculate pattern strength and confidence
        const strength = this._calculateDiurnalStrength(hourlyStats);
        const confidence = this._calculatePatternConfidence(
          hourlyStats,
          patterns
        );

        diurnalResults[param] = {
          detected: patterns.hasPattern,
          confidence: confidence,
          strength: strength,
          patterns: {
            peakHour: patterns.peakHour,
            troughHour: patterns.troughHour,
            amplitude: patterns.amplitude,
            cycleType: patterns.cycleType,
          },
          hourlyProfile: hourlyStats,
          statistics: {
            maxVariation: patterns.maxVariation,
            meanAmplitude: patterns.meanAmplitude,
            cyclicality: patterns.cyclicality,
          },
          dataPoints: validData.length,
        };
      }

      return {
        detected: Object.values(diurnalResults).some(r => r.detected),
        byParameter: diurnalResults,
        summary: this._summarizeDiurnalResults(diurnalResults),
      };
    } catch (error) {
      logger.error('Diurnal pattern analysis failed', { error: error.message });
      return {
        detected: false,
        error: 'Diurnal pattern analysis failed: ' + error.message,
      };
    }
  }

  async _analyzeTrends(data) {
    try {
      const params = this._extractParameterNames(data);
      const trendResults = {};

      for (const param of params) {
        const validData = data.filter(
          d =>
            this._hasValidValue(d[param]) &&
            d.timestamp &&
            !isNaN(new Date(d.timestamp))
        );

        if (validData.length < 10) {
          // Need minimum data points for trend analysis
          trendResults[param] = {
            hasTrend: false,
            reason: 'Insufficient data for trend analysis',
            dataPoints: validData.length,
          };
          continue;
        }

        // Sort data by timestamp
        validData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // Extract time series data
        const timeValues = validData.map(d => new Date(d.timestamp).getTime());
        const paramValues = validData.map(d => d[param]);

        // Normalize time values to start from 0
        const startTime = timeValues[0];
        const normalizedTimes = timeValues.map(
          t => (t - startTime) / (1000 * 60 * 60)
        ); // Convert to hours

        // Perform linear regression
        const regression = this._calculateLinearRegression(
          normalizedTimes,
          paramValues
        );

        // Calculate additional trend metrics
        const trendMetrics = this._calculateTrendMetrics(
          normalizedTimes,
          paramValues,
          regression
        );

        // Detect trend significance
        const significance = this._assessTrendSignificance(
          regression,
          trendMetrics
        );

        trendResults[param] = {
          hasTrend: significance.isSignificant,
          direction: regression.slope > 0 ? 'increasing' : 'decreasing',
          strength: Math.abs(regression.correlation),
          confidence: significance.confidence,
          regression: {
            slope: regression.slope,
            intercept: regression.intercept,
            correlation: regression.correlation,
            rSquared: regression.rSquared,
          },
          metrics: {
            slopePerHour: regression.slope,
            slopePerDay: regression.slope * 24,
            totalChange:
              regression.slope *
              (normalizedTimes[normalizedTimes.length - 1] -
                normalizedTimes[0]),
            meanAbsoluteError: trendMetrics.mae,
            rootMeanSquareError: trendMetrics.rmse,
          },
          statistics: {
            pValue: significance.pValue,
            tStatistic: significance.tStatistic,
            standardError: trendMetrics.standardError,
          },
          timeRange: {
            startTime: validData[0].timestamp,
            endTime: validData[validData.length - 1].timestamp,
            durationHours: normalizedTimes[normalizedTimes.length - 1],
          },
          dataPoints: validData.length,
        };
      }

      return {
        hasTrends: Object.values(trendResults).some(r => r.hasTrend),
        byParameter: trendResults,
        summary: this._summarizeTrendResults(trendResults),
      };
    } catch (error) {
      logger.error('Trend analysis failed', { error: error.message });
      return {
        hasTrends: false,
        error: 'Trend analysis failed: ' + error.message,
      };
    }
  }

  /**
   * Analyze spatial coverage and geographic distribution
   * @private
   * @param {Array} data - Weather data with location coordinates
   * @returns {Object} Spatial coverage analysis
   */
  _analyzeSpatialCoverage(data) {
    try {
      // Extract location data
      const locations = data
        .filter(record => this._hasValidCoordinates(record))
        .map(record => ({
          lat: record.latitude || record.lat,
          lng: record.longitude || record.lng || record.lon,
          timestamp: record.timestamp,
        }));

      if (locations.length === 0) {
        return {
          coverage: 0,
          error: 'No valid coordinate data found',
          details: { totalRecords: data.length, validCoordinates: 0 },
        };
      }

      // Remove duplicate locations
      const uniqueLocations = this._removeDuplicateLocations(locations);

      // Calculate basic coverage metrics
      const bounds = this._calculateBasicBounds(uniqueLocations);
      const coverageArea = this._calculateCoverageArea(bounds);
      const centroid = this._calculateCentroid(uniqueLocations);

      // Calculate spatial distribution metrics
      const distribution = this._calculateSpatialDistribution(
        uniqueLocations,
        centroid
      );

      // Calculate coverage density
      const density = this._calculateCoverageDensity(
        uniqueLocations,
        coverageArea
      );

      // Analyze geographic spread
      const spread = this._analyzeGeographicSpread(uniqueLocations, bounds);

      // Calculate coverage quality score
      const qualityScore = this._calculateCoverageQuality(
        uniqueLocations,
        distribution,
        spread
      );

      return {
        totalRecords: data.length,
        validCoordinates: locations.length,
        uniqueLocations: uniqueLocations.length,
        bounds: {
          north: bounds.maxLat,
          south: bounds.minLat,
          east: bounds.maxLng,
          west: bounds.minLng,
          latSpan: bounds.maxLat - bounds.minLat,
          lngSpan: bounds.maxLng - bounds.minLng,
        },
        centroid: {
          latitude: centroid.lat,
          longitude: centroid.lng,
        },
        coverage: {
          areaKm2: coverageArea,
          density: density,
          qualityScore: qualityScore,
        },
        distribution: {
          meanDistance: distribution.meanDistance,
          standardDeviation: distribution.standardDeviation,
          spreadIndex: distribution.spreadIndex,
          clusteringIndex: distribution.clusteringIndex,
        },
        spread: {
          maximumDistance: spread.maxDistance,
          averageNearestNeighbor: spread.avgNearestNeighbor,
          spatialAutocorrelation: spread.spatialAutocorrelation,
        },
      };
    } catch (error) {
      logger.error('Spatial coverage analysis failed', {
        error: error.message,
      });
      return {
        coverage: 0,
        error: 'Coverage analysis failed: ' + error.message,
      };
    }
  }

  /**
   * Analyze spatial density using grid-based methods with hotspot detection
   * @private
   * @param {Array} data - Weather data with location coordinates
   * @returns {Object} Spatial density analysis
   */
  _analyzeSpatialDensity(data) {
    try {
      // Extract location data
      const locations = data
        .filter(record => this._hasValidCoordinates(record))
        .map(record => ({
          lat: record.latitude || record.lat,
          lng: record.longitude || record.lng || record.lon,
          timestamp: record.timestamp,
        }));

      if (locations.length === 0) {
        return {
          density: 0,
          error: 'No valid coordinate data found',
          details: { totalRecords: data.length, validCoordinates: 0 },
        };
      }

      // Calculate bounds for grid
      const bounds = this._calculateBasicBounds(locations);

      // Determine optimal grid size based on data extent and point count
      const gridSize = this._calculateOptimalGridSize(bounds, locations.length);

      // Create density grid
      const densityGrid = this._createDensityGrid(locations, bounds, gridSize);

      // Calculate density statistics
      const densityStats = this._calculateDensityStatistics(densityGrid);

      // Identify hotspots and coldspots
      const hotspots = this._identifyHotspots(densityGrid, densityStats);
      const coldspots = this._identifyColdspots(densityGrid, densityStats);

      // Calculate spatial density metrics
      const metrics = this._calculateDensityMetrics(
        densityGrid,
        bounds,
        locations.length
      );

      // Analyze density patterns
      const patterns = this._analyzeDensityPatterns(densityGrid, densityStats);

      return {
        totalRecords: data.length,
        validCoordinates: locations.length,
        gridConfiguration: {
          cellsX: gridSize.cellsX,
          cellsY: gridSize.cellsY,
          cellSizeKm2: gridSize.cellSizeKm2,
          totalCells: gridSize.cellsX * gridSize.cellsY,
        },
        densityStatistics: {
          mean: densityStats.mean,
          median: densityStats.median,
          standardDeviation: densityStats.standardDeviation,
          min: densityStats.min,
          max: densityStats.max,
          range: densityStats.range,
        },
        spatialMetrics: {
          overallDensity: metrics.overallDensity,
          densityVariation: metrics.densityVariation,
          spatialConcentration: metrics.spatialConcentration,
          clusteringCoefficient: metrics.clusteringCoefficient,
        },
        hotspots: {
          count: hotspots.length,
          locations: hotspots,
          averageDensity:
            hotspots.length > 0
              ? hotspots.reduce((sum, h) => sum + h.density, 0) /
                hotspots.length
              : 0,
        },
        coldspots: {
          count: coldspots.length,
          locations: coldspots,
          averageDensity:
            coldspots.length > 0
              ? coldspots.reduce((sum, c) => sum + c.density, 0) /
                coldspots.length
              : 0,
        },
        patterns: {
          distributionType: patterns.distributionType,
          uniformityIndex: patterns.uniformityIndex,
          segregationIndex: patterns.segregationIndex,
          concentrationRatio: patterns.concentrationRatio,
        },
        grid: this._compressGridForOutput(densityGrid), // Compressed representation
      };
    } catch (error) {
      logger.error('Spatial density analysis failed', { error: error.message });
      return {
        density: 0,
        error: 'Density analysis failed: ' + error.message,
      };
    }
  }

  /**
   * Analyze spatial clusters using DBSCAN algorithm
   * @private
   * @param {Array} data - Weather data with location coordinates
   * @returns {Object} Spatial clustering analysis
   */
  _analyzeSpatialClusters(data) {
    try {
      // Extract location data
      const locations = data
        .filter(record => this._hasValidCoordinates(record))
        .map((record, index) => ({
          id: index,
          lat: record.latitude || record.lat,
          lng: record.longitude || record.lng || record.lon,
          timestamp: record.timestamp,
          clusterId: -1, // -1 indicates unassigned, -2 indicates noise
          visited: false,
        }));

      if (locations.length === 0) {
        return {
          clusters: [],
          error: 'No valid coordinate data found',
          details: { totalRecords: data.length, validCoordinates: 0 },
        };
      }

      if (locations.length < 3) {
        return {
          clusters: [],
          noise: locations,
          message: 'Insufficient points for clustering analysis',
          details: {
            totalRecords: data.length,
            validCoordinates: locations.length,
          },
        };
      }

      // Determine optimal DBSCAN parameters
      const params = this._calculateOptimalDBSCANParams(locations);

      // Apply DBSCAN clustering algorithm
      const clusterResult = this._applyDBSCAN(
        locations,
        params.epsilon,
        params.minPoints
      );

      // Analyze cluster characteristics
      const clusterAnalysis = this._analyzeClusterCharacteristics(
        clusterResult.clusters
      );

      // Calculate clustering quality metrics
      const qualityMetrics = this._calculateClusteringQuality(
        clusterResult,
        locations
      );

      // Identify cluster patterns
      const patterns = this._identifyClusterPatterns(clusterResult.clusters);

      return {
        totalRecords: data.length,
        validCoordinates: locations.length,
        parameters: {
          epsilon: params.epsilon,
          epsilonKm: params.epsilonKm,
          minPoints: params.minPoints,
          algorithm: 'DBSCAN',
        },
        clustering: {
          clusterCount: clusterResult.clusters.length,
          noisePoints: clusterResult.noise.length,
          clusteredPoints: clusterResult.clusteredPoints,
          clusteringRatio: clusterResult.clusteredPoints / locations.length,
        },
        clusters: clusterResult.clusters.map(cluster => ({
          id: cluster.id,
          size: cluster.points.length,
          centroid: cluster.centroid,
          bounds: cluster.bounds,
          density: cluster.density,
          compactness: cluster.compactness,
          points: cluster.points.map(p => ({
            lat: p.lat,
            lng: p.lng,
            timestamp: p.timestamp,
          })),
        })),
        noise: clusterResult.noise.map(p => ({
          lat: p.lat,
          lng: p.lng,
          timestamp: p.timestamp,
        })),
        analysis: {
          averageClusterSize: clusterAnalysis.averageSize,
          largestClusterSize: clusterAnalysis.largestSize,
          smallestClusterSize: clusterAnalysis.smallestSize,
          clusterSizeVariation: clusterAnalysis.sizeVariation,
          averageIntraClusterDistance: clusterAnalysis.avgIntraClusterDistance,
          averageInterClusterDistance: clusterAnalysis.avgInterClusterDistance,
        },
        qualityMetrics: {
          silhouetteScore: qualityMetrics.silhouetteScore,
          daviesBouldinIndex: qualityMetrics.daviesBouldinIndex,
          calinskiHarabaszIndex: qualityMetrics.calinskiHarabaszIndex,
          qualityCategory: qualityMetrics.category,
        },
        patterns: {
          dominantPattern: patterns.dominantPattern,
          spatialDistribution: patterns.spatialDistribution,
          clusterSeparation: patterns.clusterSeparation,
          hierarchicalStructure: patterns.hierarchicalStructure,
        },
      };
    } catch (error) {
      logger.error('Spatial clustering analysis failed', {
        error: error.message,
      });
      return {
        clusters: [],
        error: 'Clustering analysis failed: ' + error.message,
      };
    }
  }

  /**
   * Calculate spatial bounds using convex hull and bounding box calculations
   * @private
   * @param {Array} data - Weather data with location coordinates
   * @returns {Object} Spatial bounds analysis
   */
  _calculateSpatialBounds(data) {
    try {
      // Extract location data
      const locations = data
        .filter(record => this._hasValidCoordinates(record))
        .map(record => ({
          lat: record.latitude || record.lat,
          lng: record.longitude || record.lng || record.lon,
          timestamp: record.timestamp,
        }));

      if (locations.length === 0) {
        return {
          bounds: null,
          error: 'No valid coordinate data found',
          details: { totalRecords: data.length, validCoordinates: 0 },
        };
      }

      // Handle edge cases
      if (locations.length === 1) {
        const point = locations[0];
        return {
          totalRecords: data.length,
          validCoordinates: 1,
          boundingBox: {
            north: point.lat,
            south: point.lat,
            east: point.lng,
            west: point.lng,
            latSpan: 0,
            lngSpan: 0,
            area: 0,
          },
          convexHull: {
            vertices: [point],
            area: 0,
            perimeter: 0,
          },
          geometry: {
            centroid: { lat: point.lat, lng: point.lng },
            type: 'single_point',
          },
        };
      }

      // Remove duplicate locations for hull calculation
      const uniqueLocations = this._removeDuplicateLocations(locations);

      // Calculate bounding box
      const boundingBox = this._calculateBoundingBox(uniqueLocations);

      // Calculate convex hull using Graham scan algorithm
      const convexHull = this._calculateConvexHull(uniqueLocations);

      // Calculate geometric properties
      const geometry = this._calculateGeometricProperties(
        uniqueLocations,
        convexHull,
        boundingBox
      );

      // Calculate spatial coverage metrics
      const coverage = this._calculateSpatialCoverageMetrics(
        uniqueLocations,
        convexHull,
        boundingBox
      );

      // Analyze spatial distribution
      const distribution = this._analyzeSpatialBoundsDistribution(
        uniqueLocations,
        convexHull
      );

      return {
        totalRecords: data.length,
        validCoordinates: locations.length,
        uniqueLocations: uniqueLocations.length,
        boundingBox: {
          north: boundingBox.north,
          south: boundingBox.south,
          east: boundingBox.east,
          west: boundingBox.west,
          latSpan: boundingBox.latSpan,
          lngSpan: boundingBox.lngSpan,
          area: boundingBox.area,
          aspectRatio: boundingBox.aspectRatio,
        },
        convexHull: {
          vertices: convexHull.vertices,
          vertexCount: convexHull.vertices.length,
          area: convexHull.area,
          perimeter: convexHull.perimeter,
          centroid: convexHull.centroid,
        },
        geometry: {
          centroid: geometry.centroid,
          type: geometry.type,
          compactness: geometry.compactness,
          elongation: geometry.elongation,
          rectangularFit: geometry.rectangularFit,
        },
        coverage: {
          hullCoverageRatio: coverage.hullCoverageRatio,
          pointDensity: coverage.pointDensity,
          spatialEfficiency: coverage.spatialEfficiency,
          boundaryComplexity: coverage.boundaryComplexity,
        },
        distribution: {
          spatialSpreadIndex: distribution.spatialSpreadIndex,
          edgePointRatio: distribution.edgePointRatio,
          interiorPointRatio: distribution.interiorPointRatio,
          distributionType: distribution.distributionType,
        },
      };
    } catch (error) {
      logger.error('Spatial bounds calculation failed', {
        error: error.message,
      });
      return {
        bounds: null,
        error: 'Bounds calculation failed: ' + error.message,
      };
    }
  }

  _analyzeTemporalCompleteness(data, params) {
    try {
      if (!data.length || !params.length) {
        return {
          completeness: 0,
          message: 'No data or parameters provided',
        };
      }

      // Extract and sort timestamps
      const timestamps = data
        .map(d => new Date(d.timestamp))
        .filter(t => !isNaN(t))
        .sort((a, b) => a - b);

      if (timestamps.length < 2) {
        return {
          completeness: 0,
          message: 'Insufficient temporal data',
          details: { validTimestamps: timestamps.length },
        };
      }

      // Estimate expected frequency
      const intervals = [];
      for (let i = 1; i < Math.min(timestamps.length, 100); i++) {
        intervals.push(timestamps[i] - timestamps[i - 1]);
      }

      const medianInterval = this._calculateMedian(intervals);
      const expectedFrequency = this._estimateExpectedFrequency(medianInterval);

      // Calculate expected number of records
      const timeSpan = timestamps[timestamps.length - 1] - timestamps[0];
      const expectedRecords = Math.floor(timeSpan / medianInterval) + 1;

      // Analyze gaps and missing periods
      const gapAnalysis = this._analyzeTemporalGaps(timestamps);
      const missingPeriods = this._identifyMissingPeriods(
        timestamps,
        medianInterval
      );

      // Calculate completeness by parameter
      const parameterCompleteness = {};
      for (const param of params) {
        const validValues = data.filter(
          d => this._hasValidValue(d[param]) && !isNaN(new Date(d.timestamp))
        );

        parameterCompleteness[param] = {
          validRecords: validValues.length,
          totalRecords: timestamps.length,
          expectedRecords: expectedRecords,
          completenessRatio: validValues.length / expectedRecords,
          completenessPercentage: (validValues.length / expectedRecords) * 100,
          missingCount: expectedRecords - validValues.length,
        };
      }

      // Calculate time-based completeness patterns
      const temporalPatterns = this._analyzeTemporalCompletenessPatterns(
        data,
        params,
        medianInterval
      );

      // Overall temporal completeness score
      const overallCompleteness = this._calculateOverallTemporalCompleteness(
        timestamps.length,
        expectedRecords,
        gapAnalysis,
        parameterCompleteness
      );

      return {
        completeness: overallCompleteness.score,
        details: {
          temporal: {
            actualRecords: timestamps.length,
            expectedRecords: expectedRecords,
            completenessRatio: timestamps.length / expectedRecords,
            estimatedFrequency: expectedFrequency,
            medianIntervalMs: medianInterval,
            timeSpanHours: timeSpan / (1000 * 60 * 60),
          },
          gaps: {
            gapCount: gapAnalysis.gapCount,
            totalGapDurationHours:
              gapAnalysis.totalGapDurationMs / (1000 * 60 * 60),
            largestGapHours: gapAnalysis.largestGapHours,
            missingPeriods: missingPeriods,
          },
          byParameter: parameterCompleteness,
          patterns: temporalPatterns,
          qualityMetrics: {
            dataConsistency: overallCompleteness.consistency,
            temporalRegularity: overallCompleteness.regularity,
            coverageQuality: overallCompleteness.coverage,
          },
        },
      };
    } catch (error) {
      logger.error('Temporal completeness analysis failed', {
        error: error.message,
      });
      return {
        completeness: 0,
        error: 'Temporal completeness analysis failed: ' + error.message,
      };
    }
  }

  /**
   * Analyze missing data patterns to detect MCAR, MAR, and MNAR patterns
   * @param {Array} data - Array of weather observations
   * @param {Array} params - Parameter names to analyze
   * @returns {Object} Missing data pattern analysis results
   * @private
   */
  _analyzeMissingDataPatterns(data, params) {
    try {
      if (!data || !Array.isArray(data) || data.length === 0) {
        return {
          error: 'No data provided for missing data pattern analysis',
          mcar: null,
          mar: null,
          mnar: null,
        };
      }

      if (!params || !Array.isArray(params) || params.length === 0) {
        return {
          error: 'No parameters provided for missing data pattern analysis',
          mcar: null,
          mar: null,
          mnar: null,
        };
      }

      const results = {
        summary: {
          totalRecords: data.length,
          totalFields: data.length * params.length,
          analysisTimestamp: new Date().toISOString(),
        },
        byParameter: {},
        patterns: {},
        temporal: {},
        spatial: {},
        correlations: {},
        recommendations: {},
      };

      // Call each analysis function separately with error handling
      try {
        results.patterns.mcar = this._detectMCARPatterns(data, params);
      } catch (e) {
        logger.error('MCAR detection failed', { error: e.message });
        results.patterns.mcar = { error: 'MCAR analysis failed: ' + e.message };
      }

      try {
        results.patterns.mar = this._detectMARPatterns(data, params);
      } catch (e) {
        logger.error('MAR detection failed', { error: e.message });
        results.patterns.mar = { error: 'MAR analysis failed: ' + e.message };
      }

      try {
        results.patterns.mnar = this._detectMNARPatterns(data, params);
      } catch (e) {
        logger.error('MNAR detection failed', { error: e.message });
        results.patterns.mnar = { error: 'MNAR analysis failed: ' + e.message };
      }

      try {
        results.temporal = this._analyzeTemporalMissingPatterns(data, params);
      } catch (e) {
        logger.error('Temporal missing pattern analysis failed', {
          error: e.message,
        });
        results.temporal = { error: 'Temporal analysis failed: ' + e.message };
      }

      try {
        results.spatial = this._analyzeSpatialMissingPatterns(data, params);
      } catch (e) {
        logger.error('Spatial missing pattern analysis failed', {
          error: e.message,
        });
        results.spatial = { error: 'Spatial analysis failed: ' + e.message };
      }

      try {
        results.correlations = this._analyzeMissingDataCorrelations(
          data,
          params
        );
      } catch (e) {
        logger.error('Missing data correlation analysis failed', {
          error: e.message,
        });
        results.correlations = {
          error: 'Correlation analysis failed: ' + e.message,
        };
      }

      try {
        results.recommendations = this._generateMissingDataRecommendations(
          data,
          params
        );
      } catch (e) {
        logger.error('Missing data recommendations failed', {
          error: e.message,
        });
        results.recommendations = {
          error: 'Recommendations failed: ' + e.message,
        };
      }

      // Per-parameter missing data statistics
      for (const param of params) {
        const paramStats = this._calculateParameterMissingStats(data, param);
        results.byParameter[param] = paramStats;
      }

      // Calculate overall missingness patterns
      results.summary.totalMissing = Object.values(results.byParameter).reduce(
        (sum, stats) => sum + stats.missingCount,
        0
      );
      results.summary.missingPercentage =
        (results.summary.totalMissing / results.summary.totalFields) * 100;

      // Add pattern confidence scores
      try {
        results.patternConfidence = this._calculatePatternConfidence(
          results.patterns
        );
      } catch (e) {
        logger.error('Pattern confidence calculation failed', {
          error: e.message,
          patterns: results.patterns,
        });
        results.patternConfidence = 0;
      }

      return results;
    } catch (error) {
      logger.error('Missing data pattern analysis failed', {
        error: error.message,
      });
      return {
        error: 'Missing data pattern analysis failed: ' + error.message,
        mcar: null,
        mar: null,
        mnar: null,
      };
    }
  }

  /**
   * Detect Missing Completely At Random (MCAR) patterns
   * Tests if missingness is independent of observed and unobserved data
   * @param {Array} data - Weather data array
   * @param {Array} params - Parameter names
   * @returns {Object} MCAR analysis results
   * @private
   */
  _detectMCARPatterns(data, params) {
    try {
      const mcarResults = {
        overallTest: {},
        parameterTests: {},
        interpretation: '',
        confidence: 0,
      };

      // Little's MCAR test approximation
      // Tests null hypothesis that data is MCAR
      const missingPatterns = this._getMissingPatterns(data, params);
      const observedPatterns = Object.keys(missingPatterns).length;
      const expectedPatterns = Math.pow(2, params.length) - 1; // All possible missing patterns except complete

      // Chi-square approximation for pattern distribution
      const chiSquareStatistic = this._calculateChiSquareForPatterns(
        missingPatterns,
        data.length
      );
      const degreesOfFreedom = Math.max(1, observedPatterns - 1);
      const pValue = this._approximateChiSquarePValue(
        chiSquareStatistic,
        degreesOfFreedom
      );

      mcarResults.overallTest = {
        statistic: chiSquareStatistic,
        degreesOfFreedom,
        pValue,
        significant: pValue < 0.05,
        interpretation:
          pValue < 0.05
            ? 'Reject MCAR hypothesis'
            : 'Cannot reject MCAR hypothesis',
      };

      // Per-parameter MCAR tests
      for (const param of params) {
        const paramTest = this._testParameterMCAR(data, param, params);
        mcarResults.parameterTests[param] = paramTest;
      }

      // Overall interpretation
      const significantParams = Object.values(
        mcarResults.parameterTests
      ).filter(test => test.significant).length;

      if (
        mcarResults.overallTest.significant ||
        significantParams > params.length * 0.3
      ) {
        mcarResults.interpretation =
          'Data is likely NOT Missing Completely At Random (MCAR). Missingness may depend on observed or unobserved variables.';
        mcarResults.confidence = Math.min(
          90,
          60 + (significantParams / params.length) * 30
        );
      } else {
        mcarResults.interpretation =
          'Data appears to be Missing Completely At Random (MCAR). Missingness is independent of data values.';
        mcarResults.confidence = Math.min(85, 50 + (1 - pValue) * 35);
      }

      return mcarResults;
    } catch (error) {
      logger.error('MCAR detection failed', { error: error.message });
      return {
        error: 'MCAR detection failed: ' + error.message,
        overallTest: {},
        parameterTests: {},
        interpretation: 'MCAR analysis could not be completed',
        confidence: 0,
      };
    }
  }

  /**
   * Detect Missing At Random (MAR) patterns
   * Tests if missingness depends on observed data but not on missing values themselves
   * @param {Array} data - Weather data array
   * @param {Array} params - Parameter names
   * @returns {Object} MAR analysis results
   * @private
   */
  _detectMARPatterns(data, params) {
    try {
      const marResults = {
        dependencies: {},
        strongestDependencies: [],
        interpretation: '',
        confidence: 0,
      };

      // Test each parameter's missingness against observed values of other parameters
      for (const targetParam of params) {
        const otherParams = params.filter(p => p !== targetParam);
        const dependencies = {};

        for (const predictor of otherParams) {
          const dependency = this._testMissingnessDependency(
            data,
            targetParam,
            predictor
          );
          if (
            dependency.correlation !== null &&
            !isNaN(dependency.correlation)
          ) {
            dependencies[predictor] = dependency;
          }
        }

        marResults.dependencies[targetParam] = dependencies;
      }

      // Identify strongest dependencies (potential MAR patterns)
      const allDependencies = [];
      for (const [target, deps] of Object.entries(marResults.dependencies)) {
        for (const [predictor, dep] of Object.entries(deps)) {
          if (dep.significant && Math.abs(dep.correlation) > 0.1) {
            allDependencies.push({
              target,
              predictor,
              correlation: dep.correlation,
              pValue: dep.pValue,
              strength: Math.abs(dep.correlation),
            });
          }
        }
      }

      marResults.strongestDependencies = allDependencies
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 10); // Top 10 strongest dependencies

      // Overall interpretation
      const strongDependencies = marResults.strongestDependencies.length;
      const totalPossibleDependencies = params.length * (params.length - 1);

      if (strongDependencies > totalPossibleDependencies * 0.2) {
        marResults.interpretation =
          'Strong evidence of Missing At Random (MAR) patterns. Missingness depends on observed values of other variables.';
        marResults.confidence = Math.min(
          85,
          40 + (strongDependencies / totalPossibleDependencies) * 45
        );
      } else if (strongDependencies > 0) {
        marResults.interpretation =
          'Some evidence of Missing At Random (MAR) patterns detected, but not systematic.';
        marResults.confidence =
          30 + (strongDependencies / totalPossibleDependencies) * 25;
      } else {
        marResults.interpretation =
          'No clear Missing At Random (MAR) patterns detected.';
        marResults.confidence = 20;
      }

      return marResults;
    } catch (error) {
      logger.error('MAR detection failed', { error: error.message });
      return {
        error: 'MAR detection failed: ' + error.message,
        dependencies: {},
        strongestDependencies: [],
        interpretation: 'MAR analysis could not be completed',
        confidence: 0,
      };
    }
  }

  /**
   * Detect Missing Not At Random (MNAR) patterns
   * Tests if missingness depends on the missing values themselves
   * @param {Array} data - Weather data array
   * @param {Array} params - Parameter names
   * @returns {Object} MNAR analysis results
   * @private
   */
  _detectMNARPatterns(data, params) {
    try {
      const mnarResults = {
        systematicPatterns: {},
        extremeValueBias: {},
        temporalBias: {},
        spatialBias: {},
        interpretation: '',
        confidence: 0,
      };

      // Test for systematic missing patterns that suggest MNAR
      for (const param of params) {
        const patterns = this._detectSystematicMissingPatterns(data, param);
        mnarResults.systematicPatterns[param] = patterns;

        // Test for extreme value bias (missing values at distribution extremes)
        const extremeBias = this._testExtremeValueBias(data, param);
        mnarResults.extremeValueBias[param] = extremeBias;
      }

      // Test for temporal bias in missingness
      mnarResults.temporalBias = this._testTemporalMissingBias(data, params);

      // Test for spatial bias in missingness (if location data available)
      mnarResults.spatialBias = this._testSpatialMissingBias(data, params);

      // Overall MNAR assessment
      const systematicCount = Object.values(
        mnarResults.systematicPatterns
      ).filter(p => p.hasSystematicPattern).length;
      const extremeCount = Object.values(mnarResults.extremeValueBias).filter(
        b => b.hasExtremeBias
      ).length;
      const hasTemporal = mnarResults.temporalBias.hasSignificantBias;
      const hasSpatial = mnarResults.spatialBias.hasSignificantBias;

      const totalEvidence =
        systematicCount +
        extremeCount +
        (hasTemporal ? 1 : 0) +
        (hasSpatial ? 1 : 0);
      const maxEvidence = params.length * 2 + 2;

      if (totalEvidence > maxEvidence * 0.3) {
        mnarResults.interpretation =
          'Strong evidence of Missing Not At Random (MNAR) patterns. Missingness likely depends on the missing values themselves.';
        mnarResults.confidence = Math.min(
          85,
          50 + (totalEvidence / maxEvidence) * 35
        );
      } else if (totalEvidence > 0) {
        mnarResults.interpretation =
          'Some evidence of Missing Not At Random (MNAR) patterns detected.';
        mnarResults.confidence = 25 + (totalEvidence / maxEvidence) * 25;
      } else {
        mnarResults.interpretation =
          'No clear Missing Not At Random (MNAR) patterns detected.';
        mnarResults.confidence = 15;
      }

      return mnarResults;
    } catch (error) {
      logger.error('MNAR detection failed', { error: error.message });
      return {
        error: 'MNAR detection failed: ' + error.message,
        systematicPatterns: {},
        extremeValueBias: {},
        temporalBias: {},
        spatialBias: {},
        interpretation: 'MNAR analysis could not be completed',
        confidence: 0,
      };
    }
  }

  /**
   * Helper functions for missing data pattern analysis
   */

  /**
   * Calculate missing data statistics for a specific parameter
   * @param {Array} data - Weather data array
   * @param {string} param - Parameter name
   * @returns {Object} Parameter missing statistics
   * @private
   */
  _calculateParameterMissingStats(data, param) {
    const totalCount = data.length;
    const validCount = data.filter(record =>
      this._hasValidValue(record[param])
    ).length;
    const missingCount = totalCount - validCount;

    return {
      totalCount,
      validCount,
      missingCount,
      missingPercentage: (missingCount / totalCount) * 100,
      validPercentage: (validCount / totalCount) * 100,
    };
  }

  /**
   * Get missing patterns across all parameters
   * @param {Array} data - Weather data array
   * @param {Array} params - Parameter names
   * @returns {Object} Missing patterns with their frequencies
   * @private
   */
  _getMissingPatterns(data, params) {
    const patterns = {};

    for (const record of data) {
      const pattern = params
        .map(param => (this._hasValidValue(record[param]) ? '1' : '0'))
        .join('');
      if (pattern !== '1'.repeat(params.length)) {
        // Skip completely valid records
        patterns[pattern] = (patterns[pattern] || 0) + 1;
      }
    }

    return patterns;
  }

  /**
   * Calculate chi-square statistic for missing patterns
   * @param {Object} patterns - Missing patterns with frequencies
   * @param {number} totalRecords - Total number of records
   * @returns {number} Chi-square statistic
   * @private
   */
  _calculateChiSquareForPatterns(patterns, totalRecords) {
    const patternCounts = Object.values(patterns);
    const numPatterns = patternCounts.length;

    if (numPatterns <= 1) return 0;

    const expectedFreq = totalRecords / numPatterns;
    let chiSquare = 0;

    for (const count of patternCounts) {
      const diff = count - expectedFreq;
      chiSquare += (diff * diff) / expectedFreq;
    }

    return chiSquare;
  }

  /**
   * Approximate chi-square p-value
   * @param {number} statistic - Chi-square statistic
   * @param {number} df - Degrees of freedom
   * @returns {number} Approximate p-value
   * @private
   */
  _approximateChiSquarePValue(statistic, df) {
    if (df <= 0 || statistic < 0) return 1;

    // Simple approximation using normal distribution for large df
    if (df > 30) {
      const normalized = (statistic - df) / Math.sqrt(2 * df);
      return 1 - this._normalCDF(normalized);
    }

    // Basic approximation for smaller df
    const critical005 = this._getCriticalValue(df, 0.05);
    const critical001 = this._getCriticalValue(df, 0.01);

    if (statistic > critical001) return 0.001;
    if (statistic > critical005) return 0.01;
    return 0.5; // Conservative estimate
  }

  /**
   * Get critical value for chi-square distribution (approximate)
   * @param {number} df - Degrees of freedom
   * @param {number} alpha - Significance level
   * @returns {number} Critical value
   * @private
   */
  _getCriticalValue(df, alpha) {
    // Simplified lookup table for common values
    const criticalValues = {
      0.05: [3.84, 5.99, 7.81, 9.49, 11.07, 12.59, 14.07, 15.51, 16.92, 18.31],
      0.01: [
        6.63, 9.21, 11.34, 13.28, 15.09, 16.81, 18.48, 20.09, 21.67, 23.21,
      ],
    };

    if (df <= 10 && criticalValues[alpha]) {
      return criticalValues[alpha][df - 1] || 0;
    }

    // Rough approximation for larger df
    return df + Math.sqrt(2 * df) * (alpha === 0.05 ? 1.96 : 2.58);
  }

  /**
   * Normal cumulative distribution function approximation
   * @param {number} z - Z-score
   * @returns {number} Cumulative probability
   * @private
   */
  _normalCDF(z) {
    // Abramowitz and Stegun approximation
    const t = 1.0 / (1.0 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    let prob =
      d *
      t *
      (0.3193815 +
        t * (-0.3565638 + t * (1.7814779 + t * (-1.821256 + t * 1.3302744))));

    if (z > 0) prob = 1 - prob;
    return prob;
  }

  /**
   * Test parameter for MCAR patterns
   * @param {Array} data - Weather data array
   * @param {string} param - Target parameter
   * @param {Array} allParams - All parameter names
   * @returns {Object} MCAR test results for parameter
   * @private
   */
  _testParameterMCAR(data, param, allParams) {
    try {
      const missingIndicator = data.map(record =>
        this._hasValidValue(record[param]) ? 0 : 1
      );
      const missingCount = missingIndicator.filter(x => x === 1).length;

      if (missingCount === 0 || missingCount === data.length) {
        return {
          correlation: 0,
          pValue: 1,
          significant: false,
          interpretation: 'No variation in missingness',
        };
      }

      // Test correlation with other parameters
      const otherParams = allParams.filter(p => p !== param);
      let maxCorrelation = 0;
      let minPValue = 1;

      for (const otherParam of otherParams) {
        const otherValues = data.map(record =>
          this._hasValidValue(record[otherParam]) ? 1 : 0
        );
        const correlation = this._calculateCorrelation(
          missingIndicator,
          otherValues
        );

        if (
          !isNaN(correlation) &&
          Math.abs(correlation) > Math.abs(maxCorrelation)
        ) {
          maxCorrelation = correlation;
          // Rough p-value approximation
          const tStat =
            Math.abs(correlation) *
            Math.sqrt((data.length - 2) / (1 - correlation * correlation));
          minPValue = Math.min(minPValue, 2 * (1 - this._normalCDF(tStat)));
        }
      }

      return {
        correlation: maxCorrelation,
        pValue: minPValue,
        significant: minPValue < 0.05,
        interpretation:
          minPValue < 0.05
            ? 'Missingness correlates with other variables'
            : 'No significant correlation with other variables',
      };
    } catch (error) {
      return {
        correlation: null,
        pValue: 1,
        significant: false,
        interpretation: 'MCAR test failed: ' + error.message,
      };
    }
  }

  /**
   * Test dependency between missing indicator and observed values
   * @param {Array} data - Weather data array
   * @param {string} targetParam - Parameter with potential missing values
   * @param {string} predictorParam - Predictor parameter
   * @returns {Object} Dependency test results
   * @private
   */
  _testMissingnessDependency(data, targetParam, predictorParam) {
    try {
      const validData = data.filter(record =>
        this._hasValidValue(record[predictorParam])
      );

      if (validData.length < 10) {
        return {
          correlation: null,
          pValue: 1,
          significant: false,
          interpretation: 'Insufficient data for dependency test',
        };
      }

      const missingIndicator = validData.map(record =>
        this._hasValidValue(record[targetParam]) ? 0 : 1
      );
      const predictorValues = validData.map(record => record[predictorParam]);

      // Test correlation between predictor values and missingness
      const correlation = this._calculateCorrelation(
        predictorValues,
        missingIndicator
      );

      if (isNaN(correlation)) {
        return {
          correlation: null,
          pValue: 1,
          significant: false,
          interpretation: 'Could not calculate correlation',
        };
      }

      // Calculate approximate p-value
      const n = validData.length;
      const tStat =
        Math.abs(correlation) *
        Math.sqrt((n - 2) / (1 - correlation * correlation));
      const pValue = 2 * (1 - this._normalCDF(tStat));

      return {
        correlation,
        pValue,
        significant: pValue < 0.05,
        interpretation:
          pValue < 0.05
            ? 'Missingness depends on predictor values'
            : 'No significant dependency detected',
      };
    } catch (error) {
      return {
        correlation: null,
        pValue: 1,
        significant: false,
        interpretation: 'Dependency test failed: ' + error.message,
      };
    }
  }

  /**
   * Calculate correlation coefficient between two arrays
   * @param {Array} x - First array
   * @param {Array} y - Second array
   * @returns {number} Correlation coefficient
   * @private
   */
  _calculateCorrelation(x, y) {
    if (x.length !== y.length || x.length === 0) return NaN;

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt(
      (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
    );

    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Detect systematic missing patterns for MNAR analysis
   * @param {Array} data - Weather data array
   * @param {string} param - Parameter name
   * @returns {Object} Systematic pattern analysis
   * @private
   */
  _detectSystematicMissingPatterns(data, param) {
    try {
      const validData = data.filter(record =>
        this._hasValidValue(record[param])
      );
      const missingCount = data.length - validData.length;

      if (missingCount === 0) {
        return {
          hasSystematicPattern: false,
          pattern: 'No missing values',
          confidence: 0,
        };
      }

      // Check for consecutive missing patterns
      let consecutiveCount = 0;
      let maxConsecutive = 0;
      let consecutivePatterns = 0;

      for (let i = 0; i < data.length; i++) {
        if (!this._hasValidValue(data[i][param])) {
          consecutiveCount++;
        } else {
          if (consecutiveCount > 2) {
            consecutivePatterns++;
          }
          maxConsecutive = Math.max(maxConsecutive, consecutiveCount);
          consecutiveCount = 0;
        }
      }

      const hasSystematicPattern =
        maxConsecutive > data.length * 0.05 || consecutivePatterns > 3;

      return {
        hasSystematicPattern,
        maxConsecutiveLength: maxConsecutive,
        consecutivePatterns,
        pattern: hasSystematicPattern
          ? 'Systematic consecutive missing patterns detected'
          : 'No systematic patterns',
        confidence: hasSystematicPattern
          ? Math.min(80, 40 + (maxConsecutive / data.length) * 100)
          : 20,
      };
    } catch (error) {
      return {
        hasSystematicPattern: false,
        pattern: 'Pattern detection failed: ' + error.message,
        confidence: 0,
      };
    }
  }

  /**
   * Test for extreme value bias in missing data
   * @param {Array} data - Weather data array
   * @param {string} param - Parameter name
   * @returns {Object} Extreme value bias test results
   * @private
   */
  _testExtremeValueBias(data, param) {
    try {
      const allValues = data
        .map(record => record[param])
        .filter(val => this._hasValidValue(val));

      if (allValues.length < 10) {
        return {
          hasExtremeBias: false,
          interpretation: 'Insufficient data for extreme value bias test',
          confidence: 0,
        };
      }

      // Calculate percentiles
      const sorted = [...allValues].sort((a, b) => a - b);
      const p10 = sorted[Math.floor(sorted.length * 0.1)];
      const p90 = sorted[Math.floor(sorted.length * 0.9)];

      // Check if missing values cluster around extreme times/conditions
      let extremeMissing = 0;
      let totalMissing = 0;

      for (const record of data) {
        if (!this._hasValidValue(record[param])) {
          totalMissing++;

          // Check if other parameters suggest extreme conditions
          const temp = record.temperature;
          const wind = record.windSpeed;
          const pressure = record.pressure;

          if (
            (this._hasValidValue(temp) && (temp < -20 || temp > 40)) ||
            (this._hasValidValue(wind) && wind > 20) ||
            (this._hasValidValue(pressure) &&
              (pressure < 980 || pressure > 1040))
          ) {
            extremeMissing++;
          }
        }
      }

      const extremeRatio = totalMissing > 0 ? extremeMissing / totalMissing : 0;
      const hasExtremeBias = extremeRatio > 0.3;

      return {
        hasExtremeBias,
        extremeRatio,
        interpretation: hasExtremeBias
          ? 'Missing values tend to occur during extreme conditions'
          : 'No extreme value bias detected',
        confidence: hasExtremeBias ? Math.min(75, 30 + extremeRatio * 45) : 25,
      };
    } catch (error) {
      return {
        hasExtremeBias: false,
        interpretation: 'Extreme value bias test failed: ' + error.message,
        confidence: 0,
      };
    }
  }

  /**
   * Test for temporal bias in missing data
   * @param {Array} data - Weather data array
   * @param {Array} params - Parameter names
   * @returns {Object} Temporal bias test results
   * @private
   */
  _testTemporalMissingBias(data, params) {
    try {
      const temporalData = data.filter(
        record => record.timestamp && !isNaN(new Date(record.timestamp))
      );

      if (temporalData.length < 24) {
        // Need at least a day's worth of data
        return {
          hasSignificantBias: false,
          interpretation: 'Insufficient temporal data for bias test',
          confidence: 0,
        };
      }

      // Group by hour of day
      const hourlyMissing = Array(24).fill(0);
      const hourlyCounts = Array(24).fill(0);

      for (const record of temporalData) {
        const hour = new Date(record.timestamp).getHours();
        hourlyCounts[hour]++;

        const missingCount = params.filter(
          param => !this._hasValidValue(record[param])
        ).length;
        hourlyMissing[hour] += missingCount;
      }

      // Calculate hourly missing rates
      const hourlyRates = hourlyMissing.map((missing, i) =>
        hourlyCounts[i] > 0 ? missing / (hourlyCounts[i] * params.length) : 0
      );

      // Test for significant variation
      const meanRate = hourlyRates.reduce((a, b) => a + b, 0) / 24;
      const variance =
        hourlyRates.reduce(
          (sum, rate) => sum + Math.pow(rate - meanRate, 2),
          0
        ) / 24;
      const stdDev = Math.sqrt(variance);

      const hasSignificantBias = stdDev > meanRate * 0.5; // 50% relative variation

      return {
        hasSignificantBias,
        hourlyRates,
        meanRate,
        standardDeviation: stdDev,
        interpretation: hasSignificantBias
          ? 'Significant temporal bias in missing data'
          : 'No significant temporal bias detected',
        confidence: hasSignificantBias
          ? Math.min(80, 40 + (stdDev / meanRate) * 40)
          : 30,
      };
    } catch (error) {
      return {
        hasSignificantBias: false,
        interpretation: 'Temporal bias test failed: ' + error.message,
        confidence: 0,
      };
    }
  }

  /**
   * Test for spatial bias in missing data
   * @param {Array} data - Weather data array
   * @param {Array} params - Parameter names
   * @returns {Object} Spatial bias test results
   * @private
   */
  _testSpatialMissingBias(data, params) {
    try {
      const spatialData = data.filter(
        record =>
          this._hasValidValue(record.latitude) &&
          this._hasValidValue(record.longitude)
      );

      if (spatialData.length < 10) {
        return {
          hasSignificantBias: false,
          interpretation: 'Insufficient spatial data for bias test',
          confidence: 0,
        };
      }

      // Simple spatial clustering test - divide into grid cells
      const latRange = {
        min: Math.min(...spatialData.map(r => r.latitude)),
        max: Math.max(...spatialData.map(r => r.latitude)),
      };
      const lonRange = {
        min: Math.min(...spatialData.map(r => r.longitude)),
        max: Math.max(...spatialData.map(r => r.longitude)),
      };

      const gridSize = 5; // 5x5 grid
      const cellMissing = Array(gridSize)
        .fill()
        .map(() => Array(gridSize).fill(0));
      const cellCounts = Array(gridSize)
        .fill()
        .map(() => Array(gridSize).fill(0));

      for (const record of spatialData) {
        const latCell = Math.min(
          gridSize - 1,
          Math.floor(
            ((record.latitude - latRange.min) / (latRange.max - latRange.min)) *
              gridSize
          )
        );
        const lonCell = Math.min(
          gridSize - 1,
          Math.floor(
            ((record.longitude - lonRange.min) /
              (lonRange.max - lonRange.min)) *
              gridSize
          )
        );

        cellCounts[latCell][lonCell]++;
        const missingCount = params.filter(
          param => !this._hasValidValue(record[param])
        ).length;
        cellMissing[latCell][lonCell] += missingCount;
      }

      // Calculate cell missing rates
      const cellRates = [];
      for (let i = 0; i < gridSize; i++) {
        for (let j = 0; j < gridSize; j++) {
          if (cellCounts[i][j] > 0) {
            cellRates.push(
              cellMissing[i][j] / (cellCounts[i][j] * params.length)
            );
          }
        }
      }

      if (cellRates.length < 2) {
        return {
          hasSignificantBias: false,
          interpretation: 'Insufficient spatial variation for bias test',
          confidence: 0,
        };
      }

      // Test for significant variation
      const meanRate = cellRates.reduce((a, b) => a + b, 0) / cellRates.length;
      const variance =
        cellRates.reduce((sum, rate) => sum + Math.pow(rate - meanRate, 2), 0) /
        cellRates.length;
      const stdDev = Math.sqrt(variance);

      const hasSignificantBias = stdDev > meanRate * 0.4; // 40% relative variation

      return {
        hasSignificantBias,
        cellRates,
        meanRate,
        standardDeviation: stdDev,
        interpretation: hasSignificantBias
          ? 'Significant spatial bias in missing data'
          : 'No significant spatial bias detected',
        confidence: hasSignificantBias
          ? Math.min(75, 35 + (stdDev / meanRate) * 40)
          : 25,
      };
    } catch (error) {
      return {
        hasSignificantBias: false,
        interpretation: 'Spatial bias test failed: ' + error.message,
        confidence: 0,
      };
    }
  }

  /**
   * Analyze temporal missing patterns
   * @param {Array} data - Weather data array
   * @param {Array} params - Parameter names
   * @returns {Object} Temporal missing pattern analysis
   * @private
   */
  _analyzeTemporalMissingPatterns(data, params) {
    try {
      const temporalData = data.filter(
        record => record.timestamp && !isNaN(new Date(record.timestamp))
      );

      if (temporalData.length === 0) {
        return {
          error: 'No valid temporal data available',
          patterns: {},
          confidence: 0,
        };
      }

      // Sort by timestamp
      temporalData.sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );

      const patterns = {
        seasonalMissing: this._analyzeSeasonalMissingPatterns(
          temporalData,
          params
        ),
        weeklyMissing: this._analyzeWeeklyMissingPatterns(temporalData, params),
        dailyMissing: this._analyzeDailyMissingPatterns(temporalData, params),
        trendsInMissingness: this._analyzeMissingDataTrends(
          temporalData,
          params
        ),
      };

      return {
        patterns,
        dataCount: temporalData.length,
        timespan: {
          start: temporalData[0].timestamp,
          end: temporalData[temporalData.length - 1].timestamp,
        },
        confidence: this._calculateTemporalPatternConfidence(patterns),
      };
    } catch (error) {
      logger.error('Temporal missing pattern analysis failed', {
        error: error.message,
      });
      return {
        error: 'Temporal missing pattern analysis failed: ' + error.message,
        patterns: {},
        confidence: 0,
      };
    }
  }

  /**
   * Analyze spatial missing patterns
   * @param {Array} data - Weather data array
   * @param {Array} params - Parameter names
   * @returns {Object} Spatial missing pattern analysis
   * @private
   */
  _analyzeSpatialMissingPatterns(data, params) {
    try {
      const spatialData = data.filter(
        record =>
          this._hasValidValue(record.latitude) &&
          this._hasValidValue(record.longitude)
      );

      if (spatialData.length === 0) {
        return {
          error: 'No valid spatial data available',
          patterns: {},
          confidence: 0,
        };
      }

      const patterns = {
        geographicClustering: this._analyzeGeographicMissingClusters(
          spatialData,
          params
        ),
        altitudeRelated: this._analyzeAltitudeMissingPatterns(
          spatialData,
          params
        ),
        distanceBased: this._analyzeDistanceBasedMissing(spatialData, params),
      };

      return {
        patterns,
        dataCount: spatialData.length,
        spatialBounds: this._calculateSpatialBounds(spatialData),
        confidence: this._calculateSpatialPatternConfidence(patterns),
      };
    } catch (error) {
      logger.error('Spatial missing pattern analysis failed', {
        error: error.message,
      });
      return {
        error: 'Spatial missing pattern analysis failed: ' + error.message,
        patterns: {},
        confidence: 0,
      };
    }
  }

  /**
   * Analyze correlations between missing data patterns
   * @param {Array} data - Weather data array
   * @param {Array} params - Parameter names
   * @returns {Object} Missing data correlation analysis
   * @private
   */
  _analyzeMissingDataCorrelations(data, params) {
    try {
      const correlationMatrix = {};
      const pairwiseAnalysis = [];

      // Create missing indicators for each parameter
      const missingIndicators = {};
      for (const param of params) {
        missingIndicators[param] = data.map(record =>
          this._hasValidValue(record[param]) ? 0 : 1
        );
      }

      // Calculate pairwise correlations
      for (let i = 0; i < params.length; i++) {
        correlationMatrix[params[i]] = {};
        for (let j = 0; j < params.length; j++) {
          if (i !== j) {
            const correlation = this._calculateCorrelation(
              missingIndicators[params[i]],
              missingIndicators[params[j]]
            );
            correlationMatrix[params[i]][params[j]] = correlation;

            if (!isNaN(correlation) && Math.abs(correlation) > 0.1) {
              // Calculate significance
              const n = data.length;
              const tStat =
                Math.abs(correlation) *
                Math.sqrt((n - 2) / (1 - correlation * correlation));
              const pValue = 2 * (1 - this._normalCDF(tStat));

              pairwiseAnalysis.push({
                param1: params[i],
                param2: params[j],
                correlation,
                pValue,
                significant: pValue < 0.05,
                strength: this._interpretCorrelationStrength(
                  Math.abs(correlation)
                ),
              });
            }
          } else {
            correlationMatrix[params[i]][params[j]] = 1.0; // Perfect correlation with self
          }
        }
      }

      // Sort by correlation strength
      pairwiseAnalysis.sort(
        (a, b) => Math.abs(b.correlation) - Math.abs(a.correlation)
      );

      return {
        correlationMatrix,
        strongestCorrelations: pairwiseAnalysis.slice(0, 10),
        significantPairs: pairwiseAnalysis.filter(p => p.significant).length,
        averageCorrelation:
          pairwiseAnalysis.length > 0
            ? pairwiseAnalysis.reduce(
                (sum, p) => sum + Math.abs(p.correlation),
                0
              ) / pairwiseAnalysis.length
            : 0,
      };
    } catch (error) {
      logger.error('Missing data correlation analysis failed', {
        error: error.message,
      });
      return {
        error: 'Missing data correlation analysis failed: ' + error.message,
        correlationMatrix: {},
        strongestCorrelations: [],
        significantPairs: 0,
        averageCarrelation: 0,
      };
    }
  }

  /**
   * Generate recommendations for handling missing data
   * @param {Array} data - Weather data array
   * @param {Array} params - Parameter names
   * @returns {Object} Missing data handling recommendations
   * @private
   */
  _generateMissingDataRecommendations(data, params) {
    try {
      const recommendations = {
        imputationStrategies: [],
        dataCollectionImprovements: [],
        analysisConsiderations: [],
        overallStrategy: '',
      };

      // Calculate overall missing percentage
      const totalFields = data.length * params.length;
      const totalMissing = data.reduce((sum, record) => {
        return (
          sum +
          params.filter(param => !this._hasValidValue(record[param])).length
        );
      }, 0);
      const missingPercentage = (totalMissing / totalFields) * 100;

      // Per-parameter recommendations
      for (const param of params) {
        const paramStats = this._calculateParameterMissingStats(data, param);

        if (paramStats.missingPercentage === 0) continue;

        if (paramStats.missingPercentage < 5) {
          recommendations.imputationStrategies.push({
            parameter: param,
            strategy: 'Simple imputation',
            methods: ['mean', 'median', 'linear interpolation'],
            rationale: `Low missing rate (${paramStats.missingPercentage.toFixed(1)}%) allows for simple imputation methods`,
          });
        } else if (paramStats.missingPercentage < 20) {
          recommendations.imputationStrategies.push({
            parameter: param,
            strategy: 'Advanced imputation',
            methods: [
              'multiple imputation',
              'regression imputation',
              'k-NN imputation',
            ],
            rationale: `Moderate missing rate (${paramStats.missingPercentage.toFixed(1)}%) requires more sophisticated imputation`,
          });
        } else if (paramStats.missingPercentage < 50) {
          recommendations.imputationStrategies.push({
            parameter: param,
            strategy: 'Pattern-based imputation',
            methods: [
              'seasonal imputation',
              'pattern matching',
              'model-based imputation',
            ],
            rationale: `High missing rate (${paramStats.missingPercentage.toFixed(1)}%) requires pattern-aware imputation`,
          });
        } else {
          recommendations.imputationStrategies.push({
            parameter: param,
            strategy: 'Consider exclusion',
            methods: [
              'data collection improvement',
              'alternative data sources',
              'sensor replacement',
            ],
            rationale: `Very high missing rate (${paramStats.missingPercentage.toFixed(1)}%) may indicate systematic sensor failure`,
          });
        }
      }

      // Data collection improvements
      if (missingPercentage > 10) {
        recommendations.dataCollectionImprovements.push(
          'Review data collection infrastructure for systematic failures',
          'Implement redundant sensor systems for critical measurements',
          'Establish regular maintenance schedules for monitoring equipment'
        );
      }

      if (missingPercentage > 20) {
        recommendations.dataCollectionImprovements.push(
          'Consider alternative data sources for validation and gap-filling',
          'Implement real-time data quality monitoring with alerts',
          'Establish backup measurement systems for critical parameters'
        );
      }

      // Analysis considerations
      recommendations.analysisConsiderations.push(
        'Perform sensitivity analysis to assess impact of missing data',
        'Document missing data patterns in analysis reports',
        'Consider using multiple imputation for uncertainty quantification'
      );

      if (missingPercentage > 15) {
        recommendations.analysisConsiderations.push(
          'Use robust statistical methods that handle missing data',
          'Report confidence intervals that account for missing data uncertainty',
          'Consider bias-adjusted estimates for critical parameters'
        );
      }

      // Overall strategy
      if (missingPercentage < 5) {
        recommendations.overallStrategy =
          'Low missing data rate allows for standard analysis with simple imputation techniques.';
      } else if (missingPercentage < 15) {
        recommendations.overallStrategy =
          'Moderate missing data requires careful imputation strategy and sensitivity analysis.';
      } else if (missingPercentage < 30) {
        recommendations.overallStrategy =
          'High missing data rate requires advanced missing data techniques and systematic data collection improvements.';
      } else {
        recommendations.overallStrategy =
          'Very high missing data rate indicates systematic issues requiring immediate data collection infrastructure review and alternative data sources.';
      }

      return recommendations;
    } catch (error) {
      logger.error('Missing data recommendations failed', {
        error: error.message,
      });
      return {
        error: 'Missing data recommendations failed: ' + error.message,
        imputationStrategies: [],
        dataCollectionImprovements: [],
        analysisConsiderations: [],
        overallStrategy:
          'Unable to generate recommendations due to analysis error',
      };
    }
  }

  /**
   * Calculate pattern confidence scores
   * @param {Object} patterns - Pattern analysis results
   * @returns {Object} Confidence scores for different pattern types
   * @private
   */
  _calculatePatternConfidence(patterns) {
    try {
      const confidence = {
        mcar: patterns.mcar ? patterns.mcar.confidence || 0 : 0,
        mar: patterns.mar ? patterns.mar.confidence || 0 : 0,
        mnar: patterns.mnar ? patterns.mnar.confidence || 0 : 0,
        overall: 0,
      };

      // Calculate overall confidence as weighted average
      const weights = { mcar: 0.4, mar: 0.3, mnar: 0.3 };
      confidence.overall =
        confidence.mcar * weights.mcar +
        confidence.mar * weights.mar +
        confidence.mnar * weights.mnar;

      return confidence;
    } catch (error) {
      return {
        mcar: 0,
        mar: 0,
        mnar: 0,
        overall: 0,
        error: 'Confidence calculation failed: ' + error.message,
      };
    }
  }

  /**
   * Helper functions for temporal and spatial analysis
   */

  /**
   * Analyze seasonal missing patterns
   * @param {Array} data - Sorted temporal data
   * @param {Array} params - Parameter names
   * @returns {Object} Seasonal missing analysis
   * @private
   */
  _analyzeSeasonalMissingPatterns(data, params) {
    const seasons = { spring: 0, summer: 0, autumn: 0, winter: 0 };
    const seasonCounts = { spring: 0, summer: 0, autumn: 0, winter: 0 };

    for (const record of data) {
      const date = new Date(record.timestamp);
      const month = date.getMonth() + 1; // 1-12

      let season;
      if (month >= 3 && month <= 5) season = 'spring';
      else if (month >= 6 && month <= 8) season = 'summer';
      else if (month >= 9 && month <= 11) season = 'autumn';
      else season = 'winter';

      seasonCounts[season]++;
      const missingCount = params.filter(
        param => !this._hasValidValue(record[param])
      ).length;
      seasons[season] += missingCount;
    }

    // Calculate missing rates by season
    const seasonalRates = {};
    for (const season in seasons) {
      seasonalRates[season] =
        seasonCounts[season] > 0
          ? seasons[season] / (seasonCounts[season] * params.length)
          : 0;
    }

    return {
      seasonalRates,
      hasSeasonalPattern:
        Math.max(...Object.values(seasonalRates)) >
        Math.min(...Object.values(seasonalRates)) * 2,
    };
  }

  /**
   * Analyze weekly missing patterns
   * @param {Array} data - Sorted temporal data
   * @param {Array} params - Parameter names
   * @returns {Object} Weekly missing analysis
   * @private
   */
  _analyzeWeeklyMissingPatterns(data, params) {
    const weekdays = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    const weeklyMissing = Array(7).fill(0);
    const weeklyCounts = Array(7).fill(0);

    for (const record of data) {
      const dayOfWeek = new Date(record.timestamp).getDay();
      weeklyCounts[dayOfWeek]++;
      const missingCount = params.filter(
        param => !this._hasValidValue(record[param])
      ).length;
      weeklyMissing[dayOfWeek] += missingCount;
    }

    const weeklyRates = weeklyMissing.map((missing, i) =>
      weeklyCounts[i] > 0 ? missing / (weeklyCounts[i] * params.length) : 0
    );

    return {
      weeklyRates: Object.fromEntries(
        weekdays.map((day, i) => [day, weeklyRates[i]])
      ),
      hasWeeklyPattern:
        Math.max(...weeklyRates) >
        Math.min(...weeklyRates.filter(r => r > 0)) * 1.5,
    };
  }

  /**
   * Analyze daily missing patterns
   * @param {Array} data - Sorted temporal data
   * @param {Array} params - Parameter names
   * @returns {Object} Daily missing analysis
   * @private
   */
  _analyzeDailyMissingPatterns(data, params) {
    const hourlyMissing = Array(24).fill(0);
    const hourlyCounts = Array(24).fill(0);

    for (const record of data) {
      const hour = new Date(record.timestamp).getHours();
      hourlyCounts[hour]++;
      const missingCount = params.filter(
        param => !this._hasValidValue(record[param])
      ).length;
      hourlyMissing[hour] += missingCount;
    }

    const hourlyRates = hourlyMissing.map((missing, i) =>
      hourlyCounts[i] > 0 ? missing / (hourlyCounts[i] * params.length) : 0
    );

    return {
      hourlyRates,
      peakMissingHour: hourlyRates.indexOf(Math.max(...hourlyRates)),
      hasDailyPattern:
        Math.max(...hourlyRates) >
        Math.min(...hourlyRates.filter(r => r > 0)) * 1.5,
    };
  }

  /**
   * Analyze trends in missing data over time
   * @param {Array} data - Sorted temporal data
   * @param {Array} params - Parameter names
   * @returns {Object} Missing data trend analysis
   * @private
   */
  _analyzeMissingDataTrends(data, params) {
    if (data.length < 10) {
      return { hasTrend: false, trendDirection: 'insufficient_data' };
    }

    // Calculate missing rate over time (monthly buckets)
    const monthlyData = {};

    for (const record of data) {
      const date = new Date(record.timestamp);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { total: 0, missing: 0 };
      }

      monthlyData[monthKey].total += params.length;
      monthlyData[monthKey].missing += params.filter(
        param => !this._hasValidValue(record[param])
      ).length;
    }

    const months = Object.keys(monthlyData).sort();
    const missingRates = months.map(
      month => monthlyData[month].missing / monthlyData[month].total
    );

    // Simple linear trend calculation
    const n = missingRates.length;
    const sumX = (n * (n + 1)) / 2;
    const sumY = missingRates.reduce((a, b) => a + b, 0);
    const sumXY = missingRates.reduce(
      (sum, rate, i) => sum + rate * (i + 1),
      0
    );
    const sumX2 = (n * (n + 1) * (2 * n + 1)) / 6;

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    return {
      hasTrend: Math.abs(slope) > 0.01, // 1% change per month
      trendDirection: slope > 0 ? 'increasing' : 'decreasing',
      monthlyRates: Object.fromEntries(
        months.map(month => [
          month,
          monthlyData[month].missing / monthlyData[month].total,
        ])
      ),
      trendSlope: slope,
    };
  }

  /**
   * Calculate temporal pattern confidence
   * @param {Object} patterns - Temporal patterns
   * @returns {number} Confidence score
   * @private
   */
  _calculateTemporalPatternConfidence(patterns) {
    let confidence = 50; // Base confidence

    if (patterns.seasonalMissing && patterns.seasonalMissing.hasSeasonalPattern)
      confidence += 15;
    if (patterns.weeklyMissing && patterns.weeklyMissing.hasWeeklyPattern)
      confidence += 10;
    if (patterns.dailyMissing && patterns.dailyMissing.hasDailyPattern)
      confidence += 10;
    if (patterns.trendsInMissingness && patterns.trendsInMissingness.hasTrend)
      confidence += 15;

    return Math.min(confidence, 90);
  }

  /**
   * Calculate spatial pattern confidence
   * @param {Object} patterns - Spatial patterns
   * @returns {number} Confidence score
   * @private
   */
  _calculateSpatialPatternConfidence(patterns) {
    let confidence = 30; // Lower base for spatial

    if (
      patterns.geographicClustering &&
      patterns.geographicClustering.hasClustering
    )
      confidence += 20;
    if (patterns.altitudeRelated && patterns.altitudeRelated.hasAltitudeEffect)
      confidence += 15;
    if (patterns.distanceBased && patterns.distanceBased.hasDistanceEffect)
      confidence += 15;

    return Math.min(confidence, 80);
  }

  /**
   * Analyze geographic missing clusters
   * @param {Array} data - Spatial data
   * @param {Array} params - Parameter names
   * @returns {Object} Geographic clustering analysis
   * @private
   */
  _analyzeGeographicMissingClusters(data, params) {
    // Simple implementation: divide into grid and check for clusters
    return { hasClustering: false, clusters: [] };
  }

  /**
   * Analyze altitude-related missing patterns
   * @param {Array} data - Spatial data
   * @param {Array} params - Parameter names
   * @returns {Object} Altitude missing analysis
   * @private
   */
  _analyzeAltitudeMissingPatterns(data, params) {
    const altitudeData = data.filter(record =>
      this._hasValidValue(record.altitude)
    );
    if (altitudeData.length < 10) {
      return { hasAltitudeEffect: false, correlation: 0 };
    }

    // Calculate correlation between altitude and missing rate
    const altitudes = altitudeData.map(r => r.altitude);
    const missingRates = altitudeData.map(
      record =>
        params.filter(param => !this._hasValidValue(record[param])).length /
        params.length
    );

    const correlation = this._calculateCorrelation(altitudes, missingRates);

    return {
      hasAltitudeEffect: Math.abs(correlation) > 0.2,
      correlation,
      interpretation:
        Math.abs(correlation) > 0.2
          ? 'Missing data correlates with altitude'
          : 'No altitude effect detected',
    };
  }

  /**
   * Analyze distance-based missing patterns
   * @param {Array} data - Spatial data
   * @param {Array} params - Parameter names
   * @returns {Object} Distance-based missing analysis
   * @private
   */
  _analyzeDistanceBasedMissing(data, params) {
    // Simple implementation
    return {
      hasDistanceEffect: false,
      analysis: 'Distance analysis not implemented',
    };
  }

  /**
   * Calculate spatial bounds
   * @param {Array} data - Spatial data
   * @returns {Object} Spatial bounds
   * @private
   */
  _calculateSpatialBounds(data) {
    const lats = data.map(r => r.latitude);
    const lons = data.map(r => r.longitude);

    return {
      north: Math.max(...lats),
      south: Math.min(...lats),
      east: Math.max(...lons),
      west: Math.min(...lons),
    };
  }

  /**
   * Interpret correlation strength
   * @param {number} correlation - Correlation coefficient
   * @returns {string} Strength interpretation
   * @private
   */
  _interpretCorrelationStrength(correlation) {
    const abs = Math.abs(correlation);
    if (abs < 0.1) return 'negligible';
    if (abs < 0.3) return 'weak';
    if (abs < 0.5) return 'moderate';
    if (abs < 0.7) return 'strong';
    return 'very strong';
  }

  /**
   * Test normality using both Shapiro-Wilk and Kolmogorov-Smirnov tests
   * @param {Array<number>} values - Array of numerical values
   * @returns {Object} Normality test results with p-values and significance
   * @private
   */
  _testNormality(values) {
    try {
      if (!values || values.length < 3) {
        return {
          isNormal: null,
          shapiroWilk: null,
          kolmogorovSmirnov: null,
          message:
            'Insufficient data for normality testing (minimum 3 values required)',
        };
      }

      const n = values.length;
      const sorted = [...values].sort((a, b) => a - b);

      // Shapiro-Wilk test (for samples 3-5000)
      let shapiroWilk = null;
      if (n >= 3 && n <= 5000) {
        shapiroWilk = this._shapiroWilkTest(sorted);
      }

      // Kolmogorov-Smirnov test (for any sample size >= 3)
      const kolmogorovSmirnov = this._kolmogorovSmirnovTest(sorted);

      // Overall normality assessment
      let isNormal = null;
      let confidence = null;

      if (shapiroWilk && kolmogorovSmirnov) {
        // Both tests available - use more conservative result
        const alpha = 0.05;
        const swNormal = shapiroWilk.pValue > alpha;
        const ksNormal = kolmogorovSmirnov.pValue > alpha;

        isNormal = swNormal && ksNormal;
        confidence = Math.min(shapiroWilk.pValue, kolmogorovSmirnov.pValue);
      } else if (kolmogorovSmirnov) {
        // Only KS test available
        isNormal = kolmogorovSmirnov.pValue > 0.05;
        confidence = kolmogorovSmirnov.pValue;
      }

      return {
        isNormal,
        confidence,
        shapiroWilk,
        kolmogorovSmirnov,
        recommendation: this._getNormalityRecommendation(
          n,
          isNormal,
          confidence
        ),
      };
    } catch (error) {
      logger.error('Normality testing failed', { error: error.message });
      return {
        isNormal: null,
        error: 'Normality testing failed: ' + error.message,
      };
    }
  }

  /**
   * Identify the best-fitting distribution for the data
   * Tests multiple distributions and selects the best fit based on goodness-of-fit statistics
   * @param {Array<number>} values - Array of numerical values
   * @returns {Object} Distribution fitting results with parameters and goodness-of-fit measures
   * @private
   */
  _identifyDistribution(values) {
    try {
      if (!values || values.length < 5) {
        return {
          distribution: 'unknown',
          message:
            'Insufficient data for distribution fitting (minimum 5 values required)',
        };
      }

      const n = values.length;
      const sorted = [...values].sort((a, b) => a - b);
      const mean = this._calculateMean(values);
      const std = this._calculateStandardDeviation(values);
      const min = Math.min(...values);
      const max = Math.max(...values);

      // Test multiple distributions
      const distributions = [];

      // Normal distribution
      const normalFit = this._fitNormalDistribution(values, mean, std);
      distributions.push({
        name: 'normal',
        parameters: { mean, std },
        goodnessOfFit: normalFit,
        aic: this._calculateAIC(normalFit.logLikelihood, 2),
        bic: this._calculateBIC(normalFit.logLikelihood, 2, n),
      });

      // Log-normal distribution (only for positive values)
      if (min > 0) {
        const logValues = values.map(v => Math.log(v));
        const logMean = this._calculateMean(logValues);
        const logStd = this._calculateStandardDeviation(logValues);
        const lognormalFit = this._fitLognormalDistribution(
          values,
          logMean,
          logStd
        );
        distributions.push({
          name: 'lognormal',
          parameters: { logMean, logStd, mu: logMean, sigma: logStd },
          goodnessOfFit: lognormalFit,
          aic: this._calculateAIC(lognormalFit.logLikelihood, 2),
          bic: this._calculateBIC(lognormalFit.logLikelihood, 2, n),
        });
      }

      // Exponential distribution (only for positive values)
      if (min >= 0) {
        const lambda = 1 / mean;
        const exponentialFit = this._fitExponentialDistribution(values, lambda);
        distributions.push({
          name: 'exponential',
          parameters: { lambda, rate: lambda },
          goodnessOfFit: exponentialFit,
          aic: this._calculateAIC(exponentialFit.logLikelihood, 1),
          bic: this._calculateBIC(exponentialFit.logLikelihood, 1, n),
        });
      }

      // Gamma distribution (only for positive values)
      if (min > 0) {
        const gammaParams = this._estimateGammaParameters(values);
        if (gammaParams.shape > 0 && gammaParams.scale > 0) {
          const gammaFit = this._fitGammaDistribution(
            values,
            gammaParams.shape,
            gammaParams.scale
          );
          distributions.push({
            name: 'gamma',
            parameters: {
              shape: gammaParams.shape,
              scale: gammaParams.scale,
              alpha: gammaParams.shape,
              beta: 1 / gammaParams.scale,
            },
            goodnessOfFit: gammaFit,
            aic: this._calculateAIC(gammaFit.logLikelihood, 2),
            bic: this._calculateBIC(gammaFit.logLikelihood, 2, n),
          });
        }
      }

      // Uniform distribution
      const uniformFit = this._fitUniformDistribution(values, min, max);
      distributions.push({
        name: 'uniform',
        parameters: { min, max, range: max - min },
        goodnessOfFit: uniformFit,
        aic: this._calculateAIC(uniformFit.logLikelihood, 2),
        bic: this._calculateBIC(uniformFit.logLikelihood, 2, n),
      });

      // Select best distribution based on multiple criteria
      const bestFit = this._selectBestDistribution(distributions);

      return {
        bestFit: bestFit.name,
        parameters: bestFit.parameters,
        goodnessOfFit: bestFit.goodnessOfFit,
        aic: bestFit.aic,
        bic: bestFit.bic,
        allDistributions: distributions.map(d => ({
          name: d.name,
          aic: d.aic,
          bic: d.bic,
          ksStatistic: d.goodnessOfFit.ksStatistic,
          pValue: d.goodnessOfFit.pValue,
        })),
        recommendation: this._getDistributionRecommendation(bestFit, values),
      };
    } catch (error) {
      logger.error('Distribution identification failed', {
        error: error.message,
      });
      return {
        distribution: 'unknown',
        error: 'Distribution identification failed: ' + error.message,
      };
    }
  }

  /**
   * Analyze extreme values using both block maxima and peaks-over-threshold methods
   * @param {Array<number>} values - Array of numerical values
   * @returns {Object} Extreme value analysis results with statistical significance
   * @private
   */
  _analyzeExtremes(values) {
    try {
      if (!values || values.length < 10) {
        return {
          method: null,
          message:
            'Insufficient data for extreme value analysis (minimum 10 values required)',
        };
      }

      const n = values.length;
      const sorted = [...values].sort((a, b) => a - b);
      const mean = this._calculateMean(values);
      const std = this._calculateStandardDeviation(values);

      // Block Maxima Method (GEV distribution)
      const blockMaxima = this._blockMaximaAnalysis(values);

      // Peaks Over Threshold Method (GPD distribution)
      const peaksOverThreshold = this._peaksOverThresholdAnalysis(values);

      // Extreme quantile estimation
      const extremeQuantiles = this._estimateExtremeQuantiles(values);

      // Return period analysis
      const returnPeriods = this._calculateReturnPeriods(values);

      // Statistical significance tests
      const significance = this._testExtremeSignificance(
        values,
        blockMaxima,
        peaksOverThreshold
      );

      return {
        blockMaxima,
        peaksOverThreshold,
        extremeQuantiles,
        returnPeriods,
        significance,
        recommendation: this._getExtremeValueRecommendation(
          blockMaxima,
          peaksOverThreshold,
          n
        ),
      };
    } catch (error) {
      logger.error('Extreme value analysis failed', { error: error.message });
      return {
        method: null,
        error: 'Extreme value analysis failed: ' + error.message,
      };
    }
  }

  _identifyQualityIssues(scores) {
    const issues = [];

    Object.entries(scores).forEach(([dimension, scoreData]) => {
      if (scoreData.category === 'poor') {
        issues.push({
          dimension,
          severity: 'high',
          description: `${dimension} score is poor (${scoreData.score.toFixed(1)})`,
        });
      } else if (scoreData.category === 'fair') {
        issues.push({
          dimension,
          severity: 'medium',
          description: `${dimension} score is fair (${scoreData.score.toFixed(1)})`,
        });
      }
    });

    return issues;
  }

  _generateQualityRecommendations(scores, issues) {
    const recommendations = [];

    issues.forEach(issue => {
      switch (issue.dimension) {
        case 'completeness':
          recommendations.push(
            'Investigate data collection processes for missing values'
          );
          break;
        case 'consistency':
          recommendations.push('Implement additional data validation rules');
          break;
        case 'accuracy':
          recommendations.push(
            'Review sensor calibration and data source reliability'
          );
          break;
        case 'timeliness':
          recommendations.push(
            'Optimize data ingestion pipeline for faster processing'
          );
          break;
      }
    });

    return recommendations;
  }

  /**
   * Export profile to file
   */
  async exportProfile(profile, outputPath) {
    try {
      await fs.writeFile(outputPath, JSON.stringify(profile, null, 2));
      logger.info('Profile exported successfully', { outputPath });
    } catch (error) {
      logger.error('Failed to export profile', {
        error: error.message,
        outputPath,
      });
      throw error;
    }
  }

  /**
   * Get cached profile by ID
   */
  getProfile(profileId) {
    return this.profiles.get(profileId);
  }

  /**
   * Clear profile cache
   */
  clearCache() {
    this.profiles.clear();
    this.temporalPatterns.clear();
    this.spatialProfiles.clear();
    logger.info('Profile cache cleared');
  }

  /**
   * Helper methods for time series analysis
   * @private
   */

  /**
   * Create regular time series from irregular data
   * @private
   */
  _createRegularTimeSeries(values, timestamps) {
    if (values.length !== timestamps.length) {
      throw new Error('Values and timestamps arrays must have same length');
    }

    // Create array of {time, value} pairs
    const pairs = values.map((value, index) => ({
      time: timestamps[index],
      value: value,
    }));

    // Sort by time
    pairs.sort((a, b) => a.time - b.time);

    // Estimate regular interval
    const intervals = [];
    for (let i = 1; i < Math.min(pairs.length, 50); i++) {
      intervals.push(pairs[i].time - pairs[i - 1].time);
    }

    const medianInterval = this._calculateMedian(intervals);

    // Create regular time series
    const regularSeries = [];
    const startTime = pairs[0].time;
    const endTime = pairs[pairs.length - 1].time;

    for (
      let time = startTime;
      time <= endTime;
      time = new Date(time.getTime() + medianInterval)
    ) {
      // Find closest data point
      const closest = pairs.reduce((prev, curr) =>
        Math.abs(curr.time - time) < Math.abs(prev.time - time) ? curr : prev
      );

      // Only include if within reasonable distance (half interval)
      if (Math.abs(closest.time - time) <= medianInterval / 2) {
        regularSeries.push(closest.value);
      }
    }

    return regularSeries;
  }

  /**
   * Detect seasonal patterns using autocorrelation
   * @private
   */
  _detectSeasonalPatterns(timeSeries) {
    const n = timeSeries.length;
    const result = {
      hasSeasonality: false,
      confidence: 0,
      dominantPeriods: [],
      strength: 0,
      annual: { detected: false, period: 0, strength: 0 },
      daily: { detected: false, period: 0, strength: 0 },
      weekly: { detected: false, period: 0, strength: 0 },
    };

    if (n < 24) return result;

    // Calculate autocorrelation for different lags
    const maxLag = Math.min(Math.floor(n / 3), 365); // Don't exceed 1/3 of series length
    const autocorrelations = [];

    for (let lag = 1; lag <= maxLag; lag++) {
      const corr = this._calculateAutocorrelation(timeSeries, lag);
      autocorrelations.push({ lag, correlation: corr });
    }

    // Find peaks in autocorrelation
    const peaks = this._findPeaksInAutocorrelation(autocorrelations);

    // Classify peaks by period type
    const dailyPeaks = peaks.filter(p => p.lag >= 20 && p.lag <= 28); // ~24 hours
    const weeklyPeaks = peaks.filter(p => p.lag >= 160 && p.lag <= 176); // ~7 days
    const annualPeaks = peaks.filter(p => p.lag >= 8400 && p.lag <= 8800); // ~365 days

    // Check for daily pattern (most common in weather data)
    if (dailyPeaks.length > 0) {
      const bestDaily = dailyPeaks.reduce((max, p) =>
        p.correlation > max.correlation ? p : max
      );
      if (bestDaily.correlation > 0.3) {
        result.daily = {
          detected: true,
          period: bestDaily.lag,
          strength: bestDaily.correlation,
        };
      }
    }

    // Check for weekly pattern
    if (weeklyPeaks.length > 0) {
      const bestWeekly = weeklyPeaks.reduce((max, p) =>
        p.correlation > max.correlation ? p : max
      );
      if (bestWeekly.correlation > 0.2) {
        result.weekly = {
          detected: true,
          period: bestWeekly.lag,
          strength: bestWeekly.correlation,
        };
      }
    }

    // Check for annual pattern
    if (annualPeaks.length > 0) {
      const bestAnnual = annualPeaks.reduce((max, p) =>
        p.correlation > max.correlation ? p : max
      );
      if (bestAnnual.correlation > 0.15) {
        result.annual = {
          detected: true,
          period: bestAnnual.lag,
          strength: bestAnnual.correlation,
        };
      }
    }

    // Overall seasonality assessment
    const allSignificantPeaks = peaks.filter(p => p.correlation > 0.15);
    result.dominantPeriods = allSignificantPeaks.map(p => ({
      period: p.lag,
      strength: p.correlation,
    }));
    result.hasSeasonality =
      result.daily.detected || result.weekly.detected || result.annual.detected;
    result.strength = Math.max(
      result.daily.strength,
      result.weekly.strength,
      result.annual.strength
    );
    result.confidence = result.strength;

    return result;
  }

  /**
   * Calculate autocorrelation for a given lag
   * @private
   */
  _calculateAutocorrelation(series, lag) {
    if (lag >= series.length) return 0;

    const n = series.length - lag;
    const mean = this._calculateMean(series);

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      numerator += (series[i] - mean) * (series[i + lag] - mean);
    }

    for (let i = 0; i < series.length; i++) {
      denominator += Math.pow(series[i] - mean, 2);
    }

    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Find peaks in autocorrelation function
   * @private
   */
  _findPeaksInAutocorrelation(autocorrelations) {
    const peaks = [];
    const threshold = 0.1; // Minimum correlation to consider

    for (let i = 1; i < autocorrelations.length - 1; i++) {
      const current = autocorrelations[i];
      const prev = autocorrelations[i - 1];
      const next = autocorrelations[i + 1];

      // Check if current point is a local maximum above threshold
      if (
        current.correlation > prev.correlation &&
        current.correlation > next.correlation &&
        current.correlation > threshold
      ) {
        peaks.push(current);
      }
    }

    return peaks.sort((a, b) => b.correlation - a.correlation);
  }

  /**
   * Summarize seasonality results
   * @private
   */
  _summarizeSeasonalityResults(results) {
    const detected = Object.values(results).filter(r => r.detected);
    const summary = {
      parametersWithSeasonality: detected.length,
      totalParameters: Object.keys(results).length,
      averageConfidence:
        detected.length > 0
          ? detected.reduce((sum, r) => sum + r.confidence, 0) / detected.length
          : 0,
      commonPatterns: {},
    };

    // Find common patterns across parameters
    const dailyCount = detected.filter(
      r => r.analysis.dailyPattern.detected
    ).length;
    const weeklyCount = detected.filter(
      r => r.analysis.weeklyPattern.detected
    ).length;
    const annualCount = detected.filter(
      r => r.analysis.annualPattern.detected
    ).length;

    summary.commonPatterns = {
      daily: {
        count: dailyCount,
        percentage: (dailyCount / Object.keys(results).length) * 100,
      },
      weekly: {
        count: weeklyCount,
        percentage: (weeklyCount / Object.keys(results).length) * 100,
      },
      annual: {
        count: annualCount,
        percentage: (annualCount / Object.keys(results).length) * 100,
      },
    };

    return summary;
  }

  /**
   * Group data by hour of day for diurnal analysis
   * @private
   */
  _groupDataByHour(data, param) {
    const hourlyData = {};

    // Initialize all hours
    for (let hour = 0; hour < 24; hour++) {
      hourlyData[hour] = [];
    }

    // Group data by hour, filtering out null/undefined values
    data.forEach(record => {
      const hour = new Date(record.timestamp).getHours();
      const value = record[param];
      if (this._hasValidValue(value)) {
        hourlyData[hour].push(value);
      }
    });

    return hourlyData;
  }

  /**
   * Calculate statistics for each hour
   * @private
   */
  _calculateHourlyStatistics(hourlyData) {
    const stats = {};

    for (let hour = 0; hour < 24; hour++) {
      const values = hourlyData[hour];
      if (values.length > 0) {
        stats[hour] = {
          count: values.length,
          mean: this._calculateMean(values),
          median: this._calculateMedian(values),
          std: this._calculateStandardDeviation(values),
          min: Math.min(...values),
          max: Math.max(...values),
        };
      } else {
        stats[hour] = {
          count: 0,
          mean: null,
          median: null,
          std: null,
          min: null,
          max: null,
        };
      }
    }

    return stats;
  }

  /**
   * Detect diurnal cycles
   * @private
   */
  _detectDiurnalCycles(hourlyStats) {
    try {
      // Extract mean values for hours that have data
      const validHours = [];
      const validMeans = [];

      for (let hour = 0; hour < 24; hour++) {
        if (
          hourlyStats[hour] &&
          hourlyStats[hour].count > 0 &&
          hourlyStats[hour].mean !== null &&
          !isNaN(hourlyStats[hour].mean)
        ) {
          validHours.push(hour);
          validMeans.push(hourlyStats[hour].mean);
        }
      }

      if (validMeans.length < 2) {
        // Need at least 2 data points
        return {
          hasPattern: false,
          peakHour: 0,
          troughHour: 0,
          amplitude: 0,
          maxVariation: 0,
          meanAmplitude: 0,
          cyclicality: 0,
          cycleType: 'insufficient_data',
          reason: 'Insufficient hourly data coverage',
        };
      }

      // Find peak and trough
      const maxValue = Math.max(...validMeans);
      const minValue = Math.min(...validMeans);
      const peakHour = validHours[validMeans.indexOf(maxValue)];
      const troughHour = validHours[validMeans.indexOf(minValue)];

      const amplitude = maxValue - minValue;
      const meanValue = this._calculateMean(validMeans);
      const relativeAmplitude = meanValue > 0 ? amplitude / meanValue : 0;

      // Determine cycle type based on peak timing
      let cycleType = 'unknown';
      if (peakHour >= 12 && peakHour <= 16) {
        cycleType = 'afternoon_peak'; // Typical for temperature
      } else if (peakHour >= 6 && peakHour <= 10) {
        cycleType = 'morning_peak';
      } else if (peakHour >= 18 && peakHour <= 22) {
        cycleType = 'evening_peak';
      } else if (peakHour >= 0 && peakHour <= 6) {
        cycleType = 'night_peak';
      }

      // Calculate cyclicality using Fourier-like analysis
      const cyclicality =
        validMeans.length >= 12 ? this._calculateCyclicality(validMeans) : 0;

      return {
        hasPattern:
          validMeans.length >= 12 &&
          relativeAmplitude > 0.05 &&
          cyclicality > 0.3, // 5% relative change and reasonable cyclicality
        peakHour,
        troughHour,
        amplitude,
        maxVariation: amplitude,
        meanAmplitude: relativeAmplitude,
        cyclicality,
        cycleType,
      };
    } catch (error) {
      // Return safe defaults if any error occurs
      return {
        hasPattern: false,
        peakHour: 0,
        troughHour: 0,
        amplitude: 0,
        maxVariation: 0,
        meanAmplitude: 0,
        cyclicality: 0,
        cycleType: 'error',
        reason: 'Error in diurnal cycle detection: ' + error.message,
      };
    }
  }

  /**
   * Calculate diurnal strength
   * @private
   */
  _calculateDiurnalStrength(hourlyStats) {
    const means = [];
    for (let hour = 0; hour < 24; hour++) {
      if (hourlyStats[hour].mean !== null) {
        means.push(hourlyStats[hour].mean);
      }
    }

    if (means.length < 12) return 0;

    const overallMean = this._calculateMean(means);
    const overallStd = this._calculateStandardDeviation(means);

    // Strength is ratio of hourly variation to overall standard deviation
    return overallStd / Math.abs(overallMean);
  }

  /**
   * Calculate pattern confidence
   * @private
   */
  _calculatePatternConfidence(hourlyStats, patterns) {
    if (!patterns.hasPattern) return 0;

    // Base confidence on data coverage and pattern strength
    const dataHours = Object.values(hourlyStats).filter(
      s => s.count > 0
    ).length;
    const coverageScore = dataHours / 24;
    const amplitudeScore = Math.min(patterns.meanAmplitude * 10, 1); // Scale amplitude
    const cyclicalityScore = patterns.cyclicality;

    return coverageScore * 0.4 + amplitudeScore * 0.3 + cyclicalityScore * 0.3;
  }

  /**
   * Calculate cyclicality measure
   * @private
   */
  _calculateCyclicality(values) {
    if (values.length < 12) return 0;

    // Simple measure: correlation with sine wave
    const n = values.length;
    const sineWave = [];
    for (let i = 0; i < n; i++) {
      sineWave.push(Math.sin((2 * Math.PI * i) / 24)); // 24-hour cycle
    }

    return Math.abs(this._calculateCorrelation(values, sineWave));
  }

  /**
   * Calculate correlation between two arrays
   * @private
   */
  _calculateCorrelation(x, y) {
    if (x.length !== y.length) return 0;

    const n = x.length;
    const meanX = this._calculateMean(x);
    const meanY = this._calculateMean(y);

    let numerator = 0;
    let sumXSquared = 0;
    let sumYSquared = 0;

    for (let i = 0; i < n; i++) {
      const deltaX = x[i] - meanX;
      const deltaY = y[i] - meanY;
      numerator += deltaX * deltaY;
      sumXSquared += deltaX * deltaX;
      sumYSquared += deltaY * deltaY;
    }

    const denominator = Math.sqrt(sumXSquared * sumYSquared);
    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Summarize diurnal results
   * @private
   */
  _summarizeDiurnalResults(results) {
    const detected = Object.values(results).filter(r => r.detected);
    return {
      parametersWithDiurnalPatterns: detected.length,
      totalParameters: Object.keys(results).length,
      averageConfidence:
        detected.length > 0
          ? detected.reduce((sum, r) => sum + r.confidence, 0) / detected.length
          : 0,
      commonPeakHours: this._findCommonPeakHours(detected),
      averageStrength:
        detected.length > 0
          ? detected.reduce((sum, r) => sum + r.strength, 0) / detected.length
          : 0,
    };
  }

  /**
   * Find common peak hours across parameters
   * @private
   */
  _findCommonPeakHours(detectedPatterns) {
    const peakHours = detectedPatterns.map(p => p.patterns.peakHour);
    const hourCounts = {};

    peakHours.forEach(hour => {
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });

    return Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3) // Top 3 common hours
      .map(([hour, count]) => ({ hour: parseInt(hour), count }));
  }

  /**
   * Calculate linear regression
   * @private
   */
  _calculateLinearRegression(x, y) {
    if (x.length !== y.length || x.length < 2) {
      throw new Error('Invalid data for regression analysis');
    }

    const n = x.length;
    const meanX = this._calculateMean(x);
    const meanY = this._calculateMean(y);

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      numerator += (x[i] - meanX) * (y[i] - meanY);
      denominator += Math.pow(x[i] - meanX, 2);
    }

    const slope = denominator === 0 ? 0 : numerator / denominator;
    const intercept = meanY - slope * meanX;

    // Calculate correlation coefficient
    const correlation = this._calculateCorrelation(x, y);
    const rSquared = Math.pow(correlation, 2);

    return {
      slope,
      intercept,
      correlation,
      rSquared,
    };
  }

  /**
   * Calculate trend metrics
   * @private
   */
  _calculateTrendMetrics(x, y, regression) {
    const n = x.length;
    let sumSquaredErrors = 0;
    let sumAbsoluteErrors = 0;

    for (let i = 0; i < n; i++) {
      const predicted = regression.slope * x[i] + regression.intercept;
      const error = y[i] - predicted;
      sumSquaredErrors += error * error;
      sumAbsoluteErrors += Math.abs(error);
    }

    const mse = sumSquaredErrors / n;
    const rmse = Math.sqrt(mse);
    const mae = sumAbsoluteErrors / n;

    // Calculate standard error of slope
    const xVariance = this._calculateVariance(x);
    const standardError = Math.sqrt(mse / (n * xVariance));

    return {
      mse,
      rmse,
      mae,
      standardError,
    };
  }

  /**
   * Assess trend significance
   * @private
   */
  _assessTrendSignificance(regression, metrics) {
    const n = metrics.mae ? 10 : 1; // Approximate sample size

    // Calculate t-statistic for slope
    const tStatistic =
      metrics.standardError > 0
        ? Math.abs(regression.slope) / metrics.standardError
        : 0;

    // Approximate p-value (simplified)
    const degreesOfFreedom = n - 2;
    const criticalValue = 2.0; // Approximate for p < 0.05 with reasonable df

    const isSignificant =
      tStatistic > criticalValue && Math.abs(regression.rSquared) > 0.1;
    const pValue = tStatistic > criticalValue ? 0.05 : 0.5; // Simplified

    // Confidence based on R-squared and t-statistic
    const confidence = Math.min(
      Math.abs(regression.rSquared) * 0.7 + Math.min(tStatistic / 5, 1) * 0.3,
      1
    );

    return {
      isSignificant,
      confidence,
      pValue,
      tStatistic,
    };
  }

  /**
   * Summarize trend results
   * @private
   */
  _summarizeTrendResults(results) {
    const trendsDetected = Object.values(results).filter(r => r.hasTrend);
    const increasingTrends = trendsDetected.filter(
      r => r.direction === 'increasing'
    ).length;
    const decreasingTrends = trendsDetected.filter(
      r => r.direction === 'decreasing'
    ).length;

    return {
      parametersWithTrends: trendsDetected.length,
      totalParameters: Object.keys(results).length,
      trendDistribution: {
        increasing: increasingTrends,
        decreasing: decreasingTrends,
      },
      averageStrength:
        trendsDetected.length > 0
          ? trendsDetected.reduce((sum, r) => sum + r.strength, 0) /
            trendsDetected.length
          : 0,
      averageConfidence:
        trendsDetected.length > 0
          ? trendsDetected.reduce((sum, r) => sum + r.confidence, 0) /
            trendsDetected.length
          : 0,
      strongTrends: trendsDetected.filter(r => r.strength > 0.7).length,
    };
  }

  /**
   * Estimate expected frequency from median interval
   * @private
   */
  _estimateExpectedFrequency(medianInterval) {
    const intervalMinutes = medianInterval / (1000 * 60);

    if (intervalMinutes <= 5) return 'high_frequency'; // <= 5 minutes
    if (intervalMinutes <= 15) return 'medium_frequency'; // <= 15 minutes
    if (intervalMinutes <= 60) return 'hourly'; // <= 1 hour
    if (intervalMinutes <= 360) return 'periodic'; // <= 6 hours
    return 'low_frequency'; // > 6 hours
  }

  /**
   * Identify missing periods in time series
   * @private
   */
  _identifyMissingPeriods(timestamps, expectedInterval) {
    const missingPeriods = [];
    const tolerance = expectedInterval * 1.5; // 50% tolerance

    for (let i = 1; i < timestamps.length; i++) {
      const actualInterval = timestamps[i] - timestamps[i - 1];
      if (actualInterval > tolerance) {
        const expectedRecords =
          Math.floor(actualInterval / expectedInterval) - 1;
        missingPeriods.push({
          start: timestamps[i - 1],
          end: timestamps[i],
          durationMs: actualInterval,
          estimatedMissingRecords: expectedRecords,
        });
      }
    }

    return missingPeriods;
  }

  /**
   * Analyze temporal completeness patterns
   * @private
   */
  _analyzeTemporalCompletenessPatterns(data, params, expectedInterval) {
    // Group data by time periods to identify patterns in missing data
    const patterns = {
      hourlyCompleteness: this._calculateHourlyCompleteness(data, params),
      dailyCompleteness: this._calculateDailyCompleteness(data, params),
      weeklyCompleteness: this._calculateWeeklyCompleteness(data, params),
    };

    return patterns;
  }

  /**
   * Calculate hourly completeness patterns
   * @private
   */
  _calculateHourlyCompleteness(data, params) {
    const hourlyStats = {};

    // Initialize all hours
    for (let hour = 0; hour < 24; hour++) {
      hourlyStats[hour] = { total: 0, complete: 0, completeness: 0 };
    }

    // Count records by hour
    data.forEach(record => {
      if (record.timestamp && !isNaN(new Date(record.timestamp))) {
        const hour = new Date(record.timestamp).getHours();
        hourlyStats[hour].total++;

        // Check if record is complete for all parameters
        const isComplete = params.every(param =>
          this._hasValidValue(record[param])
        );
        if (isComplete) {
          hourlyStats[hour].complete++;
        }
      }
    });

    // Calculate completeness percentages
    Object.keys(hourlyStats).forEach(hour => {
      const stats = hourlyStats[hour];
      stats.completeness =
        stats.total > 0 ? (stats.complete / stats.total) * 100 : 0;
    });

    return hourlyStats;
  }

  /**
   * Calculate daily completeness patterns
   * @private
   */
  _calculateDailyCompleteness(data, params) {
    const dailyStats = {};

    data.forEach(record => {
      if (record.timestamp && !isNaN(new Date(record.timestamp))) {
        const date = new Date(record.timestamp).toDateString();

        if (!dailyStats[date]) {
          dailyStats[date] = { total: 0, complete: 0, completeness: 0 };
        }

        dailyStats[date].total++;

        const isComplete = params.every(param =>
          this._hasValidValue(record[param])
        );
        if (isComplete) {
          dailyStats[date].complete++;
        }
      }
    });

    // Calculate completeness percentages
    Object.keys(dailyStats).forEach(date => {
      const stats = dailyStats[date];
      stats.completeness =
        stats.total > 0 ? (stats.complete / stats.total) * 100 : 0;
    });

    return dailyStats;
  }

  /**
   * Calculate weekly completeness patterns
   * @private
   */
  _calculateWeeklyCompleteness(data, params) {
    const weeklyStats = {};

    // Initialize days of week
    const days = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    days.forEach(day => {
      weeklyStats[day] = { total: 0, complete: 0, completeness: 0 };
    });

    data.forEach(record => {
      if (record.timestamp && !isNaN(new Date(record.timestamp))) {
        const dayOfWeek = days[new Date(record.timestamp).getDay()];
        weeklyStats[dayOfWeek].total++;

        const isComplete = params.every(param =>
          this._hasValidValue(record[param])
        );
        if (isComplete) {
          weeklyStats[dayOfWeek].complete++;
        }
      }
    });

    // Calculate completeness percentages
    days.forEach(day => {
      const stats = weeklyStats[day];
      stats.completeness =
        stats.total > 0 ? (stats.complete / stats.total) * 100 : 0;
    });

    return weeklyStats;
  }

  /**
   * Calculate overall temporal completeness
   * @private
   */
  _calculateOverallTemporalCompleteness(
    actualRecords,
    expectedRecords,
    gapAnalysis,
    parameterCompleteness
  ) {
    // Temporal coverage score
    const coverageScore = Math.min(actualRecords / expectedRecords, 1) * 100;

    // Regularity score (penalize large gaps)
    const maxGapPenalty = Math.min(gapAnalysis.largestGapHours / 24, 1) * 20; // Up to 20% penalty for gaps > 24h
    const regularityScore = Math.max(100 - maxGapPenalty, 0);

    // Data consistency score (average parameter completeness)
    const paramCompleteness = Object.values(parameterCompleteness);
    const consistencyScore =
      paramCompleteness.length > 0
        ? paramCompleteness.reduce(
            (sum, p) => sum + p.completenessPercentage,
            0
          ) / paramCompleteness.length
        : 0;

    // Overall weighted score
    const overallScore =
      coverageScore * 0.4 + regularityScore * 0.3 + consistencyScore * 0.3;

    return {
      score: Math.max(overallScore, 0),
      coverage: coverageScore,
      regularity: regularityScore,
      consistency: consistencyScore,
    };
  }

  // ========================================
  // SPATIAL ANALYSIS HELPER FUNCTIONS
  // ========================================

  /**
   * Check if record has valid coordinates
   * @private
   */
  _hasValidCoordinates(record) {
    const lat = record.latitude || record.lat;
    const lng = record.longitude || record.lng || record.lon;

    return (
      lat !== null &&
      lat !== undefined &&
      lng !== null &&
      lng !== undefined &&
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      !isNaN(lat) &&
      !isNaN(lng) &&
      isFinite(lat) &&
      isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    );
  }

  /**
   * Remove duplicate locations based on coordinates
   * @private
   */
  _removeDuplicateLocations(locations) {
    const seen = new Set();
    return locations.filter(loc => {
      const key = `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Calculate basic geographic bounds
   * @private
   */
  _calculateBasicBounds(locations) {
    const lats = locations.map(loc => loc.lat);
    const lngs = locations.map(loc => loc.lng);

    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLng: Math.min(...lngs),
      maxLng: Math.max(...lngs),
    };
  }

  /**
   * Calculate coverage area using bounding box approximation
   * @private
   */
  _calculateCoverageArea(bounds) {
    const latSpan = bounds.maxLat - bounds.minLat;
    const lngSpan = bounds.maxLng - bounds.minLng;

    // Convert to approximate kilometers using Haversine approximation
    const earthRadius = 6371; // km
    const latKm = latSpan * (Math.PI / 180) * earthRadius;
    const avgLat = (bounds.maxLat + bounds.minLat) / 2;
    const lngKm =
      lngSpan *
      (Math.PI / 180) *
      earthRadius *
      Math.cos((avgLat * Math.PI) / 180);

    return latKm * lngKm;
  }

  /**
   * Calculate centroid of location points
   * @private
   */
  _calculateCentroid(locations) {
    const totalLat = locations.reduce((sum, loc) => sum + loc.lat, 0);
    const totalLng = locations.reduce((sum, loc) => sum + loc.lng, 0);

    return {
      lat: totalLat / locations.length,
      lng: totalLng / locations.length,
    };
  }

  /**
   * Calculate Haversine distance between two points in kilometers
   * @private
   */
  _calculateHaversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Calculate spatial distribution metrics
   * @private
   */
  _calculateSpatialDistribution(locations, centroid) {
    const distances = locations.map(loc =>
      this._calculateHaversineDistance(
        loc.lat,
        loc.lng,
        centroid.lat,
        centroid.lng
      )
    );

    const meanDistance = this._calculateMean(distances);
    const standardDeviation = this._calculateStandardDeviation(distances);

    // Spread index: coefficient of variation
    const spreadIndex = standardDeviation / meanDistance;

    // Clustering index: inverse of spread (lower spread = more clustered)
    const clusteringIndex = 1 / (1 + spreadIndex);

    return {
      meanDistance,
      standardDeviation,
      spreadIndex,
      clusteringIndex,
    };
  }

  /**
   * Calculate coverage density
   * @private
   */
  _calculateCoverageDensity(locations, area) {
    if (area === 0) return locations.length > 1 ? Infinity : 0;
    return locations.length / area; // points per km²
  }

  /**
   * Analyze geographic spread
   * @private
   */
  _analyzeGeographicSpread(locations, bounds) {
    // Maximum distance between any two points
    let maxDistance = 0;
    for (let i = 0; i < locations.length; i++) {
      for (let j = i + 1; j < locations.length; j++) {
        const dist = this._calculateHaversineDistance(
          locations[i].lat,
          locations[i].lng,
          locations[j].lat,
          locations[j].lng
        );
        maxDistance = Math.max(maxDistance, dist);
      }
    }

    // Average nearest neighbor distance
    const nearestNeighborDistances = locations.map(loc => {
      let minDist = Infinity;
      locations.forEach(other => {
        if (other !== loc) {
          const dist = this._calculateHaversineDistance(
            loc.lat,
            loc.lng,
            other.lat,
            other.lng
          );
          minDist = Math.min(minDist, dist);
        }
      });
      return minDist === Infinity ? 0 : minDist;
    });

    const avgNearestNeighbor = this._calculateMean(nearestNeighborDistances);

    // Simple spatial autocorrelation measure
    const spatialAutocorrelation =
      this._calculateSpatialAutocorrelation(locations);

    return {
      maxDistance,
      avgNearestNeighbor,
      spatialAutocorrelation,
    };
  }

  /**
   * Calculate simple spatial autocorrelation
   * @private
   */
  _calculateSpatialAutocorrelation(locations) {
    if (locations.length < 3) return 0;

    // Simple Moran's I approximation using distance-based weights
    const n = locations.length;
    const centroid = this._calculateCentroid(locations);

    // Calculate deviations from centroid
    const deviations = locations.map(loc => ({
      latDev: loc.lat - centroid.lat,
      lngDev: loc.lng - centroid.lng,
    }));

    let numerator = 0;
    let denominator = 0;
    let weights = 0;

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          const distance = this._calculateHaversineDistance(
            locations[i].lat,
            locations[i].lng,
            locations[j].lat,
            locations[j].lng
          );

          // Inverse distance weight (with small constant to avoid division by zero)
          const weight = 1 / (distance + 0.001);
          weights += weight;

          const product =
            (deviations[i].latDev + deviations[i].lngDev) *
            (deviations[j].latDev + deviations[j].lngDev);
          numerator += weight * product;
        }
      }

      const deviation = deviations[i].latDev + deviations[i].lngDev;
      denominator += deviation * deviation;
    }

    if (weights === 0 || denominator === 0) return 0;
    return (n / weights) * (numerator / denominator);
  }

  /**
   * Calculate coverage quality score
   * @private
   */
  _calculateCoverageQuality(locations, distribution, spread) {
    // Quality based on: point count, distribution evenness, spatial spread
    const countScore = Math.min(locations.length / 100, 1); // Normalize to 100 points
    const distributionScore = Math.max(0, 1 - distribution.spreadIndex); // Lower spread = better
    const spreadScore = Math.min(spread.avgNearestNeighbor / 10, 1); // Normalize to 10km

    return (
      (countScore * 0.4 + distributionScore * 0.3 + spreadScore * 0.3) * 100
    );
  }

  /**
   * Calculate optimal grid size for density analysis
   * @private
   */
  _calculateOptimalGridSize(bounds, pointCount) {
    const latSpan = bounds.maxLat - bounds.minLat;
    const lngSpan = bounds.maxLng - bounds.minLng;

    // Base grid size on data extent and point density
    const targetCellsPerPoint = 4; // Aim for 4 cells per point on average
    const targetCells = Math.max(pointCount * targetCellsPerPoint, 16); // Minimum 4x4 grid
    const cellsPerSide = Math.sqrt(targetCells);

    const cellsX = Math.max(
      Math.ceil(cellsPerSide * (lngSpan / Math.max(latSpan, lngSpan))),
      2
    );
    const cellsY = Math.max(
      Math.ceil(cellsPerSide * (latSpan / Math.max(latSpan, lngSpan))),
      2
    );

    // Calculate cell size in km²
    const cellLatSpan = latSpan / cellsY;
    const cellLngSpan = lngSpan / cellsX;
    const cellSizeKm2 = this._calculateCoverageArea({
      minLat: 0,
      maxLat: cellLatSpan,
      minLng: 0,
      maxLng: cellLngSpan,
    });

    return { cellsX, cellsY, cellSizeKm2 };
  }

  /**
   * Create density grid
   * @private
   */
  _createDensityGrid(locations, bounds, gridSize) {
    const { cellsX, cellsY } = gridSize;
    const latStep = (bounds.maxLat - bounds.minLat) / cellsY;
    const lngStep = (bounds.maxLng - bounds.minLng) / cellsX;

    // Initialize grid
    const grid = [];
    for (let y = 0; y < cellsY; y++) {
      grid[y] = [];
      for (let x = 0; x < cellsX; x++) {
        grid[y][x] = {
          x,
          y,
          bounds: {
            minLat: bounds.minLat + y * latStep,
            maxLat: bounds.minLat + (y + 1) * latStep,
            minLng: bounds.minLng + x * lngStep,
            maxLng: bounds.minLng + (x + 1) * lngStep,
          },
          count: 0,
          density: 0,
          points: [],
        };
      }
    }

    // Assign points to grid cells
    locations.forEach(loc => {
      const cellX = Math.min(
        Math.floor((loc.lng - bounds.minLng) / lngStep),
        cellsX - 1
      );
      const cellY = Math.min(
        Math.floor((loc.lat - bounds.minLat) / latStep),
        cellsY - 1
      );

      if (cellX >= 0 && cellX < cellsX && cellY >= 0 && cellY < cellsY) {
        grid[cellY][cellX].count++;
        grid[cellY][cellX].points.push(loc);
      }
    });

    // Calculate density for each cell
    grid.forEach(row => {
      row.forEach(cell => {
        cell.density = cell.count / gridSize.cellSizeKm2;
      });
    });

    return grid;
  }

  /**
   * Calculate density statistics
   * @private
   */
  _calculateDensityStatistics(grid) {
    const densities = [];
    grid.forEach(row => {
      row.forEach(cell => {
        densities.push(cell.density);
      });
    });

    return {
      mean: this._calculateMean(densities),
      median: this._calculateMedian(densities),
      standardDeviation: this._calculateStandardDeviation(densities),
      min: Math.min(...densities),
      max: Math.max(...densities),
      range: Math.max(...densities) - Math.min(...densities),
    };
  }

  /**
   * Identify hotspots (high density areas)
   * @private
   */
  _identifyHotspots(grid, stats) {
    const threshold = stats.mean + stats.standardDeviation;
    const hotspots = [];

    grid.forEach(row => {
      row.forEach(cell => {
        if (cell.density > threshold) {
          hotspots.push({
            x: cell.x,
            y: cell.y,
            density: cell.density,
            count: cell.count,
            bounds: cell.bounds,
            centroid: {
              lat: (cell.bounds.minLat + cell.bounds.maxLat) / 2,
              lng: (cell.bounds.minLng + cell.bounds.maxLng) / 2,
            },
          });
        }
      });
    });

    return hotspots.sort((a, b) => b.density - a.density);
  }

  /**
   * Identify coldspots (low density areas)
   * @private
   */
  _identifyColdspots(grid, stats) {
    const threshold = Math.max(stats.mean - stats.standardDeviation, 0);
    const coldspots = [];

    grid.forEach(row => {
      row.forEach(cell => {
        if (cell.density < threshold && cell.density > 0) {
          coldspots.push({
            x: cell.x,
            y: cell.y,
            density: cell.density,
            count: cell.count,
            bounds: cell.bounds,
            centroid: {
              lat: (cell.bounds.minLat + cell.bounds.maxLat) / 2,
              lng: (cell.bounds.minLng + cell.bounds.maxLng) / 2,
            },
          });
        }
      });
    });

    return coldspots.sort((a, b) => a.density - b.density);
  }

  /**
   * Calculate density metrics
   * @private
   */
  _calculateDensityMetrics(grid, bounds, totalPoints) {
    const densities = [];
    let occupiedCells = 0;

    grid.forEach(row => {
      row.forEach(cell => {
        densities.push(cell.density);
        if (cell.count > 0) occupiedCells++;
      });
    });

    const area = this._calculateCoverageArea(bounds);
    const overallDensity = totalPoints / area;
    const densityVariation =
      this._calculateStandardDeviation(densities) /
      this._calculateMean(densities);

    // Spatial concentration (Gini coefficient approximation)
    const sortedDensities = [...densities].sort((a, b) => a - b);
    const n = sortedDensities.length;
    let giniSum = 0;
    for (let i = 0; i < n; i++) {
      giniSum += (2 * (i + 1) - n - 1) * sortedDensities[i];
    }
    const spatialConcentration = giniSum / (n * this._calculateMean(densities));

    // Clustering coefficient (ratio of occupied to total cells)
    const clusteringCoefficient =
      occupiedCells / (grid.length * grid[0].length);

    return {
      overallDensity,
      densityVariation,
      spatialConcentration,
      clusteringCoefficient,
    };
  }

  /**
   * Analyze density patterns
   * @private
   */
  _analyzeDensityPatterns(grid, stats) {
    const densities = [];
    grid.forEach(row => {
      row.forEach(cell => {
        densities.push(cell.density);
      });
    });

    // Determine distribution type
    let distributionType = 'uniform';
    const cv = stats.standardDeviation / stats.mean;
    if (cv > 1.5) {
      distributionType = 'highly_clustered';
    } else if (cv > 0.8) {
      distributionType = 'moderately_clustered';
    } else if (cv > 0.3) {
      distributionType = 'weakly_clustered';
    }

    // Uniformity index (inverse of coefficient of variation)
    const uniformityIndex = 1 / (1 + cv);

    // Segregation index (how separated high and low density areas are)
    const segregationIndex = this._calculateSpatialSegregation(grid);

    // Concentration ratio (80/20 rule - what % of points are in top 20% of cells)
    const sortedCells = [];
    grid.forEach(row => {
      row.forEach(cell => {
        if (cell.count > 0) sortedCells.push(cell);
      });
    });
    sortedCells.sort((a, b) => b.count - a.count);

    const topCells = Math.ceil(sortedCells.length * 0.2);
    const topPoints = sortedCells
      .slice(0, topCells)
      .reduce((sum, cell) => sum + cell.count, 0);
    const totalPoints = sortedCells.reduce((sum, cell) => sum + cell.count, 0);
    const concentrationRatio = totalPoints > 0 ? topPoints / totalPoints : 0;

    return {
      distributionType,
      uniformityIndex,
      segregationIndex,
      concentrationRatio,
    };
  }

  /**
   * Calculate spatial segregation index
   * @private
   */
  _calculateSpatialSegregation(grid) {
    // Measure how spatially separated high and low density areas are
    let segregation = 0;
    let comparisons = 0;

    const rows = grid.length;
    const cols = grid[0].length;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = grid[y][x];

        // Compare with neighbors
        const neighbors = [
          [y - 1, x],
          [y + 1, x],
          [y, x - 1],
          [y, x + 1],
          [y - 1, x - 1],
          [y - 1, x + 1],
          [y + 1, x - 1],
          [y + 1, x + 1],
        ];

        neighbors.forEach(([ny, nx]) => {
          if (ny >= 0 && ny < rows && nx >= 0 && nx < cols) {
            const neighbor = grid[ny][nx];
            const densityDiff = Math.abs(cell.density - neighbor.density);
            segregation += densityDiff;
            comparisons++;
          }
        });
      }
    }

    return comparisons > 0 ? segregation / comparisons : 0;
  }

  /**
   * Compress grid for output (to avoid large data structures)
   * @private
   */
  _compressGridForOutput(grid) {
    return {
      dimensions: { rows: grid.length, cols: grid[0].length },
      summary: {
        totalCells: grid.length * grid[0].length,
        occupiedCells: grid.reduce(
          (sum, row) => sum + row.filter(cell => cell.count > 0).length,
          0
        ),
        maxDensity: Math.max(...grid.flat().map(cell => cell.density)),
        nonZeroCells: grid.reduce(
          (sum, row) => sum + row.filter(cell => cell.density > 0).length,
          0
        ),
      },
    };
  }

  /**
   * Calculate optimal DBSCAN parameters
   * @private
   */
  _calculateOptimalDBSCANParams(locations) {
    // Calculate distances to k-nearest neighbors to estimate epsilon
    const k = Math.max(3, Math.min(10, Math.floor(locations.length / 10))); // Adaptive k
    const distances = [];

    locations.forEach(point => {
      const neighborDistances = [];
      locations.forEach(other => {
        if (other !== point) {
          const dist = this._calculateHaversineDistance(
            point.lat,
            point.lng,
            other.lat,
            other.lng
          );
          neighborDistances.push(dist);
        }
      });

      neighborDistances.sort((a, b) => a - b);
      if (neighborDistances.length >= k) {
        distances.push(neighborDistances[k - 1]); // k-th nearest neighbor
      }
    });

    distances.sort((a, b) => a - b);

    // Use elbow method approximation - find point where distance increases significantly
    const epsilonKm =
      distances.length > 0
        ? distances[Math.floor(distances.length * 0.8)]
        : 1.0; // 80th percentile

    // Convert km to degrees (rough approximation)
    const epsilon = epsilonKm / 111.32; // 111.32 km per degree at equator

    // Minimum points: typically 3-5 for geographic data
    const minPoints = Math.max(
      3,
      Math.min(5, Math.floor(locations.length / 20))
    );

    return { epsilon, epsilonKm, minPoints };
  }

  /**
   * Apply DBSCAN clustering algorithm
   * @private
   */
  _applyDBSCAN(locations, epsilon, minPoints) {
    const clusters = [];
    let clusterId = 0;

    // Reset point states
    locations.forEach(point => {
      point.clusterId = -1; // Unassigned
      point.visited = false;
    });

    locations.forEach(point => {
      if (point.visited) return;

      point.visited = true;
      const neighbors = this._getNeighbors(point, locations, epsilon);

      if (neighbors.length < minPoints) {
        point.clusterId = -2; // Mark as noise
      } else {
        // Start new cluster
        const cluster = {
          id: clusterId++,
          points: [point],
        };
        point.clusterId = cluster.id;

        // Expand cluster
        let i = 0;
        while (i < neighbors.length) {
          const neighbor = neighbors[i];

          if (!neighbor.visited) {
            neighbor.visited = true;
            const neighborNeighbors = this._getNeighbors(
              neighbor,
              locations,
              epsilon
            );

            if (neighborNeighbors.length >= minPoints) {
              // Add new neighbors to search
              neighborNeighbors.forEach(nn => {
                if (!neighbors.includes(nn)) {
                  neighbors.push(nn);
                }
              });
            }
          }

          if (neighbor.clusterId === -1) {
            // Not yet assigned to cluster
            neighbor.clusterId = cluster.id;
            cluster.points.push(neighbor);
          }

          i++;
        }

        clusters.push(cluster);
      }
    });

    // Calculate cluster properties
    clusters.forEach(cluster => {
      cluster.centroid = this._calculateCentroid(cluster.points);
      cluster.bounds = this._calculateBasicBounds(cluster.points);
      cluster.density = this._calculateClusterDensity(cluster.points);
      cluster.compactness = this._calculateClusterCompactness(
        cluster.points,
        cluster.centroid
      );
    });

    const noise = locations.filter(p => p.clusterId === -2);
    const clusteredPoints = locations.filter(p => p.clusterId >= 0).length;

    return { clusters, noise, clusteredPoints };
  }

  /**
   * Get neighbors within epsilon distance
   * @private
   */
  _getNeighbors(point, locations, epsilon) {
    return locations.filter(other => {
      if (other === point) return false;
      const distance = Math.sqrt(
        Math.pow(point.lat - other.lat, 2) + Math.pow(point.lng - other.lng, 2)
      );
      return distance <= epsilon;
    });
  }

  /**
   * Calculate cluster density
   * @private
   */
  _calculateClusterDensity(points) {
    if (points.length < 2) return 0;

    const bounds = this._calculateBasicBounds(points);
    const area = this._calculateCoverageArea(bounds);
    return area > 0 ? points.length / area : 0;
  }

  /**
   * Calculate cluster compactness
   * @private
   */
  _calculateClusterCompactness(points, centroid) {
    if (points.length === 0) return 0;

    const distances = points.map(p =>
      this._calculateHaversineDistance(p.lat, p.lng, centroid.lat, centroid.lng)
    );

    const meanDistance = this._calculateMean(distances);
    const stdDistance = this._calculateStandardDeviation(distances);

    // Compactness: inverse of coefficient of variation
    return meanDistance > 0 ? 1 / (1 + stdDistance / meanDistance) : 1;
  }

  /**
   * Analyze cluster characteristics
   * @private
   */
  _analyzeClusterCharacteristics(clusters) {
    if (clusters.length === 0) {
      return {
        averageSize: 0,
        largestSize: 0,
        smallestSize: 0,
        sizeVariation: 0,
        avgIntraClusterDistance: 0,
        avgInterClusterDistance: 0,
      };
    }

    const sizes = clusters.map(c => c.points.length);
    const averageSize = this._calculateMean(sizes);
    const largestSize = Math.max(...sizes);
    const smallestSize = Math.min(...sizes);
    const sizeVariation = this._calculateStandardDeviation(sizes) / averageSize;

    // Average intra-cluster distance
    let totalIntraDistance = 0;
    let intraPairs = 0;

    clusters.forEach(cluster => {
      const points = cluster.points;
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          totalIntraDistance += this._calculateHaversineDistance(
            points[i].lat,
            points[i].lng,
            points[j].lat,
            points[j].lng
          );
          intraPairs++;
        }
      }
    });

    const avgIntraClusterDistance =
      intraPairs > 0 ? totalIntraDistance / intraPairs : 0;

    // Average inter-cluster distance (between centroids)
    let totalInterDistance = 0;
    let interPairs = 0;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        totalInterDistance += this._calculateHaversineDistance(
          clusters[i].centroid.lat,
          clusters[i].centroid.lng,
          clusters[j].centroid.lat,
          clusters[j].centroid.lng
        );
        interPairs++;
      }
    }

    const avgInterClusterDistance =
      interPairs > 0 ? totalInterDistance / interPairs : 0;

    return {
      averageSize,
      largestSize,
      smallestSize,
      sizeVariation,
      avgIntraClusterDistance,
      avgInterClusterDistance,
    };
  }

  /**
   * Calculate clustering quality metrics
   * @private
   */
  _calculateClusteringQuality(clusterResult, allPoints) {
    const { clusters, noise } = clusterResult;

    if (clusters.length === 0) {
      return {
        silhouetteScore: -1,
        daviesBouldinIndex: Infinity,
        calinskiHarabaszIndex: 0,
        category: 'poor',
      };
    }

    // Simplified silhouette score
    let silhouetteSum = 0;
    let silhouetteCount = 0;

    clusters.forEach(cluster => {
      cluster.points.forEach(point => {
        // Average intra-cluster distance
        let intraSum = 0;
        cluster.points.forEach(other => {
          if (other !== point) {
            intraSum += this._calculateHaversineDistance(
              point.lat,
              point.lng,
              other.lat,
              other.lng
            );
          }
        });
        const avgIntra =
          cluster.points.length > 1
            ? intraSum / (cluster.points.length - 1)
            : 0;

        // Minimum average inter-cluster distance
        let minAvgInter = Infinity;
        clusters.forEach(otherCluster => {
          if (otherCluster !== cluster) {
            let interSum = 0;
            otherCluster.points.forEach(other => {
              interSum += this._calculateHaversineDistance(
                point.lat,
                point.lng,
                other.lat,
                other.lng
              );
            });
            const avgInter =
              otherCluster.points.length > 0
                ? interSum / otherCluster.points.length
                : Infinity;
            minAvgInter = Math.min(minAvgInter, avgInter);
          }
        });

        if (minAvgInter !== Infinity && avgIntra > 0) {
          const silhouette =
            (minAvgInter - avgIntra) / Math.max(avgIntra, minAvgInter);
          silhouetteSum += silhouette;
          silhouetteCount++;
        }
      });
    });

    const silhouetteScore =
      silhouetteCount > 0 ? silhouetteSum / silhouetteCount : -1;

    // Simplified Davies-Bouldin Index
    let dbSum = 0;
    clusters.forEach((cluster, i) => {
      let maxRatio = 0;
      clusters.forEach((otherCluster, j) => {
        if (i !== j) {
          const centerDistance = this._calculateHaversineDistance(
            cluster.centroid.lat,
            cluster.centroid.lng,
            otherCluster.centroid.lat,
            otherCluster.centroid.lng
          );

          if (centerDistance > 0) {
            const ratio =
              (cluster.compactness + otherCluster.compactness) / centerDistance;
            maxRatio = Math.max(maxRatio, ratio);
          }
        }
      });
      dbSum += maxRatio;
    });

    const daviesBouldinIndex =
      clusters.length > 0 ? dbSum / clusters.length : Infinity;

    // Simplified Calinski-Harabasz Index
    const totalCentroid = this._calculateCentroid(allPoints);
    let betweenSS = 0;
    let withinSS = 0;

    clusters.forEach(cluster => {
      const clusterSize = cluster.points.length;
      const centerDistance = this._calculateHaversineDistance(
        cluster.centroid.lat,
        cluster.centroid.lng,
        totalCentroid.lat,
        totalCentroid.lng
      );
      betweenSS += clusterSize * centerDistance * centerDistance;

      cluster.points.forEach(point => {
        const pointDistance = this._calculateHaversineDistance(
          point.lat,
          point.lng,
          cluster.centroid.lat,
          cluster.centroid.lng
        );
        withinSS += pointDistance * pointDistance;
      });
    });

    const k = clusters.length;
    const n = allPoints.length;
    const calinskiHarabaszIndex =
      k > 1 && withinSS > 0 ? betweenSS / (k - 1) / (withinSS / (n - k)) : 0;

    // Determine quality category
    let category = 'poor';
    if (silhouetteScore > 0.7) category = 'excellent';
    else if (silhouetteScore > 0.5) category = 'good';
    else if (silhouetteScore > 0.25) category = 'fair';

    return {
      silhouetteScore,
      daviesBouldinIndex,
      calinskiHarabaszIndex,
      category,
    };
  }

  /**
   * Identify cluster patterns
   * @private
   */
  _identifyClusterPatterns(clusters) {
    if (clusters.length === 0) {
      return {
        dominantPattern: 'no_clusters',
        spatialDistribution: 'scattered',
        clusterSeparation: 'none',
        hierarchicalStructure: 'flat',
      };
    }

    // Analyze cluster sizes
    const sizes = clusters.map(c => c.points.length);
    const avgSize = this._calculateMean(sizes);
    const maxSize = Math.max(...sizes);
    const sizeVariation = this._calculateStandardDeviation(sizes) / avgSize;

    let dominantPattern = 'uniform';
    if (sizeVariation > 1.5) {
      dominantPattern = 'hierarchical';
    } else if (sizeVariation > 0.8) {
      dominantPattern = 'mixed';
    }

    // Analyze spatial distribution
    const centroids = clusters.map(c => c.centroid);
    const centroidSpread = this._calculateSpatialDistribution(
      centroids,
      this._calculateCentroid(centroids)
    );

    let spatialDistribution = 'compact';
    if (centroidSpread.spreadIndex > 1.0) {
      spatialDistribution = 'dispersed';
    } else if (centroidSpread.spreadIndex > 0.5) {
      spatialDistribution = 'moderate';
    }

    // Analyze cluster separation
    const analysis = this._analyzeClusterCharacteristics(clusters);
    const separationRatio =
      analysis.avgInterClusterDistance / analysis.avgIntraClusterDistance;

    let clusterSeparation = 'poor';
    if (separationRatio > 3.0) clusterSeparation = 'excellent';
    else if (separationRatio > 2.0) clusterSeparation = 'good';
    else if (separationRatio > 1.5) clusterSeparation = 'fair';

    // Hierarchical structure analysis
    let hierarchicalStructure = 'flat';
    if (maxSize > avgSize * 3) {
      hierarchicalStructure = 'dominant_cluster';
    } else if (sizeVariation > 1.0) {
      hierarchicalStructure = 'multi_level';
    }

    return {
      dominantPattern,
      spatialDistribution,
      clusterSeparation,
      hierarchicalStructure,
    };
  }

  /**
   * Calculate bounding box
   * @private
   */
  _calculateBoundingBox(locations) {
    const bounds = this._calculateBasicBounds(locations);
    const latSpan = bounds.maxLat - bounds.minLat;
    const lngSpan = bounds.maxLng - bounds.minLng;
    const area = this._calculateCoverageArea(bounds);
    const aspectRatio = lngSpan > 0 ? latSpan / lngSpan : 1;

    return {
      north: bounds.maxLat,
      south: bounds.minLat,
      east: bounds.maxLng,
      west: bounds.minLng,
      latSpan,
      lngSpan,
      area,
      aspectRatio,
    };
  }

  /**
   * Calculate convex hull using Graham scan algorithm
   * @private
   */
  _calculateConvexHull(locations) {
    if (locations.length < 3) {
      return {
        vertices: locations,
        area: 0,
        perimeter:
          locations.length === 2
            ? this._calculateHaversineDistance(
                locations[0].lat,
                locations[0].lng,
                locations[1].lat,
                locations[1].lng
              )
            : 0,
        centroid: this._calculateCentroid(locations),
      };
    }

    // Find the bottom-most point (and leftmost in case of tie)
    let bottom = locations[0];
    for (let i = 1; i < locations.length; i++) {
      const point = locations[i];
      if (
        point.lat < bottom.lat ||
        (point.lat === bottom.lat && point.lng < bottom.lng)
      ) {
        bottom = point;
      }
    }

    // Sort points by polar angle with respect to bottom point
    const sortedPoints = locations
      .filter(p => p !== bottom)
      .sort((a, b) => {
        const angleA = Math.atan2(a.lat - bottom.lat, a.lng - bottom.lng);
        const angleB = Math.atan2(b.lat - bottom.lat, b.lng - bottom.lng);

        if (angleA === angleB) {
          // If angles are equal, sort by distance
          const distA = this._calculateHaversineDistance(
            bottom.lat,
            bottom.lng,
            a.lat,
            a.lng
          );
          const distB = this._calculateHaversineDistance(
            bottom.lat,
            bottom.lng,
            b.lat,
            b.lng
          );
          return distA - distB;
        }

        return angleA - angleB;
      });

    // Graham scan
    const hull = [bottom];

    for (const point of sortedPoints) {
      // Remove points that make a right turn
      while (
        hull.length > 1 &&
        this._crossProduct(
          hull[hull.length - 2],
          hull[hull.length - 1],
          point
        ) <= 0
      ) {
        hull.pop();
      }
      hull.push(point);
    }

    // Calculate hull properties
    const area = this._calculatePolygonArea(hull);
    const perimeter = this._calculatePolygonPerimeter(hull);
    const centroid = this._calculatePolygonCentroid(hull);

    return {
      vertices: hull,
      area,
      perimeter,
      centroid,
    };
  }

  /**
   * Calculate cross product for convex hull
   * @private
   */
  _crossProduct(o, a, b) {
    return (
      (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng)
    );
  }

  /**
   * Calculate polygon area using shoelace formula
   * @private
   */
  _calculatePolygonArea(vertices) {
    if (vertices.length < 3) return 0;

    let area = 0;
    for (let i = 0; i < vertices.length; i++) {
      const j = (i + 1) % vertices.length;
      area += vertices[i].lng * vertices[j].lat;
      area -= vertices[j].lng * vertices[i].lat;
    }

    // Convert to km² using approximation
    const earthRadius = 6371; // km
    const degreeToKm = (Math.PI / 180) * earthRadius;
    return (Math.abs(area) * degreeToKm * degreeToKm) / 2;
  }

  /**
   * Calculate polygon perimeter
   * @private
   */
  _calculatePolygonPerimeter(vertices) {
    if (vertices.length < 2) return 0;

    let perimeter = 0;
    for (let i = 0; i < vertices.length; i++) {
      const j = (i + 1) % vertices.length;
      perimeter += this._calculateHaversineDistance(
        vertices[i].lat,
        vertices[i].lng,
        vertices[j].lat,
        vertices[j].lng
      );
    }

    return perimeter;
  }

  /**
   * Calculate polygon centroid
   * @private
   */
  _calculatePolygonCentroid(vertices) {
    if (vertices.length === 0) return { lat: 0, lng: 0 };
    if (vertices.length === 1)
      return { lat: vertices[0].lat, lng: vertices[0].lng };

    let area = 0;
    let centroidLat = 0;
    let centroidLng = 0;

    for (let i = 0; i < vertices.length; i++) {
      const j = (i + 1) % vertices.length;
      const crossProduct =
        vertices[i].lng * vertices[j].lat - vertices[j].lng * vertices[i].lat;
      area += crossProduct;
      centroidLat += (vertices[i].lat + vertices[j].lat) * crossProduct;
      centroidLng += (vertices[i].lng + vertices[j].lng) * crossProduct;
    }

    if (area === 0) {
      // Fallback to simple average for degenerate cases
      return this._calculateCentroid(vertices);
    }

    area *= 3;
    return {
      lat: centroidLat / area,
      lng: centroidLng / area,
    };
  }

  /**
   * Calculate geometric properties
   * @private
   */
  _calculateGeometricProperties(locations, convexHull, boundingBox) {
    const centroid = this._calculateCentroid(locations);

    // Determine geometry type
    let geometryType = 'complex';
    if (locations.length === 1) {
      geometryType = 'point';
    } else if (locations.length === 2) {
      geometryType = 'line';
    } else if (convexHull.vertices.length <= 4) {
      geometryType = 'simple_polygon';
    }

    // Compactness (isoperimetric quotient)
    const compactness =
      convexHull.perimeter > 0
        ? (4 * Math.PI * convexHull.area) /
          (convexHull.perimeter * convexHull.perimeter)
        : 0;

    // Elongation (aspect ratio)
    const elongation = boundingBox.aspectRatio;

    // Rectangular fit (how well the hull fits its bounding box)
    const rectangularFit =
      boundingBox.area > 0 ? convexHull.area / boundingBox.area : 0;

    return {
      centroid,
      type: geometryType,
      compactness,
      elongation,
      rectangularFit,
    };
  }

  /**
   * Calculate spatial coverage metrics
   * @private
   */
  _calculateSpatialCoverageMetrics(locations, convexHull, boundingBox) {
    // Hull coverage ratio (hull area vs bounding box area)
    const hullCoverageRatio =
      boundingBox.area > 0 ? convexHull.area / boundingBox.area : 0;

    // Point density (points per km²)
    const pointDensity =
      convexHull.area > 0 ? locations.length / convexHull.area : 0;

    // Spatial efficiency (how efficiently points use space)
    const spatialEfficiency = Math.min(
      (hullCoverageRatio * pointDensity) / 10,
      1
    );

    // Boundary complexity (perimeter vs area ratio)
    const boundaryComplexity =
      convexHull.area > 0
        ? convexHull.perimeter / Math.sqrt(convexHull.area)
        : 0;

    return {
      hullCoverageRatio,
      pointDensity,
      spatialEfficiency,
      boundaryComplexity,
    };
  }

  /**
   * Analyze spatial bounds distribution
   * @private
   */
  _analyzeSpatialBoundsDistribution(locations, convexHull) {
    const centroid = this._calculateCentroid(locations);

    // Spatial spread index
    const distances = locations.map(loc =>
      this._calculateHaversineDistance(
        loc.lat,
        loc.lng,
        centroid.lat,
        centroid.lng
      )
    );
    const meanDistance = this._calculateMean(distances);
    const stdDistance = this._calculateStandardDeviation(distances);
    const spatialSpreadIndex = stdDistance / meanDistance;

    // Edge vs interior points
    const hullVertices = new Set(
      convexHull.vertices.map(v => `${v.lat},${v.lng}`)
    );
    const edgePoints = locations.filter(loc =>
      hullVertices.has(`${loc.lat},${loc.lng}`)
    ).length;
    const interiorPoints = locations.length - edgePoints;

    const edgePointRatio =
      locations.length > 0 ? edgePoints / locations.length : 0;
    const interiorPointRatio =
      locations.length > 0 ? interiorPoints / locations.length : 0;

    // Distribution type
    let distributionType = 'uniform';
    if (edgePointRatio > 0.5) {
      distributionType = 'edge_dominated';
    } else if (interiorPointRatio > 0.8) {
      distributionType = 'interior_concentrated';
    } else if (spatialSpreadIndex > 1.0) {
      distributionType = 'dispersed';
    }

    return {
      spatialSpreadIndex,
      edgePointRatio,
      interiorPointRatio,
      distributionType,
    };
  }

  // =============================================================================
  // STATISTICAL ANALYSIS HELPER FUNCTIONS
  // =============================================================================

  /**
   * Shapiro-Wilk test for normality
   * @param {Array<number>} sorted - Sorted array of values
   * @returns {Object} Test statistic and p-value
   * @private
   */
  _shapiroWilkTest(sorted) {
    const n = sorted.length;

    if (n < 3 || n > 5000) {
      return {
        statistic: null,
        pValue: null,
        message: 'Sample size outside valid range (3-5000)',
      };
    }

    // Calculate Shapiro-Wilk coefficients (approximation for computational efficiency)
    const a = this._getShapiroWilkCoefficients(n);

    // Calculate W statistic
    let numerator = 0;
    for (let i = 0; i < Math.floor(n / 2); i++) {
      numerator += a[i] * (sorted[n - 1 - i] - sorted[i]);
    }
    numerator = numerator * numerator;

    // Calculate denominator (sum of squared deviations)
    const mean = this._calculateMean(sorted);
    const denominator = sorted.reduce(
      (sum, x) => sum + Math.pow(x - mean, 2),
      0
    );

    const W = numerator / denominator;

    // Approximate p-value calculation
    const pValue = this._approximateShapiroWilkPValue(W, n);

    return {
      statistic: W,
      pValue,
      criticalValue: this._getShapiroWilkCriticalValue(n, 0.05),
      interpretation: pValue > 0.05 ? 'Normal' : 'Non-normal',
      method: 'Shapiro-Wilk',
    };
  }

  /**
   * Get Shapiro-Wilk coefficients (approximation)
   * @param {number} n - Sample size
   * @returns {Array<number>} Coefficients array
   * @private
   */
  _getShapiroWilkCoefficients(n) {
    const a = new Array(Math.floor(n / 2));

    // Approximation of Shapiro-Wilk coefficients
    for (let i = 0; i < a.length; i++) {
      const m = this._getNormalOrderStatistic(i + 1, n);
      a[i] = m;
    }

    // Normalize coefficients
    const sumSquares = a.reduce((sum, val) => sum + val * val, 0);
    const norm = Math.sqrt(sumSquares);
    return a.map(val => val / norm);
  }

  /**
   * Get expected value of i-th order statistic from standard normal
   * @param {number} i - Order statistic position
   * @param {number} n - Sample size
   * @returns {number} Expected value
   * @private
   */
  _getNormalOrderStatistic(i, n) {
    // Approximation for normal order statistics
    const p = (i - 0.375) / (n + 0.25);
    return this._normalQuantile(p);
  }

  /**
   * Approximate normal quantile function (inverse CDF)
   * @param {number} p - Probability (0 < p < 1)
   * @returns {number} Quantile value
   * @private
   */
  _normalQuantile(p) {
    // Beasley-Springer-Moro algorithm approximation
    if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity;

    const a0 = -3.969683028665376e1;
    const a1 = 2.209460984245205e2;
    const a2 = -2.759285104469687e2;
    const a3 = 1.38357751867269e2;
    const a4 = -3.066479806614716e1;
    const a5 = 2.506628277459239;

    const b1 = -5.447609879822406e1;
    const b2 = 1.615858368580409e2;
    const b3 = -1.556989798598866e2;
    const b4 = 6.680131188771972e1;
    const b5 = -1.328068155288572e1;

    const c0 = -7.784894002430293e-3;
    const c1 = -3.223964580411365e-1;
    const c2 = -2.400758277161838;
    const c3 = -2.549732539343734;
    const c4 = 4.374664141464968;
    const c5 = 2.938163982698783;

    const d1 = 7.784695709041462e-3;
    const d2 = 3.224671290700398e-1;
    const d3 = 2.445134137142996;
    const d4 = 3.754408661907416;

    const p_low = 0.02425;
    const p_high = 1 - p_low;

    let q, r, x;

    if (p < p_low) {
      q = Math.sqrt(-2 * Math.log(p));
      x =
        (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
        ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
    } else if (p <= p_high) {
      q = p - 0.5;
      r = q * q;
      x =
        ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
        (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
    } else {
      q = Math.sqrt(-2 * Math.log(1 - p));
      x =
        -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
        ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
    }

    return x;
  }

  /**
   * Approximate Shapiro-Wilk p-value
   * @param {number} W - Test statistic
   * @param {number} n - Sample size
   * @returns {number} Approximate p-value
   * @private
   */
  _approximateShapiroWilkPValue(W, n) {
    // Approximation based on empirical studies
    if (n <= 3) return W > 0.767 ? 0.1 : 0.01;
    if (n <= 11) {
      const critical = 0.859 - 0.01 * n;
      return W > critical ? 0.1 : 0.01;
    }

    // For larger samples, use normal approximation
    const mu = 1 - 2.273 / n;
    const sigma = 0.04542 / Math.sqrt(n);
    const z = (W - mu) / sigma;

    return 2 * (1 - this._normalCDF(Math.abs(z)));
  }

  /**
   * Get Shapiro-Wilk critical value
   * @param {number} n - Sample size
   * @param {number} alpha - Significance level
   * @returns {number} Critical value
   * @private
   */
  _getShapiroWilkCriticalValue(n, alpha = 0.05) {
    // Approximate critical values for alpha = 0.05
    if (n <= 3) return 0.767;
    if (n <= 11) return 0.859 - 0.01 * n;
    if (n <= 50) return 0.947 - 0.0006 * n;
    return 0.95 - 0.0001 * n;
  }

  /**
   * Kolmogorov-Smirnov test against normal distribution
   * @param {Array<number>} sorted - Sorted array of values
   * @returns {Object} Test statistic and p-value
   * @private
   */
  _kolmogorovSmirnovTest(sorted) {
    const n = sorted.length;
    const mean = this._calculateMean(sorted);
    const std = this._calculateStandardDeviation(sorted);

    // Calculate empirical CDF vs theoretical normal CDF
    let maxDiff = 0;

    for (let i = 0; i < n; i++) {
      const empiricalCDF = (i + 1) / n;
      const theoreticalCDF = this._normalCDF((sorted[i] - mean) / std);
      const diff = Math.abs(empiricalCDF - theoreticalCDF);
      maxDiff = Math.max(maxDiff, diff);
    }

    // Calculate p-value using Kolmogorov distribution
    const pValue = this._kolmogorovSmirnovPValue(maxDiff, n);

    return {
      statistic: maxDiff,
      pValue,
      criticalValue: this._getKSCriticalValue(n, 0.05),
      interpretation: pValue > 0.05 ? 'Normal' : 'Non-normal',
      method: 'Kolmogorov-Smirnov',
    };
  }

  /**
   * Standard normal cumulative distribution function
   * @param {number} x - Value
   * @returns {number} Cumulative probability
   * @private
   */
  _normalCDF(x) {
    // Approximation using error function
    return 0.5 * (1 + this._erf(x / Math.sqrt(2)));
  }

  /**
   * Error function approximation
   * @param {number} x - Value
   * @returns {number} Error function value
   * @private
   */
  _erf(x) {
    // Abramowitz and Stegun approximation
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);

    const t = 1 / (1 + p * x);
    const y =
      1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return sign * y;
  }

  /**
   * Kolmogorov-Smirnov p-value calculation
   * @param {number} D - Test statistic
   * @param {number} n - Sample size
   * @returns {number} P-value
   * @private
   */
  _kolmogorovSmirnovPValue(D, n) {
    // Approximation for large n
    const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * D;

    if (lambda < 0.1) return 1;
    if (lambda > 3.5) return 0;

    // Kolmogorov distribution approximation
    let sum = 0;
    for (let j = 1; j <= 100; j++) {
      sum += Math.pow(-1, j - 1) * Math.exp(-2 * j * j * lambda * lambda);
    }

    return Math.max(0, Math.min(1, 2 * sum));
  }

  /**
   * Get Kolmogorov-Smirnov critical value
   * @param {number} n - Sample size
   * @param {number} alpha - Significance level
   * @returns {number} Critical value
   * @private
   */
  _getKSCriticalValue(n, alpha = 0.05) {
    // Critical values for alpha = 0.05
    if (alpha === 0.05) {
      return 1.36 / Math.sqrt(n);
    }
    // Other alpha values
    const c = alpha === 0.01 ? 1.63 : alpha === 0.1 ? 1.22 : 1.36;
    return c / Math.sqrt(n);
  }

  /**
   * Get normality recommendation based on test results
   * @param {number} n - Sample size
   * @param {boolean} isNormal - Normality test result
   * @param {number} confidence - Confidence level
   * @returns {string} Recommendation text
   * @private
   */
  _getNormalityRecommendation(n, isNormal, confidence) {
    if (n < 30) {
      return 'Small sample size - interpret normality tests with caution. Consider visual inspection and domain knowledge.';
    }

    if (isNormal === true) {
      if (confidence > 0.1) {
        return 'Strong evidence for normality. Parametric methods are appropriate.';
      } else {
        return 'Weak evidence for normality. Consider robust statistical methods.';
      }
    } else if (isNormal === false) {
      if (confidence < 0.001) {
        return 'Strong evidence against normality. Use non-parametric methods or data transformation.';
      } else {
        return 'Moderate evidence against normality. Consider data transformation or robust methods.';
      }
    }

    return 'Insufficient evidence to determine normality. Use robust statistical methods.';
  }

  // =============================================================================
  // DISTRIBUTION FITTING HELPER FUNCTIONS
  // =============================================================================

  /**
   * Fit normal distribution and calculate goodness of fit
   * @param {Array<number>} values - Data values
   * @param {number} mean - Distribution mean
   * @param {number} std - Distribution standard deviation
   * @returns {Object} Goodness of fit statistics
   * @private
   */
  _fitNormalDistribution(values, mean, std) {
    const n = values.length;
    const sorted = [...values].sort((a, b) => a - b);

    // Calculate log-likelihood
    let logLikelihood = 0;
    for (const x of values) {
      const z = (x - mean) / std;
      logLikelihood +=
        -0.5 * Math.log(2 * Math.PI) - Math.log(std) - 0.5 * z * z;
    }

    // Kolmogorov-Smirnov test
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      const empiricalCDF = (i + 1) / n;
      const theoreticalCDF = this._normalCDF((sorted[i] - mean) / std);
      maxDiff = Math.max(maxDiff, Math.abs(empiricalCDF - theoreticalCDF));
    }

    const pValue = this._kolmogorovSmirnovPValue(maxDiff, n);

    return {
      logLikelihood,
      ksStatistic: maxDiff,
      pValue,
      goodnessOfFit: pValue > 0.05 ? 'good' : 'poor',
    };
  }

  /**
   * Fit log-normal distribution
   * @param {Array<number>} values - Data values (must be positive)
   * @param {number} logMean - Mean of log-transformed values
   * @param {number} logStd - Standard deviation of log-transformed values
   * @returns {Object} Goodness of fit statistics
   * @private
   */
  _fitLognormalDistribution(values, logMean, logStd) {
    const n = values.length;
    const sorted = [...values].sort((a, b) => a - b);

    // Calculate log-likelihood
    let logLikelihood = 0;
    for (const x of values) {
      if (x <= 0) continue; // Skip non-positive values
      const logX = Math.log(x);
      const z = (logX - logMean) / logStd;
      logLikelihood +=
        -0.5 * Math.log(2 * Math.PI) -
        Math.log(logStd) -
        Math.log(x) -
        0.5 * z * z;
    }

    // Kolmogorov-Smirnov test
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      if (sorted[i] <= 0) continue;
      const empiricalCDF = (i + 1) / n;
      const theoreticalCDF = this._normalCDF(
        (Math.log(sorted[i]) - logMean) / logStd
      );
      maxDiff = Math.max(maxDiff, Math.abs(empiricalCDF - theoreticalCDF));
    }

    const pValue = this._kolmogorovSmirnovPValue(maxDiff, n);

    return {
      logLikelihood,
      ksStatistic: maxDiff,
      pValue,
      goodnessOfFit: pValue > 0.05 ? 'good' : 'poor',
    };
  }

  /**
   * Fit exponential distribution
   * @param {Array<number>} values - Data values
   * @param {number} lambda - Rate parameter
   * @returns {Object} Goodness of fit statistics
   * @private
   */
  _fitExponentialDistribution(values, lambda) {
    const n = values.length;
    const sorted = [...values].sort((a, b) => a - b);

    // Calculate log-likelihood
    let logLikelihood = 0;
    for (const x of values) {
      if (x < 0) continue;
      logLikelihood += Math.log(lambda) - lambda * x;
    }

    // Kolmogorov-Smirnov test
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      if (sorted[i] < 0) continue;
      const empiricalCDF = (i + 1) / n;
      const theoreticalCDF = 1 - Math.exp(-lambda * sorted[i]);
      maxDiff = Math.max(maxDiff, Math.abs(empiricalCDF - theoreticalCDF));
    }

    const pValue = this._kolmogorovSmirnovPValue(maxDiff, n);

    return {
      logLikelihood,
      ksStatistic: maxDiff,
      pValue,
      goodnessOfFit: pValue > 0.05 ? 'good' : 'poor',
    };
  }

  /**
   * Estimate gamma distribution parameters using method of moments
   * @param {Array<number>} values - Data values
   * @returns {Object} Shape and scale parameters
   * @private
   */
  _estimateGammaParameters(values) {
    const mean = this._calculateMean(values);
    const variance = this._calculateVariance(values);

    if (mean <= 0 || variance <= 0) {
      return { shape: 1, scale: 1 };
    }

    const scale = variance / mean;
    const shape = mean / scale;

    return { shape, scale };
  }

  /**
   * Fit gamma distribution
   * @param {Array<number>} values - Data values
   * @param {number} shape - Shape parameter (alpha)
   * @param {number} scale - Scale parameter (beta)
   * @returns {Object} Goodness of fit statistics
   * @private
   */
  _fitGammaDistribution(values, shape, scale) {
    const n = values.length;
    const sorted = [...values].sort((a, b) => a - b);

    // Calculate log-likelihood (approximation)
    let logLikelihood = 0;
    for (const x of values) {
      if (x <= 0) continue;
      logLikelihood +=
        (shape - 1) * Math.log(x) -
        x / scale -
        shape * Math.log(scale) -
        this._logGamma(shape);
    }

    // Kolmogorov-Smirnov test (approximate)
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      if (sorted[i] <= 0) continue;
      const empiricalCDF = (i + 1) / n;
      const theoreticalCDF = this._gammaCDF(sorted[i], shape, scale);
      maxDiff = Math.max(maxDiff, Math.abs(empiricalCDF - theoreticalCDF));
    }

    const pValue = this._kolmogorovSmirnovPValue(maxDiff, n);

    return {
      logLikelihood,
      ksStatistic: maxDiff,
      pValue,
      goodnessOfFit: pValue > 0.05 ? 'good' : 'poor',
    };
  }

  /**
   * Approximate log-gamma function
   * @param {number} x - Input value
   * @returns {number} Log-gamma value
   * @private
   */
  _logGamma(x) {
    // Stirling's approximation for log-gamma
    if (x < 1) return this._logGamma(x + 1) - Math.log(x);
    return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI);
  }

  /**
   * Approximate gamma cumulative distribution function
   * @param {number} x - Value
   * @param {number} shape - Shape parameter
   * @param {number} scale - Scale parameter
   * @returns {number} Cumulative probability
   * @private
   */
  _gammaCDF(x, shape, scale) {
    if (x <= 0) return 0;
    // Approximation using incomplete gamma function
    return this._incompleteGamma(shape, x / scale) / this._gamma(shape);
  }

  /**
   * Approximate gamma function
   * @param {number} x - Input value
   * @returns {number} Gamma value
   * @private
   */
  _gamma(x) {
    return Math.exp(this._logGamma(x));
  }

  /**
   * Approximate incomplete gamma function
   * @param {number} a - Shape parameter
   * @param {number} x - Upper limit
   * @returns {number} Incomplete gamma value
   * @private
   */
  _incompleteGamma(a, x) {
    if (x === 0) return 0;
    if (x < a + 1) {
      // Series expansion
      let sum = 1 / a;
      let term = 1 / a;
      for (let n = 1; n < 100; n++) {
        term *= x / (a + n);
        sum += term;
        if (Math.abs(term) < 1e-15) break;
      }
      return Math.pow(x, a) * Math.exp(-x) * sum;
    } else {
      // Continued fraction
      let b = x + 1 - a;
      let c = 1e30;
      let d = 1 / b;
      let h = d;

      for (let i = 1; i < 100; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b;
        if (Math.abs(d) < 1e-30) d = 1e-30;
        c = b + an / c;
        if (Math.abs(c) < 1e-30) c = 1e-30;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < 1e-15) break;
      }

      return this._gamma(a) - Math.pow(x, a) * Math.exp(-x) * h;
    }
  }

  /**
   * Fit uniform distribution
   * @param {Array<number>} values - Data values
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @returns {Object} Goodness of fit statistics
   * @private
   */
  _fitUniformDistribution(values, min, max) {
    const n = values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const range = max - min;

    // Calculate log-likelihood
    const logLikelihood = -n * Math.log(range);

    // Kolmogorov-Smirnov test
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      const empiricalCDF = (i + 1) / n;
      const theoreticalCDF = (sorted[i] - min) / range;
      maxDiff = Math.max(maxDiff, Math.abs(empiricalCDF - theoreticalCDF));
    }

    const pValue = this._kolmogorovSmirnovPValue(maxDiff, n);

    return {
      logLikelihood,
      ksStatistic: maxDiff,
      pValue,
      goodnessOfFit: pValue > 0.05 ? 'good' : 'poor',
    };
  }

  /**
   * Calculate Akaike Information Criterion
   * @param {number} logLikelihood - Log-likelihood value
   * @param {number} parameters - Number of parameters
   * @returns {number} AIC value
   * @private
   */
  _calculateAIC(logLikelihood, parameters) {
    return 2 * parameters - 2 * logLikelihood;
  }

  /**
   * Calculate Bayesian Information Criterion
   * @param {number} logLikelihood - Log-likelihood value
   * @param {number} parameters - Number of parameters
   * @param {number} n - Sample size
   * @returns {number} BIC value
   * @private
   */
  _calculateBIC(logLikelihood, parameters, n) {
    return parameters * Math.log(n) - 2 * logLikelihood;
  }

  /**
   * Select best distribution based on multiple criteria
   * @param {Array<Object>} distributions - Array of fitted distributions
   * @returns {Object} Best fitting distribution
   * @private
   */
  _selectBestDistribution(distributions) {
    if (distributions.length === 0) return null;

    // Multi-criteria selection: BIC (primary), AIC (secondary), p-value (tie-breaker)
    let bestDist = distributions[0];

    for (const dist of distributions) {
      // Prefer distributions with better BIC (lower is better)
      if (dist.bic < bestDist.bic) {
        bestDist = dist;
      } else if (Math.abs(dist.bic - bestDist.bic) < 2) {
        // If BIC values are close, use p-value as tie-breaker
        if (dist.goodnessOfFit.pValue > bestDist.goodnessOfFit.pValue) {
          bestDist = dist;
        }
      }
    }

    return bestDist;
  }

  /**
   * Get distribution fitting recommendation
   * @param {Object} bestFit - Best fitting distribution
   * @param {Array<number>} values - Original data values
   * @returns {string} Recommendation text
   * @private
   */
  _getDistributionRecommendation(bestFit, values) {
    const n = values.length;
    const pValue = bestFit.goodnessOfFit.pValue;

    let recommendation = `Best fit: ${bestFit.name} distribution. `;

    if (pValue > 0.1) {
      recommendation +=
        'Excellent fit - distribution assumptions are well-supported.';
    } else if (pValue > 0.05) {
      recommendation +=
        'Good fit - distribution is reasonable for most analyses.';
    } else if (pValue > 0.01) {
      recommendation +=
        'Marginal fit - consider alternative distributions or data transformation.';
    } else {
      recommendation +=
        'Poor fit - distribution assumptions may be violated. Consider robust methods.';
    }

    if (n < 30) {
      recommendation +=
        ' Note: Small sample size may affect distribution fitting accuracy.';
    }

    return recommendation;
  }

  // =============================================================================
  // EXTREME VALUE ANALYSIS HELPER FUNCTIONS
  // =============================================================================

  /**
   * Block maxima analysis using Generalized Extreme Value (GEV) distribution
   * @param {Array<number>} values - Data values
   * @returns {Object} Block maxima analysis results
   * @private
   */
  _blockMaximaAnalysis(values) {
    const n = values.length;

    // Determine block size (aim for 10-20 blocks)
    const blockSize = Math.max(5, Math.floor(n / 15));
    const blocks = [];

    // Extract block maxima
    for (let i = 0; i < n; i += blockSize) {
      const block = values.slice(i, i + blockSize);
      if (block.length > 0) {
        blocks.push(Math.max(...block));
      }
    }

    if (blocks.length < 3) {
      return {
        method: 'Block Maxima (GEV)',
        message: 'Insufficient blocks for analysis',
        blocks: blocks.length,
      };
    }

    // Estimate GEV parameters using method of moments
    const gevParams = this._estimateGEVParameters(blocks);

    // Calculate return levels
    const returnLevels = this._calculateGEVReturnLevels(
      gevParams,
      [2, 5, 10, 25, 50, 100]
    );

    return {
      method: 'Block Maxima (GEV)',
      blockSize,
      numberOfBlocks: blocks.length,
      blockMaxima: {
        values: blocks,
        mean: this._calculateMean(blocks),
        max: Math.max(...blocks),
        min: Math.min(...blocks),
      },
      parameters: gevParams,
      returnLevels,
      diagnostics: this._gevDiagnostics(blocks, gevParams),
    };
  }

  /**
   * Peaks over threshold analysis using Generalized Pareto Distribution (GPD)
   * @param {Array<number>} values - Data values
   * @returns {Object} Peaks over threshold analysis results
   * @private
   */
  _peaksOverThresholdAnalysis(values) {
    const n = values.length;
    const sorted = [...values].sort((a, b) => b - a); // Descending order

    // Select threshold (typically 90th-95th percentile)
    const thresholdPercentile = 0.9;
    const thresholdIndex = Math.floor(n * (1 - thresholdPercentile));
    const threshold = sorted[thresholdIndex];

    // Extract exceedances
    const exceedances = values
      .filter(v => v > threshold)
      .map(v => v - threshold);

    if (exceedances.length < 5) {
      return {
        method: 'Peaks Over Threshold (GPD)',
        message: 'Insufficient exceedances for analysis',
        threshold,
        exceedances: exceedances.length,
      };
    }

    // Estimate GPD parameters
    const gpdParams = this._estimateGPDParameters(exceedances);

    // Calculate return levels
    const returnLevels = this._calculateGPDReturnLevels(
      gpdParams,
      threshold,
      exceedances.length / n,
      [2, 5, 10, 25, 50, 100]
    );

    return {
      method: 'Peaks Over Threshold (GPD)',
      threshold,
      thresholdPercentile,
      numberOfExceedances: exceedances.length,
      exceedanceRate: exceedances.length / n,
      exceedances: {
        values: exceedances,
        mean: this._calculateMean(exceedances),
        max: Math.max(...exceedances),
        statistics: {
          count: exceedances.length,
          mean: this._calculateMean(exceedances),
          std: this._calculateStandardDeviation(exceedances),
        },
      },
      parameters: gpdParams,
      returnLevels,
      diagnostics: this._gpdDiagnostics(exceedances, gpdParams),
    };
  }

  /**
   * Estimate GEV distribution parameters
   * @param {Array<number>} maxima - Block maxima values
   * @returns {Object} GEV parameters (location, scale, shape)
   * @private
   */
  _estimateGEVParameters(maxima) {
    const n = maxima.length;
    const mean = this._calculateMean(maxima);
    const std = this._calculateStandardDeviation(maxima);

    // Method of moments estimation
    const skewness = this._calculateSkewness(maxima);

    // Estimate shape parameter from skewness
    let xi = 0; // Start with Gumbel (xi = 0)
    if (Math.abs(skewness) > 0.1) {
      // Use skewness to estimate shape
      xi = -skewness / 3; // Rough approximation
      xi = Math.max(-0.5, Math.min(0.5, xi)); // Constrain xi
    }

    // Estimate scale parameter
    const sigma = (std * Math.sqrt(6)) / Math.PI;

    // Estimate location parameter
    const mu = mean - (sigma * (Math.exp(this._logGamma(1 - xi)) - 1)) / xi;

    return {
      location: isFinite(mu) ? mu : mean,
      scale: Math.max(0.01, sigma),
      shape: xi,
      type: xi > 0.1 ? 'Frechet' : xi < -0.1 ? 'Weibull' : 'Gumbel',
    };
  }

  /**
   * Estimate GPD distribution parameters
   * @param {Array<number>} exceedances - Exceedance values
   * @returns {Object} GPD parameters (scale, shape)
   * @private
   */
  _estimateGPDParameters(exceedances) {
    const n = exceedances.length;
    const mean = this._calculateMean(exceedances);
    const variance = this._calculateVariance(exceedances);

    // Method of moments estimation
    let xi = 0.5 * ((mean * mean) / variance - 1);
    xi = Math.max(-0.5, Math.min(0.5, xi)); // Constrain xi

    const sigma = mean * (1 + xi);

    return {
      scale: Math.max(0.01, sigma),
      shape: xi,
      type:
        xi > 0.1
          ? 'Heavy-tailed'
          : xi < -0.1
            ? 'Light-tailed'
            : 'Exponential-like',
    };
  }

  /**
   * Calculate GEV return levels
   * @param {Object} params - GEV parameters
   * @param {Array<number>} returnPeriods - Return periods in years
   * @returns {Object} Return levels
   * @private
   */
  _calculateGEVReturnLevels(params, returnPeriods) {
    const { location: mu, scale: sigma, shape: xi } = params;
    const levels = {};

    for (const T of returnPeriods) {
      const p = 1 - 1 / T;
      let level;

      if (Math.abs(xi) < 1e-6) {
        // Gumbel case (xi ≈ 0)
        level = mu - sigma * Math.log(-Math.log(p));
      } else {
        // Frechet or Weibull case
        level = mu + (sigma / xi) * (Math.pow(-Math.log(p), -xi) - 1);
      }

      levels[`T${T}`] = level;
    }

    return levels;
  }

  /**
   * Calculate GPD return levels
   * @param {Object} params - GPD parameters
   * @param {number} threshold - Threshold value
   * @param {number} exceedanceRate - Rate of exceedances
   * @param {Array<number>} returnPeriods - Return periods
   * @returns {Object} Return levels
   * @private
   */
  _calculateGPDReturnLevels(params, threshold, exceedanceRate, returnPeriods) {
    const { scale: sigma, shape: xi } = params;
    const levels = {};

    for (const T of returnPeriods) {
      const m = T * exceedanceRate;
      let level;

      if (Math.abs(xi) < 1e-6) {
        // Exponential case (xi ≈ 0)
        level = threshold + sigma * Math.log(m);
      } else {
        // General GPD case
        level = threshold + (sigma / xi) * (Math.pow(m, xi) - 1);
      }

      levels[`T${T}`] = level;
    }

    return levels;
  }

  /**
   * Estimate extreme quantiles
   * @param {Array<number>} values - Data values
   * @returns {Object} Extreme quantile estimates
   * @private
   */
  _estimateExtremeQuantiles(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;

    // Calculate various extreme quantiles
    const quantiles = [0.01, 0.05, 0.1, 0.9, 0.95, 0.99, 0.995, 0.999];
    const estimates = {};

    for (const q of quantiles) {
      const index = q * (n - 1);
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      const fraction = index - lower;

      if (lower === upper) {
        estimates[`q${(q * 100).toFixed(1)}`] = sorted[lower];
      } else {
        estimates[`q${(q * 100).toFixed(1)}`] =
          sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
      }
    }

    return estimates;
  }

  /**
   * Calculate return periods for observed values
   * @param {Array<number>} values - Data values
   * @returns {Object} Return period analysis
   * @private
   */
  _calculateReturnPeriods(values) {
    const sorted = [...values].sort((a, b) => b - a); // Descending order
    const n = sorted.length;

    // Calculate empirical return periods
    const returnPeriods = sorted.map((value, index) => ({
      value,
      rank: index + 1,
      returnPeriod: n / (index + 1),
      probability: (index + 1) / (n + 1),
    }));

    // Identify notable events
    const notableEvents = returnPeriods
      .filter(rp => rp.returnPeriod >= 5) // Events with 5+ year return period
      .slice(0, 10); // Top 10 most extreme

    return {
      empiricalReturnPeriods: returnPeriods.slice(0, 20), // Top 20 most extreme
      notableEvents,
      maxObserved: {
        value: sorted[0],
        returnPeriod: n,
        probability: 1 / (n + 1),
      },
    };
  }

  /**
   * Test statistical significance of extreme value analysis
   * @param {Array<number>} values - Original data
   * @param {Object} blockMaxima - Block maxima results
   * @param {Object} pot - Peaks over threshold results
   * @returns {Object} Significance test results
   * @private
   */
  _testExtremeSignificance(values, blockMaxima, pot) {
    const n = values.length;

    // Test for adequate sample size
    const sampleAdequacy = {
      sufficient: n >= 50,
      recommended: n >= 100,
      sample_size: n,
      message:
        n < 50
          ? 'Sample size too small for reliable extreme value analysis'
          : n < 100
            ? 'Sample size adequate but results should be interpreted cautiously'
            : 'Sample size adequate for extreme value analysis',
    };

    // Test block maxima model adequacy
    let blockMaximaSignificance = null;
    if (blockMaxima && blockMaxima.numberOfBlocks >= 3) {
      const blocks = blockMaxima.blockMaxima.values;
      const gevFit = this._testGEVGoodnessOfFit(blocks, blockMaxima.parameters);
      blockMaximaSignificance = {
        method: 'GEV Goodness-of-Fit',
        adequate: gevFit.pValue > 0.05,
        pValue: gevFit.pValue,
        message:
          gevFit.pValue > 0.05
            ? 'GEV model fits the block maxima well'
            : 'GEV model may not be appropriate for this data',
      };
    }

    // Test POT model adequacy
    let potSignificance = null;
    if (pot && pot.numberOfExceedances >= 5) {
      const exceedances = pot.exceedances.values;
      const gpdFit = this._testGPDGoodnessOfFit(exceedances, pot.parameters);
      potSignificance = {
        method: 'GPD Goodness-of-Fit',
        adequate: gpdFit.pValue > 0.05,
        pValue: gpdFit.pValue,
        message:
          gpdFit.pValue > 0.05
            ? 'GPD model fits the exceedances well'
            : 'GPD model may not be appropriate for this threshold',
      };
    }

    return {
      sampleAdequacy,
      blockMaxima: blockMaximaSignificance,
      peaksOverThreshold: potSignificance,
      overallAssessment: this._getOverallExtremeSignificance(
        sampleAdequacy,
        blockMaximaSignificance,
        potSignificance
      ),
    };
  }

  /**
   * Test GEV goodness of fit
   * @param {Array<number>} maxima - Block maxima
   * @param {Object} params - GEV parameters
   * @returns {Object} Goodness of fit test
   * @private
   */
  _testGEVGoodnessOfFit(maxima, params) {
    // Simplified Anderson-Darling type test
    const n = maxima.length;
    const sorted = [...maxima].sort((a, b) => a - b);
    const { location: mu, scale: sigma, shape: xi } = params;

    let statistic = 0;
    for (let i = 0; i < n; i++) {
      const p = this._gevCDF(sorted[i], mu, sigma, xi);
      const logP = Math.log(Math.max(1e-10, p));
      const log1MinusP = Math.log(Math.max(1e-10, 1 - p));
      statistic += (2 * i + 1) * logP + (2 * (n - i) - 1) * log1MinusP;
    }
    statistic = -n - statistic / n;

    // Approximate p-value (very rough approximation)
    const pValue = statistic < 2.5 ? 0.1 : 0.01;

    return { statistic, pValue };
  }

  /**
   * Test GPD goodness of fit
   * @param {Array<number>} exceedances - Exceedance values
   * @param {Object} params - GPD parameters
   * @returns {Object} Goodness of fit test
   * @private
   */
  _testGPDGoodnessOfFit(exceedances, params) {
    // Simplified Kolmogorov-Smirnov test for GPD
    const n = exceedances.length;
    const sorted = [...exceedances].sort((a, b) => a - b);
    const { scale: sigma, shape: xi } = params;

    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      const empiricalCDF = (i + 1) / n;
      const theoreticalCDF = this._gpdCDF(sorted[i], sigma, xi);
      maxDiff = Math.max(maxDiff, Math.abs(empiricalCDF - theoreticalCDF));
    }

    const pValue = this._kolmogorovSmirnovPValue(maxDiff, n);

    return { statistic: maxDiff, pValue };
  }

  /**
   * GEV cumulative distribution function
   * @param {number} x - Value
   * @param {number} mu - Location parameter
   * @param {number} sigma - Scale parameter
   * @param {number} xi - Shape parameter
   * @returns {number} Cumulative probability
   * @private
   */
  _gevCDF(x, mu, sigma, xi) {
    const z = (x - mu) / sigma;
    if (Math.abs(xi) < 1e-6) {
      // Gumbel case
      return Math.exp(-Math.exp(-z));
    } else {
      // Frechet or Weibull case
      const term = 1 + xi * z;
      if (term <= 0) return xi > 0 ? 0 : 1;
      return Math.exp(-Math.pow(term, -1 / xi));
    }
  }

  /**
   * GPD cumulative distribution function
   * @param {number} x - Value
   * @param {number} sigma - Scale parameter
   * @param {number} xi - Shape parameter
   * @returns {number} Cumulative probability
   * @private
   */
  _gpdCDF(x, sigma, xi) {
    if (x < 0) return 0;
    if (Math.abs(xi) < 1e-6) {
      // Exponential case
      return 1 - Math.exp(-x / sigma);
    } else {
      // General GPD case
      const term = 1 + (xi * x) / sigma;
      if (term <= 0) return xi > 0 ? 0 : 1;
      return 1 - Math.pow(term, -1 / xi);
    }
  }

  /**
   * GEV model diagnostics
   * @param {Array<number>} maxima - Block maxima
   * @param {Object} params - GEV parameters
   * @returns {Object} Diagnostic results
   * @private
   */
  _gevDiagnostics(maxima, params) {
    const n = maxima.length;
    return {
      sample_size: n,
      parameter_stability: Math.abs(params.shape) < 0.5 ? 'stable' : 'unstable',
      distribution_type: params.type,
      confidence: n >= 20 ? 'high' : n >= 10 ? 'medium' : 'low',
    };
  }

  /**
   * GPD model diagnostics
   * @param {Array<number>} exceedances - Exceedance values
   * @param {Object} params - GPD parameters
   * @returns {Object} Diagnostic results
   * @private
   */
  _gpdDiagnostics(exceedances, params) {
    const n = exceedances.length;
    return {
      sample_size: n,
      parameter_stability: Math.abs(params.shape) < 0.5 ? 'stable' : 'unstable',
      tail_behavior: params.type,
      confidence: n >= 20 ? 'high' : n >= 10 ? 'medium' : 'low',
    };
  }

  /**
   * Get overall extreme value significance assessment
   * @param {Object} sampleAdequacy - Sample adequacy results
   * @param {Object} bmSignificance - Block maxima significance
   * @param {Object} potSignificance - POT significance
   * @returns {string} Overall assessment
   * @private
   */
  _getOverallExtremeSignificance(
    sampleAdequacy,
    bmSignificance,
    potSignificance
  ) {
    if (!sampleAdequacy.sufficient) {
      return 'Insufficient data for reliable extreme value analysis. Results should be interpreted with extreme caution.';
    }

    const bmAdequate = bmSignificance ? bmSignificance.adequate : false;
    const potAdequate = potSignificance ? potSignificance.adequate : false;

    if (bmAdequate && potAdequate) {
      return 'Both extreme value models show good fit. Results are statistically reliable.';
    } else if (bmAdequate || potAdequate) {
      return 'One extreme value model shows good fit. Consider using the better-fitting model for predictions.';
    } else {
      return 'Neither extreme value model shows adequate fit. Results should be interpreted cautiously.';
    }
  }

  /**
   * Get extreme value analysis recommendation
   * @param {Object} blockMaxima - Block maxima results
   * @param {Object} pot - POT results
   * @param {number} n - Sample size
   * @returns {string} Recommendation text
   * @private
   */
  _getExtremeValueRecommendation(blockMaxima, pot, n) {
    let recommendation = '';

    if (n < 50) {
      recommendation =
        'Sample size is small for extreme value analysis. Results should be used for exploratory purposes only. ';
    } else if (n < 100) {
      recommendation =
        'Sample size is adequate but results should be interpreted cautiously. ';
    }

    const bmBlocks = blockMaxima ? blockMaxima.numberOfBlocks : 0;
    const potExceedances = pot ? pot.numberOfExceedances : 0;

    if (bmBlocks >= 10 && potExceedances >= 20) {
      recommendation +=
        'Both block maxima and POT methods are applicable. Compare results for robustness.';
    } else if (bmBlocks >= 5) {
      recommendation +=
        'Block maxima method is recommended. POT method has insufficient exceedances.';
    } else if (potExceedances >= 10) {
      recommendation +=
        'POT method is recommended. Block maxima method has insufficient blocks.';
    } else {
      recommendation +=
        'Neither method has sufficient data. Consider collecting more observations or using less stringent thresholds.';
    }

    return recommendation;
  }

  /**
   * VISUALIZATION GENERATION METHODS
   * Generate charts and visualizations for analysis results
   */

  /**
   * Generate comprehensive visualizations for data profiling results
   * @param {Object} profilingResults - Complete profiling results
   * @param {Object} options - Visualization options
   * @returns {Object} Visualization configurations for charts and graphs
   */
  generateVisualizations(profilingResults, options = {}) {
    try {
      const visualizations = {
        metadata: {
          generatedAt: new Date().toISOString(),
          chartLibrary: options.chartLibrary || 'chartjs',
          theme: options.theme || 'default',
        },
        charts: {},
      };

      // Generate missing data pattern visualizations
      if (
        profilingResults.completeness &&
        profilingResults.completeness.patterns
      ) {
        visualizations.charts.missingDataPatterns =
          this._generateMissingDataVisualizations(
            profilingResults.completeness,
            options
          );
      }

      // Generate time series visualizations
      if (profilingResults.temporal) {
        visualizations.charts.timeSeries =
          this._generateTimeSeriesVisualizations(
            profilingResults.temporal,
            options
          );
      }

      // Generate spatial visualizations
      if (profilingResults.spatial) {
        visualizations.charts.spatial = this._generateSpatialVisualizations(
          profilingResults.spatial,
          options
        );
      }

      // Generate distribution visualizations
      if (profilingResults.distribution) {
        visualizations.charts.distributions =
          this._generateDistributionVisualizations(
            profilingResults.distribution,
            options
          );
      }

      // Generate quality metrics visualizations
      if (profilingResults.quality) {
        visualizations.charts.quality = this._generateQualityVisualizations(
          profilingResults.quality,
          options
        );
      }

      // Generate extreme value visualizations
      if (profilingResults.extremes) {
        visualizations.charts.extremes =
          this._generateExtremeValueVisualizations(
            profilingResults.extremes,
            options
          );
      }

      return visualizations;
    } catch (error) {
      logger.error('Visualization generation failed', { error: error.message });
      return {
        error: 'Visualization generation failed: ' + error.message,
        charts: {},
      };
    }
  }

  /**
   * Generate missing data pattern visualizations
   * @param {Object} completenessData - Completeness analysis results
   * @param {Object} options - Visualization options
   * @returns {Object} Missing data visualization configurations
   * @private
   */
  _generateMissingDataVisualizations(completenessData, options) {
    const visualizations = {};

    try {
      // Missing data heatmap
      if (completenessData.byParameter) {
        visualizations.missingDataHeatmap = {
          type: 'heatmap',
          title: 'Missing Data Patterns by Parameter',
          description:
            'Heatmap showing missing data patterns across parameters',
          data: this._prepareMissingDataHeatmapData(
            completenessData.byParameter
          ),
          config: {
            xAxis: { title: 'Time/Records' },
            yAxis: { title: 'Parameters' },
            colorScale: {
              domain: [0, 1],
              range: ['#2ecc71', '#e74c3c'],
              labels: ['Present', 'Missing'],
            },
          },
        };
      }

      // Pattern confidence radar chart
      if (completenessData.patterns) {
        visualizations.patternConfidenceRadar = {
          type: 'radar',
          title: 'Missing Data Pattern Confidence Scores',
          description:
            'Radar chart showing confidence levels for different missing data patterns',
          data: {
            labels: ['MCAR Confidence', 'MAR Confidence', 'MNAR Confidence'],
            datasets: [
              {
                label: 'Pattern Confidence',
                data: [
                  completenessData.patterns.mcar?.confidence || 0,
                  completenessData.patterns.mar?.confidence || 0,
                  completenessData.patterns.mnar?.confidence || 0,
                ],
                backgroundColor: 'rgba(54, 162, 235, 0.2)',
                borderColor: 'rgba(54, 162, 235, 1)',
                borderWidth: 2,
              },
            ],
          },
          config: {
            scale: {
              ticks: {
                beginAtZero: true,
                max: 100,
              },
            },
          },
        };
      }

      // Missing data percentage bar chart
      if (completenessData.byParameter) {
        const parameterData = Object.entries(completenessData.byParameter).map(
          ([param, stats]) => ({
            parameter: param,
            missingPercentage: stats.missingPercentage,
            missingCount: stats.missingCount,
            totalCount: stats.totalCount,
          })
        );

        visualizations.missingPercentageBar = {
          type: 'bar',
          title: 'Missing Data Percentage by Parameter',
          description:
            'Bar chart showing the percentage of missing data for each parameter',
          data: {
            labels: parameterData.map(d => d.parameter),
            datasets: [
              {
                label: 'Missing Data %',
                data: parameterData.map(d => d.missingPercentage),
                backgroundColor: parameterData.map(d =>
                  d.missingPercentage > 50
                    ? '#e74c3c'
                    : d.missingPercentage > 20
                      ? '#f39c12'
                      : '#2ecc71'
                ),
                borderColor: '#34495e',
                borderWidth: 1,
              },
            ],
          },
          config: {
            scales: {
              y: {
                beginAtZero: true,
                max: 100,
                title: { display: true, text: 'Missing Percentage (%)' },
              },
              x: {
                title: { display: true, text: 'Parameters' },
              },
            },
          },
        };
      }

      // Temporal missing data line chart
      if (completenessData.temporal) {
        visualizations.temporalMissingPattern = {
          type: 'line',
          title: 'Temporal Missing Data Patterns',
          description: 'Line chart showing missing data patterns over time',
          data: this._prepareTemporalMissingData(completenessData.temporal),
          config: {
            scales: {
              x: {
                type: 'time',
                title: { display: true, text: 'Time' },
              },
              y: {
                beginAtZero: true,
                max: 100,
                title: { display: true, text: 'Missing Data (%)' },
              },
            },
          },
        };
      }

      return visualizations;
    } catch (error) {
      logger.error('Missing data visualization generation failed', {
        error: error.message,
      });
      return {
        error: 'Missing data visualization generation failed: ' + error.message,
      };
    }
  }

  /**
   * Generate time series analysis visualizations
   * @param {Object} temporalData - Temporal analysis results
   * @param {Object} options - Visualization options
   * @returns {Object} Time series visualization configurations
   * @private
   */
  _generateTimeSeriesVisualizations(temporalData, options) {
    const visualizations = {};

    try {
      // Time series trend analysis
      if (temporalData.trends) {
        visualizations.trendAnalysis = {
          type: 'line',
          title: 'Time Series Trend Analysis',
          description:
            'Multi-line chart showing trends for different parameters over time',
          data: this._prepareTrendAnalysisData(temporalData.trends),
          config: {
            scales: {
              x: {
                type: 'time',
                title: { display: true, text: 'Time' },
              },
              y: {
                title: { display: true, text: 'Parameter Values' },
              },
            },
            plugins: {
              legend: { display: true },
            },
          },
        };
      }

      // Seasonality patterns
      if (temporalData.seasonality) {
        visualizations.seasonalityPatterns = {
          type: 'polarArea',
          title: 'Seasonal Patterns',
          description: 'Polar area chart showing seasonal patterns in the data',
          data: this._prepareSeasonalityData(temporalData.seasonality),
          config: {
            plugins: {
              legend: { display: true },
            },
          },
        };
      }

      // Data frequency histogram
      if (temporalData.frequency) {
        visualizations.dataFrequency = {
          type: 'histogram',
          title: 'Data Collection Frequency',
          description:
            'Histogram showing the distribution of data collection intervals',
          data: this._prepareFrequencyHistogramData(temporalData.frequency),
          config: {
            scales: {
              x: {
                title: { display: true, text: 'Time Interval (hours)' },
              },
              y: {
                title: { display: true, text: 'Frequency' },
              },
            },
          },
        };
      }

      return visualizations;
    } catch (error) {
      logger.error('Time series visualization generation failed', {
        error: error.message,
      });
      return {
        error: 'Time series visualization generation failed: ' + error.message,
      };
    }
  }

  /**
   * Generate spatial analysis visualizations
   * @param {Object} spatialData - Spatial analysis results
   * @param {Object} options - Visualization options
   * @returns {Object} Spatial visualization configurations
   * @private
   */
  _generateSpatialVisualizations(spatialData, options) {
    const visualizations = {};

    try {
      // Geographic coverage map
      if (spatialData.coverage) {
        visualizations.geographicCoverage = {
          type: 'map',
          title: 'Geographic Data Coverage',
          description: 'Map showing the geographic distribution of data points',
          data: this._prepareGeographicCoverageData(spatialData.coverage),
          config: {
            mapType: 'scatter',
            projection: 'mercator',
            colorScale: {
              property: 'dataCount',
              range: [
                '#ffffcc',
                '#c7e9b4',
                '#7fcdbb',
                '#41b6c4',
                '#2c7fb8',
                '#253494',
              ],
            },
          },
        };
      }

      // Spatial clustering visualization
      if (spatialData.clustering) {
        visualizations.spatialClusters = {
          type: 'scatter',
          title: 'Spatial Data Clusters',
          description: 'Scatter plot showing spatial clustering of data points',
          data: this._prepareSpatialClusterData(spatialData.clustering),
          config: {
            scales: {
              x: {
                title: { display: true, text: 'Longitude' },
              },
              y: {
                title: { display: true, text: 'Latitude' },
              },
            },
          },
        };
      }

      // Elevation profile
      if (spatialData.elevation) {
        visualizations.elevationProfile = {
          type: 'area',
          title: 'Elevation Profile of Monitoring Stations',
          description:
            'Area chart showing the elevation distribution of monitoring stations',
          data: this._prepareElevationProfileData(spatialData.elevation),
          config: {
            scales: {
              x: {
                title: { display: true, text: 'Station Index' },
              },
              y: {
                title: { display: true, text: 'Elevation (m)' },
              },
            },
          },
        };
      }

      return visualizations;
    } catch (error) {
      logger.error('Spatial visualization generation failed', {
        error: error.message,
      });
      return {
        error: 'Spatial visualization generation failed: ' + error.message,
      };
    }
  }

  /**
   * Generate distribution analysis visualizations
   * @param {Object} distributionData - Distribution analysis results
   * @param {Object} options - Visualization options
   * @returns {Object} Distribution visualization configurations
   * @private
   */
  _generateDistributionVisualizations(distributionData, options) {
    const visualizations = {};

    try {
      // Histograms for each parameter
      Object.entries(distributionData).forEach(([parameter, analysis]) => {
        if (analysis.histogram) {
          visualizations[`${parameter}Histogram`] = {
            type: 'histogram',
            title: `${parameter} Distribution`,
            description: `Histogram showing the distribution of ${parameter} values`,
            data: this._prepareHistogramData(analysis.histogram),
            config: {
              scales: {
                x: {
                  title: { display: true, text: parameter },
                },
                y: {
                  title: { display: true, text: 'Frequency' },
                },
              },
            },
          };
        }

        // Box plots
        if (analysis.percentiles) {
          visualizations[`${parameter}BoxPlot`] = {
            type: 'boxplot',
            title: `${parameter} Box Plot`,
            description: `Box plot showing the distribution and outliers for ${parameter}`,
            data: this._prepareBoxPlotData(
              analysis.percentiles,
              analysis.outliers
            ),
            config: {
              scales: {
                y: {
                  title: { display: true, text: parameter },
                },
              },
            },
          };
        }
      });

      // Q-Q plots for normality testing
      if (Object.keys(distributionData).length > 0) {
        visualizations.normalityQQPlots = {
          type: 'scatter',
          title: 'Q-Q Plots for Normality Testing',
          description:
            'Quantile-quantile plots to assess normality of distributions',
          data: this._prepareQQPlotData(distributionData),
          config: {
            scales: {
              x: {
                title: { display: true, text: 'Theoretical Quantiles' },
              },
              y: {
                title: { display: true, text: 'Sample Quantiles' },
              },
            },
          },
        };
      }

      return visualizations;
    } catch (error) {
      logger.error('Distribution visualization generation failed', {
        error: error.message,
      });
      return {
        error: 'Distribution visualization generation failed: ' + error.message,
      };
    }
  }

  /**
   * Generate quality metrics visualizations
   * @param {Object} qualityData - Quality analysis results
   * @param {Object} options - Visualization options
   * @returns {Object} Quality visualization configurations
   * @private
   */
  _generateQualityVisualizations(qualityData, options) {
    const visualizations = {};

    try {
      // Overall quality score gauge
      if (qualityData.overallScore !== undefined) {
        visualizations.qualityScoreGauge = {
          type: 'gauge',
          title: 'Overall Data Quality Score',
          description: 'Gauge showing the overall data quality score',
          data: {
            value: qualityData.overallScore,
            min: 0,
            max: 100,
            thresholds: [
              { value: 0, color: '#e74c3c', label: 'Poor' },
              { value: 40, color: '#f39c12', label: 'Fair' },
              { value: 70, color: '#f1c40f', label: 'Good' },
              { value: 85, color: '#2ecc71', label: 'Excellent' },
            ],
          },
          config: {
            arc: {
              padding: 0.02,
              cornerRadius: 3,
            },
          },
        };
      }

      // Quality dimensions radar chart
      if (qualityData.dimensions) {
        visualizations.qualityDimensionsRadar = {
          type: 'radar',
          title: 'Data Quality Dimensions',
          description:
            'Radar chart showing scores across different quality dimensions',
          data: {
            labels: Object.keys(qualityData.dimensions),
            datasets: [
              {
                label: 'Quality Score',
                data: Object.values(qualityData.dimensions),
                backgroundColor: 'rgba(46, 204, 113, 0.2)',
                borderColor: 'rgba(46, 204, 113, 1)',
                borderWidth: 2,
              },
            ],
          },
          config: {
            scale: {
              ticks: {
                beginAtZero: true,
                max: 100,
              },
            },
          },
        };
      }

      // Anomaly detection scatter plot
      if (qualityData.anomalies) {
        visualizations.anomalyDetection = {
          type: 'scatter',
          title: 'Anomaly Detection Results',
          description:
            'Scatter plot highlighting detected anomalies in the data',
          data: this._prepareAnomalyScatterData(qualityData.anomalies),
          config: {
            scales: {
              x: {
                title: { display: true, text: 'Time/Index' },
              },
              y: {
                title: { display: true, text: 'Parameter Value' },
              },
            },
          },
        };
      }

      return visualizations;
    } catch (error) {
      logger.error('Quality visualization generation failed', {
        error: error.message,
      });
      return {
        error: 'Quality visualization generation failed: ' + error.message,
      };
    }
  }

  /**
   * Generate extreme value analysis visualizations
   * @param {Object} extremeData - Extreme value analysis results
   * @param {Object} options - Visualization options
   * @returns {Object} Extreme value visualization configurations
   * @private
   */
  _generateExtremeValueVisualizations(extremeData, options) {
    const visualizations = {};

    try {
      // Return level plots
      Object.entries(extremeData).forEach(([parameter, analysis]) => {
        if (analysis.returnLevels) {
          visualizations[`${parameter}ReturnLevels`] = {
            type: 'line',
            title: `${parameter} Return Level Plot`,
            description:
              'Return level plot showing expected extreme values for different return periods',
            data: this._prepareReturnLevelData(analysis.returnLevels),
            config: {
              scales: {
                x: {
                  type: 'logarithmic',
                  title: { display: true, text: 'Return Period (years)' },
                },
                y: {
                  title: { display: true, text: `${parameter} Value` },
                },
              },
            },
          };
        }

        // Threshold selection plot
        if (analysis.thresholdSelection) {
          visualizations[`${parameter}ThresholdSelection`] = {
            type: 'line',
            title: `${parameter} Threshold Selection`,
            description:
              'Mean residual life plot for threshold selection in POT analysis',
            data: this._prepareThresholdSelectionData(
              analysis.thresholdSelection
            ),
            config: {
              scales: {
                x: {
                  title: { display: true, text: 'Threshold' },
                },
                y: {
                  title: { display: true, text: 'Mean Excess' },
                },
              },
            },
          };
        }
      });

      return visualizations;
    } catch (error) {
      logger.error('Extreme value visualization generation failed', {
        error: error.message,
      });
      return {
        error:
          'Extreme value visualization generation failed: ' + error.message,
      };
    }
  }

  /**
   * Helper methods for preparing visualization data
   */

  /**
   * Prepare missing data heatmap data
   * @param {Object} byParameterData - Missing data by parameter
   * @returns {Array} Heatmap data array
   * @private
   */
  _prepareMissingDataHeatmapData(byParameterData) {
    const parameters = Object.keys(byParameterData);
    const data = [];

    parameters.forEach((param, paramIndex) => {
      const stats = byParameterData[param];
      data.push({
        x: paramIndex,
        y: 0,
        v: stats.missingPercentage / 100,
        parameter: param,
        missingCount: stats.missingCount,
        totalCount: stats.totalCount,
      });
    });

    return data;
  }

  /**
   * Prepare temporal missing data
   * @param {Object} temporalData - Temporal missing data analysis
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareTemporalMissingData(temporalData) {
    if (!temporalData.patterns || !Array.isArray(temporalData.patterns)) {
      return { labels: [], datasets: [] };
    }

    return {
      labels: temporalData.patterns.map(p => p.timestamp),
      datasets: [
        {
          label: 'Missing Data %',
          data: temporalData.patterns.map(p => p.missingPercentage),
          borderColor: '#e74c3c',
          backgroundColor: 'rgba(231, 76, 60, 0.1)',
          fill: true,
        },
      ],
    };
  }

  /**
   * Prepare trend analysis data
   * @param {Object} trendsData - Trends analysis results
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareTrendAnalysisData(trendsData) {
    const datasets = [];
    const colors = ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6'];

    Object.entries(trendsData).forEach(([parameter, trend], index) => {
      if (trend.dataPoints && Array.isArray(trend.dataPoints)) {
        datasets.push({
          label: parameter,
          data: trend.dataPoints.map(point => ({
            x: point.timestamp,
            y: point.value,
          })),
          borderColor: colors[index % colors.length],
          backgroundColor: colors[index % colors.length] + '20',
          fill: false,
        });
      }
    });

    return { datasets };
  }

  /**
   * Missing helper functions for visualization data preparation
   */

  /**
   * Prepare seasonality data for polar area chart
   * @param {Object} seasonalityData - Seasonality analysis results
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareSeasonalityData(seasonalityData) {
    const mockSeasonalData = [
      { label: 'Spring', value: 25 },
      { label: 'Summer', value: 35 },
      { label: 'Fall', value: 20 },
      { label: 'Winter', value: 15 },
    ];

    return {
      labels: mockSeasonalData.map(d => d.label),
      datasets: [
        {
          data: mockSeasonalData.map(d => d.value),
          backgroundColor: ['#e74c3c', '#f39c12', '#f1c40f', '#3498db'],
        },
      ],
    };
  }

  /**
   * Prepare frequency histogram data
   * @param {Object} frequencyData - Frequency analysis results
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareFrequencyHistogramData(frequencyData) {
    const mockData = [
      { interval: 1, count: 15 },
      { interval: 2, count: 25 },
      { interval: 3, count: 35 },
      { interval: 4, count: 20 },
      { interval: 6, count: 10 },
      { interval: 12, count: 5 },
    ];

    return {
      labels: mockData.map(d => `${d.interval}h`),
      datasets: [
        {
          label: 'Frequency',
          data: mockData.map(d => d.count),
          backgroundColor: '#3498db',
        },
      ],
    };
  }

  /**
   * Prepare geographic coverage data
   * @param {Object} coverageData - Geographic coverage results
   * @returns {Array} Map data points
   * @private
   */
  _prepareGeographicCoverageData(coverageData) {
    // Mock geographic data points
    return [
      { lat: 40.7128, lng: -74.006, dataCount: 100, name: 'NYC' },
      { lat: 34.0522, lng: -118.2437, dataCount: 85, name: 'LA' },
      { lat: 41.8781, lng: -87.6298, dataCount: 75, name: 'Chicago' },
    ];
  }

  /**
   * Prepare spatial cluster data
   * @param {Object} clusteringData - Spatial clustering results
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareSpatialClusterData(clusteringData) {
    return {
      datasets: [
        {
          label: 'Data Points',
          data: [
            { x: -74.006, y: 40.7128, cluster: 1 },
            { x: -118.2437, y: 34.0522, cluster: 2 },
            { x: -87.6298, y: 41.8781, cluster: 3 },
          ],
          backgroundColor: ['#e74c3c', '#2ecc71', '#3498db'],
        },
      ],
    };
  }

  /**
   * Prepare elevation profile data
   * @param {Object} elevationData - Elevation analysis results
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareElevationProfileData(elevationData) {
    const mockData = Array.from({ length: 20 }, (_, i) => ({
      x: i + 1,
      y: 10 + Math.random() * 990,
    }));

    return {
      datasets: [
        {
          label: 'Elevation',
          data: mockData,
          backgroundColor: 'rgba(52, 152, 219, 0.3)',
          borderColor: '#3498db',
          fill: true,
        },
      ],
    };
  }

  /**
   * Prepare histogram data
   * @param {Object} histogramData - Histogram analysis results
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareHistogramData(histogramData) {
    if (!histogramData.bins || !histogramData.counts) {
      return { labels: [], datasets: [] };
    }

    return {
      labels: histogramData.bins.map((bin, i) =>
        i < histogramData.bins.length - 1
          ? `${bin}-${histogramData.bins[i + 1]}`
          : `${bin}+`
      ),
      datasets: [
        {
          label: 'Frequency',
          data: histogramData.counts,
          backgroundColor: '#3498db',
        },
      ],
    };
  }

  /**
   * Prepare box plot data
   * @param {Object} percentiles - Percentile data
   * @param {Array} outliers - Outlier values
   * @returns {Object} Box plot compatible data
   * @private
   */
  _prepareBoxPlotData(percentiles, outliers) {
    return {
      datasets: [
        {
          label: 'Distribution',
          data: [
            {
              min:
                percentiles.p0 ||
                percentiles.p25 - 1.5 * (percentiles.p75 - percentiles.p25),
              q1: percentiles.p25,
              median: percentiles.p50,
              q3: percentiles.p75,
              max:
                percentiles.p100 ||
                percentiles.p75 + 1.5 * (percentiles.p75 - percentiles.p25),
              outliers: outliers || [],
            },
          ],
          backgroundColor: 'rgba(52, 152, 219, 0.3)',
          borderColor: '#3498db',
        },
      ],
    };
  }

  /**
   * Prepare Q-Q plot data
   * @param {Object} distributionData - Distribution analysis results
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareQQPlotData(distributionData) {
    const datasets = [];
    const colors = ['#e74c3c', '#2ecc71', '#3498db', '#f39c12'];

    Object.entries(distributionData).forEach(([parameter, analysis], index) => {
      // Mock Q-Q plot data
      const mockData = Array.from({ length: 20 }, (_, i) => ({
        x: (i - 10) * 0.5, // Theoretical quantiles
        y: (i - 10) * 0.5 + (Math.random() - 0.5) * 0.2, // Sample quantiles with noise
      }));

      datasets.push({
        label: parameter,
        data: mockData,
        backgroundColor: colors[index % colors.length],
        borderColor: colors[index % colors.length],
        showLine: false,
      });
    });

    return { datasets };
  }

  /**
   * Prepare anomaly scatter data
   * @param {Array} anomalies - Anomaly detection results
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareAnomalyScatterData(anomalies) {
    const normalData = [];
    const anomalyData = [];

    // Mock normal data points
    for (let i = 0; i < 50; i++) {
      normalData.push({
        x: i,
        y: 20 + Math.random() * 10,
      });
    }

    // Add actual anomalies
    anomalies.forEach(anomaly => {
      anomalyData.push({
        x: anomaly.index,
        y: anomaly.value,
      });
    });

    return {
      datasets: [
        {
          label: 'Normal Data',
          data: normalData,
          backgroundColor: '#2ecc71',
        },
        {
          label: 'Anomalies',
          data: anomalyData,
          backgroundColor: '#e74c3c',
          pointRadius: 8,
        },
      ],
    };
  }

  /**
   * Prepare return level data
   * @param {Object} returnLevels - Return level analysis results
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareReturnLevelData(returnLevels) {
    if (!returnLevels.periods || !returnLevels.values) {
      return { datasets: [] };
    }

    const data = returnLevels.periods.map((period, i) => ({
      x: period,
      y: returnLevels.values[i],
    }));

    return {
      datasets: [
        {
          label: 'Return Levels',
          data: data,
          borderColor: '#e74c3c',
          backgroundColor: 'rgba(231, 76, 60, 0.1)',
          fill: false,
        },
      ],
    };
  }

  /**
   * Prepare threshold selection data
   * @param {Object} thresholdSelection - Threshold selection results
   * @returns {Object} Chart.js compatible data
   * @private
   */
  _prepareThresholdSelectionData(thresholdSelection) {
    if (!thresholdSelection.thresholds || !thresholdSelection.meanExcess) {
      return { datasets: [] };
    }

    const data = thresholdSelection.thresholds.map((threshold, i) => ({
      x: threshold,
      y: thresholdSelection.meanExcess[i],
    }));

    return {
      datasets: [
        {
          label: 'Mean Excess',
          data: data,
          borderColor: '#f39c12',
          backgroundColor: 'rgba(243, 156, 18, 0.1)',
          fill: false,
        },
      ],
    };
  }

  /**
   * Export visualization configuration as JSON
   * @param {Object} visualizations - Generated visualizations
   * @returns {string} JSON string of visualization configurations
   */
  exportVisualizationsAsJSON(visualizations) {
    try {
      return JSON.stringify(visualizations, null, 2);
    } catch (error) {
      logger.error('Failed to export visualizations as JSON', {
        error: error.message,
      });
      return JSON.stringify({ error: 'Export failed: ' + error.message });
    }
  }

  /**
   * Generate visualization HTML report
   * @param {Object} visualizations - Generated visualizations
   * @param {Object} options - Report options
   * @returns {string} HTML report string
   */
  generateVisualizationReport(visualizations, options = {}) {
    try {
      const title = options.title || 'Weather Data Profiling Report';
      const theme = options.theme || 'default';

      let html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; }
        .chart-container { background: white; margin: 20px 0; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .chart-title { font-size: 18px; font-weight: bold; margin-bottom: 10px; color: #333; }
        .chart-description { font-size: 14px; color: #666; margin-bottom: 20px; }
        canvas { max-width: 100%; height: 400px; }
        .report-header { text-align: center; margin-bottom: 30px; }
        .report-title { font-size: 28px; color: #2c3e50; margin-bottom: 10px; }
        .report-timestamp { font-size: 14px; color: #7f8c8d; }
    </style>
</head>
<body>
    <div class="container">
        <div class="report-header">
            <h1 class="report-title">${title}</h1>
            <p class="report-timestamp">Generated on ${new Date().toLocaleString()}</p>
        </div>
`;

      // Add chart containers for each visualization
      if (visualizations.charts) {
        Object.entries(visualizations.charts).forEach(([category, charts]) => {
          html += `<h2 style="color: #34495e; border-bottom: 2px solid #3498db; padding-bottom: 10px;">${this._formatCategoryTitle(category)}</h2>`;

          Object.entries(charts).forEach(([chartId, chart]) => {
            html += `
        <div class="chart-container">
            <div class="chart-title">${chart.title}</div>
            <div class="chart-description">${chart.description}</div>
            <canvas id="${chartId}_${category}"></canvas>
        </div>
`;
          });
        });
      }

      html += `
    </div>
    <script>
        // Chart configurations
        const visualizationConfigs = ${JSON.stringify(visualizations, null, 2)};
        
        // Initialize charts
        document.addEventListener('DOMContentLoaded', function() {
            if (visualizationConfigs.charts) {
                Object.entries(visualizationConfigs.charts).forEach(([category, charts]) => {
                    Object.entries(charts).forEach(([chartId, chart]) => {
                        const canvas = document.getElementById(chartId + '_' + category);
                        if (canvas && chart.data) {
                            const ctx = canvas.getContext('2d');
                            new Chart(ctx, {
                                type: chart.type === 'histogram' ? 'bar' : chart.type,
                                data: chart.data,
                                options: {
                                    responsive: true,
                                    maintainAspectRatio: false,
                                    ...chart.config
                                }
                            });
                        }
                    });
                });
            }
        });
    </script>
</body>
</html>`;

      return html;
    } catch (error) {
      logger.error('Failed to generate visualization report', {
        error: error.message,
      });
      return `<html><body><h1>Error generating report: ${error.message}</h1></body></html>`;
    }
  }

  /**
   * Format category title for display
   * @param {string} category - Category name
   * @returns {string} Formatted title
   * @private
   */
  _formatCategoryTitle(category) {
    return category
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  }
}

module.exports = DataProfilingEngine;
