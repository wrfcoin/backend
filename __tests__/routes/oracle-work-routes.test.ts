import express from 'express';
import request from 'supertest';
import {
  createOracleWorkRouter,
} from '../../server/routes/oracle-work-routes.js';
import type { VerifiedMinedApproval, VerifiedOraclePrincipal } from '../../server/services/oracle-work-broker.js';

const verified: VerifiedOraclePrincipal = {
  verified: true,
  oracleId: 'workstation',
  audience: 'wrfcoin.oracle-work',
  scopes: ['wrfcoin.oracle-work.read', 'wrfcoin.oracle-work.claim', 'wrfcoin.oracle-work.result'],
};

const minedApproval: VerifiedMinedApproval = {
  verified: true,
  workId: 'work:1',
  genesisHash: 'genesis-a',
  oracleId: 'workstation',
  attestationVersion: 1,
  commitId: 'commit-1',
  commitHash: 'hash-1',
  core4TxId: 'tx-workstation',
  minedAt: '2026-08-02T12:00:00.000Z',
  receipt: {
    verified: true,
    status: 'MINED',
    genesisHash: 'genesis-a',
    commitId: 'commit-1',
    commitHash: 'hash-1',
    core4TxId: 'tx-workstation',
    minedAt: '2026-08-02T12:00:00.000Z',
  },
};

function appFor(
  principal: VerifiedOraclePrincipal | null,
  readback: VerifiedMinedApproval | null = null,
  spoofRequestProperty = false,
) {
  const app = express();
  app.use(express.json());
  if (spoofRequestProperty) {
    app.use((req, _res, next) => {
      (req as typeof req & { oraclePrincipal?: VerifiedOraclePrincipal }).oraclePrincipal = {
        ...verified,
        oracleId: 'n5pro',
      };
      next();
    });
  }
  const broker = {
    getWork: jest.fn().mockResolvedValue({ work: { workId: 'work:1' }, ownClaim: null }),
    claimWork: jest.fn().mockResolvedValue({ claim: { workId: 'work:1' }, leaseToken: 'test-only-lease' }),
    recordResult: jest.fn().mockResolvedValue({ claim: { workId: 'work:1' }, idempotent: false }),
    reconcileMinedApproval: jest.fn().mockResolvedValue({ mined: true, quorumMined: false, reveal: { eligible: false } }),
  };
  app.use('/private/oracle-work', createOracleWorkRouter({
    broker: broker as never,
    resolvePrincipal: () => principal,
    resolveMinedApproval: () => readback,
  }));
  return { app, broker };
}

test('fails closed when no verified principal is injected', async () => {
  const { app } = appFor(null);
  const response = await request(app).get('/private/oracle-work/work:1');
  expect(response.status).toBe(401);
  expect(response.body.error.code).toBe('ORACLE_PRINCIPAL_REQUIRED');
});


test('requires the endpoint scope before invoking the broker', async () => {
  const { app, broker } = appFor({ ...verified, scopes: ['wrfcoin.oracle-work.read'] });
  const response = await request(app).post('/private/oracle-work/work:1/claim');
  expect(response.status).toBe(401);
  expect(broker.claimWork).not.toHaveBeenCalled();
});

test('passes the injected logical oracle principal to claim and result operations', async () => {
  const { app, broker } = appFor(verified);
  expect((await request(app).post('/private/oracle-work/work:1/claim')).status).toBe(200);
  expect((await request(app).post('/private/oracle-work/work:1/result').send({
    leaseVersion: 1,
    leaseToken: 'opaque',
    idempotencyKey: 'idem:1',
    approved: true,
  })).status).toBe(200);
  expect(broker.claimWork).toHaveBeenCalledWith(verified, 'work:1');
  expect(broker.recordResult).toHaveBeenCalledWith(expect.objectContaining(verified), expect.objectContaining({ workId: 'work:1' }));
});

test('ignores a mutable request-property identity spoof', async () => {
  const { app, broker } = appFor(verified, null, true);
  const response = await request(app).post('/private/oracle-work/work:1/claim');

  expect(response.status).toBe(200);
  expect(broker.claimWork).toHaveBeenCalledWith(verified, 'work:1');
});

test('routes only an injected mined readback to reconciliation', async () => {
  const { app, broker } = appFor(verified, minedApproval);
  const response = await request(app).post('/private/oracle-work/work:1/mined-approval');

  expect(response.status).toBe(200);
  expect(broker.reconcileMinedApproval).toHaveBeenCalledWith(minedApproval);
});

test('rejects a mined readback owned by the other oracle before reconciliation', async () => {
  const otherOracleReadback: VerifiedMinedApproval = {
    ...minedApproval,
    oracleId: 'n5pro',
    core4TxId: 'tx-n5pro',
    receipt: { ...minedApproval.receipt, core4TxId: 'tx-n5pro' },
  };
  const { app, broker } = appFor(verified, otherOracleReadback);
  const response = await request(app).post('/private/oracle-work/work:1/mined-approval');

  expect(response.status).toBe(403);
  expect(response.body.error.code).toBe('ORACLE_SCOPE_FORBIDDEN');
  expect(broker.reconcileMinedApproval).not.toHaveBeenCalled();
});

test('fails closed when no mined readback adapter is injected', async () => {
  const { app } = appFor(verified);
  const response = await request(app).post('/private/oracle-work/work:1/mined-approval');

  expect(response.status).toBe(503);
  expect(response.body.error.code).toBe('CORE4_READBACK_REQUIRED');
});
