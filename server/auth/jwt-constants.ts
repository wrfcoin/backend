/**
 * Canonical JWT issuer and audience constants for WRFCoin platform.
 *
 * All jwt.sign() and jwt.verify() calls MUST use these values so tokens are
 * accepted uniformly across every middleware and service.
 *
 * Closes #448
 */

export const JWT_ISSUER = 'wrfcoin-platform';
export const JWT_AUDIENCE = 'wrfcoin-api';
