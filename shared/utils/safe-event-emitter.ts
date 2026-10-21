/**
 * Safe Event Emitter Wrapper
 *
 * Provides event emission with listener verification and logging
 * to prevent silent data loss when events have no listeners.
 *
 * Task 118.5: Data Handling & Validation - Data Pipeline Audit
 */

import { EventEmitter } from 'events';

// Import logger - use a relative import that works with the project structure
let logger: { warn: (msg: string, meta?: object) => void; info: (msg: string, meta?: object) => void };
try {
  // Try to import the weather logger (commonly used in backend services)
  const { weatherLogger } = require('../../server/utils/logger.js');
  logger = weatherLogger;
} catch {
  // Fallback to console if logger not available
  logger = {
    warn: (msg: string, meta?: object) => console.warn(msg, meta),
    info: (msg: string, meta?: object) => console.info(msg, meta),
  };
}

/**
 * Result of a safe emit operation
 */
export interface SafeEmitResult {
  /** Whether any listeners received the event */
  delivered: boolean;
  /** Number of listeners that received the event */
  listenerCount: number;
  /** Whether the event was logged due to no listeners */
  logged: boolean;
}

/**
 * Configuration for SafeEventEmitter
 */
export interface SafeEventEmitterConfig {
  /** Whether to log warnings when events have no listeners (default: true) */
  warnOnNoListeners?: boolean;
  /** Custom logger to use instead of default */
  customLogger?: {
    warn: (msg: string, meta?: object) => void;
    info: (msg: string, meta?: object) => void;
  };
  /** Service name for logging context */
  serviceName?: string;
  /** Events that should not warn when no listeners (e.g., internal events) */
  silentEvents?: string[];
}

/**
 * SafeEventEmitter wraps the standard EventEmitter to provide:
 * - Listener verification before emission
 * - Logging when events have no listeners
 * - Metrics on event delivery
 *
 * This prevents silent data loss in event-driven pipelines.
 *
 * @example
 * ```typescript
 * const emitter = new SafeEventEmitter({ serviceName: 'WeatherService' });
 *
 * // Safe emit - logs warning if no listeners
 * const result = emitter.safeEmit('data:processed', { id: '123' });
 * if (!result.delivered) {
 *   console.log('No listeners for event');
 * }
 *
 * // Check listeners before emitting
 * if (emitter.hasListeners('data:processed')) {
 *   emitter.emit('data:processed', { id: '123' });
 * }
 * ```
 */
export class SafeEventEmitter extends EventEmitter {
  private config: Required<SafeEventEmitterConfig>;
  private emitStats: Map<string, { total: number; delivered: number; dropped: number }>;

  constructor(config: SafeEventEmitterConfig = {}) {
    super();
    this.config = {
      warnOnNoListeners: config.warnOnNoListeners ?? true,
      customLogger: config.customLogger ?? logger,
      serviceName: config.serviceName ?? 'SafeEventEmitter',
      silentEvents: config.silentEvents ?? [],
    };
    this.emitStats = new Map();
  }

  /**
   * Emits an event with listener verification.
   * Logs a warning if no listeners are registered for the event.
   *
   * @param event - The event name to emit
   * @param data - The data to pass to listeners
   * @returns SafeEmitResult with delivery status
   */
  safeEmit<T = unknown>(event: string | symbol, data: T): SafeEmitResult {
    const eventKey = String(event);
    const count = this.listenerCount(event);

    // Update stats
    const stats = this.emitStats.get(eventKey) ?? { total: 0, delivered: 0, dropped: 0 };
    stats.total++;

    if (count === 0) {
      stats.dropped++;
      this.emitStats.set(eventKey, stats);

      // Log warning if configured and not a silent event
      const shouldLog = this.config.warnOnNoListeners &&
                       !this.config.silentEvents.includes(eventKey);

      if (shouldLog) {
        this.config.customLogger.warn(
          `Event emitted with no listeners: ${eventKey}`,
          {
            service: this.config.serviceName,
            event: eventKey,
            dataType: typeof data,
            hasData: data !== null && data !== undefined,
          }
        );
      }

      return {
        delivered: false,
        listenerCount: 0,
        logged: shouldLog,
      };
    }

    // Emit the event
    stats.delivered++;
    this.emitStats.set(eventKey, stats);
    this.emit(event, data);

    return {
      delivered: true,
      listenerCount: count,
      logged: false,
    };
  }

  /**
   * Checks if there are any listeners for an event.
   *
   * @param event - The event name to check
   * @returns true if there is at least one listener
   */
  hasListeners(event: string | symbol): boolean {
    return this.listenerCount(event) > 0;
  }

  /**
   * Gets emission statistics for all events.
   * Useful for monitoring event delivery rates.
   *
   * @returns Map of event names to their emission stats
   */
  getEmitStats(): Map<string, { total: number; delivered: number; dropped: number }> {
    return new Map(this.emitStats);
  }

  /**
   * Gets emission statistics for a specific event.
   *
   * @param event - The event name
   * @returns Stats object or undefined if no emissions recorded
   */
  getEventStats(event: string): { total: number; delivered: number; dropped: number } | undefined {
    return this.emitStats.get(event);
  }

  /**
   * Resets emission statistics.
   */
  resetStats(): void {
    this.emitStats.clear();
  }

  /**
   * Logs a summary of all event emission statistics.
   * Useful for debugging and monitoring.
   */
  logStatsSummary(): void {
    const summary: Record<string, { total: number; delivered: number; dropped: number; deliveryRate: string }> = {};

    this.emitStats.forEach((stats, event) => {
      summary[event] = {
        ...stats,
        deliveryRate: stats.total > 0
          ? `${((stats.delivered / stats.total) * 100).toFixed(1)}%`
          : 'N/A',
      };
    });

    this.config.customLogger.info(
      `Event emission statistics for ${this.config.serviceName}`,
      { stats: summary }
    );
  }
}

/**
 * Creates a typed SafeEventEmitter for use with specific event maps.
 *
 * @example
 * ```typescript
 * interface MyEvents {
 *   'data:validated': { id: string; quality: number };
 *   'error:occurred': { message: string };
 * }
 *
 * const emitter = createTypedSafeEmitter<MyEvents>({ serviceName: 'DataService' });
 * emitter.safeEmit('data:validated', { id: '123', quality: 95 });
 * ```
 */
export function createTypedSafeEmitter<T extends Record<string, unknown>>(
  config?: SafeEventEmitterConfig
): SafeEventEmitter & {
  safeEmit<K extends keyof T>(event: K, data: T[K]): SafeEmitResult;
  on<K extends keyof T>(event: K, listener: (data: T[K]) => void): SafeEventEmitter;
} {
  return new SafeEventEmitter(config) as SafeEventEmitter & {
    safeEmit<K extends keyof T>(event: K, data: T[K]): SafeEmitResult;
    on<K extends keyof T>(event: K, listener: (data: T[K]) => void): SafeEventEmitter;
  };
}
