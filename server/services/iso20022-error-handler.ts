import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, desc, asc, gte, lte } from 'drizzle-orm';
import * as crypto from 'crypto';
import {
  iso20022ClimateMessages,
  regulatoryCompliance,
  ISO20022_MESSAGE_STATUS,
} from '../shared/schema-iso20022-climate.js';
import { securityLogger, appLogger } from '../utils/logger.js';
const { getSharedPgPool } = require('../utils/shared-pg-pool.js');

export interface ErrorContext {
  messageId: string;
  messageType: string;
  processingStage: ProcessingStage;
  originalData?: any;
  validationResults?: any;
  systemInfo: {
    nodeId: string;
    version: string;
    timestamp: Date;
  };
}

export type ProcessingStage =
  | 'parsing'
  | 'validation'
  | 'business_rules'
  | 'regulatory_check'
  | 'security_validation'
  | 'tcfd_mapping'
  | 'database_storage'
  | 'blockchain_integration'
  | 'notification';

export interface ErrorClassification {
  category:
    | 'technical'
    | 'business'
    | 'regulatory'
    | 'security'
    | 'data_quality';
  severity: 'critical' | 'high' | 'medium' | 'low';
  retryable: boolean;
  escalationRequired: boolean;
  autoRecoverable: boolean;
}

export interface RecoveryAction {
  action: 'retry' | 'manual_review' | 'escalate' | 'reject' | 'partial_process';
  maxRetries?: number;
  retryDelay?: number;
  reviewQueue?: string;
  escalationLevel?: 'level1' | 'level2' | 'level3';
  manualSteps?: string[];
}

export interface ErrorMetrics {
  errorCount: number;
  errorRate: number;
  avgResolutionTime: number;
  escalationRate: number;
  autoRecoveryRate: number;
  topErrorCategories: { category: string; count: number }[];
}

export interface AlertChannel {
  name: string;
  type: 'email' | 'slack' | 'webhook' | 'sms';
  endpoint: string;
  enabled: boolean;
  severity: 'critical' | 'high' | 'medium' | 'low';
  config: any;
  send: (alertData: any) => Promise<void>;
}

export class ISO20022ErrorHandler {
  private db: any;
  private errorClassificationRules: Map<string, ErrorClassification> =
    new Map();
  private recoveryStrategies: Map<string, RecoveryAction> = new Map();
  private alertingChannels: AlertChannel[] = [];

  constructor(databaseUrl: string) {
    const pool = getSharedPgPool(
      { connectionString: databaseUrl },
      { poolName: 'iso20022-error-handler' }
    );
    this.db = drizzle(pool);
    this.initializeErrorClassification();
    this.initializeRecoveryStrategies();
    this.initializeAlertingChannels();
  }

  /**
   * Handle error with comprehensive classification and recovery
   */
  async handleError(
    error: Error,
    context: ErrorContext,
    additionalInfo?: any
  ): Promise<{
    handled: boolean;
    recoveryAction: RecoveryAction;
    errorId: string;
  }> {
    const errorId = crypto.randomUUID();

    try {
      // 1. Classify the error
      const classification = await this.classifyError(error, context);

      // 2. Log the error with full context
      await this.logError(
        errorId,
        error,
        context,
        classification,
        additionalInfo
      );

      // 3. Determine recovery action
      const recoveryAction = this.determineRecoveryAction(
        error,
        classification,
        context
      );

      // 4. Update message status if applicable
      if (context.messageId) {
        await this.updateMessageStatus(
          context.messageId,
          error,
          classification,
          recoveryAction
        );
      }

      // 5. Execute immediate recovery actions
      const handled = await this.executeRecoveryAction(
        recoveryAction,
        error,
        context
      );

      // 6. Send alerts if required
      if (classification.escalationRequired) {
        await this.sendAlerts(error, context, classification, errorId);
      }

      // 7. Update error metrics
      await this.updateErrorMetrics(classification, context);

      return { handled, recoveryAction, errorId };
    } catch (handlingError) {
      // Fallback error handling
      securityLogger.error('Error in error handler', { error: handlingError });
      await this.handleCriticalError(error, context, handlingError as Error);

      return {
        handled: false,
        recoveryAction: { action: 'escalate', escalationLevel: 'level3' },
        errorId,
      };
    }
  }

  /**
   * Handle validation errors with specific recovery strategies
   */
  async handleValidationError(
    validationResults: any,
    context: ErrorContext
  ): Promise<{
    canProceed: boolean;
    requiredActions: string[];
    warnings: string[];
  }> {
    const { errors, warnings } = validationResults;
    const criticalErrors = errors.filter(
      e => e.severity === 'critical' || e.severity === 'high'
    );

    if (criticalErrors.length > 0) {
      // Handle critical validation errors
      for (const error of criticalErrors) {
        await this.handleError(
          new Error(`Validation error: ${error.message}`),
          { ...context, processingStage: 'validation' }
        );
      }

      return {
        canProceed: false,
        requiredActions: [
          'Fix critical validation errors',
          'Resubmit message for processing',
          'Contact support if errors persist',
        ],
        warnings: warnings.map(w => w.message),
      };
    }

    // Handle warnings and medium severity errors
    const requiredActions: string[] = [];
    const mediumErrors = errors.filter(e => e.severity === 'medium');

    if (mediumErrors.length > 0) {
      requiredActions.push('Review and address medium severity errors');
    }

    if (warnings.length > 0) {
      requiredActions.push(
        'Consider addressing warnings for better compliance'
      );
    }

    return {
      canProceed: true,
      requiredActions,
      warnings: warnings.map(w => w.message),
    };
  }

  /**
   * Handle business rule violations
   */
  async handleBusinessRuleViolation(
    ruleName: string,
    violation: any,
    context: ErrorContext
  ): Promise<{
    action: 'reject' | 'review' | 'override' | 'modify';
    details: any;
  }> {
    const error = new Error(
      `Business rule violation: ${ruleName} - ${violation.message}`
    );

    // Classify business rule violations
    const businessRuleClassification: ErrorClassification = {
      category: 'business',
      severity: violation.severity || 'medium',
      retryable: false,
      escalationRequired: violation.severity === 'critical',
      autoRecoverable: false,
    };

    await this.logError(
      crypto.randomUUID(),
      error,
      { ...context, processingStage: 'business_rules' },
      businessRuleClassification,
      { ruleName, violation }
    );

    // Determine action based on rule type and severity
    switch (violation.severity) {
      case 'critical':
        return {
          action: 'reject',
          details: { reason: violation.message, appealProcess: true },
        };

      case 'high':
        return {
          action: 'review',
          details: { reviewQueue: 'business_rules', priority: 'high' },
        };

      case 'medium':
        return {
          action: 'review',
          details: { reviewQueue: 'business_rules', priority: 'medium' },
        };

      default:
        return {
          action: 'modify',
          details: { suggestedChanges: violation.suggestedFixes },
        };
    }
  }

  /**
   * Log security events for audit purposes
   */
  async logSecurityEvent(
    eventType: string,
    eventData: any,
    context: ErrorContext
  ): Promise<void> {
    const securityEvent = {
      id: crypto.randomUUID(),
      eventType,
      timestamp: new Date(),
      messageId: context.messageId,
      messageType: context.messageType,
      processingStage: context.processingStage,
      eventData,
      severity: eventData.severity || 'medium',
      source: 'ISO20022_ERROR_HANDLER',
    };

    try {
      // Log to database (in production, this would be a security event table)
      securityLogger.warn('Security Event Logged', { securityEvent });

      // In production, you would also:
      // 1. Send to SIEM system
      // 2. Alert security team for critical events
      // 3. Store in secure audit log
    } catch (error) {
      securityLogger.error('Failed to log security event', { error });
    }
  }

  /**
   * Handle regulatory compliance failures
   */
  async handleRegulatoryFailure(
    framework: string,
    failureDetails: any,
    context: ErrorContext
  ): Promise<{
    mustComply: boolean;
    gracePeriod?: number;
    requiredActions: string[];
  }> {
    const error = new Error(`Regulatory compliance failure: ${framework}`);

    const regulatoryClassification: ErrorClassification = {
      category: 'regulatory',
      severity: failureDetails.mandatory ? 'critical' : 'medium',
      retryable: true,
      escalationRequired: failureDetails.mandatory,
      autoRecoverable: false,
    };

    await this.logError(
      crypto.randomUUID(),
      error,
      { ...context, processingStage: 'regulatory_check' },
      regulatoryClassification,
      { framework, failureDetails }
    );

    // Framework-specific handling
    switch (framework) {
      case 'TCFD':
        return {
          mustComply: false,
          gracePeriod: 30, // 30 days to improve TCFD alignment
          requiredActions: [
            'Enhance climate risk disclosure',
            'Align with TCFD recommendations',
            'Consider scenario analysis',
          ],
        };

      case 'SFDR':
        return {
          mustComply: failureDetails.jurisdictionApplies,
          gracePeriod: failureDetails.jurisdictionApplies ? 0 : undefined,
          requiredActions: [
            'Provide sustainability metrics',
            'Classify according to SFDR taxonomy',
            'Include ESG risk assessment',
          ],
        };

      default:
        return {
          mustComply: failureDetails.mandatory,
          requiredActions: [
            'Review regulatory requirements',
            'Consult compliance team',
          ],
        };
    }
  }

  /**
   * Handle security incidents
   */
  async handleSecurityIncident(
    incidentType:
      | 'unauthorized_access'
      | 'data_breach'
      | 'encryption_failure'
      | 'signature_invalid',
    incidentDetails: any,
    context: ErrorContext
  ): Promise<{
    severity: 'low' | 'medium' | 'high' | 'critical';
    immediateActions: string[];
  }> {
    const error = new Error(`Security incident: ${incidentType}`);

    const securityClassification: ErrorClassification = {
      category: 'security',
      severity: this.getSecurityIncidentSeverity(incidentType, incidentDetails),
      retryable: false,
      escalationRequired: true,
      autoRecoverable: false,
    };

    const errorId = crypto.randomUUID();
    await this.logError(
      errorId,
      error,
      { ...context, processingStage: 'security_validation' },
      securityClassification,
      { incidentType, incidentDetails }
    );

    // Immediate security response
    const immediateActions = await this.executeSecurityResponse(
      incidentType,
      incidentDetails,
      context
    );

    // Alert security team immediately
    await this.sendSecurityAlert(
      incidentType,
      incidentDetails,
      context,
      errorId
    );

    return {
      severity: securityClassification.severity,
      immediateActions,
    };
  }

  /**
   * Get error metrics for monitoring and reporting
   */
  async getErrorMetrics(timeframe: {
    start: Date;
    end: Date;
  }): Promise<ErrorMetrics> {
    // Implementation would query error logs and calculate metrics
    // This is a simplified version

    return {
      errorCount: 0, // Would be calculated from database
      errorRate: 0,
      avgResolutionTime: 0,
      escalationRate: 0,
      autoRecoveryRate: 0,
      topErrorCategories: [],
    };
  }

  /**
   * Generate error report for analysis
   */
  async generateErrorReport(criteria: {
    timeframe: { start: Date; end: Date };
    categories?: string[];
    severity?: string[];
    messageTypes?: string[];
  }): Promise<any> {
    // Implementation would generate comprehensive error report
    return {
      summary: {},
      details: [],
      trends: {},
      recommendations: [],
    };
  }

  // Private helper methods
  private async classifyError(
    error: Error,
    context: ErrorContext
  ): Promise<ErrorClassification> {
    const errorMessage = error.message.toLowerCase();
    const errorStack = error.stack?.toLowerCase() || '';

    // Pattern-based classification
    if (
      errorMessage.includes('validation') ||
      errorMessage.includes('schema')
    ) {
      return {
        category: 'data_quality',
        severity: 'medium',
        retryable: false,
        escalationRequired: false,
        autoRecoverable: false,
      };
    }

    if (
      errorMessage.includes('security') ||
      errorMessage.includes('unauthorized')
    ) {
      return {
        category: 'security',
        severity: 'critical',
        retryable: false,
        escalationRequired: true,
        autoRecoverable: false,
      };
    }

    if (
      errorMessage.includes('database') ||
      errorMessage.includes('connection')
    ) {
      return {
        category: 'technical',
        severity: 'high',
        retryable: true,
        escalationRequired: false,
        autoRecoverable: true,
      };
    }

    if (
      errorMessage.includes('business rule') ||
      errorMessage.includes('compliance')
    ) {
      return {
        category: 'business',
        severity: 'medium',
        retryable: false,
        escalationRequired: false,
        autoRecoverable: false,
      };
    }

    // Default classification
    return {
      category: 'technical',
      severity: 'medium',
      retryable: true,
      escalationRequired: false,
      autoRecoverable: false,
    };
  }

  private determineRecoveryAction(
    error: Error,
    classification: ErrorClassification,
    context: ErrorContext
  ): RecoveryAction {
    if (classification.autoRecoverable && classification.retryable) {
      return {
        action: 'retry',
        maxRetries: 3,
        retryDelay: 5000,
      };
    }

    if (classification.severity === 'critical') {
      return {
        action: 'escalate',
        escalationLevel: 'level2',
      };
    }

    if (
      classification.category === 'business' ||
      classification.category === 'regulatory'
    ) {
      return {
        action: 'manual_review',
        reviewQueue: `${classification.category}_review`,
      };
    }

    return {
      action: 'manual_review',
      reviewQueue: 'general_review',
    };
  }

  private async logError(
    errorId: string,
    error: Error,
    context: ErrorContext,
    classification: ErrorClassification,
    additionalInfo?: any
  ): Promise<void> {
    const errorLog = {
      errorId,
      message: error.message,
      stack: error.stack,
      context,
      classification,
      additionalInfo,
      timestamp: new Date(),
    };

    // Log to database, file system, or external logging service
    securityLogger.error('ISO20022 Error', { errorLog });

    // Store in database for analysis
    // Implementation would depend on your logging table structure
  }

  private async updateMessageStatus(
    messageId: string,
    error: Error,
    classification: ErrorClassification,
    recoveryAction: RecoveryAction
  ): Promise<void> {
    const newStatus =
      classification.severity === 'critical' ? 'rejected' : 'pending';

    const errorDetails = {
      error: error.message,
      classification,
      recoveryAction,
      timestamp: new Date(),
    };

    await this.db
      .update(iso20022ClimateMessages as any)
      .set({
        status: newStatus,
        processingErrors: [errorDetails],
      } as any)
      .where(eq((iso20022ClimateMessages as any).messageId, messageId));
  }

  private async executeRecoveryAction(
    recoveryAction: RecoveryAction,
    error: Error,
    context: ErrorContext
  ): Promise<boolean> {
    switch (recoveryAction.action) {
      case 'retry':
        // Implement retry logic
        return true;

      case 'manual_review':
        // Add to review queue
        await this.addToReviewQueue(
          context,
          recoveryAction.reviewQueue || 'general'
        );
        return true;

      case 'escalate':
        // Escalate to appropriate level
        await this.escalateError(
          error,
          context,
          recoveryAction.escalationLevel || 'level1'
        );
        return true;

      default:
        return false;
    }
  }

  private async sendAlerts(
    error: Error,
    context: ErrorContext,
    classification: ErrorClassification,
    errorId: string
  ): Promise<void> {
    const alertData = {
      errorId,
      message: error.message,
      context,
      classification,
      timestamp: new Date(),
    };

    for (const channel of this.alertingChannels) {
      if (this.shouldSendAlert(classification, channel)) {
        await channel.send(alertData);
      }
    }
  }

  private getSecurityIncidentSeverity(
    incidentType: string,
    incidentDetails: any
  ): 'low' | 'medium' | 'high' | 'critical' {
    switch (incidentType) {
      case 'data_breach':
        return 'critical';
      case 'unauthorized_access':
        return 'high';
      case 'encryption_failure':
        return 'high';
      case 'signature_invalid':
        return 'medium';
      default:
        return 'medium';
    }
  }

  private async executeSecurityResponse(
    incidentType: string,
    incidentDetails: any,
    context: ErrorContext
  ): Promise<string[]> {
    const actions: string[] = [];

    switch (incidentType) {
      case 'data_breach':
        actions.push('Isolate affected systems');
        actions.push('Notify data protection officer');
        actions.push('Prepare breach notification');
        break;

      case 'unauthorized_access':
        actions.push('Revoke access tokens');
        actions.push('Reset credentials');
        actions.push('Review access logs');
        break;

      case 'encryption_failure':
        actions.push('Stop processing sensitive data');
        actions.push('Verify encryption configuration');
        actions.push('Re-encrypt affected data');
        break;
    }

    return actions;
  }

  private async sendSecurityAlert(
    incidentType: string,
    incidentDetails: any,
    context: ErrorContext,
    errorId: string
  ): Promise<void> {
    // Implementation would send immediate security alerts
    // This could include SMS, email, Slack, PagerDuty, etc.
    securityLogger.error(`SECURITY ALERT [${errorId}]: ${incidentType}`, {
      context,
      incidentDetails,
    });
  }

  private async addToReviewQueue(
    context: ErrorContext,
    queueName: string
  ): Promise<void> {
    // Implementation would add item to review queue
    appLogger.info(`Added to ${queueName} review queue`, { messageId: context.messageId });
  }

  private async escalateError(
    error: Error,
    context: ErrorContext,
    level: string
  ): Promise<void> {
    // Implementation would escalate to appropriate team/level
    securityLogger.info(`Escalated to ${level}`, { errorMessage: error.message, context });
  }

  private shouldSendAlert(
    classification: ErrorClassification,
    channel: AlertChannel
  ): boolean {
    // Determine if alert should be sent based on classification and channel configuration
    return (
      classification.escalationRequired ||
      classification.severity === 'critical'
    );
  }

  private async updateErrorMetrics(
    classification: ErrorClassification,
    context: ErrorContext
  ): Promise<void> {
    // Implementation would update error metrics in database or monitoring system
  }

  private async handleCriticalError(
    originalError: Error,
    context: ErrorContext,
    handlingError: Error
  ): Promise<void> {
    // Fallback error handling when the error handler itself fails
    securityLogger.error('CRITICAL: Error handler failure', {
      originalError: originalError.message,
      handlingError: handlingError.message,
      context,
    });
  }

  private initializeErrorClassification(): void {
    this.errorClassificationRules = new Map();
    // Initialize with predefined classification rules
  }

  private initializeRecoveryStrategies(): void {
    this.recoveryStrategies = new Map();
    // Initialize with predefined recovery strategies
  }

  private initializeAlertingChannels(): void {
    this.alertingChannels = [
      // Initialize alerting channels (email, Slack, etc.)
    ];
  }
}

export default ISO20022ErrorHandler;
