/**
 * JWT dual-key verification for zero-downtime secret rotation.
 *
 * During a JWT_SECRET rotation, tokens issued with the previous secret must
 * remain valid until they expire (or a configurable grace window ends). This
 * helper tries the current JWT_SECRET first, then falls back to
 * JWT_SECRET_PREVIOUS if set. Callers should use this instead of calling
 * jwt.verify directly.
 *
 * Operator procedure: see docs/ops/secrets-rotation.md
 *
 * Implements the dual-key requirement from issue #754.
 */

import jwt, { JwtPayload, VerifyOptions } from 'jsonwebtoken';

export interface DualKeyVerifyResult<T = JwtPayload> {
  payload: T;
  /** Which key verified the token. Callers can use this for metrics/logging. */
  verifiedWith: 'current' | 'previous';
}

/**
 * Verify a JWT against JWT_SECRET, falling back to JWT_SECRET_PREVIOUS when
 * it is set. Throws if neither key verifies the token — the caller should
 * treat a throw exactly like a standard jwt.verify failure.
 *
 * JWT_SECRET must be set at startup; JWT_SECRET_PREVIOUS is optional and is
 * only consulted when the current-key verification fails. Once JWT_SECRET
 * alone verifies every live token, the operator removes JWT_SECRET_PREVIOUS
 * from the environment.
 */
export function verifyJwtWithRotation<T = JwtPayload>(
  token: string,
  options: VerifyOptions = {},
): DualKeyVerifyResult<T> {
  const current = process.env.JWT_SECRET;
  if (!current) {
    throw new Error('JWT_SECRET is not set');
  }

  try {
    const payload = jwt.verify(token, current, options) as T;
    return { payload, verifiedWith: 'current' };
  } catch (currentErr) {
    const previous = process.env.JWT_SECRET_PREVIOUS;
    if (!previous) {
      // No fallback configured — re-throw the original failure so callers
      // see the exact error they would have seen with plain jwt.verify.
      throw currentErr;
    }
    // Fall through to previous key. If that also fails, we re-throw the
    // previous-key error so the caller has a concrete diagnosis.
    const payload = jwt.verify(token, previous, options) as T;
    return { payload, verifiedWith: 'previous' };
  }
}
