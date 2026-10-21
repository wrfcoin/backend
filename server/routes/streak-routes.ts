import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { walletMayOnlyUseOwnUserId } from '../middleware/wallet-ownership.js';
import {
  checkInUser,
  getStreakBadges,
  getStreakSummary,
  initializeStreakSchema,
} from '../services/streak-service.js';

const USER_ID_RE = /^[0-9]+$/;

export function createStreakRouter(): express.Router {
  const router = express.Router();
  void initializeStreakSchema().catch(() => undefined);

  // All streak operations require authentication (#231)
  router.use(authenticateJWT);
  // backend#1297: a wallet-login caller may address only its own users row (covers the check-in write).
  router.param('userId', walletMayOnlyUseOwnUserId);

  router.get('/:userId', async (req, res) => {
    const userIdRaw = req.params.userId;
    const tzOffsetRaw = req.query.tzOffsetMinutes;
    if (!USER_ID_RE.test(userIdRaw)) {
      return res.status(400).json({ error: 'userId must be numeric' });
    }

    const userId = Number(userIdRaw);
    const tzOffsetMinutes =
      typeof tzOffsetRaw === 'string' ? Number.parseInt(tzOffsetRaw, 10) : 0;

    try {
      const summary = await getStreakSummary(userId, Number.isNaN(tzOffsetMinutes) ? 0 : tzOffsetMinutes);
      return res.status(200).json(summary);
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/:userId/check-in', async (req, res) => {
    const userIdRaw = req.params.userId;
    if (!USER_ID_RE.test(userIdRaw)) {
      return res.status(400).json({ error: 'userId must be numeric' });
    }

    const userId = Number(userIdRaw);
    const body = req.body ?? {};
    const tzOffsetMinutes = Number.isInteger(body.tzOffsetMinutes)
      ? Number(body.tzOffsetMinutes)
      : 0;

    try {
      const result = await checkInUser(userId, tzOffsetMinutes);
      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/:userId/badges', async (req, res) => {
    const userIdRaw = req.params.userId;
    const tzOffsetRaw = req.query.tzOffsetMinutes;
    if (!USER_ID_RE.test(userIdRaw)) {
      return res.status(400).json({ error: 'userId must be numeric' });
    }

    const userId = Number(userIdRaw);
    const tzOffsetMinutes =
      typeof tzOffsetRaw === 'string' ? Number.parseInt(tzOffsetRaw, 10) : 0;

    try {
      const badges = await getStreakBadges(userId, Number.isNaN(tzOffsetMinutes) ? 0 : tzOffsetMinutes);
      return res.status(200).json(badges);
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default createStreakRouter();
