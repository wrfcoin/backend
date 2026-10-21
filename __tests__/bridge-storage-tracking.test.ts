import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../server/utils/logger.js', () => ({
  crossChainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock(
  'drizzle-orm',
  () => ({
    sql: jest.fn(),
  }),
  { virtual: true }
);

jest.mock(
  'kubo-rpc-client',
  () => ({
    create: jest.fn(),
  }),
  { virtual: true }
);

jest.mock(
  'axios',
  () => ({
    __esModule: true,
    default: {
      create: jest.fn(),
    },
  }),
  { virtual: true }
);

const axelarBridge = require('../server/axelar/bridge.js');
const layerZeroBridge = require('../server/layer-zero/bridge.js');
const evmAdapter = require('../server/axelar/evm-adapter.js');
const {
  DistributedStorageProviders,
} = require('../server/services/distributed-storage-providers.ts');

describe('bridge and storage tracking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('tracks Axelar transfers in-memory and surfaces the same record via status/recent lookups', async () => {
    const transfer = await axelarBridge.executeTokenTransfer({
      sourceChain: 'ethereum',
      destinationChain: 'wrfcoin',
      sender: '0xabc123',
      recipient: 'wrf1bridge',
      asset: 'axlUSDC',
      amount: '25',
    });

    const status = await axelarBridge.getTransactionStatus(transfer.id);
    const recent = await axelarBridge.getRecentTransactions(5);

    expect(transfer.id).toMatch(/^axl-transfer-/);
    expect(status).toEqual(transfer);
    expect(recent).toEqual(expect.arrayContaining([transfer]));
  });

  it('tracks LayerZero messages and transfers instead of falling back to fabricated addresses', async () => {
    const message = await layerZeroBridge.sendMessage({
      sourceChainId: 1,
      destinationChainId: 9999,
      sender: '0xfeedbeef',
      receiver: 'wrf1receiver',
      payload: { route: 'nft-bridge' },
    });

    const transfer = await layerZeroBridge.transferTokens({
      sourceChainId: 1,
      destinationChainId: 9999,
      tokenType: 'ERC20',
      tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
      senderAddress: '0xfeedbeef',
      recipientAddress: 'wrf1receiver',
      amount: '10',
    });

    const messageStatus = await layerZeroBridge.getMessageStatus(message.messageId);
    const transferStatus = await layerZeroBridge.getTransferStatus(transfer.transferId);

    expect(messageStatus).toEqual(message);
    expect(transferStatus).toEqual(transfer);
    expect(messageStatus.sender).toBe('0xfeedbeef');
    expect(transferStatus.recipientAddress).toBe('wrf1receiver');
  });

  it('round-trips Axelar EVM payloads through the lightweight encoder', () => {
    const payload = {
      method: 'sendToken',
      params: {
        destinationChain: 'wrfcoin',
        amount: '42',
        memo: 'launch-testnet',
      },
    };

    const encoded = evmAdapter.encodePayload(payload);
    const decoded = evmAdapter.decodePayload(encoded);

    expect(encoded).toMatch(/^[0-9a-f]+$/);
    expect(decoded).toEqual(payload);
  });

  it('tracks storage deals and provider stats for filecoin, arweave, and storj', async () => {
    const providers = new DistributedStorageProviders();
    const file = {
      data: Buffer.from('storm-sample-data'),
      originalName: 'storm.json',
      mimeType: 'application/json',
      size: 17,
      checksum: 'checksum-1',
    };

    (providers as any).isInitialized = true;
    (providers as any).providers.set('filecoin', {
      name: 'Filecoin',
      type: 'FILECOIN',
      isConfigured: true,
      isHealthy: true,
      lastHealthCheck: new Date(),
      features: [],
    });
    (providers as any).providers.set('arweave', {
      name: 'Arweave',
      type: 'ARWEAVE',
      isConfigured: true,
      isHealthy: true,
      lastHealthCheck: new Date(),
      features: [],
    });
    (providers as any).providers.set('storj', {
      name: 'Storj',
      type: 'STORJ',
      isConfigured: true,
      isHealthy: true,
      lastHealthCheck: new Date(),
      features: [],
    });
    (providers as any).ipfsClient = {
      add: jest.fn().mockResolvedValue({
        cid: { toString: () => 'bafy-test-cid' },
        size: file.size,
      }),
    };
    (providers as any).arweaveClient = {
      post: jest.fn().mockResolvedValue({}),
    };
    (providers as any).storjClient = {
      put: jest.fn().mockResolvedValue({}),
    };

    const filecoinResult = await providers.store('file-1', file, 'filecoin');
    const arweaveResult = await providers.store('file-2', file, 'arweave');
    const storjResult = await providers.store('file-3', file, 'storj');

    expect(filecoinResult.metadata.dealId).toMatch(/^deal_/);
    expect(arweaveResult.txId).toBeDefined();
    expect(storjResult.metadata.dealId).toMatch(/^storj_/);

    expect(providers.getStorageStatus(filecoinResult.metadata.dealId)).toMatchObject({
      provider: 'filecoin',
      fileId: 'file-1',
      storagePath: 'bafy-test-cid',
    });

    expect(providers.listDeals('arweave')).toHaveLength(1);
    expect(providers.getStorageStats('storj')).toEqual([
      expect.objectContaining({
        provider: 'storj',
        dealCount: 1,
        totalBytesStored: file.size,
      }),
    ]);
  });
});
