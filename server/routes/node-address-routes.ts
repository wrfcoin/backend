// Node address record proxy (infra testnet/services/claim-mailbox, NODE_ADDRESSES.md). Default OFF.
//
// POST /api/node-addresses -> service POST /addresses
//
// A bonded node's `wrfcoin node address publish` posts its own signed record ("server key K is at
// these addresses") once an epoch. The mailbox checks both signatures and the bond on chain; this
// proxy adds nothing, holds no credential, forwards exactly the record fields (never the client IP
// or any header), bounds both bodies, keeps only known refusal codes with local wording, and never
// relays upstream messages. Reads (the house consumer's bearer) never go through here.
//
// Off unless NODE_ADDRESS_PROXY_ENABLED=true AND CLAIM_MAILBOX_URL is set.
import express, { Router, type Request, type Response, type NextFunction } from 'express';

const router = Router();
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,14})$/;
const FIELDS = ['version', 'chain_id', 'network_id', 'genesis_hash', 'deployment_id', 'server_key', 'peer_id',
  'epoch', 'height', 'multiaddrs', 'signature', 'peer_signature'] as const;

// Fixed, local wording per code: the service's own messages are not relayed.
const MESSAGES: Record<string, string> = {
  ADDRESSES_DISABLED: 'Node address records are not enabled',
  ADDRESSES_UNAVAILABLE: 'The address mailbox is temporarily unavailable',
  INVALID_RECORD: 'The record is not well formed; build it with `wrfcoin node address publish`',
  RECORD_TOO_LARGE: 'The record is larger than 4 KiB',
  ADDRESS_NOT_PUBLIC: 'Only public addresses (no private, CGNAT, loopback or tunnel range)',
  WRONG_CHAIN: 'The record is for another chain, network or genesis',
  BAD_SIGNATURE: 'The server or peer signature does not verify',
  NOT_BONDED: 'This bond is not registered (or is jailed) on chain',
  SERVER_KEY_MISMATCH: 'The record is not signed by this bond\'s registered server key',
  STALE_EPOCH: 'The record is for an earlier epoch',
  FUTURE_EPOCH: 'The record is for a later epoch than the chain; try again shortly',
  FUTURE_HEIGHT: 'The record height is ahead of the chain; try again shortly',
  STALE_RECORD: 'A newer record for this server key is already stored',
  RATE_LIMITED: 'Too many new records for this server key; try again later',
  BUSY: 'The address mailbox is busy; try again shortly',
  NODE_UNAVAILABLE: 'The bond could not be read from the chain right now; try again shortly',
  NOT_CONFIGURED: 'The address mailbox is not configured yet',
};
const PASS_STATUS = new Set([400, 403, 404, 409, 413, 422, 429, 503]);

function enabled(): boolean {
  return process.env.NODE_ADDRESS_PROXY_ENABLED === 'true';
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
  res.status(status).json({ ok: false, error: { code, message: MESSAGES[code] || MESSAGES.ADDRESSES_UNAVAILABLE } });
}

router.use((_req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'no-store');
  if (!enabled()) { refuse(res, 404, 'ADDRESSES_DISABLED'); return; }
  next();
});
router.use(express.json({ limit: MAX_REQUEST_BYTES }));
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!err) { next(); return; }
  const type = (err as { type?: string }).type;
  refuse(res, type === 'entity.too.large' ? 413 : 400, type === 'entity.too.large' ? 'RECORD_TOO_LARGE' : 'INVALID_RECORD');
});
router.use((req: Request, res: Response, next: NextFunction) => {
  // The live entrypoint may parse JSON first with a larger global limit.
  if (req.method === 'POST' && Buffer.byteLength(JSON.stringify(req.body ?? {})) > MAX_REQUEST_BYTES) {
    refuse(res, 413, 'RECORD_TOO_LARGE');
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

router.post('/', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (Object.keys(req.query ?? {}).length || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== FIELDS.length || !FIELDS.every((f) => Object.prototype.hasOwnProperty.call(body, f))) {
    refuse(res, 400, 'INVALID_RECORD');
    return;
  }
  const url = serviceUrl('/addresses');
  if (!url) { refuse(res, 503, 'ADDRESSES_UNAVAILABLE'); return; }
  try {
    const record = Object.fromEntries(FIELDS.map((f) => [f, body[f]]));
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      let code = 'ADDRESSES_UNAVAILABLE';
      try {
        const payload = await readPayload(response) as { error?: { code?: unknown } };
        if (typeof payload?.error?.code === 'string' && payload.error.code in MESSAGES) code = payload.error.code;
      } catch { /* Error payloads are optional and untrusted. */ }
      refuse(res, PASS_STATUS.has(response.status) ? response.status : 503, code);
      return;
    }
    const payload = await readPayload(response) as { data?: Record<string, unknown> };
    const data = payload?.data;
    if (!data || !['STORED', 'UNCHANGED'].includes(data.status as string) || typeof data.server_key !== 'string'
      || !HEX64.test(data.server_key) || typeof data.epoch !== 'string' || !DECIMAL.test(data.epoch)
      || typeof data.height !== 'string' || !DECIMAL.test(data.height)) {
      throw new Error('invalid mailbox answer');
    }
    res.json({ ok: true, data: { status: data.status, server_key: data.server_key, epoch: data.epoch, height: data.height } });
  } catch {
    refuse(res, 503, 'ADDRESSES_UNAVAILABLE');
  }
});

router.use((_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
});

export default router;
