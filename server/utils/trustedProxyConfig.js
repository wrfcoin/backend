const {
  getSecureClientIp,
  isTrustedProxy,
  tailnetIpv4,
} = require('./rateLimitEnhanced'); // extension-less so copy-build-assets rewrites to .cjs shim
const { ipKeyGenerator } = require('express-rate-limit');

function getHeaderStringValue(headerValue) {
  if (Array.isArray(headerValue)) {
    return headerValue[0] || '';
  }

  return typeof headerValue === 'string' ? headerValue : '';
}

function trustKnownProxy(ip) {
  return isTrustedProxy(ip);
}

function getTrustedClientIp(req) {
  return getSecureClientIp(req);
}

// backend#1228: collapse IPv6 clients to their /56 so rotating addresses
// within one allocation cannot mint fresh buckets.
function getIpRateLimitKey(req) {
  return ipKeyGenerator(getTrustedClientIp(req) || 'unknown');
}

/**
 * Express middleware: make `req.ip` the tailnet device's unique IPv4 when the derived client
 * address is a Tailscale IPv6. Every limiter that keys on the default `req.ip` (express-rate-limit
 * applies an IPv6 /56 collapse) then keeps one bucket per device instead of one per tailnet.
 * `req.ip` is already the right-to-left, trusted-hop-derived address, so this cannot let a caller
 * choose its own key.
 */
function normalizeTailnetClientIp(req, _res, next) {
  const mapped = tailnetIpv4(req.ip);
  if (mapped && mapped !== req.ip) {
    Object.defineProperty(req, 'ip', { value: mapped, configurable: true, enumerable: true, writable: true });
  }
  next();
}

function getPartnerRateLimitKey(req) {
  return getHeaderStringValue(req.headers['x-partner-id']) || getIpRateLimitKey(req);
}

module.exports = {
  trustKnownProxy,
  getTrustedClientIp,
  getIpRateLimitKey,
  getPartnerRateLimitKey,
  normalizeTailnetClientIp,
};
