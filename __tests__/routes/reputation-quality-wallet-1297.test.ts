/** backend#1297 (pending owner confirmation): wallet callers and the cross-identity reputation / quality routes. */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const WALLET = '0x' + 'ab'.repeat(20);
const OTHER = '0x' + 'cd'.repeat(20);

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (req: any, _res: any, next: any) => {
    const who = req.get('x-test-caller');
    if (who === 'wallet') req.user = { id: WALLET, userId: WALLET, address: WALLET, role: 'wallet', roles: ['wallet'], permissions: [] };
    if (who === 'admin') req.user = { id: '1', userId: '1', roles: ['admin'], sessionId: 's' };
    if (who === 'operator') req.user = { id: '2', userId: '2', roles: ['operator'], sessionId: 's' };
    if (who === 'session') req.user = { id: '3', userId: '3', roles: ['user'], sessionId: 's' };
    next();
  },
}));

const mockRecordSignal = jest.fn(async (input: any) => ({ id: 1, ...input }));
const mockGetEvents = jest.fn(async () => []);
const mockGetScore = jest.fn(async () => ({ score: 1 }));
jest.mock('../../server/services/reputation/reputation-scoring-engine.js', () => ({
  reputationScoringEngine: {
    recordSignal: mockRecordSignal,
    getEvents: mockGetEvents,
    getScore: mockGetScore,
    getRankings: jest.fn(async () => []),
  },
}));

import reputationRouter from '../../server/routes/reputationRoutes.js';
import { createOperatorQualityRouter } from '../../server/routes/operator-quality-routes.js';

function repApp() {
  const app = express();
  app.use(express.json());
  app.use('/reputation', reputationRouter);
  return app;
}

describe('reputation routes and wallet callers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a wallet token cannot record a reputation event for ANY address (403, recordSignal not reached)', async () => {
    for (const address of [OTHER, WALLET]) {
      const res = await request(repApp()).post('/reputation/events').set('x-test-caller', 'wallet').send({ address, score: 99 });
      expect(res.status).toBe(403);
    }
    expect(mockRecordSignal).not.toHaveBeenCalled();
  });

  it('POST /events is operator-only: admin and operator roles record; an ordinary session user and an anonymous caller do not', async () => {
    for (const who of ['admin', 'operator']) {
      mockRecordSignal.mockClear();
      const res = await request(repApp()).post('/reputation/events').set('x-test-caller', who).send({ address: OTHER, score: 5 });
      expect(res.status).toBe(201);
      expect(mockRecordSignal).toHaveBeenCalledTimes(1);
    }
    mockRecordSignal.mockClear();
    for (const who of ['session', 'none']) {
      const res = await request(repApp()).post('/reputation/events').set('x-test-caller', who).send({ address: OTHER, score: 5 });
      expect(res.status).toBe(403);
    }
    expect(mockRecordSignal).not.toHaveBeenCalled();
  });

  it('a wallet reads only its OWN identity events and score (any case); another identity is 403 with no read', async () => {
    const own = await request(repApp()).get(`/reputation/identities/${WALLET.toUpperCase().replace('0X', '0x')}/score`).set('x-test-caller', 'wallet');
    expect(own.status).toBe(200);
    const ev = await request(repApp()).get(`/reputation/identities/${WALLET}/events`).set('x-test-caller', 'wallet');
    expect(ev.status).toBe(200);
    mockGetEvents.mockClear(); mockGetScore.mockClear();
    for (const p of ['events', 'score']) {
      const res = await request(repApp()).get(`/reputation/identities/${OTHER}/${p}`).set('x-test-caller', 'wallet');
      expect(res.status).toBe(403);
    }
    expect(mockGetEvents).not.toHaveBeenCalled();
    expect(mockGetScore).not.toHaveBeenCalled();
  });
});

describe('quality /my-events and wallet callers', () => {
  const execute = jest.fn(async () => ({ rows: [] }));
  function qApp() {
    const app = express();
    app.use('/quality', createOperatorQualityRouter({ execute } as any));
    return app;
  }
  beforeEach(() => execute.mockClear());

  it('own address is allowed; another address is 403 with no query', async () => {
    expect((await request(qApp()).get(`/quality/my-events?address=${WALLET}`).set('x-test-caller', 'wallet')).status).toBe(200);
    execute.mockClear();
    const res = await request(qApp()).get(`/quality/my-events?address=${OTHER}`).set('x-test-caller', 'wallet');
    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('station-summary takes the same address query and is guarded the same way', async () => {
    execute.mockClear();
    const res = await request(qApp()).get(`/quality/station-summary/dev-1?address=${OTHER}`).set('x-test-caller', 'wallet');
    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a session caller is unchanged', async () => {
    expect((await request(qApp()).get(`/quality/my-events?address=${OTHER}`).set('x-test-caller', 'session')).status).toBe(200);
  });
});
