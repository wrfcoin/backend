/**
 * Forecast Duel Arena Schema
 * Issue #228 — competitive forecast staking
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
} from 'drizzle-orm/pg-core';

export const DUEL_STATUS = {
  PENDING: 'pending',   // created, waiting for opponent to join
  ACTIVE: 'active',     // both joined, deadline not yet passed
  RESOLVED: 'resolved', // winner determined
  EXPIRED: 'expired',   // deadline passed, no winner (stake returned)
} as const;

export type DuelStatus = (typeof DUEL_STATUS)[keyof typeof DUEL_STATUS];

export const forecastDuels = pgTable(
  'forecast_duels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    challenger: varchar('challenger', { length: 255 }).notNull(),  // wallet address
    opponent: varchar('opponent', { length: 255 }),                // null until joined
    targetMetric: varchar('target_metric', { length: 100 }).notNull(), // e.g. 'temperature_c'
    targetValue: integer('target_value').notNull(),                // predicted value (scaled ×100)
    stakeAmount: integer('stake_amount').notNull(),                // WRF tokens (smallest unit)
    deadline: timestamp('deadline').notNull(),
    winner: varchar('winner', { length: 255 }),                   // wallet address of winner
    status: varchar('status', { length: 20 }).notNull().default(DUEL_STATUS.PENDING),
    resolvedAt: timestamp('resolved_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  table => ({
    challengerIdx: index('forecast_duels_challenger_idx').on(table.challenger),
    opponentIdx: index('forecast_duels_opponent_idx').on(table.opponent),
    statusIdx: index('forecast_duels_status_idx').on(table.status),
    deadlineIdx: index('forecast_duels_deadline_idx').on(table.deadline),
  })
);

export type ForecastDuel = typeof forecastDuels.$inferSelect;
export type NewForecastDuel = typeof forecastDuels.$inferInsert;
