/**
 * Partner Onboarding and Authentication Service
 *
 * Comprehensive service for enterprise partner onboarding, authentication,
 * and authorization for Layer 2 enterprise testing integration.
 */

import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../auth/jwt-constants.js';
import * as bcrypt from 'bcrypt';
import { validationResult, body } from 'express-validator';
import * as winston from 'winston';
import { EventEmitter } from 'events';

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'partner-onboarding' },
  transports: [
    new winston.transports.File({ filename: 'logs/partner-onboarding.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// Interfaces and Types
interface PartnerApplication {
  applicationId: string;
  companyName: string;
  companyType: 'enterprise' | 'government' | 'research' | 'ngo';
  contactPerson: {
    name: string;
    email: string;
    phone: string;
    title: string;
  };
  technicalContact: {
    name: string;
    email: string;
    phone: string;
    title: string;
  };
  businessDetails: {
    description: string;
    website: string;
    establishedYear: number;
    employeeCount: string;
    revenue: string;
    industry: string[];
  };
  technicalRequirements: {
    expectedTPS: number;
    dataVolume: number; // GB per day
    integrationTypes: string[];
    protocols: string[];
    dataFormats: string[];
    regions: string[];
  };
  complianceInfo: {
    certifications: string[];
    dataPrivacyCompliance: string[];
    securityStandards: string[];
    auditReports: boolean;
  };
  useCase: {
    description: string;
    climateDataTypes: string[];
    expectedBenefit: string;
    timeline: string;
  };
  status:
    | 'submitted'
    | 'under_review'
    | 'approved'
    | 'rejected'
    | 'pending_verification';
  submittedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
  reviewNotes?: string;
}

interface PartnerCredentials {
  partnerId: string;
  apiKey: string;
  secretKey: string;
  accessToken?: string;
  refreshToken?: string;
  certificateInfo?: {
    publicKey: string;
    privateKey: string;
    certificate: string;
    expiresAt: Date;
  };
  scopes: string[];
  permissions: PartnerPermissions;
  createdAt: Date;
  expiresAt: Date;
  lastUsed?: Date;
}

interface PartnerPermissions {
  dataAccess: {
    read: string[];
    write: string[];
    delete: string[];
  };
  apiEndpoints: string[];
  rateLimit: {
    requestsPerMinute: number;
    requestsPerHour: number;
    requestsPerDay: number;
  };
  layer2Access: {
    enabled: boolean;
    maxTPS: number;
    priorityLevel: 'low' | 'medium' | 'high' | 'critical';
  };
  testingAccess: {
    performanceTesting: boolean;
    loadTesting: boolean;
    productionTesting: boolean;
  };
}

interface OnboardingStage {
  stage: string;
  name: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  requirements: string[];
  validations: OnboardingValidation[];
}

interface OnboardingValidation {
  type: 'technical' | 'business' | 'security' | 'compliance';
  name: string;
  status: 'pending' | 'passed' | 'failed';
  details?: string;
  completedAt?: Date;
}

class PartnerOnboardingService extends EventEmitter {
  private applications: Map<string, PartnerApplication> = new Map();
  private credentials: Map<string, PartnerCredentials> = new Map();
  private onboardingStages: Map<string, OnboardingStage[]> = new Map();

  private readonly JWT_SECRET = (() => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        'JWT_SECRET environment variable is required for partner onboarding service'
      );
    }
    return secret;
  })();
  private readonly API_KEY_PREFIX = 'wrf_partner_';
  private readonly SALT_ROUNDS = 12;

  constructor() {
    super();
    this.initializeOnboardingStages();
  }

  /**
   * Initialize standard onboarding stages
   */
  private initializeOnboardingStages(): void {
    this.defineOnboardingPipeline();
  }

  /**
   * Submit new partner application
   */
  async submitPartnerApplication(
    applicationData: Partial<PartnerApplication>
  ): Promise<{
    applicationId: string;
    status: string;
    nextSteps: string[];
  }> {
    try {
      const applicationId = this.generateApplicationId();

      const application: PartnerApplication = {
        applicationId,
        companyName: applicationData.companyName!,
        companyType: applicationData.companyType!,
        contactPerson: applicationData.contactPerson!,
        technicalContact: applicationData.technicalContact!,
        businessDetails: applicationData.businessDetails!,
        technicalRequirements: applicationData.technicalRequirements!,
        complianceInfo: applicationData.complianceInfo!,
        useCase: applicationData.useCase!,
        status: 'submitted',
        submittedAt: new Date(),
      };

      // Validate application data
      await this.validateApplication(application);

      // Store application
      this.applications.set(applicationId, application);

      // Initialize onboarding stages
      await this.initializeOnboardingForApplication(applicationId);

      // Start automated review process
      this.startAutomatedReview(applicationId);

      logger.info(
        `Partner application submitted: ${applicationId} - ${application.companyName}`
      );

      this.emit('application_submitted', { applicationId, application });

      return {
        applicationId,
        status: 'submitted',
        nextSteps: [
          'Automated compliance and security review will begin within 24 hours',
          'Technical requirements validation will be scheduled',
          'Business verification process will be initiated',
          'You will receive email updates on review progress',
        ],
      };
    } catch (error) {
      logger.error('Partner application submission failed:', error);
      throw new Error(
        `Application submission failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get application status and progress
   */
  async getApplicationStatus(applicationId: string): Promise<{
    application: PartnerApplication;
    onboardingProgress: OnboardingStage[];
    currentStage: OnboardingStage;
    estimatedCompletion: Date;
  }> {
    const application = this.applications.get(applicationId);
    if (!application) {
      throw new Error(`Application not found: ${applicationId}`);
    }

    const stages = this.onboardingStages.get(applicationId) || [];
    const currentStage =
      stages.find(s => s.status === 'in_progress') || stages[0];

    const estimatedCompletion = this.calculateEstimatedCompletion(stages);

    return {
      application,
      onboardingProgress: stages,
      currentStage,
      estimatedCompletion,
    };
  }

  /**
   * Approve partner application and generate credentials
   */
  async approvePartnerApplication(
    applicationId: string,
    reviewerId: string,
    notes?: string
  ): Promise<{
    partnerId: string;
    credentials: Omit<PartnerCredentials, 'secretKey'>;
    onboardingInstructions: string[];
  }> {
    try {
      const application = this.applications.get(applicationId);
      if (!application) {
        throw new Error(`Application not found: ${applicationId}`);
      }

      if (application.status !== 'under_review') {
        throw new Error(
          `Invalid application status for approval: ${application.status}`
        );
      }

      // Generate partner ID
      const partnerId = this.generatePartnerId(application.companyType);

      // Generate secure credentials
      const credentials = await this.generatePartnerCredentials(
        partnerId,
        application
      );

      // Update application status
      application.status = 'approved';
      application.reviewedAt = new Date();
      application.reviewedBy = reviewerId;
      application.reviewNotes = notes;

      // Store credentials
      this.credentials.set(partnerId, credentials);

      // Complete onboarding stages
      await this.completeOnboardingStages(applicationId);

      // Generate onboarding instructions
      const onboardingInstructions = this.generateOnboardingInstructions(
        partnerId,
        application
      );

      logger.info(
        `Partner application approved: ${applicationId} -> ${partnerId}`
      );

      this.emit('application_approved', {
        applicationId,
        partnerId,
        application,
      });

      // Return credentials without secret key for security
      const { secretKey, ...safeCredentials } = credentials;

      return {
        partnerId,
        credentials: safeCredentials,
        onboardingInstructions,
      };
    } catch (error) {
      logger.error('Partner application approval failed:', error);
      throw error;
    }
  }

  /**
   * Authenticate partner using API key
   */
  async authenticatePartner(
    apiKey: string,
    secretKey?: string
  ): Promise<{
    partnerId: string;
    permissions: PartnerPermissions;
    accessToken: string;
    expiresIn: number;
  }> {
    try {
      // Find partner by API key
      const partnerId = this.findPartnerByApiKey(apiKey);
      if (!partnerId) {
        throw new Error('Invalid API key');
      }

      const credentials = this.credentials.get(partnerId);
      if (!credentials) {
        throw new Error('Partner credentials not found');
      }

      // Verify secret key if provided
      if (secretKey) {
        const isValidSecret = await bcrypt.compare(
          secretKey,
          credentials.secretKey
        );
        if (!isValidSecret) {
          throw new Error('Invalid secret key');
        }
      }

      // Check if credentials are expired
      if (credentials.expiresAt < new Date()) {
        throw new Error('Partner credentials expired');
      }

      // Generate access token
      const accessToken = this.generateAccessToken(
        partnerId,
        credentials.permissions
      );

      // Update last used timestamp
      credentials.lastUsed = new Date();

      logger.info(`Partner authenticated: ${partnerId}`);

      this.emit('partner_authenticated', { partnerId });

      return {
        partnerId,
        permissions: credentials.permissions,
        accessToken,
        expiresIn: 3600, // 1 hour
      };
    } catch (error) {
      logger.error('Partner authentication failed:', error);
      throw error;
    }
  }

  /**
   * Verify JWT access token
   */
  async verifyAccessToken(token: string): Promise<{
    partnerId: string;
    permissions: PartnerPermissions;
    scopes: string[];
  }> {
    try {
      const decoded = jwt.verify(token, this.JWT_SECRET, { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE }) as any;

      const credentials = this.credentials.get(decoded.partnerId);
      if (!credentials) {
        throw new Error('Partner not found');
      }

      return {
        partnerId: decoded.partnerId,
        permissions: credentials.permissions,
        scopes: credentials.scopes,
      };
    } catch (error) {
      logger.error('Token verification failed:', error);
      throw new Error('Invalid or expired access token');
    }
  }

  /**
   * Update partner permissions
   */
  async updatePartnerPermissions(
    partnerId: string,
    newPermissions: Partial<PartnerPermissions>
  ): Promise<PartnerPermissions> {
    const credentials = this.credentials.get(partnerId);
    if (!credentials) {
      throw new Error(`Partner not found: ${partnerId}`);
    }

    // Merge new permissions with existing ones
    credentials.permissions = {
      ...credentials.permissions,
      ...newPermissions,
      dataAccess: {
        ...credentials.permissions.dataAccess,
        ...newPermissions.dataAccess,
      },
      rateLimit: {
        ...credentials.permissions.rateLimit,
        ...newPermissions.rateLimit,
      },
      layer2Access: {
        ...credentials.permissions.layer2Access,
        ...newPermissions.layer2Access,
      },
      testingAccess: {
        ...credentials.permissions.testingAccess,
        ...newPermissions.testingAccess,
      },
    };

    logger.info(`Partner permissions updated: ${partnerId}`);

    this.emit('permissions_updated', {
      partnerId,
      permissions: credentials.permissions,
    });

    return credentials.permissions;
  }

  /**
   * Rotate partner API credentials
   */
  async rotatePartnerCredentials(partnerId: string): Promise<{
    apiKey: string;
    secretKey: string;
    expiresAt: Date;
  }> {
    const credentials = this.credentials.get(partnerId);
    if (!credentials) {
      throw new Error(`Partner not found: ${partnerId}`);
    }

    // Generate new credentials
    const newApiKey = this.generateApiKey();
    const newSecretKey = crypto.randomBytes(32).toString('hex');
    const hashedSecretKey = await bcrypt.hash(newSecretKey, this.SALT_ROUNDS);

    // Update credentials
    credentials.apiKey = newApiKey;
    credentials.secretKey = hashedSecretKey;
    credentials.expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year

    logger.info(`Partner credentials rotated: ${partnerId}`);

    this.emit('credentials_rotated', { partnerId });

    return {
      apiKey: newApiKey,
      secretKey: newSecretKey,
      expiresAt: credentials.expiresAt,
    };
  }

  /**
   * Suspend partner access
   */
  async suspendPartner(partnerId: string, reason: string): Promise<void> {
    const credentials = this.credentials.get(partnerId);
    if (!credentials) {
      throw new Error(`Partner not found: ${partnerId}`);
    }

    // Set expiration to past date to effectively suspend
    credentials.expiresAt = new Date(Date.now() - 1000);

    logger.warn(`Partner suspended: ${partnerId} - Reason: ${reason}`);

    this.emit('partner_suspended', { partnerId, reason });
  }

  /**
   * Get partner onboarding analytics
   */
  async getOnboardingAnalytics(): Promise<{
    totalApplications: number;
    approvalRate: number;
    averageOnboardingTime: number;
    statusBreakdown: Record<string, number>;
    typeBreakdown: Record<string, number>;
    recentApplications: PartnerApplication[];
  }> {
    const applications = Array.from(this.applications.values());

    const statusBreakdown = applications.reduce(
      (acc, app) => {
        acc[app.status] = (acc[app.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const typeBreakdown = applications.reduce(
      (acc, app) => {
        acc[app.companyType] = (acc[app.companyType] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const approvedApps = applications.filter(app => app.status === 'approved');
    const approvalRate =
      applications.length > 0
        ? (approvedApps.length / applications.length) * 100
        : 0;

    const completedApps = applications.filter(app => app.reviewedAt);
    const averageOnboardingTime =
      completedApps.length > 0
        ? completedApps.reduce((sum, app) => {
            return (
              sum + (app.reviewedAt!.getTime() - app.submittedAt.getTime())
            );
          }, 0) /
          completedApps.length /
          (1000 * 60 * 60 * 24) // Convert to days
        : 0;

    const recentApplications = applications
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())
      .slice(0, 10);

    return {
      totalApplications: applications.length,
      approvalRate,
      averageOnboardingTime,
      statusBreakdown,
      typeBreakdown,
      recentApplications,
    };
  }

  // Private helper methods

  private generateApplicationId(): string {
    return `APP_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  }

  private generatePartnerId(companyType: string): string {
    const typePrefix = companyType.toUpperCase().substring(0, 3);
    const sequence = String(this.credentials.size + 1).padStart(3, '0');
    return `${typePrefix}_${sequence}`;
  }

  private generateApiKey(): string {
    return `${this.API_KEY_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
  }

  private async generatePartnerCredentials(
    partnerId: string,
    application: PartnerApplication
  ): Promise<PartnerCredentials> {
    const apiKey = this.generateApiKey();
    const secretKey = crypto.randomBytes(32).toString('hex');
    const hashedSecretKey = await bcrypt.hash(secretKey, this.SALT_ROUNDS);

    // Calculate permissions based on application requirements
    const permissions = this.calculateDefaultPermissions(application);

    const credentials: PartnerCredentials = {
      partnerId,
      apiKey,
      secretKey: hashedSecretKey,
      scopes: this.calculateScopes(application),
      permissions,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
    };

    return credentials;
  }

  private calculateDefaultPermissions(
    application: PartnerApplication
  ): PartnerPermissions {
    const basePermissions: PartnerPermissions = {
      dataAccess: {
        read: ['weather_data', 'climate_models'],
        write: [],
        delete: [],
      },
      apiEndpoints: ['/api/weather/*', '/api/climate/*', '/api/partners/*'],
      rateLimit: {
        requestsPerMinute: 1000,
        requestsPerHour: 50000,
        requestsPerDay: 1000000,
      },
      layer2Access: {
        enabled: true,
        maxTPS: Math.min(application.technicalRequirements.expectedTPS, 25000),
        priorityLevel: 'medium',
      },
      testingAccess: {
        performanceTesting: true,
        loadTesting: application.technicalRequirements.expectedTPS > 10000,
        productionTesting: application.companyType === 'enterprise',
      },
    };

    // Adjust permissions based on company type
    switch (application.companyType) {
      case 'government':
        basePermissions.layer2Access.priorityLevel = 'high';
        basePermissions.rateLimit.requestsPerMinute = 2000;
        basePermissions.dataAccess.read.push(
          'official_data',
          'regulatory_data'
        );
        break;

      case 'research':
        basePermissions.dataAccess.read.push(
          'research_data',
          'historical_data'
        );
        basePermissions.layer2Access.maxTPS = Math.min(
          basePermissions.layer2Access.maxTPS,
          15000
        );
        break;

      case 'enterprise':
        basePermissions.layer2Access.priorityLevel = 'high';
        basePermissions.rateLimit.requestsPerDay = 5000000;
        basePermissions.testingAccess.productionTesting = true;
        break;
    }

    return basePermissions;
  }

  private calculateScopes(application: PartnerApplication): string[] {
    const scopes = ['basic_access'];

    // Add scopes based on integration types
    if (
      application.technicalRequirements.integrationTypes.includes('real_time')
    ) {
      scopes.push('real_time_data');
    }

    if (
      application.technicalRequirements.integrationTypes.includes(
        'batch_processing'
      )
    ) {
      scopes.push('batch_processing');
    }

    if (
      application.technicalRequirements.integrationTypes.includes('cross_chain')
    ) {
      scopes.push('cross_chain_access');
    }

    // Add Layer 2 access scope
    scopes.push('layer2_access');

    return scopes;
  }

  private generateAccessToken(
    partnerId: string,
    permissions: PartnerPermissions
  ): string {
    const payload = {
      partnerId,
      permissions,
      type: 'access_token',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
    };

    return jwt.sign(payload, this.JWT_SECRET, { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
  }

  private findPartnerByApiKey(apiKey: string): string | null {
    for (const [partnerId, credentials] of this.credentials.entries()) {
      if (credentials.apiKey === apiKey) {
        return partnerId;
      }
    }
    return null;
  }

  private async validateApplication(
    application: PartnerApplication
  ): Promise<void> {
    const validationErrors: string[] = [];

    // Validate required fields
    if (!application.companyName || application.companyName.length < 3) {
      validationErrors.push('Company name must be at least 3 characters');
    }

    if (
      !application.contactPerson.email ||
      !this.isValidEmail(application.contactPerson.email)
    ) {
      validationErrors.push('Valid contact email is required');
    }

    if (
      !application.technicalRequirements.expectedTPS ||
      application.technicalRequirements.expectedTPS < 100
    ) {
      validationErrors.push('Expected TPS must be at least 100');
    }

    if (application.technicalRequirements.expectedTPS > 100000) {
      validationErrors.push(
        'Expected TPS cannot exceed 100,000 for initial onboarding'
      );
    }

    if (validationErrors.length > 0) {
      throw new Error(`Validation failed: ${validationErrors.join(', ')}`);
    }
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private defineOnboardingPipeline(): void {
    // This would be implemented to define the standard onboarding stages
    // and their requirements
  }

  private async initializeOnboardingForApplication(
    applicationId: string
  ): Promise<void> {
    const stages: OnboardingStage[] = [
      {
        stage: 'business_verification',
        name: 'Business Verification',
        description: 'Verify company registration and business details',
        status: 'pending',
        requirements: [
          'Valid business registration',
          'Company website verification',
          'Contact person verification',
        ],
        validations: [],
      },
      {
        stage: 'technical_review',
        name: 'Technical Requirements Review',
        description:
          'Review technical integration requirements and capabilities',
        status: 'pending',
        requirements: [
          'Technical architecture review',
          'API endpoint validation',
          'Security assessment',
        ],
        validations: [],
      },
      {
        stage: 'compliance_check',
        name: 'Compliance and Security Check',
        description: 'Verify compliance certifications and security standards',
        status: 'pending',
        requirements: [
          'Data privacy compliance verification',
          'Security certification review',
          'Audit report validation',
        ],
        validations: [],
      },
      {
        stage: 'integration_testing',
        name: 'Integration Testing',
        description: 'Perform integration testing with Layer 2 systems',
        status: 'pending',
        requirements: [
          'API connectivity testing',
          'Data exchange validation',
          'Performance testing',
        ],
        validations: [],
      },
    ];

    this.onboardingStages.set(applicationId, stages);
  }

  private startAutomatedReview(applicationId: string): void {
    // This would start automated review processes
    setTimeout(() => {
      const application = this.applications.get(applicationId);
      if (application) {
        application.status = 'under_review';
        this.emit('review_started', { applicationId });
      }
    }, 1000);
  }

  private async completeOnboardingStages(applicationId: string): Promise<void> {
    const stages = this.onboardingStages.get(applicationId);
    if (stages) {
      stages.forEach(stage => {
        stage.status = 'completed';
        stage.completedAt = new Date();
      });
    }
  }

  private calculateEstimatedCompletion(stages: OnboardingStage[]): Date {
    // Calculate estimated completion based on remaining stages
    const pendingStages = stages.filter(
      s => s.status === 'pending' || s.status === 'in_progress'
    ).length;
    const daysPerStage = 2; // Average 2 days per stage
    return new Date(
      Date.now() + pendingStages * daysPerStage * 24 * 60 * 60 * 1000
    );
  }

  private generateOnboardingInstructions(
    partnerId: string,
    application: PartnerApplication
  ): string[] {
    return [
      'Save your API credentials in a secure location',
      'Configure your systems to use the provided API endpoints',
      'Implement proper error handling and retry mechanisms',
      'Set up monitoring for your integration health',
      'Review the Layer 2 integration documentation',
      'Schedule initial performance testing with our team',
      'Join the partner portal for ongoing support and updates',
    ];
  }
}

export default PartnerOnboardingService;
