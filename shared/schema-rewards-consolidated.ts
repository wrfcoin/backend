/**
 * Consolidated Rewards Schema
 * Simplified from 12 tables to 4 optimized tables
 */

import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  numeric,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enums for type safety
export const difficultyEnum = pgEnum('difficulty', [
  'COMMON',
  'RARE',
  'EPIC',
  'LEGENDARY',
]);
export const rarityEnum = pgEnum('rarity', [
  'common',
  'rare',
  'epic',
  'legendary',
]);
export const progressStatusEnum = pgEnum('progress_status', [
  'in_progress',
  'completed',
  'claimed',
]);
export const rewardTypeEnum = pgEnum('reward_type', [
  'mining',
  'validation',
  'contribution',
]);
export const rewardStatusEnum = pgEnum('reward_status', [
  'pending',
  'distributed',
  'claimed',
]);
export const configCategoryEnum = pgEnum('config_category', [
  'distribution',
  'rates',
  'limits',
  'tracking',
]);

// Table 1: Unified achievements (replaces achievements, achievement_categories, miner_achievements)
export const achievementsConsolidated = pgTable('achievements_consolidated', {
  id: serial('id').primaryKey(),
  achievementId: varchar('achievement_id', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description').notNull(),
  category: varchar('category', { length: 50 }).notNull(),
  subcategory: varchar('subcategory', { length: 50 }),
  iconUrl: varchar('icon_url', { length: 255 }),
  difficulty: varchar('difficulty', { length: 20 }).notNull().default('COMMON'),
  rarity: varchar('rarity', { length: 20 }).default('common'),
  points: integer('points').notNull().default(10),
  governanceMultiplier: numeric('governance_multiplier', {
    precision: 10,
    scale: 2,
  }).default('1.0'),
  reputationMultiplier: numeric('reputation_multiplier', {
    precision: 10,
    scale: 2,
  }).default('1.0'),
  requirements: jsonb('requirements').notNull(),
  rewards: jsonb('rewards'),
  isActive: boolean('is_active').notNull().default(true),
  isSoulbound: boolean('is_soulbound').default(false),
  displayOrder: integer('display_order').default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  categoryIdx: index('idx_achievements_consolidated_category').on(table.category),
  isActiveIdx: index('idx_achievements_consolidated_active').on(table.isActive),
  difficultyIdx: index('idx_achievements_consolidated_difficulty').on(table.difficulty),
}));

// Table 2: Unified user progress (replaces achievement_progress, user_achievements, miner_achievement_progress, miner_earned_achievements)
export const userProgressConsolidated = pgTable('user_progress_consolidated', {
  id: serial('id').primaryKey(),
  userAddress: varchar('user_address', { length: 64 }).notNull(),
  achievementId: varchar('achievement_id', { length: 64 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('in_progress'),
  currentValue: integer('current_value').default(0),
  targetValue: integer('target_value'),
  percentageComplete: integer('percentage_complete').default(0),
  progressData: jsonb('progress_data'),
  evidenceData: jsonb('evidence_data'),
  completedAt: timestamp('completed_at'),
  claimedAt: timestamp('claimed_at'),
  transactionId: varchar('transaction_id', { length: 64 }),
  isVisible: boolean('is_visible').default(true),
  lastUpdated: timestamp('last_updated').notNull().defaultNow(),
}, (table) => ({
  userAddressIdx: index('idx_user_progress_consolidated_user').on(table.userAddress),
  achievementIdx: index('idx_user_progress_consolidated_achievement').on(table.achievementId),
  statusIdx: index('idx_user_progress_consolidated_status').on(table.status),
  userAchievementIdx: index('idx_user_progress_consolidated_user_achievement').on(table.userAddress, table.achievementId),
}));

// Table 3: Unified token rewards (replaces mining_rewards, validator_rewards, contributor_rewards)
export const tokenRewardsConsolidated = pgTable('token_rewards_consolidated', {
  id: serial('id').primaryKey(),
  rewardId: varchar('reward_id', { length: 64 }).notNull().unique(),
  userAddress: varchar('user_address', { length: 64 }).notNull(),
  rewardType: varchar('reward_type', { length: 20 }).notNull(),
  amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
  tokenSymbol: varchar('token_symbol', { length: 10 }).default('WRF'),
  sourceType: varchar('source_type', { length: 50 }),
  sourceId: varchar('source_id', { length: 64 }),
  transactionId: varchar('transaction_id', { length: 64 }),
  blockHeight: integer('block_height'),
  achievementId: varchar('achievement_id', { length: 64 }),
  metadata: jsonb('metadata'),
  status: varchar('status', { length: 20 }).default('pending'),
  distributedAt: timestamp('distributed_at'),
  claimedAt: timestamp('claimed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  userAddressIdx: index('idx_token_rewards_consolidated_user').on(table.userAddress),
  rewardTypeIdx: index('idx_token_rewards_consolidated_type').on(table.rewardType),
  statusIdx: index('idx_token_rewards_consolidated_status').on(table.status),
  blockHeightIdx: index('idx_token_rewards_consolidated_block').on(table.blockHeight),
  createdAtIdx: index('idx_token_rewards_consolidated_created').on(table.createdAt),
}));

// Table 4: System configuration (replaces reward_distribution_config, mining_contributions tracking)
export const systemConfigConsolidated = pgTable('system_config_consolidated', {
  id: serial('id').primaryKey(),
  configKey: varchar('config_key', { length: 50 }).notNull().unique(),
  configValue: jsonb('config_value').notNull(),
  category: varchar('category', { length: 30 }).notNull(),
  description: text('description'),
  isActive: boolean('is_active').default(true),
  lastUpdated: timestamp('last_updated').notNull().defaultNow(),
  updatedBy: varchar('updated_by', { length: 64 }),
}, (table) => ({
  categoryIdx: index('idx_system_config_consolidated_category').on(table.category),
  isActiveIdx: index('idx_system_config_consolidated_active').on(table.isActive),
}));

// Relations
export const achievementsConsolidatedRelations = relations(
  achievementsConsolidated,
  ({ many }) => ({
    userProgress: many(userProgressConsolidated),
    tokenRewards: many(tokenRewardsConsolidated),
  })
);

export const userProgressConsolidatedRelations = relations(
  userProgressConsolidated,
  ({ one }) => ({
    achievement: one(achievementsConsolidated, {
      fields: [userProgressConsolidated.achievementId],
      references: [achievementsConsolidated.achievementId],
    }),
  })
);

export const tokenRewardsConsolidatedRelations = relations(
  tokenRewardsConsolidated,
  ({ one }) => ({
    achievement: one(achievementsConsolidated, {
      fields: [tokenRewardsConsolidated.achievementId],
      references: [achievementsConsolidated.achievementId],
    }),
  })
);

// Export all consolidated tables
export const rewardsConsolidatedSchema = {
  achievementsConsolidated,
  userProgressConsolidated,
  tokenRewardsConsolidated,
  systemConfigConsolidated,
};
