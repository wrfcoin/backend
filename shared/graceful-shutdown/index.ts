/**
 * Graceful Shutdown Utility
 *
 * Provides structured shutdown management for Node.js applications.
 * Includes factory functions for common resource types.
 *
 * @example
 * ```typescript
 * import {
 *   GracefulShutdown,
 *   ShutdownPriority,
 *   createHttpServerShutdownHandler,
 *   createDatabaseShutdownHandler,
 * } from './graceful-shutdown.js';
 *
 * const shutdown = GracefulShutdown.getInstance();
 *
 * // Register handlers
 * shutdown.registerHandler(createHttpServerShutdownHandler(httpServer));
 * shutdown.registerHandler(createDatabaseShutdownHandler(dbPool));
 *
 * // Set up signal handling
 * shutdown.setupSignalHandlers();
 * ```
 */

// Re-export types
export {
  ShutdownPriority,
  type GracefulShutdownConfig,
  type IGracefulShutdown,
  type ShutdownEvents,
  type ShutdownHandler,
  type ShutdownHandlerResult,
  type ShutdownPriorityValue,
  type ShutdownState,
} from './types.js';

// Re-export main class
export { GracefulShutdown } from './graceful-shutdown.js';

import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import type { WebSocketServer } from 'ws';
import { ShutdownPriority, type ShutdownHandler } from './types.js';

/**
 * Generic pool interface for database connections
 */
interface DatabasePool {
  end(): Promise<void>;
}

/**
 * Generic Redis client interface
 */
interface RedisClient {
  quit(): Promise<unknown>;
  disconnect?(): Promise<void>;
}

/**
 * Create a shutdown handler for HTTP/HTTPS servers
 *
 * Stops accepting new connections and waits for existing connections to drain.
 *
 * @param server - HTTP or HTTPS server instance
 * @param options - Configuration options
 * @returns ShutdownHandler for the server
 *
 * @example
 * ```typescript
 * const server = http.createServer(app);
 * shutdown.registerHandler(createHttpServerShutdownHandler(server));
 * ```
 */
export function createHttpServerShutdownHandler(
  server: HttpServer | HttpsServer,
  options: {
    name?: string;
    timeout?: number;
    forceCloseConnections?: boolean;
  } = {}
): ShutdownHandler {
  const {
    name = 'http-server',
    timeout = 10000,
    forceCloseConnections = true,
  } = options;

  // Track connections for forced close
  const connections = new Set<import('net').Socket>();

  if (forceCloseConnections) {
    server.on('connection', (socket) => {
      connections.add(socket);
      socket.on('close', () => {
        connections.delete(socket);
      });
    });
  }

  return {
    name,
    priority: ShutdownPriority.DRAIN_HTTP_CONNECTIONS,
    timeout,
    handler: () => {
      return new Promise<void>((resolve, reject) => {
        // Stop accepting new connections
        server.close((error) => {
          if (error) {
            // Server might already be closed
            if ((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
              resolve();
              return;
            }
            reject(error);
            return;
          }
          resolve();
        });

        // Force close connections after a grace period
        if (forceCloseConnections) {
          setTimeout(() => {
            Array.from(connections).forEach((socket) => {
              socket.destroy();
            });
            connections.clear();
          }, timeout * 0.8);
        }
      });
    },
  };
}

/**
 * Create a shutdown handler for database connection pools
 *
 * Closes all database connections gracefully.
 *
 * @param pool - Database connection pool (pg.Pool, mysql2.Pool, etc.)
 * @param options - Configuration options
 * @returns ShutdownHandler for the database pool
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * const pool = new Pool({ connectionString: DATABASE_URL });
 * shutdown.registerHandler(createDatabaseShutdownHandler(pool));
 * ```
 */
export function createDatabaseShutdownHandler(
  pool: DatabasePool,
  options: {
    name?: string;
    timeout?: number;
  } = {}
): ShutdownHandler {
  const { name = 'database', timeout = 5000 } = options;

  return {
    name,
    priority: ShutdownPriority.CLOSE_DATABASE,
    timeout,
    handler: async () => {
      await pool.end();
    },
  };
}

/**
 * Create a shutdown handler for Redis clients
 *
 * Gracefully disconnects Redis connections.
 *
 * @param client - Redis client instance (ioredis, redis, etc.)
 * @param options - Configuration options
 * @returns ShutdownHandler for the Redis client
 *
 * @example
 * ```typescript
 * import Redis from 'ioredis';
 * const redis = new Redis(REDIS_URL);
 * shutdown.registerHandler(createRedisShutdownHandler(redis));
 * ```
 */
export function createRedisShutdownHandler(
  client: RedisClient,
  options: {
    name?: string;
    timeout?: number;
  } = {}
): ShutdownHandler {
  const { name = 'redis', timeout = 5000 } = options;

  return {
    name,
    priority: ShutdownPriority.CLOSE_CACHE,
    timeout,
    handler: async () => {
      try {
        await client.quit();
      } catch {
        // If quit fails, try disconnect
        if (client.disconnect) {
          await client.disconnect();
        }
      }
    },
  };
}

/**
 * Create a shutdown handler for intervals and timers
 *
 * Clears all registered intervals to stop background tasks.
 *
 * @param intervals - Array of interval IDs to clear
 * @param options - Configuration options
 * @returns ShutdownHandler for clearing intervals
 *
 * @example
 * ```typescript
 * const intervals: NodeJS.Timeout[] = [];
 * intervals.push(setInterval(() => console.log('tick'), 1000));
 * intervals.push(setInterval(() => checkHealth(), 5000));
 * shutdown.registerHandler(createIntervalShutdownHandler(intervals));
 * ```
 */
export function createIntervalShutdownHandler(
  intervals: NodeJS.Timeout[],
  options: {
    name?: string;
    timeout?: number;
  } = {}
): ShutdownHandler {
  const { name = 'intervals', timeout = 1000 } = options;

  return {
    name,
    priority: ShutdownPriority.STOP_BACKGROUND_JOBS,
    timeout,
    handler: () => {
      for (const interval of intervals) {
        clearInterval(interval);
      }
    },
  };
}

/**
 * Create a shutdown handler for WebSocket servers
 *
 * Closes all WebSocket connections and the server.
 *
 * @param wss - WebSocket server instance
 * @param options - Configuration options
 * @returns ShutdownHandler for the WebSocket server
 *
 * @example
 * ```typescript
 * import { WebSocketServer } from 'ws';
 * const wss = new WebSocketServer({ port: 8080 });
 * shutdown.registerHandler(createWebSocketShutdownHandler(wss));
 * ```
 */
export function createWebSocketShutdownHandler(
  wss: WebSocketServer,
  options: {
    name?: string;
    timeout?: number;
    closeCode?: number;
    closeReason?: string;
  } = {}
): ShutdownHandler {
  const {
    name = 'websocket-server',
    timeout = 5000,
    closeCode = 1001,
    closeReason = 'Server shutting down',
  } = options;

  return {
    name,
    priority: ShutdownPriority.CLOSE_WEBSOCKETS,
    timeout,
    handler: () => {
      return new Promise<void>((resolve, reject) => {
        // Close all connected clients
        Array.from(wss.clients).forEach((client) => {
          try {
            client.close(closeCode, closeReason);
          } catch {
            // Client may already be closed
            client.terminate();
          }
        });

        // Close the server
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

/**
 * Create a shutdown handler for flushing a queue or buffer
 *
 * Generic handler for flushing queues, buffers, or streams.
 *
 * @param flushFn - Function to execute for flushing
 * @param options - Configuration options
 * @returns ShutdownHandler for queue flushing
 *
 * @example
 * ```typescript
 * const messageQueue = new Queue();
 * shutdown.registerHandler(
 *   createQueueFlushHandler(() => messageQueue.flush(), { name: 'message-queue' })
 * );
 * ```
 */
export function createQueueFlushHandler(
  flushFn: () => Promise<void> | void,
  options: {
    name?: string;
    timeout?: number;
    priority?: number;
  } = {}
): ShutdownHandler {
  const {
    name = 'queue-flush',
    timeout = 10000,
    priority = ShutdownPriority.FLUSH_QUEUES,
  } = options;

  return {
    name,
    priority,
    timeout,
    handler: flushFn,
  };
}

/**
 * Create a shutdown handler for custom cleanup logic
 *
 * Generic handler for any cleanup operation.
 *
 * @param cleanupFn - Function to execute for cleanup
 * @param options - Configuration options
 * @returns ShutdownHandler for cleanup
 *
 * @example
 * ```typescript
 * shutdown.registerHandler(
 *   createCleanupHandler(async () => {
 *     await tempFiles.cleanup();
 *     await auditLog.flush();
 *   }, { name: 'cleanup' })
 * );
 * ```
 */
export function createCleanupHandler(
  cleanupFn: () => Promise<void> | void,
  options: {
    name?: string;
    timeout?: number;
    priority?: number;
  } = {}
): ShutdownHandler {
  const {
    name = 'cleanup',
    timeout = 5000,
    priority = ShutdownPriority.CLEANUP,
  } = options;

  return {
    name,
    priority,
    timeout,
    handler: cleanupFn,
  };
}
