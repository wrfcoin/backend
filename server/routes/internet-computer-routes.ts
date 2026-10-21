/**
 * Internet Computer (DFINITY) Integration Routes for Wrfcoin
 *
 * HONEST-GAP STATUS (backend#1133, epic wrfcoin/infra#946): there is no ICP
 * client in this backend — `package.json` has no `@dfinity/*` dependency —
 * and the controller this router was written against
 * (`../controllers/internetComputerController.ts`) never existed in the
 * shape the router expected: the controller exports a plain object of
 * `(req, res)` handlers (`getAllCanisters`, `deployCanister`, `callCanister`,
 * `getCanisterCalls`, `getSubnets`), while this router did
 * `new Controller({ testMode: true })` and called `initialize`, `getStatus`,
 * `createCanister`, `getCyclesBalance`, `submitComputationalTask`, … — none
 * of which exist. Loading the old router outside its own mocked test threw
 * at import. And the controller's fallbacks fabricate data (pseudo-random
 * canister ids, cycles cost and instruction counts, "Mock canisters/calls/
 * subnets for development").
 *
 * So every route here keeps its surface, its auth and its input validation,
 * and then answers with the explicit 501 honest-gap envelope from
 * `server/utils/honest-gap.js` (same pattern as backend#1118) instead of a
 * fabricated success. `GET /status` says so in-band. Wire a real ICP agent
 * (e.g. `@dfinity/agent`) before turning any of these back into a 200.
 */

import express, { Router } from 'express';
import { authenticateApiKey as authenticateApiRequest } from '../middleware/auth.js';
import { createApiError } from '../utils/api-error.js';

// CJS helper shared with the other honest-gap servers (backend#1118).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendNotWired, integrationNotice } = require('../utils/honest-gap.js');

const ICP_SEE = 'wrfcoin/backend#1133';
const NO_CLIENT =
  'No Internet Computer client is wired: the backend has no @dfinity/* dependency and the ' +
  'controller this router targeted fabricated canister ids, cycles and instruction counts.';

const router: Router = express.Router();

function notWired(capability: string, message: string) {
  return (_req: express.Request, res: express.Response) =>
    sendNotWired(res, { capability, message, details: NO_CLIENT, see: ICP_SEE });
}

// Status of the Internet Computer integration — honest, in-band.
router.get('/status', (_req, res) => {
  res.json({
    success: true,
    integration: integrationNotice('Internet Computer canisters/tasks', ICP_SEE),
    network: 'internet-computer',
    connected: false,
    client: null,
    reason: NO_CLIENT,
  });
});

// Canisters
router.get('/canisters', notWired('icp.canisters.list', 'Canister listing not yet wired.'));
router.post(
  '/canisters',
  authenticateApiRequest,
  notWired('icp.canisters.create', 'Canister creation not yet wired; nothing was deployed.')
);
router.get(
  '/canisters/:canisterId',
  notWired('icp.canisters.info', 'Canister info not yet wired.')
);
router.get(
  '/canisters/:canisterId/cycles',
  notWired('icp.canisters.cycles', 'Cycles balance not yet wired.')
);
router.post('/canisters/:canisterId/cycles', authenticateApiRequest, (req, res) => {
  const { cycles } = req.body ?? {};
  if (!cycles) {
    res.status(400).json(createApiError('MISSING_CYCLES', 'Missing required field: cycles'));
    return;
  }
  notWired('icp.canisters.add_cycles', 'Adding cycles not yet wired; nothing was charged.')(req, res);
});
router.post('/canisters/:canisterId/call', authenticateApiRequest, (req, res) => {
  const { method } = req.body ?? {};
  if (!method) {
    res.status(400).json(createApiError('MISSING_METHOD', 'Missing required field: method'));
    return;
  }
  notWired('icp.canisters.call', `Canister call "${method}" not yet wired; nothing was executed.`)(req, res);
});

// Computational tasks
router.get('/tasks', notWired('icp.tasks.list', 'Task listing not yet wired.'));
router.post(
  '/tasks',
  authenticateApiRequest,
  notWired('icp.tasks.submit', 'Task submission not yet wired; the task was NOT accepted.')
);
router.get('/tasks/:taskId', notWired('icp.tasks.status', 'Task status not yet wired.'));
router.post(
  '/weather-forecast',
  authenticateApiRequest,
  notWired('icp.tasks.weather_forecast', 'Weather-forecast task not yet wired; nothing was scheduled.')
);
router.post(
  '/climate-simulation',
  authenticateApiRequest,
  notWired('icp.tasks.climate_simulation', 'Climate-simulation task not yet wired; nothing was scheduled.')
);
router.post(
  '/air-quality',
  authenticateApiRequest,
  notWired('icp.tasks.air_quality', 'Air-quality task not yet wired; nothing was scheduled.')
);

// Cross-chain transfer
router.post('/cross-chain-transfer', authenticateApiRequest, (req, res) => {
  const { fromChain, toChain, fromToken, toToken, amount } = req.body ?? {};
  if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
    res
      .status(400)
      .json(
        createApiError(
          'MISSING_TRANSFER_FIELDS',
          'Missing required fields: fromChain, toChain, fromToken, toToken, amount'
        )
      );
    return;
  }
  notWired('icp.cross_chain_transfer', 'ICP cross-chain transfer not yet wired; no funds moved.')(req, res);
});

export default router;
