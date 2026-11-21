// Station registrar proxy (infra testnet/services/station-registrar, STATION_REGISTRAR.md). Default OFF.
//
// POST /api/station-registrar/requests              -> service POST /station-registrar/requests
// GET  /api/station-registrar/requests/<station id> -> service GET  /station-registrar/requests/<station id>
//
// A phone owner asks for their new phone station to be registered on chain by the
// registrar service (core4 station_registrar_key) instead of waiting for the owner's
// batch. The service checks the owner-signed row, applies the testnet limits, holds
// it 24 h and signs. This proxy holds no credential: it forwards exactly the nine row
// fields plus the visitor's address (one X-Forwarded-For value, from req.ip, so the
// service can apply its per-address limit; it keeps only a salted hash), bounds both
// bodies, keeps only known refusal codes and never relays upstream messages.
//
// Off unless STATION_REGISTRAR_PROXY_ENABLED=true AND STATION_REGISTRAR_URL is set.
// The chain refuses every registrar registration until station_registrar_key is
// scheduled and active, so turning this on early changes nothing on chain.
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { isIP } from 'node:net';

const router = Router();
// The service's own cap is 8 KiB; a phone row is well under 1 KiB.
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
// POST runs the core4 CLI check (up to 60 s) and a few node reads.
const UPSTREAM_TIMEOUT_MS = 90_000;
const STATION_ID = /^mob-[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ROW_KEYS = [
  'station_id', 'owner_address', 'owner_pubkey', 'owner_signature',
  'latitude', 'longitude', 'hardware_model', 'provenance_class', 'data_quality_tier',
] as const;
const NUMBER_KEYS = new Set(['latitude', 'longitude']);
const STATUSES = new Set(['held', 'submitted', 'registered', 'refused', 'needs_review']);
// Codes a status record may carry (the service's release loop).
const STATUS_CODES = new Set([
  'STATION_ALREADY_REGISTERED', 'STATION_NOT_NEW', 'NODE_REFUSED', 'NOT_SEEN_ON_CHAIN', 'SIGN_FAILED', 'SUBMIT_UNKNOWN',
]);

const refusalCodes = new Set([
  'REGISTRAR_DISABLED', 'REGISTRAR_STOPPED', 'REGISTRAR_UNAVAILABLE', 'REGISTRAR_CHAIN_UNAVAILABLE',
  'REGISTRAR_WRONG_CHAIN', 'REGISTRAR_NOT_ACTIVE', 'REGISTRAR_FORMAT_UNSUPPORTED', 'CLIENT_ADDRESS_UNKNOWN',
  'INVALID_REQUEST', 'INVALID_STATION_ID', 'REQUEST_TOO_LARGE', 'REGISTRATION_REFUSED',
  'STATION_ALREADY_REGISTERED', 'STATION_NOT_NEW', 'REGISTRAR_CEILING', 'NOT_REQUESTED',
  'ALREADY_REQUESTED', 'DAILY_TOTAL', 'DAILY_PER_IP', 'DAILY_PER_CELL',
]);
// Fixed, local wording per code: the service's own messages are not relayed.
const MESSAGES: Record<string, string> = {
  REGISTRAR_DISABLED: 'Station registration by the registrar is not enabled',
  REGISTRAR_STOPPED: 'Station registration is paused; try later',
  REGISTRAR_NOT_ACTIVE: 'Station registration by the registrar is not open on this chain yet',
  CLIENT_ADDRESS_UNKNOWN: 'Your network address could not be read',
  INVALID_REQUEST: 'Send the signed phone station row only',
  INVALID_STATION_ID: 'Not a phone station id',
  REQUEST_TOO_LARGE: 'Request too large',
  REGISTRATION_REFUSED: 'This row is not a new phone station the registrar can register',
  STATION_ALREADY_REGISTERED: 'This station is already on chain',
  STATION_NOT_NEW: 'This station has owner history; the registrar registers new stations only',
  REGISTRAR_CEILING: 'The testnet phone station ceiling is reached for now',
  NOT_REQUESTED: 'No request for this station',
  ALREADY_REQUESTED: 'This station was already requested',
  DAILY_TOTAL: 'Today\'s registrations are used up; try later',
  DAILY_PER_IP: 'Too many requests from your network today; try later',
  DAILY_PER_CELL: 'Too many requests from this area today; try later',
};
const PASS_STATUS = new Set([400, 404, 409, 413, 422, 429]);

function enabled(): boolean {
  return process.env.STATION_REGISTRAR_PROXY_ENABLED === 'true';
}
function serviceUrl(path: string): URL | null {
  const configured = process.env.STATION_REGISTRAR_URL || '';
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
  res.status(status).json({ error: { code, message: MESSAGES[code] || 'Station registration temporarily unavailable' } });
}

router.use((req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'no-store');
  if (!enabled()) { refuse(res, 404, 'REGISTRAR_DISABLED'); return; }
  next();
});
router.use(express.json({ limit: MAX_REQUEST_BYTES }));
router.use((req: Request, res: Response, next: NextFunction) => {
  // The live entrypoint may parse JSON first with a larger global limit.
  if (req.method === 'POST' && Buffer.byteLength(JSON.stringify(req.body ?? {})) > MAX_REQUEST_BYTES) {
    refuse(res, 413, 'REQUEST_TOO_LARGE');
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
  let code = 'REGISTRAR_UNAVAILABLE';
  try {
    const payload = await readPayload(response) as { error?: { code?: unknown } };
    if (typeof payload?.error?.code === 'string' && refusalCodes.has(payload.error.code)) code = payload.error.code;
  } catch { /* Error payloads are optional and untrusted. */ }
  // A 503 keeps its known code (stopped, not active yet) so the app can say why.
  refuse(res, PASS_STATUS.has(response.status) ? response.status : 503, code);
}

// The visitor's address as Express resolved it (trust proxy = the known edge only).
function clientAddress(req: Request): string | null {
  const raw = (req.ip || '').replace(/^::ffff:/, '');
  return isIP(raw) ? raw : null;
}

// The service's public status shape, with nothing else.
function statusOf(data: Record<string, unknown> | undefined, stationId?: string): Record<string, unknown> {
  if (!data || typeof data.stationId !== 'string' || !STATION_ID.test(data.stationId)
    || (stationId && data.stationId !== stationId) || !STATUSES.has(data.status as string)) {
    throw new Error('invalid status');
  }
  const out: Record<string, unknown> = { stationId: data.stationId, status: data.status };
  if (data.releaseAt !== undefined) {
    if (typeof data.releaseAt !== 'string' || !Number.isFinite(Date.parse(data.releaseAt))) throw new Error('invalid time');
    out.releaseAt = data.releaseAt;
  }
  if (data.transactionId !== undefined) {
    if (typeof data.transactionId !== 'string' || !HEX64.test(data.transactionId)) throw new Error('invalid tx id');
    out.transactionId = data.transactionId;
  }
  if (data.code !== undefined) {
    if (typeof data.code !== 'string' || !STATUS_CODES.has(data.code)) throw new Error('invalid code');
    out.code = data.code;
  }
  return out;
}

router.post('/requests', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)
    || !ROW_KEYS.every((k) => (NUMBER_KEYS.has(k) ? typeof body[k] === 'number' : typeof body[k] === 'string'))) {
    refuse(res, 400, 'INVALID_REQUEST');
    return;
  }
  const address = clientAddress(req);
  if (!address) { refuse(res, 400, 'CLIENT_ADDRESS_UNKNOWN'); return; }
  const url = serviceUrl('/station-registrar/requests');
  if (!url) { refuse(res, 503, 'REGISTRAR_UNAVAILABLE'); return; }
  const row: Record<string, unknown> = {};
  for (const k of ROW_KEYS) row[k] = body[k];
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
      body: JSON.stringify(row),
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) { await relayRefusal(response, res); return; }
    const payload = await readPayload(response) as { data?: Record<string, unknown> };
    const data = statusOf(payload?.data, row.station_id as string);
    if (data.status !== 'held' || data.releaseAt === undefined) throw new Error('invalid acceptance');
    res.status(202).json({ ok: true, data: {
      ...data,
      next: 'Held for 24 hours, then signed and sent to the chain. Check back with the status link.',
    } });
  } catch {
    refuse(res, 503, 'REGISTRAR_UNAVAILABLE');
  }
});

router.get('/requests/:stationId', async (req: Request, res: Response) => {
  const { stationId } = req.params;
  if (Object.keys(req.query ?? {}).length) { refuse(res, 400, 'INVALID_REQUEST'); return; }
  if (!STATION_ID.test(stationId)) { refuse(res, 400, 'INVALID_STATION_ID'); return; }
  const url = serviceUrl(`/station-registrar/requests/${stationId}`);
  if (!url) { refuse(res, 503, 'REGISTRAR_UNAVAILABLE'); return; }
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!response.ok) { await relayRefusal(response, res); return; }
    const payload = await readPayload(response) as { data?: Record<string, unknown> };
    res.json({ ok: true, data: statusOf(payload?.data, stationId) });
  } catch {
    refuse(res, 503, 'REGISTRAR_UNAVAILABLE');
  }
});

router.use((error: { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  const large = error?.type === 'entity.too.large';
  refuse(res, large ? 413 : 400, large ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST');
});

export default router;
