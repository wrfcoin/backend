import {
  SmsObservationGatewayService,
  type SmsGatewayQueueEntry,
} from './sms-observation-gateway-service.js';

/**
 * Email observation gateway (backend-archive#1495, white paper §5.8 multi-channel submission).
 *
 * An observer emails the same compact, HMAC-signed observation envelope the SMS gateway
 * accepts. The email itself proves nothing: provider webhooks and From headers are trivially
 * forged, so the envelope signature is the only authentication, exactly as for SMS. A missing,
 * malformed or wrongly signed envelope is rejected, never queued.
 *
 * The envelope, dedup (message id and payload hash), sender risk scoring, retry queue and the
 * canonical weather payload are the SMS gateway's own code (`SmsObservationGatewayService`),
 * run with the `email` transport label, its own ingest route and its own HMAC secret
 * (`EMAIL_OBSERVATION_GATEWAY_SECRET`), so an SMS secret can never sign an email submission.
 *
 * Dormant unless `WRFCOIN_ENABLE_EMAIL_OBSERVATIONS=true` (checked per request by the route).
 */

export const EMAIL_INGEST_ROUTE = '/api/transport/email/observations';
/** Largest plain-text body the gateway reads. An envelope is a few hundred bytes. */
export const MAX_EMAIL_BODY_BYTES = 16 * 1024;
const ENVELOPE_LINE = /^\s*WRF1[:\s]\s*([A-Za-z0-9_-]+)\s*$/m;

export interface EmailGatewayInbound {
  messageId: string;
  sender: string;
  body: string;
  receivedAt?: string;
}

/**
 * Pull the compact envelope out of a plain-text email body. Mail clients add signatures,
 * quoted replies and line wrapping, so the envelope travels on its own line as
 * `WRF1:<base64url>`. A body that is exactly one JSON envelope is also accepted (scripts).
 * Returns null when no envelope is present.
 */
export function extractEnvelopeText(body: string): string | null {
  const line = ENVELOPE_LINE.exec(body);
  if (line) return line[1];
  const trimmed = body.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  return null;
}

/** Lower-case the address inside `Name <addr@host>` so one sender is one risk identity. */
export function normalizeSender(raw: string): string {
  const match = /<([^>]+)>/.exec(raw);
  return (match ? match[1] : raw).trim().toLowerCase();
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

type EngineOptions = ConstructorParameters<typeof SmsObservationGatewayService>[0];

export class EmailObservationGatewayService {
  private readonly engine: SmsObservationGatewayService;

  constructor(options: EngineOptions & { sharedSecret?: string } = {}) {
    this.engine = new SmsObservationGatewayService({
      ...options,
      sharedSecret: resolveEmailGatewaySecret(options.sharedSecret),
      transport: 'email',
      ingestRoute: EMAIL_INGEST_ROUTE,
      queueIdPrefix: 'emailq_',
    });
  }

  async ingestInboundEmail(input: EmailGatewayInbound): Promise<SmsGatewayQueueEntry> {
    if (Buffer.byteLength(input.body, 'utf8') > MAX_EMAIL_BODY_BYTES) {
      throw new Error(`email body exceeds ${MAX_EMAIL_BODY_BYTES} bytes`);
    }
    const envelope = extractEnvelopeText(input.body);
    if (!envelope) {
      throw new Error('no WRF1 observation envelope found in the email body');
    }
    return this.engine.ingestInboundMessage({
      messageId: input.messageId,
      sender: normalizeSender(input.sender),
      text: envelope,
      receivedAt: input.receivedAt,
    });
  }

  flushReadyQueue(now?: Date): Promise<SmsGatewayQueueEntry[]> {
    return this.engine.flushReadyQueue(now);
  }

  listQueue(): SmsGatewayQueueEntry[] {
    return this.engine.listQueue();
  }
}

let instance: EmailObservationGatewayService | null = null;

/** Lazily built, so importing this module never throws on a missing secret (#755 pattern). */
export function getEmailObservationGatewayService(): EmailObservationGatewayService {
  if (!instance) instance = new EmailObservationGatewayService();
  return instance;
}
