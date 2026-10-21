const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../server/utils/logger', () => ({
  logger: mockLogger,
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'signed-access-token'),
  verify: jest.fn(),
  decode: jest.fn(),
}), { virtual: true });

describe('jwtSecurity refresh-token cleanup', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('schedules periodic cleanup on module load', () => {
    const unref = jest.fn();
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockImplementation(() => ({ unref } as unknown as NodeJS.Timeout));

    jest.isolateModules(() => {
      require('../server/middleware/jwtSecurity.js');
    });

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      30 * 60 * 1000
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('prunes expired refresh tokens during cleanup', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-05T00:00:00Z'));

    jest.isolateModules(() => {
      const jwtSecurity = require('../server/middleware/jwtSecurity.js');
      const refreshToken = jwtSecurity.generateRefreshToken('user-123');

      jest.setSystemTime(new Date('2026-04-13T00:00:00Z'));
      jwtSecurity.cleanupExpiredRefreshTokens();

      expect(() => jwtSecurity.refreshAccessToken(refreshToken)).toThrow(
        'Invalid refresh token'
      );
    });
  });
});
