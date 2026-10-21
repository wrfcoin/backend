/**
 * Query Cache Security Service
 * Task 104.8: Query Optimization Security
 *
 * Provides secure caching for query results with:
 * - Encryption at rest for sensitive data
 * - Role-based cache namespace isolation
 * - Cache invalidation on security events
 * - Cache poisoning prevention
 * - Audit logging for cache access
 */

import crypto from 'crypto';
import { securityLogger } from '../utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

interface CacheConfig {
  encryptionKey?: string;
  defaultTTL: number; // seconds
  maxCacheSize: number; // bytes
  enableEncryption: boolean;
  enableAuditLogging: boolean;
}

interface CachedEntry {
  data: string; // Encrypted or serialized JSON
  encrypted: boolean;
  namespace: string;
  userRole: string;
  createdAt: number;
  expiresAt: number;
  accessCount: number;
  lastAccessed: number;
  checksum: string;
  metadata: {
    queryHash: string;
    rowCount?: number;
    dataSize: number;
  };
}

interface CacheAccessLog {
  action: 'GET' | 'SET' | 'DELETE' | 'INVALIDATE';
  namespace: string;
  key: string;
  userId?: string;
  userRole?: string;
  success: boolean;
  reason?: string;
  timestamp: Date;
}

interface CacheStats {
  totalEntries: number;
  totalSize: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  byNamespace: Map<string, { entries: number; size: number }>;
  encryptedEntries: number;
}

// ============================================================================
// Cache Security Service
// ============================================================================

export class QueryCacheSecurityService {
  private cache: Map<string, CachedEntry> = new Map();
  private accessLogs: CacheAccessLog[] = [];
  private stats = {
    hitCount: 0,
    missCount: 0,
  };
  private config: CacheConfig;
  private encryptionKey: Buffer;
  private invalidationRules: Map<string, RegExp[]> = new Map();

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      encryptionKey: config.encryptionKey || process.env.CACHE_ENCRYPTION_KEY,
      defaultTTL: config.defaultTTL || 300, // 5 minutes
      maxCacheSize: config.maxCacheSize || 100 * 1024 * 1024, // 100MB
      enableEncryption: config.enableEncryption ?? true,
      enableAuditLogging: config.enableAuditLogging ?? true,
    };

    // Derive encryption key from config or generate one
    const keySource =
      this.config.encryptionKey || crypto.randomBytes(32).toString('hex');
    this.encryptionKey = crypto.scryptSync(keySource, 'wrfcoin-cache-salt', 32);

    // Set up default invalidation rules
    this.setupDefaultInvalidationRules();

    // Start periodic cleanup
    this.startPeriodicCleanup();
  }

  // ============================================================================
  // Core Cache Operations
  // ============================================================================

  /**
   * Get a cached entry with security checks
   */
  get(
    key: string,
    namespace: string,
    userRole: string,
    userId?: string
  ): { found: boolean; data: unknown | null; reason?: string } {
    const fullKey = this.buildSecureKey(key, namespace, userRole);
    const entry = this.cache.get(fullKey);

    // Log access attempt
    this.logAccess({
      action: 'GET',
      namespace,
      key,
      userId,
      userRole,
      success: !!entry,
      reason: entry ? undefined : 'Cache miss',
      timestamp: new Date(),
    });

    if (!entry) {
      this.stats.missCount++;
      return { found: false, data: null, reason: 'Cache miss' };
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(fullKey);
      this.stats.missCount++;
      return { found: false, data: null, reason: 'Entry expired' };
    }

    // Verify namespace isolation
    if (entry.namespace !== namespace) {
      this.stats.missCount++;
      return { found: false, data: null, reason: 'Namespace mismatch' };
    }

    // Verify checksum (prevent tampering)
    const calculatedChecksum = this.calculateChecksum(entry.data);
    if (calculatedChecksum !== entry.checksum) {
      this.cache.delete(fullKey);
      this.logSecurityEvent('CACHE_TAMPERING_DETECTED', {
        key: fullKey,
        namespace,
        userRole,
      });
      return { found: false, data: null, reason: 'Cache integrity check failed' };
    }

    // Decrypt if needed
    let data: unknown;
    try {
      const rawData = entry.encrypted
        ? this.decrypt(entry.data)
        : entry.data;
      data = JSON.parse(rawData);
    } catch (error) {
      this.cache.delete(fullKey);
      return { found: false, data: null, reason: 'Decryption/parse failed' };
    }

    // Update access stats
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this.stats.hitCount++;

    return { found: true, data };
  }

  /**
   * Set a cache entry with security measures
   */
  set(
    key: string,
    data: unknown,
    namespace: string,
    userRole: string,
    options: {
      ttl?: number;
      encrypt?: boolean;
      queryHash?: string;
      userId?: string;
    } = {}
  ): { success: boolean; reason?: string } {
    const fullKey = this.buildSecureKey(key, namespace, userRole);
    const ttl = options.ttl || this.config.defaultTTL;
    const shouldEncrypt = options.encrypt ?? this.shouldEncryptByDefault(namespace, userRole);

    // Serialize data
    const serialized = JSON.stringify(data);
    const dataSize = Buffer.byteLength(serialized, 'utf8');

    // Check size limits
    if (dataSize > this.config.maxCacheSize * 0.1) {
      return {
        success: false,
        reason: 'Entry too large (max 10% of total cache size)',
      };
    }

    // Check total cache size and evict if needed
    this.evictIfNeeded(dataSize);

    // Encrypt if required
    let storedData: string;
    try {
      storedData = shouldEncrypt ? this.encrypt(serialized) : serialized;
    } catch (error) {
      return { success: false, reason: 'Encryption failed' };
    }

    // Create cache entry
    const entry: CachedEntry = {
      data: storedData,
      encrypted: shouldEncrypt,
      namespace,
      userRole,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
      accessCount: 0,
      lastAccessed: Date.now(),
      checksum: this.calculateChecksum(storedData),
      metadata: {
        queryHash: options.queryHash || this.hashQuery(key),
        rowCount: Array.isArray(data) ? data.length : undefined,
        dataSize,
      },
    };

    this.cache.set(fullKey, entry);

    // Log cache set
    this.logAccess({
      action: 'SET',
      namespace,
      key,
      userId: options.userId,
      userRole,
      success: true,
      timestamp: new Date(),
    });

    return { success: true };
  }

  /**
   * Delete a specific cache entry
   */
  delete(
    key: string,
    namespace: string,
    userRole: string,
    userId?: string
  ): boolean {
    const fullKey = this.buildSecureKey(key, namespace, userRole);
    const existed = this.cache.has(fullKey);
    this.cache.delete(fullKey);

    this.logAccess({
      action: 'DELETE',
      namespace,
      key,
      userId,
      userRole,
      success: existed,
      timestamp: new Date(),
    });

    return existed;
  }

  /**
   * Invalidate cache entries based on security event
   */
  invalidateOnSecurityEvent(
    eventType: string,
    affectedNamespaces?: string[],
    affectedRoles?: string[]
  ): number {
    let invalidatedCount = 0;
    const keysToDelete: string[] = [];

    for (const [fullKey, entry] of this.cache.entries()) {
      let shouldInvalidate = false;

      // Check namespace match
      if (
        affectedNamespaces &&
        affectedNamespaces.includes(entry.namespace)
      ) {
        shouldInvalidate = true;
      }

      // Check role match
      if (affectedRoles && affectedRoles.includes(entry.userRole)) {
        shouldInvalidate = true;
      }

      // Check event-specific rules
      const rules = this.invalidationRules.get(eventType);
      if (rules) {
        for (const rule of rules) {
          if (rule.test(fullKey)) {
            shouldInvalidate = true;
            break;
          }
        }
      }

      if (shouldInvalidate) {
        keysToDelete.push(fullKey);
      }
    }

    // Delete all matched entries
    for (const key of keysToDelete) {
      this.cache.delete(key);
      invalidatedCount++;
    }

    // Log invalidation
    this.logAccess({
      action: 'INVALIDATE',
      namespace: '*',
      key: eventType,
      success: true,
      reason: `Invalidated ${invalidatedCount} entries due to ${eventType}`,
      timestamp: new Date(),
    });

    this.logSecurityEvent('CACHE_INVALIDATION', {
      eventType,
      invalidatedCount,
      affectedNamespaces,
      affectedRoles,
    });

    return invalidatedCount;
  }

  /**
   * Clear all cache entries for a specific namespace
   */
  clearNamespace(namespace: string, reason?: string): number {
    let clearedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.namespace === namespace) {
        this.cache.delete(key);
        clearedCount++;
      }
    }

    this.logSecurityEvent('NAMESPACE_CLEARED', {
      namespace,
      clearedCount,
      reason,
    });

    return clearedCount;
  }

  /**
   * Clear all cache entries for a specific role
   */
  clearByRole(role: string, reason?: string): number {
    let clearedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.userRole === role) {
        this.cache.delete(key);
        clearedCount++;
      }
    }

    this.logSecurityEvent('ROLE_CACHE_CLEARED', {
      role,
      clearedCount,
      reason,
    });

    return clearedCount;
  }

  // ============================================================================
  // Security Functions
  // ============================================================================

  /**
   * Encrypt data using AES-256-GCM
   */
  private encrypt(data: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv
    );

    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encryptedData
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt data using AES-256-GCM
   */
  private decrypt(encryptedData: string): string {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv
    );
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Calculate checksum for integrity verification
   */
  private calculateChecksum(data: string): string {
    return crypto
      .createHmac('sha256', this.encryptionKey)
      .update(data)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Build a secure cache key with namespace isolation
   */
  private buildSecureKey(
    key: string,
    namespace: string,
    userRole: string
  ): string {
    // Include namespace and role in key to ensure isolation
    const combined = `${namespace}:${userRole}:${key}`;
    return crypto.createHash('sha256').update(combined).digest('hex');
  }

  /**
   * Hash a query for metadata
   */
  private hashQuery(query: string): string {
    return crypto.createHash('sha256').update(query).digest('hex');
  }

  /**
   * Determine if data should be encrypted by default
   */
  private shouldEncryptByDefault(namespace: string, userRole: string): boolean {
    if (!this.config.enableEncryption) {
      return false;
    }

    // Always encrypt for sensitive namespaces
    const sensitiveNamespaces = [
      'user_data',
      'wallet',
      'transactions',
      'governance',
      'admin',
    ];

    if (sensitiveNamespaces.includes(namespace)) {
      return true;
    }

    // Always encrypt for privileged roles
    const privilegedRoles = ['admin', 'super_admin', 'security_admin'];
    if (privilegedRoles.includes(userRole)) {
      return true;
    }

    return true; // Encrypt by default for safety
  }

  // ============================================================================
  // Cache Maintenance
  // ============================================================================

  /**
   * Evict entries if cache is too large
   */
  private evictIfNeeded(newEntrySize: number): void {
    let currentSize = this.calculateTotalSize();

    if (currentSize + newEntrySize <= this.config.maxCacheSize) {
      return;
    }

    // Sort entries by last accessed time (LRU)
    const entries = Array.from(this.cache.entries()).sort(
      (a, b) => a[1].lastAccessed - b[1].lastAccessed
    );

    // Evict until we have enough space
    for (const [key, entry] of entries) {
      if (currentSize + newEntrySize <= this.config.maxCacheSize * 0.8) {
        break;
      }
      this.cache.delete(key);
      currentSize -= entry.metadata.dataSize;
    }
  }

  /**
   * Calculate total cache size
   */
  private calculateTotalSize(): number {
    let total = 0;
    for (const entry of this.cache.values()) {
      total += entry.metadata.dataSize;
    }
    return total;
  }

  /**
   * Start periodic cleanup of expired entries
   */
  private startPeriodicCleanup(): void {
    setInterval(() => {
      this.cleanupExpired();
    }, 60000); // Every minute
  }

  /**
   * Remove expired entries
   */
  private cleanupExpired(): number {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    return cleanedCount;
  }

  /**
   * Setup default invalidation rules
   */
  private setupDefaultInvalidationRules(): void {
    // User-related security events
    this.invalidationRules.set('USER_ROLE_CHANGED', [
      /^[a-f0-9]+$/i, // All hashed keys
    ]);

    this.invalidationRules.set('USER_PERMISSIONS_CHANGED', [
      /^[a-f0-9]+$/i,
    ]);

    this.invalidationRules.set('USER_BLOCKED', [
      /^[a-f0-9]+$/i,
    ]);

    // Data-related security events
    this.invalidationRules.set('DATA_BREACH_DETECTED', [
      /^[a-f0-9]+$/i, // Clear all cache
    ]);

    this.invalidationRules.set('SCHEMA_CHANGE', [
      /^[a-f0-9]+$/i,
    ]);
  }

  // ============================================================================
  // Logging and Monitoring
  // ============================================================================

  /**
   * Log cache access
   */
  private logAccess(log: CacheAccessLog): void {
    if (!this.config.enableAuditLogging) {
      return;
    }

    this.accessLogs.push(log);

    // Limit log size
    if (this.accessLogs.length > 10000) {
      this.accessLogs = this.accessLogs.slice(-5000);
    }
  }

  /**
   * Log security event
   */
  private logSecurityEvent(
    eventType: string,
    details: Record<string, unknown>
  ): void {
    securityLogger.warn('Cache security event', { module: 'QueryCacheSecurity', eventType, ...details });
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const byNamespace = new Map<string, { entries: number; size: number }>();
    let encryptedEntries = 0;
    let totalSize = 0;

    for (const entry of this.cache.values()) {
      totalSize += entry.metadata.dataSize;

      if (entry.encrypted) {
        encryptedEntries++;
      }

      const nsStats = byNamespace.get(entry.namespace) || {
        entries: 0,
        size: 0,
      };
      nsStats.entries++;
      nsStats.size += entry.metadata.dataSize;
      byNamespace.set(entry.namespace, nsStats);
    }

    const totalRequests = this.stats.hitCount + this.stats.missCount;
    const hitRate = totalRequests > 0 ? this.stats.hitCount / totalRequests : 0;

    return {
      totalEntries: this.cache.size,
      totalSize,
      hitCount: this.stats.hitCount,
      missCount: this.stats.missCount,
      hitRate,
      byNamespace,
      encryptedEntries,
    };
  }

  /**
   * Get recent access logs
   */
  getAccessLogs(limit: number = 100): CacheAccessLog[] {
    return this.accessLogs.slice(-limit);
  }

  /**
   * Get access logs filtered by criteria
   */
  getFilteredAccessLogs(filters: {
    namespace?: string;
    action?: CacheAccessLog['action'];
    success?: boolean;
    since?: Date;
    limit?: number;
  }): CacheAccessLog[] {
    let logs = this.accessLogs;

    if (filters.namespace) {
      logs = logs.filter((l) => l.namespace === filters.namespace);
    }

    if (filters.action) {
      logs = logs.filter((l) => l.action === filters.action);
    }

    if (filters.success !== undefined) {
      logs = logs.filter((l) => l.success === filters.success);
    }

    if (filters.since) {
      logs = logs.filter((l) => l.timestamp >= filters.since!);
    }

    return logs.slice(-(filters.limit || 100));
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: QueryCacheSecurityService | null = null;

export function getQueryCacheSecurityService(
  config?: Partial<CacheConfig>
): QueryCacheSecurityService {
  if (!instance) {
    instance = new QueryCacheSecurityService(config);
  }
  return instance;
}

// ============================================================================
// Export
// ============================================================================

export default {
  QueryCacheSecurityService,
  getQueryCacheSecurityService,
};
