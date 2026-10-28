import { createEmailObservationGatewayRouter } from '../../server/routes/email-observation-gateway-routes.js';
import { EmailObservationGatewayService } from '../../server/services/email-observation-gateway-service.js';
import {
  encodeCompactSmsObservationEnvelope,
  signCompactSmsObservationEnvelope,
} from '../../server/services/sms-observation-gateway-service.js';

// Fixtures only: no mailbox, no provider, no network.
const SECRET = 'email-test-secret-0123456789';

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
  for (const handler of layers(router, method, path)) {
    let advanced = false;
    await handler(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

function signedBody(secret = SECRET) {
  const unsigned = {
    v: 1 as const,
    mid: 'email-msg-1',
    sid: 'EMAIL-STATION-1',
    ts: 1_772_758_800,
    obs: { ts: 1_772_758_800, tmp: 21.1, hum: 49 },
  };
  const env = encodeCompactSmsObservationEnvelope({
    ...unsigned,
    sig: signCompactSmsObservationEnvelope(unsigned, secret),
  });
  return `reading attached\n\nWRF1:${env}\n`;
}

describe('email observation gateway routes', () => {
  const saved = process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS;
  let constructed = 0;
  let svc: EmailObservationGatewayService;
  let router: any;

  beforeEach(() => {
    constructed = 0;
    svc = new EmailObservationGatewayService({
      sharedSecret: SECRET,
      weatherIngestor: async () => ({ status: 201, body: { success: true, id: 'w1' }, canonicalized: {} as any }),
    });
    router = createEmailObservationGatewayRouter(() => {
      constructed += 1;
      return svc;
    });
  });
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
    ['SendGrid', { 'message_id': 's1', from: 'Obs <obs@example.org>', text: signedBody() }],
    ['Mailgun', { 'Message-Id': 'g1', sender: 'obs@example.org', 'body-plain': signedBody() }],
    ['Postmark', { MessageID: 'p1', From: 'obs@example.org', TextBody: signedBody() }],
  ])('accepts a signed envelope in the %s field shape (201)', async (_name, body) => {
    process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = 'true';
    const res = await call(router, 'post', '/observations', { body });
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deliveryState).toBe('processed');
    expect(res.body.data.sender).toBe('obs@example.org');
  });

  it('fails closed: a forged signature or missing fields is 400 and nothing is processed', async () => {
    process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = 'true';
    const forged = await call(router, 'post', '/observations', {
      body: { messageId: 'm1', from: 'a@b.c', text: signedBody('some-other-secret-0123456789') },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.body.error).toMatch(/signature/);
    const missing = await call(router, 'post', '/observations', { body: { from: 'a@b.c', text: signedBody() } });
    expect(missing.statusCode).toBe(400);
    expect(svc.listQueue().filter(e => e.deliveryState === 'processed')).toHaveLength(0);
  });

  it('returns 200 for a duplicate delivery of the same message', async () => {
    process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = 'true';
    const body = { messageId: 'm1', from: 'a@b.c', text: signedBody() };
    expect((await call(router, 'post', '/observations', { body })).statusCode).toBe(201);
    const again = await call(router, 'post', '/observations', { body });
    expect(again.statusCode).toBe(200);
    expect(again.body.data.deliveryState).toBe('duplicate');
  });

  it.each([['on', 'true'], ['off', undefined]])(
    'guards the queue with the operator token before the flag (flag %s)',
    async (_label, flag) => {
      if (flag) process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS = flag;
      else delete process.env.WRFCOIN_ENABLE_EMAIL_OBSERVATIONS;
      const savedToken = process.env.WRFCOIN_OPERATOR_TOKEN;
      process.env.WRFCOIN_OPERATOR_TOKEN = 'fixture-operator-token-0123456789';
      try {
        const res = await call(router, 'get', '/observations/queue', { headers: {}, get: () => undefined, header: () => undefined });
        expect(res.statusCode).toBe(401);
        expect(constructed).toBe(0);
      } finally {
        if (savedToken === undefined) delete process.env.WRFCOIN_OPERATOR_TOKEN;
        else process.env.WRFCOIN_OPERATOR_TOKEN = savedToken;
      }
    }
  );
});
