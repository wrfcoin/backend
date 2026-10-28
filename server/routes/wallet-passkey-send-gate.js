/**
 * Deployed-entrypoint mount of the self-proving passkey send router (backend#21).
 *
 * server.js mounts wallet-passkey-send-routes before the auth-gated /api/wallet router, but the
 * deployed entrypoint (enhanced_unified_api_optimized.ts) never did, so a passkey send there met
 * requireAuth. This gate is mounted in the same place, before wallet-routes.
 *
 * WRFCOIN_ENABLE_PASSKEY_SEND=true (read per request): the passkey router handles its two paths.
 * Off: next('router'), so the request falls through to wallet-routes exactly as before this mount
 * existed (the router's own flag-off 404 is for server.js and is not reached here). The two paths
 * are declared here so the route inventory and the build-tier mount audit can see them.
 */
const express = require('express');
const passkeySendRouter = require('./wallet-passkey-send-routes');

const gate = express.Router();
const toPasskeyRouter = (req, res, next) =>
  (process.env.WRFCOIN_ENABLE_PASSKEY_SEND === 'true' ? passkeySendRouter(req, res, next) : next('router'));

gate.post('/send-passkey', toPasskeyRouter);
gate.get('/send-passkey/nonce/:address', toPasskeyRouter);

module.exports = gate;
