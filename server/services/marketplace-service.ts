/**
 * Marketplace Service — tiered API key subscriptions and daily usage tracking
 * Issue #250
 */

import * as crypto from 'crypto';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../database/connection.js';
import {
  marketplaceSubscriptions,
  marketplaceUsage,
  MARKETPLACE_TIERS,
  TIER_DAILY_LIMITS,
  type MarketplaceTier,
  type MarketplaceSubscription,
} from '../../shared/schema-marketplace.js';

export interface SubscribeResult {
  success: boolean;
  apiKey?: string;
  tier?: MarketplaceTier;
  dailyLimit?: number;
  error?: string;
}

export interface UsageSummary {
  tier: MarketplaceTier;
  dailyLimit: number;
  requestsToday: number;
  remainingToday: number;
  apiKeyPrefix: string;
}

function generateMarketplaceKey(): string {
  return 'wrf_mkt_' + crypto.randomBytes(24).toString('base64url');
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export class MarketplaceService {
  async subscribe(userId: string, tier: MarketplaceTier): Promise<SubscribeResult> {
    // Upsert: upgrade/downgrade existing subscription or create new one
    const apiKey = generateMarketplaceKey();

    const existing = await db
      .select()
      .from(marketplaceSubscriptions)
      .where(eq(marketplaceSubscriptions.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(marketplaceSubscriptions)
        .set({ tier, updatedAt: new Date() })
        .where(eq(marketplaceSubscriptions.userId, userId));

      const updated = await db
        .select()
        .from(marketplaceSubscriptions)
        .where(eq(marketplaceSubscriptions.userId, userId))
        .limit(1);

      return {
        success: true,
        apiKey: updated[0].apiKey,
        tier,
        dailyLimit: TIER_DAILY_LIMITS[tier],
      };
    }

    await db.insert(marketplaceSubscriptions).values({
      userId,
      tier,
      apiKey,
    });

    return {
      success: true,
      apiKey,
      tier,
      dailyLimit: TIER_DAILY_LIMITS[tier],
    };
  }

  async getUsage(userId: string): Promise<UsageSummary | null> {
    const subs = await db
      .select()
      .from(marketplaceSubscriptions)
      .where(and(
        eq(marketplaceSubscriptions.userId, userId),
        eq(marketplaceSubscriptions.isActive, true)
      ))
      .limit(1);

    if (subs.length === 0) return null;

    const sub = subs[0];
    const today = todayUTC();

    const usageRows = await db
      .select()
      .from(marketplaceUsage)
      .where(and(
        eq(marketplaceUsage.subscriptionId, sub.id),
        eq(marketplaceUsage.date, today)
      ))
      .limit(1);

    const requestsToday = usageRows[0]?.requestCount ?? 0;
    const dailyLimit = TIER_DAILY_LIMITS[sub.tier as MarketplaceTier];
    const remainingToday = dailyLimit < 0 ? -1 : Math.max(0, dailyLimit - requestsToday);

    return {
      tier: sub.tier as MarketplaceTier,
      dailyLimit,
      requestsToday,
      remainingToday,
      apiKeyPrefix: sub.apiKey.slice(0, 16) + '...',
    };
  }

  /**
   * Increment usage counter and enforce daily rate limit.
   * Returns false if the key is over its daily limit.
   */
  async checkAndRecord(apiKey: string): Promise<{ allowed: boolean; tier?: MarketplaceTier }> {
    const subs = await db
      .select()
      .from(marketplaceSubscriptions)
      .where(and(
        eq(marketplaceSubscriptions.apiKey, apiKey),
        eq(marketplaceSubscriptions.isActive, true)
      ))
      .limit(1);

    if (subs.length === 0) return { allowed: false };

    const sub = subs[0];
    const tier = sub.tier as MarketplaceTier;
    const dailyLimit = TIER_DAILY_LIMITS[tier];
    const today = todayUTC();

    if (dailyLimit > 0) {
      // Get or create today's usage row
      const rows = await db
        .select()
        .from(marketplaceUsage)
        .where(and(
          eq(marketplaceUsage.subscriptionId, sub.id),
          eq(marketplaceUsage.date, today)
        ))
        .limit(1);

      const count = rows[0]?.requestCount ?? 0;
      if (count >= dailyLimit) return { allowed: false, tier };
    }

    // Upsert usage counter
    await db
      .insert(marketplaceUsage)
      .values({ subscriptionId: sub.id, date: today, requestCount: 1 })
      .onConflictDoUpdate({
        target: [marketplaceUsage.subscriptionId, marketplaceUsage.date],
        set: {
          requestCount: sql`${marketplaceUsage.requestCount} + 1`,
          updatedAt: new Date(),
        },
      });

    return { allowed: true, tier };
  }
}

export const marketplaceService = new MarketplaceService();
