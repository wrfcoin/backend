/**
 * Unit tests for dual-key JWT verification (issue #754).
 *
 * Verifies the zero-downtime rotation promise made in
 * docs/ops/secrets-rotation.md: when both JWT_SECRET (new) and
 * JWT_SECRET_PREVIOUS (old) are set, tokens issued under either key
 * must verify.
 */

import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { verifyJwtWithRotation } from '../server/auth/jwt-rotation.js';

const ORIGINAL_ENV = { ...process.env };

describe('verifyJwtWithRotation', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_PREVIOUS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('throws if JWT_SECRET is not set', () => {
    expect(() => verifyJwtWithRotation('whatever')).toThrow(/JWT_SECRET/);
  });

  it('verifies a token signed with the current secret and reports verifiedWith="current"', () => {
    process.env.JWT_SECRET = 'new-secret-value-at-least-16-chars';
    const token = jwt.sign({ sub: 'alice' }, process.env.JWT_SECRET);

    const result = verifyJwtWithRotation<{ sub: string }>(token);

    expect(result.verifiedWith).toBe('current');
    expect(result.payload.sub).toBe('alice');
  });

  it('falls back to JWT_SECRET_PREVIOUS and reports verifiedWith="previous"', () => {
    const oldSecret = 'old-secret-value-at-least-16-chars';
    const newSecret = 'new-secret-value-different-16-chr';
    process.env.JWT_SECRET = newSecret;
    process.env.JWT_SECRET_PREVIOUS = oldSecret;

    // Token was signed with the *old* secret — this is the exact scenario
    // during a rotation window: a client's in-flight token predates the
    // secret swap.
    const token = jwt.sign({ sub: 'bob' }, oldSecret);

    const result = verifyJwtWithRotation<{ sub: string }>(token);

    expect(result.verifiedWith).toBe('previous');
    expect(result.payload.sub).toBe('bob');
  });

  it('throws when neither key verifies the token', () => {
    process.env.JWT_SECRET = 'a-secret-value-at-least-16-chars';
    process.env.JWT_SECRET_PREVIOUS = 'another-secret-at-least-16-chars';
    const token = jwt.sign({ sub: 'eve' }, 'a-totally-unrelated-third-secret');

    expect(() => verifyJwtWithRotation(token)).toThrow();
  });

  it('throws when JWT_SECRET_PREVIOUS is unset and the current key does not verify', () => {
    process.env.JWT_SECRET = 'current-secret-at-least-16-chars';
    const token = jwt.sign({ sub: 'eve' }, 'wrong-secret-at-least-16-chars');

    // With no previous key configured, the failure mode must be identical
    // to a plain jwt.verify failure — no silent success.
    expect(() => verifyJwtWithRotation(token)).toThrow();
  });

  it('passes VerifyOptions (issuer, audience, algorithms) through to jwt.verify', () => {
    const secret = 'current-secret-at-least-16-chars';
    process.env.JWT_SECRET = secret;

    const token = jwt.sign({ sub: 'carol' }, secret, {
      algorithm: 'HS256',
      issuer: 'wrfcoin-platform',
      audience: 'wrfcoin-api',
    });

    const result = verifyJwtWithRotation<{ sub: string }>(token, {
      algorithms: ['HS256'],
      issuer: 'wrfcoin-platform',
      audience: 'wrfcoin-api',
    });

    expect(result.verifiedWith).toBe('current');
    expect(result.payload.sub).toBe('carol');

    // Wrong audience must still fail even when the signature is valid.
    expect(() =>
      verifyJwtWithRotation(token, {
        algorithms: ['HS256'],
        issuer: 'wrfcoin-platform',
        audience: 'some-other-audience',
      }),
    ).toThrow();
  });
});
