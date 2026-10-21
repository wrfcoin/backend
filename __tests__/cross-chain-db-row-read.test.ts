/**
 * Regression tests for issue #757 — cross-chain transfer persistence reads
 * result rows incorrectly.
 *
 * `executeQuery` (database/db.ts) resolves to `{ rows: Record<string, unknown>[] }`.
 * The bridge persistence helpers previously returned `result[0]` / `result?.[0]`,
 * which is ALWAYS `undefined` (the result object has no numeric index — only `rows`).
 * That made durably-persisted rows look absent, silently falling back to in-memory
 * transfer state. After a restart, bridge status/accounting could diverge or vanish.
 *
 * These tests prove the helpers now read `result.rows[0]` and surface the real row.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Captured by the database/db mock so each test can program the query result.
const executeQueryMock = jest.fn();

jest.mock('../database/db.js', () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));

// Heavy / side-effecting dependencies of server/cross_chain/api.ts — stub them out
// so the module loads in isolation.
jest.mock('../server/storage.js', () => ({ storage: {} }));
jest.mock('../server/blockchain_adapter.js', () => ({}));
jest.mock('../server/websocket.js', () => ({}));
jest.mock('../server/events/cross-chain-event-bus.js', () => ({
  emitBridgeTransactionEvent: jest.fn(),
}));
jest.mock('../server/utils/logger.js', () => ({
  crosschainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __bridgeTestInternals } = require('../server/cross_chain/api.ts');
const { createDatabaseTransfer, getDatabaseTransferByIdentifier } =
  __bridgeTestInternals;

const SAMPLE_ROW = {
  id: 42,
  transferId: 'transfer-abc',
  status: 'initiated',
  fromChain: 'ethereum',
  toChain: 'wrfcoin',
  senderAddress: '0xsender',
  recipientAddress: 'wrf1recipient',
  amount: '100',
  timestamp: '2026-06-13T00:00:00Z',
  completedAt: null,
  bridgeProvider: 'local-manager',
  fees: null,
  metadata: { direction: 'inbound' },
};

const DB_TRANSACTION = {
  status: 'initiated',
  fromChain: 'ethereum',
  toChain: 'wrfcoin',
  amount: 100,
  senderAddress: '0xsender',
  recipientAddress: 'wrf1recipient',
  sourceTxHash: '0xsourcehash',
  destinationTxHash: null,
  timestamp: '2026-06-13T00:00:00Z',
  provider: 'local-manager',
  fee: null,
};

beforeEach(() => {
  executeQueryMock.mockReset();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('issue #757 — cross-chain persistence reads result.rows[0]', () => {
  it('createDatabaseTransfer returns the persisted row, not undefined', async () => {
    executeQueryMock.mockResolvedValueOnce({ rows: [SAMPLE_ROW] });

    const created = await createDatabaseTransfer(
      'transfer-abc',
      DB_TRANSACTION,
      'inbound'
    );

    // The bug returned result[0] === undefined; the durable row must be surfaced.
    expect(created).toBeDefined();
    expect(created).toEqual(SAMPLE_ROW);
    expect(created.id).toBe(42);
    expect(created.transferId).toBe('transfer-abc');
  });

  it('createDatabaseTransfer throws when the insert returns no rows', async () => {
    executeQueryMock.mockResolvedValueOnce({ rows: [] });

    await expect(
      createDatabaseTransfer('transfer-abc', DB_TRANSACTION, 'inbound')
    ).rejects.toThrow('Failed to create cross-chain transfer');
  });

  it('getDatabaseTransferByIdentifier returns the row for a numeric DB id', async () => {
    executeQueryMock.mockResolvedValueOnce({ rows: [SAMPLE_ROW] });

    const found = await getDatabaseTransferByIdentifier('42');

    expect(found).toEqual(SAMPLE_ROW);
    // Numeric identifiers must be looked up by the integer primary key.
    const [, params] = executeQueryMock.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(42);
  });

  it('getDatabaseTransferByIdentifier returns the row for a transfer_id string', async () => {
    executeQueryMock.mockResolvedValueOnce({ rows: [SAMPLE_ROW] });

    const found = await getDatabaseTransferByIdentifier('transfer-abc');

    expect(found).toEqual(SAMPLE_ROW);
    const [, params] = executeQueryMock.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('transfer-abc');
  });

  it('getDatabaseTransferByIdentifier returns null when the row is absent', async () => {
    executeQueryMock.mockResolvedValueOnce({ rows: [] });

    const found = await getDatabaseTransferByIdentifier('transfer-missing');

    expect(found).toBeNull();
  });

  it('does NOT fall back to undefined when rows are present (the #757 regression)', async () => {
    executeQueryMock.mockResolvedValueOnce({ rows: [SAMPLE_ROW] });
    const created = await createDatabaseTransfer(
      'transfer-abc',
      DB_TRANSACTION,
      'inbound'
    );
    // Explicitly guard against the old `result[0]` shape leaking back in.
    expect(created).not.toBeUndefined();
    expect((created as { rows?: unknown }).rows).toBeUndefined();
  });
});
