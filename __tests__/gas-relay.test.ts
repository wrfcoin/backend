import express from 'express';
import request from 'supertest';

// Mock the gas-relay-service before importing the router
const mockBuildPaymasterAndData = jest.fn();
jest.mock('../server/services/gas-relay-service.js', () => ({
  WEATHER_SELECTOR: '0xdeadbeef',
  buildPaymasterAndData: mockBuildPaymasterAndData,
}));

// Import after mock is set up
import { createGasRelayRouter } from '../server/routes/gas-relay-routes.js';

type Row = Record<string, unknown>;

function makeDb(responses: { rows: Row[] }[]) {
  let call = 0;
  return {
    execute: jest.fn(async (_sql: string, _params?: unknown[]) => {
      return responses[call++] ?? { rows: [] };
    }),
  };
}

function makeApp(db: { execute: jest.Mock }) {
  const app = express();
  app.use(express.json());
  app.use('/api/gas', createGasRelayRouter(db as any));
  return app;
}

const VALID_ADDR = '0xaBcD1234567890aBcD1234567890aBcD12345678';
const VALID_CALL_DATA = '0xdeadbeef' + '00'.repeat(32); // starts with WEATHER_SELECTOR

beforeEach(() => {
  jest.clearAllMocks();
  mockBuildPaymasterAndData.mockResolvedValue({
    paymasterAndData: '0xpaymasterdata',
    deadline: 9999999999,
    weatherDataHash: '0xhash',
    oracle: VALID_ADDR,
  });
});

describe('POST /api/gas/sponsor', () => {
  it('returns paymasterAndData for eligible wallet', async () => {
    const db = makeDb([
      { rows: [{ '?column?': 1 }] }, // social_accounts exists
      { rows: [{ cnt: 0 }] },        // lifetime count < limit
      { rows: [{ cnt: 0 }] },        // daily count < 10
      { rows: [] },                   // INSERT log
    ]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/gas/sponsor')
      .send({
        walletAddress: VALID_ADDR,
        userOp: { callData: VALID_CALL_DATA, nonce: 1 },
      });

    expect(res.status).toBe(200);
    expect(res.body.paymasterAndData).toBe('0xpaymasterdata');
    expect(mockBuildPaymasterAndData).toHaveBeenCalledWith({
      sender: VALID_ADDR,
      nonce: 1,
      callData: VALID_CALL_DATA,
    });
  });

  it('returns 403 when no social account is linked', async () => {
    const db = makeDb([
      { rows: [] }, // social_accounts empty
    ]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/gas/sponsor')
      .send({
        walletAddress: VALID_ADDR,
        userOp: { callData: VALID_CALL_DATA, nonce: 0 },
      });

    expect(res.status).toBe(403);
    expect(mockBuildPaymasterAndData).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limit is exceeded', async () => {
    const db = makeDb([
      { rows: [{ '?column?': 1 }] }, // social account exists
      { rows: [{ cnt: 0 }] },        // lifetime count under limit
      { rows: [{ cnt: 10 }] },       // daily count >= 10
    ]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/gas/sponsor')
      .send({
        walletAddress: VALID_ADDR,
        userOp: { callData: VALID_CALL_DATA, nonce: 0 },
      });

    expect(res.status).toBe(429);
    expect(mockBuildPaymasterAndData).not.toHaveBeenCalled();
  });

  it('returns 403 when lifetime sponsorship limit is exceeded', async () => {
    process.env.GAS_SPONSOR_FREE_TX_LIMIT = '2';
    const db = makeDb([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ cnt: 2 }] }, // lifetime >= limit
    ]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/gas/sponsor')
      .send({
        walletAddress: VALID_ADDR,
        userOp: { callData: VALID_CALL_DATA, nonce: 0 },
      });

    expect(res.status).toBe(403);
    expect(mockBuildPaymasterAndData).not.toHaveBeenCalled();
    delete process.env.GAS_SPONSOR_FREE_TX_LIMIT;
  });

  it('returns 400 when callData selector does not match', async () => {
    const db = makeDb([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ cnt: 0 }] },
      { rows: [{ cnt: 0 }] },
    ]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/gas/sponsor')
      .send({
        walletAddress: VALID_ADDR,
        userOp: { callData: '0xcafebabe00000000', nonce: 0 },
      });

    expect(res.status).toBe(400);
    expect(mockBuildPaymasterAndData).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed walletAddress', async () => {
    const db = makeDb([]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/gas/sponsor')
      .send({
        walletAddress: 'not-a-wallet',
        userOp: { callData: VALID_CALL_DATA, nonce: 0 },
      });

    expect(res.status).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
