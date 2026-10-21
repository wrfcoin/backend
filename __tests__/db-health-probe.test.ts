/**
 * #910 — the /health Postgres probe must CANCEL its query on timeout, not
 * abandon it (review finding on #1051: an abandoned query stays in the shared
 * postgres-js pool/queue, so repeated polls against a stalled-but-accepting
 * Postgres accumulate work until the health endpoint itself is an
 * amplification path). These tests drive the probe with fake queries whose
 * settlement the test controls, including the never-settling shape the
 * dead-port survival test cannot exercise.
 */
import { describe, expect, test, jest } from '@jest/globals';
import {
  createDbHealthProbe,
  type CancellableProbeQuery,
} from '../server/utils/db-health-probe.js';

/** A controllable fake postgres-js query. */
function fakeQuery(behavior: 'resolve' | 'reject' | 'hang' | 'hang-even-after-cancel') {
  let settle: (() => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const cancel = jest.fn(() => {
    // A real cancelled postgres-js query rejects promptly; the
    // 'hang-even-after-cancel' shape models a cancel lost to a black-holed
    // socket, which only the hard deadline can unblock.
    if (behavior !== 'hang-even-after-cancel') {
      fail?.(new Error('canceling statement due to user request'));
    }
  });
  if (behavior === 'resolve') settle?.();
  if (behavior === 'reject') fail?.(new Error('connection refused'));
  const query = { then: promise.then.bind(promise), cancel } as unknown as CancellableProbeQuery;
  // Swallow unhandled-rejection noise for shapes the probe may not await.
  void promise.catch(() => {});
  return { query, cancel };
}

describe('db health probe cancellation contract (#910)', () => {
  test('fast success reports up without cancelling', async () => {
    const { query, cancel } = fakeQuery('resolve');
    const probe = createDbHealthProbe(() => query, 200);
    const result = await probe();
    expect(result.status).toBe('up');
    expect(cancel).not.toHaveBeenCalled();
  });

  test('immediate failure reports down without cancelling', async () => {
    const { query, cancel } = fakeQuery('reject');
    const probe = createDbHealthProbe(() => query, 200);
    const result = await probe();
    expect(result.status).toBe('down');
    expect(result.error).toContain('connection refused');
    expect(cancel).not.toHaveBeenCalled();
  });

  test('a never-settling query is CANCELLED at the timeout and reported down', async () => {
    const { query, cancel } = fakeQuery('hang');
    const probe = createDbHealthProbe(() => query, 100);
    const result = await probe();
    expect(result.status).toBe('down');
    expect(result.error).toContain('query cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('repeated probes against a stalled database cancel EVERY query — no accumulation', async () => {
    const cancels: Array<ReturnType<typeof jest.fn>> = [];
    const probe = createDbHealthProbe(() => {
      const { query, cancel } = fakeQuery('hang');
      cancels.push(cancel);
      return query;
    }, 60);

    for (let i = 0; i < 20; i++) {
      const result = await probe();
      expect(result.status).toBe('down');
    }

    expect(cancels).toHaveLength(20);
    for (const cancel of cancels) {
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  });

  test('a cancel lost to a black-holed socket settles at the controlled hard deadline', async () => {
    jest.useFakeTimers();
    try {
      const { query, cancel } = fakeQuery('hang-even-after-cancel');
      const probe = createDbHealthProbe(() => query, 100);
      const pendingResult = probe();
      let settled = false;
      void pendingResult.then(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(99);
      expect(cancel).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      const result = await pendingResult;
      expect(result.status).toBe('down');
      expect(result.error).toContain('hard deadline');
      expect(result.latency_ms).toBe(600);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a throwing query factory reports down instead of throwing out of /health', async () => {
    const probe = createDbHealthProbe(() => {
      throw new Error('pool destroyed');
    }, 100);
    const result = await probe();
    expect(result.status).toBe('down');
    expect(result.error).toContain('pool destroyed');
  });
});
