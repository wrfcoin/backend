/**
 * Forecast Duel Arena Routes
 * Issue #228
 *
 * POST /api/duels/create     — create a new forecast duel
 * POST /api/duels/:id/join   — opponent joins duel
 * GET  /api/duels/:id/result — get duel outcome
 */

import { Router, Request, Response } from 'express';
import { forecastDuelService } from '../services/forecast-duel-service.js';

const router = Router();

router.post('/create', async (req: Request, res: Response) => {
  try {
    const {
      challenger,
      targetMetric,
      targetValue,
      stakeAmount,
      deadlineMs,
    } = req.body as {
      challenger?: string;
      targetMetric?: string;
      targetValue?: number;
      stakeAmount?: number;
      deadlineMs?: number;
    };

    if (!challenger || !targetMetric || targetValue == null || stakeAmount == null || !deadlineMs) {
      return res.status(400).json({
        success: false,
        error: 'challenger, targetMetric, targetValue, stakeAmount, and deadlineMs are required',
      });
    }
    if (stakeAmount <= 0) {
      return res.status(400).json({ success: false, error: 'stakeAmount must be positive' });
    }

    const duel = await forecastDuelService.create({
      challenger,
      targetMetric,
      targetValue,
      stakeAmount,
      deadlineMs,
    });

    return res.status(201).json({
      success: true,
      data: duel,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

router.post('/:id/join', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { opponent } = req.body as { opponent?: string };

    if (!opponent) {
      return res.status(400).json({ success: false, error: 'opponent wallet address required' });
    }

    const duel = await forecastDuelService.join({ duelId: id, opponent });

    return res.json({
      success: true,
      data: duel,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

router.get('/:id/result', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await forecastDuelService.getResult(id);

    if (!result) {
      return res.status(404).json({ success: false, error: 'Duel not found' });
    }

    return res.json({
      success: true,
      data: result,
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
