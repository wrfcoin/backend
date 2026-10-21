/**
 * API Key Management Schema
 * Comprehensive database schema for secure API key management in the developer portal
 */

import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uuid,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// API Keys table - stores encrypted API key data
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(), // References users.accounts_consolidated.id
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),

    // Encrypted key data
    keyHash: varchar('key_hash', { length: 512 }).notNull().unique(), // SHA-256 hash for validation
    keyPrefix: varchar('key_prefix', { length: 12 }).notNull(), // First 12 chars for display (wrf_xxxxx...)

    // Security and permissions
    permissions: jsonb('permissions').notNull().default(['read']), // ['read', 'write', 'admin']
    scopes: jsonb('scopes').notNull().default(['*']), // API endpoint scopes

    // Rate limiting and quotas
    rateLimitTier: varchar('rate_limit_tier', { length: 50 })
      .notNull()
      .default('standard'), // standard, premium, enterprise
    dailyRequestLimit: integer('daily_request_limit').default(10000),
    monthlyRequestLimit: integer('monthly_request_limit').default(300000),

    // Status and lifecycle
    isActive: boolean('is_active').notNull().default(true),
    expiresAt: timestamp('expires_at'),
    lastUsedAt: timestamp('last_used_at'),

    // IP and environment restrictions
    allowedIps: jsonb('allowed_ips').default([]), // Array of allowed IP addresses/CIDR blocks
    allowedDomains: jsonb('allowed_domains').default([]), // Array of allowed referrer domains
    environment: varchar('environment', { length: 50 }).default('production'), // production, staging, development

    // Audit fields
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    createdBy: uuid('created_by').notNull(), // User who created the key
    revokedAt: timestamp('revoked_at'),
    revokedBy: uuid('revoked_by'),
    revokeReason: text('revoke_reason'),
  },
  table => ({
    userIdIdx: index('api_keys_user_id_idx').on(table.userId),
    keyHashIdx: uniqueIndex('api_keys_key_hash_idx').on(table.keyHash),
    isActiveIdx: index('api_keys_is_active_idx').on(table.isActive),
    expiresAtIdx: index('api_keys_expires_at_idx').on(table.expiresAt),
    lastUsedIdx: index('api_keys_last_used_idx').on(table.lastUsedAt),
  })
);

// API Key Usage Tracking - stores request logs for analytics and rate limiting
export const apiKeyUsage = pgTable(
  'api_key_usage',
  {
    id: serial('id').primaryKey(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),

    // Request details
    endpoint: varchar('endpoint', { length: 500 }).notNull(),
    method: varchar('method', { length: 10 }).notNull(),
    statusCode: integer('status_code').notNull(),
    responseTime: integer('response_time'), // milliseconds

    // Request metadata
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 45 }), // IPv6 compatible
    referrer: text('referrer'),
    requestSize: integer('request_size'), // bytes
    responseSize: integer('response_size'), // bytes

    // Geographic and network info
    country: varchar('country', { length: 2 }),
    region: varchar('region', { length: 100 }),
    city: varchar('city', { length: 100 }),
    isp: varchar('isp', { length: 255 }),

    // Error tracking
    errorCode: varchar('error_code', { length: 50 }),
    errorMessage: text('error_message'),

    // Timestamp
    requestedAt: timestamp('requested_at').notNull().defaultNow(),
  },
  table => ({
    apiKeyIdIdx: index('api_key_usage_api_key_id_idx').on(table.apiKeyId),
    requestedAtIdx: index('api_key_usage_requested_at_idx').on(
      table.requestedAt
    ),
    endpointIdx: index('api_key_usage_endpoint_idx').on(table.endpoint),
    statusCodeIdx: index('api_key_usage_status_code_idx').on(table.statusCode),
  })
);

// API Key Rate Limits - tracks current usage for rate limiting
export const apiKeyRateLimits = pgTable(
  'api_key_rate_limits',
  {
    id: serial('id').primaryKey(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),

    // Time windows
    windowType: varchar('window_type', { length: 20 }).notNull(), // minute, hour, day, month
    windowStart: timestamp('window_start').notNull(),
    windowEnd: timestamp('window_end').notNull(),

    // Usage counters
    requestCount: integer('request_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),

    // Last updated
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    apiKeyWindowIdx: uniqueIndex('api_key_rate_limits_key_window_idx').on(
      table.apiKeyId,
      table.windowType,
      table.windowStart
    ),
    windowEndIdx: index('api_key_rate_limits_window_end_idx').on(
      table.windowEnd
    ),
  })
);

// API Key Events - audit log for key lifecycle events
export const apiKeyEvents = pgTable(
  'api_key_events',
  {
    id: serial('id').primaryKey(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),

    // Event details
    eventType: varchar('event_type', { length: 50 }).notNull(), // created, updated, revoked, regenerated, used
    eventData: jsonb('event_data').default({}), // Additional event metadata

    // User and context
    userId: uuid('user_id').notNull(), // User who performed the action
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),

    // Timestamp
    occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  },
  table => ({
    apiKeyIdIdx: index('api_key_events_api_key_id_idx').on(table.apiKeyId),
    eventTypeIdx: index('api_key_events_event_type_idx').on(table.eventType),
    occurredAtIdx: index('api_key_events_occurred_at_idx').on(table.occurredAt),
    userIdIdx: index('api_key_events_user_id_idx').on(table.userId),
  })
);

// Relations
export const apiKeysRelations = relations(apiKeys, ({ many }) => ({
  usage: many(apiKeyUsage),
  rateLimits: many(apiKeyRateLimits),
  events: many(apiKeyEvents),
}));

export const apiKeyUsageRelations = relations(apiKeyUsage, ({ one }) => ({
  apiKey: one(apiKeys, {
    fields: [apiKeyUsage.apiKeyId],
    references: [apiKeys.id],
  }),
}));

export const apiKeyRateLimitsRelations = relations(
  apiKeyRateLimits,
  ({ one }) => ({
    apiKey: one(apiKeys, {
      fields: [apiKeyRateLimits.apiKeyId],
      references: [apiKeys.id],
    }),
  })
);

export const apiKeyEventsRelations = relations(apiKeyEvents, ({ one }) => ({
  apiKey: one(apiKeys, {
    fields: [apiKeyEvents.apiKeyId],
    references: [apiKeys.id],
  }),
}));

// Export the schema
export const apiKeyManagementSchema = {
  apiKeys,
  apiKeyUsage,
  apiKeyRateLimits,
  apiKeyEvents,
  apiKeysRelations,
  apiKeyUsageRelations,
  apiKeyRateLimitsRelations,
  apiKeyEventsRelations,
};

// Types for TypeScript
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type ApiKeyUsage = typeof apiKeyUsage.$inferSelect;
export type NewApiKeyUsage = typeof apiKeyUsage.$inferInsert;
export type ApiKeyRateLimit = typeof apiKeyRateLimits.$inferSelect;
export type NewApiKeyRateLimit = typeof apiKeyRateLimits.$inferInsert;
export type ApiKeyEvent = typeof apiKeyEvents.$inferSelect;
export type NewApiKeyEvent = typeof apiKeyEvents.$inferInsert;

// Permission constants
export const API_PERMISSIONS = {
  READ: 'read',
  WRITE: 'write',
  ADMIN: 'admin',
} as const;

// Rate limit tiers
export const RATE_LIMIT_TIERS = {
  BASIC: 'basic',
  STANDARD: 'standard',
  PREMIUM: 'premium',
  ENTERPRISE: 'enterprise',
} as const;

// Event types
export const API_KEY_EVENTS = {
  CREATED: 'created',
  UPDATED: 'updated',
  REVOKED: 'revoked',
  REGENERATED: 'regenerated',
  USED: 'used',
  EXPIRED: 'expired',
  RATE_LIMITED: 'rate_limited',
} as const;
