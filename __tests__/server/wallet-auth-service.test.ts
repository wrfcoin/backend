import { attachWalletNonceIssuer, walletNonceChallengeKey } from '../helpers/wallet-nonce-redis';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Wallet } from 'ethers';

// Must mock ioredis at module level before importing the module under test
let redisMock: any;

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => redisMock);
});

jest.mock('../../server/auth/jwt-constants.js', () => ({
  JWT_ISSUER: 'wrfcoin',
  JWT_AUDIENCE: 'wrfcoin-api',
}));

jest.mock('../../server/utils/logger.js', () => ({
  appLogger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

// Also mock the alternative logger path used by some imports
jest.mock('../../utils/logger.js', () => ({
  appLogger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

function createRedisMock() {
  return attachWalletNonceIssuer({
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
  });
}

function createMockDb() {
  return {
    execute: jest.fn().mockResolvedValue({ rows: [] }),
  };
}

describe('wallet-auth-service', () => {
  let buildWalletLoginMessage: (input: any) => string;
  let createWalletAuthService: (options?: any) => any;

  beforeEach(() => {
    jest.clearAllMocks();
    redisMock = createRedisMock();
    jest.resetModules();
    // Re-mock after resetModules
    jest.mock('ioredis', () => jest.fn().mockImplementation(() => redisMock));
    jest.mock('../../server/auth/jwt-constants.js', () => ({
      JWT_ISSUER: 'wrfcoin',
      JWT_AUDIENCE: 'wrfcoin-api',
    }));
    jest.mock('../../server/utils/logger.js', () => ({
      appLogger: {
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
      },
    }));
    const mod = require('../../server/routes/wallet-auth-routes');
    buildWalletLoginMessage = mod.buildWalletLoginMessage;
    createWalletAuthService = mod.createWalletAuthService;
  });

  // ---------------------------------------------------------------------------
  // buildWalletLoginMessage
  // ---------------------------------------------------------------------------

  describe('buildWalletLoginMessage', () => {
    it('binds the challenge to the relying-party origin, address, chain, and expiry', () => {
      const result = buildWalletLoginMessage({
        address: '0x1234567890abcdef1234567890abcdef12345678',
        origin: 'https://wrfcoin-testnet.taila1c049.ts.net',
        chainId: 777,
        nonce: 'deadbeef1234567890abcdef',
        issuedAt: '2026-08-17T00:00:00.000Z',
        expirationTime: '2026-08-17T00:05:00.000Z',
      });
      expect(result).toContain(
        'wrfcoin-testnet.taila1c049.ts.net wants you to sign in with your Ethereum account:'
      );
      expect(result).toContain('URI: https://wrfcoin-testnet.taila1c049.ts.net');
      expect(result).toContain('Chain ID: 777');
      expect(result).toContain('Nonce: deadbeef1234567890abcdef');
      expect(result).toContain('Expiration Time: 2026-08-17T00:05:00.000Z');
    });
  });

  // ---------------------------------------------------------------------------
  // createWalletAuthService — construction guards
  // ---------------------------------------------------------------------------

  describe('createWalletAuthService construction', () => {
    it('throws when no jwtSecret is provided and JWT_SECRET env is unset', () => {
      const original = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      try {
        expect(() => createWalletAuthService({ redis: redisMock })).toThrow(
          'JWT_SECRET is required'
        );
      } finally {
        if (original !== undefined) process.env.JWT_SECRET = original;
      }
    });

    it('throws when jwtSecret is shorter than 32 characters', () => {
      expect(() =>
        createWalletAuthService({ jwtSecret: 'tooshort', redis: redisMock })
      ).toThrow('JWT_SECRET must be at least 32 characters');
    });

    it('creates service successfully with a valid secret', () => {
      const service = createWalletAuthService({
        jwtSecret: 'a'.repeat(32),
        redis: redisMock,
      });
      expect(service).toHaveProperty('generateNonce');
      expect(service).toHaveProperty('walletLogin');
      expect(service).toHaveProperty('refresh');
    });

    it('rejects an ambiguous origin and insecure production origin', () => {
      expect(() => createWalletAuthService({
        jwtSecret: 'a'.repeat(32),
        redis: redisMock,
        walletAuthOrigin: 'https://one.example,https://two.example',
      })).toThrow('one exact origin');

      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(() => createWalletAuthService({
          jwtSecret: 'a'.repeat(32),
          redis: redisMock,
          walletAuthOrigin: 'http://wrfcoin.com',
        })).toThrow('HTTPS');
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // generateNonce
  // ---------------------------------------------------------------------------

  describe('generateNonce', () => {
    const validSecret = 'a'.repeat(32);

    it('throws for an invalid EVM address format', async () => {
      const service = createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
      });
      await expect(service.generateNonce('not-an-address')).rejects.toThrow(
        'invalid address format'
      );
    });

    it('throws for address without 0x prefix', async () => {
      const service = createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
      });
      await expect(
        service.generateNonce('1234567890abcdef1234567890abcdef12345678')
      ).rejects.toThrow('invalid address format');
    });

    it('stores and returns a domain-bound, expiring challenge', async () => {
      const now = new Date('2026-08-17T00:00:00.000Z');
      const service = createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
        walletAuthOrigin: 'https://wrfcoin.com',
        walletAuthChainId: 777,
        nonceTtlSec: 300,
        now: () => now,
      });
      const address = '0xabcdef1234567890abcdef1234567890abcdef12';
      const challenge = await service.generateNonce(address);

      expect(challenge.nonce).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(challenge.nonce)).toBe(true);
      expect(challenge.message).toContain('wrfcoin.com wants you to sign in');
      expect(challenge.message).toContain('URI: https://wrfcoin.com');
      expect(challenge.message).toContain('Chain ID: 777');
      expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
      expect(challenge.issuedAt).toBe('2026-08-17T00:00:00.000Z');
      expect(challenge.expirationTime).toBe('2026-08-17T00:05:00.000Z');

      expect(redisMock.set).toHaveBeenCalledWith(
        walletNonceChallengeKey('evm', address, challenge.nonce),
        expect.any(String),
        'EX',
        300
      );
      const stored = JSON.parse(redisMock.set.mock.calls[0][1]);
      expect(stored).toMatchObject({
        nonce: challenge.nonce,
        message: challenge.message,
        origin: 'https://wrfcoin.com',
        chainId: 777,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // walletLogin
  // ---------------------------------------------------------------------------

  describe('walletLogin', () => {
    const validSecret = 'a'.repeat(32);
    const validAddress = '0x1234567890abcdef1234567890abcdef12345678';
    const fixedNow = new Date('2026-08-17T00:00:00.000Z');
    const challengeJson = (nonce: string, overrides: Record<string, unknown> = {}) => {
      const challenge = {
        nonce,
        issuedAt: '2026-08-17T00:00:00.000Z',
        expirationTime: '2026-08-17T00:05:00.000Z',
        origin: 'https://wrfcoin.com',
        chainId: 777,
        ...overrides,
      } as any;
      challenge.message = overrides.message ?? buildWalletLoginMessage({
        address: validAddress,
        origin: challenge.origin,
        chainId: challenge.chainId,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expirationTime: challenge.expirationTime,
      });
      return JSON.stringify(challenge);
    };
    const createService = (extra: Record<string, unknown> = {}) =>
      createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
        walletAuthOrigin: 'https://wrfcoin.com',
        walletAuthChainId: 777,
        now: () => fixedNow,
        ...extra,
      });

    it('throws when address is missing', async () => {
      const service = createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
      });
      await expect(
        service.walletLogin({ address: '', signature: 'sig', nonce: 'nonce' })
      ).rejects.toThrow('address, signature, and nonce are required');
    });

    it('throws when signature is missing', async () => {
      const service = createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
      });
      await expect(
        service.walletLogin({
          address: validAddress,
          signature: '',
          nonce: 'nonce',
        })
      ).rejects.toThrow('address, signature, and nonce are required');
    });

    it('throws when nonce is missing', async () => {
      const service = createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
      });
      await expect(
        service.walletLogin({
          address: validAddress,
          signature: 'sig',
          nonce: '',
        })
      ).rejects.toThrow('address, signature, and nonce are required');
    });

    it('throws when nonce is expired (redis.get returns null)', async () => {
      redisMock.get.mockResolvedValueOnce(null);
      const service = createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
      });
      await expect(
        service.walletLogin({
          address: validAddress,
          signature: 'sig',
          nonce: 'mynonce',
        })
      ).rejects.toThrow('nonce expired or not found');
    });

    it('throws when stored nonce does not match submitted nonce', async () => {
      redisMock.get.mockResolvedValueOnce(challengeJson('stored-nonce-value'));
      const service = createService();
      await expect(
        service.walletLogin({
          address: validAddress,
          signature: 'sig',
          nonce: 'different-nonce',
        })
      ).rejects.toThrow('invalid nonce');
    });

    it('throws for invalid EVM address (verifyWalletSignature path)', async () => {
      // Nonce matches but address is non-EVM
      const nonEvmAddress = 'cosmos1abcdefghij';
      redisMock.get.mockResolvedValueOnce(challengeJson('mynonce'));
      const service = createService();
      await expect(
        service.walletLogin({
          address: nonEvmAddress,
          signature: 'sig',
          nonce: 'mynonce',
        })
      ).rejects.toThrow();
    });

    it('throws with invalid signature error when ethers cannot recover address', async () => {
      const nonce = 'a'.repeat(64);
      redisMock.get.mockResolvedValueOnce(challengeJson(nonce));
      const mockDb = createMockDb();
      const service = createService({ db: mockDb });

      // ethers will fail on a garbage signature — verifyWalletSignature returns false
      await expect(
        service.walletLogin({
          address: validAddress,
          signature: 'invalid-garbage-sig',
          nonce,
        })
      ).rejects.toThrow('invalid wallet signature');
    });

    it('rejects the old nonce-only Redis record instead of accepting a generic signature', async () => {
      redisMock.get.mockResolvedValueOnce('legacy-nonce');
      const service = createService();

      await expect(service.walletLogin({
        address: validAddress,
        signature: 'sig',
        nonce: 'legacy-nonce',
      })).rejects.toThrow('challenge is invalid');
      expect(redisMock.del).toHaveBeenCalled();
    });

    it('rejects a valid wallet signature over the old domain-less message', async () => {
      const wallet = Wallet.createRandom();
      const service = createService();
      const challenge = await service.generateNonce(wallet.address);
      redisMock.get.mockResolvedValueOnce(redisMock.set.mock.calls[0][1]);
      const signature = await wallet.signMessage(
        `WRFCoin wallet login nonce: ${challenge.nonce}`
      );

      await expect(service.walletLogin({
        address: wallet.address,
        signature,
        nonce: challenge.nonce,
      })).rejects.toThrow('invalid wallet signature');
    });

    it('rejects a stored challenge bound to a different origin', async () => {
      redisMock.get.mockResolvedValueOnce(
        challengeJson('mynonce', { origin: 'https://evil.example' })
      );
      const service = createService();

      await expect(service.walletLogin({
        address: validAddress,
        signature: 'sig',
        nonce: 'mynonce',
      })).rejects.toThrow('challenge is invalid');
    });

    it('rejects an explicitly expired challenge even if Redis still returns it', async () => {
      redisMock.get.mockResolvedValueOnce(
        challengeJson('mynonce', {
          issuedAt: '2026-08-16T23:54:59.000Z',
          expirationTime: '2026-08-16T23:59:59.000Z',
        })
      );
      const service = createService();

      await expect(service.walletLogin({
        address: validAddress,
        signature: 'sig',
        nonce: 'mynonce',
      })).rejects.toThrow('nonce expired');
    });

    it('consumes the challenge atomically so a captured signature cannot be replayed', async () => {
      const wallet = Wallet.createRandom();
      const mockDb = createMockDb();
      const service = createService({ db: mockDb });

      // Issue a real server-bound challenge and sign its exact message.
      const challenge = await service.generateNonce(wallet.address);
      const storedChallenge = redisMock.set.mock.calls[0][1];
      const signature = await wallet.signMessage(challenge.message);

      // First login: Redis still holds the challenge and DEL removes it (=> 1).
      redisMock.get.mockResolvedValueOnce(storedChallenge);
      redisMock.del.mockResolvedValueOnce(1);
      const first = await service.walletLogin({
        address: wallet.address,
        signature,
        nonce: challenge.nonce,
      });
      expect(first).toBeDefined();
      expect(mockDb.execute).toHaveBeenCalled(); // reached the post-verification path

      // Concurrent replay of the same valid signature: the read still returns
      // the challenge (the TOCTOU window), but DEL now removes nothing (=> 0),
      // so the second request must be rejected rather than minting a 2nd JWT.
      redisMock.get.mockResolvedValueOnce(storedChallenge);
      redisMock.del.mockResolvedValueOnce(0);
      await expect(service.walletLogin({
        address: wallet.address,
        signature,
        nonce: challenge.nonce,
      })).rejects.toThrow('nonce already used');
    });
  });

  // ---------------------------------------------------------------------------
  // refresh
  // ---------------------------------------------------------------------------

  describe('refresh', () => {
    const validSecret = 'a'.repeat(32);

    it('throws when refreshToken is missing', async () => {
      const service = createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
      });
      await expect(service.refresh({ refreshToken: '' })).rejects.toThrow(
        'refreshToken is required'
      );
    });

    it('throws when redis returns null for the refresh token key', async () => {
      redisMock.get.mockResolvedValueOnce(null);
      const service = createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
      });
      await expect(
        service.refresh({ refreshToken: 'unknowntoken' })
      ).rejects.toThrow('invalid refresh token');
    });

    it('throws when the stored refresh token is expired', async () => {
      const expired = JSON.stringify({
        address: '0x1234567890abcdef1234567890abcdef12345678',
        expiresAtMs: Date.now() - 10_000, // 10 seconds in the past
      });
      redisMock.get.mockResolvedValueOnce(expired);
      const service = createWalletAuthService({
        jwtSecret: validSecret,
        redis: redisMock,
      });
      await expect(
        service.refresh({ refreshToken: 'expiredtoken' })
      ).rejects.toThrow('refresh token expired');
    });
  });
});
