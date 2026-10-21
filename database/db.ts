import { db as primaryDb, executeQuery as primaryExecuteQuery, queryClient } from './connection.js';

// Backward-compatible database type alias.
export type Database = typeof primaryDb;

export const db: Database = primaryDb;

// Compatibility wrapper for code expecting pg.Pool-like methods.
export const pool = {
  query: async (sql: string, params: unknown[] = []) => {
    return primaryExecuteQuery(sql, params);
  },
  // Returns a client bound to ONE dedicated connection (postgres.js reserve()),
  // so BEGIN ... COMMIT/ROLLBACK issued through it all land on the same session.
  connect: async () => {
    const reserved = await queryClient.reserve();
    let released = false;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (released) {
          throw new Error('Cannot query a released database client');
        }
        const rows = await reserved.unsafe(sql, params as any[]);
        return {
          rows: rows as unknown as Record<string, unknown>[],
          rowCount: (rows as unknown as { count?: number }).count ?? rows.length,
        };
      },
      release: () => {
        if (released) return;
        released = true;
        reserved.release();
      },
    };
  },
  end: async () => {
    await queryClient.end({ timeout: 5 });
  },
  on: () => {},
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
};

export async function executeQuery(
  query: string,
  params: unknown[] = []
): Promise<{ rows: Record<string, unknown>[] }> {
  return primaryExecuteQuery(query, params);
}

export async function ping(): Promise<boolean> {
  try {
    await executeQuery('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

let reconnectTimer: NodeJS.Timeout | null = null;

export function setupConnectionManager() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setInterval(async () => {
    await ping();
  }, 30_000);
  // A keepalive ping must never be the reason the process (or a test runner)
  // stays alive: this module starts the timer as an import side effect, so an
  // un-unref'd interval holds every importer open for up to 30s.
  reconnectTimer.unref();
}

setupConnectionManager();
