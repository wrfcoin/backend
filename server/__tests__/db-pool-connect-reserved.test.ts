/**
 * pool.connect() must hand back a client bound to ONE dedicated connection
 * (postgres.js reserve()), otherwise BEGIN/COMMIT are refused with
 * UNSAFE_TRANSACTION or land on different pooled connections.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const reservedUnsafe = jest.fn();
const reservedRelease = jest.fn();
const sharedUnsafe = jest.fn();
const reserve = jest.fn();

jest.mock('../../database/connection.js', () => ({
  db: {},
  queryClient: {
    reserve: (...a: unknown[]) => reserve(...a),
    unsafe: (...a: unknown[]) => sharedUnsafe(...a),
    end: jest.fn(),
  },
  executeQuery: async (sql: string, params: unknown[] = []) => ({
    rows: await sharedUnsafe(sql, params),
  }),
}));

import { pool } from '../../database/db.js';

describe('pool.connect() transaction client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const reserved = { unsafe: reservedUnsafe, release: reservedRelease };
    reserve.mockImplementation(async () => reserved);
    reservedUnsafe.mockImplementation(async () => Object.assign([{ ok: 1 }], { count: 1 }));
    sharedUnsafe.mockImplementation(async () => []);
  });

  it('runs BEGIN..COMMIT on one reserved connection, never the shared pool', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    const res = await client.query('INSERT INTO t VALUES ($1)', [1]);
    await client.query('COMMIT');
    client.release();

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reservedUnsafe.mock.calls.map((c) => c[0])).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES ($1)',
      'COMMIT',
    ]);
    expect(sharedUnsafe).not.toHaveBeenCalled();
    expect(Array.from(res.rows)).toEqual([{ ok: 1 }]);
    expect(res.rowCount).toBe(1);
  });

  it('release() is idempotent and releases the reservation exactly once', async () => {
    const client = await pool.connect();
    client.release();
    client.release();
    expect(reservedRelease).toHaveBeenCalledTimes(1);
  });

  it('rejects queries on a released client', async () => {
    const client = await pool.connect();
    client.release();
    await expect(client.query('SELECT 1')).rejects.toThrow(/released/);
    expect(reservedUnsafe).not.toHaveBeenCalled();
  });

  it('pool.query still uses the shared pool', async () => {
    await pool.query('SELECT 1');
    expect(sharedUnsafe).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
  });
});
