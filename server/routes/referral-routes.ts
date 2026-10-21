/**
 * Referral Routes — #248, mounted on the live API by backend#1178
 *
 * POST /api/referrals/generate      — create (or return) the caller's referral code
 * GET  /api/referrals/stats/:wallet — referral counts for a wallet
 * POST /api/referrals/activate      — the referee attributes itself to a code
 *
 * Both mutators require a wallet login token (Authorization: Bearer, issued by
 * /api/wallet-auth) whose `address` claim is the wallet the request acts for:
 * the referrer for /generate, the referee for /activate.
 *
 * No referral reward is paid. There is no on-chain referral payout, so an
 * activation is recorded as `activated` with no reward amount, and every
 * response says so (`reward.state = 'not_paid'`). It used to write
 * `status: rewarded, rewardAmountWrf: 100` with nothing behind it.
 */

import { Router, Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../../database/connection.js';
import {
  referrals,
  REFERRAL_STATUS,
} from '../../shared/schema-engagement.js';
import { recordReferralFunnelStep } from '../utils/metrics.js';
import { createApiError } from '../utils/api-error.js';
import { appLogger } from '../utils/logger.js';
import { authenticateToken } from '../middleware/auth-middleware.js';
import { normalizeOwnerAddress } from '../services/owner-address.js';

const router = Router();

/** Reported on every response that could otherwise be read as a payout. */
export const REFERRAL_REWARD_NOT_PAID = {
  state: 'not_paid',
  reason: 'no on-chain referral payout exists',
} as const;

type WalletRequest = Request & { user?: { address?: string } };

/**
 * 403 unless the verified token's wallet is `claimed`. Case-insensitive, the
 * same canonical form as owner addresses (backend#1210).
 */
function callerIs(req: WalletRequest, claimed: string): boolean {
  const tokenAddress = req.user?.address;
  if (!tokenAddress || tokenAddress === 'unknown') return false;
  return normalizeOwnerAddress(tokenAddress) === normalizeOwnerAddress(claimed);
}

function forbidden(res: Response, which: string) {
  return res
    .status(403)
    .json(
      createApiError(
        'REFERRAL_WALLET_MISMATCH',
        `The authenticated wallet is not the ${which} in the request`,
      ),
    );
}

const requireWalletToken = (req: Request, res: Response, next: NextFunction) =>
  authenticateToken(req, res, next);

function generateCode(): string {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

router.post('/generate', requireWalletToken, async (req: WalletRequest, res: Response) => {
  try {
    const { walletAddress: rawWallet } = (req.body ?? {}) as { walletAddress?: string };
    if (!rawWallet || typeof rawWallet !== 'string' || !rawWallet.trim()) {
      return res
        .status(400)
        .json(
          createApiError(
            'MISSING_WALLET_ADDRESS',
            'walletAddress required',
          ),
        );
    }
    if (!callerIs(req, rawWallet)) return forbidden(res, 'referrer');
    const walletAddress = normalizeOwnerAddress(rawWallet);

    // Idempotent — return existing pending code if one exists
    const existing = await db
      .select()
      .from(referrals)
      .where(and(
        eq(referrals.referrerAddress, walletAddress),
        eq(referrals.status, REFERRAL_STATUS.PENDING)
      ))
      .limit(1);

    if (existing.length > 0) {
      return res.json({
        success: true,
        data: { referralCode: existing[0].referralCode },
        timestamp: new Date().toISOString(),
      });
    }

    const referralCode = generateCode();
    await db.insert(referrals).values({
      referralCode,
      referrerAddress: walletAddress,
      status: REFERRAL_STATUS.PENDING,
    });

    recordReferralFunnelStep('code_generated');

    return res.status(201).json({
      success: true,
      data: { referralCode },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    appLogger.error('Referral code generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res
      .status(500)
      .json(
        createApiError(
          'REFERRAL_CODE_GENERATION_FAILED',
          'Failed to generate referral code',
        ),
      );
  }
});

router.get('/stats/:walletAddress', async (req: Request, res: Response) => {
  try {
    const walletAddress = normalizeOwnerAddress(req.params.walletAddress);

    const rows = await db
      .select()
      .from(referrals)
      .where(eq(referrals.referrerAddress, walletAddress));

    const byStatus = rows.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return res.json({
      success: true,
      data: {
        walletAddress,
        totalReferrals: rows.length,
        byStatus,
        // Activations that would earn a reward if a payout existed.
        pendingActivations: byStatus[REFERRAL_STATUS.ACTIVATED] ?? 0,
        // Nothing is paid (see REFERRAL_REWARD_NOT_PAID); never sum a
        // recorded amount into an "earned" figure.
        earnedWrf: 0,
        totalRewardsWrf: 0,
        reward: REFERRAL_REWARD_NOT_PAID,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    appLogger.error('Referral stats fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res
      .status(500)
      .json(createApiError('REFERRAL_STATS_FETCH_FAILED', 'Failed to fetch referral stats'));
  }
});

router.post('/activate', requireWalletToken, async (req: WalletRequest, res: Response) => {
  try {
    // The mobile client sends `refereeAddress`; the web client sends
    // `walletAddress`. Both name the referee — the caller.
    const body = (req.body ?? {}) as {
      referralCode?: string;
      refereeAddress?: string;
      walletAddress?: string;
    };
    const referralCode = body.referralCode;
    const rawReferee = body.refereeAddress ?? body.walletAddress;

    if (!referralCode || typeof referralCode !== 'string'
      || !rawReferee || typeof rawReferee !== 'string' || !rawReferee.trim()) {
      return res.status(400).json(
        createApiError(
          'MISSING_REFERRAL_ACTIVATION_FIELDS',
          'referralCode and refereeAddress required',
        ),
      );
    }
    if (!callerIs(req, rawReferee)) return forbidden(res, 'referee');
    const refereeAddress = normalizeOwnerAddress(rawReferee);

    const rows = await db
      .select()
      .from(referrals)
      .where(and(
        eq(referrals.referralCode, referralCode),
        eq(referrals.status, REFERRAL_STATUS.PENDING)
      ))
      .limit(1);

    if (rows.length === 0) {
      return res.status(404).json(
        createApiError(
          'REFERRAL_CODE_NOT_FOUND_OR_ACTIVATED',
          'Referral code not found or already activated',
        ),
      );
    }

    if (normalizeOwnerAddress(rows[0].referrerAddress) === refereeAddress) {
      return res
        .status(400)
        .json(createApiError('SELF_REFERRAL_NOT_ALLOWED', 'Self-referral not allowed'));
    }

    // Conditional on still-pending so two concurrent activations cannot both
    // claim the code. No reward amount and no rewarded timestamp; nothing is paid.
    const now = new Date();
    const updated = await db
      .update(referrals)
      .set({
        refereeAddress,
        status: REFERRAL_STATUS.ACTIVATED,
        rewardAmountWrf: null,
        activatedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(referrals.referralCode, referralCode),
        eq(referrals.status, REFERRAL_STATUS.PENDING)
      ))
      .returning({ id: referrals.id });

    if (updated.length === 0) {
      return res.status(404).json(
        createApiError(
          'REFERRAL_CODE_NOT_FOUND_OR_ACTIVATED',
          'Referral code not found or already activated',
        ),
      );
    }

    recordReferralFunnelStep('activated');

    return res.json({
      success: true,
      data: {
        referralCode,
        status: REFERRAL_STATUS.ACTIVATED,
        rewardAmountWrf: null,
        reward: REFERRAL_REWARD_NOT_PAID,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    appLogger.error('Referral activation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res
      .status(500)
      .json(createApiError('REFERRAL_ACTIVATION_FAILED', 'Failed to activate referral code'));
  }
});

// Anything else under /api/referrals is a 404 from this router, not a fall
// through to the entrypoint's token-gated catch-all (whose 401 would hide
// whether the router is mounted at all).
router.use((_req: Request, res: Response) => {
  res.status(404).json(createApiError('NOT_FOUND', 'Unknown referrals endpoint'));
});

export default router;
