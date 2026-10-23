import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { consumeFaucetChallenge, getFaucetServiceUrl, getFaucetServiceToken } from './onboarding-routes.js';

const router = Router();
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
// Preserve useful refusal codes without trusting upstream messages, hosts or stacks.
const refusalCodes = new Set([
  'BOND_GRANT_DISABLED', 'INVALID_BOND_GRANT_REQUEST', 'INVALID_BOND_GRANT_SIGNATURE',
  'NODE_TOO_NEW', 'NODE_NOT_SYNCED', 'NODE_NOT_VISIBLE', 'BOND_GRANT_CHAIN_UNAVAILABLE',
  'BOND_GRANT_SPACING', 'BOND_GRANT_DAILY_LIMIT', 'BOND_GRANT_ALREADY_USED',
  'FAUCET_TRANSFER_BUSY', 'CLAIM_PENDING',
]);
const unavailable = (res: Response, status = 503, code = 'FAUCET_UNAVAILABLE') =>
  res.status(status).json({ error: { code, message: 'Bond grant service temporarily unavailable' } });

router.use(express.json({ limit: MAX_REQUEST_BYTES }));
router.use((req: Request, res: Response, next: NextFunction) => {
  // The live entrypoint parses JSON first with a larger global limit. Enforce
  // this route's smaller cap there too, without altering any forwarded fields.
  if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > MAX_REQUEST_BYTES) {
    res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body too large' } });
    return;
  }
  next();
});

async function readPayload(response: globalThis.Response): Promise<unknown> {
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('oversized response');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function forward(req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  const configured = getFaucetServiceUrl();
  const token = getFaucetServiceToken();
  if (!configured || !token) { unavailable(res); return; }
  try {
    const url = new URL(req.method === 'POST' ? '/faucet/bond-grant' : '/faucet/bond-grants', configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('bad config');
    const response = await fetch(url, {
      method: req.method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(req.method === 'POST' ? { body: JSON.stringify(req.body) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    // Never relay error text, URL, response headers, or exception messages.
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      if (retry && /^\d+$/.test(retry) && Number(retry) > 0 && Number(retry) <= 2592000) res.set('Retry-After', retry);
      let code = 'FAUCET_UNAVAILABLE';
      try {
        const payload = await readPayload(response) as { error?: { code?: unknown } };
        if (typeof payload?.error?.code === 'string' && refusalCodes.has(payload.error.code)) code = payload.error.code;
      } catch { /* Error payloads are optional and untrusted. */ }
      unavailable(res, [400, 409, 429].includes(response.status) ? response.status : 503, code);
      return;
    }
    const payload = await readPayload(response);
    // Even a compromised dispenser must not echo our injected credential.
    if (JSON.stringify(payload).includes(token)) throw new Error('unsafe response');
    if (req.method === 'GET') {
      const rows = (payload as { grants?: unknown })?.grants;
      if (!Array.isArray(rows) || rows.length > 100) throw new Error('invalid history');
      const grants = rows.map((row: Record<string, unknown>) => {
        if (!row || typeof row.ownerAddress !== 'string' || !/^0x[0-9a-f]{40}$/.test(row.ownerAddress)
          || typeof row.serverKey !== 'string' || !/^[0-9a-f]{64}$/.test(row.serverKey)
          || typeof row.peerId !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{30,128}$/.test(row.peerId)
          || typeof row.txHash !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(row.txHash)
          || typeof row.time !== 'string' || !Number.isFinite(Date.parse(row.time))
          || ![true, false, null].includes(row.bonded as boolean | null)) throw new Error('invalid history row');
        return { ownerAddress: row.ownerAddress, peerId: row.peerId, serverKey: row.serverKey,
          txHash: row.txHash, time: row.time, bonded: row.bonded };
      });
      res.json({ grants });
      return;
    }
    // Success is the dispenser's ordinary JSON response. The request was
    // forwarded unchanged, including its signed node fields and captcha proof.
    res.json(payload);
  } catch {
    unavailable(res);
  }
}

router.post('/bond-grant', (req: Request, res: Response) => {
  const message = consumeFaucetChallenge(req.body?.challengeId, req.body?.answer);
  if (message) {
    res.status(400).json({ error: { code: 'CAPTCHA_FAILED', message } });
    return;
  }
  void forward(req, res);
});
router.get('/bond-grants', (req: Request, res: Response) => { void forward(req, res); });
router.use((error: { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const large = error?.type === 'entity.too.large';
  res.status(large ? 413 : 400).json({ error: { code: large ? 'BODY_TOO_LARGE' : 'INVALID_JSON', message: large ? 'Request body too large' : 'Invalid JSON body' } });
});
export default router;
