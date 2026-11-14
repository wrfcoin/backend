// Claim mailbox read proxy (infra testnet/services/claim-mailbox, CLAIM_MAILBOX.md). Default OFF.
//
// GET /api/claim-mailbox/claims/:deploymentId/:epoch -> service GET /claims/:deploymentId/:epoch
//
// Read only. `wrfcoin node receipt auto --mailbox-url https://wrfcoin.com/api/claim-mailbox/claims`
// reads a bond's claims for an epoch here. Writes (PUT, the house consumer's bearer) never go
// through this proxy: they reach the service on its host network only. The proxy holds no
// credential, accepts no query, checks the answer's shape and relays only those fields.
//
// Off unless CLAIM_MAILBOX_PROXY_ENABLED=true AND CLAIM_MAILBOX_URL is set.
import { Router, type Request, type Response, type NextFunction } from 'express';

const router = Router();
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CLAIMS = 8;
const MAX_CLAIM_HEX = 2 * 1536;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const EPOCH = /^(0|[1-9][0-9]{0,8})$/;

const MESSAGES: Record<string, string> = {
  MAILBOX_DISABLED: 'The claim mailbox is not enabled',
  NO_CLAIM: 'No claim for this bond and epoch yet',
  INVALID_CLAIM_ROUTE: 'Expected /claims/<64 lowercase hex bond id>/<epoch>',
};

function enabled(): boolean {
  return process.env.CLAIM_MAILBOX_PROXY_ENABLED === 'true';
}
function serviceUrl(path: string): URL | null {
  const configured = process.env.CLAIM_MAILBOX_URL || '';
  if (!configured) return null;
  try {
    const url = new URL(path, configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}
function refuse(res: Response, status: number, code: string): void {
  res.status(status).json({ ok: false, error: { code, message: MESSAGES[code] || 'Claim mailbox temporarily unavailable' } });
}

router.use((_req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'no-store');
  if (!enabled()) { refuse(res, 404, 'MAILBOX_DISABLED'); return; }
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

router.get('/claims/:deploymentId/:epoch', async (req: Request, res: Response) => {
  const { deploymentId, epoch } = req.params;
  if (Object.keys(req.query ?? {}).length || !HEX64.test(deploymentId) || !EPOCH.test(epoch)) {
    refuse(res, 400, 'INVALID_CLAIM_ROUTE');
    return;
  }
  const url = serviceUrl(`/claims/${deploymentId}/${epoch}`);
  if (!url) { refuse(res, 503, 'MAILBOX_UNAVAILABLE'); return; }
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (response.status === 404) {
      let code = 'NO_CLAIM';
      try {
        const payload = await readPayload(response) as { error?: { code?: unknown } };
        if (payload?.error?.code === 'MAILBOX_DISABLED') code = 'MAILBOX_DISABLED';
      } catch { /* Error payloads are optional and untrusted. */ }
      refuse(res, 404, code);
      return;
    }
    if (!response.ok) throw new Error('upstream refused');
    const payload = await readPayload(response) as { deployment_id?: unknown; epoch?: unknown; claims?: unknown };
    const claims = payload?.claims;
    if (payload?.deployment_id !== deploymentId || payload?.epoch !== epoch || !Array.isArray(claims)
      || claims.length === 0 || claims.length > MAX_CLAIMS) {
      throw new Error('invalid mailbox answer');
    }
    const out = claims.map((claim: Record<string, unknown>) => {
      if (!claim || typeof claim.receipt_id !== 'string' || !HEX64.test(claim.receipt_id)
        || typeof claim.claim_hex !== 'string' || claim.claim_hex.length > MAX_CLAIM_HEX || !HEX.test(claim.claim_hex)) {
        throw new Error('invalid claim');
      }
      return { claim_hex: claim.claim_hex, receipt_id: claim.receipt_id };
    });
    res.json({ deployment_id: deploymentId, epoch, claims: out });
  } catch {
    refuse(res, 503, 'MAILBOX_UNAVAILABLE');
  }
});

router.use((_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
});

export default router;
