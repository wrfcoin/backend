import { describe, beforeEach, expect, it } from '@jest/globals';
import BlockchainValidator from '../../server/utils/blockchainValidator.js';

describe('BlockchainValidator', () => {
  let validator: any;

  const validTransaction = (overrides: Record<string, unknown> = {}) => ({
    id: 'tx-123',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    amount: 1.25,
    timestamp: new Date().toISOString(),
    signature: 'a'.repeat(64),
    ...overrides,
  });

  beforeEach(() => {
    validator = new BlockchainValidator();
  });

  it('accepts a valid transaction', async () => {
    const result = await validator.validateTransaction(validTransaction());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects malformed transaction objects even when a signature is present', async () => {
    const result = await validator.validateTransaction(
      validTransaction({
        to: undefined,
        amount: 0,
        signature: 'shortsig',
      })
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Invalid transaction structure',
        'Invalid transaction signature',
      ])
    );
  });

  it('rejects malformed non-object transaction payloads', async () => {
    const result = await validator.validateTransaction(null as any);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error: string) =>
        error.startsWith('Transaction validation error:')
      )
    ).toBe(true);
  });

  it('rejects invalid structure even when signature length is valid', async () => {
    const result = await validator.validateTransaction(
      validTransaction({
        amount: 0,
        signature: 'b'.repeat(64),
      })
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid transaction structure');
    expect(result.errors).not.toContain('Invalid transaction signature');
  });

  it('rejects transactions whose payload exceeds the maximum size', async () => {
    const result = await validator.validateTransaction(
      validTransaction({
        memo: 'x'.repeat(100 * 1024 + 1),
      })
    );

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error: string) =>
        error.startsWith('Transaction too large:')
      )
    ).toBe(true);
  });

  it('rejects short signatures on otherwise valid transactions', async () => {
    const result = await validator.validateTransaction(
      validTransaction({
        signature: 'abcd',
      })
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid transaction signature');
  });
});
