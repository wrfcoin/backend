/**
 * Seasonal Challenge Routes — #249
 *
 * GET  /api/challenges/active      — active challenges (now between start_date and end_date)
 * POST /api/challenges/:id/claim   — claim reward if earned
 */

import { Router, Request, Response } from 'express';
import { eq, and, lte, gte, sql } from 'drizzle-orm';
import { db } from '../../database/connection.js';
import {
  challenges,
  challengeParticipants,
} from '../../shared/schema-engagement.js';

const router = Router();

router.get('/active', async (req: Request, res: Response) => {
  try {
    const now = new Date();

    const active = await db
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.isActive, true),
          lte(challenges.startDate, now),
          gte(challenges.endDate, now)
        )
      );

    return res.json({
      success: true,
      data: active,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
});

router.post('/:id/claim', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userAddress } = req.body as { userAddress?: string };

    if (!userAddress) {
      return res.status(400).json({ success: false, error: 'userAddress required' });
    }

    const challengeRows = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, id))
      .limit(1);

    if (challengeRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Challenge not found' });
    }

    const challenge = challengeRows[0];
    const now = new Date();
    if (now < challenge.endDate) {
      return res.status(400).json({ success: false, error: 'Challenge has not ended yet' });
    }

    const participants = await db
      .select()
      .from(challengeParticipants)
      .where(
        and(
          eq(challengeParticipants.challengeId, id),
          eq(challengeParticipants.userAddress, userAddress)
        )
      )
      .limit(1);

    if (participants.length === 0) {
      return res.status(404).json({ success: false, error: 'No participation record found' });
    }

    const participant = participants[0];
    if (participant.rewardClaimed) {
      return res.status(400).json({ success: false, error: 'Reward already claimed' });
    }

    const criteria = challenge.criteria as { minReadings?: number } | null;
    const minReadings = criteria?.minReadings ?? 1;
    if (participant.readingsCount < minReadings) {
      return res.status(400).json({
        success: false,
        error: `Need ${minReadings} readings to claim (have ${participant.readingsCount})`,
      });
    }

    await db
      .update(challengeParticipants)
      .set({ rewardClaimed: true, claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(challengeParticipants.challengeId, id),
          eq(challengeParticipants.userAddress, userAddress)
        )
      );

    const rewardWrf = challenge.bonusMultiplier * 50; // base 50 WRF × multiplier

    return res.json({
      success: true,
      data: { challengeId: id, userAddress, rewardAmountWrf: rewardWrf },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
