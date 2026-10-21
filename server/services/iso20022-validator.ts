import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import {
  iso20022ClimateMessages,
  climateFinanceDataMapping,
  regulatoryCompliance,
  ISO20022_CLIMATE_MESSAGE_TYPES,
  TCFD_PILLAR_TYPES,
  TCFD_DISCLOSURE_CATEGORIES,
} from '../shared/schema-iso20022-climate.js';
const { getSharedPgPool } = require('../utils/shared-pg-pool.js');

// Validation schemas for different message types
const FinancialTransactionSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().length(3, 'Currency must be 3-character ISO code'),
  valueDate: z.string().optional(),
  instructionId: z.string().min(1, 'Instruction ID is required'),
});

const PartySchema = z.object({
  name: z.string().min(1, 'Party name is required'),
  identifier: z.string().min(1, 'Party identifier is required'),
  bicFi: z.string().optional(),
  address: z
    .object({
      streetName: z.string().optional(),
      buildingNumber: z.string().optional(),
      townName: z.string().optional(),
      country: z
        .string()
        .length(2, 'Country must be 2-character ISO code')
        .optional(),
    })
    .optional(),
});

const ClimateFinanceSchema = z.object({
  projectType: z.enum(['mitigation', 'adaptation', 'mixed']).optional(),
  sectorCode: z.string().optional(),
  carbonCredits: z
    .object({
      registryId: z.string(),
      serialNumber: z.string(),
      quantity: z.number().positive(),
      vintage: z.number().int().min(2000).max(2100),
    })
    .optional(),
  environmentalStandards: z.array(z.string()).optional(),
  sdgAlignment: z.array(z.number().int().min(1).max(17)).optional(),
});

const TCFDDataSchema = z.object({
  pillar: z.enum(TCFD_PILLAR_TYPES).optional(),
  disclosureCategory: z.enum(TCFD_DISCLOSURE_CATEGORIES).optional(),
  climateScenariosUsed: z.array(z.string()).optional(),
  timeHorizon: z.enum(['short', 'medium', 'long']).optional(),
  financialImpact: z
    .object({
      quantified: z.boolean(),
      amount: z.number().optional(),
      currency: z.string().optional(),
      methodology: z.string().optional(),
    })
    .optional(),
});

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  complianceScore: number;
  requiredActions: string[];
}

export interface ValidationError {
  code: string;
  message: string;
  field?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'schema' | 'business' | 'regulatory' | 'security';
}

export interface ValidationWarning {
  code: string;
  message: string;
  field?: string;
  recommendation: string;
}

export interface ValidationRule {
  code: string;
  messageType: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  validate: (
    data: any
  ) => Promise<{
    isValid: boolean;
    message: string;
    field?: string;
    warnings?: ValidationWarning[];
  }>;
  errorMessage: string;
}

export class ISO20022Validator {
  private db: any;
  private validationRules: Map<string, ValidationRule[]> = new Map();

  constructor(databaseUrl: string) {
    const pool = getSharedPgPool(
      { connectionString: databaseUrl },
      { poolName: 'iso20022-validator' }
    );
    this.db = drizzle(pool);
    this.initializeValidationRules();
  }

  /**
   * Comprehensive validation of ISO20022 climate finance message
   */
  async validateMessage(
    messageData: any,
    messageType: string
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // 1. Schema validation
      await this.performSchemaValidation(
        messageData,
        messageType,
        errors,
        warnings
      );

      // 2. Business rules validation
      await this.performBusinessRulesValidation(
        messageData,
        messageType,
        errors,
        warnings
      );

      // 3. Climate finance specific validation
      await this.performClimateFinanceValidation(messageData, errors, warnings);

      // 4. TCFD compliance validation
      await this.performTCFDValidation(messageData, errors, warnings);

      // 5. Regulatory compliance validation
      await this.performRegulatoryValidation(
        messageData,
        messageType,
        errors,
        warnings
      );

      // 6. Security validation
      await this.performSecurityValidation(messageData, errors, warnings);

      // 7. Data quality assessment
      await this.performDataQualityValidation(messageData, warnings);

      // Calculate compliance score
      const complianceScore = this.calculateComplianceScore(errors, warnings);

      // Generate required actions
      const requiredActions = this.generateRequiredActions(errors, warnings);

      return {
        isValid:
          errors.filter(e => e.severity === 'critical' || e.severity === 'high')
            .length === 0,
        errors,
        warnings,
        complianceScore,
        requiredActions,
      };
    } catch (error) {
      errors.push({
        code: 'VALIDATION_SYSTEM_ERROR',
        message: `Validation system error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'critical',
        category: 'schema',
      });

      return {
        isValid: false,
        errors,
        warnings,
        complianceScore: 0,
        requiredActions: ['Fix validation system error before reprocessing'],
      };
    }
  }

  /**
   * Validate message against dynamic mapping rules
   */
  async validateAgainstMappingRules(
    messageData: any,
    mappingId: string
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // Retrieve mapping configuration
      const [mapping] = await this.db
        .select()
        .from(climateFinanceDataMapping as any)
        .where(eq((climateFinanceDataMapping as any).mappingId, mappingId))
        .limit(1);

      if (!mapping) {
        errors.push({
          code: 'MAPPING_NOT_FOUND',
          message: `Mapping configuration not found: ${mappingId}`,
          severity: 'critical',
          category: 'business',
        });
        return {
          isValid: false,
          errors,
          warnings,
          complianceScore: 0,
          requiredActions: [],
        };
      }

      // Validate against mapping field requirements
      await this.validateMappingFields(messageData, mapping, errors, warnings);

      // Validate transformation rules
      await this.validateTransformationRules(
        messageData,
        mapping,
        errors,
        warnings
      );

      // Validate business rules specific to this mapping
      await this.validateMappingBusinessRules(
        messageData,
        mapping,
        errors,
        warnings
      );

      const complianceScore = this.calculateComplianceScore(errors, warnings);
      const requiredActions = this.generateRequiredActions(errors, warnings);

      return {
        isValid:
          errors.filter(e => e.severity === 'critical' || e.severity === 'high')
            .length === 0,
        errors,
        warnings,
        complianceScore,
        requiredActions,
      };
    } catch (error) {
      errors.push({
        code: 'MAPPING_VALIDATION_ERROR',
        message: `Mapping validation error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'critical',
        category: 'business',
      });

      return {
        isValid: false,
        errors,
        warnings,
        complianceScore: 0,
        requiredActions: [],
      };
    }
  }

  /**
   * Real-time validation with streaming support
   */
  async validateStream(
    messageStream: any,
    callback: (result: ValidationResult) => void
  ): Promise<void> {
    // Implementation for streaming validation
    // This would be used for high-volume message processing

    for await (const message of messageStream) {
      const result = await this.validateMessage(message.data, message.type);
      callback(result);
    }
  }

  // Private validation methods
  private async performSchemaValidation(
    messageData: any,
    messageType: string,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Validate basic structure
    if (!messageData.messageId) {
      errors.push({
        code: 'MISSING_MESSAGE_ID',
        message: 'Message ID is required',
        field: 'messageId',
        severity: 'critical',
        category: 'schema',
      });
    }

    // Validate financial transaction data
    if (messageData.financialInfo) {
      const financialResult = FinancialTransactionSchema.safeParse(
        messageData.financialInfo
      );
      if (!financialResult.success) {
        financialResult.error.issues.forEach(issue => {
          errors.push({
            code: 'FINANCIAL_SCHEMA_ERROR',
            message: issue.message,
            field: `financialInfo.${issue.path.join('.')}`,
            severity: 'high',
            category: 'schema',
          });
        });
      }
    }

    // Validate party information
    if (messageData.debtorInfo) {
      const debtorResult = PartySchema.safeParse(messageData.debtorInfo);
      if (!debtorResult.success) {
        debtorResult.error.issues.forEach(issue => {
          errors.push({
            code: 'DEBTOR_SCHEMA_ERROR',
            message: issue.message,
            field: `debtorInfo.${issue.path.join('.')}`,
            severity: 'high',
            category: 'schema',
          });
        });
      }
    }

    if (messageData.creditorInfo) {
      const creditorResult = PartySchema.safeParse(messageData.creditorInfo);
      if (!creditorResult.success) {
        creditorResult.error.issues.forEach(issue => {
          errors.push({
            code: 'CREDITOR_SCHEMA_ERROR',
            message: issue.message,
            field: `creditorInfo.${issue.path.join('.')}`,
            severity: 'high',
            category: 'schema',
          });
        });
      }
    }
  }

  private async performBusinessRulesValidation(
    messageData: any,
    messageType: string,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Get business rules for this message type
    const rules = this.validationRules.get(messageType) || [];

    for (const rule of rules) {
      try {
        const ruleResult = await rule.validate(messageData);
        if (!ruleResult.isValid) {
          errors.push({
            code: rule.code,
            message: ruleResult.message,
            field: ruleResult.field,
            severity: rule.severity,
            category: 'business',
          });
        }

        if (ruleResult.warnings) {
          warnings.push(...ruleResult.warnings);
        }
      } catch (error) {
        errors.push({
          code: 'BUSINESS_RULE_ERROR',
          message: `Business rule validation failed: ${error instanceof Error ? error.message : String(error)}`,
          severity: 'medium',
          category: 'business',
        });
      }
    }

    // Common business rules
    await this.validateCommonBusinessRules(messageData, errors, warnings);
  }

  private async performClimateFinanceValidation(
    messageData: any,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    if (messageData.climateFinanceData) {
      const climateResult = ClimateFinanceSchema.safeParse(
        messageData.climateFinanceData
      );
      if (!climateResult.success) {
        climateResult.error.issues.forEach(issue => {
          warnings.push({
            code: 'CLIMATE_FINANCE_WARNING',
            message: issue.message,
            field: `climateFinanceData.${issue.path.join('.')}`,
            recommendation:
              'Ensure climate finance data meets environmental standards',
          });
        });
      }
    }

    // Validate environmental certifications
    if (messageData.environmentalCertification) {
      await this.validateEnvironmentalCertifications(
        messageData.environmentalCertification,
        warnings
      );
    }

    // Validate carbon credit information
    if (messageData.carbonCreditRegistryId) {
      await this.validateCarbonCredits(messageData, errors, warnings);
    }
  }

  private async performTCFDValidation(
    messageData: any,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    if (messageData.tcfdData) {
      const tcfdResult = TCFDDataSchema.safeParse(messageData.tcfdData);
      if (!tcfdResult.success) {
        tcfdResult.error.issues.forEach(issue => {
          warnings.push({
            code: 'TCFD_COMPLIANCE_WARNING',
            message: issue.message,
            field: `tcfdData.${issue.path.join('.')}`,
            recommendation:
              'Align with TCFD recommendations for better disclosure',
          });
        });
      }
    }

    // Check TCFD pillar alignment
    if (messageData.tcfdPillarAlignment) {
      await this.validateTCFDPillarAlignment(messageData, warnings);
    }
  }

  private async performRegulatoryValidation(
    messageData: any,
    messageType: string,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Check against known regulatory frameworks
    const regulatoryFrameworks = [
      'TCFD',
      'SFDR',
      'SEC_CLIMATE',
      'CFTC_CLIMATE',
    ];

    for (const framework of regulatoryFrameworks) {
      const complianceResult = await this.checkRegulatoryCompliance(
        messageData,
        framework
      );

      if (!complianceResult.isCompliant) {
        if (complianceResult.mandatory) {
          errors.push({
            code: `${framework}_NON_COMPLIANCE`,
            message: complianceResult.message,
            severity: 'high',
            category: 'regulatory',
          });
        } else {
          warnings.push({
            code: `${framework}_COMPLIANCE_WARNING`,
            message: complianceResult.message,
            recommendation: complianceResult.recommendation,
          });
        }
      }
    }
  }

  private async performSecurityValidation(
    messageData: any,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Check for PII and sensitive data
    if (this.containsPII(messageData)) {
      warnings.push({
        code: 'PII_DETECTED',
        message: 'Message contains personally identifiable information',
        recommendation:
          'Ensure proper encryption and access controls are applied',
      });
    }

    // Check for proper encryption markers
    if (
      !messageData.encryptionDetails &&
      this.requiresEncryption(messageData)
    ) {
      errors.push({
        code: 'ENCRYPTION_REQUIRED',
        message: 'Message requires encryption but none is specified',
        severity: 'high',
        category: 'security',
      });
    }

    // Validate digital signature requirements
    if (
      !messageData.digitalSignature &&
      this.requiresDigitalSignature(messageData)
    ) {
      errors.push({
        code: 'SIGNATURE_REQUIRED',
        message: 'Message requires digital signature',
        severity: 'high',
        category: 'security',
      });
    }
  }

  private async performDataQualityValidation(
    messageData: any,
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Check data completeness
    const completenessScore = this.calculateDataCompleteness(messageData);
    if (completenessScore < 0.8) {
      warnings.push({
        code: 'DATA_COMPLETENESS_LOW',
        message: `Data completeness score: ${Math.round(completenessScore * 100)}%`,
        recommendation:
          'Provide more complete data for better processing and reporting',
      });
    }

    // Check data consistency
    const consistencyIssues = this.checkDataConsistency(messageData);
    consistencyIssues.forEach(issue => {
      warnings.push({
        code: 'DATA_CONSISTENCY_ISSUE',
        message: issue.message,
        field: issue.field,
        recommendation: issue.recommendation,
      });
    });
  }

  private initializeValidationRules(): void {
    this.validationRules = new Map();

    // Climate data payment rules
    this.validationRules.set('climate_data_payment', [
      {
        code: 'CLIMATE_AMOUNT_THRESHOLD',
        messageType: 'climate_data_payment',
        severity: 'medium' as const,
        errorMessage: 'Climate data payments should typically be above $1,000',
        validate: async data => ({
          isValid: parseFloat(data.principalAmount) >= 1000,
          message: 'Climate data payments should typically be above $1,000',
          field: 'principalAmount',
        }),
      },
    ]);

    // Carbon credit transfer rules
    this.validationRules.set('carbon_credit_transfer', [
      {
        code: 'CARBON_CREDIT_REGISTRY',
        messageType: 'carbon_credit_transfer',
        severity: 'high' as const,
        errorMessage: 'Carbon credit transfers must include registry ID',
        validate: async data => ({
          isValid: !!data.carbonCreditRegistryId,
          message: 'Carbon credit transfers must include registry ID',
          field: 'carbonCreditRegistryId',
        }),
      },
    ]);
  }

  private async validateCommonBusinessRules(
    messageData: any,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Settlement date validation
    if (messageData.settlementDate) {
      const settlementDate = new Date(messageData.settlementDate);
      const today = new Date();

      if (settlementDate < today) {
        warnings.push({
          code: 'PAST_SETTLEMENT_DATE',
          message: 'Settlement date is in the past',
          field: 'settlementDate',
          recommendation: 'Verify settlement date is correct',
        });
      }
    }

    // Currency code validation
    const validCurrencies = [
      'USD',
      'EUR',
      'GBP',
      'JPY',
      'CHF',
      'CAD',
      'AUD',
      'CNY',
    ];
    if (
      messageData.currency &&
      !validCurrencies.includes(messageData.currency)
    ) {
      warnings.push({
        code: 'UNUSUAL_CURRENCY',
        message: `Unusual currency code: ${messageData.currency}`,
        field: 'currency',
        recommendation: 'Verify currency code is correct',
      });
    }
  }

  private calculateComplianceScore(
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): number {
    let score = 100;

    // Deduct points for errors based on severity
    errors.forEach(error => {
      switch (error.severity) {
        case 'critical':
          score -= 25;
          break;
        case 'high':
          score -= 15;
          break;
        case 'medium':
          score -= 10;
          break;
        case 'low':
          score -= 5;
          break;
      }
    });

    // Deduct points for warnings
    score -= warnings.length * 2;

    return Math.max(0, score);
  }

  private generateRequiredActions(
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): string[] {
    const actions: string[] = [];

    // Critical and high errors require immediate action
    const criticalErrors = errors.filter(
      e => e.severity === 'critical' || e.severity === 'high'
    );
    if (criticalErrors.length > 0) {
      actions.push('Fix critical validation errors before processing');
    }

    // Security-related actions
    const securityErrors = errors.filter(e => e.category === 'security');
    if (securityErrors.length > 0) {
      actions.push('Address security requirements');
    }

    // Regulatory compliance actions
    const regulatoryErrors = errors.filter(e => e.category === 'regulatory');
    if (regulatoryErrors.length > 0) {
      actions.push('Ensure regulatory compliance requirements are met');
    }

    return actions;
  }

  // Helper methods for specific validations
  private containsPII(messageData: any): boolean {
    const piiPatterns = [
      /\b\d{3}-\d{2}-\d{4}\b/, // SSN
      /\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/, // Credit card
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // Email
    ];

    const dataString = JSON.stringify(messageData);
    return piiPatterns.some(pattern => pattern.test(dataString));
  }

  private requiresEncryption(messageData: any): boolean {
    // Determine if message requires encryption based on content
    return (
      parseFloat(messageData.principalAmount) > 100000 ||
      this.containsPII(messageData) ||
      messageData.messageType === 'carbon_credit_transfer'
    );
  }

  private requiresDigitalSignature(messageData: any): boolean {
    // Determine if message requires digital signature
    return (
      parseFloat(messageData.principalAmount) > 50000 ||
      messageData.messageType === 'carbon_credit_transfer' ||
      messageData.messageType === 'climate_fund_disbursement'
    );
  }

  private calculateDataCompleteness(messageData: any): number {
    const requiredFields = [
      'messageId',
      'messageType',
      'principalAmount',
      'currency',
      'debtorInfo.name',
      'creditorInfo.name',
      'messageTimestamp',
    ];

    const presentFields = requiredFields.filter(field => {
      const value = this.getNestedValue(messageData, field);
      return value !== undefined && value !== null && value !== '';
    });

    return presentFields.length / requiredFields.length;
  }

  private checkDataConsistency(messageData: any): any[] {
    const issues: any[] = [];

    // Check currency consistency
    if (messageData.currency !== messageData.feeAmount?.currency) {
      issues.push({
        message: 'Currency mismatch between principal amount and fees',
        field: 'currency',
        recommendation: 'Ensure consistent currency codes throughout message',
      });
    }

    return issues;
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  private async validateMappingFields(
    messageData: any,
    mapping: any,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Implementation for mapping-specific validation
    const fieldMappings = mapping.fieldMappings;

    // Check required fields based on mapping
    for (const [sourceField, targetField] of Object.entries(fieldMappings)) {
      if (!this.getNestedValue(messageData, sourceField as string)) {
        warnings.push({
          code: 'MAPPING_FIELD_MISSING',
          message: `Required field missing for mapping: ${sourceField}`,
          field: sourceField as string,
          recommendation: `Provide ${sourceField} to enable proper mapping to ${targetField}`,
        });
      }
    }
  }

  private async validateTransformationRules(
    messageData: any,
    mapping: any,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Implementation for transformation rule validation
    const transformationRules = mapping.transformationRules;

    if (transformationRules) {
      // Validate each transformation rule
      for (const rule of transformationRules) {
        // Implementation would depend on rule structure
      }
    }
  }

  private async validateMappingBusinessRules(
    messageData: any,
    mapping: any,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Implementation for mapping-specific business rules
    const businessRules = mapping.businessRules;

    if (businessRules) {
      // Validate each business rule
      for (const rule of businessRules) {
        // Implementation would depend on rule structure
      }
    }
  }

  private async validateEnvironmentalCertifications(
    certifications: any,
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Validate environmental certifications
    const knownStandards = ['VCS', 'CDM', 'GOLD_STANDARD', 'CAR', 'ACR'];

    if (typeof certifications === 'object') {
      Object.keys(certifications).forEach(cert => {
        if (!knownStandards.includes(cert)) {
          warnings.push({
            code: 'UNKNOWN_CERTIFICATION',
            message: `Unknown environmental certification: ${cert}`,
            recommendation: 'Verify certification is from recognized standard',
          });
        }
      });
    }
  }

  private async validateCarbonCredits(
    messageData: any,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Validate carbon credit specific requirements
    if (!messageData.environmentalCertification) {
      warnings.push({
        code: 'CARBON_CREDIT_NO_CERTIFICATION',
        message: 'Carbon credit transaction lacks environmental certification',
        recommendation:
          'Include environmental certification for carbon credit transfers',
      });
    }
  }

  private async validateTCFDPillarAlignment(
    messageData: any,
    warnings: ValidationWarning[]
  ): Promise<void> {
    // Validate TCFD pillar alignment
    const pillar = messageData.tcfdPillarAlignment;

    if (
      pillar === 'metrics_and_targets' &&
      !messageData.sustainabilityMetrics
    ) {
      warnings.push({
        code: 'TCFD_METRICS_MISSING',
        message: 'TCFD metrics pillar alignment without sustainability metrics',
        recommendation:
          'Include sustainability metrics for metrics and targets pillar',
      });
    }
  }

  private async checkRegulatoryCompliance(
    messageData: any,
    framework: string
  ): Promise<any> {
    // Check compliance with specific regulatory framework
    switch (framework) {
      case 'TCFD':
        return {
          isCompliant: !!messageData.tcfdPillarAlignment,
          mandatory: false,
          message: 'TCFD alignment recommended for climate finance',
          recommendation:
            'Align transaction with TCFD disclosure recommendations',
        };
      case 'SFDR':
        return {
          isCompliant: !!messageData.sustainabilityMetrics,
          mandatory: false,
          message: 'SFDR requires sustainability metrics',
          recommendation: 'Include sustainability metrics for SFDR compliance',
        };
      default:
        return { isCompliant: true, mandatory: false };
    }
  }
}

export default ISO20022Validator;
