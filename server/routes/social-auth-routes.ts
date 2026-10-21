import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  completeSocialLogin,
  verifyGithubIdentity,
  verifyGoogleIdToken,
} from '../services/social-auth-service.js';

const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

const socialRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: 'Too many social auth requests',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: 15 * 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
});

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function defaultDb(): DbExecutor {
  // Lazy dynamic import — avoids "require is not defined" in ESM bundles (#268)
  let cachedExecuteQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null = null;
  return {
    execute: async (sql: string, params?: unknown[]) => {
      if (!cachedExecuteQuery) {
        const mod = await import('../../database/index.js');
        cachedExecuteQuery = mod.executeQuery;
      }
      return cachedExecuteQuery!(sql, params);
    },
  };
}

export function createSocialAuthRouter(db?: DbExecutor): express.Router {
  const router = express.Router();

  // Social login endpoints are public — the user sends an ID token from
  // an external provider to create a session (no JWT exists yet).
  // Keep authenticateJWT import available for future account-linking endpoints.

  const testMode = (process.env.SOCIAL_AUTH_TEST_MODE || '').toLowerCase() === 'true';

  // POST /google
  router.post('/google', socialRateLimiter, async (req, res) => {
    const executor = db ?? defaultDb();
    const { idToken, mockSub, mockEmail } = req.body ?? {};
    if (testMode && mockSub) {
      const auth = await completeSocialLogin(
        {
          provider: 'google',
          sub: String(mockSub),
          email: mockEmail ? String(mockEmail) : undefined,
        },
        executor
      );
      return res.status(200).json(auth);
    }

    if (!idToken) {
      return res.status(400).json({ error: 'idToken required (or mockSub in test mode)' });
    }

    try {
      const identity = await verifyGoogleIdToken(String(idToken));
      const auth = await completeSocialLogin(
        {
          provider: 'google',
          sub: identity.sub,
          email: identity.email,
        },
        executor
      );
      return res.status(200).json(auth);
    } catch (_err) {
      return res.status(401).json({ error: 'Invalid Google identity token' });
    }
  });

  // POST /github
  router.post('/github', socialRateLimiter, async (req, res) => {
    const executor = db ?? defaultDb();
    const { code, accessToken, mockSub, mockEmail } = req.body ?? {};
    if (testMode && mockSub) {
      const auth = await completeSocialLogin(
        {
          provider: 'github',
          sub: String(mockSub),
          email: mockEmail ? String(mockEmail) : undefined,
        },
        executor
      );
      return res.status(200).json(auth);
    }

    if (!code && !accessToken) {
      return res.status(400).json({ error: 'code or accessToken required (or mockSub in test mode)' });
    }

    try {
      const identity = await verifyGithubIdentity({
        code: code ? String(code) : undefined,
        accessToken: accessToken ? String(accessToken) : undefined,
      });
      const auth = await completeSocialLogin(
        {
          provider: 'github',
          sub: identity.sub,
          email: identity.email,
        },
        executor
      );
      return res.status(200).json(auth);
    } catch (_err) {
      return res.status(401).json({ error: 'Invalid GitHub social auth' });
    }
  });

  // POST /apple (kept for compatibility)
  router.post('/apple', socialRateLimiter, async (req, res) => {
    const executor = db ?? defaultDb();
    const { idToken, mockSub, mockEmail } = req.body ?? {};
    if (testMode && mockSub) {
      const auth = await completeSocialLogin(
        {
          provider: 'apple',
          sub: String(mockSub),
          email: mockEmail ? String(mockEmail) : undefined,
        },
        executor
      );
      return res.status(200).json(auth);
    }
    if (!idToken) {
      return res.status(400).json({ error: 'idToken required (or mockSub in test mode)' });
    }

    try {
      const { payload } = await jwtVerify(String(idToken), APPLE_JWKS, {
        issuer: 'https://appleid.apple.com',
        audience: process.env.APPLE_CLIENT_ID,
      });
      const auth = await completeSocialLogin(
        {
          provider: 'apple',
          sub: String(payload.sub),
          email: payload.email ? String(payload.email) : undefined,
        },
        executor
      );
      return res.status(200).json(auth);
    } catch (_err) {
      return res.status(401).json({ error: 'Invalid Apple ID token' });
    }
  });

  return router;
}

export default createSocialAuthRouter();
