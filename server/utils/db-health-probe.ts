/**
 * #910 — direct Postgres liveness probe for /health, with real cancellation.
 *
 * A bare Promise.race against a timer abandons the losing query: it stays in
 * the shared postgres-js pool/queue and repeated health polls against a
 * stalled-but-accepting Postgres would accumulate work until the probe itself
 * became a resource-amplification path (review finding on #1051). This probe
 * therefore holds the postgres-js query handle and calls `.cancel()` on
 * timeout — a queued query is dequeued, an in-flight one gets a server-side
 * cancel request — so each poll's work dies with the poll.
 *
 * Lives in its own module (not the entrypoint) so tests can exercise the
 * timeout/cancel contract with injected fake queries without booting the
 * server.
 */

export const DB_HEALTH_PROBE_TIMEOUT_MS = 1_500;

/** The slice of a postgres-js query the probe relies on. */
export type CancellableProbeQuery = PromiseLike<unknown> & { cancel: () => void };

export interface DbHealthResult {
  status: 'up' | 'down';
  latency_ms: number;
  error?: string;
}

export function createDbHealthProbe(
  makeQuery: () => CancellableProbeQuery,
  timeoutMs: number = DB_HEALTH_PROBE_TIMEOUT_MS,
): () => Promise<DbHealthResult> {
  return async function probeDatabaseHealth(): Promise<DbHealthResult> {
    const started = Date.now();
    let query: CancellableProbeQuery;
    try {
      query = makeQuery();
    } catch (error) {
      return {
        status: 'down',
        latency_ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        query.cancel();
      } catch {
        // Cancellation is best-effort; the probe still reports down below.
      }
    }, timeoutMs);
    timer.unref?.();

    // A cancelled postgres-js query rejects promptly — but a cancel lost to a
    // black-holed socket must not hang /health. The hard deadline (cancel
    // point + grace) guarantees the probe always settles; the query itself
    // received a genuine cancel either way, so no work accumulates.
    const CANCEL_GRACE_MS = 500;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const hardDeadline = new Promise<'deadline'>((resolve) => {
      deadlineTimer = setTimeout(() => resolve('deadline'), timeoutMs + CANCEL_GRACE_MS);
      deadlineTimer.unref?.();
    });

    try {
      const outcome = await Promise.race([
        Promise.resolve(query).then(
          () => 'up' as const,
          (error: unknown) => ({ probeError: error }),
        ),
        hardDeadline,
      ]);
      if (outcome === 'up') {
        return { status: 'up', latency_ms: Date.now() - started };
      }
      const errorDetail =
        outcome === 'deadline'
          ? `db probe missed the hard deadline at ${timeoutMs + CANCEL_GRACE_MS}ms (cancel sent, response never arrived)`
          : timedOut
            ? `db probe timed out after ${timeoutMs}ms (query cancelled)`
            : outcome.probeError instanceof Error
              ? outcome.probeError.message
              : String(outcome.probeError);
      return { status: 'down', latency_ms: Date.now() - started, error: errorDetail };
    } finally {
      clearTimeout(timer);
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
    }
  };
}
