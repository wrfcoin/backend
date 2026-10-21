import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetVotingParticipation = jest.fn();
const mockGetProposalSuccessRates = jest.fn();
const mockGetTreasuryUtilization = jest.fn();
const mockGetGovernanceStats = jest.fn();
const mockGetProposal = jest.fn();
const mockGetVoter = jest.fn();
const mockGetCurrentVotingPower = jest.fn();

jest.mock('express-rate-limit', () =>
  jest.fn(() => (_req: any, _res: any, next: any) => next())
);

jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  format: {
    combine: jest.fn(() => ({})),
    timestamp: jest.fn(() => ({})),
    json: jest.fn(() => ({})),
    simple: jest.fn(() => ({})),
  },
  transports: {
    File: jest.fn(),
    Console: jest.fn(),
  },
}));

jest.mock('../../blockchain/services/governance-blockchain-service.js', () => ({
  governanceBlockchainService: {
    getVotingParticipation: mockGetVotingParticipation,
    getProposalSuccessRates: mockGetProposalSuccessRates,
    getTreasuryUtilization: mockGetTreasuryUtilization,
    getGovernanceStats: mockGetGovernanceStats,
    getProposal: mockGetProposal,
    getVoter: mockGetVoter,
    getCurrentVotingPower: mockGetCurrentVotingPower,
  },
}));

jest.mock('ethers', () => ({
  ethers: {
    parseEther: jest.fn(() => BigInt(1)),
    isAddress: jest.fn(
      (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value)
    ),
  },
}));

import router from '../../api/governance-analytics.ts';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/governance', router);
  return app;
}

describe('governance-analytics API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetVotingParticipation.mockResolvedValue({
      totalTokenHolders: 10,
      activeVoters: 3,
      delegatedVoters: 2,
    });
    mockGetProposalSuccessRates.mockResolvedValue({ total: 5, passed: 4 });
    mockGetTreasuryUtilization.mockResolvedValue({ totalBalance: '1000 WRF' });
    mockGetGovernanceStats.mockResolvedValue({ activeProposals: 2 });
    mockGetProposal.mockResolvedValue({ id: 1, title: 'Test proposal' });
    mockGetVoter.mockResolvedValue({ address: '0x1111111111111111111111111111111111111111' });
    mockGetCurrentVotingPower.mockResolvedValue(BigInt(7));
  });

  it('returns blockchain participation when service call succeeds', async () => {
    const res = await request(makeApp()).get('/governance/participation');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.source).toBe('blockchain');
    expect(res.body.data.activeVoters).toBe(3);
  });

  it('falls back when blockchain participation fails', async () => {
    mockGetVotingParticipation.mockRejectedValueOnce(new Error('rpc unavailable'));

    const res = await request(makeApp()).get('/governance/participation');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.source).toBe('fallback');
    expect(res.body.data).toBeDefined();
  });

  it('validates timeframe query for historical endpoint', async () => {
    const res = await request(makeApp()).get('/governance/historical?timeframe=invalid');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/timeframe must be one of/i);
  });

  it('rejects malformed voter addresses', async () => {
    const res = await request(makeApp()).get('/governance/voter/not-an-address');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid Ethereum address');
  });
});
