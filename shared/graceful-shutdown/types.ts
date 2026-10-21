/**
 * Graceful Shutdown Types
 *
 * Type definitions for the graceful shutdown utility.
 * Provides interfaces for handlers, configuration, and state management.
 */

import type { EventEmitter } from 'events';

/**
 * Shutdown priority constants.
 * Lower numbers execute first during shutdown sequence.
 * Handlers are grouped and executed in priority order.
 */
export const ShutdownPriority = {
  /** Stop accepting new connections (load balancer health checks fail) */
  STOP_ACCEPTING_CONNECTIONS: 10,
  /** Drain existing HTTP connections (wait for in-flight requests) */
  DRAIN_HTTP_CONNECTIONS: 20,
  /** Close WebSocket connections gracefully */
  CLOSE_WEBSOCKETS: 30,
  /** Stop background jobs and scheduled tasks */
  STOP_BACKGROUND_JOBS: 40,
  /** Flush message queues and ensure delivery */
  FLUSH_QUEUES: 50,
  /** Close database connections */
  CLOSE_DATABASE: 60,
  /** Close cache connections (Redis, Memcached) */
  CLOSE_CACHE: 70,
  /** Flush logs to ensure all entries are persisted */
  FLUSH_LOGS: 80,
  /** Final cleanup operations */
  CLEANUP: 90,
} as const;

export type ShutdownPriorityValue =
  (typeof ShutdownPriority)[keyof typeof ShutdownPriority];

/**
 * Result of a shutdown handler execution
 */
export interface ShutdownHandlerResult {
  /** Handler name for identification */
  name: string;
  /** Whether the handler completed successfully */
  success: boolean;
  /** Time taken to execute in milliseconds */
  duration: number;
  /** Error if the handler failed */
  error?: Error;
  /** Whether the handler was forcefully terminated due to timeout */
  timedOut: boolean;
}

/**
 * Shutdown handler configuration
 */
export interface ShutdownHandler {
  /** Unique name for the handler */
  name: string;
  /** Execution priority (lower numbers execute first) */
  priority: ShutdownPriorityValue | number;
  /** Timeout for this handler in milliseconds (default: 5000) */
  timeout: number;
  /**
   * Handler function to execute during shutdown.
   * Should clean up resources and return when complete.
   * Must not call process.exit() directly.
   */
  handler: () => Promise<void> | void;
}

/**
 * Configuration for the GracefulShutdown manager
 */
export interface GracefulShutdownConfig {
  /** Global timeout for entire shutdown sequence in milliseconds (default: 30000) */
  globalTimeout: number;
  /** Default timeout for individual handlers in milliseconds (default: 5000) */
  defaultHandlerTimeout: number;
  /** Whether to log shutdown progress (default: true) */
  enableLogging: boolean;
  /** Custom logger function */
  logger?: (message: string, level: 'info' | 'warn' | 'error') => void;
  /** Exit code on successful shutdown (default: 0) */
  exitCodeSuccess: number;
  /** Exit code on shutdown with errors (default: 1) */
  exitCodeError: number;
  /** Whether to handle uncaught exceptions (default: true) */
  handleUncaughtExceptions: boolean;
  /** Whether to handle unhandled promise rejections (default: true) */
  handleUnhandledRejections: boolean;
}

/**
 * Possible states of the shutdown manager
 */
export type ShutdownState =
  | 'idle'
  | 'starting'
  | 'in_progress'
  | 'completed'
  | 'failed';

/**
 * Events emitted during shutdown lifecycle
 */
export interface ShutdownEvents {
  /** Emitted when shutdown sequence begins */
  'shutdown:start': (signal: string) => void;
  /** Emitted before each handler executes */
  'handler:start': (name: string, priority: number) => void;
  /** Emitted after each handler completes */
  'handler:complete': (result: ShutdownHandlerResult) => void;
  /** Emitted when shutdown sequence completes */
  'shutdown:complete': (results: ShutdownHandlerResult[]) => void;
  /** Emitted on shutdown error */
  'shutdown:error': (error: Error) => void;
  /** Emitted when global timeout is reached */
  'shutdown:timeout': () => void;
}

/**
 * Interface for the GracefulShutdown manager
 */
export interface IGracefulShutdown extends EventEmitter {
  /**
   * Register a shutdown handler
   * @param handler The handler configuration
   */
  registerHandler(handler: ShutdownHandler): void;

  /**
   * Unregister a shutdown handler by name
   * @param name The handler name to remove
   * @returns true if handler was found and removed
   */
  unregisterHandler(name: string): boolean;

  /**
   * Set up signal handlers for SIGTERM, SIGINT, etc.
   */
  setupSignalHandlers(): void;

  /**
   * Initiate the shutdown sequence
   * @param signal The signal that triggered shutdown
   * @returns Promise that resolves when shutdown is complete
   */
  shutdown(signal: string): Promise<ShutdownHandlerResult[]>;

  /**
   * Get the current shutdown state
   */
  getState(): ShutdownState;

  /**
   * Check if shutdown is in progress
   */
  isShuttingDown(): boolean;

  /**
   * Get all registered handlers
   */
  getHandlers(): ReadonlyArray<ShutdownHandler>;

  /**
   * Update configuration
   * @param config Partial configuration to merge
   */
  configure(config: Partial<GracefulShutdownConfig>): void;
}
