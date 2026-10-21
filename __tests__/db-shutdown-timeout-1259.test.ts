/**
 * backend#1259: the database shutdown handler's timeout must be longer than the
 * time postgres.js is told to wait in `end`, otherwise the handler timer can win
 * the race and a clean SIGTERM exits 1.
 */
import { describe, expect, it, jest } from '@jest/globals';

describe('database shutdown timeouts (backend#1259)', () => {
  it('postgres.js gives up before the GracefulShutdown handler timer, with margin', async () => {
    const mod = await import('../database/connection');
    expect(mod.DB_END_TIMEOUT_SECONDS * 1000 + 2000).toBeLessThanOrEqual(mod.DB_SHUTDOWN_HANDLER_TIMEOUT_MS);
  });

  it('closeDatabaseConnection passes the shared end timeout to postgres.js', async () => {
    const mod = await import('../database/connection');
    const end = jest.spyOn(mod.queryClient, 'end').mockResolvedValue(undefined as any);
    await mod.closeDatabaseConnection();
    expect(end).toHaveBeenCalledWith({ timeout: mod.DB_END_TIMEOUT_SECONDS });
    end.mockRestore();
  });

  it('the registered shutdown handler uses the shared handler timeout', async () => {
    const { GracefulShutdown } = await import('../shared/graceful-shutdown/index');
    const mod = await import('../database/connection');
    const handlers = (GracefulShutdown.getInstance() as any).handlers as Map<string, { timeout: number }>;
    const registered = [...handlers.values()].find((h: any) => h.name === 'database-connection');
    expect(registered?.timeout).toBe(mod.DB_SHUTDOWN_HANDLER_TIMEOUT_MS);
  });
});
