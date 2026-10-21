/**
 * Graceful Shutdown Manager
 *
 * Singleton class that orchestrates graceful shutdown of application resources.
 * Executes registered handlers in priority order with timeout management.
 */

import { EventEmitter } from 'events';
import type {
  GracefulShutdownConfig,
  IGracefulShutdown,
  ShutdownHandler,
  ShutdownHandlerResult,
  ShutdownState,
} from './types.js';

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: GracefulShutdownConfig = {
  globalTimeout: 30000,
  defaultHandlerTimeout: 5000,
  enableLogging: true,
  exitCodeSuccess: 0,
  exitCodeError: 1,
  handleUncaughtExceptions: true,
  handleUnhandledRejections: true,
};

/**
 * GracefulShutdown singleton class
 *
 * Manages the orderly shutdown of application resources by executing
 * registered handlers in priority order with proper timeout handling.
 */
export class GracefulShutdown extends EventEmitter implements IGracefulShutdown {
  private static instance: GracefulShutdown | null = null;

  private handlers: Map<string, ShutdownHandler> = new Map();
  private state: ShutdownState = 'idle';
  private config: GracefulShutdownConfig;
  private shutdownPromise: Promise<ShutdownHandlerResult[]> | null = null;
  private signalHandlersSetup = false;
  private signalHandlerSigTerm: (() => void) | null = null;
  private signalHandlerSigInt: (() => void) | null = null;
  private fatalHandlerUncaught: ((error: unknown) => void) | null = null;
  private fatalHandlerUnhandled:
    | ((reason: unknown) => void)
    | null = null;

  private constructor(config: Partial<GracefulShutdownConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(
    config?: Partial<GracefulShutdownConfig>
  ): GracefulShutdown {
    if (!GracefulShutdown.instance) {
      GracefulShutdown.instance = new GracefulShutdown(config);
    } else if (config) {
      GracefulShutdown.instance.configure(config);
    }
    return GracefulShutdown.instance;
  }

  /**
   * Reset the singleton instance (primarily for testing)
   */
  public static resetInstance(): void {
    if (GracefulShutdown.instance) {
      GracefulShutdown.instance.detachProcessListeners();
      GracefulShutdown.instance.removeAllListeners();
      GracefulShutdown.instance.handlers.clear();
      GracefulShutdown.instance.state = 'idle';
      GracefulShutdown.instance.shutdownPromise = null;
    }
    GracefulShutdown.instance = null;
  }

  /**
   * Update configuration
   */
  public configure(config: Partial<GracefulShutdownConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Log a message using the configured logger
   */
  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (!this.config.enableLogging) return;

    if (this.config.logger) {
      this.config.logger(message, level);
    } else {
      const prefix = `[GracefulShutdown]`;
      switch (level) {
        case 'error':
          console.error(`${prefix} ${message}`);
          break;
        case 'warn':
          console.warn(`${prefix} ${message}`);
          break;
        default:
          console.log(`${prefix} ${message}`);
      }
    }
  }

  /**
   * Register a shutdown handler
   */
  public registerHandler(handler: ShutdownHandler): void {
    if (this.state !== 'idle') {
      this.log(
        `Cannot register handler "${handler.name}" - shutdown already in progress`,
        'warn'
      );
      return;
    }

    if (this.handlers.has(handler.name)) {
      this.log(
        `Handler "${handler.name}" already registered, replacing`,
        'warn'
      );
    }

    const handlerWithDefaults: ShutdownHandler = {
      ...handler,
      timeout: handler.timeout ?? this.config.defaultHandlerTimeout,
    };

    this.handlers.set(handler.name, handlerWithDefaults);
    this.log(`Registered handler: ${handler.name} (priority: ${handler.priority})`);
  }

  /**
   * Unregister a shutdown handler by name
   */
  public unregisterHandler(name: string): boolean {
    if (this.state !== 'idle') {
      this.log(
        `Cannot unregister handler "${name}" - shutdown already in progress`,
        'warn'
      );
      return false;
    }

    const removed = this.handlers.delete(name);
    if (removed) {
      this.log(`Unregistered handler: ${name}`);
    }
    return removed;
  }

  /**
   * Set up signal handlers for graceful shutdown
   */
  public setupSignalHandlers(): void {
    if (this.signalHandlersSetup) {
      this.log('Signal handlers already set up', 'warn');
      return;
    }

    const handleSignal = (signal: string) => {
      this.log(`Received ${signal} signal`);
      this.shutdown(signal).catch((error) => {
        this.log(`Shutdown error: ${error.message}`, 'error');
      });
    };

    const runFatalShutdown = (signal: string) => {
      this.log(`Received ${signal}. Running fatal shutdown...`);
      this.shutdown(signal)
        .then(() => {
          process.exit(this.config.exitCodeError);
        })
        .catch(() => {
          process.exit(this.config.exitCodeError);
        });
    };

    this.signalHandlerSigTerm = () => handleSignal('SIGTERM');
    this.signalHandlerSigInt = () => handleSignal('SIGINT');
    process.on('SIGTERM', this.signalHandlerSigTerm);
    process.on('SIGINT', this.signalHandlerSigInt);

    if (this.config.handleUncaughtExceptions) {
      this.fatalHandlerUncaught = (error: unknown) => {
        const fatalError = error instanceof Error ? error : new Error(String(error));
        this.log(`Uncaught exception: ${fatalError.message}`, 'error');
        this.log(fatalError.stack || '', 'error');
        runFatalShutdown('uncaughtException');
      };
      process.on('uncaughtException', this.fatalHandlerUncaught);
    }

    if (this.config.handleUnhandledRejections) {
      this.fatalHandlerUnhandled = (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        this.log(`Unhandled rejection: ${error.message}`, 'error');
        runFatalShutdown('unhandledRejection');
      };
      process.on('unhandledRejection', this.fatalHandlerUnhandled);
    }

    this.signalHandlersSetup = true;
    this.log('Signal handlers configured');
  }

  private detachProcessListeners(): void {
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
   */
  private async executeHandler(
    handler: ShutdownHandler
  ): Promise<ShutdownHandlerResult> {
    const startTime = Date.now();

    this.emit('handler:start', handler.name, handler.priority);
    this.log(`Executing handler: ${handler.name}`);

    try {
      const handlerPromise = Promise.resolve(handler.handler());

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Handler "${handler.name}" timed out after ${handler.timeout}ms`));
        }, handler.timeout);
      });

      await Promise.race([handlerPromise, timeoutPromise]);

      const duration = Date.now() - startTime;
      const result: ShutdownHandlerResult = {
        name: handler.name,
        success: true,
        duration,
        timedOut: false,
      };

      this.log(`Handler ${handler.name} completed in ${duration}ms`);
      this.emit('handler:complete', result);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const isTimeout = error instanceof Error && error.message.includes('timed out');
      const result: ShutdownHandlerResult = {
        name: handler.name,
        success: false,
        duration,
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: isTimeout,
      };

      if (isTimeout) {
        this.log(`Handler ${handler.name} timed out after ${duration}ms`, 'warn');
      } else {
        this.log(
          `Handler ${handler.name} failed: ${result.error?.message}`,
          'error'
        );
      }

      this.emit('handler:complete', result);
      return result;
    }
  }

  /**
   * Initiate the shutdown sequence
   */
  public async shutdown(signal: string): Promise<ShutdownHandlerResult[]> {
    // If already shutting down, return the existing promise
    if (this.shutdownPromise) {
      this.log('Shutdown already in progress, waiting for completion');
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.executeShutdown(signal);
    return this.shutdownPromise;
  }

  /**
   * Execute the shutdown sequence
   */
  private async executeShutdown(signal: string): Promise<ShutdownHandlerResult[]> {
    this.state = 'starting';
    this.emit('shutdown:start', signal);
    this.log(`Starting shutdown sequence (signal: ${signal})`);

    const results: ShutdownHandlerResult[] = [];
    let hasErrors = false;

    // Set up global timeout
    const globalTimeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), this.config.globalTimeout);
    });

    // Sort handlers by priority
    const sortedHandlers = Array.from(this.handlers.values()).sort(
      (a, b) => a.priority - b.priority
    );

    this.state = 'in_progress';
    this.log(`Executing ${sortedHandlers.length} handlers`);

    // Execute handlers with global timeout
    const executeAll = async (): Promise<'complete'> => {
      // Group handlers by priority for parallel execution within same priority
      const priorityGroups = new Map<number, ShutdownHandler[]>();
      for (const handler of sortedHandlers) {
        const group = priorityGroups.get(handler.priority) || [];
        group.push(handler);
        priorityGroups.set(handler.priority, group);
      }

      // Execute each priority group in order
      const sortedPriorities = Array.from(priorityGroups.keys()).sort(
        (a, b) => a - b
      );

      for (const priority of sortedPriorities) {
        const handlers = priorityGroups.get(priority)!;
        this.log(`Executing priority ${priority} handlers (${handlers.length})`);

        // Execute handlers in the same priority group in parallel
        const groupResults = await Promise.all(
          handlers.map((handler) => this.executeHandler(handler))
        );

        results.push(...groupResults);

        // Check for errors
        for (const result of groupResults) {
          if (!result.success) {
            hasErrors = true;
          }
        }
      }

      return 'complete';
    };

    try {
      const raceResult = await Promise.race([executeAll(), globalTimeoutPromise]);

      if (raceResult === 'timeout') {
        this.log('Global shutdown timeout reached, force terminating', 'warn');
        this.emit('shutdown:timeout');
        hasErrors = true;
      }

      this.state = hasErrors ? 'failed' : 'completed';
      this.emit('shutdown:complete', results);

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.length - successCount;
      this.log(
        `Shutdown complete: ${successCount} succeeded, ${failCount} failed`
      );

      // Exit process after all handlers complete
      const exitCode = hasErrors
        ? this.config.exitCodeError
        : this.config.exitCodeSuccess;

      this.log(`Exiting with code ${exitCode}`);

      // Small delay to allow final logs to flush
      setTimeout(() => {
        process.exit(exitCode);
      }, 100);

      return results;
    } catch (error) {
      this.state = 'failed';
      const shutdownError =
        error instanceof Error ? error : new Error(String(error));
      this.emit('shutdown:error', shutdownError);
      this.log(`Shutdown sequence failed: ${shutdownError.message}`, 'error');

      // Force exit on catastrophic failure
      setTimeout(() => {
        process.exit(this.config.exitCodeError);
      }, 100);

      throw shutdownError;
    }
  }

  /**
   * Get the current shutdown state
   */
  public getState(): ShutdownState {
    return this.state;
  }

  /**
   * Check if shutdown is in progress
   */
  public isShuttingDown(): boolean {
    return this.state !== 'idle' && this.state !== 'completed';
  }

  /**
   * Get all registered handlers
   */
  public getHandlers(): ReadonlyArray<ShutdownHandler> {
    return Array.from(this.handlers.values());
  }
}

export default GracefulShutdown;
