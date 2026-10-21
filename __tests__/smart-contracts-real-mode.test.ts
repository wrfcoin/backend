import express from 'express';
import request from 'supertest';

describe('smart contracts real blockchain mode', () => {
  const originalUseRealBlockchain = process.env.USE_REAL_BLOCKCHAIN;

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    if (originalUseRealBlockchain === undefined) {
      delete process.env.USE_REAL_BLOCKCHAIN;
    } else {
      process.env.USE_REAL_BLOCKCHAIN = originalUseRealBlockchain;
    }
  });

  async function loadRouterWithEnv() {
    const { USE_REAL_BLOCKCHAIN } = await import('../blockchain/config/networks.js');
    const initialize = jest.fn().mockResolvedValue(undefined);
    const getStatus = jest.fn().mockResolvedValue({
      initialized: true,
      hsmConnected: true,
      hsmMode: 'hardware',
      activeNetworks: ['ethereum'],
      contractCount: 1,
      signerAddress: '0x1111111111111111111111111111111111111111',
    });

    jest.doMock('../blockchain/index.js', () => ({
      USE_REAL_BLOCKCHAIN,
      isValidNetworkId: () => true,
      smartContractService: {
        initialize,
        getStatus,
      },
    }));

    const router = (await import('../api/smart-contracts.js')).default;
    return { router, USE_REAL_BLOCKCHAIN, initialize, getStatus };
  }

  it('defaults to blockchain mode when USE_REAL_BLOCKCHAIN is unset', async () => {
    delete process.env.USE_REAL_BLOCKCHAIN;

    const { router, USE_REAL_BLOCKCHAIN, initialize, getStatus } = await loadRouterWithEnv();
    const app = express();
    app.use('/api/smart-contracts', router);

    const response = await request(app).get('/api/smart-contracts/status');

    expect(USE_REAL_BLOCKCHAIN).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.mode).toBe('blockchain');
    expect(response.body.data.hsmConnected).toBe(true);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('honors USE_REAL_BLOCKCHAIN=false as an explicit mock-mode override', async () => {
    process.env.USE_REAL_BLOCKCHAIN = 'false';

    const { router, USE_REAL_BLOCKCHAIN, initialize, getStatus } = await loadRouterWithEnv();
    const app = express();
    app.use('/api/smart-contracts', router);

    const response = await request(app).get('/api/smart-contracts/status');

    expect(USE_REAL_BLOCKCHAIN).toBe(false);
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.mode).toBe('mock');
    expect(response.body.data.hsmConnected).toBe(false);
    expect(initialize).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
  });
});
