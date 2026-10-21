/**
 * JWT Secret Validation
 *
 * Validates JWT_SECRET at startup. Throws in production if missing or weak;
 * logs a warning in development.
 */

export interface WarnLogger {
  warn(message: string, ...args: unknown[]): void;
}

/** Known weak prefixes that must be rejected. */
export const WEAK_PREFIXES = [
  'abc',
  '123',
  'test',
  'dev',
  'change-me',
  'secret',
  'password',
] as const;

export const WEAK_PREFIX_PATTERN = new RegExp(
  `^(${WEAK_PREFIXES.join('|')})`,
  'i'
);

export const MIN_SECRET_LENGTH = 32;

/**
 * Validates the JWT_SECRET environment variable.
 *
 * - Throws in production if the secret is absent, too short, or starts with a
 *   known-weak prefix.
 * - Logs a warning in non-production environments for the same conditions.
 *
 * @param logger  Logger with a `warn` method (injected for testability).
 * @param env     Process environment map (defaults to `process.env`).
 */
export function validateJwtSecret(
  logger: WarnLogger,
  env: NodeJS.ProcessEnv = process.env
): void {
  const secret = env.JWT_SECRET;
  const nodeEnv = env.NODE_ENV ?? 'development';
  // Treat testnet/staging like production: these environments are reachable by
  // untrusted users (e.g. the Tailscale-exposed testnet), so a weak/missing
  // JWT_SECRET must fail-closed, not just warn. Mirrors the gate in
  // shared/utils/oauth-state-validator.ts.
  const requiresStrongSecret =
    nodeEnv === 'production' ||
    nodeEnv === 'testnet' ||
    nodeEnv === 'staging';

  if (!secret) {
    const message =
      'JWT_SECRET is not set — social auth will fail unless SOCIAL_AUTH_TEST_MODE=true';
    if (requiresStrongSecret) {
      throw new Error(`JWT_SECRET is required in ${nodeEnv}`);
    }
    logger.warn(message);
    return;
  }

  const isWeak =
    secret.length < MIN_SECRET_LENGTH || WEAK_PREFIX_PATTERN.test(secret);

  if (isWeak) {
    const message = `JWT_SECRET is weak (length=${secret.length}). Generate with: openssl rand -hex 64`;
    if (requiresStrongSecret) {
      throw new Error(message);
    }
    logger.warn(message);
  }
}
