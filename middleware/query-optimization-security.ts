/**
 * Query Optimization Security Middleware
 * Task 104.8: Query Optimization Security
 *
 * Prevents unauthorized access to query optimization and database
 * analysis features that could be exploited to:
 * - Enumerate database structure
 * - Fingerprint the database engine
 * - Identify performance bottlenecks for exploitation
 * - Access sensitive system statistics
 */

import { Request, Response, NextFunction } from 'express';

// ============================================================================
// Security Patterns and Blocklists
// ============================================================================

/**
 * Patterns that should NEVER appear in user-controlled queries
 * These are used for query analysis and could leak database internals
 */
const BLOCKED_QUERY_PATTERNS = [
  // EXPLAIN/ANALYZE commands
  /\bEXPLAIN\b/i,
  /\bANALYZE\b/i,
  /\bEXPLAIN\s+ANALYZE\b/i,
  /\bEXPLAIN\s+\(/i,
  /\bEXPLAIN\s+VERBOSE\b/i,
  /\bEXPLAIN\s+BUFFERS\b/i,
  /\bEXPLAIN\s+COSTS\b/i,
  /\bEXPLAIN\s+FORMAT\b/i,

  // PostgreSQL system catalogs
  /\bpg_stat_/i,
  /\bpg_statio_/i,
  /\bpg_catalog\b/i,
  /\bpg_class\b/i,
  /\bpg_tables\b/i,
  /\bpg_views\b/i,
  /\bpg_indexes\b/i,
  /\bpg_constraint\b/i,
  /\bpg_trigger\b/i,
  /\bpg_proc\b/i,
  /\bpg_namespace\b/i,
  /\bpg_database\b/i,
  /\bpg_tablespace\b/i,
  /\bpg_extension\b/i,
  /\bpg_settings\b/i,
  /\bpg_user\b/i,
  /\bpg_roles\b/i,
  /\bpg_authid\b/i,
  /\bpg_auth_members\b/i,
  /\bpg_shadow\b/i,
  /\bpg_group\b/i,
  /\bpg_locks\b/i,
  /\bpg_prepared_xacts\b/i,
  /\bpg_stat_activity\b/i,
  /\bpg_stat_replication\b/i,
  /\bpg_stat_ssl\b/i,
  /\bpg_stat_progress_/i,
  /\bpg_stat_statements\b/i,
  /\bpg_stat_user_tables\b/i,
  /\bpg_stat_user_indexes\b/i,
  /\bpg_stat_all_tables\b/i,
  /\bpg_stat_all_indexes\b/i,
  /\bpg_stat_xact_/i,
  /\bpg_stat_bgwriter\b/i,
  /\bpg_stat_database\b/i,
  /\bpg_stat_wal\b/i,
  /\bpg_stat_archiver\b/i,

  // Information schema access (should be restricted)
  /\binformation_schema\b/i,

  // Debug and profiling functions
  /\bpg_sleep\b/i,
  /\bcurrent_setting\b/i,
  /\bset_config\b/i,
  /\bpg_terminate_backend\b/i,
  /\bpg_cancel_backend\b/i,
  /\bpg_reload_conf\b/i,
  /\bpg_rotate_logfile\b/i,

  // Large object functions
  /\blo_import\b/i,
  /\blo_export\b/i,
  /\blo_create\b/i,

  // File system access
  /\bpg_read_file\b/i,
  /\bpg_read_binary_file\b/i,
  /\bpg_ls_dir\b/i,
  /\bpg_stat_file\b/i,

  // Copy command (file access)
  /\bCOPY\s+.*\s+TO\b/i,
  /\bCOPY\s+.*\s+FROM\b/i,
];

/**
 * Allowed roles for query optimization access
 */
const QUERY_OPTIMIZATION_ALLOWED_ROLES = new Set([
  'admin',
  'dba',
  'database_admin',
  'security_admin',
  'super_admin',
]);

/**
 * Allowed roles for read-only statistics access
 */
const STATS_READONLY_ROLES = new Set([
  'admin',
  'dba',
  'developer',
  'analyst',
  'security_admin',
]);

// ============================================================================
// Security Event Logging
// ============================================================================

interface QuerySecurityEvent {
  type:
    | 'BLOCKED_QUERY_PATTERN'
    | 'UNAUTHORIZED_OPTIMIZATION_ACCESS'
    | 'SUSPICIOUS_QUERY_ACTIVITY'
    | 'RATE_LIMIT_EXCEEDED';
  severity: 'low' | 'medium' | 'high' | 'critical';
  query?: string;
  pattern?: string;
  userId?: string;
  userRole?: string;
  ip?: string;
  timestamp: Date;
  blocked: boolean;
}

const securityEvents: QuerySecurityEvent[] = [];

function logQuerySecurityEvent(event: QuerySecurityEvent): void {
  // Add to in-memory buffer (would integrate with security audit trail in production)
  securityEvents.push(event);

  // Limit buffer size
  if (securityEvents.length > 10000) {
    securityEvents.shift();
  }

  // Log to console for monitoring
  const logLevel =
    event.severity === 'critical' || event.severity === 'high'
      ? 'error'
      : 'warn';
  console[logLevel](
    `[QUERY_SECURITY] ${event.type}: ${JSON.stringify({
      pattern: event.pattern,
      userId: event.userId,
      ip: event.ip,
      blocked: event.blocked,
    })}`
  );
}

// ============================================================================
// Rate Limiting for Query Analysis
// ============================================================================

interface RateLimitEntry {
  count: number;
  firstRequest: number;
  blocked: boolean;
}

const queryAnalysisRateLimits = new Map<string, RateLimitEntry>();

const RATE_LIMIT_CONFIG = {
  maxRequests: 10, // Max analysis requests per window
  windowMs: 60000, // 1 minute window
  blockDurationMs: 300000, // 5 minute block after exceeding
};

function checkRateLimit(identifier: string): boolean {
  const now = Date.now();
  const entry = queryAnalysisRateLimits.get(identifier);

  if (!entry) {
    queryAnalysisRateLimits.set(identifier, {
      count: 1,
      firstRequest: now,
      blocked: false,
    });
    return true;
  }

  // Check if still blocked
  if (
    entry.blocked &&
    now - entry.firstRequest < RATE_LIMIT_CONFIG.blockDurationMs
  ) {
    return false;
  }

  // Check if window expired
  if (now - entry.firstRequest > RATE_LIMIT_CONFIG.windowMs) {
    queryAnalysisRateLimits.set(identifier, {
      count: 1,
      firstRequest: now,
      blocked: false,
    });
    return true;
  }

  // Within window, check count
  entry.count++;
  if (entry.count > RATE_LIMIT_CONFIG.maxRequests) {
    entry.blocked = true;
    entry.firstRequest = now; // Reset for block duration
    return false;
  }

  return true;
}

// ============================================================================
// Query Pattern Detection
// ============================================================================

interface PatternDetectionResult {
  isBlocked: boolean;
  matchedPatterns: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
}

function detectBlockedPatterns(query: string): PatternDetectionResult {
  const matchedPatterns: string[] = [];

  for (const pattern of BLOCKED_QUERY_PATTERNS) {
    if (pattern.test(query)) {
      matchedPatterns.push(pattern.source);
    }
  }

  // Determine severity based on what was detected
  let severity: PatternDetectionResult['severity'] = 'low';

  if (matchedPatterns.some((p) => p.includes('pg_stat_activity'))) {
    severity = 'critical'; // Could expose connection info
  } else if (matchedPatterns.some((p) => p.includes('pg_shadow'))) {
    severity = 'critical'; // Password hash exposure
  } else if (matchedPatterns.some((p) => p.includes('pg_authid'))) {
    severity = 'critical'; // Auth info exposure
  } else if (matchedPatterns.some((p) => p.includes('EXPLAIN'))) {
    severity = 'high'; // Query plan disclosure
  } else if (matchedPatterns.some((p) => p.includes('information_schema'))) {
    severity = 'medium'; // Schema enumeration
  } else if (matchedPatterns.length > 0) {
    severity = 'medium';
  }

  return {
    isBlocked: matchedPatterns.length > 0,
    matchedPatterns,
    severity,
  };
}

// ============================================================================
// Middleware Functions
// ============================================================================

/**
 * Request with user context
 */
interface SecureRequest extends Request {
  user?: {
    id: string;
    role?: string;
    permissions?: string[];
  };
  query: {
    [key: string]: string | undefined;
    sql?: string;
    query?: string;
  };
  body: {
    sql?: string;
    query?: string;
    [key: string]: unknown;
  };
}

/**
 * Main query security middleware
 * Blocks dangerous query patterns from user input
 */
export function querySecurityMiddleware(
  req: SecureRequest,
  res: Response,
  next: NextFunction
): void {
  // Extract potential query strings from various sources
  const potentialQueries: string[] = [];

  // Check query parameters
  if (req.query.sql) potentialQueries.push(req.query.sql);
  if (req.query.query) potentialQueries.push(req.query.query);

  // Check body parameters
  if (req.body?.sql) potentialQueries.push(req.body.sql as string);
  if (req.body?.query) potentialQueries.push(req.body.query as string);

  // Check all body fields for embedded SQL
  if (req.body && typeof req.body === 'object') {
    for (const [key, value] of Object.entries(req.body)) {
      if (typeof value === 'string' && value.length > 50) {
        potentialQueries.push(value);
      }
    }
  }

  // Analyze each potential query
  for (const query of potentialQueries) {
    const detection = detectBlockedPatterns(query);

    if (detection.isBlocked) {
      logQuerySecurityEvent({
        type: 'BLOCKED_QUERY_PATTERN',
        severity: detection.severity,
        query: query.substring(0, 200), // Truncate for logging
        pattern: detection.matchedPatterns.join(', '),
        userId: req.user?.id,
        userRole: req.user?.role,
        ip: req.ip,
        timestamp: new Date(),
        blocked: true,
      });

      res.status(403).json({
        success: false,
        error: 'Query contains blocked patterns',
        code: 'QUERY_SECURITY_VIOLATION',
      });
      return;
    }
  }

  next();
}

/**
 * Middleware for query optimization endpoints
 * Requires elevated privileges and rate limiting
 */
export function queryOptimizationAccessMiddleware(
  req: SecureRequest,
  res: Response,
  next: NextFunction
): void {
  const userRole = req.user?.role;
  const userId = req.user?.id;
  const identifier = userId || req.ip || 'anonymous';

  // Check role authorization
  if (!userRole || !QUERY_OPTIMIZATION_ALLOWED_ROLES.has(userRole)) {
    logQuerySecurityEvent({
      type: 'UNAUTHORIZED_OPTIMIZATION_ACCESS',
      severity: 'high',
      userId,
      userRole,
      ip: req.ip,
      timestamp: new Date(),
      blocked: true,
    });

    res.status(403).json({
      success: false,
      error: 'Query optimization access requires elevated privileges',
      code: 'INSUFFICIENT_PRIVILEGES',
    });
    return;
  }

  // Check rate limiting
  if (!checkRateLimit(identifier)) {
    logQuerySecurityEvent({
      type: 'RATE_LIMIT_EXCEEDED',
      severity: 'medium',
      userId,
      userRole,
      ip: req.ip,
      timestamp: new Date(),
      blocked: true,
    });

    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded for query analysis operations',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: Math.ceil(RATE_LIMIT_CONFIG.blockDurationMs / 1000),
    });
    return;
  }

  next();
}

/**
 * Middleware for read-only statistics access
 * Less restrictive than full optimization access
 */
export function statsReadonlyMiddleware(
  req: SecureRequest,
  res: Response,
  next: NextFunction
): void {
  const userRole = req.user?.role;
  const userId = req.user?.id;

  if (!userRole || !STATS_READONLY_ROLES.has(userRole)) {
    logQuerySecurityEvent({
      type: 'UNAUTHORIZED_OPTIMIZATION_ACCESS',
      severity: 'medium',
      userId,
      userRole,
      ip: req.ip,
      timestamp: new Date(),
      blocked: true,
    });

    res.status(403).json({
      success: false,
      error: 'Statistics access requires authorized role',
      code: 'INSUFFICIENT_PRIVILEGES',
    });
    return;
  }

  next();
}

// ============================================================================
// Query Sanitization Functions
// ============================================================================

/**
 * Sanitize a query string by removing dangerous patterns
 * Use this when you need to pass user input to query analysis tools
 */
export function sanitizeQueryForAnalysis(query: string): {
  sanitized: string;
  modified: boolean;
  removedPatterns: string[];
} {
  let sanitized = query;
  const removedPatterns: string[] = [];

  for (const pattern of BLOCKED_QUERY_PATTERNS) {
    if (pattern.test(sanitized)) {
      removedPatterns.push(pattern.source);
      sanitized = sanitized.replace(pattern, '[REMOVED]');
    }
  }

  return {
    sanitized,
    modified: removedPatterns.length > 0,
    removedPatterns,
  };
}

/**
 * Validate that a query is safe for execution
 * Returns detailed validation result
 */
export function validateQuerySafety(query: string): {
  isSafe: boolean;
  issues: string[];
  severity: 'safe' | 'warning' | 'danger' | 'critical';
} {
  const detection = detectBlockedPatterns(query);
  const issues: string[] = [];

  if (detection.isBlocked) {
    issues.push(
      `Blocked patterns detected: ${detection.matchedPatterns.join(', ')}`
    );
  }

  // Check for potential injection patterns
  if (/;\s*--/.test(query)) {
    issues.push('Comment-based SQL injection pattern detected');
  }

  if (/UNION\s+(ALL\s+)?SELECT/i.test(query)) {
    issues.push('UNION SELECT pattern detected');
  }

  if (/;\s*(DROP|DELETE|TRUNCATE|ALTER)/i.test(query)) {
    issues.push('Destructive command pattern detected');
  }

  // Determine overall severity
  let severity: 'safe' | 'warning' | 'danger' | 'critical' = 'safe';
  if (issues.length > 0) {
    if (detection.severity === 'critical') {
      severity = 'critical';
    } else if (detection.severity === 'high') {
      severity = 'danger';
    } else {
      severity = 'warning';
    }
  }

  return {
    isSafe: issues.length === 0,
    issues,
    severity,
  };
}

// ============================================================================
// Security Event Retrieval (for monitoring)
// ============================================================================

/**
 * Get recent security events (for admin monitoring)
 */
export function getRecentSecurityEvents(
  limit: number = 100
): QuerySecurityEvent[] {
  return securityEvents.slice(-limit);
}

/**
 * Get security event statistics
 */
export function getSecurityEventStats(): {
  total: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  last24Hours: number;
} {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let last24Hours = 0;

  for (const event of securityEvents) {
    byType[event.type] = (byType[event.type] || 0) + 1;
    bySeverity[event.severity] = (bySeverity[event.severity] || 0) + 1;

    if (event.timestamp.getTime() > oneDayAgo) {
      last24Hours++;
    }
  }

  return {
    total: securityEvents.length,
    byType,
    bySeverity,
    last24Hours,
  };
}

// ============================================================================
// Export
// ============================================================================

export default {
  querySecurityMiddleware,
  queryOptimizationAccessMiddleware,
  statsReadonlyMiddleware,
  sanitizeQueryForAnalysis,
  validateQuerySafety,
  getRecentSecurityEvents,
  getSecurityEventStats,
  BLOCKED_QUERY_PATTERNS,
  QUERY_OPTIMIZATION_ALLOWED_ROLES,
  STATS_READONLY_ROLES,
};
