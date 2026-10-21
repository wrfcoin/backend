/**
 * Emergency Response System for ISO 22301 Business Continuity
 * Comprehensive emergency protocols, automated response, and crisis management
 */

const crypto = require('crypto');
const { appLogger } = require('../server/utils/logger');

let authenticateToken, requireRole;
import('../server/middleware/auth-middleware.js').then((mod) => {
  authenticateToken = mod.authenticateToken;
  requireRole = mod.requireRole;
}).catch((err) => {
  appLogger.error('Failed to load auth middleware for emergency endpoints', { error: err.message });
});

class EmergencyResponseSystem {
  constructor() {
    this.emergencyPlans = new Map();
    this.activeIncidents = new Map();
    this.responseTeams = new Map();
    this.communicationChannels = new Map();
    this.escalationMatrix = new Map();
    this.alertSystems = new Map();
    this.auditLog = [];

    // Pluggable notification dispatch handlers keyed by channel type.
    // Each handler: async (channel, payload) => { delivered: boolean, message: string }
    this.notificationDispatchers = new Map();
    this.registerDefaultDispatchers();

    this.initializeEmergencyFramework();
  }

  registerDefaultDispatchers() {
    // Webhook dispatcher: actually POSTs JSON to the configured endpoint
    this.notificationDispatchers.set('webhook', async (channel, payload) => {
      const url = process.env.EMERGENCY_WEBHOOK_URL || channel.endpoint;
      if (!url || url === 'https://monitoring.wrfcoin.org/webhooks/emergency') {
        return { delivered: false, message: 'Webhook URL not configured (set EMERGENCY_WEBHOOK_URL)' };
      }
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        throw new Error(`Webhook returned ${resp.status}: ${resp.statusText}`);
      }
      return { delivered: true, message: `Webhook POST ${resp.status}` };
    });

    // Console/log dispatcher: logs at info level (universal fallback)
    this.notificationDispatchers.set('console', async (_channel, payload) => {
      appLogger.info('Emergency notification delivered via console channel', {
        incidentId: payload.incidentId,
        severity: payload.severity,
        title: payload.title,
      });
      return { delivered: true, message: 'Logged to console' };
    });
  }

  registerNotificationDispatcher(channelType, handler) {
    this.notificationDispatchers.set(channelType, handler);
  }

  // Initialize comprehensive emergency response framework
  initializeEmergencyFramework() {
    // Define emergency severity levels
    this.severityLevels = {
      LOW: {
        level: 1,
        name: 'Low Impact',
        description: 'Minor disruption, limited impact',
        responseTime: 4, // hours
        escalationThreshold: 2, // hours
        notificationLevel: 'team',
      },
      MEDIUM: {
        level: 2,
        name: 'Medium Impact',
        description: 'Moderate disruption, some services affected',
        responseTime: 2, // hours
        escalationThreshold: 1, // hour
        notificationLevel: 'management',
      },
      HIGH: {
        level: 3,
        name: 'High Impact',
        description: 'Significant disruption, multiple services affected',
        responseTime: 1, // hour
        escalationThreshold: 0.5, // 30 minutes
        notificationLevel: 'executive',
      },
      CRITICAL: {
        level: 4,
        name: 'Critical Impact',
        description: 'Severe disruption, core services down',
        responseTime: 0.25, // 15 minutes
        escalationThreshold: 0.17, // 10 minutes
        notificationLevel: 'all_hands',
      },
      CATASTROPHIC: {
        level: 5,
        name: 'Catastrophic',
        description: 'Complete system failure, business continuity at risk',
        responseTime: 0.08, // 5 minutes
        escalationThreshold: 0.05, // 3 minutes
        notificationLevel: 'emergency_broadcast',
      },
    };

    // Initialize response teams
    this.initializeResponseTeams();

    // Initialize communication channels
    this.initializeCommunicationChannels();

    // Initialize emergency plans
    this.initializeEmergencyPlans();

    // Initialize alert systems
    this.initializeAlertSystems();
  }

  // Initialize emergency response teams
  initializeResponseTeams() {
    this.responseTeams.set('INCIDENT_COMMAND', {
      name: 'Incident Command Team',
      role: 'Overall incident coordination and decision making',
      members: [
        {
          id: 'ic_lead',
          name: 'Incident Commander',
          role: 'leader',
          contact: '+1-555-COMMAND',
        },
        {
          id: 'ic_deputy',
          name: 'Deputy Commander',
          role: 'backup',
          contact: '+1-555-DEPUTY',
        },
      ],
      capabilities: [
        'coordination',
        'decision_making',
        'external_communication',
      ],
      activationCriteria: ['MEDIUM', 'HIGH', 'CRITICAL', 'CATASTROPHIC'],
    });

    this.responseTeams.set('TECHNICAL_RESPONSE', {
      name: 'Technical Response Team',
      role: 'Technical investigation and resolution',
      members: [
        {
          id: 'tech_lead',
          name: 'Technical Lead',
          role: 'leader',
          contact: '+1-555-TECHOPS',
        },
        {
          id: 'sys_admin',
          name: 'System Administrator',
          role: 'specialist',
          contact: '+1-555-SYSADMIN',
        },
        {
          id: 'dev_lead',
          name: 'Development Lead',
          role: 'specialist',
          contact: '+1-555-DEVTEAM',
        },
      ],
      capabilities: ['system_diagnosis', 'technical_repair', 'code_deployment'],
      activationCriteria: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'CATASTROPHIC'],
    });

    this.responseTeams.set('COMMUNICATIONS', {
      name: 'Communications Team',
      role: 'Internal and external communications',
      members: [
        {
          id: 'comm_lead',
          name: 'Communications Lead',
          role: 'leader',
          contact: '+1-555-COMMS',
        },
        {
          id: 'pr_manager',
          name: 'PR Manager',
          role: 'external',
          contact: '+1-555-PRESS',
        },
        {
          id: 'customer_success',
          name: 'Customer Success',
          role: 'customer',
          contact: '+1-555-CUSTOMER',
        },
      ],
      capabilities: [
        'stakeholder_communication',
        'media_relations',
        'customer_updates',
      ],
      activationCriteria: ['HIGH', 'CRITICAL', 'CATASTROPHIC'],
    });

    this.responseTeams.set('SECURITY', {
      name: 'Security Response Team',
      role: 'Security incident investigation and response',
      members: [
        {
          id: 'sec_lead',
          name: 'Security Lead',
          role: 'leader',
          contact: '+1-555-SECURITY',
        },
        {
          id: 'forensics',
          name: 'Digital Forensics',
          role: 'specialist',
          contact: '+1-555-FORENSICS',
        },
        {
          id: 'compliance',
          name: 'Compliance Officer',
          role: 'compliance',
          contact: '+1-555-COMPLIANCE',
        },
      ],
      capabilities: [
        'threat_analysis',
        'digital_forensics',
        'regulatory_compliance',
      ],
      activationCriteria: ['security_incident', 'data_breach', 'cyber_attack'],
    });

    this.responseTeams.set('CLIMATE_OPERATIONS', {
      name: 'Climate Operations Team',
      role: 'Weather station and climate data emergency response',
      members: [
        {
          id: 'climate_lead',
          name: 'Climate Operations Lead',
          role: 'leader',
          contact: '+1-555-CLIMATE',
        },
        {
          id: 'meteorologist',
          name: 'Chief Meteorologist',
          role: 'specialist',
          contact: '+1-555-WEATHER',
        },
        {
          id: 'field_ops',
          name: 'Field Operations',
          role: 'field',
          contact: '+1-555-FIELDOPS',
        },
      ],
      capabilities: ['weather_monitoring', 'sensor_repair', 'data_validation'],
      activationCriteria: [
        'weather_emergency',
        'sensor_failure',
        'data_quality_crisis',
      ],
    });
  }

  // Initialize communication channels
  initializeCommunicationChannels() {
    this.communicationChannels.set('EMAIL_ALERTS', {
      type: 'email',
      name: 'Email Alert System',
      endpoint: 'alerts@wrfcoin.org',
      enabled: true,
      priority: 'standard',
    });

    this.communicationChannels.set('SMS_ALERTS', {
      type: 'sms',
      name: 'SMS Emergency Alerts',
      endpoint: '+1-555-ALERTS',
      enabled: true,
      priority: 'urgent',
    });

    this.communicationChannels.set('SLACK_INCIDENT', {
      type: 'slack',
      name: 'Slack Incident Channel',
      endpoint: '#incident-response',
      enabled: true,
      priority: 'coordination',
    });

    this.communicationChannels.set('DISCORD_EMERGENCY', {
      type: 'discord',
      name: 'Discord Emergency Channel',
      endpoint: 'https://discord.gg/wrfcoin-emergency',
      enabled: true,
      priority: 'community',
    });

    this.communicationChannels.set('WEBHOOK_MONITORING', {
      type: 'webhook',
      name: 'Monitoring System Webhooks',
      endpoint: 'https://monitoring.wrfcoin.org/webhooks/emergency',
      enabled: true,
      priority: 'automated',
    });
  }

  // Initialize emergency response plans
  initializeEmergencyPlans() {
    // Data Center Failure Plan
    this.emergencyPlans.set('DATA_CENTER_FAILURE', {
      id: 'DATA_CENTER_FAILURE',
      name: 'Data Center Emergency Response',
      description:
        'Response to complete data center failure or natural disaster',
      triggerConditions: [
        'infrastructure_failure',
        'natural_disaster',
        'power_outage',
      ],
      severity: 'CRITICAL',
      steps: [
        {
          step: 1,
          action: 'Assess extent of failure',
          responsible: 'TECHNICAL_RESPONSE',
          timeframe: '5 minutes',
          automated: false,
        },
        {
          step: 2,
          action: 'Activate backup data center',
          responsible: 'TECHNICAL_RESPONSE',
          timeframe: '10 minutes',
          automated: true,
        },
        {
          step: 3,
          action: 'Redirect traffic to backup systems',
          responsible: 'TECHNICAL_RESPONSE',
          timeframe: '15 minutes',
          automated: true,
        },
        {
          step: 4,
          action: 'Notify stakeholders',
          responsible: 'COMMUNICATIONS',
          timeframe: '20 minutes',
          automated: false,
        },
        {
          step: 5,
          action: 'Begin recovery operations',
          responsible: 'TECHNICAL_RESPONSE',
          timeframe: '30 minutes',
          automated: false,
        },
      ],
      estimatedRecoveryTime: '2-4 hours',
      businessImpact: 'Complete service outage',
    });

    // Cybersecurity Incident Plan
    this.emergencyPlans.set('CYBERSECURITY_INCIDENT', {
      id: 'CYBERSECURITY_INCIDENT',
      name: 'Cybersecurity Emergency Response',
      description: 'Response to security breaches, attacks, or data breaches',
      triggerConditions: [
        'security_breach',
        'malware_detection',
        'ddos_attack',
        'unauthorized_access',
      ],
      severity: 'HIGH',
      steps: [
        {
          step: 1,
          action: 'Isolate affected systems',
          responsible: 'SECURITY',
          timeframe: '2 minutes',
          automated: true,
        },
        {
          step: 2,
          action: 'Assess scope of incident',
          responsible: 'SECURITY',
          timeframe: '10 minutes',
          automated: false,
        },
        {
          step: 3,
          action: 'Notify law enforcement if required',
          responsible: 'SECURITY',
          timeframe: '30 minutes',
          automated: false,
        },
        {
          step: 4,
          action: 'Begin forensic analysis',
          responsible: 'SECURITY',
          timeframe: '1 hour',
          automated: false,
        },
        {
          step: 5,
          action: 'Implement containment measures',
          responsible: 'SECURITY',
          timeframe: '2 hours',
          automated: false,
        },
      ],
      estimatedRecoveryTime: '4-24 hours',
      businessImpact: 'Potential data compromise, service degradation',
    });

    // Weather Emergency Plan
    this.emergencyPlans.set('WEATHER_EMERGENCY', {
      id: 'WEATHER_EMERGENCY',
      name: 'Severe Weather Emergency Response',
      description: 'Response to severe weather affecting operations',
      triggerConditions: [
        'severe_weather_warning',
        'hurricane',
        'tornado',
        'blizzard',
      ],
      severity: 'MEDIUM',
      steps: [
        {
          step: 1,
          action: 'Monitor weather conditions',
          responsible: 'CLIMATE_OPERATIONS',
          timeframe: 'Continuous',
          automated: true,
        },
        {
          step: 2,
          action: 'Secure weather stations',
          responsible: 'CLIMATE_OPERATIONS',
          timeframe: '30 minutes',
          automated: false,
        },
        {
          step: 3,
          action: 'Activate backup data collection',
          responsible: 'CLIMATE_OPERATIONS',
          timeframe: '45 minutes',
          automated: true,
        },
        {
          step: 4,
          action: 'Ensure personnel safety',
          responsible: 'INCIDENT_COMMAND',
          timeframe: '1 hour',
          automated: false,
        },
      ],
      estimatedRecoveryTime: '6-48 hours',
      businessImpact: 'Reduced data collection, potential equipment damage',
    });
  }

  // Initialize automated alert systems
  initializeAlertSystems() {
    this.alertSystems.set('SYSTEM_MONITORING', {
      name: 'System Health Monitoring',
      type: 'automated',
      triggers: ['cpu_high', 'memory_high', 'disk_full', 'network_down'],
      thresholds: {
        cpu_high: 90,
        memory_high: 85,
        disk_full: 95,
        response_time: 5000,
      },
      actions: ['alert_team', 'auto_scale', 'failover'],
    });

    this.alertSystems.set('SECURITY_MONITORING', {
      name: 'Security Event Monitoring',
      type: 'automated',
      triggers: ['failed_logins', 'suspicious_activity', 'malware_detected'],
      thresholds: {
        failed_logins: 10,
        suspicious_requests: 100,
        malware_score: 0.8,
      },
      actions: ['alert_security', 'block_ip', 'isolate_system'],
    });

    this.alertSystems.set('CLIMATE_MONITORING', {
      name: 'Climate Data Quality Monitoring',
      type: 'automated',
      triggers: ['data_quality_drop', 'sensor_offline', 'calibration_drift'],
      thresholds: {
        quality_score: 85,
        offline_sensors: 5,
        drift_percentage: 10,
      },
      actions: [
        'alert_climate_team',
        'activate_backup',
        'schedule_maintenance',
      ],
    });
  }

  // Declare emergency incident
  async declareEmergency(incidentData) {
    const incidentId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const incident = {
      id: incidentId,
      title: incidentData.title,
      description: incidentData.description,
      type: incidentData.type,
      severity: incidentData.severity,
      location: incidentData.location || 'Unknown',

      // Incident lifecycle
      status: 'DECLARED',
      declaredAt: timestamp,
      declaredBy: incidentData.declaredBy,
      acknowledgedAt: null,
      resolvedAt: null,

      // Response coordination
      incidentCommander: null,
      activeTeams: [],
      activePlan: null,

      // Communication
      notifications: [],
      updates: [],

      // Timeline and escalation
      timeline: [
        {
          timestamp,
          event: 'INCIDENT_DECLARED',
          actor: incidentData.declaredBy,
          description: `Emergency declared: ${incidentData.title}`,
          severity: incidentData.severity,
        },
      ],

      // Impact assessment
      impact: {
        affectedServices: incidentData.affectedServices || [],
        affectedUsers: incidentData.affectedUsers || 0,
        businessImpact: incidentData.businessImpact || 'Unknown',
        estimatedLoss: incidentData.estimatedLoss || 0,
      },

      // Response metrics
      metrics: {
        responseTime: null,
        escalationTime: null,
        resolutionTime: null,
        communicationEffectiveness: null,
      },
    };

    // Store incident
    this.activeIncidents.set(incidentId, incident);

    // Automatically activate appropriate response plan
    const responsePlan = await this.selectResponsePlan(incident);
    if (responsePlan) {
      incident.activePlan = responsePlan.id;
      await this.activateResponsePlan(incidentId, responsePlan);
    }

    // Assign incident commander based on severity
    const commander = await this.assignIncidentCommander(incident.severity);
    if (commander) {
      incident.incidentCommander = commander.id;
    }

    // Trigger immediate notifications
    await this.triggerEmergencyNotifications(incident);

    // Start automated response procedures
    await this.initiateAutomatedResponse(incident);

    await this.logEmergencyActivity('emergency_declared', {
      incidentId,
      severity: incident.severity,
      type: incident.type,
      commander: incident.incidentCommander,
    });

    return {
      success: true,
      incidentId,
      incident: this.sanitizeIncidentForResponse(incident),
      activePlan: responsePlan?.name,
      incidentCommander: commander?.name,
    };
  }

  // Activate specific emergency response plan
  async activateResponsePlan(incidentId, plan) {
    const incident = this.activeIncidents.get(incidentId);
    if (!incident) {
      throw new Error('Incident not found');
    }

    const activationId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Execute plan steps
    const execution = {
      activationId,
      planId: plan.id,
      incidentId,
      startedAt: timestamp,
      steps: plan.steps.map(step => ({
        ...step,
        status: 'pending',
        startedAt: null,
        completedAt: null,
        assignedTo: null,
        result: null,
      })),
      status: 'active',
    };

    // Activate required response teams
    for (const step of plan.steps) {
      const team = this.responseTeams.get(step.responsible);
      if (team && !incident.activeTeams.includes(step.responsible)) {
        incident.activeTeams.push(step.responsible);
        await this.activateResponseTeam(step.responsible, incidentId);
      }
    }

    // Begin executing steps
    await this.executeResponseSteps(execution);

    // Update incident timeline
    incident.timeline.push({
      timestamp,
      event: 'RESPONSE_PLAN_ACTIVATED',
      actor: 'system',
      description: `Activated response plan: ${plan.name}`,
      planId: plan.id,
    });

    await this.logEmergencyActivity('response_plan_activated', {
      incidentId,
      planId: plan.id,
      activationId,
      teamsActivated: incident.activeTeams.length,
    });

    return {
      success: true,
      activationId,
      execution,
      teamsActivated: incident.activeTeams,
    };
  }

  // Execute emergency response steps
  async executeResponseSteps(execution) {
    for (let i = 0; i < execution.steps.length; i++) {
      const step = execution.steps[i];
      const timestamp = new Date().toISOString();

      step.status = 'in_progress';
      step.startedAt = timestamp;

      try {
        // Execute step based on automation level
        if (step.automated) {
          step.result = await this.executeAutomatedStep(
            step,
            execution.incidentId
          );
        } else {
          step.result = await this.executeManualStep(
            step,
            execution.incidentId
          );
        }

        step.status = 'completed';
        step.completedAt = new Date().toISOString();

        await this.logEmergencyActivity('response_step_completed', {
          incidentId: execution.incidentId,
          stepNumber: step.step,
          action: step.action,
          duration: new Date(step.completedAt) - new Date(step.startedAt),
        });
      } catch (error) {
        step.status = 'failed';
        step.error = error.message;
        step.completedAt = new Date().toISOString();

        await this.logEmergencyActivity('response_step_failed', {
          incidentId: execution.incidentId,
          stepNumber: step.step,
          error: error.message,
        });

        // Continue with next step even if one fails
        continue;
      }
    }

    execution.status = 'completed';
    execution.completedAt = new Date().toISOString();
  }

  // Monitor and escalate incidents based on response time
  async monitorIncidentEscalation() {
    const currentTime = new Date();

    for (const [incidentId, incident] of this.activeIncidents) {
      if (incident.status === 'RESOLVED') continue;

      const severityConfig = this.severityLevels[incident.severity];
      if (!severityConfig) continue;

      const declaredTime = new Date(incident.declaredAt);
      const timeSinceDeclaration =
        (currentTime - declaredTime) / (1000 * 60 * 60); // hours

      // Check if escalation is needed
      if (
        timeSinceDeclaration > severityConfig.escalationThreshold &&
        !incident.escalated
      ) {
        await this.escalateIncident(incidentId);
      }

      // Check if incident is taking too long to resolve
      if (timeSinceDeclaration > severityConfig.responseTime * 2) {
        await this.triggerManagementAlert(incidentId);
      }
    }
  }

  // Escalate incident to higher severity level
  async escalateIncident(incidentId) {
    const incident = this.activeIncidents.get(incidentId);
    if (!incident) return;

    const timestamp = new Date().toISOString();
    const originalSeverity = incident.severity;

    // Escalate severity level
    const severityLevels = [
      'LOW',
      'MEDIUM',
      'HIGH',
      'CRITICAL',
      'CATASTROPHIC',
    ];
    const currentIndex = severityLevels.indexOf(incident.severity);
    if (currentIndex < severityLevels.length - 1) {
      incident.severity = severityLevels[currentIndex + 1];
    }

    // Mark as escalated
    incident.escalated = true;
    incident.escalatedAt = timestamp;

    // Update timeline
    incident.timeline.push({
      timestamp,
      event: 'INCIDENT_ESCALATED',
      actor: 'system',
      description: `Incident escalated from ${originalSeverity} to ${incident.severity}`,
      reason: 'Response time threshold exceeded',
    });

    // Notify additional teams based on new severity
    await this.activateAdditionalTeams(incident);

    // Send escalation notifications
    await this.sendEscalationNotifications(incident);

    await this.logEmergencyActivity('incident_escalated', {
      incidentId,
      fromSeverity: originalSeverity,
      toSeverity: incident.severity,
      escalationReason: 'timeout',
    });
  }

  // Generate emergency status report
  async generateEmergencyStatusReport() {
    const reportId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const activeIncidents = Array.from(this.activeIncidents.values()).filter(
      incident => incident.status !== 'RESOLVED'
    );

    const report = {
      id: reportId,
      generatedAt: timestamp,

      // Overall status
      overallStatus: this.calculateOverallEmergencyStatus(activeIncidents),

      // Active incidents summary
      activeIncidents: {
        total: activeIncidents.length,
        bySeverity: this.groupIncidentsBySeverity(activeIncidents),
        byType: this.groupIncidentsByType(activeIncidents),
        oldestIncident: this.findOldestIncident(activeIncidents),
      },

      // Response team status
      responseTeams: {
        total: this.responseTeams.size,
        active: this.getActiveTeamCount(),
        utilization: this.calculateTeamUtilization(),
      },

      // System health
      systemHealth: await this.assessSystemHealth(),

      // Recent activity
      recentActivity: this.getRecentEmergencyActivity(24), // Last 24 hours

      // Recommendations
      recommendations:
        await this.generateEmergencyRecommendations(activeIncidents),
    };

    await this.logEmergencyActivity('status_report_generated', {
      reportId,
      activeIncidents: activeIncidents.length,
      overallStatus: report.overallStatus,
    });

    return report;
  }

  // Helper methods
  async selectResponsePlan(incident) {
    for (const [planId, plan] of this.emergencyPlans) {
      if (
        plan.triggerConditions.some(
          condition =>
            incident.type.includes(condition) ||
            incident.description.toLowerCase().includes(condition)
        )
      ) {
        return plan;
      }
    }
    return null;
  }

  async assignIncidentCommander(severity) {
    const commandTeam = this.responseTeams.get('INCIDENT_COMMAND');
    if (commandTeam && commandTeam.members.length > 0) {
      return commandTeam.members[0]; // Primary incident commander
    }
    return null;
  }

  async triggerEmergencyNotifications(incident) {
    const severityConfig = this.severityLevels[incident.severity];

    const enabledChannels = [...this.communicationChannels.values()].filter(c => c.enabled);
    const CONCURRENCY_LIMIT = 5;
    for (let i = 0; i < enabledChannels.length; i += CONCURRENCY_LIMIT) {
      const batch = enabledChannels.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.allSettled(
        batch.map(channel => this.sendNotification(channel, incident, severityConfig))
      );
    }
  }

  async initiateAutomatedResponse(incident) {
    const matchingSystems = [...this.alertSystems.values()].filter(
      system => system.triggers.some(trigger => incident.type.includes(trigger))
    );
    await Promise.allSettled(
      matchingSystems.map(system => this.executeAutomatedActions(system, incident))
    );
  }

  async activateResponseTeam(teamId, incidentId) {
    const team = this.responseTeams.get(teamId);
    if (!team) return;

    await Promise.allSettled(
      team.members.map(member => this.notifyTeamMember(member, incidentId))
    );

    appLogger.info('Response team activated', { teamName: team.name, incidentId });
  }

  async executeAutomatedStep(step, incidentId) {
    appLogger.warn('Automated step requires manual intervention', {
      action: step.action,
      incidentId,
      reason: 'Automated execution not yet connected to infrastructure controls',
    });

    await this.logEmergencyActivity('AUTOMATED_STEP_PENDING', {
      action: step.action,
      incidentId,
      requiresManualIntervention: true,
    });

    return {
      success: false,
      requiresManualIntervention: true,
      message: `Automated action '${step.action}' requires manual intervention`,
      action: step.action,
      incidentId,
    };
  }

  async executeManualStep(step, incidentId) {
    appLogger.warn('EMERGENCY: Manual step initiated — requires human action', {
      action: step.action,
      incidentId,
      responsible: step.responsible,
      timestamp: new Date().toISOString(),
    });

    await this.logEmergencyActivity('MANUAL_STEP_INITIATED', {
      action: step.action,
      incidentId,
      assignedTo: step.responsible,
    });

    return {
      success: true,
      status: 'PENDING_HUMAN_ACTION',
      message: `Manual action '${step.action}' assigned to ${step.responsible}`,
      assignedTo: step.responsible,
      incidentId,
      trackedAt: new Date().toISOString(),
    };
  }

  async sendNotification(channel, incident, severityConfig) {
    const payload = {
      incidentId: incident.id,
      title: incident.title,
      description: incident.description,
      severity: incident.severity,
      type: incident.type,
      declaredAt: incident.declaredAt,
      channel: channel.name,
      channelType: channel.type,
      notificationLevel: severityConfig?.notificationLevel || 'unknown',
      timestamp: new Date().toISOString(),
    };

    const dispatcher = this.notificationDispatchers.get(channel.type)
      || this.notificationDispatchers.get('console');

    try {
      const result = await dispatcher(channel, payload);
      if (result.delivered) {
        appLogger.info('Emergency notification delivered', {
          channel: channel.name,
          channelType: channel.type,
          incidentId: incident.id,
          detail: result.message,
        });
        await this.logEmergencyActivity('NOTIFICATION_DELIVERED', {
          channel: channel.name,
          incidentId: incident.id,
          severity: incident.severity,
        });
      } else {
        appLogger.warn('Emergency notification channel not configured', {
          channel: channel.name,
          channelType: channel.type,
          incidentId: incident.id,
          detail: result.message,
        });
        await this.logEmergencyActivity('NOTIFICATION_CHANNEL_UNCONFIGURED', {
          channel: channel.name,
          incidentId: incident.id,
          detail: result.message,
        });
      }
    } catch (err) {
      appLogger.error('Emergency notification delivery failed', {
        channel: channel.name,
        channelType: channel.type,
        incidentId: incident.id,
        error: err.message,
      });
      await this.logEmergencyActivity('NOTIFICATION_DELIVERY_FAILED', {
        channel: channel.name,
        incidentId: incident.id,
        error: err.message,
      });
    }
  }

  async executeAutomatedActions(system, incident) {
    appLogger.info('Automated actions evaluated for alert system', {
      systemName: system.name,
      incidentId: incident.id,
      actions: system.actions,
    });

    for (const action of system.actions || []) {
      await this.logEmergencyActivity('AUTOMATED_ACTION_PENDING', {
        systemName: system.name,
        action,
        incidentId: incident.id,
        status: 'requires_manual_intervention',
      });
    }
  }

  async notifyTeamMember(member, incidentId) {
    appLogger.info('Emergency team member notification dispatched', {
      memberName: member.name,
      role: member.role,
      incidentId,
    });

    await this.logEmergencyActivity('TEAM_NOTIFICATION_DISPATCHED', {
      memberName: member.name,
      role: member.role,
      incidentId,
    });

    // If a webhook dispatcher is configured, also POST team notifications
    const webhookDispatcher = this.notificationDispatchers.get('webhook');
    if (webhookDispatcher) {
      try {
        await webhookDispatcher({ endpoint: process.env.EMERGENCY_WEBHOOK_URL }, {
          type: 'team_member_notification',
          memberName: member.name,
          role: member.role,
          incidentId,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Webhook delivery is best-effort for team notifications
      }
    }
  }

  async sendEscalationNotifications(incident) {
    await this.triggerEmergencyNotifications(incident);
  }

  async activateAdditionalTeams(incident) {
    for (const [teamId, team] of this.responseTeams) {
      if (
        team.activationCriteria.includes(incident.severity) &&
        !incident.activeTeams.includes(teamId)
      ) {
        incident.activeTeams.push(teamId);
        await this.activateResponseTeam(teamId, incident.id);
      }
    }
  }

  async triggerManagementAlert(incidentId) {
    const incident = this.activeIncidents.get(incidentId);
    if (!incident) return;

    appLogger.warn('Management alert triggered — incident exceeds response time', {
      incidentId,
      severity: incident.severity,
      declaredAt: incident.declaredAt,
    });

    await this.logEmergencyActivity('MANAGEMENT_ALERT_TRIGGERED', {
      incidentId,
      severity: incident.severity,
      reason: 'Response time threshold exceeded by 2x',
    });
  }

  calculateOverallEmergencyStatus(activeIncidents) {
    if (activeIncidents.length === 0) return 'NORMAL';

    const severities = activeIncidents.map(i => i.severity);
    if (severities.includes('CATASTROPHIC')) return 'CATASTROPHIC';
    if (severities.includes('CRITICAL')) return 'CRITICAL';
    if (severities.includes('HIGH')) return 'HIGH';
    if (severities.includes('MEDIUM')) return 'MEDIUM';
    return 'LOW';
  }

  groupIncidentsBySeverity(incidents) {
    const groups = {};
    for (const incident of incidents) {
      groups[incident.severity] = (groups[incident.severity] || 0) + 1;
    }
    return groups;
  }

  groupIncidentsByType(incidents) {
    const groups = {};
    for (const incident of incidents) {
      groups[incident.type] = (groups[incident.type] || 0) + 1;
    }
    return groups;
  }

  findOldestIncident(incidents) {
    if (incidents.length === 0) return null;
    return incidents.reduce((oldest, current) =>
      new Date(current.declaredAt) < new Date(oldest.declaredAt)
        ? current
        : oldest
    );
  }

  getActiveTeamCount() {
    return Array.from(this.activeIncidents.values()).reduce(
      (teams, incident) => {
        incident.activeTeams.forEach(team => teams.add(team));
        return teams;
      },
      new Set()
    ).size;
  }

  calculateTeamUtilization() {
    const totalTeams = this.responseTeams.size;
    const activeTeams = this.getActiveTeamCount();
    return totalTeams > 0 ? (activeTeams / totalTeams) * 100 : 0;
  }

  async assessSystemHealth() {
    const healthUrl = process.env.HEALTH_CHECK_URL || 'http://localhost:4001/health';
    let backendHealth = 'unknown';
    let backendDetail = null;

    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        backendDetail = await resp.json();
        backendHealth = backendDetail.status || 'healthy';
      } else {
        backendHealth = 'unhealthy';
        backendDetail = { httpStatus: resp.status };
      }
    } catch (err) {
      backendHealth = 'unreachable';
      backendDetail = { error: err.message };
      appLogger.warn('Health probe failed for backend API', { error: err.message });
    }

    return {
      overall: backendHealth,
      message: backendHealth === 'healthy'
        ? 'Backend API is healthy'
        : `Backend API status: ${backendHealth}`,
      services: {
        backendApi: backendHealth,
      },
      infrastructure: {
        servers: backendHealth === 'healthy' ? 'operational' : 'unknown',
        network: backendHealth !== 'unreachable' ? 'operational' : 'degraded',
        storage: 'unknown',
      },
      details: backendDetail,
      assessedAt: new Date().toISOString(),
    };
  }

  getRecentEmergencyActivity(hours) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.auditLog
      .filter(log => new Date(log.timestamp) > cutoff)
      .slice(-50); // Last 50 activities
  }

  async generateEmergencyRecommendations(activeIncidents) {
    const recommendations = [];

    if (activeIncidents.length > 5) {
      recommendations.push(
        'High incident volume detected - consider activating emergency operations center'
      );
    }

    const criticalIncidents = activeIncidents.filter(
      i => i.severity === 'CRITICAL' || i.severity === 'CATASTROPHIC'
    );
    if (criticalIncidents.length > 0) {
      recommendations.push(
        'Critical incidents active - ensure executive team is notified'
      );
    }

    const oldIncidents = activeIncidents.filter(
      i => new Date() - new Date(i.declaredAt) > 4 * 60 * 60 * 1000 // 4 hours
    );
    if (oldIncidents.length > 0) {
      recommendations.push(
        'Long-running incidents detected - review response effectiveness'
      );
    }

    return recommendations;
  }

  sanitizeIncidentForResponse(incident) {
    const sanitized = { ...incident };
    // Remove sensitive internal data
    delete sanitized.internal;
    return sanitized;
  }

  async logEmergencyActivity(activity, data) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      activity,
      data,
      id: crypto.randomUUID(),
    };

    this.auditLog.push(logEntry);
    appLogger.info(`Emergency Response: ${activity}`, { data });
  }

  // Public API methods
  getActiveIncidents() {
    return Array.from(this.activeIncidents.values())
      .filter(incident => incident.status !== 'RESOLVED')
      .map(incident => this.sanitizeIncidentForResponse(incident));
  }

  getIncidentById(incidentId) {
    const incident = this.activeIncidents.get(incidentId);
    return incident ? this.sanitizeIncidentForResponse(incident) : null;
  }

  getResponsePlans() {
    return Array.from(this.emergencyPlans.values());
  }

  getResponseTeams() {
    return Array.from(this.responseTeams.values());
  }
}

// Express middleware
const emergencyResponse = new EmergencyResponseSystem();

function authGuard(req, res, next) {
  if (!authenticateToken) {
    return res.status(503).json({ error: 'Auth middleware not initialized' });
  }
  authenticateToken(req, res, next);
}

function adminGuard(req, res, next) {
  if (!requireRole) {
    return res.status(503).json({ error: 'Auth middleware not initialized' });
  }
  requireRole('admin')(req, res, next);
}

const emergencyResponseMiddleware = {
  declareEmergency: [authGuard, adminGuard, async (req, res, next) => {
    try {
      const incidentData = req.body;
      const result = await emergencyResponse.declareEmergency(incidentData);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }],

  getActiveIncidents: [authGuard, async (req, res, next) => {
    try {
      const incidents = emergencyResponse.getActiveIncidents();
      res.json({ incidents });
    } catch (error) {
      next(error);
    }
  }],

  getIncident: [authGuard, async (req, res, next) => {
    try {
      const { incidentId } = req.params;
      const incident = emergencyResponse.getIncidentById(incidentId);

      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      res.json(incident);
    } catch (error) {
      next(error);
    }
  }],

  getStatusReport: [authGuard, async (req, res, next) => {
    try {
      const report = await emergencyResponse.generateEmergencyStatusReport();
      res.json(report);
    } catch (error) {
      next(error);
    }
  }],

  getResponsePlans: [authGuard, async (req, res, next) => {
    try {
      const plans = emergencyResponse.getResponsePlans();
      res.json({ plans });
    } catch (error) {
      next(error);
    }
  }],
};

module.exports = {
  EmergencyResponseSystem,
  emergencyResponseMiddleware,
  emergencyResponse,
};
