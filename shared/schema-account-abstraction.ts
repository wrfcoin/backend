import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * Account Abstraction Schema
 *
 * This file defines the database schema for account abstraction in the Wrfcoin ecosystem.
 * It includes tables for users, delegations, and sponsors to enable transaction delegation and gas
 * sponsorship for cross-chain operations.
 */

// User accounts
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  walletAddress: varchar('wallet_address', { length: 100 }).notNull(),
  email: varchar('email', { length: 100 }),
  profileImageUrl: varchar('profile_image_url', { length: 255 }),
  bio: text('bio'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastActive: timestamp('last_active'),
  isValidator: boolean('is_validator').default(false),
  nodeRole: varchar('node_role', { length: 50 }),
  contributorType: varchar('contributor_type', { length: 50 }),
  reputationScore: integer('reputation_score').default(0),
  preferencesJson: jsonb('preferences_json'),
});

// Delegated permissions
export const delegations = pgTable('delegations', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  delegatedToAddress: varchar('delegated_to_address', {
    length: 100,
  }).notNull(),
  permissionLevel: varchar('permission_level', { length: 50 }).notNull(),
  isActive: boolean('is_active').default(true),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsed: timestamp('last_used'),
  allowedOperations: jsonb('allowed_operations'),
  maxTransactionValue: varchar('max_transaction_value', { length: 50 }),
  validOnChains: jsonb('valid_on_chains'),
});

// Transaction sponsors
export const sponsors = pgTable('sponsors', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  sponsorAddress: varchar('sponsor_address', { length: 100 }).notNull(),
  sponsorName: varchar('sponsor_name', { length: 100 }),
  dailyLimit: varchar('daily_limit', { length: 50 }),
  totalLimit: varchar('total_limit', { length: 50 }),
  isActive: boolean('is_active').default(true),
  supportedChains: jsonb('supported_chains'),
  whitelistedOperations: jsonb('whitelisted_operations'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at'),
});

// Relationship definitions
export const userRelations = relations(users, ({ many }) => ({
  delegations: many(delegations),
  sponsors: many(sponsors),
}));

export const delegationRelations = relations(delegations, ({ one }) => ({
  user: one(users, {
    fields: [delegations.userId],
    references: [users.id],
  }),
}));

export const sponsorRelations = relations(sponsors, ({ one }) => ({
  user: one(users, {
    fields: [sponsors.userId],
    references: [users.id],
  }),
}));

// Type exports
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export type Delegation = typeof delegations.$inferSelect;
export type InsertDelegation = typeof delegations.$inferInsert;

export type Sponsor = typeof sponsors.$inferSelect;
export type InsertSponsor = typeof sponsors.$inferInsert;
