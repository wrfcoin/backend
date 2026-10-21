/**
 * Security Controller - TypeScript Implementation
 * Handles security operations, threat detection, and audit logging with comprehensive validation
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  SecurityAlert,
  ThreatLevel,
  AuditLog,
  SecurityMetrics,
  EthereumAddress,
} from '../../shared/types/security-types.js';
import { securityLogger } from '../utils/logger.js';

// Enhanced request interface with security context
interface SecurityRequest extends Request {
  security?: {
    userId?: string;
    sessionId?: string;
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
  };
  storage?: {
    createSecurityAlert: (
      alert: Partial<SecurityAlert>
    ) => Promise<SecurityAlert>;
    getSecurityAlerts: (
      limit?: number,
      offset?: number
    ) => Promise<SecurityAlert[]>;
    createAuditLog: (log: Partial<AuditLog>) => Promise<AuditLog>;
    getAuditLogs: (
      userId?: string,
      limit?: number,
      offset?: number
    ) => Promise<AuditLog[]>;
    getSecurityMetrics: () => Promise<SecurityMetrics>;
    updateThreatLevel: (level: ThreatLevel) => Promise<void>;
  };
}

// Security alert creation interface
interface CreateAlertRequest {
  type:
    | 'authentication'
    | 'authorization'
    | 'data_breach'
    | 'suspicious_activity'
    | 'system_intrusion'
    | 'rate_limit_violation'
    | 'brute_force_attack'
    | 'suspicious_request'
    | 'unauthorized_access';
  severity: ThreatLevel;
  description: string;
  sourceIp?: string;
  userId?: string;
  additionalData?: Record<string, any>;
}

// Audit log creation interface
interface CreateAuditLogRequest {
  action: string;
  resource: string;
  userId?: string;
  details?: Record<string, any>;
}

/**
 * Create security alert
 */
export const createSecurityAlert = async (
  req: SecurityRequest,
  res: Response
): Promise<ControllerResponse<SecurityAlert>> => {
  const requestId = uuidv4();

  try {
    const { type, severity, description, sourceIp, userId, additionalData } =
      req.body as CreateAlertRequest;

    // Validate required fields
    if (!type || !severity || !description) {
      const errorResponse: ControllerResponse<SecurityAlert> = {
        success: false,
        error: 'Missing required alert fields',
        message: 'Alert must include type, severity, and description',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate threat level
    const validThreatLevels: ThreatLevel[] = [
      'low',
      'medium',
      'high',
      'critical',
    ];
    if (!validThreatLevels.includes(severity)) {
      const errorResponse: ControllerResponse<SecurityAlert> = {
        success: false,
        error: 'Invalid threat level',
        message: `Severity must be one of: ${validThreatLevels.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate user ID if provided
    if (userId && !userId.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<SecurityAlert> = {
        success: false,
        error: 'Invalid user ID format',
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create alert data
    const alertData: Partial<SecurityAlert> = {
      id: `alert_${uuidv4()}`,
      type,
      severity,
      description,
      sourceIp: sourceIp || req.security?.ipAddress || req.ip,
      userId: userId as EthereumAddress,
      timestamp: new Date(),
      resolved: false,
      additionalData: additionalData || {},
    };

    let alert: SecurityAlert;
    if (req.storage) {
      alert = await req.storage.createSecurityAlert(alertData);
    } else {
      alert = alertData as SecurityAlert;
    }

    // Log security alert creation
    securityLogger.warn('Security Alert Created', { type, severity, description, requestId });

    const response: ControllerResponse<SecurityAlert> = {
      success: true,
      data: alert,
      message: 'Security alert created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    securityLogger.error('Error in createSecurityAlert', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<SecurityAlert> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create security alert',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get security alerts with pagination
 */
export const getSecurityAlerts = async (
  req: SecurityRequest,
  res: Response
): Promise<PaginatedResponse<SecurityAlert>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const severity = req.query.severity as ThreatLevel;
    const offset = (page - 1) * limit;

    let alerts: SecurityAlert[] = [];
    if (req.storage) {
      alerts = await req.storage.getSecurityAlerts(limit, offset);
    } else {
      // Mock alerts for development
      alerts = [
        {
          id: 'alert_1',
          type: 'authentication',
          severity: 'medium' as ThreatLevel,
          description: 'Multiple failed login attempts detected',
          sourceIp: '192.168.1.100',
          timestamp: new Date(),
          resolved: false,
          additionalData: { attempts: 5 },
        },
        {
          id: 'alert_2',
          type: 'suspicious_activity',
          severity: 'high' as ThreatLevel,
          description: 'Unusual transaction pattern detected',
          sourceIp: '10.0.0.50',
          timestamp: new Date(),
          resolved: true,
          additionalData: { pattern: 'high_frequency_transfers' },
        },
      ];
    }

    // Filter by severity if provided
    if (severity) {
      alerts = alerts.filter(alert => alert.severity === severity);
    }

    const totalPages = Math.ceil(alerts.length / limit);

    const response: PaginatedResponse<SecurityAlert> = {
      success: true,
      data: alerts,
      message: `Retrieved ${alerts.length} security alerts`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: alerts.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    securityLogger.error('Error in getSecurityAlerts', { error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<SecurityAlert> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve security alerts',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Create audit log entry
 */
export const createAuditLog = async (
  req: SecurityRequest,
  res: Response
): Promise<ControllerResponse<AuditLog>> => {
  const requestId = uuidv4();

  try {
    const { action, resource, userId, details } =
      req.body as CreateAuditLogRequest;

    // Validate required fields
    if (!action || !resource) {
      const errorResponse: ControllerResponse<AuditLog> = {
        success: false,
        error: 'Missing required audit log fields',
        message: 'Audit log must include action and resource',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate user ID if provided
    if (userId && !userId.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<AuditLog> = {
        success: false,
        error: 'Invalid user ID format',
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create audit log data
    const logData: Partial<AuditLog> = {
      id: `audit_${uuidv4()}`,
      action,
      resource,
      userId: userId as EthereumAddress,
      timestamp: new Date(),
      ipAddress: req.security?.ipAddress || req.ip,
      userAgent: req.security?.userAgent || req.get('User-Agent'),
      sessionId: req.security?.sessionId,
      details: details || {},
    };

    let auditLog: AuditLog;
    if (req.storage) {
      auditLog = await req.storage.createAuditLog(logData);
    } else {
      auditLog = logData as AuditLog;
    }

    const response: ControllerResponse<AuditLog> = {
      success: true,
      data: auditLog,
      message: 'Audit log created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    securityLogger.error('Error in createAuditLog', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<AuditLog> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create audit log',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get audit logs with pagination
 */
export const getAuditLogs = async (
  req: SecurityRequest,
  res: Response
): Promise<PaginatedResponse<AuditLog>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const userId = req.query.userId as string;
    const offset = (page - 1) * limit;

    // Validate user ID if provided
    if (userId && !userId.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: PaginatedResponse<AuditLog> = {
        success: false,
        error: 'Invalid user ID format',
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let logs: AuditLog[] = [];
    if (req.storage) {
      logs = await req.storage.getAuditLogs(userId, limit, offset);
    } else {
      // Mock audit logs for development
      logs = [
        {
          id: 'audit_1',
          action: 'user_login',
          resource: 'authentication',
          userId:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          timestamp: new Date(),
          ipAddress: '192.168.1.100',
          userAgent: 'Mozilla/5.0',
          details: { method: 'wallet_connect' },
        },
        {
          id: 'audit_2',
          action: 'transaction_created',
          resource: 'blockchain',
          userId:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          timestamp: new Date(),
          ipAddress: '192.168.1.100',
          userAgent: 'Mozilla/5.0',
          details: { amount: 1.5, token: 'WRF' },
        },
      ];
    }

    const totalPages = Math.ceil(logs.length / limit);

    const response: PaginatedResponse<AuditLog> = {
      success: true,
      data: logs,
      message: `Retrieved ${logs.length} audit logs`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: logs.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    securityLogger.error('Error in getAuditLogs', { error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<AuditLog> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve audit logs',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get security metrics and system status
 */
export const getSecurityMetrics = async (
  req: SecurityRequest,
  res: Response
): Promise<ControllerResponse<SecurityMetrics>> => {
  const requestId = uuidv4();

  try {
    let metrics: SecurityMetrics;

    if (req.storage) {
      metrics = await req.storage.getSecurityMetrics();
    } else {
      // Mock metrics for development
      metrics = {
        totalAlerts: 25,
        resolvedAlerts: 18,
        criticalAlerts: 2,
        highAlerts: 5,
        mediumAlerts: 12,
        lowAlerts: 6,
        threatLevel: 'medium' as ThreatLevel,
        lastThreatDetection: new Date(Date.now() - 3600000), // 1 hour ago
        systemStatus: 'secure',
        activeThreats: 3,
        blockedIPs: 15,
        suspiciousActivities: 8,
        lastUpdate: new Date(),
      };
    }

    const response: ControllerResponse<SecurityMetrics> = {
      success: true,
      data: metrics,
      message: 'Security metrics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    securityLogger.error('Error in getSecurityMetrics', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<SecurityMetrics> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve security metrics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Update system threat level
 */
export const updateThreatLevel = async (
  req: SecurityRequest,
  res: Response
): Promise<ControllerResponse<{ threatLevel: ThreatLevel }>> => {
  const requestId = uuidv4();

  try {
    const { threatLevel } = req.body;

    // Validate threat level
    const validThreatLevels: ThreatLevel[] = [
      'low',
      'medium',
      'high',
      'critical',
    ];
    if (!validThreatLevels.includes(threatLevel)) {
      const errorResponse: ControllerResponse<{ threatLevel: ThreatLevel }> = {
        success: false,
        error: 'Invalid threat level',
        message: `Threat level must be one of: ${validThreatLevels.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    if (req.storage) {
      await req.storage.updateThreatLevel(threatLevel);
    }

    // Create audit log for threat level change
    if (req.storage) {
      await req.storage.createAuditLog({
        id: `audit_${uuidv4()}`,
        action: 'threat_level_updated',
        resource: 'security_system',
        userId: req.security?.userId as EthereumAddress,
        timestamp: new Date(),
        ipAddress: req.security?.ipAddress || req.ip,
        details: { newThreatLevel: threatLevel },
      });
    }

    securityLogger.warn('System Threat Level Updated', { threatLevel, requestId });

    const response: ControllerResponse<{ threatLevel: ThreatLevel }> = {
      success: true,
      data: { threatLevel },
      message: 'Threat level updated successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    securityLogger.error('Error in updateThreatLevel', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<{ threatLevel: ThreatLevel }> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to update threat level',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Resolve security alert
 */
export const resolveAlert = async (
  req: SecurityRequest,
  res: Response
): Promise<ControllerResponse<SecurityAlert>> => {
  const requestId = uuidv4();

  try {
    const alertId = req.params.alertId;
    const { resolution } = req.body;

    if (!alertId) {
      const errorResponse: ControllerResponse<SecurityAlert> = {
        success: false,
        error: 'Alert ID is required',
        message: 'Please provide a valid alert ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Mock resolution for development
    const resolvedAlert: SecurityAlert = {
      id: alertId,
      type: 'authentication',
      severity: 'medium' as ThreatLevel,
      description: 'Alert resolved',
      sourceIp: '192.168.1.100',
      timestamp: new Date(),
      resolved: true,
      resolution: resolution || 'Manually resolved by administrator',
      resolvedAt: new Date(),
      additionalData: {},
    };

    // Create audit log for alert resolution
    if (req.storage) {
      await req.storage.createAuditLog({
        id: `audit_${uuidv4()}`,
        action: 'alert_resolved',
        resource: 'security_alert',
        userId: req.security?.userId as EthereumAddress,
        timestamp: new Date(),
        ipAddress: req.security?.ipAddress || req.ip,
        details: { alertId, resolution },
      });
    }

    const response: ControllerResponse<SecurityAlert> = {
      success: true,
      data: resolvedAlert,
      message: 'Security alert resolved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    securityLogger.error('Error in resolveAlert', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<SecurityAlert> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to resolve security alert',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  createSecurityAlert,
  getSecurityAlerts,
  createAuditLog,
  getAuditLogs,
  getSecurityMetrics,
  updateThreatLevel,
  resolveAlert,
};
