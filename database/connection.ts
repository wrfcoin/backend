/**
 * PostgreSQL (postgres-js) primary connection for backend services.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { logger } from '../utils/logger.js';
import * as schema from '../shared/schema.js';
import {
  GracefulShutdown,
  ShutdownPriority,
} from '../shared/graceful-shutdown/index.js';

const databaseUrl =
  process.env.DATABASE_URL || 'postgresql://localhost:5432/wrfcoin';
const isProduction = process.env.NODE_ENV === 'production';

export const poolConfig = {
  min: parseInt(process.env.DB_POOL_MIN || '2', 10),
  max: parseInt(process.env.DB_POOL_SIZE || '20', 10),
  idleTimeoutSeconds: parseInt(process.env.DB_IDLE_TIMEOUT || '30', 10),
  connectTimeoutSeconds: parseInt(process.env.DB_CONNECT_TIMEOUT || '10', 10),
};

// Parse DATABASE_URL with proper percent-decoding for special characters in credentials
const u = new URL(databaseUrl);
export const queryClient = postgres({
  host: u.hostname,
  port: Number(u.port) || 5432,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: decodeURIComponent(u.pathname.slice(1)),
  ssl:
    databaseUrl.includes('neon.tech') ||
    databaseUrl.includes('sslmode=require'),
  max: poolConfig.max,
  idle_timeout: poolConfig.idleTimeoutSeconds,
  connect_timeout: poolConfig.connectTimeoutSeconds,
  onnotice: () => {},
  debug: !isProduction,
});

export const db = drizzle(queryClient, {
  schema,
  logger: !isProduction,
});

export async function executeQuery(
  sql: string,
  params: unknown[] = []
): Promise<{ rows: Record<string, unknown>[] }> {
  const rows = await queryClient.unsafe(sql, params as any[]);
  return { rows: rows as Record<string, unknown>[] };
}

export async function executeTransaction<T>(
  callback: (transaction: {
    execute: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  }) => Promise<T>,
): Promise<T> {
  return queryClient.begin(async (transaction) => {
    const executor = {
      execute: async (sql: string, params: readonly unknown[] = []) => {
        const rows = await transaction.unsafe(sql, params as any[]);
        return { rows: rows as Record<string, unknown>[] };
      },
    };
    return callback(executor);
  }) as unknown as Promise<T>;
}

export async function checkDatabaseHealth(): Promise<'healthy' | 'unhealthy'> {
  try {
    await queryClient`SELECT 1`;
    return 'healthy';
  } catch (error) {
    logger.error('Database health check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unhealthy';
  }
}

export function getDatabaseStats() {
  return {
    minConnections: poolConfig.min,
    maxConnections: poolConfig.max,
    idleTimeoutSeconds: poolConfig.idleTimeoutSeconds,
    connectTimeoutSeconds: poolConfig.connectTimeoutSeconds,
  };
}

export async function connectWithRetry(
  maxAttempts: number = 5,
  delayMs: number = 2000
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await queryClient`SELECT 1`;
      logger.info('Database connection verified', { attempt });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === maxAttempts) {
        logger.error('Database connection failed after all retry attempts', {
          attempt,
          maxAttempts,
          error: message,
        });
        throw new Error(
          `Failed to connect to database after ${maxAttempts} attempts: ${message}`
        );
      }
      const backoff = delayMs * Math.pow(2, attempt - 1);
      logger.warn('Database connection attempt failed, retrying', {
        attempt,
        maxAttempts,
        nextDelayMs: backoff,
        error: message,
      });
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
}

// backend#1259: the GracefulShutdown handler timeout and postgres.js's own `end`
// timeout were both 5 s, so on a loaded or unreachable database the handler timer
// won the race, the shutdown was reported as failed and the process exited 1 instead
// of 0 (a flaky live-entrypoint suite). postgres.js must give up first.
export const DB_END_TIMEOUT_SECONDS = 3;
export const DB_SHUTDOWN_HANDLER_TIMEOUT_MS = 8000;

export async function closeDatabaseConnection(): Promise<void> {
  try {
    await queryClient.end({ timeout: DB_END_TIMEOUT_SECONDS });
    logger.info('Database connection closed gracefully');
  } catch (error) {
    logger.error('Error closing database connection', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const shutdown = GracefulShutdown.getInstance();
shutdown.registerHandler({
  name: 'database-connection',
  priority: ShutdownPriority.CLOSE_DATABASE,
  timeout: DB_SHUTDOWN_HANDLER_TIMEOUT_MS,
  handler: closeDatabaseConnection,
});

logger.info('Database connection initialized', {
  url: databaseUrl.replace(/:\/\/.*@/, '://***@'),
  ssl:
    databaseUrl.includes('sslmode=require') ||
    databaseUrl.includes('neon.tech'),
  poolMin: poolConfig.min,
  poolMax: poolConfig.max,
  idleTimeoutSeconds: poolConfig.idleTimeoutSeconds,
});

export default db;
