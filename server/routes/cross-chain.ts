/**
 * Cross-Chain API Routes — the ONE mounted cross-chain router (backend#1136).
 *
 * Canonical of the former three-way duplicate (epic wrfcoin/infra#946):
 *   - `crossChainRoutes.js` — a JS snapshot of this file (same 7 routes, same
 *     bodies; only `requireAuth` vs `authenticateJWT` and a limiter differed),
 *     co-edited with it in every commit since #339. Deleted in #1136.
 *   - `cross-chain-routes.js` — a DIFFERENT surface (computational-NFT
 *     cross-chain execution: /chains, /status, /providers, /transfer,
 *     /execute, /verify). Not a snapshot of this file, so not consolidated
 *     here; it is also broken at runtime (destructures `{ controller }` from
 *     a module whose export is the class). Its fate is a follow-up decision
 *     story: backend#1143.
 *
 * HONEST-GAP STATUS: this router used to call
 * `integrations/cross-chain/index.js`, whose `CrossChainAdapter` has NO real
 * provider — every branch of `initializeProvider()` (zeta, layerzero, axelar,
 * wormhole, polkadot-xcm) resolves to `createMock*Provider()` in test mode
 * AND in production (the real imports are commented out), and those mocks
 * fabricate `txHash`es and coin-flip `verified` flags with `Math.random()`.
 * Importing that module also self-initialises the mock providers at import
 * time and logs "Cross-chain integration initialized successfully".
 *
 * Mounting fabricated bridge transfers as if they were real would be worse
 * than leaving the router unmounted, so every route keeps its surface, its
 * auth (#230) and rate limits (#237) and its input validation, and then
 * answers with the explicit 501 honest-gap envelope from
 * `server/utils/honest-gap.js` (same pattern as backend#1118 / #1133).
 * `GET /status` says so in-band. The REAL bridge surfaces already mounted on
 * this entrypoint are `/api/bridges`, `/api/bridges/wormhole` and
 * `/api/layer-zero`; wire a real provider into the adapter (or point these
 * routes at those services) before turning any of these back into a 200.
 */

import express, { Router } from 'express';
import { authenticateJWT } from '../middleware/auth.js';

// CJS helper shared with the other honest-gap servers (backend#1118).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendNotWired, integrationNotice } = require('../utils/honest-gap.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generalLimiter, transferLimiter } = require('../../middleware/rateLimiting');

const SEE = 'wrfcoin/backend#1136';
const NO_PROVIDER =
  'No real cross-chain provider is wired: integrations/cross-chain/adapter.ts resolves every ' +
  'provider (zeta, layerzero, axelar, wormhole, polkadot-xcm) to a mock that fabricates txHashes ' +
  'and verification results with Math.random(), in production as well as test mode.';

const router: Router = express.Router();

function notWired(capability: string, message: string) {
  return (_req: express.Request, res: express.Response) =>
    sendNotWired(res, { capability, message, details: NO_PROVIDER, see: SEE });
}

function missing(res: express.Response, error = 'Missing required parameters') {
  res.status(400).json({ success: false, error });
}

/**
 * GET /api/cross-chain/status — honest, in-band, no auth required so that
 * operators and the frontend can discover the gap without a token.
 */
router.get('/status', (_req, res) => {
  res.json({
    success: true,
    integration: integrationNotice('Cross-chain transfers/messaging/verification', SEE),
    providers: [],
    networks: [],
    reason: NO_PROVIDER,
  });
});

// All cross-chain operations require authentication (#230)
router.use(authenticateJWT);
// Rate limit cross-chain endpoints; transfer POST endpoints get tighter limits (#237)
router.use(generalLimiter);

/** GET /api/cross-chain/networks — the mock providers' network lists were fabricated claims. */
router.get(
  '/networks',
  notWired('cross_chain.networks', 'Supported-network discovery not yet wired to a real provider.')
);

/** POST /api/cross-chain/transfer-weather-data */
router.post('/transfer-weather-data', transferLimiter, (req, res) => {
  const { data, sourceChain, targetChains } = req.body ?? {};
  if (!data || !sourceChain || !targetChains || !Array.isArray(targetChains)) {
    missing(res);
    return;
  }
  notWired(
    'cross_chain.transfer_weather_data',
    'Cross-chain weather-data transfer not yet wired; nothing was transferred.'
  )(req, res);
});

/** POST /api/cross-chain/transfer-tokens */
router.post('/transfer-tokens', transferLimiter, (req, res) => {
  const { transfer, sourceChain, targetChain } = req.body ?? {};
  if (!transfer || !sourceChain || !targetChain) {
    missing(res);
    return;
  }
  notWired(
    'cross_chain.transfer_tokens',
    'Cross-chain token transfer not yet wired; no funds moved.'
  )(req, res);
});

/** POST /api/cross-chain/verify-data */
router.post('/verify-data', transferLimiter, (req, res) => {
  const { dataId, chains } = req.body ?? {};
  if (!dataId || !chains || !Array.isArray(chains)) {
    missing(res);
    return;
  }
  notWired(
    'cross_chain.verify_data',
    'Cross-chain data verification not yet wired; nothing was verified.'
  )(req, res);
});

/** POST /api/cross-chain/send-message */
router.post('/send-message', transferLimiter, (req, res) => {
  const { message, sourceChain, targetChain } = req.body ?? {};
  if (!message || !sourceChain || !targetChain) {
    missing(res);
    return;
  }
  notWired(
    'cross_chain.send_message',
    'Cross-chain messaging not yet wired; the message was NOT sent.'
  )(req, res);
});

/** GET /api/cross-chain/operation/:id */
router.get(
  '/operation/:id',
  notWired('cross_chain.operation_status', 'Operation status lookup not yet wired.')
);

/** GET /api/cross-chain/transactions */
router.get(
  '/transactions',
  notWired('cross_chain.transactions', 'Recent cross-chain transaction listing not yet wired.')
);

export default router;
