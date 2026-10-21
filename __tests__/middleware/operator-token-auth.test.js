const {
  extractBearerToken,
  getConfiguredOperatorToken,
  requireOperatorToken,
} = require('../../server/middleware/operator-token-auth.js');

describe('operator-token-auth middleware', () => {
  const originalOperatorToken = process.env.WRFCOIN_OPERATOR_TOKEN;

  let req;
  let res;
  let next;

  beforeEach(() => {
    req = {
      headers: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
  });

  afterAll(() => {
    if (originalOperatorToken === undefined) {
      delete process.env.WRFCOIN_OPERATOR_TOKEN;
    } else {
      process.env.WRFCOIN_OPERATOR_TOKEN = originalOperatorToken;
    }
  });

  test('extractBearerToken returns trimmed bearer token', () => {
    expect(extractBearerToken('Bearer  abc123  ')).toBe('abc123');
    expect(extractBearerToken('Basic abc123')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  test('getConfiguredOperatorToken trims configured token', () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = '  test-token  ';
    expect(getConfiguredOperatorToken()).toBe('test-token');
  });

  test('returns 503 when operator token is not configured', () => {
    requireOperatorToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Operator authentication is not configured on this server',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when bearer token is missing', () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'expected-token';

    requireOperatorToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Missing authorization token',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 403 when bearer token does not match', () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'expected-token';
    req.headers.authorization = 'Bearer wrong-token';

    requireOperatorToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Invalid authorization token',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next when bearer token matches', () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'expected-token';
    req.headers.authorization = 'Bearer expected-token';

    requireOperatorToken(req, res, next);

    expect(req.operatorAuthenticated).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
