/**
 * Database Incident Response Service
 * Task 104.10: Database Security Monitoring
 *
 * Provides automated incident response for database security events:
 * - Auto-block after threshold violations
 * - Redis-based IP blocklist integration
 * - Alert escalation (3 levels)
 * - Evidence preservation (query logs, connection info)
 * - Integration with circuit breaker patterns
 */

import { securityLogger } from '../utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface SecurityIncident {
  id: string;
  type: IncidentType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'investigating' | 'contained' | 'resolved' | 'escalated';
  source: {
    ip?: string;
    userId?: string;
    sessionId?: string;
    userAgent?: string;
    endpoint?: string;
  };
  description: string;
  evidence: IncidentEvidence[];
  timeline: IncidentTimelineEntry[];
  response: {
    blocked: boolean;
    blockReason?: string;
    blockDuration?: number;
    escalationLevel: number;
    notificationsSent: string[];
    automatedActions: string[];
  };
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  resolutionNotes?: string;
}

type IncidentType =
  | 'SQL_INJECTION_ATTEMPT'
  | 'BRUTE_FORCE_ATTACK'
  | 'DATA_EXFILTRATION'
  | 'PRIVILEGE_ESCALATION'
  | 'UNAUTHORIZED_ACCESS'
  | 'RATE_LIMIT_EXCEEDED'
  | 'ANOMALOUS_BEHAVIOR'
  | 'SCHEMA_TAMPERING'
  | 'CONNECTION_FLOODING';

interface IncidentEvidence {
  type: 'query_log' | 'access_log' | 'error_log' | 'system_state' | 'screenshot';
  timestamp: Date;
  description: string;
  data: unknown;
  hash: string; // For integrity verification
}

interface IncidentTimelineEntry {
  timestamp: Date;
  action: string;
  actor: 'system' | 'user' | 'admin';
  details?: string;
}

interface BlocklistEntry {
  ip: string;
  reason: string;
  incidentId: string;
  blockedAt: Date;
  expiresAt?: Date;
  permanent: boolean;
  bypassToken?: string;
}

interface EscalationPolicy {
  level: number;
  triggerConditions: {
    incidentCount?: number;
    timeWindow?: number;
    severities?: string[];
  };
  actions: EscalationAction[];
  notifications: NotificationConfig[];
}

interface EscalationAction {
  type: 'block_ip' | 'disable_user' | 'circuit_breaker' | 'rate_limit' | 'alert';
  parameters: Record<string, unknown>;
}

interface NotificationConfig {
  channel: 'email' | 'slack' | 'pagerduty' | 'webhook';
  recipients: string[];
  priority: 'low' | 'normal' | 'high' | 'urgent';
}

interface IncidentResponseConfig {
  autoBlockEnabled: boolean;
  autoBlockThresholds: {
    sqlInjectionAttempts: number;
    failedAuthAttempts: number;
    rateLimitExceeded: number;
    anomalyScore: number;
  };
  blockDurations: {
    temporary: number; // seconds
    extended: number;
    permanent: boolean;
  };
  escalationPolicies: EscalationPolicy[];
  evidenceRetentionDays: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: IncidentResponseConfig = {
  autoBlockEnabled: true,
  autoBlockThresholds: {
    sqlInjectionAttempts: 3,
    failedAuthAttempts: 10,
    rateLimitExceeded: 50,
    anomalyScore: 80,
  },
  blockDurations: {
    temporary: 300, // 5 minutes
    extended: 3600, // 1 hour
    permanent: false,
  },
  escalationPolicies: [
    {
      level: 1,
      triggerConditions: {
        incidentCount: 1,
        severities: ['medium', 'high'],
      },
      actions: [
        { type: 'alert', parameters: { message: 'New security incident' } },
      ],
      notifications: [
        { channel: 'slack', recipients: ['#security-alerts'], priority: 'normal' },
      ],
    },
    {
      level: 2,
      triggerConditions: {
        incidentCount: 3,
        timeWindow: 3600, // 1 hour
        severities: ['high', 'critical'],
      },
      actions: [
        { type: 'block_ip', parameters: { duration: 3600 } },
        { type: 'rate_limit', parameters: { factor: 0.5 } },
      ],
      notifications: [
        { channel: 'slack', recipients: ['#security-alerts'], priority: 'high' },
        { channel: 'email', recipients: ['security@company.com'], priority: 'high' },
      ],
    },
    {
      level: 3,
      triggerConditions: {
        incidentCount: 5,
        timeWindow: 1800, // 30 minutes
        severities: ['critical'],
      },
      actions: [
        { type: 'block_ip', parameters: { permanent: true } },
        { type: 'disable_user', parameters: {} },
        { type: 'circuit_breaker', parameters: { open: true } },
      ],
      notifications: [
        { channel: 'pagerduty', recipients: ['security-oncall'], priority: 'urgent' },
        { channel: 'slack', recipients: ['#security-critical'], priority: 'urgent' },
        { channel: 'email', recipients: ['cto@company.com', 'ciso@company.com'], priority: 'urgent' },
      ],
    },
  ],
  evidenceRetentionDays: 90,
};

// ============================================================================
// Database Incident Response Service
// ============================================================================

export class DatabaseIncidentResponseService {
  private incidents: Map<string, SecurityIncident> = new Map();
  private blocklist: Map<string, BlocklistEntry> = new Map();
  private incidentCounts: Map<string, { count: number; firstIncident: Date }> = new Map();
  private config: IncidentResponseConfig;

  // Simulated Redis client (in production, use actual Redis)
  private blocklistCache: Map<string, BlocklistEntry> = new Map();

  constructor(config: Partial<IncidentResponseConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Start periodic tasks
    this.startPeriodicTasks();
  }

  // ============================================================================
  // Incident Management
  // ============================================================================

  /**
   * Create and process a new security incident
   */
  async createIncident(params: {
    type: IncidentType;
    severity: SecurityIncident['severity'];
    source: SecurityIncident['source'];
    description: string;
    evidence?: Omit<IncidentEvidence, 'hash'>[];
  }): Promise<SecurityIncident> {
    const incident: SecurityIncident = {
      id: this.generateId(),
      type: params.type,
      severity: params.severity,
      status: 'open',
      source: params.source,
      description: params.description,
      evidence: (params.evidence || []).map((e) => ({
        ...e,
        hash: this.hashEvidence(e.data),
      })),
      timeline: [
        {
          timestamp: new Date(),
          action: 'Incident created',
          actor: 'system',
          details: `${params.type}: ${params.description}`,
        },
      ],
      response: {
        blocked: false,
        escalationLevel: 0,
        notificationsSent: [],
        automatedActions: [],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.incidents.set(incident.id, incident);

    // Track incident count for source
    await this.trackIncidentSource(incident);

    // Process automated response
    await this.processAutomatedResponse(incident);

    // Log incident
    securityLogger.warn('[SECURITY_INCIDENT]', {
      id: incident.id,
      type: incident.type,
      severity: incident.severity,
      source: incident.source,
    });

    return incident;
  }

  /**
   * Track incident source for escalation
   */
  private async trackIncidentSource(incident: SecurityIncident): Promise<void> {
    const sourceKey = incident.source.ip || incident.source.userId || 'unknown';
    const existing = this.incidentCounts.get(sourceKey);

    if (existing) {
      existing.count++;
    } else {
      this.incidentCounts.set(sourceKey, {
        count: 1,
        firstIncident: new Date(),
      });
    }
  }

  /**
   * Process automated response based on incident
   */
  private async processAutomatedResponse(incident: SecurityIncident): Promise<void> {
    // Check if auto-block is enabled
    if (!this.config.autoBlockEnabled) {
      return;
    }

    const sourceKey = incident.source.ip || incident.source.userId;
    if (!sourceKey) {
      return;
    }

    // Check thresholds
    const shouldBlock = this.checkBlockThresholds(incident);

    if (shouldBlock) {
      await this.blockSource(incident, 'Auto-blocked due to security threshold');
    }

    // Check escalation
    await this.checkEscalation(incident);
  }

  /**
   * Check if block thresholds are met
   */
  private checkBlockThresholds(incident: SecurityIncident): boolean {
    const thresholds = this.config.autoBlockThresholds;

    switch (incident.type) {
      case 'SQL_INJECTION_ATTEMPT': {
        const sourceKey = incident.source.ip || 'unknown';
        const count = this.getIncidentCount(sourceKey, 'SQL_INJECTION_ATTEMPT');
        return count >= thresholds.sqlInjectionAttempts;
      }
      case 'BRUTE_FORCE_ATTACK': {
        const sourceKey = incident.source.ip || 'unknown';
        const count = this.getIncidentCount(sourceKey, 'BRUTE_FORCE_ATTACK');
        return count >= thresholds.failedAuthAttempts;
      }
      case 'RATE_LIMIT_EXCEEDED': {
        const sourceKey = incident.source.ip || 'unknown';
        const count = this.getIncidentCount(sourceKey, 'RATE_LIMIT_EXCEEDED');
        return count >= thresholds.rateLimitExceeded;
      }
      default:
        return incident.severity === 'critical';
    }
  }

  /**
   * Get incident count for source and type
   */
  private getIncidentCount(sourceKey: string, type: IncidentType): number {
    let count = 0;
    for (const incident of this.incidents.values()) {
      if (
        incident.type === type &&
        (incident.source.ip === sourceKey || incident.source.userId === sourceKey)
      ) {
        count++;
      }
    }
    return count;
  }

  // ============================================================================
  // Blocking and Escalation
  // ============================================================================

  /**
   * Block a source (IP or user)
   */
  async blockSource(
    incident: SecurityIncident,
    reason: string,
    duration?: number,
    permanent: boolean = false
  ): Promise<void> {
    const ip = incident.source.ip;
    if (!ip) {
      return;
    }

    const blockDuration = permanent
      ? undefined
      : duration || this.config.blockDurations.temporary;

    const blockEntry: BlocklistEntry = {
      ip,
      reason,
      incidentId: incident.id,
      blockedAt: new Date(),
      expiresAt: blockDuration
        ? new Date(Date.now() + blockDuration * 1000)
        : undefined,
      permanent,
    };

    // Add to blocklist
    this.blocklist.set(ip, blockEntry);
    this.blocklistCache.set(ip, blockEntry);

    // Update incident
    incident.response.blocked = true;
    incident.response.blockReason = reason;
    incident.response.blockDuration = blockDuration;

    // Add to timeline
    incident.timeline.push({
      timestamp: new Date(),
      action: permanent ? 'Permanently blocked' : `Blocked for ${blockDuration}s`,
      actor: 'system',
      details: reason,
    });

    incident.response.automatedActions.push(
      `Blocked IP ${ip} ${permanent ? 'permanently' : `for ${blockDuration}s`}`
    );

    securityLogger.warn('[IP_BLOCKED]', {
      ip,
      reason,
      incidentId: incident.id,
      permanent,
      expiresAt: blockEntry.expiresAt,
    });
  }

  /**
   * Check and process escalation
   */
  private async checkEscalation(incident: SecurityIncident): Promise<void> {
    const sourceKey = incident.source.ip || incident.source.userId || 'unknown';
    const sourceData = this.incidentCounts.get(sourceKey);

    if (!sourceData) {
      return;
    }

    for (const policy of this.config.escalationPolicies) {
      if (this.shouldEscalate(policy, sourceData, incident)) {
        await this.executeEscalation(incident, policy);
        break; // Only execute highest matching escalation
      }
    }
  }

  /**
   * Check if escalation conditions are met
   */
  private shouldEscalate(
    policy: EscalationPolicy,
    sourceData: { count: number; firstIncident: Date },
    incident: SecurityIncident
  ): boolean {
    const conditions = policy.triggerConditions;

    // Check incident count
    if (conditions.incidentCount && sourceData.count < conditions.incidentCount) {
      return false;
    }

    // Check time window
    if (conditions.timeWindow) {
      const windowStart = Date.now() - conditions.timeWindow * 1000;
      if (sourceData.firstIncident.getTime() < windowStart) {
        // Reset count if window expired
        sourceData.count = 1;
        sourceData.firstIncident = new Date();
        return false;
      }
    }

    // Check severity
    if (conditions.severities && !conditions.severities.includes(incident.severity)) {
      return false;
    }

    // Check if already at this escalation level or higher
    if (incident.response.escalationLevel >= policy.level) {
      return false;
    }

    return true;
  }

  /**
   * Execute escalation actions
   */
  private async executeEscalation(
    incident: SecurityIncident,
    policy: EscalationPolicy
  ): Promise<void> {
    incident.response.escalationLevel = policy.level;
    incident.status = 'escalated';

    // Add to timeline
    incident.timeline.push({
      timestamp: new Date(),
      action: `Escalated to level ${policy.level}`,
      actor: 'system',
      details: `Triggered by: ${JSON.stringify(policy.triggerConditions)}`,
    });

    // Execute actions
    for (const action of policy.actions) {
      await this.executeAction(incident, action);
    }

    // Send notifications
    for (const notification of policy.notifications) {
      await this.sendNotification(incident, notification);
    }

    securityLogger.error('[INCIDENT_ESCALATED]', {
      incidentId: incident.id,
      level: policy.level,
      actions: policy.actions.map((a) => a.type),
    });
  }

  /**
   * Execute escalation action
   */
  private async executeAction(
    incident: SecurityIncident,
    action: EscalationAction
  ): Promise<void> {
    const actionDesc = `${action.type}: ${JSON.stringify(action.parameters)}`;
    incident.response.automatedActions.push(actionDesc);

    switch (action.type) {
      case 'block_ip':
        if (incident.source.ip) {
          await this.blockSource(
            incident,
            'Escalation action',
            action.parameters.duration as number,
            action.parameters.permanent as boolean
          );
        }
        break;

      case 'disable_user':
        if (incident.source.userId) {
          // In production, integrate with user service
          securityLogger.warn('[USER_DISABLED]', {
            userId: incident.source.userId,
            reason: 'Security escalation',
          });
          incident.timeline.push({
            timestamp: new Date(),
            action: 'User account disabled',
            actor: 'system',
            details: `User ${incident.source.userId} disabled due to security escalation`,
          });
        }
        break;

      case 'circuit_breaker':
        // In production, integrate with circuit breaker
        securityLogger.warn('[CIRCUIT_BREAKER_ACTIVATED]', {
          incidentId: incident.id,
          open: action.parameters.open,
        });
        incident.timeline.push({
          timestamp: new Date(),
          action: 'Circuit breaker activated',
          actor: 'system',
        });
        break;

      case 'rate_limit':
        securityLogger.warn('[RATE_LIMIT_ADJUSTED]', {
          incidentId: incident.id,
          factor: action.parameters.factor,
        });
        incident.timeline.push({
          timestamp: new Date(),
          action: `Rate limit adjusted by factor ${action.parameters.factor}`,
          actor: 'system',
        });
        break;

      case 'alert':
        securityLogger.error('[SECURITY_ALERT]', {
          incidentId: incident.id,
          message: action.parameters.message,
        });
        break;
    }
  }

  /**
   * Send notification
   */
  private async sendNotification(
    incident: SecurityIncident,
    config: NotificationConfig
  ): Promise<void> {
    // In production, integrate with notification services
    const notification = {
      channel: config.channel,
      recipients: config.recipients,
      priority: config.priority,
      subject: `Security Incident: ${incident.type}`,
      body: `
Incident ID: ${incident.id}
Type: ${incident.type}
Severity: ${incident.severity}
Source IP: ${incident.source.ip || 'N/A'}
User ID: ${incident.source.userId || 'N/A'}
Description: ${incident.description}
Status: ${incident.status}
Escalation Level: ${incident.response.escalationLevel}
      `.trim(),
    };

    securityLogger.info('[NOTIFICATION_SENT]', { notification });
    incident.response.notificationsSent.push(
      `${config.channel}:${config.recipients.join(',')}`
    );

    incident.timeline.push({
      timestamp: new Date(),
      action: `Notification sent via ${config.channel}`,
      actor: 'system',
      details: `Recipients: ${config.recipients.join(', ')}`,
    });
  }

  // ============================================================================
  // Blocklist Management
  // ============================================================================

  /**
   * Check if IP is blocked
   */
  isBlocked(ip: string): { blocked: boolean; entry?: BlocklistEntry } {
    const entry = this.blocklist.get(ip) || this.blocklistCache.get(ip);

    if (!entry) {
      return { blocked: false };
    }

    // Check expiration
    if (entry.expiresAt && entry.expiresAt < new Date()) {
      this.blocklist.delete(ip);
      this.blocklistCache.delete(ip);
      return { blocked: false };
    }

    return { blocked: true, entry };
  }

  /**
   * Unblock an IP
   */
  unblock(ip: string, reason: string, unblockerId: string): boolean {
    const entry = this.blocklist.get(ip);
    if (!entry) {
      return false;
    }

    // Find related incident and update
    const incident = this.incidents.get(entry.incidentId);
    if (incident) {
      incident.timeline.push({
        timestamp: new Date(),
        action: 'IP unblocked',
        actor: 'user',
        details: `Unblocked by ${unblockerId}: ${reason}`,
      });
    }

    this.blocklist.delete(ip);
    this.blocklistCache.delete(ip);

    securityLogger.info('[IP_UNBLOCKED]', { ip, reason, unblockerId });
    return true;
  }

  /**
   * Get all blocked IPs
   */
  getBlocklist(): BlocklistEntry[] {
    return Array.from(this.blocklist.values());
  }

  // ============================================================================
  // Evidence Management
  // ============================================================================

  /**
   * Add evidence to an incident
   */
  addEvidence(
    incidentId: string,
    evidence: Omit<IncidentEvidence, 'hash'>
  ): boolean {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      return false;
    }

    incident.evidence.push({
      ...evidence,
      hash: this.hashEvidence(evidence.data),
    });

    incident.timeline.push({
      timestamp: new Date(),
      action: 'Evidence added',
      actor: 'system',
      details: evidence.description,
    });

    incident.updatedAt = new Date();
    return true;
  }

  /**
   * Hash evidence for integrity verification
   */
  private hashEvidence(data: unknown): string {
    const crypto = require('crypto');
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  /**
   * Verify evidence integrity
   */
  verifyEvidence(incidentId: string): { valid: boolean; issues: string[] } {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      return { valid: false, issues: ['Incident not found'] };
    }

    const issues: string[] = [];

    for (const evidence of incident.evidence) {
      const expectedHash = this.hashEvidence(evidence.data);
      if (expectedHash !== evidence.hash) {
        issues.push(`Evidence integrity check failed: ${evidence.description}`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  // ============================================================================
  // Incident Resolution
  // ============================================================================

  /**
   * Resolve an incident
   */
  resolveIncident(
    incidentId: string,
    resolverId: string,
    notes: string
  ): boolean {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      return false;
    }

    incident.status = 'resolved';
    incident.resolvedAt = new Date();
    incident.resolvedBy = resolverId;
    incident.resolutionNotes = notes;
    incident.updatedAt = new Date();

    incident.timeline.push({
      timestamp: new Date(),
      action: 'Incident resolved',
      actor: 'user',
      details: `Resolved by ${resolverId}: ${notes}`,
    });

    securityLogger.info('[INCIDENT_RESOLVED]', {
      incidentId,
      resolverId,
      notes,
    });

    return true;
  }

  /**
   * Update incident status
   */
  updateIncidentStatus(
    incidentId: string,
    status: SecurityIncident['status'],
    updaterId: string,
    notes?: string
  ): boolean {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      return false;
    }

    const previousStatus = incident.status;
    incident.status = status;
    incident.updatedAt = new Date();

    incident.timeline.push({
      timestamp: new Date(),
      action: `Status changed: ${previousStatus} -> ${status}`,
      actor: 'user',
      details: notes || `Updated by ${updaterId}`,
    });

    return true;
  }

  // ============================================================================
  // Query and Reporting
  // ============================================================================

  /**
   * Get all incidents
   */
  getIncidents(filters?: {
    type?: IncidentType;
    severity?: SecurityIncident['severity'];
    status?: SecurityIncident['status'];
    since?: Date;
    limit?: number;
  }): SecurityIncident[] {
    let incidents = Array.from(this.incidents.values());

    if (filters?.type) {
      incidents = incidents.filter((i) => i.type === filters.type);
    }

    if (filters?.severity) {
      incidents = incidents.filter((i) => i.severity === filters.severity);
    }

    if (filters?.status) {
      incidents = incidents.filter((i) => i.status === filters.status);
    }

    if (filters?.since) {
      incidents = incidents.filter((i) => i.createdAt >= filters.since!);
    }

    // Sort by creation date descending
    incidents.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (filters?.limit) {
      incidents = incidents.slice(0, filters.limit);
    }

    return incidents;
  }

  /**
   * Get incident by ID
   */
  getIncident(incidentId: string): SecurityIncident | undefined {
    return this.incidents.get(incidentId);
  }

  /**
   * Get incident statistics
   */
  getStats(): {
    total: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
    byStatus: Record<string, number>;
    blockedIPs: number;
    last24Hours: number;
  } {
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let last24Hours = 0;

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    for (const incident of this.incidents.values()) {
      byType[incident.type] = (byType[incident.type] || 0) + 1;
      bySeverity[incident.severity] = (bySeverity[incident.severity] || 0) + 1;
      byStatus[incident.status] = (byStatus[incident.status] || 0) + 1;

      if (incident.createdAt.getTime() > oneDayAgo) {
        last24Hours++;
      }
    }

    return {
      total: this.incidents.size,
      byType,
      bySeverity,
      byStatus,
      blockedIPs: this.blocklist.size,
      last24Hours,
    };
  }

  // ============================================================================
  // Periodic Tasks
  // ============================================================================

  /**
   * Start periodic cleanup and maintenance
   */
  private startPeriodicTasks(): void {
    // Clean expired blocks every minute
    setInterval(() => {
      this.cleanExpiredBlocks();
    }, 60000);

    // Clean old incidents every hour
    setInterval(() => {
      this.cleanOldIncidents();
    }, 3600000);
  }

  /**
   * Remove expired block entries
   */
  private cleanExpiredBlocks(): void {
    const now = new Date();

    for (const [ip, entry] of this.blocklist.entries()) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.blocklist.delete(ip);
        this.blocklistCache.delete(ip);
        securityLogger.info('[BLOCK_EXPIRED]', { ip });
      }
    }
  }

  /**
   * Clean old incidents based on retention policy
   */
  private cleanOldIncidents(): void {
    const retentionMs = this.config.evidenceRetentionDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;

    for (const [id, incident] of this.incidents.entries()) {
      if (incident.status === 'resolved' && incident.createdAt.getTime() < cutoff) {
        this.incidents.delete(id);
      }
    }
  }

  // ============================================================================
  // Utility
  // ============================================================================

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `inc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: DatabaseIncidentResponseService | null = null;

export function getDatabaseIncidentResponseService(
  config?: Partial<IncidentResponseConfig>
): DatabaseIncidentResponseService {
  if (!instance) {
    instance = new DatabaseIncidentResponseService(config);
  }
  return instance;
}

// ============================================================================
// Export
// ============================================================================

export default {
  DatabaseIncidentResponseService,
  getDatabaseIncidentResponseService,
};
