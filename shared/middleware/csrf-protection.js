const crypto = require('crypto');

const CSRF_TOKEN_LENGTH = 32;
const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE = 'csrf-token';
const CSRF_COOKIE_HTTP_ONLY = 'csrf-token-http';

const DEFAULT_CONFIG = {
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
  ignorePaths: [],
  cookie: {
    name: CSRF_COOKIE,
    path: '/',
    domain: undefined,
    maxAge: 3600,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  },
  refreshToken: false,
  onError: (_req, res) => {
    res.status(403).json({
      error: 'CSRF Token Invalid',
      message:
        'The CSRF token is missing or invalid. Please refresh the page and try again.',
      code: 'CSRF_TOKEN_INVALID',
    });
  },
};

function generateCsrfToken() {
  return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('base64url');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    const dummy = Buffer.alloc(bufA.length);
    crypto.timingSafeEqual(bufA, dummy);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

function shouldIgnorePath(path, ignorePaths) {
  return ignorePaths.some(ignorePath => path.startsWith(ignorePath));
}

function parseCookies(req) {
  if (req.cookies && typeof req.cookies === 'object') {
    return req.cookies;
  }

  const header = req.headers.cookie;
  if (!header) {
    return {};
  }

  return header.split(';').reduce((cookies, part) => {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      return cookies;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function extractTokenFromRequest(req) {
  const headerToken = req.headers[CSRF_HEADER];
  if (headerToken) {
    return headerToken;
  }

  if (req.body && typeof req.body === 'object') {
    const bodyToken = req.body._csrf || req.body.csrfToken;
    if (typeof bodyToken === 'string') {
      return bodyToken;
    }
  }

  return null;
}

function csrfProtectionMiddleware(config = {}) {
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    cookie: {
      ...DEFAULT_CONFIG.cookie,
      ...config.cookie,
    },
  };

  return (req, res, next) => {
    if (mergedConfig.ignoreMethods.includes(req.method.toUpperCase())) {
      const cookies = parseCookies(req);
      const existingToken = cookies[mergedConfig.cookie.name];

      if (!existingToken) {
        const token = generateCsrfToken();
        res.cookie(mergedConfig.cookie.name, token, {
          httpOnly: false,
          secure: mergedConfig.cookie.secure,
          sameSite: mergedConfig.cookie.sameSite,
          path: mergedConfig.cookie.path,
          domain: mergedConfig.cookie.domain,
          maxAge: mergedConfig.cookie.maxAge * 1000,
        });
        res.cookie(CSRF_COOKIE_HTTP_ONLY, token, {
          httpOnly: true,
          secure: mergedConfig.cookie.secure,
          sameSite: mergedConfig.cookie.sameSite,
          path: mergedConfig.cookie.path,
          domain: mergedConfig.cookie.domain,
          maxAge: mergedConfig.cookie.maxAge * 1000,
        });
        res.locals.csrfToken = token;
      } else {
        res.locals.csrfToken = existingToken;
      }

      return next();
    }

    if (shouldIgnorePath(req.path, mergedConfig.ignorePaths)) {
      return next();
    }

    const cookies = parseCookies(req);
    const cookieToken = cookies[CSRF_COOKIE_HTTP_ONLY];
    const requestToken = extractTokenFromRequest(req);

    if (!cookieToken) {
      mergedConfig.onError(req, res, 'Missing CSRF cookie');
      return;
    }

    if (!requestToken) {
      mergedConfig.onError(req, res, 'Missing CSRF token in request');
      return;
    }

    if (requestToken.length < 20 || requestToken.length > 100) {
      mergedConfig.onError(req, res, 'Invalid CSRF token format');
      return;
    }

    if (!timingSafeEqual(cookieToken, requestToken)) {
      mergedConfig.onError(req, res, 'CSRF token mismatch');
      return;
    }

    if (mergedConfig.refreshToken) {
      const newToken = generateCsrfToken();
      res.cookie(mergedConfig.cookie.name, newToken, {
        httpOnly: false,
        secure: mergedConfig.cookie.secure,
        sameSite: mergedConfig.cookie.sameSite,
        path: mergedConfig.cookie.path,
        domain: mergedConfig.cookie.domain,
        maxAge: mergedConfig.cookie.maxAge * 1000,
      });
      res.cookie(CSRF_COOKIE_HTTP_ONLY, newToken, {
        httpOnly: true,
        secure: mergedConfig.cookie.secure,
        sameSite: mergedConfig.cookie.sameSite,
        path: mergedConfig.cookie.path,
        domain: mergedConfig.cookie.domain,
        maxAge: mergedConfig.cookie.maxAge * 1000,
      });
      res.locals.csrfToken = newToken;
    } else {
      res.locals.csrfToken = cookieToken;
    }

    next();
  };
}

module.exports = {
  csrfProtectionMiddleware,
  default: csrfProtectionMiddleware,
  generateCsrfToken,
};
