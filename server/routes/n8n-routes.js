/**
 * n8n Integration API Routes
 *
 * This module provides routes for interacting with n8n workflow automation
 * in the Wrfcoin network.
 */

const express = require('express');
const router = express.Router();
const n8nController = require('../controllers/n8nController');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { requireWiredStorage } = require('../middleware/require-wired-storage');

// Everything else is an operator/admin surface — n8n workflow execution runs
// attacker-controllable payloads against the configured N8N_URL. Gate the
// whole family behind requireAuth, matching the sibling mcp-routes.js, and put
// requireAdmin on every execute/mutation route (mcp-routes.js gates /execute
// the same way). See #900.
router.use(requireAuth);

// backend#1145: n8nController falls back to "Mock … for development" data
// whenever req.n8nService (and req.storage) are absent, and nothing on the
// live entrypoint injects either. Answer 501 until an n8n service is wired.
router.use(requireWiredStorage('n8n', { needs: 'n8nService', see: 'wrfcoin/backend#1145' }));

// These names intentionally mirror the current TypeScript controller export.
// Do not register a route for an absent handler: safeMount would otherwise
// swallow Express's construction error and leave the entire family unmounted.
router.get('/status', n8nController.getConnectionStatus);

// Get all workflows
router.get('/workflows', n8nController.getAllWorkflows);

// Execute a workflow
router.post('/workflows/:workflowId/execute', requireAdmin, n8nController.executeWorkflow);

// Get workflow execution history.
router.get('/executions', n8nController.getExecutions);

// Toggle a workflow's active state.
router.patch(
  '/workflows/:workflowId/active',
  requireAdmin,
  n8nController.toggleWorkflow
);

module.exports = router;
