import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MeshtasticTxReconstructor, txReconstructor } from '../shared/meshtastic-tx-reconstructor.js';
import type { TxBody } from '../shared/meshtastic-payload-types.js';
import { db } from '../database/db.js';

jest.mock('../database/db', () => ({
  db: {
    insert: jest.fn(),
    select: jest.fn(),
    update: jest.fn(),
  },
}));

function buildChunk(overrides: Partial<TxBody> = {}): TxBody {
  return {
    txId: '123e4567-e89b-12d3-a456-426614174000',
    from: '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18',
    to: '0xabcdef1234567890abcdef1234567890abcdef12',
    amount: '10.5',
    nonce: 7,
    signature: '0x' + 'a'.repeat(130),
    chunk: {
      index: 0,
      total: 2,
      data: Buffer.from('chunk-0').toString('base64'),
    },
    ...overrides,
  };
}

describe('MeshtasticTxReconstructor security checks', () => {
  let reconstructor: MeshtasticTxReconstructor;

  beforeEach(() => {
    jest.clearAllMocks();

    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: (jest.fn() as any).mockResolvedValue([]),
        }),
      }),
    });

    (db.insert as jest.Mock).mockReturnValue({
      values: (jest.fn() as any).mockResolvedValue([]),
    });

    (db.update as jest.Mock).mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: (jest.fn() as any).mockResolvedValue([]),
      }),
    });

    reconstructor = new MeshtasticTxReconstructor(60_000);
  });

  afterEach(() => {
    reconstructor.stopCleanup();
    txReconstructor.stopCleanup();
  });

  it('rejects txId reuse with conflicting signed metadata', async () => {
    const first = buildChunk();
    const second = buildChunk({
      amount: '999.0',
      chunk: {
        index: 1,
        total: 2,
        data: Buffer.from('chunk-1').toString('base64'),
      },
    });

    const storeFirst = await reconstructor.storeChunk(first, '!node123', 'gateway-a');
    expect(storeFirst.success).toBe(true);

    const storeSecond = await reconstructor.storeChunk(second, '!node123', 'gateway-a');
    expect(storeSecond.success).toBe(false);
    expect(storeSecond.error).toContain('Inconsistent chunk metadata');
  });

  it('treats duplicate chunk inserts as idempotent when unique constraint races', async () => {
    (db.insert as jest.Mock)
      .mockReturnValueOnce({ values: (jest.fn() as any).mockResolvedValue([]) })
      .mockReturnValueOnce({ values: (jest.fn() as any).mockRejectedValue({ code: '23505' }) });

    const chunk = buildChunk({
      chunk: {
        index: 0,
        total: 1,
        data: Buffer.from('single-chunk').toString('base64'),
      },
    });

    const first = await reconstructor.storeChunk(chunk, '!node123', 'gateway-a');
    expect(first.success).toBe(true);
    expect(first.isNewChunk).toBe(true);

    const second = await reconstructor.storeChunk(chunk, '!node123', 'gateway-a');
    expect(second.success).toBe(true);
    expect(second.isNewChunk).toBe(false);
    expect(second.isComplete).toBe(true);
  });
});
