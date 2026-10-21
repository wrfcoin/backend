/**
 * NOT MOUNTABLE AS-IS (backend#1135, epic wrfcoin/infra#946, 2026-09-16).
 *
 * This router binds 13 handlers from ../controllers/governanceController, but
 * that controller exports only 6 (submitComputationalNFTProposal,
 * submitRewardDistributionProposal, voteOnProposal, getProposal,
 * getGovernanceStatus, recordSlashingEvent). Ten of the names used below —
 * listProposals, getGovernanceStats, getTransparencyReport,
 * calculateEpochRewards, getRewardGovernanceState, reportComputationComplete,
 * stakeForProposal, submitReview, updateGovernanceParameters,
 * updateNodeTypeWeights — do not exist, so Express throws
 * "Route.get() requires a callback function but got a [object Undefined]"
 * the moment this module is required. It was never "real, working, unwired";
 * it is a router written against a controller that was never finished.
 * Governance is served live by routes/governance-routes.ts at /api/governance
 * (no path overlap with the four resources here). Complete the controller or
 * delete this file — decision tracked on backend#1135.
 */
/**
 * Governance API Routes
 * Routes for computational NFT governance and reward distribution
 */

const express = require('express');
const router = express.Router();
const governanceController = require('../controllers/governanceController');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');

// Computational NFT Governance Routes - Protected with authentication
router.post(
  '/computational-nft/proposals',
  requireAuth,
  governanceController.submitComputationalNFTProposal
);
router.get('/computational-nft/proposals', governanceController.listProposals);
router.get(
  '/computational-nft/proposals/:proposalId',
  governanceController.getProposal
);
router.post(
  '/computational-nft/proposals/:proposalId/review',
  requireAuth,
  governanceController.submitReview
);
router.post(
  '/computational-nft/proposals/:proposalId/stake',
  requireAuth,
  governanceController.stakeForProposal
);
router.post(
  '/computational-nft/proposals/:proposalId/complete',
  requireAuth,
  governanceController.reportComputationComplete
);
router.get('/computational-nft/stats', governanceController.getGovernanceStats);

// Reward Distribution Governance Routes - High-impact admin routes
router.post(
  '/rewards/calculate-epoch',
  requireAdmin,
  governanceController.calculateEpochRewards
);
router.post(
  '/rewards/slashing-event',
  requireAdmin,
  governanceController.recordSlashingEvent
);
router.put(
  '/rewards/parameters',
  requireAdmin,
  governanceController.updateGovernanceParameters
);
router.put(
  '/rewards/node-weights',
  requireAdmin,
  governanceController.updateNodeTypeWeights
);
router.get('/rewards/transparency', governanceController.getTransparencyReport);
router.get('/rewards/state', governanceController.getRewardGovernanceState);

module.exports = router;
