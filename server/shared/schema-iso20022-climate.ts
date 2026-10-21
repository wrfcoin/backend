/**
 * ISO20022 Climate Finance Schema Definitions
 * Type definitions for climate finance transactions and reporting
 */

// Base types for ISO20022 climate finance
export interface ISO20022ClimateTransaction {
  id: string;
  messageType: string;
  timestamp: Date;
  amount: number;
  currency: string;
  carbonCredits?: number;
  climateImpact?: ClimateImpact;
  tcfdData?: TCFDData;
  regulatoryReporting?: RegulatoryReporting;
  securityValidation?: SecurityValidation;
}

export interface ClimateImpact {
  co2Reduction: number;
  renewableEnergyUsage: number;
  carbonFootprint: number;
  sustainabilityScore: number;
  environmentalMetrics: EnvironmentalMetrics;
}

export interface EnvironmentalMetrics {
  co2_emissions: number;
  renewable_percentage: number;
  energy_efficiency: number;
  water_usage?: number;
  waste_reduction?: number;
}

export interface TCFDData {
  governance: TCFDGovernance;
  strategy: TCFDStrategy;
  riskManagement: TCFDRiskManagement;
  metricsTargets: TCFDMetricsTargets;
}

export interface TCFDGovernance {
  boardOversight: string;
  managementRole: string;
  riskCommittees: string[];
}

export interface TCFDStrategy {
  climateRisks: ClimateRisk[];
  opportunities: ClimateOpportunity[];
  resilience: ResilienceAssessment;
}

export interface ClimateRisk {
  type: 'physical' | 'transition';
  category: string;
  timeframe: 'short' | 'medium' | 'long';
  impact: 'low' | 'medium' | 'high';
  description: string;
}

export interface ClimateOpportunity {
  type: string;
  category: string;
  timeframe: 'short' | 'medium' | 'long';
  impact: 'low' | 'medium' | 'high';
  description: string;
}

export interface ResilienceAssessment {
  scenario: string;
  resilience_score: number;
  adaptive_capacity: number;
  vulnerabilities: string[];
}

export interface TCFDRiskManagement {
  identification: string;
  assessment: string;
  management: string;
  integration: string;
}

export interface TCFDMetricsTargets {
  scope1Emissions: number;
  scope2Emissions: number;
  scope3Emissions: number;
  carbonIntensity: number;
  climateTargets: ClimateTarget[];
}

export interface ClimateTarget {
  description: string;
  target_value: number;
  target_date: Date;
  progress: number;
}

export interface RegulatoryReporting {
  jurisdiction: string;
  reportingFramework: string;
  complianceStatus: 'compliant' | 'non-compliant' | 'pending';
  filingDate: Date;
  nextReviewDate: Date;
  regulatoryBody: string;
}

export interface SecurityValidation {
  validationLevel: 'basic' | 'enhanced' | 'comprehensive';
  cryptographicProof: string;
  auditTrail: AuditTrailEntry[];
  complianceChecks: ComplianceCheck[];
}

export interface AuditTrailEntry {
  timestamp: Date;
  action: string;
  user: string;
  details: Record<string, any>;
}

export interface ComplianceCheck {
  rule: string;
  status: 'passed' | 'failed' | 'warning';
  description: string;
  evidence?: string;
}

// Error types for ISO20022 processing
export interface ISO20022Error {
  type:
    | 'parsing'
    | 'validation'
    | 'business_rules'
    | 'regulatory_check'
    | 'security_validation'
    | 'tcfd_mapping'
    | 'database_storage'
    | 'blockchain_integration'
    | 'notification';
  code: string;
  message: string;
  details?: Record<string, any>;
  timestamp: Date;
}

// Message types for ISO20022 climate finance
export type ISO20022MessageType =
  | 'pain.001.001.03' // CustomerCreditTransferInitiation
  | 'pain.008.001.02' // CustomerDirectDebitInitiation
  | 'camt.053.001.02' // BankToCustomerStatement
  | 'camt.054.001.02' // BankToCustomerDebitCreditNotification
  | 'pacs.008.001.02' // PaymentStatusReport
  | 'climate.001.001.01' // ClimateFinanceTransaction (custom)
  | 'tcfd.001.001.01' // TCFDReport (custom)
  | 'esg.001.001.01'; // ESGDataReport (custom)

// Processing status for ISO20022 messages
export type ProcessingStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'rejected';

// Main ISO20022 climate message interface
export interface ISO20022ClimateMessage {
  messageId: string;
  messageType: ISO20022MessageType;
  processingStatus: ProcessingStatus;
  transaction: ISO20022ClimateTransaction;
  validationErrors?: ISO20022Error[];
  processingLog: ProcessingLogEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ProcessingLogEntry {
  timestamp: Date;
  stage: string;
  status: 'success' | 'error' | 'warning';
  message: string;
  details?: Record<string, any>;
}

// Constants for schema validation
export const ISO20022_CLIMATE_MESSAGE_TYPES = [
  'climate_data_payment',
  'carbon_credit_transfer',
  'climate_fund_disbursement',
  'environmental_compliance_payment',
  'weather_data_validation_payment',
] as const;

export const ISO20022_MESSAGE_STATUS = [
  'pending',
  'processing',
  'completed',
  'failed',
  'rejected',
] as const;

export const TCFD_PILLAR_TYPES = [
  'governance',
  'strategy',
  'risk_management',
  'metrics_targets',
] as const;

export const TCFD_DISCLOSURE_CATEGORIES = [
  'governance_oversight',
  'strategy_resilience',
  'risk_identification',
  'metrics_disclosure',
] as const;

// Mock schema objects for database integration
export const iso20022ClimateMessages = {
  id: 'id',
  messageId: 'messageId',
  messageType: 'messageType',
  status: 'status',
  reportingPeriod: 'reportingPeriod',
};

export const tcfdReports = {
  id: 'id',
  reportId: 'reportId',
  messageId: 'messageId',
};

export const climateFinanceDataMapping = {
  mappingId: 'mappingId',
  sourceField: 'sourceField',
  targetField: 'targetField',
};

export const climateFinanceSecurity = {
  securityId: 'securityId',
  encryptionStatus: 'encryptionStatus',
};

export const regulatoryCompliance = {
  complianceId: 'complianceId',
  messageId: 'messageId',
  framework: 'framework',
};

// Export default schema object for backward compatibility
export default {
  ISO20022_CLIMATE_MESSAGE_TYPES,
  ISO20022_MESSAGE_STATUS,
  TCFD_PILLAR_TYPES,
  TCFD_DISCLOSURE_CATEGORIES,
  iso20022ClimateMessages,
  tcfdReports,
  climateFinanceDataMapping,
  climateFinanceSecurity,
  regulatoryCompliance,
};
