/**
 * Test-Logger Unit Tests - Task 113.9
 *
 * Verifies that the test logging configuration works correctly:
 * - TestLogCapture captures logs for assertions
 * - createMockLogger provides mock methods for unit tests
 * - Custom Jest matchers work correctly
 * - Environment-based log silencing works
 */

import {
  TestLogCapture,
  createTestLogger,
  createMockLogger,
  getTestLogCapture,
  resetTestLogCapture,
  configureTestLogging,
} from '../../utils/test-logger.js';

describe('TestLogCapture', () => {
  let capture: TestLogCapture;

  beforeEach(() => {
    capture = new TestLogCapture({ level: 'debug' });
  });

  describe('log capture', () => {
    it('should capture logs with correct level and message', done => {
      const logEntry = {
        level: 'info',
        message: 'Test message',
        timestamp: new Date().toISOString(),
        service: 'test-service',
      };

      capture.log(logEntry as any, () => {
        // Use setImmediate to wait for the async log operation
        setImmediate(() => {
          const logs = capture.getLogs();
          expect(logs).toHaveLength(1);
          expect(logs[0].level).toBe('info');
          expect(logs[0].message).toBe('Test message');
          expect(logs[0].service).toBe('test-service');
          done();
        });
      });
    });

    it('should capture multiple logs', done => {
      const callback = jest.fn();

      capture.log({ level: 'info', message: 'First' } as any, callback);
      capture.log({ level: 'warn', message: 'Second' } as any, callback);
      capture.log({ level: 'error', message: 'Third' } as any, callback);

      setImmediate(() => {
        setImmediate(() => {
          const logs = capture.getLogs();
          expect(logs).toHaveLength(3);
          expect(logs.map(l => l.message)).toEqual(['First', 'Second', 'Third']);
          done();
        });
      });
    });

    it('should respect maxLogs limit', done => {
      const smallCapture = new TestLogCapture({ maxLogs: 2 });

      smallCapture.log({ level: 'info', message: 'First' } as any, () => {});
      smallCapture.log({ level: 'info', message: 'Second' } as any, () => {});
      smallCapture.log({ level: 'info', message: 'Third' } as any, () => {});

      setImmediate(() => {
        setImmediate(() => {
          setImmediate(() => {
            const logs = smallCapture.getLogs();
            expect(logs).toHaveLength(2);
            expect(logs.map(l => l.message)).toEqual(['Second', 'Third']);
            done();
          });
        });
      });
    });
  });

  describe('filtering methods', () => {
    beforeEach(done => {
      capture.log({ level: 'info', message: 'Info message' } as any, () => {});
      capture.log({ level: 'warn', message: 'Warning message' } as any, () => {});
      capture.log({ level: 'error', message: 'Error message' } as any, () => {});
      capture.log({ level: 'info', message: 'Another info', service: 'api' } as any, () => {});

      setImmediate(() => {
        setImmediate(() => {
          setImmediate(() => {
            setImmediate(() => done());
          });
        });
      });
    });

    it('should filter logs by level', () => {
      const infoLogs = capture.getLogsByLevel('info');
      expect(infoLogs).toHaveLength(2);
      infoLogs.forEach(log => expect(log.level).toBe('info'));
    });

    it('should filter logs by message substring', () => {
      const warningLogs = capture.getLogsByMessage('warning');
      expect(warningLogs).toHaveLength(1);
      expect(warningLogs[0].message).toBe('Warning message');
    });

    it('should filter logs by service', () => {
      const apiLogs = capture.getLogsByService('api');
      expect(apiLogs).toHaveLength(1);
      expect(apiLogs[0].message).toBe('Another info');
    });
  });

  describe('assertion helpers', () => {
    beforeEach(done => {
      capture.log({ level: 'error', message: 'Database connection failed' } as any, () => {});
      capture.log({ level: 'info', message: 'Server started' } as any, () => {});

      setImmediate(() => {
        setImmediate(() => done());
      });
    });

    it('should check if log exists with hasLog', () => {
      expect(capture.hasLog('error', 'database')).toBe(true);
      expect(capture.hasLog('error', 'not found')).toBe(false);
    });

    it('should check if message exists with hasLogWithMessage', () => {
      expect(capture.hasLogWithMessage('server')).toBe(true);
      expect(capture.hasLogWithMessage('shutdown')).toBe(false);
    });

    it('should return last n logs', () => {
      const lastLog = capture.getLastLogs(1);
      expect(lastLog).toHaveLength(1);
      expect(lastLog[0].message).toBe('Server started');
    });
  });

  describe('clear method', () => {
    it('should clear all captured logs', done => {
      capture.log({ level: 'info', message: 'Test' } as any, () => {});

      setImmediate(() => {
        expect(capture.getLogs()).toHaveLength(1);
        capture.clear();
        expect(capture.getLogs()).toHaveLength(0);
        done();
      });
    });
  });
});

describe('createTestLogger', () => {
  beforeEach(() => {
    resetTestLogCapture();
  });

  it('should create a logger with test capture attached', () => {
    const logger = createTestLogger('test-service');
    expect(logger._testCapture).toBeDefined();
    expect(logger._testCapture).toBeInstanceOf(TestLogCapture);
  });

  it('should capture logs to shared capture', done => {
    const logger = createTestLogger('test-service');
    logger.info('Test log message');

    setImmediate(() => {
      expect(logger._testCapture.hasLogWithMessage('Test log message')).toBe(true);
      done();
    });
  });

  it('should use test service name as default metadata', () => {
    const logger = createTestLogger('my-service');
    expect(logger.defaultMeta).toBeDefined();
    expect((logger.defaultMeta as any).service).toBe('my-service');
  });
});

describe('createMockLogger', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('should create a logger with mocked methods', () => {
    expect(mockLogger.error).toBeDefined();
    expect(mockLogger.warn).toBeDefined();
    expect(mockLogger.info).toBeDefined();
    expect(mockLogger.http).toBeDefined();
    expect(mockLogger.debug).toBeDefined();
    expect(mockLogger.log).toBeDefined();
  });

  it('should track calls to log methods', () => {
    mockLogger.info('Test info message', { key: 'value' });
    mockLogger.error('Test error message');

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith('Test info message', { key: 'value' });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  it('should track calls in _calls object', () => {
    mockLogger.info('Info 1');
    mockLogger.info('Info 2');
    mockLogger.error('Error 1');

    expect(mockLogger._calls.info).toHaveLength(2);
    expect(mockLogger._calls.error).toHaveLength(1);
  });

  it('should provide _hasLogged helper', () => {
    mockLogger.error('Database connection failed');
    mockLogger.info('Server started successfully');

    expect(mockLogger._hasLogged('error', 'database')).toBe(true);
    expect(mockLogger._hasLogged('error', 'server')).toBe(false);
    expect(mockLogger._hasLogged('info', 'server')).toBe(true);
  });

  it('should clear all mocks with _clear', () => {
    mockLogger.info('Test');
    mockLogger.error('Error');

    mockLogger._clear();

    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger._calls.info).toHaveLength(0);
    expect(mockLogger._calls.error).toHaveLength(0);
  });

  it('should create child loggers', () => {
    const childLogger = mockLogger.child({ requestId: '123' });
    expect(childLogger).toBeDefined();
    expect(childLogger.info).toBeDefined();
  });
});

describe('shared log capture utilities', () => {
  beforeEach(() => {
    resetTestLogCapture();
  });

  it('should return same instance from getTestLogCapture', () => {
    const capture1 = getTestLogCapture();
    const capture2 = getTestLogCapture();
    expect(capture1).toBe(capture2);
  });

  it('should reset capture with resetTestLogCapture', done => {
    const capture = getTestLogCapture();
    capture.log({ level: 'info', message: 'Test' } as any, () => {});

    setImmediate(() => {
      expect(capture.getLogs()).toHaveLength(1);
      resetTestLogCapture();
      expect(capture.getLogs()).toHaveLength(0);
      done();
    });
  });
});

describe('configureTestLogging', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should set NODE_ENV to test', () => {
    delete process.env.NODE_ENV;
    configureTestLogging();
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('should set LOG_LEVEL to error if not already set', () => {
    delete process.env.LOG_LEVEL;
    delete process.env.DEBUG;
    configureTestLogging();
    expect(process.env.LOG_LEVEL).toBe('error');
  });

  it('should enable SILENT_LOGS when not debugging', () => {
    delete process.env.DEBUG;
    delete process.env.TEST_DEBUG;
    configureTestLogging();
    expect(process.env.SILENT_LOGS).toBe('true');
  });

  it('should not enable SILENT_LOGS when DEBUG is set', () => {
    process.env.DEBUG = 'true';
    configureTestLogging();
    // SILENT_LOGS should not be set to true when DEBUG is enabled
    expect(process.env.SILENT_LOGS).not.toBe('true');
  });
});

describe('Jest custom matchers integration', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('should work with toHaveLogged matcher via mock logger interface', () => {
    mockLogger.info('Server started on port 3000');
    mockLogger.error('Failed to connect to database');

    // Mock logger implements hasLog and getLogs for compatibility
    expect(mockLogger.hasLog('info', 'server')).toBe(true);
    expect(mockLogger.hasLog('error', 'database')).toBe(true);
    expect(mockLogger.hasLog('warn', 'warning')).toBe(false);
  });

  it('should work with getLogsByLevel', () => {
    mockLogger.info('First info');
    mockLogger.info('Second info');
    mockLogger.error('An error');

    const infoLogs = mockLogger.getLogsByLevel('info');
    expect(infoLogs).toHaveLength(2);
  });
});
