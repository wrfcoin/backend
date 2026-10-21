/**
 * Security Types for Wrfcoin Platform
 * Type definitions for security, validation, and authentication
 */

// Branded types for additional type safety
export type EthereumAddress = string & { __brand: 'EthereumAddress' };
export type PositiveNumber = number & { __brand: 'PositiveNumber' };
export type SupportedToken = string & { __brand: 'SupportedToken' };
export type SecureHash = string & { __brand: 'SecureHash' };
export type EncryptedData = string & { __brand: 'EncryptedData' };
export type HSMKeyHandle = string & { __brand: 'HSMKeyHandle' };
export type CryptographicAlgorithm =
  | 'ECDSA-P256'
  | 'RSA-2048'
  | 'RSA-4096'
  | 'Ed25519';
export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';

// Authentication Types
export interface AuthenticationResult {
  success: boolean;
  token?: string;
  refreshToken?: string;
  expiresIn?: number;
  user?: UserProfile;
  error?: string;
}

export interface UserProfile {
  id: string;
  address: EthereumAddress;
  roles: UserRole[];
  permissions: Permission[];
  lastLogin: Date;
  isActive: boolean;
}

export interface UserRole {
  id: string;
  name: string;
  permissions: Permission[];
}

export interface Permission {
  resource: string;
  action: string;
  conditions?: Record<string, any>;
}

// Validation Types
export interface ValidatedRequest<T = any> {
  data: T;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  isValid: boolean;
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
  value?: any;
}

export interface ValidationWarning {
  field: string;
  message: string;
  code: string;
}

export interface ValidatedTransferRequest {
  fromAddress: EthereumAddress;
  toAddress: EthereumAddress;
  amount: PositiveNumber;
  token: SupportedToken;
  fee: PositiveNumber;
  nonce: number;
  signature: SecureHash;
}

// HSM and Vault Types
export interface HSMConfiguration {
  provider: 'YubiHSM' | 'Azure' | 'AWS' | 'PKCS11' | 'SoftHSM';
  endpoint?: string;
  credentials: HSMCredentials;
  settings: HSMSettings;
}

export interface HSMCredentials {
  keyId: string;
  pin?: string;
  certificate?: string;
  privateKey?: string;
}

export interface HSMSettings {
  sessionTimeout: number;
  maxRetries: number;
  auditLogging: boolean;
  keyRotationInterval: number;
}

export interface HSMKeyPair {
  keyHandle: string;
  algorithm: string;
  publicKey: string;
  keyType: string;
  createdAt: Date;
  expiresAt?: Date;
}

export interface VaultSecret {
  path: string;
  key: string;
  value: EncryptedData;
  version: number;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultConfiguration {
  endpoint: string;
  authMethod: 'token' | 'userpass' | 'approle' | 'kubernetes';
  namespace?: string;
  credentials: VaultCredentials;
  options: VaultOptions;
}

export interface VaultCredentials {
  token?: string;
  username?: string;
  password?: string;
  roleId?: string;
  secretId?: string;
}

export interface VaultOptions {
  timeout: number;
  retries: number;
  apiVersion: string;
  requestTimeout: number;
}

// Audit and Logging Types
export interface SecurityAuditLog {
  timestamp: string;
  event: string;
  success: boolean;
  userId: string;
  ipAddress: string;
  userAgent: string;
  requestPath?: string;
  requestMethod?: string;
  keyHandle?: HSMKeyHandle;
  keyType?: string;
  algorithm?: CryptographicAlgorithm;
  sessionId?: string;
  dataHash?: string;
  keyCount?: number;
  deviceId?: string;
  blockReason?: string;
}

export interface SecurityAlert {
  id: string;
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
  message?: string; // Alias for description for backward compatibility
  sourceIp?: string;
  clientIp?: string; // Alias for sourceIp for backward compatibility
  userId?: EthereumAddress;
  timestamp: Date;
  resolved: boolean;
  resolution?: string;
  resolvedAt?: Date;
  additionalData?: Record<string, any>;
}

export interface AuditLog {
  id: string;
  action: string;
  resource: string;
  userId?: EthereumAddress;
  timestamp: Date;
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  details?: Record<string, any>;
}

export interface SecurityMetrics {
  totalAlerts: number;
  resolvedAlerts: number;
  criticalAlerts: number;
  highAlerts: number;
  mediumAlerts: number;
  lowAlerts: number;
  threatLevel: ThreatLevel;
  lastThreatDetection?: Date;
  systemStatus: string;
  activeThreats: number;
  blockedIPs: number;
  suspiciousActivities: number;
  lastUpdate: Date;
}

export interface JWTPayload {
  userId: string;
  roles: string[];
  permissions: string[];
  sessionId: string;
  jti?: string;
  iat: number;
  exp: number;
}

import { Request, Response, NextFunction } from 'express';

// Use proper Express types that include all required properties
export interface AuthenticatedRequest extends Request {
  user?: {
    id?: string;
    userId?: string; // Alias for id for backward compatibility
    address?: string;
    walletAddress?: string; // Alias for address for backward compatibility
    email?: string;
    role?: string;
    roles?: string[];
    permissions?: string[];
    sessionId?: string;
    verified?: boolean;
  };
  apiKey?: {
    id: string; // API key ID (required per global augmentation)
    userId: string; // User ID associated with the API key (required per global augmentation)
    name?: string; // API key name
    permissions: string[];
    scopes: string[]; // Scopes for fine-grained access (required per global augmentation)
    rateLimitTier: string;
    remainingQuota?: {
      daily: number;
      monthly: number;
    };
    lastUsed?: Date;
  };
  service?: {
    name: string;
    id: string;
  };
}

// Export common Express types for consistency
export { Response, NextFunction } from 'express';

export interface APIKeyValidation {
  isValid: boolean;
  reason?: string;
  permissions?: string[];
  rateLimitTier?: string;
  /** The environment extracted from the API key (live, test, or dev) */
  environment?: 'live' | 'test' | 'dev';
}

export interface VaultConfig {
  url: string;
  token: string;
  namespace?: string;
  timeout: number;
  retryAttempts: number;
}

export interface SecretRotationPolicy {
  enabled: boolean;
  rotationInterval: string;
  lastRotated: Date;
  nextRotation: Date;
}

export interface SecurityEvent {
  type: SecurityEventType;
  category: SecurityEventCategory;
  description: string;
  result: 'success' | 'failure' | 'warning';
}

export type SecurityEventType =
  | 'authentication'
  | 'authorization'
  | 'data_access'
  | 'configuration_change'
  | 'key_operation'
  | 'vault_operation'
  | 'suspicious_activity'
  | 'rate_limit_exceeded';

export type SecurityEventCategory =
  | 'access_control'
  | 'cryptography'
  | 'network_security'
  | 'data_protection'
  | 'compliance'
  | 'incident_response';

// Rate Limiting Types
export interface RateLimitConfiguration {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests: boolean;
  skipFailedRequests: boolean;
  keyGenerator: (req: any) => string;
  handler: (req: any, res: any) => void;
}

export interface RateLimitStatus {
  limit: number;
  remaining: number;
  reset: Date;
  retryAfter?: number;
}

// Input Sanitization Types
export interface SanitizationResult {
  sanitized: string;
  original: string;
  modified: boolean;
  threats: ThreatDetection[];
}

export interface ThreatDetection {
  type: ThreatType;
  severity: 'low' | 'medium' | 'high';
  description: string;
  location: string;
  mitigation: string;
}

export type ThreatType =
  | 'xss'
  | 'sql_injection'
  | 'script_injection'
  | 'html_injection'
  | 'path_traversal'
  | 'command_injection'
  | 'ldap_injection';

// CORS Configuration Types
export interface CORSConfiguration {
  origin: string[] | RegExp[];
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  credentials: boolean;
  maxAge: number;
  preflightContinue: boolean;
  optionsSuccessStatus: number;
}

// Security Headers Types
export interface SecurityHeaders {
  'Strict-Transport-Security': string;
  'Content-Security-Policy': string;
  'X-Content-Type-Options': string;
  'X-Frame-Options': string;
  'X-XSS-Protection': string;
  'Referrer-Policy': string;
  'Feature-Policy': string;
  'Permissions-Policy': string;
}

// Encryption Types
export interface EncryptionConfiguration {
  algorithm: string;
  keySize: number;
  ivSize: number;
  tagSize: number;
  iterations: number;
  saltSize: number;
}

export interface EncryptionResult {
  encrypted: EncryptedData;
  iv: string;
  tag: string;
  salt: string;
  algorithm: string;
}

export interface DecryptionResult {
  decrypted: string;
  verified: boolean;
  algorithm: string;
}

// Session Management Types
export interface SessionData {
  sessionId: string;
  userId: string;
  address: EthereumAddress;
  roles: string[];
  permissions: string[];
  createdAt: Date;
  lastActivity: Date;
  expiresAt: Date;
  ipAddress: string;
  userAgent: string;
}

export interface SessionConfiguration {
  secret: string;
  name: string;
  maxAge: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  rolling: boolean;
  saveUninitialized: boolean;
  resave: boolean;
}
