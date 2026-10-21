import express, { Router } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { requireOperatorCaller, walletMayOnlyUseOwnAddress } from '../middleware/wallet-ownership.js';
import {
  reputationScoringEngine,
  type ContributorRole,
} from '../services/reputation/reputation-scoring-engine.js';

const router: Router = express.Router();

// All reputation operations require authentication (#231)
router.use(authenticateJWT);
// backend#1297: only an operator (admin or operator role) records events, and reads only its own identity.
router.param('identityDid', walletMayOnlyUseOwnAddress);

function asRole(value: unknown): ContributorRole {
  const normalized = String(value || 'user').toLowerCase();
  const roles: ContributorRole[] = [
    'collector',
    'analyzer',
    'keeper',
    'offsetter',
    'node',
    'coder',
    'user',
  ];
  return roles.includes(normalized as ContributorRole)
    ? (normalized as ContributorRole)
    : 'user';
}

router.post('/events', requireOperatorCaller, async (req, res) => {
  try {
    const address =
      req.body?.address || req.body?.identityDid || req.body?.identityDid?.toLowerCase();

    if (!address) {
      return res.status(400).json({ success: false, error: 'address is required' });
    }

    const event = await reputationScoringEngine.recordSignal({
      address: String(address),
      role: asRole(req.body?.role),
      eventType: String(req.body?.eventType || 'unknown'),
      dataQuality: Number(req.body?.dataQuality ?? req.body?.score ?? 0),
      uptime: Number(req.body?.uptime ?? 0),
      verificationAccuracy: Number(req.body?.verificationAccuracy ?? 0),
      communityContribution: Number(req.body?.communityContribution ?? 0),
      details: req.body?.details,
      occurredAt: req.body?.occurredAt,
    });

    return res.status(201).json({ success: true, reputation: event });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(400).json({ success: false, error: message });
  }
});

router.get('/identities/:identityDid/events', async (req, res) => {
  try {
    const events = await reputationScoringEngine.getEvents(
      String(req.params.identityDid),
      Number(req.query.limit ?? 50)
    );

    return res.status(200).json({
      success: true,
      identityDid: req.params.identityDid,
      events,
      count: events.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(400).json({ success: false, error: message });
  }
});

router.get('/identities/:identityDid/score', async (req, res) => {
  try {
    const reputation = await reputationScoringEngine.getScore(
      String(req.params.identityDid)
    );

    return res.status(200).json({ success: true, reputation });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(400).json({ success: false, error: message });
  }
});

router.get('/rankings', async (req, res) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const rankings = await reputationScoringEngine.getRankings(page, limit);

    return res.status(200).json({
      success: true,
      ...rankings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(400).json({ success: false, error: message });
  }
});

export default router;
