// Bond admission proxy (infra testnet/services/bond-admission, BOND_ADMISSION.md). Default OFF.
//
// POST /api/bond-admission         -> service POST /bond-admission
// GET  /api/bond-admission/recent  -> service GET  /bond-admissions
//
// The service co-signs a node bond Deposit/Update with the pinned admission key
// after its own rules pass (24 h connected node, reachability dial, limits). This
// proxy adds nothing to the request and holds no credential: it forwards exactly
// the four request fields, bounds both bodies, keeps only known refusal codes,
// and never relays upstream messages, hosts or stack text.
//
// Off unless BOND_ADMISSION_PROXY_ENABLED=true AND BOND_ADMISSION_URL is set.
import express, { Router, type Request, type Response, type NextFunction } from 'express';

const router = Router();
const MAX_REQUEST_BYTES = 48 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
// The service may dial the node (up to ~30 s) and run the CLI twice.
const UPSTREAM_TIMEOUT_MS = 90_000;
const HEX64 = /^[0-9a-f]{64}$/;

const refusalCodes = new Set([
  'ADMISSION_DISABLED', 'ADMISSION_UNAVAILABLE', 'INVALID_ADMISSION_REQUEST', 'ADDRESS_NOT_PUBLIC',
  'ADMISSION_PACKET_REFUSED', 'INVALID_PEER_SIGNATURE', 'ALIAS_NOT_GENERATED', 'ADMISSION_CHAIN_UNAVAILABLE',
  'NODE_NOT_VISIBLE', 'NODE_TOO_NEW', 'NODE_NOT_SYNCED', 'ADMISSION_CEILING', 'NODE_NOT_REACHABLE',
  'NODE_WRONG_CHAIN', 'SERVER_KEY_ALREADY_ADMITTED', 'ADDRESS_ALREADY_ADMITTED', 'ADMISSION_SPACING',
  'ADMISSION_DAILY_LIMIT', 'UPDATE_ALREADY_ADMITTED', 'ADMISSION_SIGN_FAILED', 'ADMISSION_BUSY',
  'ADMISSION_REQUEST_TOO_LARGE',
]);
// Fixed, local wording per code: the service's own messages are not relayed.
const MESSAGES: Record<string, string> = {
  ADMISSION_DISABLED: 'Bond admission is not enabled',
  ADDRESS_NOT_PUBLIC: 'The node must announce a public address with an open port',
  ADMISSION_PACKET_REFUSED: 'The packet is not admissible; check it with `wrfcoin node bond admit`',
  INVALID_PEER_SIGNATURE: 'The peer signature does not match this packet and address',
  ALIAS_NOT_GENERATED: 'Use the generated service alias node-<first 8 hex of the server key>',
  NODE_NOT_VISIBLE: 'The node is not a visible sync peer of the network',
  NODE_TOO_NEW: 'The node must stay connected for 24 hours first',
  NODE_NOT_SYNCED: 'The node is not advertising a recent height',
  ADMISSION_CEILING: 'The testnet bond ceiling is reached for now',
  NODE_NOT_REACHABLE: 'The node could not be reached at its announced address; check the port forward',
  NODE_WRONG_CHAIN: 'The node at that address is on another chain',
  SERVER_KEY_ALREADY_ADMITTED: 'This node key was already admitted',
  ADDRESS_ALREADY_ADMITTED: 'A node at this address was already admitted',
  ADMISSION_SPACING: 'Admissions are paced; try later',
  ADMISSION_DAILY_LIMIT: 'Today\'s admissions are used up; try after the UTC day resets',
  UPDATE_ALREADY_ADMITTED: 'This update was already admitted for that epoch',
  ADMISSION_BUSY: 'The admission service is busy; try again shortly',
};
const PASS_STATUS = new Set([400, 404, 409, 413, 422, 429]);

function enabled(): boolean {
  return process.env.BOND_ADMISSION_PROXY_ENABLED === 'true';
}
function serviceUrl(path: string): URL | null {
  const configured = process.env.BOND_ADMISSION_URL || '';
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
  res.status(status).json({ error: { code, message: MESSAGES[code] || 'Bond admission temporarily unavailable' } });
}

router.use((req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'no-store');
  if (!enabled()) { refuse(res, 404, 'ADMISSION_DISABLED'); return; }
  next();
});
router.use(express.json({ limit: MAX_REQUEST_BYTES }));
router.use((req: Request, res: Response, next: NextFunction) => {
  // The live entrypoint may parse JSON first with a larger global limit.
  if (req.method === 'POST' && Buffer.byteLength(JSON.stringify(req.body ?? {})) > MAX_REQUEST_BYTES) {
    refuse(res, 413, 'ADMISSION_REQUEST_TOO_LARGE');
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

async function relayRefusal(response: globalThis.Response, res: Response): Promise<void> {
  const retry = response.headers.get('retry-after');
  if (retry && /^\d+$/.test(retry) && Number(retry) > 0 && Number(retry) <= 2592000) res.set('Retry-After', retry);
  let code = 'ADMISSION_UNAVAILABLE';
  try {
    const payload = await readPayload(response) as { error?: { code?: unknown } };
    if (typeof payload?.error?.code === 'string' && refusalCodes.has(payload.error.code)) code = payload.error.code;
  } catch { /* Error payloads are optional and untrusted. */ }
  refuse(res, PASS_STATUS.has(response.status) ? response.status : 503, code);
}

router.post('/', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body) || !body.transaction || typeof body.transaction !== 'object'
    || Array.isArray(body.transaction) || typeof body.peerId !== 'string' || typeof body.multiaddr !== 'string'
    || typeof body.peerSignature !== 'string') {
    refuse(res, 400, 'INVALID_ADMISSION_REQUEST');
    return;
  }
  const url = serviceUrl('/bond-admission');
  if (!url) { refuse(res, 503, 'ADMISSION_UNAVAILABLE'); return; }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transaction: body.transaction, peerId: body.peerId, multiaddr: body.multiaddr, peerSignature: body.peerSignature,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) { await relayRefusal(response, res); return; }
    const payload = await readPayload(response) as { data?: Record<string, unknown> };
    const data = payload?.data;
    if (!data || data.admitted !== true || !data.transaction || typeof data.transaction !== 'object'
      || !['Deposit', 'Update'].includes(data.action as string) || typeof data.deploymentId !== 'string'
      || !HEX64.test(data.deploymentId) || !Number.isSafeInteger(data.effectiveEpoch)) {
      throw new Error('invalid admission answer');
    }
    res.json({ ok: true, data: {
      admitted: true, included: false, action: data.action, deploymentId: data.deploymentId,
      effectiveEpoch: data.effectiveEpoch, transaction: data.transaction,
      next: 'Add the payout approval, then submit with your owner key before this epoch closes.',
    } });
  } catch {
    refuse(res, 503, 'ADMISSION_UNAVAILABLE');
  }
});

router.get('/recent', async (req: Request, res: Response) => {
  if (Object.keys(req.query ?? {}).length) { refuse(res, 400, 'INVALID_ADMISSION_REQUEST'); return; }
  const url = serviceUrl('/bond-admissions');
  if (!url) { refuse(res, 503, 'ADMISSION_UNAVAILABLE'); return; }
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!response.ok) { await relayRefusal(response, res); return; }
    const rows = (await readPayload(response) as { admissions?: unknown })?.admissions;
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('invalid history');
    const admissions = rows.map((row: Record<string, unknown>) => {
      if (!row || !['Deposit', 'Update'].includes(row.action as string)
        || typeof row.deploymentId !== 'string' || !HEX64.test(row.deploymentId)
        || typeof row.serverKey !== 'string' || !HEX64.test(row.serverKey)
        || typeof row.serviceAlias !== 'string' || row.serviceAlias.length > 128
        || !Number.isSafeInteger(row.effectiveEpoch) || typeof row.renewal !== 'boolean'
        || typeof row.time !== 'string' || !Number.isFinite(Date.parse(row.time))) throw new Error('invalid row');
      return { action: row.action, deploymentId: row.deploymentId, serverKey: row.serverKey,
        serviceAlias: row.serviceAlias, effectiveEpoch: row.effectiveEpoch, renewal: row.renewal, time: row.time };
    });
    res.json({ admissions });
  } catch {
    refuse(res, 503, 'ADMISSION_UNAVAILABLE');
  }
});

router.use((error: { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const large = error?.type === 'entity.too.large';
  refuse(res, large ? 413 : 400, large ? 'ADMISSION_REQUEST_TOO_LARGE' : 'INVALID_ADMISSION_REQUEST');
});

export default router;
