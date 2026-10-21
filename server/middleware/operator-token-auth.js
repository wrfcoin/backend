const crypto = require('crypto');

function getConfiguredOperatorToken() {
  const token = process.env.WRFCOIN_OPERATOR_TOKEN;
  return typeof token === 'string' && token.trim().length > 0
    ? token.trim()
    : null;
}

function extractBearerToken(authorizationHeader) {
  if (
    typeof authorizationHeader !== 'string' ||
    !authorizationHeader.startsWith('Bearer ')
  ) {
    return null;
  }

  const token = authorizationHeader.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function tokensMatch(expectedToken, providedToken) {
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(providedToken);

  if (
    expectedBuffer.length === 0 ||
    expectedBuffer.length !== providedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function requireOperatorToken(req, res, next) {
  const configuredToken = getConfiguredOperatorToken();
  if (!configuredToken) {
    return res.status(503).json({
      success: false,
      error: 'Operator authentication is not configured on this server',
    });
  }

  const providedToken = extractBearerToken(req.headers.authorization);
  if (!providedToken) {
    return res.status(401).json({
      success: false,
      error: 'Missing authorization token',
    });
  }

  if (!tokensMatch(configuredToken, providedToken)) {
    return res.status(403).json({
      success: false,
      error: 'Invalid authorization token',
    });
  }

  req.operatorAuthenticated = true;
  return next();
}

function presentsConfiguredToken(req, envNames) {
  const providedToken = extractBearerToken(req.headers && req.headers.authorization);
  if (!providedToken) {
    return false;
  }
  return envNames.some(name => {
    const configured = process.env[name];
    return (
      typeof configured === 'string' &&
      configured.trim().length > 0 &&
      tokensMatch(configured.trim(), providedToken)
    );
  });
}

/**
 * Non-rejecting check: does this request carry the operator bearer token?
 * For routes that stay public but must hand anonymous callers a redacted
 * projection (backend#1222, #1224).
 */
function hasOperatorToken(req) {
  return presentsConfiguredToken(req, ['WRFCOIN_OPERATOR_TOKEN']);
}

/**
 * Like hasOperatorToken, but also accepts WRFCOIN_READER_TOKEN — the
 * read-only credential Prometheus scrapes with (infra writes it into
 * prometheus-bearer-token). Use for operational detail, never for PII.
 */
function hasOperatorOrReaderToken(req) {
  return presentsConfiguredToken(req, ['WRFCOIN_OPERATOR_TOKEN', 'WRFCOIN_READER_TOKEN']);
}

module.exports = {
  extractBearerToken,
  getConfiguredOperatorToken,
  hasOperatorOrReaderToken,
  hasOperatorToken,
  requireOperatorToken,
};
