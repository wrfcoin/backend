const express = require('express');
const router = express.Router();
const { blockchainLogger } = require('../utils/logger');
const { sendNotWired } = require('../utils/honest-gap');

// WVM Integration endpoints that connect to your Rust Virtual Machine

// Cross-chain rewards endpoint (fixing the 404 error)
router.get('/mining/cross-chain-rewards', (req, res) => sendNotWired(res, {
  capability: 'wvm.mining.cross_chain_rewards',
  message: 'WVM cross-chain reward figures are not wired; no live source exists behind this route.',
}));

// Computational NFT status
router.get('/computational-nfts/status', (req, res) => sendNotWired(res, {
  capability: 'wvm.computational_nfts.status',
  message: 'WVM computational NFT status are not wired; no live source exists behind this route.',
}));

// Governance proposals: no WVM source exists. This used to answer hard-coded
// proposals and vote percentages as live data (backend#1245). Real proposals are
// served by server/routes/governance-routes.ts from core4.
router.get('/governance/proposals', (req, res) => sendNotWired(res, {
  capability: 'wvm.governance.proposals',
  message: 'WVM governance proposals are not wired; no live source exists behind this route.',
  see: '/api/governance/proposals',
}));

// Reward distribution
router.get('/rewards/distribution', (req, res) => sendNotWired(res, {
  capability: 'wvm.rewards.distribution',
  message: 'WVM reward distribution figures are not wired; no live source exists behind this route.',
}));

// Smart contract metrics
router.get('/smart-contracts/metrics', (req, res) => sendNotWired(res, {
  capability: 'wvm.smart_contracts.metrics',
  message: 'WVM smart-contract metrics are not wired; no live source exists behind this route.',
}));

// Environmental impact dashboard
router.get('/environmental/impact', (req, res) => sendNotWired(res, {
  capability: 'wvm.environmental.impact',
  message: 'WVM environmental impact figures are not wired; no live source exists behind this route.',
}));

// WVM performance metrics
router.get('/wvm/performance', (req, res) => sendNotWired(res, {
  capability: 'wvm.performance',
  message: 'WVM performance figures are not wired; no live source exists behind this route.',
}));

module.exports = router;
