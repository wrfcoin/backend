import {
  __resetWormholeTransferTestState,
  getWormholeTransfer,
  initiateOutboundTransfer,
  processInboundTransfer,
} from '../server/services/wormhole-transfer-service.js';

describe('wormhole-transfer-service', () => {
  const originalMode = process.env.WORMHOLE_TEST_MODE;

  beforeAll(() => {
    process.env.WORMHOLE_TEST_MODE = 'mock';
  });

  afterAll(() => {
    process.env.WORMHOLE_TEST_MODE = originalMode;
  });

  beforeEach(() => {
    __resetWormholeTransferTestState();
  });

  it('processes inbound transfer and stores status', async () => {
    const record = await processInboundTransfer({
      emitterChain: 2,
      emitterAddress: '0xabc',
      sequence: '1',
      recipient: '0x1111111111111111111111111111111111111111',
      amount: '100',
    }, {
      execute: jest.fn(async () => ({ rows: [] })),
    } as any);

    expect(record.direction).toBe('inbound');
    expect(record.status).toBe('mint_submitted');

    const loaded = await getWormholeTransfer(record.transferId, {
      execute: jest.fn(async () => ({ rows: [] })),
    } as any);
    expect(loaded?.transferId).toBe(record.transferId);
  });

  it('rejects replayed inbound VAA key', async () => {
    const req = {
      emitterChain: 2,
      emitterAddress: '0xabc',
      sequence: '1',
      recipient: '0x1111111111111111111111111111111111111111',
    };
    await processInboundTransfer(req, {
      execute: jest.fn(async () => ({ rows: [] })),
    } as any);

    await expect(
      processInboundTransfer(req, {
        execute: jest.fn(async () => ({ rows: [] })),
      } as any)
    ).rejects.toThrow('VAA replay detected');
  });

  it('creates outbound attestation record', async () => {
    const record = await initiateOutboundTransfer({
      sender: '0x1111111111111111111111111111111111111111',
      recipient: '0x2222222222222222222222222222222222222222',
      amount: '50',
    }, {
      execute: jest.fn(async () => ({ rows: [] })),
    } as any);

    expect(record.direction).toBe('outbound');
    expect(record.status).toBe('attested');
    expect(record.data).toHaveProperty('attestation');
  });
});
