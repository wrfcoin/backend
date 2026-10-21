#!/usr/bin/env node
/**
 * Host CLI: issue a short-lived backend ADMIN token (backend#1329 item 1).
 *
 * Run only on the host that holds JWT_SECRET, with JWT_SECRET (and REDIS_URL, the
 * same Redis the backend uses) in this process's OWN environment. There is no HTTP
 * issuer. The token is printed to stdout ONLY; the secret is never printed or
 * logged. Every issuance writes one audit line (JSON, no token) to stderr and, when
 * ADMIN_TOKEN_AUDIT_LOG is set, appends it to that file.
 *
 *   node scripts/issue-admin-token.cjs [--ttl-minutes 1..15 (default 10)] [--subject <label>]
 *
 * The admin routes' requireAdmin (middleware/authMiddleware.js) requires a live session, so
 * this also writes the session record (`session:<id>`, same shape as
 * RedisSessionService.createSession) with a TTL equal to the token lifetime.
 * Claims: roles ['admin'], issuer/audience from server/auth/jwt-constants.ts.
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const jwt = require('jsonwebtoken');

const JWT_ISSUER = 'wrfcoin-platform'; // server/auth/jwt-constants.ts
const JWT_AUDIENCE = 'wrfcoin-api';
const MAX_TTL_MINUTES = 15;
const DEFAULT_TTL_MINUTES = 10;

class AdminTokenError extends Error {}

function parseArgs(argv) {
  const out = { ttlMinutes: DEFAULT_TTL_MINUTES, subject: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ttl-minutes') out.ttlMinutes = Number(argv[++i]);
    else if (arg === '--subject') out.subject = argv[++i];
    else throw new AdminTokenError(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.ttlMinutes) || out.ttlMinutes < 1 || out.ttlMinutes > MAX_TTL_MINUTES) {
    throw new AdminTokenError(`--ttl-minutes must be an integer from 1 to ${MAX_TTL_MINUTES}`);
  }
  if (out.subject !== undefined && !/^[A-Za-z0-9._:@-]{1,64}$/.test(out.subject)) {
    throw new AdminTokenError('--subject must match [A-Za-z0-9._:@-]{1,64}');
  }
  return out;
}

function loadSigningKey(env) {
  // The admin routes verify with server/middleware/authMiddleware.js, which is HS256 with
  // JWT_SECRET only. An RS256 token would verify nowhere, so RS256 issuance is refused.
  if (env.JWT_PRIVATE_KEY_PATH?.trim()) {
    throw new AdminTokenError('RS256 issuance is not supported: the admin verifier is HS256-only (JWT_SECRET)');
  }
  const secret = env.JWT_SECRET;
  if (!secret) throw new AdminTokenError('JWT_SECRET is not set in this process environment');
  if (secret.length < 32) throw new AdminTokenError('JWT_SECRET must be at least 32 characters');
  return { key: secret, algorithm: 'HS256' };
}

/** Pure: build the token + the session record the backend requires. */
function buildAdminToken({ key, algorithm, ttlMinutes, subject, now = Date.now(), sessionId = crypto.randomUUID() }) {
  const iat = Math.floor(now / 1000);
  const ttlSeconds = ttlMinutes * 60;
  const userId = subject ?? `admin-cli:${os.userInfo().username}`;
  const token = jwt.sign(
    { userId, roles: ['admin'], permissions: [], sessionId, jti: sessionId, iat },
    key,
    { algorithm, expiresIn: ttlSeconds, issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
  );
  const session = {
    userId, roles: ['admin'], permissions: [], sessionId,
    createdAt: new Date(now).toISOString(), lastActivity: new Date(now).toISOString(),
  };
  return { token, sessionId, userId, ttlSeconds, expiresAt: new Date((iat + ttlSeconds) * 1000).toISOString(), session };
}

function auditLine(issued, env = process.env) {
  return JSON.stringify({
    event: 'admin_token_issued', at: new Date().toISOString(), userId: issued.userId,
    sessionId: issued.sessionId, expiresAt: issued.expiresAt, ttlSeconds: issued.ttlSeconds,
    hostUser: os.userInfo().username, host: os.hostname(), pid: process.pid,
    sudoUser: env.SUDO_USER || undefined,
  });
}

async function run({ argv, env, stdout, stderr, redisFactory }) {
  const { ttlMinutes, subject } = parseArgs(argv);
  const { key, algorithm } = loadSigningKey(env);
  const issued = buildAdminToken({ key, algorithm, ttlMinutes, subject });
  const redis = await redisFactory(env.REDIS_URL || 'redis://localhost:6379');
  try {
    await redis.setex(`session:${issued.sessionId}`, issued.ttlSeconds, JSON.stringify(issued.session));
    await redis.sadd(`session:user:${issued.userId}:sessions`, issued.sessionId);
    await redis.expire(`session:user:${issued.userId}:sessions`, issued.ttlSeconds * 2);
  } finally {
    await redis.quit?.();
  }
  const line = auditLine(issued, env);
  stderr.write(`${line}\n`);
  if (env.ADMIN_TOKEN_AUDIT_LOG) fs.appendFileSync(env.ADMIN_TOKEN_AUDIT_LOG, `${line}\n`, { mode: 0o600 });
  stdout.write(`${issued.token}\n`);
  return issued;
}

async function defaultRedisFactory(url) {
  const Redis = require('ioredis');
  const client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 3000 });
  await client.connect();
  return client;
}

if (require.main === module) {
  run({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr, redisFactory: defaultRedisFactory })
    .then(() => process.exit(0))
    .catch((error) => {
      // Never print the secret or anything derived from it; the message is ours or ioredis'.
      process.stderr.write(`issue-admin-token: ${error instanceof Error ? error.message : 'failed'}\n`);
      process.exit(1);
    });
}

module.exports = { JWT_ISSUER, JWT_AUDIENCE, MAX_TTL_MINUTES, DEFAULT_TTL_MINUTES, AdminTokenError, parseArgs, loadSigningKey, buildAdminToken, auditLine, run };
