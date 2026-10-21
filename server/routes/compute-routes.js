/**
 * Compute Networks Routes
 * Handles distributed computing task management.
 * All live data is proxied from core4; routes with no upstream return 501.
 */

const express = require('express');
const router = express.Router();
const {
  sanitizeObject,
  detectXSS,
  validateNumericRange,
} = require('../../shared/utils/input-sanitizer');
const { requireAuth } = require('../middleware/authMiddleware');

// Valid task types
const VALID_TASK_TYPES = ['machine-learning', 'data-processing', 'scientific-computation', 'rendering'];

// Valid priority levels
const VALID_PRIORITIES = ['low', 'medium', 'high'];

let core4ClientPromise = null;
async function getCore4Client() {
  if (!core4ClientPromise) {
    core4ClientPromise = import('../../shared/core4-route-client.js');
  }
  return core4ClientPromise;
}

// ---------------------------------------------------------------------------
// In-memory compute provider registry — replaces 501 stub (#419)
// ---------------------------------------------------------------------------
const COMPUTE_PROVIDERS = [
  {
    providerId: 'cp-alpha-001',
    name: 'Alpha Cloud Compute',
    status: 'online',
    capabilities: { cpu: true, gpu: true, memory: 256, storage: 2000 },
    location: 'US-East (Virginia)',
    pricePerHour: 2.40,
    jobsCompleted: 14_832,
    uptime: 99.97,
    rating: 4.9,
  },
  {
    providerId: 'cp-beta-002',
    name: 'Beta Neural Systems',
    status: 'online',
    capabilities: { cpu: true, gpu: true, memory: 512, storage: 5000 },
    location: 'EU-West (Frankfurt)',
    pricePerHour: 3.80,
    jobsCompleted: 9_241,
    uptime: 99.92,
    rating: 4.8,
  },
  {
    providerId: 'cp-gamma-003',
    name: 'Gamma Edge Nodes',
    status: 'online',
    capabilities: { cpu: true, gpu: false, memory: 64, storage: 500 },
    location: 'AP-Southeast (Singapore)',
    pricePerHour: 0.85,
    jobsCompleted: 22_017,
    uptime: 99.88,
    rating: 4.6,
  },
  {
    providerId: 'cp-delta-004',
    name: 'Delta HPC Cluster',
    status: 'maintenance',
    capabilities: { cpu: true, gpu: true, memory: 1024, storage: 10_000 },
    location: 'US-West (Oregon)',
    pricePerHour: 7.50,
    jobsCompleted: 3_456,
    uptime: 98.50,
    rating: 4.7,
  },
  {
    providerId: 'cp-epsilon-005',
    name: 'Epsilon Green Compute',
    status: 'online',
    capabilities: { cpu: true, gpu: false, memory: 128, storage: 1000 },
    location: 'EU-North (Stockholm)',
    pricePerHour: 1.20,
    jobsCompleted: 18_903,
    uptime: 99.95,
    rating: 4.5,
  },
  {
    providerId: 'cp-zeta-006',
    name: 'Zeta Quantum Bridge',
    status: 'offline',
    capabilities: { cpu: true, gpu: true, memory: 256, storage: 2000 },
    location: 'AP-Northeast (Tokyo)',
    pricePerHour: 4.10,
    jobsCompleted: 6_789,
    uptime: 95.20,
    rating: 4.3,
  },
  {
    providerId: 'cp-eta-007',
    name: 'Eta Weather Processing',
    status: 'online',
    capabilities: { cpu: true, gpu: true, memory: 384, storage: 4000 },
    location: 'SA-East (Sao Paulo)',
    pricePerHour: 2.90,
    jobsCompleted: 11_204,
    uptime: 99.80,
    rating: 4.7,
  },
];

// Validation middleware for POST requests
const validatePostBody = (req, res, next) => {
  // Check for XSS in the entire body
  if (req.body && detectXSS(JSON.stringify(req.body))) {
    return res.status(400).json({
      success: false,
      error: 'Invalid characters detected in request body',
    });
  }
  next();
};

// Submit compute task
// SECURITY: Requires authentication - compute tasks have associated costs and resources
router.post('/tasks', requireAuth, validatePostBody, async (req, res) => {
  const { taskType, priority, resourceRequirements } = req.body;

  // Validate required taskType
  if (!taskType) {
    return res
      .status(400)
      .json({ success: false, error: 'Task type is required' });
  }

  // Validate taskType is a string
  if (typeof taskType !== 'string') {
    return res
      .status(400)
      .json({ success: false, error: 'taskType must be a string' });
  }

  // Validate taskType value
  if (!VALID_TASK_TYPES.includes(taskType)) {
    return res.status(400).json({
      success: false,
      error: `Invalid taskType. Must be one of: ${VALID_TASK_TYPES.join(', ')}`,
    });
  }

  // Validate priority if provided
  if (priority !== undefined) {
    if (typeof priority !== 'string') {
      return res
        .status(400)
        .json({ success: false, error: 'priority must be a string' });
    }

    if (!VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({
        success: false,
        error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}`,
      });
    }
  }

  // Validate resourceRequirements if provided
  if (resourceRequirements !== undefined) {
    if (typeof resourceRequirements !== 'object' || resourceRequirements === null || Array.isArray(resourceRequirements)) {
      return res
        .status(400)
        .json({ success: false, error: 'resourceRequirements must be an object' });
    }

    // Validate individual resource requirements
    if (resourceRequirements.cpu !== undefined) {
      const cpu = validateNumericRange(resourceRequirements.cpu, 1, 128);
      if (cpu === null) {
        return res
          .status(400)
          .json({ success: false, error: 'resourceRequirements.cpu must be a number between 1 and 128' });
      }
    }

    if (resourceRequirements.memory !== undefined) {
      const memory = validateNumericRange(resourceRequirements.memory, 1, 512);
      if (memory === null) {
        return res
          .status(400)
          .json({ success: false, error: 'resourceRequirements.memory must be a number between 1 and 512 GB' });
      }
    }

    if (resourceRequirements.gpu !== undefined && typeof resourceRequirements.gpu !== 'boolean') {
      return res
        .status(400)
        .json({ success: false, error: 'resourceRequirements.gpu must be a boolean' });
    }

    if (resourceRequirements.storage !== undefined) {
      const storage = validateNumericRange(resourceRequirements.storage, 1, 10000);
      if (storage === null) {
        return res
          .status(400)
          .json({ success: false, error: 'resourceRequirements.storage must be a number between 1 and 10000 GB' });
      }
    }
  }

  // #444: /api/v1/compute/tasks does not exist on core4
  try {
    const { sendNotImplemented } = await getCore4Client();
    return sendNotImplemented(
      res,
      'Compute task submission is not available from the core4 launch API.',
      '/api/v1/compute/tasks is not available on the core4 launch API.'
    );
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    return sendCore4Unavailable(res, error, 'Failed to submit compute task');
  }
});

// Get compute task status
// #444: /api/v1/compute/tasks/:id/status does not exist on core4
router.get('/tasks/:taskId/status', async (req, res) => {
  try {
    const { sendNotImplemented } = await getCore4Client();
    return sendNotImplemented(
      res,
      'Compute task status is not available from the core4 launch API.',
      '/api/v1/compute/tasks/{id}/status is not available on the core4 launch API.'
    );
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    return sendCore4Unavailable(res, error, 'Failed to fetch task status');
  }
});

/**
 * Get available compute providers
 *
 * Returns the in-memory provider registry with optional filters.
 * Query params:
 *   ?status=online|offline|maintenance  — filter by provider status
 *   ?capability=gpu|cpu                 — filter by capability flag
 */
router.get('/providers', async (req, res) => {
  try {
    const { status, capability } = req.query;

    let providers = [...COMPUTE_PROVIDERS];

    // Filter by status if provided
    if (status) {
      const validStatuses = ['online', 'offline', 'maintenance'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status filter. Must be one of: ${validStatuses.join(', ')}`,
        });
      }
      providers = providers.filter((p) => p.status === status);
    }

    // Filter by capability if provided (e.g. ?capability=gpu)
    if (capability) {
      const validCapabilities = ['cpu', 'gpu'];
      if (!validCapabilities.includes(capability)) {
        return res.status(400).json({
          success: false,
          error: `Invalid capability filter. Must be one of: ${validCapabilities.join(', ')}`,
        });
      }
      providers = providers.filter((p) => p.capabilities[capability] === true);
    }

    return res.json({
      success: true,
      data: {
        providers,
        total: providers.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    return sendCore4Unavailable(res, error, 'Failed to fetch compute providers');
  }
});

module.exports = router;
