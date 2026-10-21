/**
 * Risk Management System for ISO 22031 Compliance
 * Comprehensive risk identification, assessment, and mitigation
 */

const crypto = require('crypto');
const { securityLogger } = require('../server/utils/logger');

// Lazy-loaded database references for live data queries.
// We resolve these on first use so the module can still load even if
// the database layer is unavailable (e.g. during unit tests).
let _db = null;
let _schema = null;
let _drizzleOps = null;
let _dbInitAttempted = false;

function getDb() {
  if (!_dbInitAttempted) {
    _dbInitAttempted = true;
    try {
      _db = require('../database/connection').db || require('../database/connection').default;
      _schema = require('../shared/schema');
      _drizzleOps = require('drizzle-orm');
    } catch (err) {
      securityLogger.warn('Risk Management: database modules unavailable', {
        error: err.message,
      });
    }
  }
  return { db: _db, schema: _schema, ops: _drizzleOps };
}

class RiskManagementSystem {
  constructor() {
    this.riskRegistry = new Map();
    this.riskAssessments = new Map();
    this.mitigationStrategies = new Map();
    this.climateRisks = new Map();
    this.operationalRisks = new Map();
    this.auditLog = [];

    this.initializeRiskFramework();
  }

  // Initialize comprehensive risk framework
  initializeRiskFramework() {
    // Define risk categories
    this.riskCategories = {
      operational: 'Operational Risk',
      climate: 'Climate Risk',
      cybersecurity: 'Cybersecurity Risk',
      regulatory: 'Regulatory Compliance Risk',
      financial: 'Financial Risk',
      reputational: 'Reputational Risk',
      technology: 'Technology Risk',
      environmental: 'Environmental Risk',
    };

    // Risk severity levels
    this.severityLevels = {
      low: { score: 1, description: 'Minimal impact, unlikely occurrence' },
      medium: { score: 2, description: 'Moderate impact, possible occurrence' },
      high: { score: 3, description: 'Significant impact, likely occurrence' },
      critical: { score: 4, description: 'Severe impact, highly probable' },
      catastrophic: {
        score: 5,
        description: 'Catastrophic impact, certain occurrence',
      },
    };

    // Initialize default risk scenarios
    this.initializeDefaultRisks();
  }

  // Initialize default risk scenarios
  initializeDefaultRisks() {
    // Climate-specific risks
    this.registerRisk({
      id: 'CLIMATE_001',
      category: 'climate',
      title: 'Extreme Weather Events',
      description: 'Impact of severe weather on weather station operations',
      likelihood: 'medium',
      impact: 'high',
      riskScore: 6,
      mitigations: [
        'Redundant sensor networks',
        'Hardened equipment',
        'Emergency protocols',
      ],
    });

    this.registerRisk({
      id: 'CLIMATE_002',
      category: 'climate',
      title: 'Climate Data Quality Degradation',
      description:
        'Declining accuracy of climate data due to equipment failure',
      likelihood: 'low',
      impact: 'medium',
      riskScore: 2,
      mitigations: [
        'Regular calibration',
        'Quality monitoring',
        'Backup systems',
      ],
    });

    // Operational risks
    this.registerRisk({
      id: 'OPS_001',
      category: 'operational',
      title: 'System Downtime',
      description: 'Blockchain network or API service interruption',
      likelihood: 'medium',
      impact: 'high',
      riskScore: 6,
      mitigations: [
        'Load balancing',
        'Redundant infrastructure',
        'Monitoring systems',
      ],
    });

    // Cybersecurity risks
    this.registerRisk({
      id: 'CYBER_001',
      category: 'cybersecurity',
      title: 'Data Breach',
      description: 'Unauthorized access to sensitive user or climate data',
      likelihood: 'low',
      impact: 'critical',
      riskScore: 8,
      mitigations: ['Encryption', 'Access controls', 'Security monitoring'],
    });

    // Regulatory risks
    this.registerRisk({
      id: 'REG_001',
      category: 'regulatory',
      title: 'Compliance Violation',
      description: 'Failure to meet regulatory requirements (GDPR, financial)',
      likelihood: 'low',
      impact: 'high',
      riskScore: 3,
      mitigations: ['Regular audits', 'Compliance monitoring', 'Legal review'],
    });
  }

  // Register new risk
  registerRisk(riskData) {
    const risk = {
      id: riskData.id || crypto.randomUUID(),
      category: riskData.category,
      title: riskData.title,
      description: riskData.description,
      likelihood: riskData.likelihood,
      impact: riskData.impact,
      riskScore: this.calculateRiskScore(riskData.likelihood, riskData.impact),
      mitigations: riskData.mitigations || [],
      status: 'active',
      owner: riskData.owner || 'risk_team',
      createdAt: new Date().toISOString(),
      lastAssessed: new Date().toISOString(),
      nextReview: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    };

    this.riskRegistry.set(risk.id, risk);
    this.logRiskActivity('risk_registered', {
      riskId: risk.id,
      category: risk.category,
    });

    return risk;
  }

  // Conduct comprehensive risk assessment
  async conductRiskAssessment(scope = 'full') {
    const assessmentId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const assessment = {
      id: assessmentId,
      scope,
      timestamp,
      risks: [],
      overallRiskScore: 0,
      riskProfile: {},
      recommendations: [],
      mitigationPlan: {},
    };

    // Assess all registered risks concurrently
    const riskEntries = [...this.riskRegistry.values()];
    const CONCURRENCY_LIMIT = 10;
    for (let i = 0; i < riskEntries.length; i += CONCURRENCY_LIMIT) {
      const batch = riskEntries.slice(i, i + CONCURRENCY_LIMIT);
      const batchResults = await Promise.all(
        batch.map(risk => this.assessIndividualRisk(risk))
      );
      assessment.risks.push(...batchResults);
    }

    // Climate-specific risk assessment
    if (scope === 'full' || scope === 'climate') {
      const climateRisks = await this.assessClimateRisks();
      assessment.risks.push(...climateRisks);
    }

    // Calculate overall risk metrics
    assessment.overallRiskScore = this.calculateOverallRiskScore(
      assessment.risks
    );
    assessment.riskProfile = this.generateRiskProfile(assessment.risks);
    assessment.recommendations = await this.generateRecommendations(
      assessment.risks
    );
    assessment.mitigationPlan = await this.createMitigationPlan(
      assessment.risks
    );

    this.riskAssessments.set(assessmentId, assessment);
    this.logRiskActivity('risk_assessment_completed', {
      assessmentId,
      scope,
      overallScore: assessment.overallRiskScore,
    });

    return assessment;
  }

  // Assess individual risk
  async assessIndividualRisk(risk) {
    const currentDate = new Date();
    const daysSinceLastAssessment = Math.floor(
      (currentDate - new Date(risk.lastAssessed)) / (1000 * 60 * 60 * 24)
    );

    // Update risk based on current conditions
    const updatedRisk = await this.updateRiskParameters(risk);

    // Calculate current risk level
    const currentRiskScore = this.calculateRiskScore(
      updatedRisk.likelihood,
      updatedRisk.impact
    );

    // Assess mitigation effectiveness
    const mitigationEffectiveness =
      await this.assessMitigationEffectiveness(updatedRisk);

    // Calculate residual risk
    const residualRisk = this.calculateResidualRisk(
      currentRiskScore,
      mitigationEffectiveness
    );

    return {
      riskId: risk.id,
      title: risk.title,
      category: risk.category,
      currentRiskScore,
      residualRisk,
      mitigationEffectiveness,
      trend: await this.calculateRiskTrend(
        risk.id,
        residualRisk,
        risk.category
      ),
      recommendation: await this.generateRiskRecommendation(
        updatedRisk,
        residualRisk
      ),
      lastAssessed: currentDate.toISOString(),
      nextReview: new Date(
        Date.now() + this.getReviewInterval(risk.category) * 24 * 60 * 60 * 1000
      ).toISOString(),
    };
  }

  // Assess climate-specific risks
  async assessClimateRisks() {
    const climateRisks = [];

    // Weather station network risks
    const stationRisk = await this.assessWeatherStationRisks();
    climateRisks.push(stationRisk);

    // Climate data quality risks
    const dataQualityRisk = await this.assessClimateDataQuality();
    climateRisks.push(dataQualityRisk);

    // Carbon credit verification risks
    const carbonRisk = await this.assessCarbonCreditRisks();
    climateRisks.push(carbonRisk);

    // Environmental impact risks
    const environmentalRisk = await this.assessEnvironmentalImpactRisks();
    climateRisks.push(environmentalRisk);

    return climateRisks;
  }

  // Assess weather station network risks
  async assessWeatherStationRisks() {
    const { db, schema, ops } = getDb();

    let totalStations;
    let offlineStations;
    let dataSource = 'live';

    if (db && schema && ops) {
      try {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        // Total station count
        const totalResult = await db
          .select({ count: ops.count() })
          .from(schema.weatherStations);
        totalStations = Number(totalResult[0]?.count ?? 0);

        // Stations that are inactive OR have not been updated in the last hour
        const offlineResult = await db
          .select({ count: ops.count() })
          .from(schema.weatherStations)
          .where(
            ops.or(
              ops.eq(schema.weatherStations.isActive, false),
              ops.lt(schema.weatherStations.updatedAt, oneHourAgo)
            )
          );
        offlineStations = Number(offlineResult[0]?.count ?? 0);
      } catch (err) {
        securityLogger.error('Risk Management: failed to query weather stations', {
          error: err.message,
        });
        dataSource = 'assessment_unavailable';
        totalStations = 0;
        offlineStations = 0;
      }
    } else {
      dataSource = 'data_unavailable';
      totalStations = 0;
      offlineStations = 0;
    }

    const availabilityRate =
      totalStations > 0
        ? ((totalStations - offlineStations) / totalStations) * 100
        : 0;

    let riskLevel = 'low';
    if (dataSource !== 'live') {
      // If we cannot assess, assume medium risk
      riskLevel = 'medium';
    } else {
      if (availabilityRate < 95) riskLevel = 'medium';
      if (availabilityRate < 90) riskLevel = 'high';
      if (availabilityRate < 85) riskLevel = 'critical';
    }

    return {
      riskId: 'WEATHER_STATION_NETWORK',
      title: 'Weather Station Network Availability',
      category: 'climate',
      currentRiskScore: this.severityLevels[riskLevel].score,
      metrics: {
        totalStations,
        offlineStations,
        availabilityRate: availabilityRate.toFixed(2),
        dataSource,
      },
      recommendation:
        dataSource !== 'live'
          ? 'Database unavailable — unable to assess station health'
          : availabilityRate < 95
            ? 'Investigate offline stations and implement redundancy'
            : 'Continue monitoring',
      lastAssessed: new Date().toISOString(),
    };
  }

  // Assess climate data quality
  async assessClimateDataQuality() {
    const { db, schema, ops } = getDb();
    let qualityMetrics;
    let dataSource = 'live';

    if (db && schema && ops) {
      try {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Fetch recent weather data entries from the last 24 hours
        const recentData = await db
          .select()
          .from(schema.weatherData)
          .where(ops.gte(schema.weatherData.timestamp, twentyFourHoursAgo));

        if (recentData.length === 0) {
          dataSource = 'no_recent_data';
          qualityMetrics = { accuracy: 0, completeness: 0, consistency: 0, timeliness: 0 };
        } else {
          const totalEntries = recentData.length;

          // Accuracy: percentage of entries that passed verification
          const verifiedCount = recentData.filter(
            d => d.verificationStatus === 'verified'
          ).length;
          const accuracy = (verifiedCount / totalEntries) * 100;

          // Completeness: percentage of entries with all core fields populated
          const coreFields = ['temperature', 'humidity', 'pressure', 'windSpeed'];
          const completeCount = recentData.filter(d =>
            coreFields.every(f => d[f] != null && d[f] !== '')
          ).length;
          const completeness = (completeCount / totalEntries) * 100;

          // Consistency: percentage of entries linked to a known station
          const withStationCount = recentData.filter(
            d => d.stationId != null && d.stationId !== ''
          ).length;
          const consistency = (withStationCount / totalEntries) * 100;

          // Timeliness: percentage of entries with a dataHash (submitted on-chain)
          const hashedCount = recentData.filter(
            d => d.dataHash != null && d.dataHash !== ''
          ).length;
          const timeliness = (hashedCount / totalEntries) * 100;

          qualityMetrics = {
            accuracy: parseFloat(accuracy.toFixed(1)),
            completeness: parseFloat(completeness.toFixed(1)),
            consistency: parseFloat(consistency.toFixed(1)),
            timeliness: parseFloat(timeliness.toFixed(1)),
            sampleSize: totalEntries,
          };
        }
      } catch (err) {
        securityLogger.error('Risk Management: failed to query weather data quality', {
          error: err.message,
        });
        dataSource = 'assessment_unavailable';
        qualityMetrics = { accuracy: 0, completeness: 0, consistency: 0, timeliness: 0 };
      }
    } else {
      dataSource = 'data_unavailable';
      qualityMetrics = { accuracy: 0, completeness: 0, consistency: 0, timeliness: 0 };
    }

    const coreValues = [
      qualityMetrics.accuracy,
      qualityMetrics.completeness,
      qualityMetrics.consistency,
      qualityMetrics.timeliness,
    ];
    const overallQuality = coreValues.reduce((a, b) => a + b, 0) / coreValues.length;

    let riskLevel = 'low';
    if (dataSource !== 'live') {
      riskLevel = 'medium';
    } else {
      if (overallQuality < 95) riskLevel = 'medium';
      if (overallQuality < 90) riskLevel = 'high';
      if (overallQuality < 85) riskLevel = 'critical';
    }

    return {
      riskId: 'CLIMATE_DATA_QUALITY',
      title: 'Climate Data Quality',
      category: 'climate',
      currentRiskScore: this.severityLevels[riskLevel].score,
      metrics: { ...qualityMetrics, dataSource },
      overallQuality: overallQuality.toFixed(1),
      recommendation:
        dataSource !== 'live'
          ? 'Database unavailable — unable to assess data quality'
          : overallQuality < 95
            ? 'Implement enhanced quality controls'
            : 'Maintain current standards',
      lastAssessed: new Date().toISOString(),
    };
  }

  // Assess carbon credit verification risks
  async assessCarbonCreditRisks() {
    const { db, schema, ops } = getDb();
    let metrics;
    let dataSource = 'live';

    if (db && schema && ops) {
      try {
        const allCredits = await db
          .select({
            id: schema.carbonCredits.id,
            isRetired: schema.carbonCredits.isRetired,
            certificationHash: schema.carbonCredits.certificationHash,
            createdAt: schema.carbonCredits.createdAt,
          })
          .from(schema.carbonCredits);

        const totalCredits = allCredits.length;

        if (totalCredits === 0) {
          dataSource = 'no_recent_data';
          metrics = { verificationSuccess: 100, disputeRate: 0, totalCredits: 0 };
        } else {
          // Verification success: credits that have a certification hash
          const verifiedCount = allCredits.filter(
            c => c.certificationHash != null && c.certificationHash !== ''
          ).length;
          const verificationSuccess = (verifiedCount / totalCredits) * 100;

          // Dispute rate: retired credits as a proxy for disputed/revoked credits
          const retiredCount = allCredits.filter(c => c.isRetired === true).length;
          const disputeRate = (retiredCount / totalCredits) * 100;

          metrics = {
            verificationSuccess: parseFloat(verificationSuccess.toFixed(1)),
            disputeRate: parseFloat(disputeRate.toFixed(1)),
            totalCredits,
            verifiedCredits: verifiedCount,
            retiredCredits: retiredCount,
          };
        }
      } catch (err) {
        securityLogger.error('Risk Management: failed to query carbon credits', {
          error: err.message,
        });
        dataSource = 'assessment_unavailable';
        metrics = { verificationSuccess: 0, disputeRate: 0, totalCredits: 0 };
      }
    } else {
      dataSource = 'data_unavailable';
      metrics = { verificationSuccess: 0, disputeRate: 0, totalCredits: 0 };
    }

    // Determine risk score based on verification success and dispute rate
    let riskScore;
    if (dataSource !== 'live') {
      riskScore = 2; // medium default when data unavailable
    } else if (metrics.verificationSuccess >= 98 && metrics.disputeRate < 2) {
      riskScore = 1; // low risk
    } else if (metrics.verificationSuccess >= 95 && metrics.disputeRate < 5) {
      riskScore = 2; // medium risk
    } else if (metrics.verificationSuccess >= 90 && metrics.disputeRate < 10) {
      riskScore = 3; // high risk
    } else {
      riskScore = 4; // critical risk
    }

    return {
      riskId: 'CARBON_CREDIT_VERIFICATION',
      title: 'Carbon Credit Verification Risk',
      category: 'climate',
      currentRiskScore: riskScore,
      metrics: { ...metrics, dataSource },
      recommendation:
        dataSource !== 'live'
          ? 'Database unavailable — unable to assess carbon credit risks'
          : riskScore <= 2
            ? 'Continue current verification processes'
            : 'Review verification pipeline — elevated dispute or failure rate',
      lastAssessed: new Date().toISOString(),
    };
  }

  // Assess environmental impact risks
  async assessEnvironmentalImpactRisks() {
    const { db, schema } = getDb();
    let metrics = {
      carbonFootprint: 'Unknown',
      energyEfficiency: 0,
      sustainabilityScore: 'C',
    };
    let riskScore = 2;
    let assessmentStatus = 'data_unavailable';

    if (db && schema) {
      try {
        const [footprints, credits, qualityRows] = await Promise.all([
          db.select().from(schema.carbonFootprints).limit(250),
          db.select().from(schema.carbonCredits).limit(250),
          db.select().from(schema.weatherDataQuality).limit(500),
        ]);

        const hasPersistedInputs =
          footprints.length > 0 || credits.length > 0 || qualityRows.length > 0;

        if (!hasPersistedInputs) {
          assessmentStatus = 'no_recent_data';
        } else {
          const averageNetEmissions = this.averageNumericField(
            footprints,
            'netEmissions'
          );
          const totalEmissions = this.sumNumericField(
            footprints,
            'totalEmissions'
          );
          const totalOffsets = this.sumNumericField(footprints, 'totalOffsets');
          const offsetCoverage =
            totalEmissions > 0
              ? Math.min(100, (totalOffsets / totalEmissions) * 100)
              : totalOffsets > 0
                ? 100
                : 0;

          const qualityScore = this.averageNumericField(
            qualityRows,
            'qualityScore'
          );
          const confidenceScore =
            this.averageNumericField(qualityRows, 'confidence') * 100;
          const verifiedCredits = credits.filter(
            credit =>
              credit.certificationHash != null &&
              credit.certificationHash !== ''
          ).length;
          const verificationRate =
            credits.length > 0 ? (verifiedCredits / credits.length) * 100 : 0;

          const energyEfficiency = Math.max(
            0,
            Math.min(
              100,
              ((qualityScore || 0) * 0.55) +
                ((confidenceScore || 0) * 0.25) +
                verificationRate * 0.2
            )
          );
          const sustainabilityIndex =
            energyEfficiency * 0.5 +
            offsetCoverage * 0.35 +
            verificationRate * 0.15;

          metrics = {
            carbonFootprint:
              averageNetEmissions <= 0
                ? 'Net Negative'
                : averageNetEmissions <= 1
                  ? 'Net Neutral'
                  : 'Net Positive',
            energyEfficiency: parseFloat(energyEfficiency.toFixed(1)),
            sustainabilityScore: this.getSustainabilityGrade(
              sustainabilityIndex
            ),
          };
          assessmentStatus = 'live';

          if (
            metrics.carbonFootprint === 'Net Positive' ||
            sustainabilityIndex < 70
          ) {
            riskScore = 3;
          }
          if (
            metrics.carbonFootprint === 'Net Positive' &&
            sustainabilityIndex < 55
          ) {
            riskScore = 4;
          }
          if (
            metrics.carbonFootprint === 'Net Negative' &&
            sustainabilityIndex >= 85
          ) {
            riskScore = 1;
          }
        }
      } catch (err) {
        securityLogger.error(
          'Risk Management: failed to query environmental impact metrics',
          {
            error: err.message,
          }
        );
        assessmentStatus = 'assessment_unavailable';
      }
    }

    return {
      riskId: 'ENVIRONMENTAL_IMPACT',
      title: 'Environmental Impact Risk',
      category: 'environmental',
      currentRiskScore: riskScore,
      metrics,
      recommendation:
        assessmentStatus !== 'live'
          ? 'Environmental assessment data unavailable — investigate carbon, credit, and quality data pipelines'
          : riskScore >= 3
          ? 'Reduce net emissions and improve validation quality across environmental programs'
          : 'Maintain sustainable practices',
      lastAssessed: new Date().toISOString(),
    };
  }

  // Calculate risk score based on likelihood and impact
  calculateRiskScore(likelihood, impact) {
    const likelihoodScores = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
      catastrophic: 5,
    };
    const impactScores = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
      catastrophic: 5,
    };

    return (likelihoodScores[likelihood] || 2) * (impactScores[impact] || 2);
  }

  // Update risk parameters based on current conditions
  async updateRiskParameters(risk) {
    const updatedRisk = { ...risk };

    // Adjust severity from persisted live signals when available.
    if (risk.category === 'climate' && (await this.hasRecentWeatherEvents())) {
      updatedRisk.likelihood = this.increaseLikelihood(risk.likelihood);
    }

    if (risk.category === 'cybersecurity' && (await this.hasRecentSecurityThreats())) {
      updatedRisk.likelihood = this.increaseLikelihood(risk.likelihood);
    }

    return updatedRisk;
  }

  // Assess mitigation effectiveness
  async assessMitigationEffectiveness(risk) {
    let effectiveness = 0;
    const evidenceModifier = await this.getMitigationEvidenceModifier(
      risk.category
    );

    for (const mitigation of risk.mitigations) {
      effectiveness += this.evaluateMitigation(
        mitigation,
        risk.category,
        evidenceModifier
      );
    }

    return Math.min(effectiveness / risk.mitigations.length, 1.0);
  }

  // Calculate residual risk after mitigations
  calculateResidualRisk(originalRisk, mitigationEffectiveness) {
    return originalRisk * (1 - mitigationEffectiveness);
  }

  // Calculate overall risk score for assessment
  calculateOverallRiskScore(risks) {
    if (risks.length === 0) return 0;

    const totalScore = risks.reduce(
      (sum, risk) => sum + (risk.residualRisk || risk.currentRiskScore),
      0
    );
    return totalScore / risks.length;
  }

  // Generate risk profile
  generateRiskProfile(risks) {
    const profile = {
      total: risks.length,
      byCategory: {},
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
      trending: { increasing: 0, stable: 0, decreasing: 0 },
    };

    for (const risk of risks) {
      // Count by category
      profile.byCategory[risk.category] =
        (profile.byCategory[risk.category] || 0) + 1;

      // Count by severity
      const severity = this.getSeverityLevel(
        risk.currentRiskScore || risk.residualRisk
      );
      profile.bySeverity[severity]++;

      // Count by trend
      const trend = risk.trend || 'stable';
      profile.trending[trend]++;
    }

    return profile;
  }

  // Generate recommendations based on risk assessment
  async generateRecommendations(risks) {
    const recommendations = [];

    // High-risk items need immediate attention
    const highRisks = risks.filter(
      r => (r.residualRisk || r.currentRiskScore) >= 6
    );
    if (highRisks.length > 0) {
      recommendations.push({
        priority: 'high',
        type: 'immediate_action',
        description: `Address ${highRisks.length} high-risk items requiring immediate attention`,
        risks: highRisks.map(r => r.riskId),
      });
    }

    // Climate-specific recommendations
    const climateRisks = risks.filter(r => r.category === 'climate');
    if (climateRisks.some(r => (r.currentRiskScore || r.residualRisk) >= 4)) {
      recommendations.push({
        priority: 'medium',
        type: 'climate_resilience',
        description: 'Enhance climate resilience measures and backup systems',
        risks: climateRisks.map(r => r.riskId),
      });
    }

    // Operational recommendations
    const operationalRisks = risks.filter(r => r.category === 'operational');
    if (operationalRisks.length > 3) {
      recommendations.push({
        priority: 'medium',
        type: 'operational_efficiency',
        description:
          'Review and improve operational processes to reduce risk exposure',
        risks: operationalRisks.map(r => r.riskId),
      });
    }

    return recommendations;
  }

  // Create mitigation plan
  async createMitigationPlan(risks) {
    const plan = {
      immediate: [],
      shortTerm: [],
      longTerm: [],
      resources: {
        budget: 0,
        personnel: [],
        technology: [],
      },
    };

    for (const risk of risks) {
      const riskScore = risk.residualRisk || risk.currentRiskScore;

      if (riskScore >= 8) {
        plan.immediate.push({
          riskId: risk.riskId,
          action: 'Emergency mitigation required',
          timeline: '24-48 hours',
          owner: 'incident_response_team',
        });
      } else if (riskScore >= 6) {
        plan.shortTerm.push({
          riskId: risk.riskId,
          action: 'Implement additional controls',
          timeline: '1-4 weeks',
          owner: 'risk_management_team',
        });
      } else if (riskScore >= 3) {
        plan.longTerm.push({
          riskId: risk.riskId,
          action: 'Monitor and review',
          timeline: '1-6 months',
          owner: 'operational_team',
        });
      }
    }

    return plan;
  }

  // Helper methods
  async hasRecentWeatherEvents() {
    const { db, schema, ops } = getDb();

    if (db && schema && ops) {
      try {
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

        // Check for severe weather: extreme wind speed (>= 90 km/h),
        // heavy precipitation (>= 50 mm), or very low pressure (< 980 hPa)
        const recentEntries = await db
          .select({
            windSpeed: schema.weatherData.windSpeed,
            precipitation: schema.weatherData.precipitation,
            pressure: schema.weatherData.pressure,
          })
          .from(schema.weatherData)
          .where(ops.gte(schema.weatherData.timestamp, sixHoursAgo))
          .limit(500);

        return recentEntries.some(entry => {
          const wind = parseFloat(entry.windSpeed);
          const precip = parseFloat(entry.precipitation);
          const pressure = parseFloat(entry.pressure);
          return (
            (!isNaN(wind) && wind >= 90) ||
            (!isNaN(precip) && precip >= 50) ||
            (!isNaN(pressure) && pressure > 0 && pressure < 980)
          );
        });
      } catch (err) {
        securityLogger.error('Risk Management: failed to check recent weather events', {
          error: err.message,
        });
        return false;
      }
    }

    return false;
  }

  async hasRecentSecurityThreats() {
    const { db, schema, ops } = getDb();

    if (db && schema && ops) {
      try {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentEvents = await db
          .select({
            severity: schema.securityEvents.severity,
            eventType: schema.securityEvents.eventType,
            createdAt: schema.securityEvents.createdAt,
          })
          .from(schema.securityEvents)
          .where(ops.gte(schema.securityEvents.createdAt, twentyFourHoursAgo))
          .limit(500);

        let weightedScore = 0;
        for (const event of recentEvents) {
          const severityScore = {
            low: 1,
            medium: 2,
            high: 3,
            critical: 4,
          }[event.severity] || 1;
          const threatMultiplier =
            typeof event.eventType === 'string' &&
            /(suspicious|threat|breach|attack|fraud|lockout)/i.test(
              event.eventType
            )
              ? 1.5
              : 1;
          const eventThreatScore = severityScore * threatMultiplier;
          weightedScore += eventThreatScore;

          if (
            threatMultiplier > 1 &&
            (event.severity === 'high' || event.severity === 'critical')
          ) {
            return true;
          }
        }

        return weightedScore >= 8;
      } catch (err) {
        securityLogger.error(
          'Risk Management: failed to check recent security threats',
          {
            error: err.message,
          }
        );
      }
    }

    return false;
  }

  increaseLikelihood(currentLikelihood) {
    const levels = ['low', 'medium', 'high', 'critical', 'catastrophic'];
    const currentIndex = levels.indexOf(currentLikelihood);
    return levels[Math.min(currentIndex + 1, levels.length - 1)];
  }

  async getMitigationEvidenceModifier(category) {
    if (category === 'climate' && (await this.hasRecentWeatherEvents())) {
      return -0.15;
    }

    if (
      category === 'cybersecurity' &&
      (await this.hasRecentSecurityThreats())
    ) {
      return -0.2;
    }

    return 0;
  }

  evaluateMitigation(mitigation, category, evidenceModifier = 0) {
    // Deterministic baseline scoring with live-signal degradation when controls are stressed.
    const effectivenessMap = {
      'Redundant sensor networks': 0.8,
      'Hardened equipment': 0.7,
      'Emergency protocols': 0.6,
      'Regular calibration': 0.8,
      'Quality monitoring': 0.7,
      'Backup systems': 0.9,
      'Load balancing': 0.8,
      'Redundant infrastructure': 0.9,
      'Monitoring systems': 0.7,
      Encryption: 0.9,
      'Access controls': 0.8,
      'Security monitoring': 0.8,
      'Regular audits': 0.7,
      'Compliance monitoring': 0.8,
      'Legal review': 0.6,
    };

    const categoryBaseline = {
      climate: 0.65,
      operational: 0.7,
      cybersecurity: 0.75,
      regulatory: 0.65,
      financial: 0.6,
      reputational: 0.55,
      technology: 0.6,
      environmental: 0.65,
    };
    const baseline =
      effectivenessMap[mitigation] ?? categoryBaseline[category] ?? 0.5;

    return Math.max(0.25, Math.min(0.95, baseline + evidenceModifier));
  }

  async calculateRiskTrend(riskId, currentScore, category) {
    const historicalScores = Array.from(this.riskAssessments.values())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .flatMap(assessment => assessment.risks || [])
      .filter(risk => risk.riskId === riskId)
      .map(risk => risk.residualRisk || risk.currentRiskScore)
      .filter(score => Number.isFinite(score))
      .slice(0, 5);

    if (historicalScores.length > 0) {
      const baseline =
        historicalScores.reduce((sum, score) => sum + score, 0) /
        historicalScores.length;

      if (currentScore >= baseline + 1) return 'increasing';
      if (currentScore <= baseline - 1) return 'decreasing';
      return 'stable';
    }

    if (category === 'climate' && (await this.hasRecentWeatherEvents())) {
      return 'increasing';
    }

    if (category === 'cybersecurity' && (await this.hasRecentSecurityThreats())) {
      return 'increasing';
    }

    return 'stable';
  }

  generateRiskRecommendation(risk, residualRisk) {
    if (residualRisk >= 8)
      return 'Immediate action required - escalate to executive team';
    if (residualRisk >= 6)
      return 'High priority - implement additional controls within 30 days';
    if (residualRisk >= 3)
      return 'Monitor closely and review mitigation effectiveness';
    return 'Acceptable risk level - continue current controls';
  }

  getReviewInterval(category) {
    const intervals = {
      climate: 30,
      cybersecurity: 15,
      operational: 60,
      regulatory: 90,
      financial: 30,
      reputational: 45,
      technology: 30,
      environmental: 90,
    };

    return intervals[category] || 60;
  }

  getSeverityLevel(score) {
    if (score >= 15) return 'critical';
    if (score >= 9) return 'high';
    if (score >= 4) return 'medium';
    return 'low';
  }

  averageNumericField(rows, fieldName) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    const numericValues = rows
      .map(row => this.parseNumericValue(row?.[fieldName]))
      .filter(value => value !== null);

    if (numericValues.length === 0) return 0;

    return (
      numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
    );
  }

  sumNumericField(rows, fieldName) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    return rows.reduce((sum, row) => {
      const value = this.parseNumericValue(row?.[fieldName]);
      return sum + (value ?? 0);
    }, 0);
  }

  parseNumericValue(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  getSustainabilityGrade(score) {
    if (score >= 95) return 'A+';
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }

  // Logging
  logRiskActivity(activity, data) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      activity,
      data,
      id: crypto.randomUUID(),
    };

    this.auditLog.push(logEntry);
    securityLogger.info('Risk Management', { activity, ...data });
  }

  // Public API methods
  getAllRisks() {
    return Array.from(this.riskRegistry.values());
  }

  getRiskById(riskId) {
    return this.riskRegistry.get(riskId);
  }

  getAssessmentById(assessmentId) {
    return this.riskAssessments.get(assessmentId);
  }

  getRecentAssessments(limit = 10) {
    return Array.from(this.riskAssessments.values())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }
}

// Express middleware
const riskManager = new RiskManagementSystem();

const riskManagementMiddleware = {
  conductAssessment: async (req, res, next) => {
    try {
      const { scope } = req.query;
      const assessment = await riskManager.conductRiskAssessment(scope);
      res.json(assessment);
    } catch (error) {
      next(error);
    }
  },

  registerRisk: async (req, res, next) => {
    try {
      const riskData = req.body;
      const risk = riskManager.registerRisk(riskData);
      res.json({ success: true, risk });
    } catch (error) {
      next(error);
    }
  },

  getAllRisks: async (req, res, next) => {
    try {
      const risks = riskManager.getAllRisks();
      res.json({ risks });
    } catch (error) {
      next(error);
    }
  },

  getRisk: async (req, res, next) => {
    try {
      const { riskId } = req.params;
      const risk = riskManager.getRiskById(riskId);

      if (!risk) {
        return res.status(404).json({ error: 'Risk not found' });
      }

      res.json({ risk });
    } catch (error) {
      next(error);
    }
  },

  getAssessment: async (req, res, next) => {
    try {
      const { assessmentId } = req.params;
      const assessment = riskManager.getAssessmentById(assessmentId);

      if (!assessment) {
        return res.status(404).json({ error: 'Assessment not found' });
      }

      res.json(assessment);
    } catch (error) {
      next(error);
    }
  },

  getRecentAssessments: async (req, res, next) => {
    try {
      const { limit } = req.query;
      const assessments = riskManager.getRecentAssessments(
        parseInt(limit, 10) || 10
      );
      res.json({ assessments });
    } catch (error) {
      next(error);
    }
  },
};

module.exports = {
  RiskManagementSystem,
  riskManagementMiddleware,
  riskManager,
};
