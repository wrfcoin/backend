import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const hashPattern = /^0x[0-9a-f]{64}$/;
const primaryWallet = 'wrf717d72395303fcb2aed4df368f32f1078d18e9cc';
const secondaryWallet = 'wrffb8404050b3727122c74c74887eadccf080ab223';

const mockBlockchainLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const loadSimpleBlockchain = () => {
  jest.resetModules();
  jest.doMock('../server/utils/logger.js', () => ({
    blockchainLogger: mockBlockchainLogger,
  }));

  return require('../blockchain/simple-blockchain');
};

const loadEnhancedBlockchainService = () => {
  jest.resetModules();
  jest.doMock('../server/utils/logger.js', () => ({
    blockchainLogger: mockBlockchainLogger,
  }));
  jest.doMock('../blockchain/rust-blockchain-client.js', () => ({
    __esModule: true,
    RustBlockchainClient: class MockRustBlockchainClient {},
    rustBlockchainClient: {
      isAvailable: jest.fn().mockResolvedValue(false),
    },
    default: {
      isAvailable: jest.fn().mockResolvedValue(false),
    },
  }));

  return require('../blockchain/enhanced-blockchain-service');
};

describe('simple blockchain transaction hashes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('generates canonical transaction IDs with cryptographic hex hashes', () => {
    const { generateTransactionId } = loadSimpleBlockchain();

    const ids = Array.from({ length: 5 }, () => generateTransactionId());

    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id: string) => {
      expect(id).toMatch(hashPattern);
      expect(id.startsWith('tx')).toBe(false);
    });
  });

  it('uses canonical hashes for seeded history and new fallback transfers', () => {
    const simpleBlockchain = loadSimpleBlockchain();

    const seededTx = simpleBlockchain
      .getTransactionHistory(primaryWallet)
      .find((tx: any) => tx.memo === 'Weather Station Earnings Transfer');

    expect(seededTx).toBeDefined();
    expect(seededTx.hash).toMatch(hashPattern);

    const tx = simpleBlockchain.processTransaction(
      primaryWallet,
      secondaryWallet,
      1.25,
      'Regression test transfer'
    );

    expect(tx.hash).toMatch(hashPattern);
    expect(tx.hash.startsWith('tx')).toBe(false);

    const history = simpleBlockchain.getTransactionHistory(primaryWallet);
    expect(history.some((entry: any) => entry.hash === tx.hash)).toBe(true);
  });

  it('returns canonical hashes through the enhanced blockchain fallback', async () => {
    const { EnhancedBlockchainService } = loadEnhancedBlockchainService();
    const service = new EnhancedBlockchainService({
      useRustBlockchain: false,
      fallbackToSimple: true,
    });

    const result = await service.createTransaction({
      from: primaryWallet,
      to: secondaryWallet,
      amount: 1,
      memo: 'Fallback hash test',
    });

    expect(result.hash).toMatch(hashPattern);
    expect(result.hash.startsWith('tx')).toBe(false);
  });
});
