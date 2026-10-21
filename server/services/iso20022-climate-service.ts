import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, desc, asc } from 'drizzle-orm';
import * as crypto from 'crypto';
import * as xml2js from 'xml2js';
import { z } from 'zod';
import {
  iso20022ClimateMessages,
  tcfdReports,
  climateFinanceDataMapping,
  climateFinanceSecurity,
  regulatoryCompliance,
  ISO20022_CLIMATE_MESSAGE_TYPES,
  ISO20022_MESSAGE_STATUS,
  TCFD_PILLAR_TYPES,
  TCFD_DISCLOSURE_CATEGORIES,
} from '../../shared/schema-iso20022-climate.js';
const { getSharedPgPool } = require('../utils/shared-pg-pool.js');

// ISO20022 Message Schemas
const ISO20022MessageSchema = z.object({
  messageId: z.string(),
  messageType: z.enum(ISO20022_CLIMATE_MESSAGE_TYPES),
  iso20022Schema: z.string(),
  climateFinanceCategory: z.string(),
  messageContent: z.object({}).passthrough(),
  debtorInfo: z.object({
    name: z.string(),
    identifier: z.string(),
    address: z.object({}).optional(),
    country: z.string().optional(),
  }),
  creditorInfo: z.object({
    name: z.string(),
    identifier: z.string(),
    address: z.object({}).optional(),
    country: z.string().optional(),
  }),
  principalAmount: z.string(),
  currency: z.string(),
  messageTimestamp: z.string(),
});

const TCFDReportSchema = z.object({
  reportId: z.string(),
  reportType: z.string(),
  reportingPeriod: z.string(),
  reportingEntity: z.object({
    name: z.string(),
    identifier: z.string(),
    jurisdiction: z.string(),
  }),
  governanceData: z.object({}).optional(),
  strategyData: z.object({}).optional(),
  riskManagementData: z.object({}).optional(),
  metricsTargetsData: z.object({}).optional(),
});

export class ISO20022ClimateService {
  private db: any;
  private xmlParser: xml2js.Parser;
  private xmlBuilder: xml2js.Builder;

  constructor(databaseUrl: string) {
    const pool = getSharedPgPool(
      { connectionString: databaseUrl },
      { poolName: 'iso20022-climate-service' }
    );
    this.db = drizzle(pool);

    this.xmlParser = new xml2js.Parser({
      explicitArray: false,
      ignoreAttrs: false,
      mergeAttrs: true,
    });

    this.xmlBuilder = new xml2js.Builder({
      rootName: 'Document',
      xmldec: { version: '1.0', encoding: 'UTF-8' },
    });
  }

  /**
   * Parse incoming ISO20022 XML message for climate finance
   */
  async parseISO20022Message(xmlContent: string): Promise<any> {
    try {
      // Parse XML to JSON
      const parsedXml = await this.xmlParser.parseStringPromise(xmlContent);

      // Extract message identification and type
      const messageId = this.extractMessageId(parsedXml);
      const messageType = this.determineMessageType(parsedXml);
      const iso20022Schema = this.extractSchemaVersion(parsedXml);

      // Extract core financial information
      const financialInfo = this.extractFinancialInfo(parsedXml);

      // Extract parties information
      const partiesInfo = this.extractPartiesInfo(parsedXml);

      // Extract climate-specific information
      const climateInfo = this.extractClimateFinanceInfo(parsedXml);

      // Construct normalized message object
      const normalizedMessage = {
        messageId,
        messageType,
        iso20022Schema,
        climateFinanceCategory:
          climateInfo.category || 'general_climate_finance',
        messageContent: parsedXml,
        originalXml: xmlContent,
        originalJson: parsedXml,

        // Climate finance specific fields
        climateProjectId: climateInfo.projectId,
        carbonCreditRegistryId: climateInfo.carbonCreditId,
        environmentalCertification: climateInfo.certifications,
        sustainabilityMetrics: climateInfo.metrics,

        // Financial details
        principalAmount: financialInfo.amount,
        currency: financialInfo.currency,
        exchangeRate: financialInfo.exchangeRate,
        feeAmount: financialInfo.fees,

        // Parties information
        debtorInfo: partiesInfo.debtor,
        creditorInfo: partiesInfo.creditor,
        instructingAgent: partiesInfo.instructingAgent,
        instructedAgent: partiesInfo.instructedAgent,

        // TCFD alignment
        tcfdPillarAlignment: this.determineTCFDPillar(climateInfo),
        tcfdDisclosureCategory: this.determineTCFDCategory(climateInfo),
        climateRiskAssessment: climateInfo.riskAssessment,

        // Processing metadata
        status: 'pending' as const,
        messageTimestamp: new Date(financialInfo.timestamp || Date.now()),
        receivedAt: new Date(),
        originatingSystem: this.extractOriginatingSystem(parsedXml),
        messageRoute: [{ system: 'wrfcoin-platform', timestamp: new Date() }],
      };

      return normalizedMessage;
    } catch (error) {
      throw new Error(
        `Failed to parse ISO20022 message: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Validate ISO20022 message against schema and business rules
   */
  async validateMessage(
    messageData: any
  ): Promise<{ isValid: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Schema validation
      const validationResult = ISO20022MessageSchema.safeParse(messageData);
      if (!validationResult.success) {
        validationResult.error.issues.forEach(issue => {
          errors.push(
            `Schema validation: ${issue.path.join('.')} - ${issue.message}`
          );
        });
      }

      // Business rule validation
      await this.validateBusinessRules(messageData, errors, warnings);

      // Climate finance specific validation
      await this.validateClimateFinanceRules(messageData, errors, warnings);

      // TCFD compliance validation
      await this.validateTCFDCompliance(messageData, errors, warnings);

      return {
        isValid: errors.length === 0,
        errors,
        warnings,
      };
    } catch (error) {
      errors.push(
        `Validation error: ${error instanceof Error ? error.message : String(error)}`
      );
      return { isValid: false, errors, warnings };
    }
  }

  /**
   * Store validated message in database
   */
  async storeMessage(
    messageData: any,
    validationResults: any
  ): Promise<string> {
    try {
      const [result] = await this.db
        .insert(iso20022ClimateMessages)
        .values({
          ...messageData,
          validationResults,
        })
        .returning({ id: iso20022ClimateMessages.id });

      return result.id.toString();
    } catch (error) {
      throw new Error(
        `Failed to store message: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Process message for TCFD reporting integration
   */
  async processForTCFDReporting(messageId: string): Promise<void> {
    try {
      const [message] = await this.db
        .select()
        .from(iso20022ClimateMessages)
        .where(eq(iso20022ClimateMessages.messageId, messageId))
        .limit(1);

      if (!message) {
        throw new Error(`Message not found: ${messageId}`);
      }

      // Extract TCFD-relevant data
      const tcfdData = this.extractTCFDRelevantData(message);

      // Update or create TCFD report entries
      await this.updateTCFDReports(tcfdData, message);

      // Update message status
      await this.db
        .update(iso20022ClimateMessages)
        .set({
          status: 'processed',
          processedAt: new Date(),
        })
        .where(eq(iso20022ClimateMessages.messageId, messageId));
    } catch (error) {
      // Update message with error status
      await this.db
        .update(iso20022ClimateMessages)
        .set({
          status: 'rejected',
          processingErrors: [
            {
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date(),
            },
          ],
        })
        .where(eq(iso20022ClimateMessages.messageId, messageId));

      throw error;
    }
  }

  // Private helper methods
  private extractMessageId(parsedXml: any): string {
    // Extract message ID from various possible locations in ISO20022 structure
    const msgId =
      parsedXml?.Document?.FIToFIPmtStsRpt?.GrpHdr?.MsgId ||
      parsedXml?.Document?.CstmrCdtTrfInitn?.GrpHdr?.MsgId ||
      parsedXml?.Document?.PmtSts?.TxInfAndSts?.[0]?.TxId ||
      crypto.randomUUID();

    return msgId;
  }

  private determineMessageType(parsedXml: any): string {
    // Determine message type based on document structure
    const documentKeys = Object.keys(parsedXml.Document || {});

    if (documentKeys.includes('CstmrCdtTrfInitn')) {
      return 'climate_data_payment';
    } else if (documentKeys.includes('FIToFIPmtStsRpt')) {
      return 'carbon_credit_transfer';
    } else if (documentKeys.includes('CdtTrfTxInf')) {
      return 'climate_fund_disbursement';
    }

    return 'climate_data_payment'; // Default
  }

  private extractSchemaVersion(parsedXml: any): string {
    // Extract schema version from XML namespace or attributes
    const document = parsedXml.Document;
    if (document && document.$) {
      const namespace = document.$['xmlns'] || '';
      if (namespace.includes('pacs.008.001.09')) return 'pacs.008.001.09';
      if (namespace.includes('pacs.002.001.10')) return 'pacs.002.001.10';
      if (namespace.includes('pain.001.001.09')) return 'pain.001.001.09';
    }

    return 'pacs.008.001.09'; // Default
  }

  private extractFinancialInfo(parsedXml: any): any {
    const cdtTrfTxInf =
      parsedXml?.Document?.CstmrCdtTrfInitn?.CdtTrfTxInf?.[0] ||
      parsedXml?.Document?.FIToFIPmtStsRpt?.TxInfAndSts?.[0];

    return {
      amount: cdtTrfTxInf?.Amt?.InstdAmt?._ || cdtTrfTxInf?.InstdAmt || '0',
      currency: cdtTrfTxInf?.Amt?.InstdAmt?.Ccy || 'USD',
      exchangeRate: cdtTrfTxInf?.XchgRate || null,
      fees: cdtTrfTxInf?.ChrgsInf?.[0]?.Amt?._ || null,
      timestamp: cdtTrfTxInf?.CreDtTm || parsedXml?.Document?.GrpHdr?.CreDtTm,
    };
  }

  private extractPartiesInfo(parsedXml: any): any {
    const cdtTrfTxInf = parsedXml?.Document?.CstmrCdtTrfInitn?.CdtTrfTxInf?.[0];

    return {
      debtor: {
        name: cdtTrfTxInf?.Dbtr?.Nm || 'Unknown',
        identifier: cdtTrfTxInf?.Dbtr?.Id?.OrgId?.Othr?.[0]?.Id || '',
        address: cdtTrfTxInf?.Dbtr?.PstlAdr,
        country: cdtTrfTxInf?.Dbtr?.PstlAdr?.Ctry,
      },
      creditor: {
        name: cdtTrfTxInf?.Cdtr?.Nm || 'Unknown',
        identifier: cdtTrfTxInf?.Cdtr?.Id?.OrgId?.Othr?.[0]?.Id || '',
        address: cdtTrfTxInf?.Cdtr?.PstlAdr,
        country: cdtTrfTxInf?.Cdtr?.PstlAdr?.Ctry,
      },
      instructingAgent: cdtTrfTxInf?.InstgAgt,
      instructedAgent: cdtTrfTxInf?.InstdAgt,
    };
  }

  private extractClimateFinanceInfo(parsedXml: any): any {
    // Extract climate-specific information from structured data
    const rmtInf =
      parsedXml?.Document?.CstmrCdtTrfInitn?.CdtTrfTxInf?.[0]?.RmtInf;
    const purposeCode =
      parsedXml?.Document?.CstmrCdtTrfInitn?.CdtTrfTxInf?.[0]?.Purp?.Cd;

    // Look for climate finance indicators in remittance information
    const climateKeywords = [
      'CLIMATE',
      'CARBON',
      'ENVIRONMENTAL',
      'SUSTAINABILITY',
      'ESG',
    ];
    const category = climateKeywords.find(keyword =>
      JSON.stringify(rmtInf).toUpperCase().includes(keyword)
    )
      ? 'climate_finance'
      : 'general_payment';

    return {
      category,
      projectId: rmtInf?.Ustrd?.match(/PROJECT[:\s]*([A-Z0-9-]+)/i)?.[1],
      carbonCreditId: rmtInf?.Ustrd?.match(/CARBON[:\s]*([A-Z0-9-]+)/i)?.[1],
      certifications: this.extractCertifications(rmtInf),
      metrics: this.extractSustainabilityMetrics(rmtInf),
      riskAssessment: this.extractRiskAssessment(rmtInf),
    };
  }

  private extractCertifications(rmtInf: any): any {
    // Extract environmental certifications from remittance info
    const certPatterns = {
      VCS: /VCS[:\s]*([A-Z0-9-]+)/i,
      CDM: /CDM[:\s]*([A-Z0-9-]+)/i,
      GOLD_STANDARD: /GOLD[:\s]*STANDARD[:\s]*([A-Z0-9-]+)/i,
    };

    const certifications = {};
    const rmtText = JSON.stringify(rmtInf);

    Object.entries(certPatterns).forEach(([cert, pattern]) => {
      const match = rmtText.match(pattern);
      if (match) {
        certifications[cert] = match[1];
      }
    });

    return Object.keys(certifications).length > 0 ? certifications : null;
  }

  private extractSustainabilityMetrics(rmtInf: any): any {
    // Extract sustainability metrics from structured data
    const metrics: any = {};
    const rmtText = JSON.stringify(rmtInf).toUpperCase();

    // Look for CO2 emissions data
    const co2Match = rmtText.match(/CO2[:\s]*([0-9.]+)/);
    if (co2Match) {
      metrics.co2_emissions = parseFloat(co2Match[1]);
    }

    // Look for renewable energy percentage
    const renewableMatch = rmtText.match(/RENEWABLE[:\s]*([0-9.]+)%?/);
    if (renewableMatch) {
      metrics.renewable_percentage = parseFloat(renewableMatch[1]);
    }

    return Object.keys(metrics).length > 0 ? metrics : null;
  }

  private extractRiskAssessment(rmtInf: any): any {
    // Extract climate risk assessment information
    const rmtText = JSON.stringify(rmtInf).toUpperCase();
    const riskKeywords = [
      'HIGH RISK',
      'MEDIUM RISK',
      'LOW RISK',
      'CLIMATE RISK',
    ];

    const foundRisk = riskKeywords.find(keyword => rmtText.includes(keyword));
    if (foundRisk) {
      return {
        assessment_level: foundRisk.toLowerCase().replace(' ', '_'),
        assessment_date: new Date().toISOString(),
      };
    }

    return null;
  }

  private determineTCFDPillar(climateInfo: any): string | null {
    // Determine which TCFD pillar this message relates to
    if (climateInfo.riskAssessment) return 'risk_management';
    if (climateInfo.metrics) return 'metrics_and_targets';
    if (climateInfo.projectId) return 'strategy';
    return null;
  }

  private determineTCFDCategory(climateInfo: any): string | null {
    // Determine TCFD disclosure category
    if (climateInfo.metrics) return 'climate_metrics';
    if (climateInfo.riskAssessment)
      return 'climate_related_risks_opportunities';
    if (climateInfo.carbonCreditId) return 'emissions_data';
    return null;
  }

  private extractOriginatingSystem(parsedXml: any): string {
    // Extract originating system information
    return parsedXml?.Document?.GrpHdr?.InstgAgt?.FinInstnId?.Nm || 'unknown';
  }

  private async validateBusinessRules(
    messageData: any,
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    // Validate amount is positive
    if (parseFloat(messageData.principalAmount) <= 0) {
      errors.push('Principal amount must be positive');
    }

    // Validate currency code
    const validCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD'];
    if (!validCurrencies.includes(messageData.currency)) {
      warnings.push(`Unusual currency code: ${messageData.currency}`);
    }

    // Validate parties have required information
    if (!messageData.debtorInfo?.name || !messageData.creditorInfo?.name) {
      errors.push('Both debtor and creditor names are required');
    }
  }

  private async validateClimateFinanceRules(
    messageData: any,
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    // Validate climate finance specific rules
    if (
      messageData.climateProjectId &&
      !/^[A-Z0-9-]{6,20}$/.test(messageData.climateProjectId)
    ) {
      warnings.push('Climate project ID format may be invalid');
    }

    if (
      messageData.carbonCreditRegistryId &&
      !messageData.environmentalCertification
    ) {
      warnings.push(
        'Carbon credit transfers should include environmental certifications'
      );
    }
  }

  private async validateTCFDCompliance(
    messageData: any,
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    // Validate TCFD compliance requirements
    if (messageData.tcfdPillarAlignment && !messageData.climateRiskAssessment) {
      warnings.push(
        'TCFD-aligned transactions should include climate risk assessment'
      );
    }

    if (
      messageData.sustainabilityMetrics &&
      !messageData.tcfdDisclosureCategory
    ) {
      warnings.push(
        'Sustainability metrics should be mapped to TCFD disclosure categories'
      );
    }
  }

  private extractTCFDRelevantData(message: any): any {
    // Extract data relevant for TCFD reporting
    return {
      messageId: message.messageId,
      amount: message.principalAmount,
      currency: message.currency,
      pillar: message.tcfdPillarAlignment,
      category: message.tcfdDisclosureCategory,
      metrics: message.sustainabilityMetrics,
      riskAssessment: message.climateRiskAssessment,
      timestamp: message.messageTimestamp,
    };
  }

  private async updateTCFDReports(tcfdData: any, message: any): Promise<void> {
    // Update TCFD reports with new data from processed message
    const reportingPeriod = this.getCurrentReportingPeriod();

    // Check if report exists for current period
    const existingReports = await this.db
      .select()
      .from(tcfdReports)
      .where(eq(tcfdReports.reportingPeriod, reportingPeriod))
      .limit(1);

    if (existingReports.length > 0) {
      // Update existing report
      const report = existingReports[0];
      const updatedRelatedMessages = [
        ...((report.relatedMessages as string[]) || []),
        message.messageId,
      ];

      await this.db
        .update(tcfdReports)
        .set({
          relatedMessages: updatedRelatedMessages,
          updatedAt: new Date(),
        })
        .where(eq(tcfdReports.id, report.id));
    } else {
      // Create new report for the period
      await this.db.insert(tcfdReports).values({
        reportId: `TCFD-${reportingPeriod}-${crypto.randomUUID().substring(0, 8)}`,
        reportType: 'quarterly',
        reportingPeriod,
        reportingEntity: {
          name: 'Wrfcoin Platform',
          identifier: 'WRFCOIN-001',
          jurisdiction: 'GLOBAL',
        },
        relatedMessages: [message.messageId],
        status: 'draft',
        reportingDate: new Date(),
      });
    }
  }

  private getCurrentReportingPeriod(): string {
    const now = new Date();
    const year = now.getFullYear();
    const quarter = Math.ceil((now.getMonth() + 1) / 3);
    return `${year}-Q${quarter}`;
  }
}

export default ISO20022ClimateService;
