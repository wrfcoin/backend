/**
 * Community Forecast Competition Routes — #251
 *
 * GET /api/competitions/current          — current open competition
 * GET /api/competitions/:id/leaderboard  — ranked scores
 */

import { Router, Request, Response } from 'express';
import { eq, asc, desc } from 'drizzle-orm';
import { db } from '../../database/connection.js';
import {
  competitions,
  competitionScores,
  COMPETITION_STATUS,
} from '../../shared/schema-engagement.js';

const router = Router();

router.get('/current', async (req: Request, res: Response) => {
  try {
    const openRows = await db
      .select()
      .from(competitions)
      .where(eq(competitions.status, COMPETITION_STATUS.OPEN))
      .orderBy(desc(competitions.createdAt))
      .limit(1);

    if (openRows.length === 0) {
      // Fall back to most recent
      const recent = await db
        .select()
        .from(competitions)
        .orderBy(desc(competitions.createdAt))
        .limit(1);

      if (recent.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No competitions found',
          timestamp: new Date().toISOString(),
        });
      }

      return res.json({
        success: true,
        data: recent[0],
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      success: true,
      data: openRows[0],
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
});

router.get('/:id/leaderboard', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const compRows = await db
      .select()
      .from(competitions)
      .where(eq(competitions.id, id))
      .limit(1);

    if (compRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Competition not found' });
    }

    const scores = await db
      .select()
      .from(competitionScores)
      .where(eq(competitionScores.competitionId, id))
      .orderBy(asc(competitionScores.rank));

    return res.json({
      success: true,
      data: {
        competition: compRows[0],
        leaderboard: scores.map((s, idx) => ({
          rank: s.rank ?? idx + 1,
          userAddress: s.userAddress,
          score: s.score,
          prizeAmountWrf: s.prizeAmountWrf,
          submittedAt: s.submittedAt,
        })),
        total: scores.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
