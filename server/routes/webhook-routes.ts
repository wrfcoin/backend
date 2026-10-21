/**
 * Outbound webhook subscription system — closes backend#389.
 *
 * Operators subscribe to platform events and receive signed HTTP POST
 * payloads from WRFCoin to their own endpoints.
 *
 * Routes:
 *   POST   /api/webhooks/subscriptions          — register a URL + event filter
 *   GET    /api/webhooks/subscriptions          — list caller's subscriptions
 *   DELETE /api/webhooks/subscriptions/:id      — remove a subscription
 *   POST   /api/webhooks/subscriptions/:id/test — fire a ping event synchronously
 *
 * Delivery:
 *   - HMAC-SHA256 in X-WRFCoin-Signature header
 *   - 3 retries: 1s, 4s, 16s backoff
 *   - Subscriptions paused after 10 consecutive failures
 */

import express from 'express';
import crypto from 'crypto';
import { authenticateJWT } from '../middleware/auth.js';

const SUPPORTED_EVENTS = [
  'weather.submission.confirmed',
  'weather.reward.credited',
  'streak.milestone.reached',
  'governance.proposal.created',
  'governance.vote.result',
] as const;

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function defaultDb(): DbExecutor {
  let cachedExecuteQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null =
    null;
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

function hmacSignature(secret: string, payload: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function deliverWithRetry(
  url: string,
  secret: string,
  eventType: string,
  payload: object,
  maxAttempts = 3
): Promise<{ success: boolean; statusCode?: number; error?: string; attempts: number }> {
  const body = JSON.stringify({ event: eventType, payload, deliveredAt: new Date().toISOString() });
  const signature = hmacSignature(secret, body);
  const delays = [1000, 4000, 16000];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WRFCoin-Signature': signature,
          'X-WRFCoin-Event': eventType,
          'User-Agent': 'WRFCoin-Webhook/1.0',
        },
        body,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timeout));

      if (resp.ok) return { success: true, statusCode: resp.status, attempts: attempt };
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delays[attempt - 1]));
    } catch (err) {
      if (attempt === maxAttempts) {
        return { success: false, error: err instanceof Error ? err.message : 'Request failed', attempts: attempt };
      }
      await new Promise(r => setTimeout(r, delays[attempt - 1]));
    }
  }
  return { success: false, error: 'Max retries exceeded', attempts: maxAttempts };
}

export async function deliverWebhookEvent(
  db: DbExecutor,
  eventType: string,
  payload: object
): Promise<void> {
  try {
    const subs = await db.execute(
      `SELECT id, url, secret_hash, consecutive_failures
       FROM webhook_subscriptions
       WHERE active = true AND $1 = ANY(events)`,
      [eventType]
    );
    for (const sub of subs.rows) {
      const result = await deliverWithRetry(
        String(sub.url),
        String(sub.secret_hash),
        eventType,
        payload
      );
      const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      await db.execute(
        `INSERT INTO webhook_delivery_log (subscription_id, event_type, payload_hash, status, attempts, last_attempt_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [sub.id, eventType, payloadHash, result.success ? 'delivered' : 'failed', result.attempts]
      ).catch(() => null); // log failure is non-fatal

      if (!result.success) {
        const failures = Number(sub.consecutive_failures ?? 0) + 1;
        await db.execute(
          `UPDATE webhook_subscriptions
           SET consecutive_failures = $1, active = $2
           WHERE id = $3`,
          [failures, failures < 10, sub.id]
        ).catch(() => null);
      } else {
        await db.execute(
          `UPDATE webhook_subscriptions SET consecutive_failures = 0 WHERE id = $1`,
          [sub.id]
        ).catch(() => null);
      }
    }
  } catch {
    // delivery errors are non-fatal to the caller
  }
}

export function createWebhookRouter(db?: DbExecutor): express.Router {
  const router = express.Router();
  const executor = db ?? defaultDb();

  // All routes require auth
  router.use(authenticateJWT);

  // POST /api/webhooks/subscriptions
  router.post('/subscriptions', async (req, res) => {
    const { url, events, secret } = req.body ?? {};
    const operatorWallet =
      (req as any).user?.walletAddress ??
      (req as any).user?.wallet_address ??
      (req as any).user?.id;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }
    if (!Array.isArray(events) || !events.length) {
      return res.status(400).json({ error: 'events array is required' });
    }
    const invalidEvents = events.filter(e => !SUPPORTED_EVENTS.includes(e as any));
    if (invalidEvents.length) {
      return res.status(400).json({
        error: `Unsupported events: ${invalidEvents.join(', ')}`,
        supported: SUPPORTED_EVENTS,
      });
    }
    if (!secret || typeof secret !== 'string' || secret.length < 16) {
      return res.status(400).json({ error: 'secret must be at least 16 characters' });
    }

    try {
      // URL validation
      new URL(url); // throws if invalid
    } catch {
      return res.status(400).json({ error: 'url must be a valid HTTPS URL' });
    }

    try {
      const result = await executor.execute(
        `INSERT INTO webhook_subscriptions
           (operator_wallet, url, events, secret_hash, active, consecutive_failures, created_at)
         VALUES ($1, $2, $3, $4, true, 0, now())
         RETURNING id, url, events, active, created_at`,
        [operatorWallet ?? 'unknown', url, events, secret]
      );
      return res.status(201).json({ success: true, subscription: result.rows[0] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Database error';
      return res.status(500).json({ error: msg });
    }
  });

  // GET /api/webhooks/subscriptions
  router.get('/subscriptions', async (req, res) => {
    const operatorWallet =
      (req as any).user?.walletAddress ??
      (req as any).user?.wallet_address ??
      (req as any).user?.id;
    try {
      const result = await executor.execute(
        `SELECT id, url, events, active, consecutive_failures, created_at
         FROM webhook_subscriptions
         WHERE operator_wallet = $1
         ORDER BY created_at DESC`,
        [operatorWallet ?? 'unknown']
      );
      return res.json({ success: true, subscriptions: result.rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Database error';
      return res.status(500).json({ error: msg });
    }
  });

  // DELETE /api/webhooks/subscriptions/:id
  router.delete('/subscriptions/:id', async (req, res) => {
    const { id } = req.params;
    const operatorWallet =
      (req as any).user?.walletAddress ??
      (req as any).user?.wallet_address ??
      (req as any).user?.id;
    try {
      const result = await executor.execute(
        `UPDATE webhook_subscriptions SET active = false
         WHERE id = $1 AND operator_wallet = $2
         RETURNING id`,
        [id, operatorWallet ?? 'unknown']
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: 'Subscription not found' });
      }
      return res.json({ success: true, deleted: id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Database error';
      return res.status(500).json({ error: msg });
    }
  });

  // POST /api/webhooks/subscriptions/:id/test — synchronous ping
  router.post('/subscriptions/:id/test', async (req, res) => {
    const { id } = req.params;
    const operatorWallet =
      (req as any).user?.walletAddress ??
      (req as any).user?.wallet_address ??
      (req as any).user?.id;
    try {
      const result = await executor.execute(
        `SELECT url, secret_hash FROM webhook_subscriptions
         WHERE id = $1 AND operator_wallet = $2 AND active = true LIMIT 1`,
        [id, operatorWallet ?? 'unknown']
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: 'Active subscription not found' });
      }
      const { url, secret_hash } = result.rows[0];
      const delivery = await deliverWithRetry(
        String(url),
        String(secret_hash),
        'ping',
        { message: 'WRFCoin webhook test ping', subscriptionId: id }
      );
      return res.json({ success: delivery.success, delivery });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Database error';
      return res.status(500).json({ error: msg });
    }
  });

  return router;
}

export default createWebhookRouter();
