/**
 * Marketplace & Academic Partnership Schema
 * Issues #250 and #252
 */

import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  uuid,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Marketplace tier definitions
export const MARKETPLACE_TIERS = {
  FREE: 'free',
  PRO: 'pro',
  ENTERPRISE: 'enterprise',
} as const;

export type MarketplaceTier = (typeof MARKETPLACE_TIERS)[keyof typeof MARKETPLACE_TIERS];

export const TIER_DAILY_LIMITS: Record<MarketplaceTier, number> = {
  free: 100,
  pro: 10_000,
  enterprise: -1, // unlimited
};

// Academic application states
export const ACADEMIC_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

export type AcademicStatus = (typeof ACADEMIC_STATUS)[keyof typeof ACADEMIC_STATUS];

// Marketplace subscriptions — one active subscription per user
export const marketplaceSubscriptions = pgTable(
  'marketplace_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tier: varchar('tier', { length: 20 }).notNull().default(MARKETPLACE_TIERS.FREE),
    apiKey: varchar('api_key', { length: 128 }).notNull().unique(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    userIdIdx: uniqueIndex('marketplace_subscriptions_user_id_idx').on(table.userId),
    apiKeyIdx: uniqueIndex('marketplace_subscriptions_api_key_idx').on(table.apiKey),
  })
);

// Daily usage counters per API key (reset each UTC day)
export const marketplaceUsage = pgTable(
  'marketplace_usage',
  {
    id: serial('id').primaryKey(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => marketplaceSubscriptions.id, { onDelete: 'cascade' }),
    date: varchar('date', { length: 10 }).notNull(), // YYYY-MM-DD
    requestCount: integer('request_count').notNull().default(0),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    subDateIdx: uniqueIndex('marketplace_usage_sub_date_idx').on(
      table.subscriptionId,
      table.date
    ),
  })
);

// Academic partnership applications
export const academicApplications = pgTable(
  'academic_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    institution: varchar('institution', { length: 255 }).notNull(),
    researchDescription: text('research_description').notNull(),
    status: varchar('status', { length: 20 }).notNull().default(ACADEMIC_STATUS.PENDING),
    // auto-provisioned API key on approval
    provisionedApiKey: varchar('provisioned_api_key', { length: 128 }),
    reviewedAt: timestamp('reviewed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    userIdIdx: index('academic_applications_user_id_idx').on(table.userId),
    statusIdx: index('academic_applications_status_idx').on(table.status),
    emailIdx: uniqueIndex('academic_applications_email_idx').on(table.email),
  })
);

export type MarketplaceSubscription = typeof marketplaceSubscriptions.$inferSelect;
export type NewMarketplaceSubscription = typeof marketplaceSubscriptions.$inferInsert;
export type MarketplaceUsage = typeof marketplaceUsage.$inferSelect;
export type AcademicApplication = typeof academicApplications.$inferSelect;
export type NewAcademicApplication = typeof academicApplications.$inferInsert;
