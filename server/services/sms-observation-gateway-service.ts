import crypto from 'crypto';
import { obsBodySchema, type ObsBody } from '../../shared/meshtastic-payload-types.js';
import {
  AbuseRiskService,
  abuseRiskService,
  type AbuseRiskAssessment,
} from './abuse-risk-service.js';
import {
  ingestWeatherPayload,
  type WeatherIngestionResult,
} from './weather-ingestion-service.js';

export interface CompactSmsObservationEnvelope {
  v: 1;
  mid: string;
  sid: string;
  ts?: number;
  obs: ObsBody;
  sig: string;
}

export interface SmsGatewayInbound {
  messageId: string;
  sender: string;
  text: string;
  receivedAt?: string;
}

export interface SmsGatewayQueueEntry {
  queueId: string;
  messageId: string;
  sender: string;
  stationId: string;
  payloadHash: string;
  receivedAt: string;
  observedAt: string;
  attempts: number;
  nextAttemptAt: string;
  deliveryState: 'pending' | 'processed' | 'queued_for_retry' | 'rejected' | 'duplicate';
  delayed: boolean;
  duplicate: boolean;
  lastError?: string;
  risk?: AbuseRiskAssessment;
  weatherRecordId?: string;
  canonicalPayload?: Record<string, unknown>;
  envelope: Omit<CompactSmsObservationEnvelope, 'sig'>;
}

interface SmsGatewayServiceOptions {
  sharedSecret?: string;
  abuseRiskService?: AbuseRiskService;
  weatherIngestor?: (input: {
    route: string;
    payload: unknown;
    idempotencyKey?: unknown;
    transportMeta?: Record<string, unknown>;
  }) => Promise<WeatherIngestionResult>;
  nowFn?: () => Date;
  retryDelayMs?: number;
  maxAttempts?: number;
  riskThreshold?: 'low' | 'moderate' | 'high' | 'critical';
  /**
   * Transport label recorded in `transportMeta.transport` and the ingest route
   * passed to the weather ingestor. Defaults keep the SMS gateway unchanged; the
   * email gateway (backend-archive#1495) reuses this envelope + queue with its
   * own label, route, queue-id prefix and secret.
   */
  transport?: string;
  ingestRoute?: string;
  queueIdPrefix?: string;
  /**
   * Upper bound on every in-memory map (queue, dedup indexes, per-station and per-sender
   * history); the oldest entry is evicted first and sender history is kept LRU. Defaults to
   * unbounded, which is the SMS gateway's existing behaviour. The email gateway sets it because
   * its sender keys are attacker-chosen.
   */
  maxTrackedEntries?: number;
}

const RISK_ORDER = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
} as const;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function toBase64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

export function encodeCompactSmsObservationEnvelope(
  envelope: CompactSmsObservationEnvelope
): string {
  return toBase64Url(stableStringify(envelope));
}

export function signCompactSmsObservationEnvelope(
  envelope: Omit<CompactSmsObservationEnvelope, 'sig'>,
  sharedSecret: string
): string {
  return crypto
    .createHmac('sha256', sharedSecret)
    .update(stableStringify(envelope))
    .digest('hex');
}

function decodeEnvelope(text: string): CompactSmsObservationEnvelope {
  const trimmed = text.trim();
  const decoded = trimmed.startsWith('{') ? trimmed : fromBase64Url(trimmed);
  return JSON.parse(decoded) as CompactSmsObservationEnvelope;
}

function buildCanonicalObservation(obs: ObsBody): Record<string, unknown> {
  return {
    ...(typeof obs.tmp === 'number' ? { temperature_c: obs.tmp } : {}),
    ...(typeof obs.hum === 'number' ? { humidity: obs.hum } : {}),
    ...(typeof obs.prs === 'number' ? { pressure_hpa: obs.prs } : {}),
  };
}

export class SmsObservationGatewayService {
  private readonly sharedSecret: string;
  private readonly riskService: AbuseRiskService;
  private readonly weatherIngestor: NonNullable<SmsGatewayServiceOptions['weatherIngestor']>;
  private readonly nowFn: () => Date;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly riskThreshold: keyof typeof RISK_ORDER;
  private readonly transport: string;
  private readonly ingestRoute: string;
  private readonly queueIdPrefix: string;
  private readonly maxTrackedEntries: number;
  private readonly queue = new Map<string, SmsGatewayQueueEntry>();
  private readonly stationLatestObservedAt = new Map<string, string>();
  private readonly senderHistory = new Map<
    string,
    Array<{ observedAt: string; status: 'accepted' | 'duplicate' | 'failed' }>
  >();
  private readonly processedMessageIds = new Map<string, string>();
  private readonly processedPayloadHashes = new Map<string, string>();

  constructor(options: SmsGatewayServiceOptions = {}) {
    this.sharedSecret = SmsObservationGatewayService.resolveSharedSecret(
      options.sharedSecret
    );
    this.riskService = options.abuseRiskService || abuseRiskService;
    this.weatherIngestor = options.weatherIngestor || ingestWeatherPayload;
    this.nowFn = options.nowFn || (() => new Date());
    this.retryDelayMs = options.retryDelayMs || 30_000;
    this.maxAttempts = options.maxAttempts || 3;
    this.riskThreshold = options.riskThreshold || 'critical';
    this.transport = options.transport || 'sms';
    this.ingestRoute = options.ingestRoute || '/api/transport/sms/observations';
    this.queueIdPrefix = options.queueIdPrefix || 'smsq_';
    this.maxTrackedEntries = options.maxTrackedEntries ?? Number.POSITIVE_INFINITY;
  }

  /** Evict oldest-first until `map` is within `maxTrackedEntries` (a no-op when unbounded). */
  private bound<K, V>(map: Map<K, V>): void {
    while (map.size > this.maxTrackedEntries) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
    }
  }

  /** Number of entries currently held across the in-memory maps (for bounded-memory tests). */
  trackedEntryCounts(): Record<string, number> {
    return {
      queue: this.queue.size,
      senderHistory: this.senderHistory.size,
      processedMessageIds: this.processedMessageIds.size,
      processedPayloadHashes: this.processedPayloadHashes.size,
      stationLatestObservedAt: this.stationLatestObservedAt.size,
    };
  }

  /**
   * #755: resolve the HMAC shared secret used to verify inbound SMS observation
   * envelopes. The SMS gateway uses request signatures instead of JWT, so a
   * weak/known secret lets anyone forge signed observations.
   *
   * Fail-closed semantics: the insecure dev fallback is permitted ONLY when
   * NODE_ENV === 'development'. In every other environment (testnet, staging,
   * production, or unset NODE_ENV) a non-empty, sufficiently strong
   * SMS_OBSERVATION_GATEWAY_SECRET must be provided, or construction throws.
   */
  private static readonly DEV_FALLBACK_SECRET =
    'dev-sms-observation-gateway-secret';
  private static readonly MIN_SECRET_LENGTH = 16;

  private static resolveSharedSecret(explicit?: string): string {
    const isDevelopment = process.env.NODE_ENV === 'development';

    // An explicit secret is a deliberate programmatic/caller choice (e.g. tests,
    // or callers wiring their own secret store). It bypasses the env strength
    // gate, but the public dev-fallback value is still rejected outside dev so a
    // copy-pasted insecure value cannot slip through.
    const explicitSecret = (explicit ?? '').trim();
    if (explicitSecret) {
      if (
        !isDevelopment &&
        explicitSecret === SmsObservationGatewayService.DEV_FALLBACK_SECRET
      ) {
        throw new Error(
          'SMS observation gateway secret is the public dev fallback value, ' +
            'which is insecure outside development.'
        );
      }
      return explicitSecret;
    }

    // Otherwise resolve from the environment with fail-closed semantics.
    const fromEnv = (process.env.SMS_OBSERVATION_GATEWAY_SECRET ?? '').trim();
    if (fromEnv) {
      if (
        !isDevelopment &&
        fromEnv === SmsObservationGatewayService.DEV_FALLBACK_SECRET
      ) {
        throw new Error(
          'SMS_OBSERVATION_GATEWAY_SECRET is set to the public dev fallback ' +
            'value, which is insecure outside development. Generate a unique ' +
            'secret (e.g. `openssl rand -hex 32`).'
        );
      }
      if (
        !isDevelopment &&
        fromEnv.length < SmsObservationGatewayService.MIN_SECRET_LENGTH
      ) {
        throw new Error(
          `SMS_OBSERVATION_GATEWAY_SECRET is too weak (min ` +
            `${SmsObservationGatewayService.MIN_SECRET_LENGTH} chars). ` +
            'Generate a strong secret (e.g. `openssl rand -hex 32`).'
        );
      }
      return fromEnv;
    }

    // No secret provided at all.
    if (isDevelopment) {
      return SmsObservationGatewayService.DEV_FALLBACK_SECRET;
    }

    throw new Error(
      'SMS_OBSERVATION_GATEWAY_SECRET is required outside development. The SMS ' +
        'observation gateway verifies inbound envelopes by HMAC signature, so a ' +
        'missing secret would fall back to a public value and allow forged ' +
        'observations. Provision a strong secret (e.g. `openssl rand -hex 32`).'
    );
  }

  async ingestInboundMessage(input: SmsGatewayInbound): Promise<SmsGatewayQueueEntry> {
    const receivedAt = input.receivedAt || this.nowFn().toISOString();
    const envelope = this.validateAndDecode(input.text);
    const payloadHash = crypto
      .createHash('sha256')
      .update(stableStringify(envelope.obs))
      .digest('hex');
    const observedAt = new Date((envelope.ts || envelope.obs.ts) * 1000).toISOString();
    const delayed = this.isDelayed(envelope.sid, observedAt);
    const risk = this.assessSender(input.sender, receivedAt);

    if (RISK_ORDER[risk.riskBand] >= RISK_ORDER[this.riskThreshold]) {
      const entry = this.buildEntry({
        input,
        envelope,
        payloadHash,
        observedAt,
        receivedAt,
        delayed,
        duplicate: false,
        state: 'rejected',
        risk,
        lastError: `sender exceeded ${this.riskThreshold} risk threshold`,
      });
      this.queue.set(entry.queueId, entry);
      this.bound(this.queue);
      this.recordHistory(input.sender, observedAt, 'failed');
      return entry;
    }

    if (
      this.processedMessageIds.has(input.messageId) ||
      this.processedPayloadHashes.has(payloadHash)
    ) {
      const duplicateEntry = this.buildEntry({
        input,
        envelope,
        payloadHash,
        observedAt,
        receivedAt,
        delayed,
        duplicate: true,
        state: 'duplicate',
        risk,
      });
      this.queue.set(duplicateEntry.queueId, duplicateEntry);
      this.bound(this.queue);
      this.recordHistory(input.sender, observedAt, 'duplicate');
      return duplicateEntry;
    }

    const entry = this.buildEntry({
      input,
      envelope,
      payloadHash,
      observedAt,
      receivedAt,
      delayed,
      duplicate: false,
      state: 'pending',
      risk,
    });
    this.queue.set(entry.queueId, entry);
    this.bound(this.queue);
    return this.processEntry(entry.queueId);
  }

  async flushReadyQueue(now = this.nowFn()): Promise<SmsGatewayQueueEntry[]> {
    const ready = Array.from(this.queue.values())
      .filter(
        entry =>
          entry.deliveryState === 'queued_for_retry' &&
          Date.parse(entry.nextAttemptAt) <= now.getTime()
      )
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

    const results: SmsGatewayQueueEntry[] = [];
    for (const entry of ready) {
      results.push(await this.processEntry(entry.queueId));
    }
    return results;
  }

  listQueue(): SmsGatewayQueueEntry[] {
    return Array.from(this.queue.values()).sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt)
    );
  }

  private validateAndDecode(text: string): CompactSmsObservationEnvelope {
    const envelope = decodeEnvelope(text);
    const parsed = obsBodySchema.safeParse(envelope.obs);
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues
          .map(issue => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
      );
    }
    if (envelope.v !== 1) {
      throw new Error('Unsupported compact envelope version');
    }
    if (!envelope.mid || !envelope.sid || !envelope.sig) {
      throw new Error('Envelope requires mid, sid, and sig');
    }

    const expectedSig = signCompactSmsObservationEnvelope(
      {
        v: envelope.v,
        mid: envelope.mid,
        sid: envelope.sid,
        ts: envelope.ts,
        obs: envelope.obs,
      },
      this.sharedSecret
    );

    if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(envelope.sig))) {
      throw new Error('Invalid compact envelope signature');
    }

    return envelope;
  }

  private async processEntry(queueId: string): Promise<SmsGatewayQueueEntry> {
    const current = this.queue.get(queueId);
    if (!current) {
      throw new Error(`Queue entry not found: ${queueId}`);
    }
    if (
      current.deliveryState === 'duplicate' ||
      current.deliveryState === 'rejected' ||
      current.deliveryState === 'processed'
    ) {
      return current;
    }

    const nextAttempts = current.attempts + 1;
    try {
      const canonicalPayload = {
        schema_version: 'wrf.weather.observation.v1',
        station_id: current.stationId,
        observed_at_unix: Math.floor(Date.parse(current.observedAt) / 1000),
        observation: buildCanonicalObservation(current.envelope.obs),
      };

      const result = await this.weatherIngestor({
        route: this.ingestRoute,
        payload: canonicalPayload,
        idempotencyKey: current.messageId,
        transportMeta: {
          transport: this.transport,
          sender: current.sender,
          queueId: current.queueId,
          delayed: current.delayed,
        },
      });

      const processed: SmsGatewayQueueEntry = {
        ...current,
        attempts: nextAttempts,
        deliveryState: result.body.duplicate ? 'duplicate' : 'processed',
        duplicate: Boolean(result.body.duplicate),
        weatherRecordId:
          typeof result.body.id === 'string' ? result.body.id : current.weatherRecordId,
        canonicalPayload,
        lastError: undefined,
      };
      this.queue.set(queueId, processed);
      this.processedMessageIds.set(current.messageId, queueId);
      this.processedPayloadHashes.set(current.payloadHash, queueId);
      this.stationLatestObservedAt.set(current.stationId, current.observedAt);
      this.bound(this.processedMessageIds);
      this.bound(this.processedPayloadHashes);
      this.bound(this.stationLatestObservedAt);
      this.recordHistory(
        current.sender,
        current.observedAt,
        processed.duplicate ? 'duplicate' : 'accepted'
      );
      return processed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const shouldRetry = nextAttempts < this.maxAttempts;
      const updated: SmsGatewayQueueEntry = {
        ...current,
        attempts: nextAttempts,
        deliveryState: shouldRetry ? 'queued_for_retry' : 'rejected',
        nextAttemptAt: new Date(this.nowFn().getTime() + this.retryDelayMs).toISOString(),
        lastError: message,
      };
      this.queue.set(queueId, updated);
      this.recordHistory(current.sender, current.observedAt, 'failed');
      return updated;
    }
  }

  private buildEntry(args: {
    input: SmsGatewayInbound;
    envelope: CompactSmsObservationEnvelope;
    payloadHash: string;
    observedAt: string;
    receivedAt: string;
    delayed: boolean;
    duplicate: boolean;
    state: SmsGatewayQueueEntry['deliveryState'];
    risk: AbuseRiskAssessment;
    lastError?: string;
  }): SmsGatewayQueueEntry {
    return {
      queueId: `${this.queueIdPrefix}${crypto.randomUUID().replace(/-/g, '')}`,
      messageId: args.input.messageId,
      sender: args.input.sender,
      stationId: args.envelope.sid,
      payloadHash: args.payloadHash,
      receivedAt: args.receivedAt,
      observedAt: args.observedAt,
      attempts: 0,
      nextAttemptAt: args.receivedAt,
      deliveryState: args.state,
      delayed: args.delayed,
      duplicate: args.duplicate,
      lastError: args.lastError,
      risk: args.risk,
      envelope: {
        v: args.envelope.v,
        mid: args.envelope.mid,
        sid: args.envelope.sid,
        ts: args.envelope.ts,
        obs: args.envelope.obs,
      },
    };
  }

  private isDelayed(stationId: string, observedAt: string): boolean {
    const latest = this.stationLatestObservedAt.get(stationId);
    return Boolean(latest && Date.parse(observedAt) < Date.parse(latest));
  }

  private assessSender(sender: string, receivedAt: string): AbuseRiskAssessment {
    const history = this.senderHistory.get(sender) || [];
    const recentWindow = history.filter(
      entry => Date.parse(receivedAt) - Date.parse(entry.observedAt) <= 10 * 60 * 1000
    );
    const duplicateCount = recentWindow.filter(entry => entry.status === 'duplicate').length;
    const failureCount = recentWindow.filter(entry => entry.status === 'failed').length;
    return this.riskService.assessParticipant({
      participantId: sender,
      actorClass: 'human',
      indicators: {
        spam_burst: Math.min(1, recentWindow.length / 6),
        duplicate_payload: Math.min(1, duplicateCount / 3),
        failed_submission_rate: recentWindow.length
          ? failureCount / recentWindow.length
          : 0,
      },
      observedAt: receivedAt,
      evidenceConfidence: 0.8,
    });
  }

  private recordHistory(
    sender: string,
    observedAt: string,
    status: 'accepted' | 'duplicate' | 'failed'
  ) {
    const current = this.senderHistory.get(sender) || [];
    current.push({ observedAt, status });
    if (Number.isFinite(this.maxTrackedEntries)) {
      // LRU: move this sender to the newest position before evicting the oldest.
      this.senderHistory.delete(sender);
    }
    this.senderHistory.set(sender, current.slice(-25));
    this.bound(this.senderHistory);
  }
}

// #755: lazily construct the shared singleton on first use rather than at module
// import. Construction now fails closed when the HMAC secret is missing/weak
// outside development; doing that eagerly at import would crash unrelated
// modules (and tests) that merely import this file. A lazy proxy preserves the
// fail-closed guarantee at the point the gateway is actually exercised while
// keeping the module importable.
let _smsObservationGatewayServiceInstance: SmsObservationGatewayService | null =
  null;

function getSmsObservationGatewayService(): SmsObservationGatewayService {
  if (!_smsObservationGatewayServiceInstance) {
    _smsObservationGatewayServiceInstance = new SmsObservationGatewayService();
  }
  return _smsObservationGatewayServiceInstance;
}

export const smsObservationGatewayService =
  new Proxy({} as SmsObservationGatewayService, {
    get(_target, prop, receiver) {
      const instance = getSmsObservationGatewayService();
      const value = Reflect.get(instance, prop, receiver);
      return typeof value === 'function' ? value.bind(instance) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(getSmsObservationGatewayService(), prop, value);
    },
  });
