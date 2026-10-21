/**
 * Graceful Shutdown Manager
 *
 * Centralized shutdown handling for the WRFCoin platform.
 * Provides coordinated cleanup of resources during application shutdown.
 *
 * Features:
 * - Priority-based handler execution
 * - Configurable timeouts per handler and globally
 * - Signal handler setup (SIGTERM, SIGINT)
 * - Event emission for monitoring
 * - Singleton pattern for consistent behavior
 */

import { EventEmitter } from 'events';

/**
 * Shutdown priority constants.
 * Lower numbers execute first during shutdown sequence.
 */
export const ShutdownPriority = {
  STOP_ACCEPTING_CONNECTIONS: 10,
  DRAIN_HTTP_CONNECTIONS: 20,
  CLOSE_WEBSOCKETS: 30,
  STOP_BACKGROUND_JOBS: 40,
  FLUSH_QUEUES: 50,
  CLOSE_DATABASE: 60,
  CLOSE_CACHE: 70,
  FLUSH_LOGS: 80,
  CLEANUP: 90,
};

/**
 * Default configuration for GracefulShutdown
 */
export const DEFAULT_CONFIG = {
  globalTimeout: 30000,
  defaultHandlerTimeout: 5000,
  enableLogging: true,
  logger: null,
  exitCodeSuccess: 0,
  exitCodeError: 1,
  handleUncaughtExceptions: true,
  handleUnhandledRejections: true,
};

export function createHttpServerShutdownHandler(server, options = {}) {
  const {
    name = 'http-server',
    timeout = 10000,
    forceCloseConnections = true,
  } = options;

  const connections = new Set();

  if (forceCloseConnections) {
    server.on('connection', socket => {
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
    handler: () =>
      new Promise((resolve, reject) => {
        server.close(error => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error);
            return;
          }
          resolve();
        });

        if (forceCloseConnections) {
          setTimeout(() => {
            for (const socket of connections) {
              socket.destroy();
            }
            connections.clear();
          }, Math.floor(timeout * 0.8));
        }
      }),
  };
}

export class GracefulShutdown extends EventEmitter {
  static instance = null;

  /**
   * Get the singleton instance of GracefulShutdown
   * @param {Partial<typeof DEFAULT_CONFIG>} config Optional configuration
   * @returns {GracefulShutdown}
   */
  static getInstance(config = {}) {
    if (!GracefulShutdown.instance) {
      GracefulShutdown.instance = new GracefulShutdown(config);
    }
    return GracefulShutdown.instance;
  }

  /**
   * Reset the singleton instance (mainly for testing)
   */
  static resetInstance() {
    if (GracefulShutdown.instance) {
      GracefulShutdown.instance.detachProcessListeners();
      GracefulShutdown.instance.removeAllListeners();
      GracefulShutdown.instance = null;
    }
  }

  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.handlers = [];
    this.state = 'idle';
    this.shutdownPromise = null;
    this.signalHandlersSetup = false;
    this.signalHandlerSigTerm = null;
    this.signalHandlerSigInt = null;
    this.fatalHandlerUncaught = null;
    this.fatalHandlerUnhandled = null;
  }

  /**
   * Log a message using the configured logger
   * @param {string} message
   * @param {'info' | 'warn' | 'error'} level
   */
  log(message, level = 'info') {
    if (!this.config.enableLogging) return;

    if (this.config.logger) {
      this.config.logger(message, level);
    } else {
      const prefix = `[GracefulShutdown] [${level.toUpperCase()}]`;
      if (level === 'error') {
        console.error(`${prefix} ${message}`);
      } else if (level === 'warn') {
        console.warn(`${prefix} ${message}`);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  }

  /**
   * Register a shutdown handler
   * @param {Object} handler
   * @param {string} handler.name Unique name for the handler
   * @param {number} handler.priority Execution priority (lower = first)
   * @param {number} [handler.timeout] Timeout for this handler in milliseconds
   * @param {Function} handler.handler Handler function to execute
   */
  registerHandler(handler) {
    if (!handler.name || typeof handler.handler !== 'function') {
      throw new Error('Handler must have a name and handler function');
    }

    // Remove existing handler with same name
    this.unregisterHandler(handler.name);

    this.handlers.push({
      name: handler.name,
      priority: handler.priority ?? ShutdownPriority.CLEANUP,
      timeout: handler.timeout ?? this.config.defaultHandlerTimeout,
      handler: handler.handler,
    });

    // Sort handlers by priority
    this.handlers.sort((a, b) => a.priority - b.priority);

    this.log(`Registered handler: ${handler.name} (priority: ${handler.priority})`);
  }

  /**
   * Unregister a shutdown handler by name
   * @param {string} name
   * @returns {boolean} True if handler was found and removed
   */
  unregisterHandler(name) {
    const index = this.handlers.findIndex(h => h.name === name);
    if (index !== -1) {
      this.handlers.splice(index, 1);
      this.log(`Unregistered handler: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * Set up signal handlers for SIGTERM and SIGINT
   */
  setupSignalHandlers() {
    if (this.signalHandlersSetup) {
      this.log('Signal handlers already set up', 'warn');
      return;
    }

    const handleSignal = signal => {
      this.log(`Received ${signal}. Starting graceful shutdown...`);
      this.shutdown(signal).then(results => {
        const hasErrors = results.some(r => !r.success);
        const exitCode = hasErrors
          ? this.config.exitCodeError
          : this.config.exitCodeSuccess;
        process.exit(exitCode);
      });
    };

    const runFatalShutdown = (signal) => {
      this.log(`Received ${signal}. Running fatal shutdown...`);
      this.shutdown(signal)
        .catch(error => {
          this.log(`Fatal shutdown failed: ${error.message}`, 'error');
        })
        .finally(() => {
          process.exit(this.config.exitCodeError);
        });
    };

    this.signalHandlerSigTerm = () => handleSignal('SIGTERM');
    this.signalHandlerSigInt = () => handleSignal('SIGINT');
    process.on('SIGTERM', this.signalHandlerSigTerm);
    process.on('SIGINT', this.signalHandlerSigInt);

    if (this.config.handleUncaughtExceptions) {
      this.fatalHandlerUncaught = error => {
        this.log(`Unhandled exception: ${error?.message || 'Unknown error'}`, 'error');
        runFatalShutdown('uncaughtException');
      };
      process.on('uncaughtException', this.fatalHandlerUncaught);
    }

    if (this.config.handleUnhandledRejections) {
      this.fatalHandlerUnhandled = reason => {
        const reasonMessage =
          reason instanceof Error ? reason.message : String(reason);
        this.log(`Unhandled rejection: ${reasonMessage}`, 'error');
        runFatalShutdown('unhandledRejection');
      };
      process.on('unhandledRejection', this.fatalHandlerUnhandled);
    }

    this.signalHandlersSetup = true;
    this.log('Signal and fatal process listeners set up');
  }

  detachProcessListeners() {
    if (this.signalHandlerSigTerm) {
      process.off('SIGTERM', this.signalHandlerSigTerm);
    }
    if (this.signalHandlerSigInt) {
      process.off('SIGINT', this.signalHandlerSigInt);
    }
    if (this.fatalHandlerUncaught) {
      process.off('uncaughtException', this.fatalHandlerUncaught);
    }
    if (this.fatalHandlerUnhandled) {
      process.off('unhandledRejection', this.fatalHandlerUnhandled);
    }
    this.signalHandlersSetup = false;
    this.signalHandlerSigTerm = null;
    this.signalHandlerSigInt = null;
    this.fatalHandlerUncaught = null;
    this.fatalHandlerUnhandled = null;
  }

  /**
   * Execute a single handler with timeout
   * @param {Object} handler
   * @returns {Promise<Object>}
   */
  async executeHandler(handler) {
    const startTime = Date.now();
    const result = {
      name: handler.name,
      success: false,
      duration: 0,
      error: null,
      timedOut: false,
    };

    this.emit('handler:start', handler.name, handler.priority);

    try {
      const handlerPromise = Promise.resolve(handler.handler());
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Handler timeout after ${handler.timeout}ms`));
        }, handler.timeout);
      });

      await Promise.race([handlerPromise, timeoutPromise]);

      result.success = true;
      result.duration = Date.now() - startTime;
      this.log(`Handler completed: ${handler.name} (${result.duration}ms)`);
    } catch (error) {
      result.duration = Date.now() - startTime;
      result.error = error;
      result.timedOut = error.message.includes('timeout');
      this.log(
        `Handler failed: ${handler.name} - ${error.message}`,
        'error'
      );
    }

    this.emit('handler:complete', result);
    return result;
  }

  /**
   * Initiate the shutdown sequence
   * @param {string} signal The signal that triggered shutdown
   * @returns {Promise<Array>} Results from all handlers
   */
  async shutdown(signal) {
    // If already shutting down, return the existing promise
    if (this.state !== 'idle' && this.shutdownPromise) {
      this.log('Shutdown already in progress, waiting for completion...', 'warn');
      return this.shutdownPromise;
    }

    this.state = 'starting';
    this.emit('shutdown:start', signal);
    this.log(`Starting graceful shutdown (signal: ${signal})`);

    this.shutdownPromise = this.executeShutdown();
    return this.shutdownPromise;
  }

  /**
   * Execute the shutdown sequence
   * @returns {Promise<Array>}
   */
  async executeShutdown() {
    const results = [];
    this.state = 'in_progress';

    // Set global timeout
    const globalTimeoutHandle = setTimeout(() => {
      this.log('Global shutdown timeout reached', 'error');
      this.emit('shutdown:timeout');
      this.state = 'failed';
    }, this.config.globalTimeout);

    try {
      // Group handlers by priority
      const priorityGroups = new Map();
      for (const handler of this.handlers) {
        if (!priorityGroups.has(handler.priority)) {
          priorityGroups.set(handler.priority, []);
        }
        priorityGroups.get(handler.priority).push(handler);
      }

      // Execute handlers in priority order
      const sortedPriorities = Array.from(priorityGroups.keys()).sort(
        (a, b) => a - b
      );

      for (const priority of sortedPriorities) {
        const handlers = priorityGroups.get(priority);
        this.log(
          `Executing ${handlers.length} handler(s) at priority ${priority}`
        );

        // Execute handlers at the same priority level in parallel
        const groupResults = await Promise.all(
          handlers.map(handler => this.executeHandler(handler))
        );
        results.push(...groupResults);
      }

      this.state = 'completed';
      this.log('Graceful shutdown completed');
    } catch (error) {
      this.state = 'failed';
      this.log(`Shutdown failed: ${error.message}`, 'error');
      this.emit('shutdown:error', error);
    } finally {
      clearTimeout(globalTimeoutHandle);
    }

    this.emit('shutdown:complete', results);
    return results;
  }

  /**
   * Get the current shutdown state
   * @returns {'idle' | 'starting' | 'in_progress' | 'completed' | 'failed'}
   */
  getState() {
    return this.state;
  }

  /**
   * Check if shutdown is in progress
   * @returns {boolean}
   */
  isShuttingDown() {
    return this.state !== 'idle' && this.state !== 'completed' && this.state !== 'failed';
  }

  /**
   * Get all registered handlers
   * @returns {ReadonlyArray<Object>}
   */
  getHandlers() {
    return Object.freeze([...this.handlers]);
  }

  /**
   * Update configuration
   * @param {Partial<typeof DEFAULT_CONFIG>} config
   */
  configure(config) {
    this.config = { ...this.config, ...config };
    this.log('Configuration updated');
  }
}

export default GracefulShutdown;
