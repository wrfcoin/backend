import crypto from 'crypto';
import {
  SmsObservationGatewayService,
  encodeCompactSmsObservationEnvelope,
  signCompactSmsObservationEnvelope,
} from '../../server/services/sms-observation-gateway-service.js';

function buildTextEnvelope(input: {
  messageId: string;
  stationId: string;
  ts: number;
  obs: Record<string, unknown>;
  secret?: string;
}) {
  const sharedSecret = input.secret || 'test-secret';
  const unsigned = {
    v: 1 as const,
    mid: input.messageId,
    sid: input.stationId,
    ts: input.ts,
    obs: input.obs,
  };
  const sig = signCompactSmsObservationEnvelope(unsigned, sharedSecret);
  return encodeCompactSmsObservationEnvelope({ ...unsigned, sig });
}

describe('SmsObservationGatewayService', () => {
  it('processes signed compact observations and deduplicates repeats', async () => {
    const weatherIngestor = jest.fn(async () => ({
      status: 201,
      body: { success: true, id: 'weather-1' },
      canonicalized: {} as any,
    }));

    const service = new SmsObservationGatewayService({
      sharedSecret: 'test-secret',
      weatherIngestor,
      nowFn: () => new Date('2026-03-06T10:00:00Z'),
    });

    const text = buildTextEnvelope({
      messageId: 'msg-1',
      stationId: 'STATION-1',
      ts: 1_772_758_800,
      obs: { ts: 1_772_758_800, tmp: 22.4, hum: 48 },
    });

    const first = await service.ingestInboundMessage({
      messageId: 'msg-1',
      sender: '+15555550101',
      text,
    });
    const second = await service.ingestInboundMessage({
      messageId: 'msg-1',
      sender: '+15555550101',
      text,
    });

    expect(first.deliveryState).toBe('processed');
    expect(first.duplicate).toBe(false);
    expect(second.deliveryState).toBe('duplicate');
    expect(second.duplicate).toBe(true);
    expect(weatherIngestor).toHaveBeenCalledTimes(1);
  });

  it('marks older arrivals as delayed while still accepting them', async () => {
    const weatherIngestor = jest.fn(async () => ({
      status: 201,
      body: { success: true, id: crypto.randomUUID() },
      canonicalized: {} as any,
    }));
    const service = new SmsObservationGatewayService({
      sharedSecret: 'test-secret',
      weatherIngestor,
      nowFn: () => new Date('2026-03-06T12:00:00Z'),
    });

    const newer = buildTextEnvelope({
      messageId: 'msg-new',
      stationId: 'STATION-2',
      ts: 1_772_762_400,
      obs: { ts: 1_772_762_400, tmp: 24.1 },
    });
    const older = buildTextEnvelope({
      messageId: 'msg-old',
      stationId: 'STATION-2',
      ts: 1_772_758_800,
      obs: { ts: 1_772_758_800, tmp: 20.2 },
    });

    const first = await service.ingestInboundMessage({
      messageId: 'msg-new',
      sender: '+15555550102',
      text: newer,
    });
    const second = await service.ingestInboundMessage({
      messageId: 'msg-old',
      sender: '+15555550102',
      text: older,
    });

    expect(first.delayed).toBe(false);
    expect(second.deliveryState).toBe('processed');
    expect(second.delayed).toBe(true);
  });

  it('queues retries for transient ingest failures and flushes them later', async () => {
    let attempts = 0;
    const weatherIngestor = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary downstream failure');
      }
      return {
        status: 201,
        body: { success: true, id: 'weather-retry-1' },
        canonicalized: {} as any,
      };
    });

    let now = Date.parse('2026-03-06T10:00:00Z');
    const service = new SmsObservationGatewayService({
      sharedSecret: 'test-secret',
      weatherIngestor,
      nowFn: () => new Date(now),
      retryDelayMs: 5_000,
    });

    const text = buildTextEnvelope({
      messageId: 'msg-retry',
      stationId: 'STATION-3',
      ts: 1_772_758_800,
      obs: { ts: 1_772_758_800, tmp: 18.5, hum: 60 },
    });

    const first = await service.ingestInboundMessage({
      messageId: 'msg-retry',
      sender: '+15555550103',
      text,
    });
    expect(first.deliveryState).toBe('queued_for_retry');

    now += 6_000;
    const retried = await service.flushReadyQueue(new Date(now));
    expect(retried).toHaveLength(1);
    expect(retried[0].deliveryState).toBe('processed');
    expect(weatherIngestor).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed or unsigned compact payloads', async () => {
    const service = new SmsObservationGatewayService({
      sharedSecret: 'test-secret',
    });

    await expect(
      service.ingestInboundMessage({
        messageId: 'msg-bad',
        sender: '+15555550104',
        text: 'not-json-or-base64',
      })
    ).rejects.toThrow();

    const badSigText = buildTextEnvelope({
      messageId: 'msg-bad-sig',
      stationId: 'STATION-4',
      ts: 1_772_758_800,
      obs: { ts: 1_772_758_800, tmp: 15.2 },
      secret: 'wrong-secret',
    });

    await expect(
      service.ingestInboundMessage({
        messageId: 'msg-bad-sig',
        sender: '+15555550104',
        text: badSigText,
      })
    ).rejects.toThrow('Invalid compact envelope signature');
  });
});
