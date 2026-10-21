const mockSecurityLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const path = require('path');

jest.mock('../../utils/logger', () => ({
  securityLogger: mockSecurityLogger,
  createLogger: jest.fn(),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const ONE_HOUR_MS = 60 * 60 * 1000;

describe('authLogging hourly cleanup timer', () => {
  let uncaughtHandler;
  const authLoggingPath = path.resolve(__dirname, '../../middleware/authLogging.js');

  const loadAuthLogging = () => {
    jest.resetModules();
    return require(authLoggingPath);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockSecurityLogger.debug.mockClear();
    mockSecurityLogger.info.mockClear();
    mockSecurityLogger.warn.mockClear();
    mockSecurityLogger.error.mockClear();

    uncaughtHandler = jest.fn();
    process.on('uncaughtException', uncaughtHandler);
  });

  afterEach(() => {
    process.off('uncaughtException', uncaughtHandler);
    jest.useRealTimers();
    jest.clearAllTimers();
    jest.resetModules();
    delete require.cache[authLoggingPath];
  });

  test('fires cleanup without uncaught exception and clears one tracked failure', () => {
    const authLogging = loadAuthLogging();

    authLogging.logAuthFailure(
      {
        ip: '198.51.100.1',
        method: 'POST',
        originalUrl: '/auth/login',
        headers: {},
        connection: { remoteAddress: '198.51.100.1' },
      },
      'invalid-password',
      'alice'
    );

    expect(() => {
      jest.advanceTimersByTime(ONE_HOUR_MS);
    }).not.toThrow();

    expect(uncaughtHandler).not.toHaveBeenCalled();
    expect(mockSecurityLogger.debug).toHaveBeenCalledWith(
      'Cleaning authentication failure cache',
      { cacheSize: 1 }
    );
  });
});
