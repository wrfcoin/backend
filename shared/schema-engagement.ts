/**
 * Community Engagement Schema
 * Issues #248 (referrals), #249 (challenges), #251 (competitions)
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

// ── #248 Referral Rewards ──────────────────────────────────────────────────

export const REFERRAL_STATUS = {
  PENDING: 'pending',
  ACTIVATED: 'activated',
  REWARDED: 'rewarded',
} as const;

export const referrals = pgTable(
  'referrals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referralCode: varchar('referral_code', { length: 32 }).notNull().unique(),
    referrerAddress: varchar('referrer_address', { length: 255 }).notNull(),
    refereeAddress: varchar('referee_address', { length: 255 }),
    status: varchar('status', { length: 20 }).notNull().default(REFERRAL_STATUS.PENDING),
    rewardAmountWrf: integer('reward_amount_wrf').default(0),
    activatedAt: timestamp('activated_at'),
    rewardedAt: timestamp('rewarded_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    codeIdx: uniqueIndex('referrals_code_idx').on(table.referralCode),
    referrerIdx: index('referrals_referrer_idx').on(table.referrerAddress),
    refereeIdx: index('referrals_referee_idx').on(table.refereeAddress),
    statusIdx: index('referrals_status_idx').on(table.status),
  })
);

// ── #249 Seasonal Challenges ───────────────────────────────────────────────

export const challenges = pgTable(
  'challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    startDate: timestamp('start_date').notNull(),
    endDate: timestamp('end_date').notNull(),
    bonusMultiplier: integer('bonus_multiplier').notNull().default(1), // ×N reward multiplier
    criteria: jsonb('criteria').notNull().default({}), // e.g. { minReadings: 10, metric: 'temperature_c' }
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    dateRangeIdx: index('challenges_date_range_idx').on(table.startDate, table.endDate),
    isActiveIdx: index('challenges_is_active_idx').on(table.isActive),
  })
);

export const challengeParticipants = pgTable(
  'challenge_participants',
  {
    id: serial('id').primaryKey(),
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id, { onDelete: 'cascade' }),
    userAddress: varchar('user_address', { length: 255 }).notNull(),
    readingsCount: integer('readings_count').notNull().default(0),
    rewardClaimed: boolean('reward_claimed').notNull().default(false),
    claimedAt: timestamp('claimed_at'),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    challengeUserIdx: uniqueIndex('challenge_participants_challenge_user_idx').on(
      table.challengeId,
      table.userAddress
    ),
  })
);

// ── #251 Community Forecast Competitions ──────────────────────────────────

export const COMPETITION_STATUS = {
  OPEN: 'open',
  SCORING: 'scoring',
  CLOSED: 'closed',
} as const;

export const competitions = pgTable(
  'competitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 255 }).notNull(),
    weekLabel: varchar('week_label', { length: 20 }).notNull(), // e.g. '2026-W14'
    submissionDeadline: timestamp('submission_deadline').notNull(),
    verificationDeadline: timestamp('verification_deadline').notNull(),
    status: varchar('status', { length: 20 }).notNull().default(COMPETITION_STATUS.OPEN),
    scoringMethod: varchar('scoring_method', { length: 50 }).notNull().default('mae'), // mean absolute error
    prizes: jsonb('prizes').notNull().default([]),  // [{ rank: 1, amountWrf: 1000 }, ...]
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => ({
    statusIdx: index('competitions_status_idx').on(table.status),
    weekIdx: uniqueIndex('competitions_week_label_idx').on(table.weekLabel),
  })
);

export const competitionScores = pgTable(
  'competition_scores',
  {
    id: serial('id').primaryKey(),
    competitionId: uuid('competition_id')
      .notNull()
      .references(() => competitions.id, { onDelete: 'cascade' }),
    userAddress: varchar('user_address', { length: 255 }).notNull(),
    forecastData: jsonb('forecast_data').notNull().default({}),
    score: integer('score'),          // lower = better for MAE (×100 scaled)
    rank: integer('rank'),
    prizeAmountWrf: integer('prize_amount_wrf').default(0),
    submittedAt: timestamp('submitted_at').notNull().defaultNow(),
  },
  table => ({
    compUserIdx: uniqueIndex('competition_scores_comp_user_idx').on(
      table.competitionId,
      table.userAddress
    ),
    rankIdx: index('competition_scores_rank_idx').on(table.competitionId, table.rank),
  })
);

// Types
export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
export type Challenge = typeof challenges.$inferSelect;
export type ChallengeParticipant = typeof challengeParticipants.$inferSelect;
export type Competition = typeof competitions.$inferSelect;
export type CompetitionScore = typeof competitionScores.$inferSelect;
