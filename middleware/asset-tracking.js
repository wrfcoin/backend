/**
 * Climate Asset Tracking System for ISO 24165 Asset Identifier Compliance
 * Global asset identification, registry integration, and climate asset lifecycle management
 */

const crypto = require('crypto');
const { appLogger } = require('../server/utils/logger');

class ClimateAssetTracker {
  constructor() {
    this.assetRegistry = new Map();
    this.globalIdentifiers = new Map();
    this.assetCategories = new Map();
    this.lifecycleStates = new Map();
    this.verificationRecords = new Map();
    this.auditLog = [];

    this.initializeAssetFramework();
  }

  // Initialize comprehensive asset tracking framework
  initializeAssetFramework() {
    // Define climate asset categories
    this.assetCategories.set('CARBON_CREDITS', {
      name: 'Carbon Credit Assets',
      prefix: 'CC',
      standards: ['VCS', 'CDM', 'CAR', 'WRF'],
      verificationRequired: true,
      retirementTracking: true,
    });

    this.assetCategories.set('WEATHER_DATA', {
      name: 'Weather Data Assets',
      prefix: 'WD',
      standards: ['WMO', 'ISO19156', 'WRF'],
      verificationRequired: true,
      qualityTracking: true,
    });

    this.assetCategories.set('RENEWABLE_CERTIFICATES', {
      name: 'Renewable Energy Certificates',
      prefix: 'REC',
      standards: ['I-REC', 'TIGR', 'WRF'],
      verificationRequired: true,
      energyTracking: true,
    });

    this.assetCategories.set('BIODIVERSITY_CREDITS', {
      name: 'Biodiversity Conservation Credits',
      prefix: 'BC',
      standards: ['VCS_BIO', 'CBD', 'WRF'],
      verificationRequired: true,
      conservationTracking: true,
    });

    this.assetCategories.set('WATER_CREDITS', {
      name: 'Water Conservation Credits',
      prefix: 'WC',
      standards: ['AWS', 'VERRA_WATER', 'WRF'],
      verificationRequired: true,
      waterTracking: true,
    });

    // Define asset lifecycle states
    this.lifecycleStates.set('CREATED', {
      name: 'Asset Created',
      description: 'Initial asset registration',
      nextStates: ['VERIFIED', 'CANCELLED'],
      actions: ['verify', 'cancel'],
    });

    this.lifecycleStates.set('VERIFIED', {
      name: 'Asset Verified',
      description: 'Third-party verification complete',
      nextStates: ['ISSUED', 'REJECTED'],
      actions: ['issue', 'reject'],
    });

    this.lifecycleStates.set('ISSUED', {
      name: 'Asset Issued',
      description: 'Asset available for trading',
      nextStates: ['TRANSFERRED', 'RETIRED', 'EXPIRED'],
      actions: ['transfer', 'retire', 'expire'],
    });

    this.lifecycleStates.set('TRANSFERRED', {
      name: 'Asset Transferred',
      description: 'Ownership transferred',
      nextStates: ['RETIRED', 'TRANSFERRED', 'EXPIRED'],
      actions: ['retire', 'transfer', 'expire'],
    });

    this.lifecycleStates.set('RETIRED', {
      name: 'Asset Retired',
      description: 'Asset permanently retired',
      nextStates: [],
      actions: [],
    });

    // Initialize global identifier registries
    this.initializeGlobalRegistries();
  }

  // Initialize connections to global asset registries
  initializeGlobalRegistries() {
    this.globalIdentifiers.set('VERRA', {
      name: 'Verra Registry',
      endpoint: 'https://registry.verra.org/api',
      idFormat: 'VCS-{projectId}-{vintageYear}-{serialNumber}',
      supported: true,
    });

    this.globalIdentifiers.set('CDM', {
      name: 'CDM Registry',
      endpoint: 'https://cdm.unfccc.int/Registry/api',
      idFormat: 'CDM-{countryCode}-{projectId}-{vintageYear}',
      supported: true,
    });

    this.globalIdentifiers.set('IETA', {
      name: 'IETA Registry',
      endpoint: 'https://ieta.org/registry/api',
      idFormat: 'IETA-{standard}-{projectId}-{serialNumber}',
      supported: true,
    });

    this.globalIdentifiers.set('WRF_GLOBAL', {
      name: 'WRF Global Climate Registry',
      endpoint: 'https://registry.wrfcoin.org/api',
      idFormat: 'WRF-{category}-{region}-{timestamp}-{hash}',
      supported: true,
      primary: true,
    });
  }

  // Register new climate asset with global identifiers
  async registerClimateAsset(assetData) {
    const assetId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Generate global identifier
    const globalId = await this.generateGlobalIdentifier(assetData);

    const asset = {
      id: assetId,
      globalId,
      category: assetData.category,
      type: assetData.type,
      title: assetData.title,
      description: assetData.description,

      // Asset properties
      properties: {
        vintage: assetData.vintage,
        quantity: assetData.quantity,
        unit: assetData.unit,
        location: assetData.location,
        projectId: assetData.projectId,
        methodology: assetData.methodology,
      },

      // Ownership and custody
      ownership: {
        currentOwner: assetData.owner,
        custodian: assetData.custodian || 'WRF_REGISTRY',
        ownershipHistory: [
          {
            owner: assetData.owner,
            timestamp,
            transactionType: 'initial_issuance',
          },
        ],
      },

      // Verification and compliance
      verification: {
        status: 'pending',
        verifier: null,
        verificationDate: null,
        standards:
          this.assetCategories.get(assetData.category)?.standards || [],
        certificates: [],
      },

      // Lifecycle management
      lifecycle: {
        currentState: 'CREATED',
        stateHistory: [
          {
            state: 'CREATED',
            timestamp,
            actor: assetData.creator || assetData.owner,
            notes: 'Initial asset creation',
          },
        ],
        expirationDate: assetData.expirationDate,
        retirementDate: null,
      },

      // Metadata and tracking
      metadata: {
        createdAt: timestamp,
        createdBy: assetData.creator || assetData.owner,
        lastUpdated: timestamp,
        version: 1,
        tags: assetData.tags || [],
        external_ids: {},
      },

      // Climate-specific tracking
      climateData: {
        carbonEquivalent: assetData.carbonEquivalent,
        additionality: assetData.additionality,
        permanence: assetData.permanence,
        leakage: assetData.leakage,
        sdgImpacts: assetData.sdgImpacts || [],
        geographicScope: assetData.geographicScope,
      },
    };

    // Register with external registries
    const registrationResults = await this.registerWithGlobalRegistries(asset);
    asset.metadata.external_ids = registrationResults.externalIds;

    // Store in local registry
    this.assetRegistry.set(assetId, asset);

    await this.logAssetActivity('asset_registered', {
      assetId,
      globalId,
      category: asset.category,
      quantity: asset.properties.quantity,
    });

    return {
      success: true,
      assetId,
      globalId,
      asset: this.sanitizeAssetForResponse(asset),
      registrationResults,
    };
  }

  // Generate unique global identifier following ISO 24165 standards
  async generateGlobalIdentifier(assetData) {
    const category = this.assetCategories.get(assetData.category);
    if (!category) {
      throw new Error(`Unknown asset category: ${assetData.category}`);
    }

    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    const locationCode = this.getLocationCode(assetData.location);
    const vintage = assetData.vintage || new Date().getFullYear();

    // WRF Global Registry format
    return `WRF-${category.prefix}-${locationCode}-${vintage}-${timestamp}-${random}`;
  }

  // Register asset with external global registries
  async registerWithGlobalRegistries(asset) {
    const results = {
      success: [],
      failed: [],
      externalIds: {},
    };

    const supportedRegistries = [...this.globalIdentifiers.entries()]
      .filter(([, registry]) => registry.supported);

    const settled = await Promise.allSettled(
      supportedRegistries.map(async ([registryName, registry]) => {
        const externalId = await this.registerWithRegistry(asset, registry);
        return { registryName, externalId };
      })
    );

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const registryName = supportedRegistries[i][0];
      if (result.status === 'fulfilled') {
        results.success.push(result.value.registryName);
        results.externalIds[result.value.registryName] = result.value.externalId;
      } else {
        results.failed.push({
          registry: registryName,
          error: result.reason?.message || String(result.reason),
        });
      }
    }

    return results;
  }

  // Transfer asset ownership
  async transferAsset(assetId, transferData) {
    const asset = this.assetRegistry.get(assetId);
    if (!asset) {
      throw new Error('Asset not found');
    }

    // Validate transfer permissions
    if (asset.ownership.currentOwner !== transferData.fromOwner) {
      throw new Error('Transfer not authorized by current owner');
    }

    // Validate asset state
    if (!this.canTransfer(asset.lifecycle.currentState)) {
      throw new Error(
        `Asset cannot be transferred in state: ${asset.lifecycle.currentState}`
      );
    }

    const timestamp = new Date().toISOString();
    const transferId = crypto.randomUUID();

    // Update ownership
    asset.ownership.currentOwner = transferData.toOwner;
    asset.ownership.ownershipHistory.push({
      transferId,
      fromOwner: transferData.fromOwner,
      toOwner: transferData.toOwner,
      timestamp,
      transactionType: 'transfer',
      quantity: transferData.quantity || asset.properties.quantity,
      price: transferData.price,
      notes: transferData.notes,
    });

    // Update lifecycle
    asset.lifecycle.currentState = 'TRANSFERRED';
    asset.lifecycle.stateHistory.push({
      state: 'TRANSFERRED',
      timestamp,
      actor: transferData.fromOwner,
      notes: `Transferred to ${transferData.toOwner}`,
      transferId,
    });

    // Update metadata
    asset.metadata.lastUpdated = timestamp;
    asset.metadata.version++;

    // Notify external registries
    await this.notifyRegistriesOfTransfer(asset, transferData);

    await this.logAssetActivity('asset_transferred', {
      assetId,
      transferId,
      fromOwner: transferData.fromOwner,
      toOwner: transferData.toOwner,
      quantity: transferData.quantity,
    });

    return {
      success: true,
      transferId,
      asset: this.sanitizeAssetForResponse(asset),
    };
  }

  // Retire asset (permanent removal from circulation)
  async retireAsset(assetId, retirementData) {
    const asset = this.assetRegistry.get(assetId);
    if (!asset) {
      throw new Error('Asset not found');
    }

    // Validate retirement permissions
    if (asset.ownership.currentOwner !== retirementData.owner) {
      throw new Error('Retirement not authorized by current owner');
    }

    // Validate asset state
    if (!this.canRetire(asset.lifecycle.currentState)) {
      throw new Error(
        `Asset cannot be retired in state: ${asset.lifecycle.currentState}`
      );
    }

    const timestamp = new Date().toISOString();
    const retirementId = crypto.randomUUID();

    // Update lifecycle
    asset.lifecycle.currentState = 'RETIRED';
    asset.lifecycle.retirementDate = timestamp;
    asset.lifecycle.stateHistory.push({
      state: 'RETIRED',
      timestamp,
      actor: retirementData.owner,
      notes: retirementData.reason || 'Asset permanently retired',
      retirementId,
    });

    // Add retirement metadata
    asset.metadata.retirement = {
      retirementId,
      retiredBy: retirementData.owner,
      retirementDate: timestamp,
      reason: retirementData.reason,
      beneficiary: retirementData.beneficiary,
      retirementCertificate: await this.generateRetirementCertificate(
        asset,
        retirementData
      ),
    };

    // Update metadata
    asset.metadata.lastUpdated = timestamp;
    asset.metadata.version++;

    // Notify external registries
    await this.notifyRegistriesOfRetirement(asset, retirementData);

    await this.logAssetActivity('asset_retired', {
      assetId,
      retirementId,
      owner: retirementData.owner,
      reason: retirementData.reason,
    });

    return {
      success: true,
      retirementId,
      retirementCertificate: asset.metadata.retirement.retirementCertificate,
      asset: this.sanitizeAssetForResponse(asset),
    };
  }

  // Verify asset with third-party verifier
  async verifyAsset(assetId, verificationData) {
    const asset = this.assetRegistry.get(assetId);
    if (!asset) {
      throw new Error('Asset not found');
    }

    const timestamp = new Date().toISOString();
    const verificationId = crypto.randomUUID();

    // Update verification status
    asset.verification = {
      status: verificationData.approved ? 'verified' : 'rejected',
      verifier: verificationData.verifier,
      verificationDate: timestamp,
      verificationId,
      standards: verificationData.standards || asset.verification.standards,
      certificates: verificationData.certificates || [],
      methodology: verificationData.methodology,
      findings: verificationData.findings,
      recommendations: verificationData.recommendations,
    };

    // Update lifecycle
    const newState = verificationData.approved ? 'VERIFIED' : 'REJECTED';
    asset.lifecycle.currentState = newState;
    asset.lifecycle.stateHistory.push({
      state: newState,
      timestamp,
      actor: verificationData.verifier,
      notes:
        verificationData.notes || `Asset ${newState.toLowerCase()} by verifier`,
      verificationId,
    });

    // Create verification record
    this.verificationRecords.set(verificationId, {
      id: verificationId,
      assetId,
      verifier: verificationData.verifier,
      timestamp,
      result: verificationData.approved,
      methodology: verificationData.methodology,
      evidence: verificationData.evidence,
      carbonQuantification: verificationData.carbonQuantification,
      qualityAssurance: verificationData.qualityAssurance,
    });

    await this.logAssetActivity('asset_verified', {
      assetId,
      verificationId,
      verifier: verificationData.verifier,
      approved: verificationData.approved,
    });

    return {
      success: true,
      verificationId,
      status: asset.verification.status,
      asset: this.sanitizeAssetForResponse(asset),
    };
  }

  // Track climate impact and performance
  async trackClimateImpact(assetId, impactData) {
    const asset = this.assetRegistry.get(assetId);
    if (!asset) {
      throw new Error('Asset not found');
    }

    const timestamp = new Date().toISOString();
    const trackingId = crypto.randomUUID();

    // Initialize climate tracking if not exists
    if (!asset.climateData.impactTracking) {
      asset.climateData.impactTracking = [];
    }

    // Add impact measurement
    const impactRecord = {
      trackingId,
      timestamp,
      period: impactData.period,
      measurements: {
        carbonReduction: impactData.carbonReduction,
        energyGenerated: impactData.energyGenerated,
        waterConserved: impactData.waterConserved,
        biodiversityProtected: impactData.biodiversityProtected,
        socialImpact: impactData.socialImpact,
      },
      methodology: impactData.methodology,
      dataSource: impactData.dataSource,
      verificationStatus: impactData.verified ? 'verified' : 'self-reported',
      qualityScore: this.calculateImpactQuality(impactData),
    };

    asset.climateData.impactTracking.push(impactRecord);

    // Update cumulative impact
    this.updateCumulativeImpact(asset);

    await this.logAssetActivity('impact_tracked', {
      assetId,
      trackingId,
      carbonReduction: impactData.carbonReduction,
      verified: impactData.verified,
    });

    return {
      success: true,
      trackingId,
      cumulativeImpact: asset.climateData.cumulativeImpact,
      qualityScore: impactRecord.qualityScore,
    };
  }

  // Generate comprehensive asset report
  async generateAssetReport(assetId) {
    const asset = this.assetRegistry.get(assetId);
    if (!asset) {
      throw new Error('Asset not found');
    }

    const report = {
      id: crypto.randomUUID(),
      assetId,
      generatedAt: new Date().toISOString(),

      // Asset summary
      summary: {
        globalId: asset.globalId,
        category: asset.category,
        type: asset.type,
        currentState: asset.lifecycle.currentState,
        currentOwner: asset.ownership.currentOwner,
        verificationStatus: asset.verification.status,
      },

      // Performance metrics
      performance: {
        climateImpact: asset.climateData.cumulativeImpact,
        qualityScore: this.calculateAssetQuality(asset),
        utilizationRate: this.calculateUtilizationRate(asset),
        marketValue: await this.estimateMarketValue(asset),
      },

      // Compliance status
      compliance: {
        standards: this.checkStandardsCompliance(asset),
        registrations: Object.keys(asset.metadata.external_ids),
        verifications: this.getVerificationHistory(asset),
        auditTrail: this.generateAuditTrail(asset),
      },

      // Recommendations
      recommendations: await this.generateAssetRecommendations(asset),
    };

    await this.logAssetActivity('report_generated', {
      assetId,
      reportId: report.id,
      qualityScore: report.performance.qualityScore,
    });

    return report;
  }

  // Helper methods
  async registerWithRegistry(asset, registry) {
    // Mock external registry registration
    const externalId = `${registry.idFormat.replace('{projectId}', asset.properties.projectId || 'WRF001')}`;
    appLogger.info('Registering asset with registry', {
      assetGlobalId: asset.globalId,
      registryName: registry.name,
      externalId
    });
    return externalId;
  }

  getLocationCode(location) {
    if (!location) return 'GLB';

    // Extract country/region code from location
    const locationCodes = {
      'United States': 'USA',
      'European Union': 'EUR',
      'United Kingdom': 'GBR',
      Canada: 'CAN',
      Australia: 'AUS',
      Global: 'GLB',
    };

    return locationCodes[location] || 'GLB';
  }

  canTransfer(currentState) {
    const transferableStates = ['ISSUED', 'TRANSFERRED'];
    return transferableStates.includes(currentState);
  }

  canRetire(currentState) {
    const retirableStates = ['ISSUED', 'TRANSFERRED'];
    return retirableStates.includes(currentState);
  }

  async generateRetirementCertificate(asset, retirementData) {
    return {
      certificateId: `CERT-${asset.globalId}-${Date.now()}`,
      assetId: asset.id,
      globalId: asset.globalId,
      retiredBy: retirementData.owner,
      retirementDate: new Date().toISOString(),
      quantity: asset.properties.quantity,
      unit: asset.properties.unit,
      vintage: asset.properties.vintage,
      reason: retirementData.reason,
      beneficiary: retirementData.beneficiary,
      carbonImpact: asset.climateData.carbonEquivalent,
      verificationStatus: asset.verification.status,
    };
  }

  async notifyRegistriesOfTransfer(asset, transferData) {
    // Mock notification to external registries
    appLogger.info('Notifying registries of transfer', { assetGlobalId: asset.globalId });
  }

  async notifyRegistriesOfRetirement(asset, retirementData) {
    // Mock notification to external registries
    appLogger.info('Notifying registries of retirement', { assetGlobalId: asset.globalId });
  }

  calculateImpactQuality(impactData) {
    let quality = 100;

    // Deduct for missing verification
    if (!impactData.verified) quality -= 20;

    // Deduct for incomplete data
    const dataCompleteness =
      Object.values(impactData).filter(v => v !== undefined).length / 10;
    quality *= dataCompleteness;

    return Math.max(0, Math.min(100, quality));
  }

  updateCumulativeImpact(asset) {
    if (
      !asset.climateData.impactTracking ||
      asset.climateData.impactTracking.length === 0
    ) {
      return;
    }

    const cumulative = {
      carbonReduction: 0,
      energyGenerated: 0,
      waterConserved: 0,
      biodiversityProtected: 0,
    };

    for (const record of asset.climateData.impactTracking) {
      cumulative.carbonReduction += record.measurements.carbonReduction || 0;
      cumulative.energyGenerated += record.measurements.energyGenerated || 0;
      cumulative.waterConserved += record.measurements.waterConserved || 0;
      cumulative.biodiversityProtected +=
        record.measurements.biodiversityProtected || 0;
    }

    asset.climateData.cumulativeImpact = cumulative;
  }

  calculateAssetQuality(asset) {
    let quality = 100;

    // Factor in verification status
    if (asset.verification.status === 'verified') quality += 0;
    else if (asset.verification.status === 'pending') quality -= 20;
    else quality -= 50;

    // Factor in impact tracking
    if (asset.climateData.impactTracking) {
      const avgImpactQuality =
        asset.climateData.impactTracking.reduce(
          (sum, record) => sum + record.qualityScore,
          0
        ) / asset.climateData.impactTracking.length;
      quality = (quality + avgImpactQuality) / 2;
    }

    return Math.max(0, Math.min(100, quality));
  }

  calculateUtilizationRate(asset) {
    // Mock utilization calculation
    return Math.random() * 100;
  }

  async estimateMarketValue(asset) {
    // Mock market value estimation
    const baseValue = asset.properties.quantity * 15; // $15 per tCO2e
    const qualityMultiplier = this.calculateAssetQuality(asset) / 100;
    return baseValue * qualityMultiplier;
  }

  checkStandardsCompliance(asset) {
    const compliance = {};
    const category = this.assetCategories.get(asset.category);

    if (category) {
      for (const standard of category.standards) {
        compliance[standard] = asset.verification.standards.includes(standard);
      }
    }

    return compliance;
  }

  getVerificationHistory(asset) {
    return asset.lifecycle.stateHistory
      .filter(entry => entry.state === 'VERIFIED' || entry.state === 'REJECTED')
      .map(entry => ({
        date: entry.timestamp,
        status: entry.state,
        verifier: entry.actor,
      }));
  }

  generateAuditTrail(asset) {
    return asset.lifecycle.stateHistory.map(entry => ({
      timestamp: entry.timestamp,
      action: entry.state,
      actor: entry.actor,
      notes: entry.notes,
    }));
  }

  async generateAssetRecommendations(asset) {
    const recommendations = [];

    if (asset.verification.status === 'pending') {
      recommendations.push(
        'Complete third-party verification to increase asset value'
      );
    }

    if (
      !asset.climateData.impactTracking ||
      asset.climateData.impactTracking.length === 0
    ) {
      recommendations.push(
        'Implement impact tracking to demonstrate performance'
      );
    }

    if (
      asset.lifecycle.currentState === 'ISSUED' &&
      this.calculateAssetQuality(asset) > 90
    ) {
      recommendations.push(
        'Consider listing on carbon marketplace for trading'
      );
    }

    return recommendations;
  }

  sanitizeAssetForResponse(asset) {
    // Remove sensitive internal data
    const sanitized = { ...asset };
    delete sanitized.metadata.internal;
    return sanitized;
  }

  async logAssetActivity(activity, data) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      activity,
      data,
      id: crypto.randomUUID(),
    };

    this.auditLog.push(logEntry);
    appLogger.info('Asset Tracking', { activity, ...data });
  }

  // Public API methods
  getAssetById(assetId) {
    const asset = this.assetRegistry.get(assetId);
    return asset ? this.sanitizeAssetForResponse(asset) : null;
  }

  getAssetByGlobalId(globalId) {
    for (const asset of this.assetRegistry.values()) {
      if (asset.globalId === globalId) {
        return this.sanitizeAssetForResponse(asset);
      }
    }
    return null;
  }

  getAllAssets(filters = {}) {
    let assets = Array.from(this.assetRegistry.values());

    if (filters.category) {
      assets = assets.filter(a => a.category === filters.category);
    }

    if (filters.owner) {
      assets = assets.filter(a => a.ownership.currentOwner === filters.owner);
    }

    if (filters.state) {
      assets = assets.filter(a => a.lifecycle.currentState === filters.state);
    }

    return assets.map(a => this.sanitizeAssetForResponse(a));
  }

  getAssetCategories() {
    return Array.from(this.assetCategories.entries()).map(([key, value]) => ({
      id: key,
      ...value,
    }));
  }
}

// Express middleware
const assetTracker = new ClimateAssetTracker();

const assetTrackingMiddleware = {
  registerAsset: async (req, res, next) => {
    try {
      const assetData = req.body;
      const result = await assetTracker.registerClimateAsset(assetData);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  transferAsset: async (req, res, next) => {
    try {
      const { assetId } = req.params;
      const transferData = req.body;
      const result = await assetTracker.transferAsset(assetId, transferData);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  retireAsset: async (req, res, next) => {
    try {
      const { assetId } = req.params;
      const retirementData = req.body;
      const result = await assetTracker.retireAsset(assetId, retirementData);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  verifyAsset: async (req, res, next) => {
    try {
      const { assetId } = req.params;
      const verificationData = req.body;
      const result = await assetTracker.verifyAsset(assetId, verificationData);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  trackImpact: async (req, res, next) => {
    try {
      const { assetId } = req.params;
      const impactData = req.body;
      const result = await assetTracker.trackClimateImpact(assetId, impactData);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  getAsset: async (req, res, next) => {
    try {
      const { assetId } = req.params;
      const asset = assetTracker.getAssetById(assetId);

      if (!asset) {
        return res.status(404).json({ error: 'Asset not found' });
      }

      res.json(asset);
    } catch (error) {
      next(error);
    }
  },

  getAllAssets: async (req, res, next) => {
    try {
      const filters = req.query;
      const assets = assetTracker.getAllAssets(filters);
      res.json({ assets });
    } catch (error) {
      next(error);
    }
  },

  generateReport: async (req, res, next) => {
    try {
      const { assetId } = req.params;
      const report = await assetTracker.generateAssetReport(assetId);
      res.json(report);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = { ClimateAssetTracker, assetTrackingMiddleware, assetTracker };
