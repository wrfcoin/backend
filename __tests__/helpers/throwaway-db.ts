/**
 * Teardown for suites that create a throwaway Postgres database (backend#1402).
 *
 * pg-pool's end() settles as soon as the pool has forgotten its clients, before their
 * sockets have disconnected. A `DROP DATABASE ... WITH (FORCE)` sent right after can reach
 * the server first and terminate a session that is still shutting down: Postgres answers
 * 57P01, the client's pool idle listener re-emits it as a pool 'error' event and, with no
 * listener, it is an unhandled error. jest then reports "Test suite failed to run" although
 * every test passed.
 *
 * The server is the only evidence that a session has gone: pg-pool's events, its
 * ending/ended flags and a deadline are not. So the drop runs only after pg_stat_activity
 * shows no session on the database; if sessions remain at the deadline, teardown fails and
 * the database is left in place (no FORCE drop of a live session). Test support only.
 */
import type { Pool } from 'pg';

/** admin_shutdown: the server terminated the session (here: the FORCE drop). */
export const ADMIN_SHUTDOWN = '57P01';

/** Sessions the server still holds on `dbName`, seen from the admin connection. */
export async function sessionsOn(admin: Pool, dbName: string): Promise<number> {
  const r = await admin.query('SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [dbName]);
  return r.rows[0].n as number;
}

/** Poll until the server shows no session on `dbName`; false if any remain at the deadline. */
export async function waitForNoSessions(admin: Pool, dbName: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await sessionsOn(admin, dbName)) === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * End `pools`, wait until the server shows no session on `dbName`, then drop it WITH (FORCE).
 * Only while this runs, a 57P01 on one of the pools is tolerated; any other pool error is
 * collected and fails the teardown. The helper's listener is removed before it returns, on
 * every path, so outside teardown every pool error behaves as before.
 */
export async function dropThrowawayDatabase(
  admin: Pool | undefined,
  dbName: string,
  pools: Array<Pool | undefined>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const unexpected: Error[] = [];
  const onError = (err: Error & { code?: string }) => {
    if (err.code !== ADMIN_SHUTDOWN) unexpected.push(err);
  };
  const supplied = pools.filter((p): p is Pool => p !== undefined);
  for (const p of supplied) p.on('error', onError);
  try {
    // A pool that is already ending or ended is not ended again; the server poll below is
    // what proves its sockets have gone.
    for (const p of supplied) if (!p.ending && !p.ended) await p.end();
    if (admin) {
      if (!(await waitForNoSessions(admin, dbName, timeoutMs))) {
        throw new Error(`sessions on ${dbName} are still connected after ${timeoutMs} ms; the database was not dropped`);
      }
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    }
  } finally {
    for (const p of supplied) p.removeListener('error', onError);
  }
  if (unexpected.length > 0) {
    throw new AggregateError(unexpected, `pool error during teardown of ${dbName}: ${unexpected.map((e) => e.message).join('; ')}`);
  }
}
