import express from 'express';
import request from 'supertest';

import {
  createOperatorProfileRouter,
} from '../../server/routes/operator-profile-routes.js';

type Row = Record<string, unknown>;

function makeDb(responses: { rows: Row[] }[]) {
  let call = 0;
  return {
    execute: jest.fn(async () => responses[call++] ?? { rows: [] }),
  };
}

function makeApp(db: { execute: jest.Mock }) {
  const app = express();
  app.use(express.json());
  app.use('/api/operators', createOperatorProfileRouter(db as any));
  return app;
}

describe('operator profile routes', () => {
  it('accepts WRFCoin native addresses for profile lookups', async () => {
    const nativeWallet = 'wrf' + 'a'.repeat(40);
    const db = makeDb([
      { rows: [{ id: 'user-1', wallet_address: nativeWallet, created_at: '2026-01-15T00:00:00.000Z' }] },
      { rows: [{ total_submissions: 12, last_submission: '2026-03-27T09:12:00.000Z', avg_quality: 94.2 }] },
      { rows: [{ station_count: 1 }] },
      { rows: [{ longest_streak: 5 }] },
      { rows: [{ current_streak: 2 }] },
      { rows: [{ total_rewards: '1200' }] },
      { rows: [{ rank: 17 }] },
      { rows: [] },
    ]);
    const app = makeApp(db);

    const res = await request(app).get(`/api/operators/${nativeWallet}/profile`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.profile.walletAddress).toBe(nativeWallet);
    expect(res.body.profile.totalSubmissions).toBe(12);
  });
});
