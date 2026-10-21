import { relations } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uuid,
  decimal,
} from 'drizzle-orm/pg-core';

// ISO20022 Climate Finance Message Types
export const ISO20022_CLIMATE_MESSAGE_TYPES = [
  'climate_data_payment',
  'carbon_credit_transfer',
  'climate_fund_disbursement',
  'environmental_compliance_payment',
  'weather_data_validation_payment',
  'research_data_access_payment',
  'climate_emergency_funding',
  'green_bond_payment',
  'sustainability_incentive_payment',
  'climate_risk_insurance_payment',
] as const;

export const ISO20022_MESSAGE_STATUS = [
  'pending',
  'validated',
  'processed',
  'completed',
  'rejected',
  'returned',
  'cancelled',
] as const;

export const TCFD_PILLAR_TYPES = [
  'governance',
  'strategy',
  'risk_management',
  'metrics_and_targets',
] as const;

export const TCFD_DISCLOSURE_CATEGORIES = [
  'climate_related_risks_opportunities',
  'financial_impact_assessment',
  'scenario_analysis',
  'risk_management_processes',
  'climate_metrics',
  'emissions_data',
  'climate_targets',
  'transition_planning',
] as const;

// ISO20022 Climate Finance Messages
export const iso20022ClimateMessages = pgTable('iso20022_climate_messages', {
  id: serial('id').primaryKey(),
  messageId: text('message_id').notNull().unique(),

  // Message Classification
  messageType: text('message_type', {
    enum: ISO20022_CLIMATE_MESSAGE_TYPES,
  }).notNull(),
  iso20022Schema: text('iso20022_schema').notNull(), // e.g., 'pacs.008.001.09'
  climateFinanceCategory: text('climate_finance_category').notNull(),

  // Message Content
  messageContent: jsonb('message_content').notNull(), // Full ISO20022 message structure
  originalXml: text('original_xml'), // Original XML message
  originalJson: jsonb('original_json'), // JSON representation

  // Climate Finance Specific Fields
  climateProjectId: text('climate_project_id'),
  carbonCreditRegistryId: text('carbon_credit_registry_id'),
  environmentalCertification: jsonb('environmental_certification'),
  sustainabilityMetrics: jsonb('sustainability_metrics'),

  // Financial Details
  principalAmount: decimal('principal_amount', { precision: 20, scale: 8 }),
  currency: text('currency').notNull(),
  exchangeRate: decimal('exchange_rate', { precision: 20, scale: 8 }),
  feeAmount: decimal('fee_amount', { precision: 20, scale: 8 }),

  // Parties Information
  debtorInfo: jsonb('debtor_info').notNull(),
  creditorInfo: jsonb('creditor_info').notNull(),
  instructingAgent: jsonb('instructing_agent'),
  instructedAgent: jsonb('instructed_agent'),

  // Regulatory and Compliance
  regulatoryReporting: jsonb('regulatory_reporting'),
  complianceFlags: jsonb('compliance_flags'),
  sanctionsScreening: jsonb('sanctions_screening'),
  amlChecks: jsonb('aml_checks'),

  // TCFD Alignment
  tcfdPillarAlignment: text('tcfd_pillar_alignment', {
    enum: TCFD_PILLAR_TYPES,
  }),
  tcfdDisclosureCategory: text('tcfd_disclosure_category', {
    enum: TCFD_DISCLOSURE_CATEGORIES,
  }),
  climateRiskAssessment: jsonb('climate_risk_assessment'),

  // Processing Status
  status: text('status', { enum: ISO20022_MESSAGE_STATUS })
    .notNull()
    .default('pending'),
  validationResults: jsonb('validation_results'),
  processingErrors: jsonb('processing_errors'),

  // Blockchain Integration
  blockchainTransactionId: text('blockchain_transaction_id'),
  blockHash: text('block_hash'),
  blockHeight: integer('block_height'),
  smartContractAddress: text('smart_contract_address'),

  // Audit Trail
  originatingSystem: text('originating_system'),
  receivingSystem: text('receiving_system'),
  processingNode: text('processing_node'),
  messageRoute: jsonb('message_route'), // Array of systems that handled the message

  // Security
  digitalSignature: text('digital_signature'),
  encryptionDetails: jsonb('encryption_details'),
  accessControlFlags: jsonb('access_control_flags'),

  // Timestamps
  messageTimestamp: timestamp('message_timestamp').notNull(),
  receivedAt: timestamp('received_at').notNull().defaultNow(),
  processedAt: timestamp('processed_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Additional Metadata
  metadata: jsonb('metadata'),
});

// TCFD Reporting Data Structure
export const tcfdReports = pgTable('tcfd_reports', {
  id: serial('id').primaryKey(),
  reportId: text('report_id').notNull().unique(),

  // Report Classification
  reportType: text('report_type').notNull(), // 'annual', 'quarterly', 'event_driven', 'regulatory_filing'
  reportingPeriod: text('reporting_period').notNull(),
  reportingEntity: jsonb('reporting_entity').notNull(),

  // TCFD Pillar Data
  governanceData: jsonb('governance_data'), // Board oversight, management role
  strategyData: jsonb('strategy_data'), // Risks, opportunities, financial impact
  riskManagementData: jsonb('risk_management_data'), // Processes for identifying, assessing, managing
  metricsTargetsData: jsonb('metrics_targets_data'), // Metrics, emissions data, targets

  // Financial Impact Assessment
  physicalRiskImpacts: jsonb('physical_risk_impacts'),
  transitionRiskImpacts: jsonb('transition_risk_impacts'),
  climateOpportunities: jsonb('climate_opportunities'),
  financialQuantification: jsonb('financial_quantification'),

  // Scenario Analysis
  scenarioAnalysisData: jsonb('scenario_analysis_data'),
  climateScenarios: jsonb('climate_scenarios'), // 1.5°C, 2°C, 4°C scenarios
  businessImpactAssessment: jsonb('business_impact_assessment'),

  // Emissions and Metrics
  scope1Emissions: decimal('scope1_emissions', { precision: 20, scale: 4 }),
  scope2Emissions: decimal('scope2_emissions', { precision: 20, scale: 4 }),
  scope3Emissions: decimal('scope3_emissions', { precision: 20, scale: 4 }),
  emissionsIntensity: jsonb('emissions_intensity'),
  climateMetrics: jsonb('climate_metrics'),

  // Targets and Commitments
  emissionTargets: jsonb('emission_targets'),
  netZeroCommitments: jsonb('net_zero_commitments'),
  intermediateTargets: jsonb('intermediate_targets'),
  targetProgress: jsonb('target_progress'),

  // Data Sources and Methodology
  dataSources: jsonb('data_sources'),
  calculationMethodology: jsonb('calculation_methodology'),
  dataQualityAssessment: jsonb('data_quality_assessment'),
  assuranceLevel: text('assurance_level'), // 'limited', 'reasonable', 'none'

  // Regulatory Compliance
  regulatoryFramework: jsonb('regulatory_framework'),
  disclosureStandards: jsonb('disclosure_standards'), // TCFD, SASB, GRI, etc.
  complianceStatus: jsonb('compliance_status'),

  // Integration with ISO20022 Messages
  relatedMessages: jsonb('related_messages'), // Array of message IDs that contributed to this report
  sourceTransactions: jsonb('source_transactions'),

  // Report Status
  status: text('status').notNull().default('draft'),
  reviewStatus: text('review_status'),
  approvalStatus: text('approval_status'),
  publicationStatus: text('publication_status'),

  // Generation and Processing
  generatedBy: text('generated_by'),
  reviewedBy: jsonb('reviewed_by'),
  approvedBy: jsonb('approved_by'),
  generationMethod: text('generation_method'), // 'automated', 'manual', 'hybrid'

  // Timestamps
  reportingDate: timestamp('reporting_date').notNull(),
  generatedAt: timestamp('generated_at').notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at'),
  approvedAt: timestamp('approved_at'),
  publishedAt: timestamp('published_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Additional Metadata
  metadata: jsonb('metadata'),
});

// Climate Finance Data Mapping
export const climateFinanceDataMapping = pgTable(
  'climate_finance_data_mapping',
  {
    id: serial('id').primaryKey(),
    mappingId: text('mapping_id').notNull().unique(),

    // Source Data
    sourceSystem: text('source_system').notNull(),
    sourceDataType: text('source_data_type').notNull(),
    sourceSchema: jsonb('source_schema'),

    // Target ISO20022 Mapping
    iso20022MessageType: text('iso20022_message_type', {
      enum: ISO20022_CLIMATE_MESSAGE_TYPES,
    }).notNull(),
    iso20022Schema: text('iso20022_schema').notNull(),
    fieldMappings: jsonb('field_mappings').notNull(), // Source field -> ISO20022 field mappings

    // TCFD Alignment Mapping
    tcfdPillar: text('tcfd_pillar', { enum: TCFD_PILLAR_TYPES }),
    tcfdDisclosureCategory: text('tcfd_disclosure_category', {
      enum: TCFD_DISCLOSURE_CATEGORIES,
    }),
    tcfdFieldMappings: jsonb('tcfd_field_mappings'),

    // Transformation Rules
    transformationRules: jsonb('transformation_rules'),
    validationRules: jsonb('validation_rules'),
    businessRules: jsonb('business_rules'),

    // Climate Finance Context
    climateFinanceCategory: text('climate_finance_category'),
    environmentalCriteria: jsonb('environmental_criteria'),
    sustainabilityClassification: jsonb('sustainability_classification'),

    // Configuration
    isActive: boolean('is_active').default(true),
    version: text('version').notNull(),
    effectiveFrom: timestamp('effective_from').notNull(),
    effectiveTo: timestamp('effective_to'),

    // Audit
    createdBy: text('created_by').notNull(),
    approvedBy: text('approved_by'),

    // Timestamps
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    // Additional Metadata
    metadata: jsonb('metadata'),
  }
);

// Cryptographic Security for Climate Finance
export const climateFinanceSecurity = pgTable('climate_finance_security', {
  id: serial('id').primaryKey(),
  securityId: text('security_id').notNull().unique(),

  // Associated Resource
  resourceType: text('resource_type').notNull(), // 'message', 'report', 'transaction'
  resourceId: text('resource_id').notNull(),

  // Encryption Details
  encryptionAlgorithm: text('encryption_algorithm').notNull(),
  encryptionKeyId: text('encryption_key_id').notNull(),
  encryptedData: text('encrypted_data'),
  encryptionIV: text('encryption_iv'),

  // Digital Signature
  signatureAlgorithm: text('signature_algorithm'),
  publicKeyId: text('public_key_id'),
  digitalSignature: text('digital_signature'),
  signatureTimestamp: timestamp('signature_timestamp'),

  // Key Management
  keyDerivationMethod: text('key_derivation_method'),
  keyRotationSchedule: jsonb('key_rotation_schedule'),
  keyEscrowDetails: jsonb('key_escrow_details'),

  // Access Control
  accessControlList: jsonb('access_control_list'),
  permissionLevel: text('permission_level'),
  dataClassification: text('data_classification'),

  // Compliance and Audit
  regulatoryRequirements: jsonb('regulatory_requirements'),
  auditTrail: jsonb('audit_trail'),
  complianceStatus: text('compliance_status'),

  // Security Metadata
  securityLevel: text('security_level'), // 'standard', 'enhanced', 'maximum'
  threatModelVersion: text('threat_model_version'),
  securityFramework: text('security_framework'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at'),

  // Additional Metadata
  metadata: jsonb('metadata'),
});

// Regulatory Compliance Tracking
export const regulatoryCompliance = pgTable('regulatory_compliance', {
  id: serial('id').primaryKey(),
  complianceId: text('compliance_id').notNull().unique(),

  // Associated Resource
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),

  // Regulatory Framework
  regulatoryFramework: text('regulatory_framework').notNull(), // 'TCFD', 'SFDR', 'SEC', 'CFTC', etc.
  jurisdiction: text('jurisdiction').notNull(),
  regulatoryVersion: text('regulatory_version'),

  // Compliance Assessment
  complianceStatus: text('compliance_status').notNull(), // 'compliant', 'non_compliant', 'pending_review'
  complianceScore: decimal('compliance_score', { precision: 5, scale: 2 }),
  complianceDetails: jsonb('compliance_details'),

  // Requirements Checklist
  requirementChecklist: jsonb('requirement_checklist'),
  mandatoryFields: jsonb('mandatory_fields'),
  optionalFields: jsonb('optional_fields'),

  // Assessment Results
  assessmentResults: jsonb('assessment_results'),
  identifiedGaps: jsonb('identified_gaps'),
  recommendedActions: jsonb('recommended_actions'),

  // Validation
  validationMethod: text('validation_method'),
  validatedBy: text('validated_by'),
  validationTimestamp: timestamp('validation_timestamp'),

  // Reporting
  reportingRequired: boolean('reporting_required').default(false),
  reportingDeadline: timestamp('reporting_deadline'),
  reportingStatus: text('reporting_status'),

  // Timestamps
  assessmentDate: timestamp('assessment_date').notNull(),
  nextReviewDate: timestamp('next_review_date'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Additional Metadata
  metadata: jsonb('metadata'),
});

// Relations
export const iso20022ClimateMessagesRelations = relations(
  iso20022ClimateMessages,
  ({ one, many }) => ({
    security: one(climateFinanceSecurity, {
      fields: [iso20022ClimateMessages.messageId],
      references: [climateFinanceSecurity.resourceId],
    }),
    compliance: many(regulatoryCompliance),
  })
);

export const tcfdReportsRelations = relations(tcfdReports, ({ one, many }) => ({
  security: one(climateFinanceSecurity, {
    fields: [tcfdReports.reportId],
    references: [climateFinanceSecurity.resourceId],
  }),
  compliance: many(regulatoryCompliance),
}));

export const climateFinanceDataMappingRelations = relations(
  climateFinanceDataMapping,
  ({ many }) => ({
    messages: many(iso20022ClimateMessages),
  })
);

export const climateFinanceSecurityRelations = relations(
  climateFinanceSecurity,
  ({ one }) => ({
    message: one(iso20022ClimateMessages, {
      fields: [climateFinanceSecurity.resourceId],
      references: [iso20022ClimateMessages.messageId],
    }),
    report: one(tcfdReports, {
      fields: [climateFinanceSecurity.resourceId],
      references: [tcfdReports.reportId],
    }),
  })
);

export const regulatoryComplianceRelations = relations(
  regulatoryCompliance,
  ({ one }) => ({
    message: one(iso20022ClimateMessages, {
      fields: [regulatoryCompliance.resourceId],
      references: [iso20022ClimateMessages.messageId],
    }),
    report: one(tcfdReports, {
      fields: [regulatoryCompliance.resourceId],
      references: [tcfdReports.reportId],
    }),
  })
);
