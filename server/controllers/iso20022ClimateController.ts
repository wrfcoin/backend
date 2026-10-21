import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { z } from 'zod';
import { ErrorContext } from '../services/iso20022-error-handler.js';
import ISO20022ClimateService from '../services/iso20022-climate-service.js';
import ISO20022Validator from '../services/iso20022-validator.js';
import ISO20022ErrorHandler from '../services/iso20022-error-handler.js';
import TCFDAnalyzer from '../services/tcfd-analyzer.js';
import TCFDReportGenerator from '../services/tcfd-report-generator.js';
import ClimateFinanceSecurity from '../services/climate-finance-security.js';

// =====================================================
// INPUT VALIDATION SCHEMAS (Zod)
// Security: Enhanced validation for ISO20022 climate finance operations
// =====================================================

// ISO20022 message types
const messageTypeSchema = z.enum([
  'climate_data_payment',
  'carbon_credit_transfer',
  'climate_fund_disbursement',
  'environmental_compliance_payment',
  'weather_data_validation_payment',
]);

// Security level validation
const securityLevelSchema = z.enum(['standard', 'enhanced', 'maximum']).optional();

// XML message validation - basic sanitization
const xmlMessageSchema = z.string()
  .min(1, 'XML message is required')
  .max(1048576, 'XML message exceeds maximum size (1MB)')
  .refine((val) => !/<script|javascript:|on\w+=/i.test(val), {
    message: 'XML message contains potentially malicious content',
  });

// Reporting period validation (YYYY-Q# format or YYYY-MM)
const reportingPeriodSchema = z.string()
  .min(4, 'Reporting period is required')
  .max(16, 'Reporting period too long')
  .regex(/^[0-9]{4}(-Q[1-4]|-[0-9]{2})?$/, 'Invalid reporting period format');

// Message ID validation
const messageIdSchema = z.string()
  .min(1, 'Message ID is required')
  .max(128, 'Message ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Message ID contains invalid characters');

// Array of message IDs
const messageIdsSchema = z.array(messageIdSchema)
  .min(1, 'At least one message ID is required')
  .max(1000, 'Too many message IDs');

// Report type validation
const reportTypeSchema = z.enum(['annual', 'quarterly', 'event_driven', 'regulatory_filing']).optional();

// Output formats validation
const outputFormatsSchema = z.array(
  z.enum(['pdf', 'html', 'json', 'xml'])
).optional();

// TCFD analysis request schema
const tcfdAnalysisSchema = z.object({
  messageIds: messageIdsSchema,
  analysisType: z.enum(['basic', 'comprehensive']).optional(),
});

// Mapping validation schema
const mappingValidationSchema = z.object({
  messageData: z.record(z.string(), z.unknown()).refine(
    (val) => Object.keys(val).length > 0,
    { message: 'Message data cannot be empty' }
  ),
  mappingId: z.string()
    .min(1, 'Mapping ID is required')
    .max(64, 'Mapping ID too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Mapping ID contains invalid characters'),
});

// Security incident types
const incidentTypeSchema = z.enum([
  'unauthorized_access',
  'data_breach',
  'encryption_failure',
  'signature_invalid',
]);

// Security incident schema
const securityIncidentSchema = z.object({
  incidentType: incidentTypeSchema,
  incidentDetails: z.string()
    .min(1, 'Incident details are required')
    .max(4096, 'Incident details too long'),
  resourceId: z.string()
    .min(1, 'Resource ID is required')
    .max(128, 'Resource ID too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Resource ID contains invalid characters'),
});

// Key rotation schema
const keyRotationSchema = z.object({
  resourceType: z.enum(['message', 'report', 'transaction']),
  resourceId: z.string()
    .min(1, 'Resource ID is required')
    .max(128, 'Resource ID too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Resource ID contains invalid characters'),
  forceRotation: z.boolean().optional(),
});

// Utility function to safely extract error message from unknown error type
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message);
  }
  return 'Unknown error occurred';
}

/**
 * Controller for ISO20022 Climate Finance Operations
 * Handles institutional-grade climate finance message processing with TCFD compliance
 */
export class ISO20022ClimateController {
  private iso20022Service: ISO20022ClimateService;
  private validator: ISO20022Validator;
  private errorHandler: ISO20022ErrorHandler;
  private tcfdAnalyzer: TCFDAnalyzer;
  private reportGenerator: TCFDReportGenerator;
  private security: ClimateFinanceSecurity;

  constructor() {
    const databaseUrl =
      process.env.DATABASE_URL || 'postgresql://localhost:5432/wrfcoin';

    this.iso20022Service = new ISO20022ClimateService(databaseUrl);
    this.validator = new ISO20022Validator(databaseUrl);
    this.errorHandler = new ISO20022ErrorHandler(databaseUrl);
    this.tcfdAnalyzer = new TCFDAnalyzer(databaseUrl);
    this.reportGenerator = new TCFDReportGenerator(databaseUrl);
    this.security = new ClimateFinanceSecurity(databaseUrl);
  }

  /**
   * Process incoming ISO20022 climate finance message
   */
  async processClimateMessage(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const { xmlMessage, messageType, securityLevel = 'standard' } = req.body;

      // Create processing context
      const context: ErrorContext = {
        messageId: '', // Will be set after parsing
        messageType,
        processingStage: 'parsing',
        systemInfo: {
          nodeId: process.env.NODE_ID || 'wrfcoin-node-1',
          version: '1.0.0',
          timestamp: new Date(),
        },
      };

      try {
        // 1. Parse ISO20022 message
        const parsedMessage =
          await this.iso20022Service.parseISO20022Message(xmlMessage);
        context.messageId = parsedMessage.messageId;

        // 2. Validate message
        context.processingStage = 'validation';
        const validationResult = await this.validator.validateMessage(
          parsedMessage,
          messageType
        );

        if (!validationResult.isValid) {
          const errorResponse = await this.errorHandler.handleValidationError(
            validationResult,
            context
          );

          res.status(400).json({
            success: false,
            error: 'Message validation failed',
            validationResults: validationResult,
            requiredActions: errorResponse.requiredActions,
            warnings: errorResponse.warnings,
          });
          return;
        }

        // 3. Apply security measures
        context.processingStage = 'security_validation';
        const securityContext = {
          resourceType: 'message' as const,
          resourceId: parsedMessage.messageId,
          securityLevel: securityLevel as 'standard' | 'enhanced' | 'maximum',
          dataClassification: this.determineDataClassification(parsedMessage),
          regulatoryRequirements: ['ISO20022', 'TCFD'],
          accessControlList: [req.ip || 'unknown'],
        };

        // Encrypt sensitive data if required
        let encryptionResult;
        if (this.requiresEncryption(parsedMessage, securityLevel)) {
          const messageData = JSON.stringify(parsedMessage);
          encryptionResult = await this.security.encryptData(
            messageData,
            securityContext
          );
        }

        // Create digital signature
        const signatureResult = await this.security.createDigitalSignature(
          JSON.stringify(parsedMessage),
          securityContext
        );

        // 4. Store message with security
        context.processingStage = 'database_storage';
        const messageId = await this.iso20022Service.storeMessage(
          {
            ...parsedMessage,
            digitalSignature: signatureResult.signature.toString('base64'),
            encryptionDetails: encryptionResult?.encryptionMetadata,
          },
          validationResult
        );

        // 5. Process for TCFD reporting
        context.processingStage = 'tcfd_mapping';
        await this.iso20022Service.processForTCFDReporting(
          parsedMessage.messageId
        );

        // Log successful processing
        await this.errorHandler.logSecurityEvent(
          'process_climate_message',
          {
            status: 'success',
            messageId,
            validationScore: validationResult.complianceScore,
          },
          context
        );

        res.status(201).json({
          success: true,
          data: {
            messageId: parsedMessage.messageId,
            status: 'processed',
            validationResults: validationResult,
            securityId: encryptionResult?.securityId,
            tcfdAlignment: parsedMessage.tcfdPillarAlignment,
            processingTime: new Date().toISOString(),
          },
        });
      } catch (processingError) {
        // Handle processing errors
        const { handled, recoveryAction, errorId } =
          await this.errorHandler.handleError(
            processingError as Error,
            context
          );

        await this.errorHandler.logSecurityEvent(
          'process_climate_message',
          {
            status: 'failure',
            errorId,
            recoveryAction,
          },
          context
        );

        res.status(500).json({
          success: false,
          error: 'Message processing failed',
          errorId,
          recoveryAction,
          handled,
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'System error',
        message: getErrorMessage(error),
      });
    }
  }

  /**
   * Generate TCFD report from processed messages
   */
  async generateTCFDReport(req: Request, res: Response): Promise<void> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
        });
        return;
      }

      const {
        reportingPeriod,
        messageIds,
        reportType = 'quarterly',
        outputFormats = ['json'],
        includeAnalytics = true,
      } = req.body;

      // Configure report generation
      const reportConfig = {
        reportType: reportType as
          | 'annual'
          | 'quarterly'
          | 'event_driven'
          | 'regulatory_filing',
        reportingPeriod,
        reportingEntity: {
          name: 'Wrfcoin Climate Finance Platform',
          identifier: 'WRFCOIN-001',
          jurisdiction: 'GLOBAL',
          businessDescription:
            'Blockchain-based climate finance and data platform',
        },
        scope: {
          includeSubsidiaries: false,
          geographicScope: ['GLOBAL'],
          businessSegments: [
            'Climate Finance',
            'Weather Data',
            'Carbon Credits',
          ],
        },
        frameworkAlignment: {
          tcfdRecommendations: true,
          sasb: false,
          gri: false,
        },
        outputFormats: outputFormats as ('pdf' | 'html' | 'json' | 'xml')[],
        customizations: {
          includeGraphics: true,
          includeAppendices: true,
          detailLevel: 'detailed' as const,
        },
      };

      // Map data to TCFD structure
      const dataMapping = await this.reportGenerator.mapDataToTCFD(
        messageIds,
        reportingPeriod
      );

      // Generate comprehensive report
      const reportResult = await this.reportGenerator.generateTCFDReport(
        reportConfig,
        dataMapping
      );

      // Include analytics if requested
      let analytics;
      if (includeAnalytics) {
        analytics = await this.generateReportAnalytics(
          reportResult.reportData,
          reportingPeriod
        );
      }

      res.status(200).json({
        success: true,
        data: {
          reportId: reportResult.reportId,
          reportData: reportResult.reportData,
          validationResults: reportResult.validationResults,
          complianceAssessment: reportResult.complianceAssessment,
          outputs: reportResult.outputs.map(output => ({
            format: output.format,
            path: output.path,
            size: output.content.length,
          })),
          analytics,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Report generation failed',
        message: getErrorMessage(error),
      });
    }
  }

  /**
   * Analyze TCFD compliance for messages
   */
  async analyzeTCFDCompliance(req: Request, res: Response): Promise<void> {
    try {
      // SECURITY: Validate input using zod schema
      const zodValidation = tcfdAnalysisSchema.safeParse(req.body);
      if (!zodValidation.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: zodValidation.error.issues.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
        return;
      }

      const { messageIds, analysisType = 'comprehensive' } = zodValidation.data;

      // Perform TCFD requirements analysis
      const requirementsAnalysis =
        await this.tcfdAnalyzer.analyzeTCFDRequirements();

      // Assess climate risks and opportunities
      const riskAssessment = await this.tcfdAnalyzer.assessClimateRisks(
        { businessType: 'climate_finance' },
        ['GLOBAL'],
        ['short', 'medium', 'long']
      );

      // Perform scenario analysis
      const scenarioAnalysis = await this.tcfdAnalyzer.performScenarioAnalysis(
        ['1.5C', '2C', '4C'],
        { businessType: 'climate_finance' },
        ['2030', '2040', '2050']
      );

      // Map messages to TCFD disclosures
      const tcfdMapping = await this.tcfdAnalyzer.mapMessagesToTCFD(
        messageIds,
        this.getCurrentReportingPeriod()
      );

      res.status(200).json({
        success: true,
        data: {
          requirementsAnalysis,
          riskAssessment,
          scenarioAnalysis,
          tcfdMapping,
          analysisDate: new Date().toISOString(),
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'TCFD analysis failed',
        message: getErrorMessage(error),
      });
    }
  }

  /**
   * Validate message against custom mapping rules
   */
  async validateWithMapping(req: Request, res: Response): Promise<void> {
    try {
      // SECURITY: Validate input using zod schema
      const zodValidation = mappingValidationSchema.safeParse(req.body);
      if (!zodValidation.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: zodValidation.error.issues.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
        return;
      }

      const { messageData, mappingId } = zodValidation.data;

      const validationResult = await this.validator.validateAgainstMappingRules(
        messageData,
        mappingId
      );

      res.status(200).json({
        success: true,
        data: validationResult,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Mapping validation failed',
        message: getErrorMessage(error),
      });
    }
  }

  /**
   * Handle security incidents
   */
  async handleSecurityIncident(req: Request, res: Response): Promise<void> {
    try {
      // SECURITY: Validate input using zod schema
      const zodValidation = securityIncidentSchema.safeParse(req.body);
      if (!zodValidation.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: zodValidation.error.issues.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
        return;
      }

      const { incidentType, incidentDetails, resourceId } = zodValidation.data;

      const context = {
        messageId: resourceId,
        messageType: 'security_incident',
        processingStage: 'security_validation' as const,
        systemInfo: {
          nodeId: process.env.NODE_ID || 'wrfcoin-node-1',
          version: '1.0.0',
          timestamp: new Date(),
        },
      };

      const securityContext = {
        resourceType: 'message' as const,
        resourceId,
        securityLevel: 'maximum' as const,
        dataClassification: 'restricted' as const,
        regulatoryRequirements: ['SECURITY_INCIDENT'],
        accessControlList: [req.ip || 'unknown'],
      };

      const incidentResponse = await this.errorHandler.handleSecurityIncident(
        incidentType,
        incidentDetails,
        context
      );

      res.status(200).json({
        success: true,
        data: {
          severity: incidentResponse.severity,
          immediateActions: incidentResponse.immediateActions,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Security incident handling failed',
        message: getErrorMessage(error),
      });
    }
  }

  /**
   * Rotate encryption keys
   */
  async rotateKeys(req: Request, res: Response): Promise<void> {
    try {
      // SECURITY: Validate input using zod schema
      const zodValidation = keyRotationSchema.safeParse(req.body);
      if (!zodValidation.success) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: zodValidation.error.issues.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
        return;
      }

      const { resourceType, resourceId, forceRotation = false } = zodValidation.data;

      const securityContext = {
        resourceType: resourceType as 'message' | 'report' | 'transaction',
        resourceId,
        securityLevel: 'enhanced' as const,
        dataClassification: 'confidential' as const,
        regulatoryRequirements: ['KEY_MANAGEMENT'],
        accessControlList: [req.ip || 'unknown'],
      };

      const rotationResult = await this.security.rotateKeys(
        securityContext,
        forceRotation
      );

      res.status(200).json({
        success: true,
        data: rotationResult,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Key rotation failed',
        message: getErrorMessage(error),
      });
    }
  }

  // Helper methods
  private determineDataClassification(
    parsedMessage: any
  ): 'public' | 'internal' | 'confidential' | 'restricted' {
    const amount = parseFloat(parsedMessage.principalAmount || '0');

    if (amount > 1000000) return 'restricted';
    if (amount > 100000) return 'confidential';
    if (parsedMessage.carbonCreditRegistryId) return 'confidential';

    return 'internal';
  }

  private requiresEncryption(
    parsedMessage: any,
    securityLevel: string
  ): boolean {
    const amount = parseFloat(parsedMessage.principalAmount || '0');

    return (
      securityLevel === 'maximum' ||
      amount > 100000 ||
      parsedMessage.messageType === 'carbon_credit_transfer'
    );
  }

  private async generateReportAnalytics(
    reportData: any,
    reportingPeriod: string
  ): Promise<any> {
    return {
      dataCoverage: {
        governance: this.calculateDataCompleteness(reportData.governance),
        strategy: this.calculateDataCompleteness(reportData.strategy),
        riskManagement: this.calculateDataCompleteness(
          reportData.riskManagement
        ),
        metricsTargets: this.calculateDataCompleteness(
          reportData.metricsTargets
        ),
      },
      trends: {
        messageVolume: await this.getMessageVolumeTrend(reportingPeriod),
        complianceScore: await this.getComplianceScoreTrend(reportingPeriod),
        dataQuality: await this.getDataQualityTrend(reportingPeriod),
      },
      recommendations: [
        'Enhance climate risk disclosure',
        'Improve scenario analysis depth',
        'Increase emissions data granularity',
      ],
    };
  }

  private calculateDataCompleteness(data: any): number {
    if (!data || typeof data !== 'object') return 0;

    const fields = Object.keys(data);
    const populatedFields = fields.filter(
      field =>
        data[field] !== null && data[field] !== undefined && data[field] !== ''
    );

    return fields.length > 0 ? populatedFields.length / fields.length : 0;
  }

  private async getMessageVolumeTrend(reportingPeriod: string): Promise<any> {
    // Implementation would query database for trend data
    return { trend: 'increasing', change: '+15%' };
  }

  private async getComplianceScoreTrend(reportingPeriod: string): Promise<any> {
    // Implementation would query database for compliance trend
    return { trend: 'improving', averageScore: 85 };
  }

  private async getDataQualityTrend(reportingPeriod: string): Promise<any> {
    // Implementation would query database for data quality trend
    return { trend: 'stable', qualityScore: 0.92 };
  }

  private getCurrentReportingPeriod(): string {
    const now = new Date();
    const year = now.getFullYear();
    const quarter = Math.ceil((now.getMonth() + 1) / 3);
    return `${year}-Q${quarter}`;
  }
}

// Validation middleware
export const validateClimateMessage = [
  body('xmlMessage').notEmpty().withMessage('XML message is required'),
  body('messageType')
    .isIn([
      'climate_data_payment',
      'carbon_credit_transfer',
      'climate_fund_disbursement',
      'environmental_compliance_payment',
      'weather_data_validation_payment',
    ])
    .withMessage('Invalid message type'),
  body('securityLevel').optional().isIn(['standard', 'enhanced', 'maximum']),
];

export const validateTCFDReport = [
  body('reportingPeriod')
    .notEmpty()
    .withMessage('Reporting period is required'),
  body('messageIds').isArray().withMessage('Message IDs must be an array'),
  body('reportType')
    .optional()
    .isIn(['annual', 'quarterly', 'event_driven', 'regulatory_filing']),
  body('outputFormats').optional().isArray(),
];

export const validateTCFDAnalysis = [
  body('messageIds').isArray().withMessage('Message IDs must be an array'),
  body('analysisType').optional().isIn(['basic', 'comprehensive']),
];

export const validateMappingValidation = [
  body('messageData').notEmpty().withMessage('Message data is required'),
  body('mappingId').notEmpty().withMessage('Mapping ID is required'),
];

export const validateSecurityIncident = [
  body('incidentType')
    .isIn([
      'unauthorized_access',
      'data_breach',
      'encryption_failure',
      'signature_invalid',
    ])
    .withMessage('Invalid incident type'),
  body('incidentDetails')
    .notEmpty()
    .withMessage('Incident details are required'),
  body('resourceId').notEmpty().withMessage('Resource ID is required'),
];

export const validateKeyRotation = [
  body('resourceType')
    .isIn(['message', 'report', 'transaction'])
    .withMessage('Invalid resource type'),
  body('resourceId').notEmpty().withMessage('Resource ID is required'),
  body('forceRotation').optional().isBoolean(),
];

export default ISO20022ClimateController;
