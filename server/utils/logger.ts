/**
 * Comprehensive Logging Infrastructure - Task 67.4
 *
 * Enhanced Winston logger with structured logging, performance monitoring,
 * security event tracking, and service integration logging for WRFCoin platform.
 *
 * Integrations:
 * - OpenTelemetry: Automatic trace context (traceId, spanId) injection into logs
 * - Prometheus: Log message counting by level and logger for metrics/alerting
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { trace, SpanContext, context as otelContext } from '@opentelemetry/api';
import { recordLogMetric } from './metrics.js';

// Async context storage for request correlation
export const asyncLocalStorage = new AsyncLocalStorage<Map<string, any>>();

// Attempt to create logs directory — skip file transports on read-only FS (#443)
let logsDir: string | null = null;
try {
  const dir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  logsDir = dir;
} catch {
  // Read-only filesystem (e.g. Docker read_only:true) — console-only logging
  console.warn('WARNING: Cannot create logs directory — file log transports disabled');
}

// Define log level type
export type LogLevel = 'error' | 'warn' | 'info' | 'http' | 'debug';

// Enhanced metadata interface with comprehensive logging support
export interface LogMetadata {
  // Core metadata
  service?: string;
  operation?: string;
  userId?: string;
  requestId?: string;
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  duration?: number;
  statusCode?: number;
  ip?: string;
  userAgent?: string;
  method?: string;
  path?: string;

  // Business context
  blockchainNetwork?: string;
  walletAddress?: string;
  transactionHash?: string;
  contractAddress?: string;
  tokenId?: string;

  // OpenForis integration
  openforis?: {
    projectId?: string;
    plotId?: string;
    analysisId?: string;
    operation?: string;
    apiEndpoint?: string;
    responseTime?: number;
    dataSize?: number;
  };

  // Performance metrics
  performance?: {
    memoryUsage?: NodeJS.MemoryUsage;
    cpuUsage?: NodeJS.CpuUsage;
    responseTime?: number;
    queryTime?: number;
    cacheHitRatio?: number;
    databaseConnectionPool?: {
      active: number;
      idle: number;
      pending: number;
    };
    throughput?: {
      requestsPerSecond: number;
      operationsPerSecond: number;
    };
  };

  // Security context
  security?: {
    authMethod?: string;
    roleBasedAccess?: string[];
    apiKeyUsed?: boolean;
    riskScore?: number;
    geoLocation?: string;
    deviceFingerprint?: string;
    sessionId?: string;
  };

  // Error details
  error?: {
    name?: string;
    message?: string;
    stack?: string;
    code?: string;
    cause?: string;
    category?:
      | 'validation'
      | 'authentication'
      | 'authorization'
      | 'network'
      | 'database'
      | 'external'
      | 'business'
      | 'system';
    severity?: 'low' | 'medium' | 'high' | 'critical';
  };

  // Service integration
  serviceCall?: {
    targetService?: string;
    endpoint?: string;
    method?: string;
    requestPayload?: any;
    responsePayload?: any;
    duration?: number;
    success?: boolean;
    circuitBreakerState?: 'closed' | 'open' | 'half-open';
  };

  // GraphQL specific
  graphql?: {
    operationName?: string;
    operationType?: 'query' | 'mutation' | 'subscription';
    complexity?: number;
    depth?: number;
    variables?: Record<string, any>;
    resolverPath?: string[];
  };

  // Cross-chain operations
  crossChain?: {
    sourceChain?: string;
    targetChain?: string;
    bridgeType?: string;
    amount?: string;
    fee?: string;
    confirmations?: number;
  };

  // IoT sensor data
  iot?: {
    deviceId?: string;
    sensorType?: string;
    location?: {
      latitude: number;
      longitude: number;
    };
    dataPoints?: number;
    quality?: 'high' | 'medium' | 'low';
  };

  // Weather data
  weather?: {
    stationId?: string;
    dataType?: string;
    forecastModel?: string;
    accuracy?: number;
    timestamp?: string;
  };
}

// Utility functions for correlation tracking
export function generateCorrelationId(): string {
  return `wrfc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function getCorrelationId(): string {
  const store = asyncLocalStorage.getStore();
  return store?.get('correlationId') || generateCorrelationId();
}

export function setCorrelationId(correlationId: string): void {
  const store = asyncLocalStorage.getStore();
  if (store) {
    store.set('correlationId', correlationId);
  }
}

/**
 * OpenTelemetry Trace Context Extraction
 *
 * Extracts the current trace context (traceId, spanId) from OpenTelemetry's
 * active span to inject into log entries for distributed tracing correlation.
 */
export interface OTelTraceContext {
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
}

export function getOTelTraceContext(): OTelTraceContext {
  try {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      const spanContext: SpanContext = activeSpan.spanContext();
      // Validate trace context (skip invalid/no-op contexts)
      if (spanContext.traceId && spanContext.traceId !== '00000000000000000000000000000000') {
        return {
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          traceFlags: spanContext.traceFlags,
        };
      }
    }
  } catch {
    // OpenTelemetry not initialized or error extracting context - silently ignore
  }
  return {};
}

// Comprehensive sensitive field patterns for PII/credential masking
// This covers 23+ sensitive field categories as required by Task 113.10
const SENSITIVE_FIELD_PATTERNS = {
  // Exact match fields (case-insensitive)
  exactMatch: new Set([
    // Credentials
    'password',
    'secret',
    'apikey',
    'api_key',
    'token',
    'jwt',
    'bearer',
    'authorization',
    // Financial/Crypto
    'privatekey',
    'private_key',
    'mnemonic',
    'seed',
    'seedphrase',
    'seed_phrase',
    'walletkey',
    'wallet_key',
    // Personal Data
    'ssn',
    'socialsecuritynumber',
    'social_security_number',
    'creditcard',
    'credit_card',
    'cardnumber',
    'card_number',
    'cvv',
    'cvc',
    'pin',
    // Authentication
    'sessionid',
    'session_id',
    'sessiontoken',
    'session_token',
    'refreshtoken',
    'refresh_token',
    'accesstoken',
    'access_token',
    'bearertoken',
    'bearer_token',
    'jwttoken',
    'jwt_token',
    // Additional security-related fields
    'auth',
    'cookie',
    'signature',
    'credentials',
    'encryptionkey',
    'encryption_key',
    'key',
    'passphrase',
    'pass_phrase',
    'secretkey',
    'secret_key',
    'masterkey',
    'master_key',
    'recoverykey',
    'recovery_key',
    'backupcode',
    'backup_code',
    'otp',
    'totp',
    'otpsecret',
    'otp_secret',
  ]),
  // Partial match patterns (if key contains any of these substrings)
  partialMatch: [
    'password',
    'secret',
    'private',
    'mnemonic',
    'credential',
    'apikey',
    'api_key',
    'token',
    'bearer',
    'authorization',
    'auth_',
    '_auth',
    'seed',
    'wallet',
    'ssn',
    'creditcard',
    'cardnum',
    'cvv',
    'session',
    'refresh',
    'access_token',
    'jwt',
    'passphrase',
    'encryption',
    'masterkey',
    'recoverykey',
  ],
};

/**
 * Checks if a field name matches sensitive patterns
 * Exported for testing and potential reuse in other security-related utilities.
 * @param key - The field name to check
 * @returns true if the field should be masked
 */
export function isSensitiveField(key: string): boolean {
  const lowerKey = key.toLowerCase().replace(/[-\s]/g, '_');
  const normalizedKey = lowerKey.replace(/_/g, '');

  // Check exact match (with normalization for case and separators)
  if (SENSITIVE_FIELD_PATTERNS.exactMatch.has(lowerKey)) {
    return true;
  }
  if (SENSITIVE_FIELD_PATTERNS.exactMatch.has(normalizedKey)) {
    return true;
  }

  // Check partial match patterns
  for (const pattern of SENSITIVE_FIELD_PATTERNS.partialMatch) {
    if (lowerKey.includes(pattern) || normalizedKey.includes(pattern.replace(/_/g, ''))) {
      return true;
    }
  }

  return false;
}

// PII data masking utility
// Masks sensitive data in log output to prevent credential leaks
// Covers 23+ sensitive field patterns including:
// - Credentials: password, secret, apiKey, api_key, token, jwt, bearer, authorization
// - Financial: privateKey, private_key, mnemonic, seed, seedPhrase, walletKey
// - Personal: ssn, socialSecurityNumber, creditCard, cardNumber, cvv, pin
// - Authentication: sessionId, sessionToken, refreshToken, accessToken
export function maskSensitiveData(obj: any, maxDepth = 10, currentDepth = 0): any {
  // Handle null/undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle primitives
  if (typeof obj !== 'object') {
    return obj;
  }

  // Prevent infinite recursion with increased depth limit
  if (currentDepth >= maxDepth) {
    return '[MAX_DEPTH_REACHED]';
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => maskSensitiveData(item, maxDepth, currentDepth + 1));
  }

  // Handle Date objects
  if (obj instanceof Date) {
    return obj;
  }

  // Handle Error objects
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: maskSensitiveData(obj.message, maxDepth, currentDepth + 1),
      stack: obj.stack,
    };
  }

  // Handle regular objects
  const masked: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveField(key)) {
      masked[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      masked[key] = maskSensitiveData(value, maxDepth, currentDepth + 1);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

/**
 * Render the `error` log field. Callers pass an Error, an `{ name, message,
 * ... }` record, or — most often, `{ error: err.message }` — a plain string.
 * A string used to be read as an Error and printed "Unknown:No message",
 * dropping the one thing the log line existed to say (backend#1247).
 */
export function formatErrorDetails(error: unknown): string {
  if (error === undefined || error === null || error === '') {
    return '';
  }
  if (typeof error !== 'object') {
    return ` [Error: ${String(error)}]`;
  }
  const details = error as Record<string, unknown>;
  let out = ` [Error: ${details.name || 'Unknown'}:${details.message || 'No message'}`;
  if (details.code) {
    out += `:${details.code}`;
  }
  if (details.category) {
    out += `:${details.category}`;
  }
  if (details.severity) {
    out += `:${details.severity}`;
  }
  return `${out}]`;
}

// Enhanced log format with comprehensive context
const enhancedLogFormat = winston.format.printf(
  (info) => {
    const {
      level,
      message,
      timestamp,
      service,
      correlationId,
      requestId,
      traceId,
      openforis,
      performance,
      security,
      error,
      serviceCall,
      graphql,
      crossChain,
      iot,
      weather,
      ...meta
    } = info as any;
    const correlationTracker = correlationId || getCorrelationId();
    const baseLog = `${timestamp} [${level.toUpperCase()}] [${service || 'default'}] [${correlationTracker}] ${message}`;

    let extras = '';

    // Add request/trace IDs
    if (requestId || traceId) {
      extras += ` [Request: ${requestId || 'N/A'}] [Trace: ${traceId || 'N/A'}]`;
    }

    // Add OpenForis-specific context
    if (openforis) {
      const openforisContext = Object.entries(openforis)
        .filter(([_, value]) => value !== undefined)
        .map(([key, value]) => `${key}:${value}`)
        .join(' ');
      if (openforisContext) {
        extras += ` [OpenForis: ${openforisContext}]`;
      }
    }

    // Add performance metrics
    if (performance) {
      const perfContext = Object.entries(performance)
        .filter(([_, value]) => value !== undefined)
        .map(([key, value]) => {
          if (key === 'memoryUsage' && typeof value === 'object') {
            const mem = value as NodeJS.MemoryUsage;
            return `memory:${Math.round(mem.heapUsed / 1024 / 1024)}MB`;
          }
          if (key === 'responseTime' || key === 'queryTime') {
            return `${key}:${value}ms`;
          }
          if (key === 'databaseConnectionPool' && typeof value === 'object') {
            const pool = value as any;
            return `dbPool:${pool.active}/${pool.active + pool.idle}`;
          }
          if (key === 'throughput' && typeof value === 'object') {
            const throughput = value as any;
            return `throughput:${throughput.requestsPerSecond}rps`;
          }
          return `${key}:${value}`;
        })
        .join(' ');
      if (perfContext) {
        extras += ` [Performance: ${perfContext}]`;
      }
    }

    // Add security context
    if (security) {
      const securityContext = Object.entries(security)
        .filter(([_, value]) => value !== undefined)
        .map(([key, value]) => {
          if (key === 'roleBasedAccess' && Array.isArray(value)) {
            return `roles:${value.join(',')}`;
          }
          return `${key}:${value}`;
        })
        .join(' ');
      if (securityContext) {
        extras += ` [Security: ${securityContext}]`;
      }
    }

    // Add service call context
    if (serviceCall) {
      extras += ` [ServiceCall: ${serviceCall.targetService || 'unknown'}:${serviceCall.endpoint || 'unknown'}:${serviceCall.duration || 0}ms:${serviceCall.success ? 'OK' : 'FAIL'}]`;
    }

    // Add GraphQL context
    if (graphql) {
      extras += ` [GraphQL: ${graphql.operationType || 'unknown'}:${graphql.operationName || 'unknown'}:complexity:${graphql.complexity || 0}]`;
    }

    // Add cross-chain context
    if (crossChain) {
      extras += ` [CrossChain: ${crossChain.sourceChain || 'unknown'}->${crossChain.targetChain || 'unknown'}:${crossChain.amount || '0'}]`;
    }

    // Add IoT context
    if (iot) {
      extras += ` [IoT: ${iot.deviceId || 'unknown'}:${iot.sensorType || 'unknown'}:${iot.quality || 'unknown'}]`;
    }

    // Add weather context
    if (weather) {
      extras += ` [Weather: ${weather.stationId || 'unknown'}:${weather.dataType || 'unknown'}:${weather.accuracy || 0}%]`;
    }

    // Add error details
    extras += formatErrorDetails(error);

    // Add remaining metadata (masked for security)
    const remainingMeta =
      Object.keys(meta).length > 0
        ? ` ${JSON.stringify(maskSensitiveData(meta))}`
        : '';

    return baseLog + extras + remainingMeta;
  }
);

// Console format with colors and enhanced context
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  enhancedLogFormat
);

// File format with JSON structure and correlation tracking
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(info => {
    // Add correlation ID to JSON logs if not present
    if (!info.correlationId) {
      info.correlationId = getCorrelationId();
    }
    return JSON.stringify(maskSensitiveData(info));
  })
);

// Performance-optimized format for high-volume logs
const performanceFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json(),
  winston.format.printf(info => {
    // Minimal JSON structure for performance logs - still apply masking for security
    return JSON.stringify(maskSensitiveData({
      timestamp: info.timestamp,
      level: info.level,
      service: info.service,
      correlationId: info.correlationId || getCorrelationId(),
      performance: info.performance,
      operation: info.operation,
      duration: info.duration,
    }));
  })
);

// Security audit format with enhanced tracking
const securityFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json(),
  winston.format.printf(info => {
    // Security logs must also be masked to prevent credential leaks
    return JSON.stringify(maskSensitiveData({
      timestamp: info.timestamp,
      level: info.level,
      service: info.service,
      correlationId: info.correlationId || getCorrelationId(),
      security: info.security,
      userId: info.userId,
      ip: info.ip,
      userAgent: info.userAgent,
      operation: info.operation,
      success: info.success,
      riskScore: info.riskScore,
    }));
  })
);

// Environment-specific configuration
const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');
const disableFileLogTransports =
  process.env.DISABLE_FILE_LOG_TRANSPORTS === 'true' || logsDir === null;

// Log rotation configuration
const logRotationConfig = {
  maxsize: isProduction ? 50 * 1024 * 1024 : 10 * 1024 * 1024, // 50MB in prod, 10MB in dev
  maxFiles: isProduction ? 20 : 10,
  tailable: true,
  zippedArchive: isProduction,
};

// Winston installs process-level uncaughtException/unhandledRejection listeners
// for any transport with handleExceptions/handleRejections enabled. This module
// eagerly creates many service loggers, so only the first logger should claim
// those process-level hooks.
let processFatalHandlersRegistered = false;

// Create transport factory for specialized logging
function createTransports(service: string): winston.transport[] {
  const transports: winston.transport[] = [];

  // Console transport — always enabled (stdout is the primary transport in containers).
  // Set DISABLE_CONSOLE_LOGS=true to suppress if needed.
  if (process.env.DISABLE_CONSOLE_LOGS !== 'true') {
    transports.push(
      new winston.transports.Console({
        format: consoleFormat,
        level: isDevelopment ? 'debug' : 'info',
      })
    );
  }

  if (!disableFileLogTransports) {
    const shouldHandleProcessFatals = !processFatalHandlersRegistered;
    processFatalHandlersRegistered = true;
    if (shouldHandleProcessFatals) fatalClaimPending = true;

    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        format: fileFormat,
        ...logRotationConfig,
        handleExceptions: shouldHandleProcessFatals,
        handleRejections: shouldHandleProcessFatals,
      })
    );

    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'combined.log'),
        format: fileFormat,
        ...logRotationConfig,
      })
    );

    if (service !== 'wrfcoin-core') {
      transports.push(
        new winston.transports.File({
          filename: path.join(logsDir, `${service.toLowerCase()}.log`),
          format: fileFormat,
          ...logRotationConfig,
          level: 'info',
        })
      );
    }

    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'performance.log'),
        format: performanceFormat,
        ...logRotationConfig,
        level: 'info',
      })
    );

    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'security.log'),
        format: securityFormat,
        ...logRotationConfig,
        level: 'warn',
      })
    );

    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'graphql.log'),
        format: fileFormat,
        ...logRotationConfig,
        level: 'info',
      })
    );

    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'crosschain.log'),
        format: fileFormat,
        ...logRotationConfig,
        level: 'info',
      })
    );

    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'iot.log'),
        format: fileFormat,
        ...logRotationConfig,
        level: 'info',
      })
    );

    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'weather.log'),
        format: fileFormat,
        ...logRotationConfig,
        level: 'info',
      })
    );
  }

  return transports;
}

// backend#1243: ownership of a fatal event is decided PER EVENT, and BEFORE any listener runs.
// With file transports on, winston claims uncaughtException and unhandledRejection (one listener
// each, see processFatalHandlersRegistered), logs the error and, with exitOnError:false, never
// exits, so a process that threw at startup used to exit 0 or idle. Node removes a process.once()
// handler as it invokes it and orders prepended/appended listeners differently, so any decision
// taken from inside a listener depends on registration order and lifetime. Instead this module
// wraps process.emit once: when the fatal event is emitted, before dispatch, it asks whether ANY
// registered listener is not one of winston's own. If so the application owns the event
// (GracefulShutdown and the legacy log-and-continue servers do) and nothing is scheduled;
// otherwise the process exits 1 shortly after winston has written the record. A handler for the
// other event does not count, and it adds no listener of its own to either event.
let fatalClaimPending = false;
// The ownership sets live on the process, keyed by a registered Symbol, so every evaluation of this
// module (a cached import, or a fresh re-import under a query suffix) shares one hook and one record
// of which listeners are winston's own.
const FATAL_STATE = Symbol.for('wrfcoin.logger.fatalListeners');
const fatalHolder = process as unknown as Record<symbol, Record<string, Set<Function>> | undefined>;
const winstonFatalListeners: Record<string, Set<Function>> = (fatalHolder[FATAL_STATE] ??= {
  uncaughtException: new Set(),
  unhandledRejection: new Set(),
});
const FATAL_EXIT_HOOK = Symbol.for('wrfcoin.logger.fatalExitHook');
function installFatalExit(): void {
  const proc = process as unknown as Record<symbol, unknown>;
  if (proc[FATAL_EXIT_HOOK]) return;
  proc[FATAL_EXIT_HOOK] = true;
  const originalEmit = process.emit;
  process.emit = function patchedEmit(this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
    // Only an emission ON the process is a process fatal; a borrowed call on another emitter is not.
    if (this === process && (event === 'uncaughtException' || event === 'unhandledRejection')
      && !process.listeners(event).some((listener) => !winstonFatalListeners[event].has(listener))) {
      process.exitCode = 1;
      // Winston's own listener (still to be dispatched) writes the record; then leave.
      setTimeout(() => process.exit(1), 500).unref();
    }
    return (originalEmit as (...a: unknown[]) => boolean).call(this, event, ...args);
  } as typeof process.emit;
}

// Create comprehensive logger with all transports
const createLogger = (service: string = 'wrfcoin-core'): winston.Logger => {
  const listenersBefore = {
    uncaughtException: new Set<Function>(process.listeners('uncaughtException')),
    unhandledRejection: new Set<Function>(process.listeners('unhandledRejection')),
  };
  fatalClaimPending = false;
  const logger = winston.createLogger({
    level: logLevel,
    defaultMeta: {
      service,
      environment: process.env.NODE_ENV || 'development',
      version: process.env.APP_VERSION || '1.0.0',
      nodeVersion: process.version,
      platform: process.platform,
    },
    transports: createTransports(service),
    // Winston never exits on its own here; installFatalExit() decides per event (backend#1243).
    exitOnError: false,
    silent: process.env.SILENT_LOGS === 'true',
  });

  /**
   * Enhanced logging with OpenTelemetry trace context and Prometheus metrics
   *
   * This wrapper adds:
   * 1. Correlation ID from async local storage
   * 2. OpenTelemetry traceId/spanId from active span for distributed tracing
   * 3. Prometheus counter increment for log level monitoring
   */
  const originalLog = logger.log.bind(logger);
  logger.log = function (
    level: any,
    message?: any,
    meta?: any,
    ...args: any[]
  ) {
    // Get correlation ID from async context
    const correlationId = getCorrelationId();

    // Get OpenTelemetry trace context from active span
    const traceContext = getOTelTraceContext();

    // Prepare metadata with correlation and trace context
    const enrichedMeta = {
      correlationId,
      ...(traceContext.traceId && { traceId: traceContext.traceId }),
      ...(traceContext.spanId && { spanId: traceContext.spanId }),
    };

    // Merge context into metadata
    if (typeof meta === 'object' && meta !== null) {
      Object.assign(meta, enrichedMeta);
    } else if (typeof message === 'object' && message !== null) {
      Object.assign(message, enrichedMeta);
    } else {
      meta = { ...meta, ...enrichedMeta };
    }

    // Record Prometheus metrics for log level monitoring
    // This enables alerting on error rates and log volume
    try {
      const levelStr = typeof level === 'string' ? level : (level?.level || 'info');
      recordLogMetric(levelStr, service);
    } catch {
      // Silently ignore metrics errors to not impact logging
    }

    return originalLog(level, message, meta, ...args);
  };

  if (fatalClaimPending) {
    // This logger claimed the fatal events: whatever listeners appeared while it was built are winston's.
    fatalClaimPending = false;
    for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
      for (const listener of process.listeners(event)) {
        if (!listenersBefore[event].has(listener)) winstonFatalListeners[event].add(listener);
      }
    }
    installFatalExit();
  }
  return logger;
};

// Create specialized loggers for different services
export const appLogger = createLogger('app');
export const openforisLogger = createLogger('openforis');
export const performanceLogger = createLogger('performance');
export const securityLogger = createLogger('security');
export const graphqlLogger = createLogger('graphql');
export const crosschainLogger = createLogger('crosschain');
// backend#1086: `server/utils/logger.js` — a separate, standalone winston module
// with the same basename — spells this `crossChainLogger`, and seven cross-chain
// modules destructure that spelling from `../utils/logger.js`. In `dist/` only
// this file survives (copy-build-assets skips a `.js` with a `.ts` peer), so the
// capitalised name resolved to `undefined` and the Axelar and LayerZero
// api-clients threw on every call in the default production configuration.
// Exported here so the emitted artifact satisfies both live spellings. The real
// defect is two logger implementations under one basename; consolidating them is
// tracked separately and is not a one-line change — 201 call sites require this
// path without an extension and resolve to the `.js` module under plain node.
export const crossChainLogger = crosschainLogger;
export const iotLogger = createLogger('iot');
export const weatherLogger = createLogger('weather');
export const walletLogger = createLogger('wallet');
export const governanceLogger = createLogger('governance');
export const computeLogger = createLogger('compute');
export const aimlLogger = createLogger('aiml');
export const storageLogger = createLogger('storage');
export const blockchainLogger = createLogger('blockchain');
export const miningLogger = createLogger('mining');
// backend#1097: `server/utils/logger.js` — a separate winston module sharing this
// basename — exports these six, and copy-build-assets skips a `.js` with a `.ts`
// peer, so only THIS file reaches dist. Consumers destructuring them from
// `../utils/logger.js` therefore got `undefined` in production while passing
// every dev and jest test, because both of those resolve the `.js` module.
// Two were live defects: `websocketLogger` (api/gamification-notifications.js:18,
// on client connect) and `nftLogger` (api/environmental-achievement-nfts.js:279,
// inside a catch block — it turned a handled error into an unhandled TypeError).
// The other four had no consumer and were latent. Exported here so the module
// that actually ships is a superset of the one dev runs.
export const websocketLogger = createLogger('websocket');
export const nftLogger = createLogger('nft');
export const privacyLogger = createLogger('privacy');
export const analyticsLogger = createLogger('analytics');
export const identityLogger = createLogger('identity');
export const oracleLogger = createLogger('oracle');
// Alias for CJS modules that destructure { logger } from this module.
// The CJS logger.js source also exports { logger } but TypeScript compilation
// overwrites it in dist — this alias ensures CJS require()s get a valid logger.
export const logger = createLogger('default');

// Enhanced helper functions for structured logging
export const logError = (
  logger: winston.Logger,
  message: string,
  error: Error,
  metadata?: LogMetadata
) => {
  const errorCategory = (error as any).category || 'system';
  const errorSeverity = (error as any).severity || 'medium';

  logger.error(message, {
    ...metadata,
    error: {
      name: error.name,
      message: error.message,
      stack: isProduction ? undefined : error.stack, // Hide stack traces in production
      code: (error as any).code,
      cause: (error as any).cause,
      category: errorCategory,
      severity: errorSeverity,
    },
    correlationId: getCorrelationId(),
  });
};

export const logOpenforisOperation = (
  operation: string,
  metadata: LogMetadata['openforis'] & {
    success: boolean;
    duration: number;
    userId?: string;
  }
) => {
  const level = metadata.success ? 'info' : 'error';
  const message = `OpenForis ${operation} ${metadata.success ? 'completed' : 'failed'}`;

  openforisLogger.log(level, message, {
    operation,
    userId: metadata.userId,
    openforis: {
      operation,
      ...metadata,
    },
    performance: {
      responseTime: metadata.duration,
    },
    correlationId: getCorrelationId(),
  });
};

export const logPerformanceMetrics = (
  operation: string,
  duration: number,
  memoryUsage?: NodeJS.MemoryUsage,
  additionalMetrics?: Record<string, any>
) => {
  performanceLogger.info(`Performance metrics for ${operation}`, {
    operation,
    duration,
    performance: {
      responseTime: duration,
      memoryUsage,
      ...additionalMetrics,
    },
    correlationId: getCorrelationId(),
  });
};

export const logSecurityEvent = (
  event: string,
  details: Record<string, any>,
  level: LogLevel = 'warn',
  userId?: string,
  ip?: string
) => {
  securityLogger.log(level, `Security event: ${event}`, {
    operation: event,
    userId,
    ip,
    security: {
      event,
      ...details,
      timestamp: new Date().toISOString(),
    },
    correlationId: getCorrelationId(),
  });
};

export const logGraphQLOperation = (
  operationType: 'query' | 'mutation' | 'subscription',
  operationName: string,
  duration: number,
  complexity?: number,
  variables?: Record<string, any>,
  userId?: string
) => {
  graphqlLogger.info(`GraphQL ${operationType}: ${operationName}`, {
    operation: `${operationType}:${operationName}`,
    userId,
    duration,
    graphql: {
      operationType,
      operationName,
      complexity,
      variables: maskSensitiveData(variables),
    },
    performance: {
      responseTime: duration,
    },
    correlationId: getCorrelationId(),
  });
};

export const logServiceCall = (
  targetService: string,
  endpoint: string,
  method: string,
  duration: number,
  success: boolean,
  statusCode?: number,
  circuitBreakerState?: 'closed' | 'open' | 'half-open'
) => {
  const level = success ? 'info' : 'warn';
  const message = `Service call to ${targetService}${endpoint} ${success ? 'succeeded' : 'failed'}`;

  appLogger.log(level, message, {
    operation: `service-call:${targetService}`,
    duration,
    statusCode,
    serviceCall: {
      targetService,
      endpoint,
      method,
      duration,
      success,
      circuitBreakerState,
    },
    performance: {
      responseTime: duration,
    },
    correlationId: getCorrelationId(),
  });
};

export const logCrossChainOperation = (
  sourceChain: string,
  targetChain: string,
  operation: string,
  amount: string,
  transactionHash?: string,
  duration?: number,
  success?: boolean
) => {
  const level = success === false ? 'error' : 'info';
  const message = `Cross-chain ${operation}: ${sourceChain} -> ${targetChain} (${amount})`;

  crosschainLogger.log(level, message, {
    operation: `crosschain:${operation}`,
    transactionHash,
    duration,
    crossChain: {
      sourceChain,
      targetChain,
      bridgeType: operation,
      amount,
    },
    performance: duration ? { responseTime: duration } : undefined,
    correlationId: getCorrelationId(),
  });
};

export const logWeatherData = (
  stationId: string,
  dataType: string,
  operation: string,
  dataPoints?: number,
  accuracy?: number,
  duration?: number
) => {
  weatherLogger.info(`Weather data ${operation}: ${stationId} (${dataType})`, {
    operation: `weather:${operation}`,
    duration,
    weather: {
      stationId,
      dataType,
      accuracy,
      timestamp: new Date().toISOString(),
    },
    performance: duration ? { responseTime: duration } : undefined,
    correlationId: getCorrelationId(),
  });
};

export const logIoTSensorData = (
  deviceId: string,
  sensorType: string,
  operation: string,
  dataPoints?: number,
  quality?: 'high' | 'medium' | 'low',
  location?: { latitude: number; longitude: number }
) => {
  iotLogger.info(`IoT sensor ${operation}: ${deviceId} (${sensorType})`, {
    operation: `iot:${operation}`,
    iot: {
      deviceId,
      sensorType,
      dataPoints,
      quality,
      location,
    },
    correlationId: getCorrelationId(),
  });
};

// Request/Response logging middleware helper
export const createRequestLogger = (service: string = 'http') => {
  const logger = createLogger(service);

  return (req: any, res: any, next: any) => {
    const startTime = Date.now();
    const correlationId =
      req.headers['x-correlation-id'] || generateCorrelationId();

    // Set correlation ID in async context
    const store = new Map();
    store.set('correlationId', correlationId);

    asyncLocalStorage.run(store, () => {
      // Log incoming request
      logger.info(`Incoming ${req.method} ${req.path}`, {
        operation: `${req.method}:${req.path}`,
        method: req.method,
        path: req.path,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent'),
        correlationId,
        requestId: req.id,
      });

      // Override res.end to log response
      const originalEnd = res.end;
      res.end = function (...args: any[]) {
        const duration = Date.now() - startTime;
        const level = res.statusCode >= 400 ? 'warn' : 'info';

        logger.log(level, `${req.method} ${req.path} ${res.statusCode}`, {
          operation: `${req.method}:${req.path}`,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          duration,
          ip: req.ip || req.connection.remoteAddress,
          userAgent: req.get('User-Agent'),
          correlationId,
          requestId: req.id,
          performance: {
            responseTime: duration,
          },
        });

        return originalEnd.apply(this, args);
      };

      next();
    });
  };
};

// Export the main logger creation function
export default createLogger;
