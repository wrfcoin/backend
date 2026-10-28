import fs from 'node:fs';
import path from 'node:path';
import {
  EmailGatewayRefusal,
  EmailObservationGatewayService,
  EMAIL_INGEST_ROUTE,
  MAX_EMAIL_BODY_BYTES,
  REPLAY_SCOPE,
  extractEnvelopeText,
  hashSender,
  normalizeSender,
  resolveEmailGatewaySecret,
  type ReplayStore,
} from '../../server/services/email-observation-gateway-service.js';
import {
  encodeCompactSmsObservationEnvelope,
  signCompactSmsObservationEnvelope,
} from '../../server/services/sms-observation-gateway-service.js';
import { RouteDurableStore } from '../../shared/route-durable-store.js';

// Fixtures only: no mailbox, no provider, no network.
const SECRET = 'email-test-secret-0123456789';
const SMS_SECRET = 'sms-test-secret-0123456789ab';
const TS = 1_772_758_800;
const NOW = new Date(TS * 1000 + 30_000);

function envelope(opts: { secret?: string; mid?: string; ts?: number; tmp?: number } = {}) {
  const ts = opts.ts ?? TS;
  const obs = { ts, tmp: opts.tmp ?? 21.1, hum: 49 };
  const unsigned = { v: 1 as const, mid: opts.mid ?? 'email-msg-1', sid: 'EMAIL-STATION-1', ts, obs };
  return encodeCompactSmsObservationEnvelope({
    ...unsigned,
    sig: signCompactSmsObservationEnvelope(unsigned, opts.secret ?? SECRET),
  });
}

function emailBody(env: string) {
  return ['Hi,', '', `WRF1:${env}`, '', '-- ', 'Sent from my phone', '> quoted reply'].join('\n');
}

function memoryStore(): ReplayStore & { keys: string[] } {
  const map = new Map<string, unknown>();
  return {
    keys: [] as string[],
    async getIdempotency(scope, key) {
      return map.get(`${scope}:${key}`) ?? null;
    },
    async putIdempotency(scope, key, status, body) {
      map.set(`${scope}:${key}`, { status, body });
      this.keys.push(`${scope}:${key}`);
    },
  };
}

function service(calls: any[] = [], extra: Record<string, unknown> = {}) {
  return new EmailObservationGatewayService({
    sharedSecret: SECRET,
    replayStore: memoryStore(),
    weatherIngestor: async (input: any) => {
      calls.push(input);
      return { status: 201, body: { success: true, id: `weather-email-${calls.length}` }, canonicalized: {} as any };
    },
    nowFn: () => NOW,
    ...extra,
  });
}

async function refusal(promise: Promise<unknown>): Promise<EmailGatewayRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmailGatewayRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('email observation gateway service', () => {
  it('ingests a signed envelope from a plain-text body and labels it as email', async () => {
    const calls: any[] = [];
    const entry = await service(calls).ingestInboundEmail({
      messageId: '<abc@mail.example>',
      sender: 'Observer One <Observer@Example.org>',
      body: emailBody(envelope()),
    });
    expect(entry.deliveryState).toBe('processed');
    expect(entry.queueId).toMatch(/^emailq_/);
    expect(entry.stationId).toBe('EMAIL-STATION-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].route).toBe(EMAIL_INGEST_ROUTE);
    expect(calls[0].transportMeta.transport).toBe('email');
    expect(calls[0].payload).toEqual({
      schema_version: 'wrf.weather.observation.v1',
      station_id: 'EMAIL-STATION-1',
      observed_at_unix: TS,
      observation: { temperature_c: 21.1, humidity: 49 },
    });
  });

  it('rejects an envelope signed with any other secret, including the SMS secret', async () => {
    const calls: any[] = [];
    await expect(
      service(calls).ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body: emailBody(envelope({ secret: SMS_SECRET })) })
    ).rejects.toThrow(/Invalid compact envelope signature/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a body with no envelope and an oversize body, without ingesting', async () => {
    const calls: any[] = [];
    const svc = service(calls);
    expect((await refusal(svc.ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body: 'temp 21C, humid 49%' }))).status).toBe(400);
    const big = await refusal(
      svc.ingestInboundEmail({ messageId: 'm2', sender: 'a@b.c', body: emailBody(envelope()) + 'x'.repeat(MAX_EMAIL_BODY_BYTES) })
    );
    expect(big.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  describe('freshness window (default ±5 min)', () => {
    it.each([
      ['6 min old', TS - 360, 400],
      ['6 min ahead', TS + 420, 400],
      ['4 min old', TS - 210, null],
      ['4 min ahead', TS + 240, null],
    ])('%s', async (_label, ts, status) => {
      const calls: any[] = [];
      const run = service(calls).ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body: emailBody(envelope({ ts })) });
      if (status === null) {
        expect((await run).deliveryState).toBe('processed');
      } else {
        const error = await refusal(run);
        expect(error.status).toBe(status);
        expect(error.message).toMatch(/freshness window/);
        expect(calls).toHaveLength(0);
      }
    });
  });

  it('dedups in memory by message id and payload hash', async () => {
    const calls: any[] = [];
    const svc = service(calls);
    const body = emailBody(envelope());
    expect((await svc.ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body })).deliveryState).toBe('processed');
    // The same envelope again is refused by the replay record before the engine sees it.
    expect((await refusal(svc.ingestInboundEmail({ messageId: 'm2', sender: 'a@b.c', body }))).status).toBe(409);
    // A re-signed envelope with a new mid but the same observation is a payload-hash duplicate.
    const resent = emailBody(envelope({ mid: 'email-msg-2' }));
    expect((await svc.ingestInboundEmail({ messageId: 'm3', sender: 'a@b.c', body: resent })).deliveryState).toBe('duplicate');
    expect(calls).toHaveLength(1);
  });

  it('replay protection survives a restart (route durable store, file backend)', async () => {
    const file = path.join(process.cwd(), 'backend', 'data', `email-replay-test-${process.pid}-${Date.now()}.json`);
    try {
      const body = emailBody(envelope());
      const first = new EmailObservationGatewayService({
        sharedSecret: SECRET,
        replayStore: new RouteDurableStore(file, 'file'),
        weatherIngestor: async () => ({ status: 201, body: { success: true, id: 'w1' }, canonicalized: {} as any }),
        nowFn: () => NOW,
      });
      expect((await first.ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body })).deliveryState).toBe('processed');

      // "Restart": a new store instance on the same file and a new service with empty memory.
      const calls: any[] = [];
      const restarted = new EmailObservationGatewayService({
        sharedSecret: SECRET,
        replayStore: new RouteDurableStore(file, 'file'),
        weatherIngestor: async (input: any) => {
          calls.push(input);
          return { status: 201, body: { success: true, id: 'w2' }, canonicalized: {} as any };
        },
        nowFn: () => NOW,
      });
      const replay = await refusal(restarted.ingestInboundEmail({ messageId: 'fresh-id', sender: 'a@b.c', body }));
      expect(replay.status).toBe(409);
      expect(calls).toHaveLength(0);
      // Control: a different genuine envelope is still accepted after the restart.
      const other = emailBody(envelope({ mid: 'email-msg-9', tmp: 19.5 }));
      expect((await restarted.ingestInboundEmail({ messageId: 'm9', sender: 'a@b.c', body: other })).deliveryState).toBe('processed');
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.tmp`, { force: true });
    }
  });

  it('records a replay key only for genuine envelopes', async () => {
    const store = memoryStore();
    const svc = service([], { replayStore: store });
    await expect(
      svc.ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body: emailBody(envelope({ secret: SMS_SECRET })) })
    ).rejects.toThrow(/signature/);
    expect(store.keys).toHaveLength(0);
    await svc.ingestInboundEmail({ messageId: 'm2', sender: 'a@b.c', body: emailBody(envelope()) });
    expect(store.keys).toHaveLength(1);
    expect(store.keys[0].startsWith(`${REPLAY_SCOPE}:sig:`)).toBe(true);
  });

  it('applies a per-sender cap and a global cap (429)', async () => {
    const svc = service([], { senderLimit: { max: 2, windowMs: 60_000 }, globalLimit: { max: 4, windowMs: 60_000 } });
    const send = (sender: string, i: number) =>
      svc.ingestInboundEmail({ messageId: `m${i}`, sender, body: emailBody(envelope({ mid: `mid-${i}`, tmp: 10 + i })) });
    await send('a@b.c', 1);
    await send('A@B.C', 2); // same sender after normalisation
    const perSender = await refusal(send('a@b.c', 3));
    expect(perSender.status).toBe(429);
    expect(perSender.message).toMatch(/sender is at its rate cap/);
    await send('other@b.c', 4); // global hit 4 (the refused hit 3 still counted)
    const global = await refusal(send('third@b.c', 5));
    expect(global.status).toBe(429);
    expect(global.message).toMatch(/global rate cap/);
  });

  it('keeps every in-memory map bounded under attacker-chosen senders', async () => {
    const svc = service([], { maxTrackedEntries: 5, globalLimit: { max: 1_000, windowMs: 60_000 } });
    for (let i = 0; i < 40; i += 1) {
      await svc.ingestInboundEmail({
        messageId: `m${i}`,
        sender: `attacker-${i}@example.org`,
        body: emailBody(envelope({ mid: `mid-${i}`, tmp: i })),
      });
    }
    for (const [name, size] of Object.entries(svc.trackedEntryCounts())) {
      expect({ name, bounded: size <= 5 }).toEqual({ name, bounded: true });
    }
  });

  it('never stores, scores or forwards the raw address', async () => {
    const calls: any[] = [];
    const svc = service(calls);
    const entry = await svc.ingestInboundEmail({ messageId: 'm1', sender: 'Observer <Observer@Example.org>', body: emailBody(envelope()) });
    const expected = hashSender('observer@example.org', SECRET);
    expect(entry.sender).toBe(expected);
    expect(entry.sender).toMatch(/^es_[0-9a-f]{32}$/);
    expect(calls[0].transportMeta.sender).toBe(expected);
    const serialized = JSON.stringify(svc.listQueue());
    expect(serialized).not.toMatch(/example\.org/i);
    expect(hashSender('observer@example.org', 'another-secret-0123456789')).not.toBe(expected);
  });

  it('extracts the envelope line and a bare JSON envelope, and normalizes senders', () => {
    expect(extractEnvelopeText('x\n  WRF1: abc_DEF-123  \r\ny')).toBe('abc_DEF-123');
    expect(extractEnvelopeText('{"v":1}')).toBe('{"v":1}');
    expect(extractEnvelopeText('WRF1:bad chars!')).toBeNull();
    expect(extractEnvelopeText('\n\n  \nWRF1:\n\nabc')).toBeNull();
    expect(normalizeSender(' Name <ME@Host.ORG> ')).toBe('me@host.org');
    expect(normalizeSender('ME@host.org')).toBe('me@host.org');
  });

  it('scans pathological bodies in linear time', () => {
    const bodies = [
      '\n'.repeat(MAX_EMAIL_BODY_BYTES),
      ' \n'.repeat(MAX_EMAIL_BODY_BYTES / 2),
      '\t \r\n'.repeat(MAX_EMAIL_BODY_BYTES / 4),
      'WRF1:\n'.repeat(MAX_EMAIL_BODY_BYTES / 6),
      `WRF1:${'a'.repeat(MAX_EMAIL_BODY_BYTES - 6)}!`,
    ];
    for (const body of bodies) {
      const started = process.hrtime.bigint();
      expect(extractEnvelopeText(body)).toBeNull();
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(elapsedMs).toBeLessThan(50);
    }
  });
});

describe('email observation gateway secret (fail closed)', () => {
  const saved = { env: process.env.NODE_ENV, secret: process.env.EMAIL_OBSERVATION_GATEWAY_SECRET };
  afterEach(() => {
    process.env.NODE_ENV = saved.env;
    if (saved.secret === undefined) delete process.env.EMAIL_OBSERVATION_GATEWAY_SECRET;
    else process.env.EMAIL_OBSERVATION_GATEWAY_SECRET = saved.secret;
  });

  it('throws outside development with no, weak or fallback secret', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.EMAIL_OBSERVATION_GATEWAY_SECRET;
    expect(() => resolveEmailGatewaySecret()).toThrow(/required outside development/);
    process.env.EMAIL_OBSERVATION_GATEWAY_SECRET = 'short';
    expect(() => resolveEmailGatewaySecret()).toThrow(/too weak/);
    process.env.EMAIL_OBSERVATION_GATEWAY_SECRET = 'dev-email-observation-gateway-secret';
    expect(() => resolveEmailGatewaySecret()).toThrow(/public dev fallback/);
    expect(() => new EmailObservationGatewayService({ sharedSecret: 'short' })).toThrow(/too weak/);
  });

  it('accepts a strong secret, and the dev fallback only in development', () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_OBSERVATION_GATEWAY_SECRET = SECRET;
    expect(resolveEmailGatewaySecret()).toBe(SECRET);
    process.env.NODE_ENV = 'development';
    delete process.env.EMAIL_OBSERVATION_GATEWAY_SECRET;
    expect(resolveEmailGatewaySecret()).toBe('dev-email-observation-gateway-secret');
  });
});
