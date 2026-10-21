/**
 * Honest-gap responder (backend#1118).
 *
 * When a route's real capability is not wired — no bridge SDK, no job queue,
 * no daemon behind it — answer with an explicit 501 NOT_IMPLEMENTED envelope
 * instead of fabricated success data. Shape mirrors
 * `shared/core4-route-client.js` `sendNotImplemented` (same `error.code`) and
 * adds the `{ unavailable: true, reason }` marker wrfsentinel#34 established,
 * so a client can detect "not wired" uniformly across services.
 *
 * Same pattern family as backend#1024 / #1041 / #1006 / #1016.
 */

const NOT_WIRED_CODE = 'NOT_IMPLEMENTED';

/**
 * @param {import('express').Response} res
 * @param {object} opts
 * @param {string} opts.capability  short slug, e.g. 'crosschain.send'
 * @param {string} opts.message     one-line human explanation
 * @param {string} [opts.details]   what would have to exist for this to work
 * @param {string} [opts.see]       pointer to the real route / issue, if any
 */
function sendNotWired(res, { capability, message, details, see }) {
  return res.status(501).json({
    success: false,
    unavailable: true,
    reason: message,
    error: {
      code: NOT_WIRED_CODE,
      message,
      capability,
      ...(details ? { details } : {}),
      ...(see ? { see } : {}),
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Notice attached to catalog-style responses (a list of protocols/networks the
 * service is *designed* to support) so the catalog cannot be read as live
 * integration status.
 */
function integrationNotice(what, see) {
  return {
    wired: false,
    reason: `${what} are a design catalog only; no live integration exists behind this service yet.`,
    ...(see ? { see } : {}),
  };
}

module.exports = { sendNotWired, integrationNotice, NOT_WIRED_CODE };
