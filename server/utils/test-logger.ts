/**
 * Test-Specific Logging Configuration - Task 113.9
 *
 * Provides Winston logger configuration optimized for Jest test environments:
 * - Silences verbose logs by default for clean test output
 * - Captures logs in memory for test assertions
 * - Provides mock logger utilities for unit tests
 * - Supports DEBUG mode for troubleshooting failing tests
 */

import winston from 'winston';
import Transport from 'winston-transport';

/**
 * Captured log entry structure for test assertions
 */
export interface CapturedLogEntry {
  level: string;
  message: string;
  timestamp?: string;
  service?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * In-memory transport that captures logs for test assertions
 */
export class TestLogCapture extends Transport {
  private logs: CapturedLogEntry[] = [];
  private maxLogs: number;

  constructor(opts?: Transport.TransportStreamOptions & { maxLogs?: number }) {
    super(opts);
    this.maxLogs = opts?.maxLogs ?? 1000;
  }

  log(info: winston.LogEntry, callback: () => void): void {
    setImmediate(() => {
      const entry: CapturedLogEntry = {
        level: info.level,
        message: info.message,
        timestamp: info.timestamp as string | undefined,
        service: info.service as string | undefined,
        correlationId: info.correlationId as string | undefined,
        metadata: {},
      };

      // Capture additional metadata
      const excludeKeys = new Set([
        'level',
        'message',
        'timestamp',
        'service',
        'correlationId',
        'Symbol(level)',
        'Symbol(splat)',
      ]);
      for (const [key, value] of Object.entries(info)) {
        if (!excludeKeys.has(key) && !key.startsWith('Symbol')) {
          entry.metadata![key] = value;
        }
      }

      // Maintain max log limit to prevent memory issues in long test runs
      if (this.logs.length >= this.maxLogs) {
        this.logs.shift();
      }
      this.logs.push(entry);
    });

    callback();
  }

  /**
   * Get all captured logs
   */
  getLogs(): CapturedLogEntry[] {
    return [...this.logs];
  }

  /**
   * Get logs filtered by level
   */
  getLogsByLevel(level: string): CapturedLogEntry[] {
    return this.logs.filter(log => log.level === level);
  }

  /**
   * Get logs containing a specific message substring
   */
  getLogsByMessage(messageSubstring: string): CapturedLogEntry[] {
    return this.logs.filter(log =>
      log.message.toLowerCase().includes(messageSubstring.toLowerCase())
    );
  }

  /**
   * Get logs by service name
   */
  getLogsByService(service: string): CapturedLogEntry[] {
    return this.logs.filter(log => log.service === service);
  }

  /**
   * Check if any log contains the specified message
   */
  hasLogWithMessage(message: string): boolean {
    return this.logs.some(log =>
      log.message.toLowerCase().includes(message.toLowerCase())
    );
  }

  /**
   * Check if any log has the specified level and message
   */
  hasLog(level: string, message: string): boolean {
    return this.logs.some(
      log =>
        log.level === level &&
        log.message.toLowerCase().includes(message.toLowerCase())
    );
  }

  /**
   * Get the last n logs
   */
  getLastLogs(n: number = 10): CapturedLogEntry[] {
    return this.logs.slice(-n);
  }

  /**
   * Clear all captured logs
   */
  clear(): void {
    this.logs = [];
  }
}

/**
 * Shared log capture instance for test assertions
 */
let sharedLogCapture: TestLogCapture | null = null;

/**
 * Get or create the shared log capture instance
 */
export function getTestLogCapture(): TestLogCapture {
  if (!sharedLogCapture) {
    sharedLogCapture = new TestLogCapture({ level: 'debug' });
  }
  return sharedLogCapture;
}

/**
 * Reset the shared log capture (call in beforeEach or afterEach)
 */
export function resetTestLogCapture(): void {
  if (sharedLogCapture) {
    sharedLogCapture.clear();
  }
}

/**
 * Determine the appropriate log level for test environment
 * - Returns 'debug' if DEBUG environment variable is set
 * - Returns 'error' for clean test output by default
 * - Respects LOG_LEVEL if explicitly set
 */
function getTestLogLevel(): string {
  if (process.env.DEBUG || process.env.TEST_DEBUG) {
    return 'debug';
  }
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL;
  }
  return 'error'; // Only show errors by default for clean test output
}

/**
 * Determine if logs should be completely silenced
 * Respects SILENT_LOGS environment variable
 */
function shouldSilenceLogs(): boolean {
  return (
    process.env.SILENT_LOGS === 'true' &&
    !process.env.DEBUG &&
    !process.env.TEST_DEBUG
  );
}

/**
 * Create a test-configured Winston logger
 *
 * Features:
 * - Silent by default unless DEBUG is set
 * - Captures logs for assertions via TestLogCapture
 * - Uses simple format for easier debugging when enabled
 */
export function createTestLogger(
  service: string = 'test'
): winston.Logger & { _testCapture: TestLogCapture } {
  const testCapture = getTestLogCapture();

  const transports: winston.transport[] = [testCapture];

  // Only add console transport if not silent and DEBUG is set
  if (!shouldSilenceLogs() && (process.env.DEBUG || process.env.TEST_DEBUG)) {
    transports.push(
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
          winston.format.printf(({ level, message, timestamp, service }) => {
            return `[TEST] ${timestamp} ${level} [${service}]: ${message}`;
          })
        ),
        level: getTestLogLevel(),
      })
    );
  }

  const logger = winston.createLogger({
    level: getTestLogLevel(),
    silent: shouldSilenceLogs(),
    defaultMeta: {
      service,
      environment: 'test',
    },
    transports,
  }) as winston.Logger & { _testCapture: TestLogCapture };

  // Attach test capture for direct access
  logger._testCapture = testCapture;

  return logger;
}

/**
 * Mock logger factory for unit tests
 *
 * Creates a logger with mocked methods that can be used to verify logging calls
 * without any actual logging output.
 */
export interface MockLogger {
  error: jest.Mock;
  warn: jest.Mock;
  info: jest.Mock;
  http: jest.Mock;
  debug: jest.Mock;
  log: jest.Mock;
  child: jest.Mock<MockLogger>;
  _calls: {
    error: Array<[string, Record<string, unknown>?]>;
    warn: Array<[string, Record<string, unknown>?]>;
    info: Array<[string, Record<string, unknown>?]>;
    http: Array<[string, Record<string, unknown>?]>;
    debug: Array<[string, Record<string, unknown>?]>;
  };
  _clear: () => void;
  _hasLogged: (level: string, message: string) => boolean;
  hasLog: (level: string, message: string) => boolean;
  getLogsByLevel: (level: string) => Array<[string, Record<string, unknown>?]>;
}

export function createMockLogger(): MockLogger {
  const calls: MockLogger['_calls'] = {
    error: [],
    warn: [],
    info: [],
    http: [],
    debug: [],
  };

  const createLogFn = (
    level: keyof MockLogger['_calls']
  ): jest.Mock<void, [string, Record<string, unknown>?]> => {
    return jest.fn((message: string, meta?: Record<string, unknown>) => {
      calls[level].push([message, meta]);
    });
  };

  const mockLogger: MockLogger = {
    error: createLogFn('error'),
    warn: createLogFn('warn'),
    info: createLogFn('info'),
    http: createLogFn('http'),
    debug: createLogFn('debug'),
    log: jest.fn((level: string, message: string, meta?: Record<string, unknown>) => {
      if (level in calls) {
        (calls as Record<string, Array<[string, Record<string, unknown>?]>>)[level].push([
          message,
          meta,
        ]);
      }
    }),
    child: jest.fn(() => createMockLogger()),
    _calls: calls,
    _clear: () => {
      calls.error = [];
      calls.warn = [];
      calls.info = [];
      calls.http = [];
      calls.debug = [];
      mockLogger.error.mockClear();
      mockLogger.warn.mockClear();
      mockLogger.info.mockClear();
      mockLogger.http.mockClear();
      mockLogger.debug.mockClear();
      mockLogger.log.mockClear();
    },
    _hasLogged: (level: string, message: string): boolean => {
      const levelCalls = (calls as Record<string, Array<[string, Record<string, unknown>?]>>)[level];
      if (!levelCalls) return false;
      return levelCalls.some(([msg]) =>
        msg.toLowerCase().includes(message.toLowerCase())
      );
    },
    hasLog: (level: string, message: string): boolean => {
      const levelCalls = (calls as Record<string, Array<[string, Record<string, unknown>?]>>)[level];
      if (!levelCalls) return false;
      return levelCalls.some(([msg]) =>
        msg.toLowerCase().includes(message.toLowerCase())
      );
    },
    getLogsByLevel: (level: string): Array<[string, Record<string, unknown>?]> => {
      return (calls as Record<string, Array<[string, Record<string, unknown>?]>>)[level] || [];
    },
  };

  return mockLogger;
}

/**
 * Jest custom matchers for log assertions
 *
 * Usage:
 *   expect(logger._testCapture).toHaveLoggedError('Database connection failed');
 *   expect(logger._testCapture).toHaveLogged('info', 'Server started');
 */
export const loggerMatchers = {
  toHaveLogged(
    received: TestLogCapture,
    level: string,
    message: string
  ): jest.CustomMatcherResult {
    const pass = received.hasLog(level, message);
    const logs = received.getLogs();

    return {
      pass,
      message: () =>
        pass
          ? `Expected not to find ${level} log containing "${message}"`
          : `Expected to find ${level} log containing "${message}"\n` +
            `Captured logs:\n${logs
              .map(l => `  [${l.level}] ${l.message}`)
              .join('\n') || '  (no logs captured)'}`,
    };
  },

  toHaveLoggedError(
    received: TestLogCapture,
    message: string
  ): jest.CustomMatcherResult {
    return loggerMatchers.toHaveLogged(received, 'error', message);
  },

  toHaveLoggedWarning(
    received: TestLogCapture,
    message: string
  ): jest.CustomMatcherResult {
    return loggerMatchers.toHaveLogged(received, 'warn', message);
  },

  toHaveLoggedInfo(
    received: TestLogCapture,
    message: string
  ): jest.CustomMatcherResult {
    return loggerMatchers.toHaveLogged(received, 'info', message);
  },

  toHaveLogCount(
    received: TestLogCapture,
    expectedCount: number
  ): jest.CustomMatcherResult {
    const actualCount = received.getLogs().length;
    const pass = actualCount === expectedCount;

    return {
      pass,
      message: () =>
        pass
          ? `Expected not to have ${expectedCount} logs`
          : `Expected ${expectedCount} logs but found ${actualCount}`,
    };
  },
};

/**
 * Configure environment for test logging
 *
 * Call this in jest.setup.js or at the beginning of test files
 * to ensure Winston is properly configured for tests.
 */
export function configureTestLogging(): void {
  // Set environment variables for test logging
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = 'error';
  }

  // Enable SILENT_LOGS unless debugging
  if (!process.env.DEBUG && !process.env.TEST_DEBUG) {
    process.env.SILENT_LOGS = 'true';
  }

  // Ensure NODE_ENV is set to test
  process.env.NODE_ENV = 'test';
}

/**
 * Jest setup hook to configure logging and add matchers
 *
 * Usage in jest.setup.js:
 *   const { setupTestLogging } = require('./backend/server/utils/test-logger');
 *   setupTestLogging();
 */
export function setupTestLogging(): void {
  configureTestLogging();

  // Reset log capture before each test
  beforeEach(() => {
    resetTestLogCapture();
  });

  // Add custom matchers if Jest expect is available
  if (typeof expect !== 'undefined' && typeof expect.extend === 'function') {
    expect.extend(loggerMatchers);
  }
}

// Type declarations for custom matchers
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toHaveLogged(level: string, message: string): R;
      toHaveLoggedError(message: string): R;
      toHaveLoggedWarning(message: string): R;
      toHaveLoggedInfo(message: string): R;
      toHaveLogCount(count: number): R;
    }
  }
}

export default {
  TestLogCapture,
  createTestLogger,
  createMockLogger,
  getTestLogCapture,
  resetTestLogCapture,
  configureTestLogging,
  setupTestLogging,
  loggerMatchers,
};
