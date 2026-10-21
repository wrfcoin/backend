import { createSmsObservationGatewayRouter } from '../../server/routes/sms-observation-gateway-routes.js';
import {
  SmsObservationGatewayService,
  encodeCompactSmsObservationEnvelope,
  signCompactSmsObservationEnvelope,
} from '../../server/services/sms-observation-gateway-service.js';

function mockReq(body: any = {}): any {
  return { body };
}

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

function getHandler(router: any, method: string, pathSuffix: string): Function {
  for (const layer of router.stack) {
    if (
      layer.route &&
      layer.route.path === pathSuffix &&
      layer.route.methods[method.toLowerCase()]
    ) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${pathSuffix}`);
}

function buildTextEnvelope() {
  const unsigned = {
    v: 1 as const,
    mid: 'twilio-msg-1',
    sid: 'SMS-STATION-1',
    ts: 1_772_758_800,
    obs: { ts: 1_772_758_800, tmp: 21.1, hum: 49 },
  };
  const sig = signCompactSmsObservationEnvelope(unsigned, 'test-secret');
  return encodeCompactSmsObservationEnvelope({ ...unsigned, sig });
}

describe('sms observation gateway routes', () => {
  it('accepts Twilio-style fields and returns processed data', async () => {
    const service = new SmsObservationGatewayService({
      sharedSecret: 'test-secret',
      weatherIngestor: async () => ({
        status: 201,
        body: { success: true, id: 'weather-sms-1' },
        canonicalized: {} as any,
      }),
    });
    const router = createSmsObservationGatewayRouter(service);
    const res = mockRes();

    await getHandler(router, 'POST', '/observations')(
      mockReq({
        MessageSid: 'twilio-msg-1',
        From: '+15555550105',
        Body: buildTextEnvelope(),
      }),
      res
    );

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deliveryState).toBe('processed');
  });

  it('rejects malformed webhook payloads', async () => {
    const router = createSmsObservationGatewayRouter(
      new SmsObservationGatewayService({ sharedSecret: 'test-secret' })
    );
    const res = mockRes();

    await getHandler(router, 'POST', '/observations')(
      mockReq({
        MessageSid: 'twilio-msg-2',
        From: '+15555550106',
        Body: 'garbage-body',
      }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
