import {
  EmailObservationGatewayService,
  EMAIL_INGEST_ROUTE,
  MAX_EMAIL_BODY_BYTES,
  extractEnvelopeText,
  normalizeSender,
  resolveEmailGatewaySecret,
} from '../../server/services/email-observation-gateway-service.js';
import {
  encodeCompactSmsObservationEnvelope,
  signCompactSmsObservationEnvelope,
} from '../../server/services/sms-observation-gateway-service.js';

// Fixtures only: no mailbox, no provider, no network.
const SECRET = 'email-test-secret-0123456789';
const SMS_SECRET = 'sms-test-secret-0123456789ab';

function envelope(secret = SECRET, mid = 'email-msg-1', obs = { ts: 1_772_758_800, tmp: 21.1, hum: 49 }) {
  const unsigned = { v: 1 as const, mid, sid: 'EMAIL-STATION-1', ts: obs.ts, obs };
  return encodeCompactSmsObservationEnvelope({
    ...unsigned,
    sig: signCompactSmsObservationEnvelope(unsigned, secret),
  });
}

function emailBody(env: string) {
  return ['Hi,', '', `WRF1:${env}`, '', '-- ', 'Sent from my phone', '> quoted reply'].join('\n');
}

function service(calls: any[] = []) {
  return new EmailObservationGatewayService({
    sharedSecret: SECRET,
    weatherIngestor: async (input: any) => {
      calls.push(input);
      return { status: 201, body: { success: true, id: `weather-email-${calls.length}` }, canonicalized: {} as any };
    },
    nowFn: () => new Date('2026-10-28T00:00:00Z'),
  });
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
    expect(entry.sender).toBe('observer@example.org');
    expect(entry.stationId).toBe('EMAIL-STATION-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].route).toBe(EMAIL_INGEST_ROUTE);
    expect(calls[0].transportMeta.transport).toBe('email');
    expect(calls[0].payload).toEqual({
      schema_version: 'wrf.weather.observation.v1',
      station_id: 'EMAIL-STATION-1',
      observed_at_unix: 1_772_758_800,
      observation: { temperature_c: 21.1, humidity: 49 },
    });
  });

  it('rejects an envelope signed with any other secret, including the SMS secret', async () => {
    const calls: any[] = [];
    await expect(
      service(calls).ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body: emailBody(envelope(SMS_SECRET)) })
    ).rejects.toThrow(/Invalid compact envelope signature/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a body with no envelope and an oversize body, without ingesting', async () => {
    const calls: any[] = [];
    const svc = service(calls);
    await expect(svc.ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body: 'temp 21C, humid 49%' }))
      .rejects.toThrow(/no WRF1 observation envelope/);
    await expect(
      svc.ingestInboundEmail({ messageId: 'm2', sender: 'a@b.c', body: emailBody(envelope()) + 'x'.repeat(MAX_EMAIL_BODY_BYTES) })
    ).rejects.toThrow(/exceeds/);
    expect(calls).toHaveLength(0);
  });

  it('dedups by message id and by payload hash', async () => {
    const calls: any[] = [];
    const svc = service(calls);
    const body = emailBody(envelope());
    expect((await svc.ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body })).deliveryState).toBe('processed');
    expect((await svc.ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body })).deliveryState).toBe('duplicate');
    const resent = emailBody(envelope(SECRET, 'email-msg-2'));
    expect((await svc.ingestInboundEmail({ messageId: 'm2', sender: 'a@b.c', body: resent })).deliveryState).toBe('duplicate');
    expect(calls).toHaveLength(1);
  });

  it('queues for retry when the ingestor fails, then delivers on flush', async () => {
    let fail = true;
    let now = new Date('2026-10-28T00:00:00Z');
    const svc = new EmailObservationGatewayService({
      sharedSecret: SECRET,
      retryDelayMs: 1000,
      nowFn: () => now,
      weatherIngestor: async () => {
        if (fail) throw new Error('ingest down');
        return { status: 201, body: { success: true, id: 'w1' }, canonicalized: {} as any };
      },
    });
    const first = await svc.ingestInboundEmail({ messageId: 'm1', sender: 'a@b.c', body: emailBody(envelope()) });
    expect(first.deliveryState).toBe('queued_for_retry');
    fail = false;
    now = new Date(now.getTime() + 1000);
    const flushed = await svc.flushReadyQueue(now);
    expect(flushed.map(e => e.deliveryState)).toEqual(['processed']);
  });

  it('extracts the envelope line and a bare JSON envelope, and normalizes senders', () => {
    expect(extractEnvelopeText('x\n  WRF1: abc_DEF-123  \ny')).toBe('abc_DEF-123');
    expect(extractEnvelopeText('{"v":1}')).toBe('{"v":1}');
    expect(extractEnvelopeText('WRF1:bad chars!')).toBeNull();
    expect(normalizeSender(' Name <ME@Host.ORG> ')).toBe('me@host.org');
    expect(normalizeSender('ME@host.org')).toBe('me@host.org');
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
