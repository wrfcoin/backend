import express from 'express';
import { authenticateSessionJWT } from '../middleware/auth.js';
import { buildPaymasterAndData, WEATHER_SELECTOR } from '../services/gas-relay-service.js';

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_DAILY_SPONSORSHIPS = 10;
const DEFAULT_LIFETIME_SPONSORSHIPS = 30;

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function defaultDb(): DbExecutor {
  // Lazy dynamic import — avoids "require is not defined" in ESM bundles (#268)
  let cachedExecuteQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null = null;
  return {
    execute: async (sql: string, params?: unknown[]) => {
      if (!cachedExecuteQuery) {
        const mod = await import('../../database/index.js');
        cachedExecuteQuery = mod.executeQuery;
      }
      return cachedExecuteQuery!(sql, params);
    },
  };
}

export function createGasRelayRouter(db?: DbExecutor): express.Router {
  const router = express.Router();

  // All gas relay operations require authentication (#231)
  router.use(authenticateSessionJWT);

  router.post('/sponsor', async (req, res) => {
    const executor = db ?? defaultDb();
    const { walletAddress, userOp } = req.body ?? {};
    const maxLifetime = Number(process.env.GAS_SPONSOR_FREE_TX_LIMIT || DEFAULT_LIFETIME_SPONSORSHIPS);

    // 1. Validate wallet address
    if (!walletAddress || !WALLET_RE.test(walletAddress)) {
      return res.status(400).json({ error: 'Invalid walletAddress' });
    }

    // 2. Require social account
    try {
      const socialRes = await executor.execute(
        `SELECT 1 FROM social_accounts WHERE wallet_address = $1 LIMIT 1`,
        [walletAddress]
      );
      if (socialRes.rows.length === 0) {
        return res.status(403).json({ error: 'No social account linked to this wallet' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Internal server error' });
    }

    // 3. Lifetime limit for sponsored onboarding transactions
    try {
      const lifetimeRes = await executor.execute(
        `SELECT COUNT(*) AS cnt FROM gas_sponsor_log WHERE wallet_address = $1`,
        [walletAddress]
      );
      const lifetimeCount = Number(lifetimeRes.rows[0]?.cnt ?? 0);
      if (lifetimeCount >= maxLifetime) {
        return res.status(403).json({ error: 'Lifetime sponsorship limit reached' });
      }
    } catch (_err) {
      return res.status(500).json({ error: 'Internal server error' });
    }

    // 4. Rate limit: max 10 sponsorships per 24 hours
    try {
      const countRes = await executor.execute(
        `SELECT COUNT(*) AS cnt FROM gas_sponsor_log
         WHERE wallet_address = $1
           AND sponsored_at > NOW() - INTERVAL '24 hours'`,
        [walletAddress]
      );
      const count = Number(countRes.rows[0]?.cnt ?? 0);
      if (count >= MAX_DAILY_SPONSORSHIPS) {
        return res.status(429).json({ error: 'Daily sponsorship limit reached' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Internal server error' });
    }

    // 5. Validate callData selector
    const callData: string = userOp?.callData ?? '';
    if (!callData.startsWith(WEATHER_SELECTOR)) {
      return res.status(400).json({ error: 'userOp.callData selector mismatch' });
    }

    // 6. Sign and build paymasterAndData
    let paymasterAndData: string;
    let userOpHash: string | undefined;
    let sponsorshipMeta:
      | {
          deadline: number;
          weatherDataHash: string;
          oracle: string;
        }
      | undefined;
    try {
      const result = await buildPaymasterAndData({
        sender: walletAddress,
        nonce: userOp?.nonce ?? 0,
        callData,
      });
      paymasterAndData = result.paymasterAndData;
      sponsorshipMeta = {
        deadline: result.deadline,
        weatherDataHash: result.weatherDataHash,
        oracle: result.oracle,
      };
      userOpHash = userOp?.hash ?? undefined;
    } catch (_err) {
      return res.status(500).json({ error: 'Failed to build paymasterAndData' });
    }

    // 7. Log the sponsorship
    try {
      await executor.execute(
        `INSERT INTO gas_sponsor_log (wallet_address, user_op_hash) VALUES ($1, $2)`,
        [walletAddress, userOpHash ?? null]
      );
    } catch (_err) {
      // Log but don't fail the request
    }

    return res.status(200).json({
      paymasterAndData,
      sponsorship: sponsorshipMeta,
      limits: {
        daily: MAX_DAILY_SPONSORSHIPS,
        lifetime: maxLifetime,
      },
    });
  });

  return router;
}

export default createGasRelayRouter();
