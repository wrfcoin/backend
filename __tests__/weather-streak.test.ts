import express from 'express';
import request from 'supertest';
import { createWeatherStreakRouter } from '../server/routes/weather-streak-routes.js';

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
  app.use('/api/weather/streak', createWeatherStreakRouter(db as any));
  return app;
}

const VALID_ADDR = '0xaBcD1234567890aBcD1234567890aBcD12345678';

describe('GET /api/weather/streak/:walletAddress', () => {
  it('returns streak data for a valid address', async () => {
    const db = makeDb([
      { rows: [{ id: 42 }] },              // users lookup
      { rows: [{ current_streak: 5 }] },   // current streak CTE
      { rows: [{ longest_streak: 12 }] },  // longest streak
      { rows: [] },                         // claimed milestones
    ]);

    const app = makeApp(db);
    const res = await request(app).get(`/api/weather/streak/${VALID_ADDR}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      currentStreak: 5,
      longestStreak: 12,
      nextMilestone: 7,
      milestoneReached: false,
    });
  });

  it('returns 400 for an invalid wallet address', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/streak/not-an-address');
    expect(res.status).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('returns currentStreak 0 when no submissions today', async () => {
    const db = makeDb([
      { rows: [{ id: 7 }] },
      { rows: [{ current_streak: 0 }] },
      { rows: [{ longest_streak: 3 }] },
      { rows: [] },
    ]);
    const app = makeApp(db);
    const res = await request(app).get(`/api/weather/streak/${VALID_ADDR}`);
    expect(res.status).toBe(200);
    expect(res.body.currentStreak).toBe(0);
    expect(res.body.milestoneReached).toBe(false);
  });

  it('returns nextMilestone null when all milestones claimed', async () => {
    const db = makeDb([
      { rows: [{ id: 1 }] },
      { rows: [{ current_streak: 100 }] },
      { rows: [{ longest_streak: 100 }] },
      { rows: [{ milestone_days: 7 }, { milestone_days: 30 }, { milestone_days: 90 }] },
    ]);
    const app = makeApp(db);
    const res = await request(app).get(`/api/weather/streak/${VALID_ADDR}`);
    expect(res.status).toBe(200);
    expect(res.body.nextMilestone).toBeNull();
    expect(res.body.milestoneReached).toBe(false);
  });

  it('returns currentStreak 0 when user not found', async () => {
    const db = makeDb([
      { rows: [] }, // user not found
      { rows: [] }, // claimed milestones (still queried)
    ]);
    const app = makeApp(db);
    const res = await request(app).get(`/api/weather/streak/${VALID_ADDR}`);
    expect(res.status).toBe(200);
    expect(res.body.currentStreak).toBe(0);
    expect(res.body.longestStreak).toBe(0);
  });
});

describe('POST /api/weather/streak/mint-trigger', () => {
  it('records a milestone claim', async () => {
    const db = makeDb([
      { rows: [] }, // INSERT ON CONFLICT DO NOTHING
    ]);
    const app = makeApp(db);
    const res = await request(app)
      .post('/api/weather/streak/mint-trigger')
      .send({ walletAddress: VALID_ADDR, milestoneLevel: 7, txHash: '0xabc' });

    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(true);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.execute.mock.calls[0][1]).toEqual([VALID_ADDR, 7, '0xabc']);
  });

  it('returns 400 for invalid walletAddress', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app)
      .post('/api/weather/streak/mint-trigger')
      .send({ walletAddress: 'bad', milestoneLevel: 7 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid milestoneLevel', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app)
      .post('/api/weather/streak/mint-trigger')
      .send({ walletAddress: VALID_ADDR, milestoneLevel: 14 });
    expect(res.status).toBe(400);
  });

  it('POST /mint-trigger is not shadowed by GET /:walletAddress param', async () => {
    // Verifies route ordering: POST /mint-trigger must not be matched as /:walletAddress
    const db = makeDb([{ rows: [] }]);
    const app = makeApp(db);
    const res = await request(app)
      .post('/api/weather/streak/mint-trigger')
      .send({ walletAddress: VALID_ADDR, milestoneLevel: 30 });
    // Should hit the mint-trigger handler, not the GET param handler
    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(true);
  });
});
