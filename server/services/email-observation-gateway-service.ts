import crypto from 'crypto';
import {
  SmsObservationGatewayService,
  type SmsGatewayQueueEntry,
} from './sms-observation-gateway-service.js';
import { routeDurableStore } from '../../shared/route-durable-store.js';

/**
 * Email observation gateway (backend-archive#1495, white paper §5.8 multi-channel submission).
 *
 * An observer emails the same compact, HMAC-signed observation envelope the SMS gateway
 * accepts. The email itself proves nothing: provider webhooks and From headers are trivially
 * forged, so the envelope signature is the only authentication, exactly as for SMS. A missing,
 * malformed or wrongly signed envelope is rejected, never queued.
 *
 * The envelope, dedup, sender risk scoring, retry queue and canonical weather payload are the
 * SMS gateway's own code (`SmsObservationGatewayService`), run with the `email` transport label,
 * its own ingest route, its own HMAC secret (`EMAIL_OBSERVATION_GATEWAY_SECRET`) and bounded
 * in-memory maps. On top of it this transport adds, before any envelope reaches the engine:
 *
 * - a freshness window on the envelope `ts` (default ±5 min);
 * - replay protection that survives a restart: each accepted envelope's signature is recorded in
 *   the route durable store, the same store weather ingestion uses for idempotency;
 * - per-sender and global rate caps with a bounded key set;
 * - sender privacy: the address is replaced by a keyed hash before it is stored, scored or
 *   passed on, and is never returned.
 *
 * Dormant unless `WRFCOIN_ENABLE_EMAIL_OBSERVATIONS=true` (checked per request by the route).
 */

export const EMAIL_INGEST_ROUTE = '/api/transport/email/observations';
/** Largest plain-text body the gateway reads. An envelope is a few hundred bytes. */
export const MAX_EMAIL_BODY_BYTES = 16 * 1024;
/** Envelope `ts` must be within this of the gateway clock (an email that sat in a queue longer is refused). */
export const DEFAULT_MAX_ENVELOPE_SKEW_MS = 5 * 60 * 1000;
/** Bound on every in-memory map, including the rate limiter's key set. */
export const DEFAULT_MAX_TRACKED_ENTRIES = 10_000;
export const DEFAULT_SENDER_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 };
export const DEFAULT_GLOBAL_LIMIT = { max: 300, windowMs: 60 * 1000 };
export const REPLAY_SCOPE = 'transport:email:envelope';

const ENVELOPE_LINE = /^[ \t]*WRF1[: \t][ \t]*([A-Za-z0-9_-]+)[ \t]*$/;

export interface EmailGatewayInbound {
  messageId: string;
  sender: string;
  body: string;
  receivedAt?: string;
}

/** A refusal the route maps to a status code without echoing input. */
export class EmailGatewayRefusal extends Error {
  constructor(readonly status: 400 | 409 | 413 | 429, message: string) {
    super(message);
    this.name = 'EmailGatewayRefusal';
  }
}

/**
 * Pull the compact envelope out of a plain-text email body. Mail clients add signatures,
 * quoted replies and line wrapping, so the envelope travels on its own line as
 * `WRF1:<base64url>`. A body that is exactly one JSON envelope is also accepted (scripts).
 * Returns null when no envelope is present. Linear in the body length: each line is matched
 * once by an anchored, single-line pattern.
 */
export function extractEnvelopeText(body: string): string | null {
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const match = ENVELOPE_LINE.exec(line);
    if (match) return match[1];
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  return null;
}

/** Lower-case the address inside `Name <addr@host>` so one sender is one identity. */
export function normalizeSender(raw: string): string {
  const open = raw.indexOf('<');
  const close = open >= 0 ? raw.indexOf('>', open + 1) : -1;
  const address = open >= 0 && close > open ? raw.slice(open + 1, close) : raw;
  return address.trim().toLowerCase();
}

/** Keyed hash of a normalised address. Stable per secret; not reversible without it. */
export function hashSender(address: string, secret: string): string {
  return `es_${crypto
    .createHmac('sha256', secret)
    .update(`wrfcoin.email-sender.v1:${normalizeSender(address)}`)
    .digest('hex')
    .slice(0, 32)}`;
}

const DEV_FALLBACK_SECRET = 'dev-email-observation-gateway-secret';
const MIN_SECRET_LENGTH = 16;

/**
 * Same fail-closed rule as the SMS gateway (#755): the dev fallback only when
 * NODE_ENV === 'development'; everywhere else a strong, non-fallback secret or a throw.
 */
export function resolveEmailGatewaySecret(explicit?: string): string {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const value = (explicit ?? process.env.EMAIL_OBSERVATION_GATEWAY_SECRET ?? '').trim();
  if (!value) {
    if (isDevelopment) return DEV_FALLBACK_SECRET;
    throw new Error(
      'EMAIL_OBSERVATION_GATEWAY_SECRET is required outside development. The email ' +
        'observation gateway verifies envelopes by HMAC signature, so a missing secret ' +
        'would allow forged observations. Provision a strong secret (e.g. `openssl rand -hex 32`).'
    );
  }
  if (!isDevelopment && value === DEV_FALLBACK_SECRET) {
    throw new Error(
      'EMAIL_OBSERVATION_GATEWAY_SECRET is the public dev fallback value, which is insecure outside development.'
    );
  }
  if (!isDevelopment && value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `EMAIL_OBSERVATION_GATEWAY_SECRET is too weak (min ${MIN_SECRET_LENGTH} chars).`
    );
  }
  return value;
}

/** Sliding-window counter with a bounded key set (oldest key evicted first). */
export class BoundedRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys: number
  ) {}

  /** Records a hit for `key` at `nowMs`; false when the key is already at its cap. */
  tryHit(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) || []).filter(t => nowMs - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.delete(key);
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
    return true;
  }

  size(): number {
    return this.hits.size;
  }
}

/** Store used for restart-surviving replay keys (the route durable store by default). */
export interface ReplayStore {
  getIdempotency(scope: string, key: string): Promise<unknown | null>;
  putIdempotency(scope: string, key: string, status: number, responseBody: unknown): Promise<void>;
}

/** The fields of an entry an unauthenticated caller may see: no sender, no risk detail. */
export interface EmailGatewayPublicEntry {
  queueId: string;
  stationId: string;
  observedAt: string;
  deliveryState: SmsGatewayQueueEntry['deliveryState'];
  duplicate: boolean;
  delayed: boolean;
  weatherRecordId?: string;
}

export function publicEntry(entry: SmsGatewayQueueEntry): EmailGatewayPublicEntry {
  return {
    queueId: entry.queueId,
    stationId: entry.stationId,
    observedAt: entry.observedAt,
    deliveryState: entry.deliveryState,
    duplicate: entry.duplicate,
    delayed: entry.delayed,
    ...(entry.weatherRecordId ? { weatherRecordId: entry.weatherRecordId } : {}),
  };
}

function decodeHeader(text: string): { ts: number | null; sig: string | null } {
  try {
    const trimmed = text.trim();
    const json = trimmed.startsWith('{')
      ? trimmed
      : Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json) as { ts?: unknown; sig?: unknown; obs?: { ts?: unknown } };
    const ts = typeof parsed.ts === 'number' ? parsed.ts : typeof parsed.obs?.ts === 'number' ? parsed.obs.ts : null;
    const sig = typeof parsed.sig === 'string' && /^[0-9a-f]{64}$/.test(parsed.sig) ? parsed.sig : null;
    return { ts, sig };
  } catch {
    return { ts: null, sig: null };
  }
}

type EngineOptions = NonNullable<ConstructorParameters<typeof SmsObservationGatewayService>[0]>;

export interface EmailGatewayOptions extends EngineOptions {
  replayStore?: ReplayStore;
  maxEnvelopeSkewMs?: number;
  senderLimit?: { max: number; windowMs: number };
  globalLimit?: { max: number; windowMs: number };
}

export class EmailObservationGatewayService {
  private readonly engine: SmsObservationGatewayService;
  private readonly secret: string;
  private readonly nowFn: () => Date;
  private readonly replayStore: ReplayStore;
  private readonly maxSkewMs: number;
  private readonly senderLimiter: BoundedRateLimiter;
  private readonly globalLimiter: BoundedRateLimiter;

  constructor(options: EmailGatewayOptions = {}) {
    this.secret = resolveEmailGatewaySecret(options.sharedSecret);
    this.nowFn = options.nowFn || (() => new Date());
    this.replayStore = options.replayStore || routeDurableStore;
    this.maxSkewMs = options.maxEnvelopeSkewMs ?? DEFAULT_MAX_ENVELOPE_SKEW_MS;
    const maxTracked = options.maxTrackedEntries ?? DEFAULT_MAX_TRACKED_ENTRIES;
    const sender = options.senderLimit || DEFAULT_SENDER_LIMIT;
    const global = options.globalLimit || DEFAULT_GLOBAL_LIMIT;
    this.senderLimiter = new BoundedRateLimiter(sender.max, sender.windowMs, maxTracked);
    this.globalLimiter = new BoundedRateLimiter(global.max, global.windowMs, 1);
    this.engine = new SmsObservationGatewayService({
      ...options,
      sharedSecret: this.secret,
      nowFn: this.nowFn,
      transport: 'email',
      ingestRoute: EMAIL_INGEST_ROUTE,
      queueIdPrefix: 'emailq_',
      maxTrackedEntries: maxTracked,
    });
  }

  async ingestInboundEmail(input: EmailGatewayInbound): Promise<SmsGatewayQueueEntry> {
    if (Buffer.byteLength(input.body, 'utf8') > MAX_EMAIL_BODY_BYTES) {
      throw new EmailGatewayRefusal(413, `email body exceeds ${MAX_EMAIL_BODY_BYTES} bytes`);
    }
    const nowMs = this.nowFn().getTime();
    const senderKey = hashSender(input.sender, this.secret);
    if (!this.globalLimiter.tryHit('global', nowMs)) {
      throw new EmailGatewayRefusal(429, 'email observation gateway is at its global rate cap');
    }
    if (!this.senderLimiter.tryHit(senderKey, nowMs)) {
      throw new EmailGatewayRefusal(429, 'sender is at its rate cap');
    }
    const envelope = extractEnvelopeText(input.body);
    if (!envelope) {
      throw new EmailGatewayRefusal(400, 'no WRF1 observation envelope found in the email body');
    }
    const header = decodeHeader(envelope);
    if (header.ts === null || header.sig === null) {
      throw new EmailGatewayRefusal(400, 'envelope requires a numeric ts and a hex sig');
    }
    if (Math.abs(nowMs - header.ts * 1000) > this.maxSkewMs) {
      throw new EmailGatewayRefusal(400, 'envelope ts is outside the freshness window');
    }
    const replayKey = `sig:${header.sig}`;
    if (await this.replayStore.getIdempotency(REPLAY_SCOPE, replayKey)) {
      throw new EmailGatewayRefusal(409, 'envelope was already accepted');
    }
    // The engine verifies the HMAC before anything is queued, so only a genuine envelope
    // reaches the replay record below.
    const entry = await this.engine.ingestInboundMessage({
      messageId: input.messageId,
      sender: senderKey,
      text: envelope,
      receivedAt: input.receivedAt,
    });
    if (entry.deliveryState === 'processed' || entry.deliveryState === 'queued_for_retry') {
      await this.replayStore.putIdempotency(REPLAY_SCOPE, replayKey, 201, { queueId: entry.queueId });
    }
    return entry;
  }

  flushReadyQueue(now?: Date): Promise<SmsGatewayQueueEntry[]> {
    return this.engine.flushReadyQueue(now);
  }

  listQueue(): SmsGatewayQueueEntry[] {
    return this.engine.listQueue();
  }

  trackedEntryCounts(): Record<string, number> {
    return { ...this.engine.trackedEntryCounts(), senderLimiterKeys: this.senderLimiter.size() };
  }
}

let instance: EmailObservationGatewayService | null = null;

/** Lazily built, so importing this module never throws on a missing secret (#755 pattern). */
export function getEmailObservationGatewayService(): EmailObservationGatewayService {
  if (!instance) instance = new EmailObservationGatewayService();
  return instance;
}
