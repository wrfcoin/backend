import express from 'express';
import { ROLES, earningsEnabled, defaultEarningsSource, type EarningsSource, type Role, type Period } from '../services/chain-rewards/earnings.js';
import { peekWalletSubject } from '../middleware/authMiddleware.js';
import { profileKeyFor } from '../utils/contributor-alias.js';

export function createEarningsRouter(source: EarningsSource = defaultEarningsSource()) {
  const router = express.Router();
  router.get('/leaderboard', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!earningsEnabled()) return res.status(503).json({ error: { code: 'EARNINGS_DISABLED' } });
    const q = new URL(req.originalUrl, 'http://localhost').searchParams;
    if ([...q.keys()].join(',') !== 'role,period,limit' || !ROLES.includes(q.get('role') as Role) ||
      !['all', '7d', '30d'].includes(q.get('period')!) || !/^([1-9]|[12][0-9]|30)$/.test(q.get('limit')!))
      return res.status(400).json({ error: { code: 'INVALID_EARNINGS_QUERY' } });
    try {
      const body = await source.leaderboard(q.get('role') as Role, q.get('period') as Period, Number(q.get('limit')));
      const own = peekWalletSubject(req); const key = own ? profileKeyFor(own) : null;
      return res.json({ success: true, ...body, rows: body.rows.map((r: any) => ({ ...r, isYou: key !== null && r.profileKey === key })) });
    } catch { return res.status(503).json({ error: { code: 'EARNINGS_UNAVAILABLE' } }); }
  });
  return router;
}
export default createEarningsRouter();
