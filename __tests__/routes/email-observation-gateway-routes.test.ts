import { createEmailObservationGatewayRouter } from '../../server/routes/email-observation-gateway-routes.js';
import {
  EmailObservationGatewayService,
  type ReplayStore,
} from '../../server/services/email-observation-gateway-service.js';
import {
  encodeCompactSmsObservationEnvelope,
  signCompactSmsObservationEnvelope,
} from '../../server/services/sms-observation-gateway-service.js';

// Fixtures only: no mailbox, no provider, no network.
const SECRET = 'email-test-secret-0123456789';
const TS = 1_772_758_800;
const NOW = new Date(TS * 1000 + 30_000);

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

function layers(router: any, method: string, path: string): Function[] {
  const route = router.stack.find(
    (layer: any) => layer.route && layer.route.path === path && layer.route.methods[method]
  ).route;
  return route.stack.map((layer: any) => layer.handle);
}

async function call(router: any, method: string, path: string, req: any) {
  const res = mockRes();
  const request = { headers: {}, ...req };
  for (const handler of layers(router, method, path)) {
    let advanced = false;
    await handler(request, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

function signedBody(opts: { secret?: string; mid?: string; tmp?: number } = {}) {
  const unsigned = {
    v: 1 as const,
    mid: opts.mid ?? 'email-msg-1',
    sid: 'EMAIL-STATION-1',
    ts: TS,
    obs: { ts: TS, tmp: opts.tmp ?? 21.1, hum: 49 },
  };
  const env = encodeCompactSmsObservationEnvelope({
    ...unsigned,
    sig: signCompactSmsObservationEnvelope(unsigned, opts.secret ?? SECRET),
  });
  return `reading attached\n\nWRF1:${env}\n`;
}

function memoryStore(): ReplayStore {
  const map = new Map<string, unknown>();
  return {
    async getIdempotency(scope, key) {
      return map.get(`${scope}:${key}`) ?? null;
    },
    async putIdempotency(scope, key, status, body) {
      map.set(`${scope}:${key}`, { status, body });
    },
  };
}

describe('email observation gateway routes', () => {
  const saved = process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS;
  let constructed = 0;
  let svc: EmailObservationGatewayService;
  let router: any;

  function build(extra: Record<string, unknown> = {}) {
    constructed = 0;
    svc = new EmailObservationGatewayService({
      sharedSecret: SECRET,
      replayStore: memoryStore(),
      nowFn: () => NOW,
      weatherIngestor: async () => ({ status: 201, body: { success: true, id: 'w1' }, canonicalized: {} as any }),
      ...extra,
    });
    router = createEmailObservationGatewayRouter(() => {
      constructed += 1;
      return svc;
    });
  }

  beforeEach(() => build());
  afterEach(() => {
    if (saved === undefined) delete process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS;
    else process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = saved;
  });

  it('is dormant (404) while the flag is off, and never builds the service', async () => {
    delete process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS;
    const res = await call(router, 'post', '/observations', {
      body: { messageId: 'm1', from: 'a@b.c', text: signedBody() },
    });
    expect(res.statusCode).toBe(404);
    process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = 'yes';
    expect((await call(router, 'post', '/observations', { body: {} })).statusCode).toBe(404);
    expect(constructed).toBe(0);
  });

  it.each([
    ['SendGrid', { message_id: 's1', from: 'Obs <obs@example.org>', text: signedBody() }],
    ['Mailgun', { 'Message-Id': 'g1', sender: 'obs@example.org', 'body-plain': signedBody() }],
    ['Postmark', { MessageID: 'p1', From: 'obs@example.org', TextBody: signedBody() }],
  ])('accepts a signed envelope in the %s field shape (201) and echoes no sender', async (_name, body) => {
    process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = 'true';
    const res = await call(router, 'post', '/observations', { body });
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deliveryState).toBe('processed');
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['delayed', 'deliveryState', 'duplicate', 'observedAt', 'queueId', 'stationId', 'weatherRecordId'].sort()
    );
    expect(JSON.stringify(res.body)).not.toMatch(/example\.org|es_[0-9a-f]{32}/);
  });

  it('fails closed: a forged signature or missing fields is 400 and nothing is processed', async () => {
    process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = 'true';
    const forged = await call(router, 'post', '/observations', {
      body: { messageId: 'm1', from: 'a@b.c', text: signedBody({ secret: 'some-other-secret-0123456789' }) },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.body.error).toMatch(/signature/);
    const missing = await call(router, 'post', '/observations', { body: { from: 'a@b.c', text: signedBody() } });
    expect(missing.statusCode).toBe(400);
    const noEnvelope = await call(router, 'post', '/observations', { body: { messageId: 'm2', from: 'a@b.c', text: 'just text' } });
    expect(noEnvelope.statusCode).toBe(400);
    expect(svc.listQueue().filter(e => e.deliveryState === 'processed')).toHaveLength(0);
  });

  it('refuses an oversized request: 413 from the declared length and from the body itself', async () => {
    process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = 'true';
    const declared = await call(router, 'post', '/observations', {
      headers: { 'content-length': String(64 * 1024) },
      body: { messageId: 'm1', from: 'a@b.c', text: signedBody() },
    });
    expect(declared.statusCode).toBe(413);
    const body = await call(router, 'post', '/observations', {
      body: { messageId: 'm2', from: 'a@b.c', text: signedBody() + 'x'.repeat(17 * 1024) },
    });
    expect(body.statusCode).toBe(413);
  });

  it('maps a replayed envelope to 409 and a rate cap to 429', async () => {
    process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = 'true';
    build({ senderLimit: { max: 2, windowMs: 60_000 } });
    const body = { messageId: 'm1', from: 'a@b.c', text: signedBody() };
    expect((await call(router, 'post', '/observations', { body })).statusCode).toBe(201);
    const again = await call(router, 'post', '/observations', { body: { ...body, messageId: 'm2' } });
    expect(again.statusCode).toBe(409);
    const capped = await call(router, 'post', '/observations', {
      body: { messageId: 'm3', from: 'a@b.c', text: signedBody({ mid: 'other', tmp: 5 }) },
    });
    expect(capped.statusCode).toBe(429);
  });

  it.each([['on', 'true'], ['off', undefined]])(
    'guards the queue with the operator token before the flag (flag %s)',
    async (_label, flag) => {
      if (flag) process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = flag;
      else delete process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS;
      const savedToken = process.env.WRFCOIN_OPERATOR_TOKEN;
      process.env.WRFCOIN_OPERATOR_TOKEN = 'fixture-operator-token-0123456789';
      try {
        const res = await call(router, 'get', '/observations/queue', { get: () => undefined, header: () => undefined });
        expect(res.statusCode).toBe(401);
        expect(constructed).toBe(0);
      } finally {
        if (savedToken === undefined) delete process.env.WRFCOIN_OPERATOR_TOKEN;
        else process.env.WRFCOIN_OPERATOR_TOKEN = savedToken;
      }
    }
  );
});
