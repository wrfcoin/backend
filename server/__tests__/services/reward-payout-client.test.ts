/**
 * #215 — core4 payout client mapping + guards.
 */
import { jest, describe, it, expect } from '@jest/globals';

// shared/core4-route-client.js is plain ESM (unparseable by ts-jest/CJS). The
// client injects fetchJson in these tests, so the real fetchCore4Json is never
// used; we only need faithful pure helpers for envelope + error parsing.
jest.mock('../../../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(),
  extractCore4Data: (payload: any) =>
    payload && typeof payload === 'object' && ('success' in payload || 'ok' in payload) && 'data' in payload
      ? (payload.data ?? null)
      : (payload ?? null),
  getCore4ErrorMessage: (payload: any, fallback: string) =>
    payload?.error?.message || payload?.message ||
    (typeof payload?.error === 'string' ? payload.error : null) || fallback,
}));

import {
  submitPayout,
  serializeBaseUnits,
  validatePayoutAmount,
  isValidPayoutAddress,
  MAX_BLOCK_EMISSION_BASE_UNITS,
} from '../../services/reward-payout-client.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const OK_AMOUNT = 50n * 100_000_000n; // 50 WRF in base units

function deps(fetchImpl: any, token: string | undefined = 'op-token') {
  return { fetchJson: fetchImpl as any, getOperatorToken: () => token };
}

describe('submitPayout — success mapping', () => {
  it('202 accepted → success/accepted with tx_hash + request id', async () => {
    const fetchJson = jest.fn(async () => ({
      ok: true, status: 202,
      payload: { ok: true, data: { status: 'accepted', tx_hash: '0xdeadbeef' }, meta: { request_id: 'req-1' } },
    }));
    const r = await submitPayout({ address: ADDRESS, amountBaseUnits: OK_AMOUNT, claimId: 'c1' }, deps(fetchJson));
    expect(r).toMatchObject({ kind: 'success', status: 'accepted', txHash: '0xdeadbeef', requestId: 'req-1' });
    // Amount serialized as a safe Number, operator bearer forwarded.
    const [, opts] = fetchJson.mock.calls[0] as any[];
    expect(opts.body.amount_base_units).toBe(Number(OK_AMOUNT));
    expect(opts.body.claim_id).toBe('c1');
    expect(opts.headers.authorization).toBe('Bearer op-token');
  });

  it('202 pending → success/pending (idempotent re-POST of a pending claim)', async () => {
    const fetchJson = jest.fn(async () => ({
      ok: true, status: 202,
      payload: { ok: true, data: { status: 'pending', tx_hash: '0xaa' } },
    }));
    const r = await submitPayout({ address: ADDRESS, amountBaseUnits: OK_AMOUNT, claimId: 'c1' }, deps(fetchJson));
    expect(r).toMatchObject({ kind: 'success', status: 'pending', txHash: '0xaa' });
  });

  it('200 already_processed → success/already_processed, no tx_hash', async () => {
    const fetchJson = jest.fn(async () => ({
      ok: true, status: 200,
      payload: { ok: true, data: { status: 'already_processed' } },
    }));
    const r = await submitPayout({ address: ADDRESS, amountBaseUnits: OK_AMOUNT, claimId: 'c1' }, deps(fetchJson));
    expect(r).toMatchObject({ kind: 'success', status: 'already_processed', txHash: null });
  });

  it('2xx with an unrecognized status → retryable (never silently "paid")', async () => {
    const fetchJson = jest.fn(async () => ({
      ok: true, status: 200, payload: { ok: true, data: { status: 'weird' } },
    }));
    const r = await submitPayout({ address: ADDRESS, amountBaseUnits: OK_AMOUNT, claimId: 'c1' }, deps(fetchJson));
    expect(r.kind).toBe('retryable');
  });
});

describe('submitPayout — error/retryable mapping', () => {
  it('422 OVER_SUPPLY → retryable/over_supply (claim not consumed)', async () => {
    const fetchJson = jest.fn(async () => ({
      ok: false, status: 422, payload: { ok: false, error: { code: 'OVER_SUPPLY', message: 'would exceed 21M' } },
    }));
    const r = await submitPayout({ address: ADDRESS, amountBaseUnits: OK_AMOUNT, claimId: 'c1' }, deps(fetchJson));
    expect(r).toMatchObject({ kind: 'retryable', reason: 'over_supply', code: 'OVER_SUPPLY' });
  });

  it('503 PARTITION_READ_ONLY → retryable/partition_read_only', async () => {
    const fetchJson = jest.fn(async () => ({
      ok: false, status: 503, payload: { ok: false, error: { code: 'PARTITION_READ_ONLY', message: 'read only' } },
    }));
    const r = await submitPayout({ address: ADDRESS, amountBaseUnits: OK_AMOUNT, claimId: 'c1' }, deps(fetchJson));
    expect(r).toMatchObject({ kind: 'retryable', reason: 'partition_read_only' });
  });

  it('401 UNAUTHORIZED → hard error', async () => {
    const fetchJson = jest.fn(async () => ({
      ok: false, status: 401, payload: { ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } },
    }));
    const r = await submitPayout({ address: ADDRESS, amountBaseUnits: OK_AMOUNT, claimId: 'c1' }, deps(fetchJson));
    expect(r).toMatchObject({ kind: 'error', code: 'UNAUTHORIZED', httpStatus: 401 });
  });

  it('network throw → retryable/network', async () => {
    const fetchJson = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await submitPayout({ address: ADDRESS, amountBaseUnits: OK_AMOUNT, claimId: 'c1' }, deps(fetchJson));
    expect(r).toMatchObject({ kind: 'retryable', reason: 'network' });
  });
});

describe('submitPayout — pre-flight guards (no network)', () => {
  it('rejects a bad address before calling core4', async () => {
    const fetchJson = jest.fn();
    const r = await submitPayout({ address: 'nope', amountBaseUnits: OK_AMOUNT, claimId: 'c1' }, deps(fetchJson));
    expect(r).toMatchObject({ kind: 'error', code: 'BAD_REQUEST' });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('rejects amount == 0 and amount over the block-emission cap', async () => {
    const fetchJson = jest.fn();
    const zero = await submitPayout({ address: ADDRESS, amountBaseUnits: 0n, claimId: 'c1' }, deps(fetchJson));
    expect(zero).toMatchObject({ kind: 'error', code: 'UNPROCESSABLE_ENTITY' });
    const tooBig = await submitPayout(
      { address: ADDRESS, amountBaseUnits: MAX_BLOCK_EMISSION_BASE_UNITS + 1n, claimId: 'c1' },
      deps(fetchJson)
    );
    expect(tooBig).toMatchObject({ kind: 'error', code: 'AMOUNT_EXCEEDS_BLOCK_EMISSION' });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('rejects a missing operator token', async () => {
    const fetchJson = jest.fn();
    const r = await submitPayout(
      { address: ADDRESS, amountBaseUnits: OK_AMOUNT, claimId: 'c1' },
      { fetchJson: fetchJson as any, getOperatorToken: () => undefined }
    );
    expect(r).toMatchObject({ kind: 'error', code: 'UNAUTHORIZED' });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('rejects an over-long claim_id', async () => {
    const fetchJson = jest.fn();
    const r = await submitPayout(
      { address: ADDRESS, amountBaseUnits: OK_AMOUNT, claimId: 'x'.repeat(129) },
      deps(fetchJson)
    );
    expect(r).toMatchObject({ kind: 'error', code: 'UNPROCESSABLE_ENTITY' });
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('serializeBaseUnits returns a Number when safe, a string when huge', () => {
    expect(serializeBaseUnits(50n * 100_000_000n)).toBe(5_000_000_000);
    expect(typeof serializeBaseUnits(BigInt(Number.MAX_SAFE_INTEGER) + 10n)).toBe('string');
  });

  it('validatePayoutAmount enforces > 0 and <= cap', () => {
    expect(validatePayoutAmount(1n).ok).toBe(true);
    expect(validatePayoutAmount(0n).ok).toBe(false);
    expect(validatePayoutAmount(MAX_BLOCK_EMISSION_BASE_UNITS).ok).toBe(true);
    expect(validatePayoutAmount(MAX_BLOCK_EMISSION_BASE_UNITS + 1n).ok).toBe(false);
  });

  it('isValidPayoutAddress accepts 20-byte hex with/without 0x', () => {
    expect(isValidPayoutAddress(ADDRESS)).toBe(true);
    expect(isValidPayoutAddress(ADDRESS.slice(2))).toBe(true);
    expect(isValidPayoutAddress('0x123')).toBe(false);
    expect(isValidPayoutAddress(null)).toBe(false);
  });
});
