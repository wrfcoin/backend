import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

interface MockBridgeRow {
  id: number;
  transferId: string;
  fromChain: string;
  toChain: string;
  senderAddress: string;
  recipientAddress: string;
  amount: number;
  status: string;
  timestamp: string;
  completedAt: string | null;
  bridgeProvider: string | null;
  fees: string | null;
  metadata: Record<string, unknown>;
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function flushPendingTimers(iterations = 16): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await jest.runOnlyPendingTimersAsync();
  }
}

describe('cross_chain/api DB lifecycle', () => {
  let rowsById: Map<number, MockBridgeRow>;
  let rowsByTransferId: Map<string, MockBridgeRow>;
  let nextId = 1;
  let statusUpdates: string[] = [];
  let executeQueryMock: any;
  let internals: any;

  const setupModule = (options?: { failSelect?: boolean }): void => {
    const failSelect = options?.failSelect === true;

    jest.resetModules();
    rowsById = new Map<number, MockBridgeRow>();
    rowsByTransferId = new Map<string, MockBridgeRow>();
    nextId = 1;
    statusUpdates = [];

    executeQueryMock = jest.fn(async (query: string, params: any[] = []) => {
      const normalized = normalizeQuery(query);

      if (normalized.startsWith('insert into cross_chain_transfers')) {
        const row: MockBridgeRow = {
          id: nextId++,
          transferId: params[0],
          fromChain: params[1],
          toChain: params[2],
          senderAddress: params[3],
          recipientAddress: params[4],
          amount: Number(params[5]),
          status: params[7],
          timestamp: params[8],
          completedAt: null,
          bridgeProvider: params[9],
          fees: params[10],
          metadata: JSON.parse(params[11]),
        };

        rowsById.set(row.id, row);
        rowsByTransferId.set(row.transferId, row);
        return { rows: [row] };
      }

      if (
        normalized.startsWith('select') &&
        normalized.includes('from cross_chain_transfers')
      ) {
        if (failSelect) {
          throw new Error('simulated select failure');
        }

        const row = normalized.includes('where id = $1')
          ? rowsById.get(Number(params[0]))
          : rowsByTransferId.get(String(params[0]));
        return { rows: row ? [row] : [] };
      }

      if (normalized.startsWith('update cross_chain_transfers')) {
        const txId = Number(params[0]);
        const row = rowsById.get(txId);
        if (!row) {
          return { rows: [] };
        }

        if (row.status === 'completed' || row.status === 'failed') {
          return { rows: [] };
        }

        row.status = params[1];
        row.completedAt = params[2] || null;
        row.metadata = JSON.parse(params[3]);
        statusUpdates.push(row.status);
        rowsById.set(row.id, row);
        rowsByTransferId.set(row.transferId, row);
        return { rows: [row] };
      }

      throw new Error(`Unexpected query in test: ${normalized}`);
    });

    jest.doMock('../../database/db.js', () => ({
      executeQuery: executeQueryMock,
    }));
    jest.doMock('../websocket', () => ({
      broadcastBridgeTransaction: jest.fn(),
    }));
    jest.doMock('../blockchain_adapter', () => ({}));
    jest.doMock('../utils/logger.js', () => ({
      crosschainLogger: {
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const apiModule = require('../cross_chain/api');
    internals = apiModule.__bridgeTestInternals;
    internals.resetDatabaseQueryCache();
    internals.bridgeTransactions.length = 0;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.BRIDGE_STATE_DELAY_MS = '0';
  });

  afterEach(() => {
    delete process.env.BRIDGE_STATE_DELAY_MS;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('persists DB bridge lifecycle and hash metadata to terminal state', async () => {
    setupModule();

    const created = await internals.createDatabaseTransfer(
      'txdb000001',
      {
        status: internals.BRIDGE_STATUS.INITIATED,
        fromChain: 'wrfcoin',
        toChain: 'ethereum',
        amount: 250,
        senderAddress: 'wrfSenderAddr001',
        recipientAddress: 'extRecipient001',
        sourceTxHash: null,
        destinationTxHash: null,
        timestamp: new Date().toISOString(),
        provider: 'layerzero',
        fee: '3',
      },
      'outbound'
    );

    await internals.processBridgeTransaction(String(created.id));
    await flushPendingTimers();

    const row = rowsById.get(created.id);
    expect(row).toBeDefined();
    expect(row?.status).toBe('completed');
    expect(row?.completedAt).toBeTruthy();
    expect(statusUpdates).toEqual(
      expect.arrayContaining(['locked', 'burned', 'unlocked', 'completed'])
    );

    const metadata = row?.metadata as Record<string, string>;
    expect(metadata.sourceTxHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(metadata.destinationTxHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(metadata.trust_state).toBe('finalized');
    expect(metadata.provenance_source).toBe('local-manager');
  });

  it('falls back to in-memory lifecycle when DB lookup fails', async () => {
    setupModule({ failSelect: true });

    internals.bridgeTransactions.push({
      tx_id: '42',
      status: internals.BRIDGE_STATUS.INITIATED,
      direction: 'outbound',
      from_chain: 'wrfcoin',
      to_chain: 'polygon',
      amount: 150,
      sender_address: 'wrfSenderAddr002',
      recipient_address: 'extRecipient002',
      external_transaction_hash: null,
      wrf_transaction_hash: null,
      timestamp: new Date().toISOString(),
      provider: 'wormhole',
      fee: '2',
      trust_state: 'pending',
      provenance_source: 'simulated',
    });

    await internals.processBridgeTransaction('42');
    await flushPendingTimers();

    const memTx = internals.bridgeTransactions.find((tx: any) => tx.tx_id === '42');
    expect(memTx).toBeDefined();
    expect(memTx.status).toBe('completed');
    expect(memTx.wrf_transaction_hash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('keeps DB transaction terminal-state idempotency on repeated processing', async () => {
    setupModule();

    const created = await internals.createDatabaseTransfer(
      'txdb000002',
      {
        status: internals.BRIDGE_STATUS.INITIATED,
        fromChain: 'wrfcoin',
        toChain: 'avalanche',
        amount: 99,
        senderAddress: 'wrfSenderAddr003',
        recipientAddress: 'extRecipient003',
        sourceTxHash: null,
        destinationTxHash: null,
        timestamp: new Date().toISOString(),
        provider: 'axelar',
        fee: '1',
      },
      'outbound'
    );

    await internals.processBridgeTransaction(String(created.id));
    await flushPendingTimers();

    const updatesBefore = statusUpdates.length;
    await internals.processBridgeTransaction(String(created.id));
    await flushPendingTimers(4);

    expect(statusUpdates.length).toBe(updatesBefore);
    expect(rowsById.get(created.id)?.status).toBe('completed');
  });
});
