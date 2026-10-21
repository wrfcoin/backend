/**
 * Marketplace Routes — tiered data API subscriptions
 * Issue #250
 *
 * POST /api/marketplace/subscribe  — create/upgrade subscription
 * GET  /api/marketplace/usage      — daily usage summary
 */

import { Router, Request, Response } from 'express';
import { marketplaceService } from '../services/marketplace-service.js';
import {
  MARKETPLACE_TIERS,
  type MarketplaceTier,
} from '../../shared/schema-marketplace.js';

const router = Router();

const VALID_TIERS = new Set<string>(Object.values(MARKETPLACE_TIERS));

router.post('/subscribe', async (req: Request, res: Response) => {
  try {
    const userId: string | undefined = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { tier } = req.body as { tier?: string };
    if (!tier || !VALID_TIERS.has(tier)) {
      return res.status(400).json({
        success: false,
        error: `Invalid tier. Must be one of: ${[...VALID_TIERS].join(', ')}`,
      });
    }

    const result = await marketplaceService.subscribe(userId, tier as MarketplaceTier);
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    return res.status(201).json({
      success: true,
      data: {
        apiKey: result.apiKey,
        tier: result.tier,
        dailyLimit: result.dailyLimit === -1 ? 'unlimited' : result.dailyLimit,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

router.get('/usage', async (req: Request, res: Response) => {
  try {
    const userId: string | undefined = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const usage = await marketplaceService.getUsage(userId);
    if (!usage) {
      return res.status(404).json({
        success: false,
        error: 'No active marketplace subscription found',
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      success: true,
      data: {
        ...usage,
        dailyLimit: usage.dailyLimit === -1 ? 'unlimited' : usage.dailyLimit,
        remainingToday: usage.remainingToday === -1 ? 'unlimited' : usage.remainingToday,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
