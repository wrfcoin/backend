/**
 * Forecast Duel Service
 * Issue #228 — competitive forecast staking
 */

import * as crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../../database/connection.js';
import {
  forecastDuels,
  DUEL_STATUS,
  type ForecastDuel,
  type NewForecastDuel,
} from '../../shared/schema-duels.js';

export interface CreateDuelInput {
  challenger: string;
  targetMetric: string;
  targetValue: number;
  stakeAmount: number;
  deadlineMs: number; // unix ms
}

export interface JoinDuelInput {
  duelId: string;
  opponent: string;
}

export interface DuelResult {
  duelId: string;
  status: string;
  winner: string | null;
  challenger: string;
  opponent: string | null;
  targetMetric: string;
  targetValue: number;
  stakeAmount: number;
  deadline: string;
  resolvedAt: string | null;
}

export class ForecastDuelService {
  async create(input: CreateDuelInput): Promise<ForecastDuel> {
    const deadline = new Date(input.deadlineMs);
    if (deadline <= new Date()) {
      throw new Error('Deadline must be in the future');
    }

    const rows = await db
      .insert(forecastDuels)
      .values({
        challenger: input.challenger,
        targetMetric: input.targetMetric,
        targetValue: input.targetValue,
        stakeAmount: input.stakeAmount,
        deadline,
        status: DUEL_STATUS.PENDING,
      })
      .returning();

    return rows[0];
  }

  async join(input: JoinDuelInput): Promise<ForecastDuel> {
    const rows = await db
      .select()
      .from(forecastDuels)
      .where(eq(forecastDuels.id, input.duelId))
      .limit(1);

    if (rows.length === 0) throw new Error('Duel not found');
    const duel = rows[0];

    if (duel.status !== DUEL_STATUS.PENDING) {
      throw new Error(`Duel is not joinable (status: ${duel.status})`);
    }
    if (duel.challenger === input.opponent) {
      throw new Error('Challenger cannot join their own duel');
    }
    if (new Date() > duel.deadline) {
      throw new Error('Duel deadline has passed');
    }

    const updated = await db
      .update(forecastDuels)
      .set({
        opponent: input.opponent,
        status: DUEL_STATUS.ACTIVE,
        updatedAt: new Date(),
      })
      .where(and(eq(forecastDuels.id, input.duelId), eq(forecastDuels.status, DUEL_STATUS.PENDING)))
      .returning();

    if (updated.length === 0) throw new Error('Duel already joined or not found');
    return updated[0];
  }

  async getResult(duelId: string): Promise<DuelResult | null> {
    const rows = await db
      .select()
      .from(forecastDuels)
      .where(eq(forecastDuels.id, duelId))
      .limit(1);

    if (rows.length === 0) return null;
    const d = rows[0];

    return {
      duelId: d.id,
      status: d.status,
      winner: d.winner,
      challenger: d.challenger,
      opponent: d.opponent,
      targetMetric: d.targetMetric,
      targetValue: d.targetValue,
      stakeAmount: d.stakeAmount,
      deadline: d.deadline.toISOString(),
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
    };
  }
}

export const forecastDuelService = new ForecastDuelService();
