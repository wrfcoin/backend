/**
 * Bridge Status API Routes
 * Real-time bridge monitoring and fee estimation endpoints
 *
 * Updated: Uses GasEstimationService for real blockchain gas queries
 */

const express = require('express');
const router = express.Router();
const {
  sanitizeObject,
  detectXSS,
  validateNumericRange,
  validateChainId,
} = require('../../shared/utils/input-sanitizer');
const { requireAuth } = require('../middleware/authMiddleware');
const { crosschainLogger } = require('../utils/logger');

// Import real gas estimation service
let gasEstimationService = null;
try {
  const { getGasEstimationService } = require('../../services/GasEstimationService');
  gasEstimationService = getGasEstimationService();
  crosschainLogger.info('GasEstimationService initialized', { service: 'bridge-status' });
} catch (error) {
  crosschainLogger.warn('GasEstimationService not available, using fallback values', { service: 'bridge-status', error: { message: error.message } });
}

// Validation middleware for POST requests
const validatePostBody = (req, res, next) => {
  // Check for XSS in the entire body
  if (req.body && detectXSS(JSON.stringify(req.body))) {
    return res.status(400).json({ error: 'Invalid characters detected in request body' });
  }
  next();
};

// Mock bridge status data (in production, this would come from actual bridge APIs)
const bridgeStatuses = {
  axelar: {
    id: 'axelar',
    name: 'Axelar Network',
    status: 'active',
    uptime: 99.8,
    avgTransactionTime: '5.2 min',
    currentFee: '0.003%',
    gasEstimate: '$12.50',
    lastTransactionTime: '2.1 min',
    throughput: '850 tx/h',
    liquidity: '$892M',
    securityLevel: 'high',
    lastUpdate: Date.now(),
  },
  layerzero: {
    id: 'layerzero',
    name: 'LayerZero',
    status: 'active',
    uptime: 99.9,
    avgTransactionTime: '3.8 min',
    currentFee: '0.0025%',
    gasEstimate: '$8.75',
    lastTransactionTime: '1.8 min',
    throughput: '1200 tx/h',
    liquidity: '$1.2B',
    securityLevel: 'high',
    lastUpdate: Date.now(),
  },
  wormhole: {
    id: 'wormhole',
    name: 'Wormhole',
    status: 'active',
    uptime: 99.7,
    avgTransactionTime: '6.1 min',
    currentFee: '0.005%',
    gasEstimate: '$15.20',
    lastTransactionTime: '3.2 min',
    throughput: '650 tx/h',
    liquidity: '$756M',
    securityLevel: 'high',
    lastUpdate: Date.now(),
  },
  'chainlink-ccip': {
    id: 'chainlink-ccip',
    name: 'Chainlink CCIP',
    status: 'active',
    uptime: 99.95,
    avgTransactionTime: '4.5 min',
    currentFee: '0.004%',
    gasEstimate: '$18.50',
    lastTransactionTime: '2.8 min',
    throughput: '420 tx/h',
    liquidity: '$423M',
    securityLevel: 'enterprise',
    lastUpdate: Date.now(),
  },
  chainflip: {
    id: 'chainflip',
    name: 'Chainflip',
    status: 'active',
    uptime: 98.9,
    avgTransactionTime: '8.2 min',
    currentFee: '0.008%',
    gasEstimate: '$22.10',
    lastTransactionTime: '4.1 min',
    throughput: '280 tx/h',
    liquidity: '$189M',
    securityLevel: 'high',
    lastUpdate: Date.now(),
  },
  'celer-cbridge': {
    id: 'celer-cbridge',
    name: 'Celer cBridge',
    status: 'active',
    uptime: 99.3,
    avgTransactionTime: '4.8 min',
    currentFee: '0.0015%',
    gasEstimate: '$9.20',
    lastTransactionTime: '2.5 min',
    throughput: '720 tx/h',
    liquidity: '$267M',
    securityLevel: 'high',
    lastUpdate: Date.now(),
  },
  thorchain: {
    id: 'thorchain',
    name: 'THORChain',
    status: 'active',
    uptime: 99.1,
    avgTransactionTime: '7.3 min',
    currentFee: '0.006%',
    gasEstimate: '$16.80',
    lastTransactionTime: '3.8 min',
    throughput: '380 tx/h',
    liquidity: '$345M',
    securityLevel: 'high',
    lastUpdate: Date.now(),
  },
  'near-rainbow': {
    id: 'near-rainbow',
    name: 'NEAR Rainbow Bridge',
    status: 'active',
    uptime: 98.7,
    avgTransactionTime: '9.1 min',
    currentFee: '0.007%',
    gasEstimate: '$11.40',
    lastTransactionTime: '4.2 min',
    throughput: '210 tx/h',
    liquidity: '$123M',
    securityLevel: 'medium',
    lastUpdate: Date.now(),
  },
  optimism: {
    id: 'optimism',
    name: 'Optimism Bridge',
    status: 'active',
    uptime: 99.6,
    avgTransactionTime: '12.5 min',
    currentFee: '0.002%',
    gasEstimate: '$5.20',
    lastTransactionTime: '8.1 min',
    throughput: '950 tx/h',
    liquidity: '$1.8B',
    securityLevel: 'high',
    lastUpdate: Date.now(),
  },
  base: {
    id: 'base',
    name: 'Base Network',
    status: 'active',
    uptime: 99.8,
    avgTransactionTime: '2.8 min',
    currentFee: '0.0018%',
    gasEstimate: '$4.80',
    lastTransactionTime: '1.5 min',
    throughput: '1100 tx/h',
    liquidity: '$2.1B',
    securityLevel: 'high',
    lastUpdate: Date.now(),
  },
  'cosmos-ibc': {
    id: 'cosmos-ibc',
    name: 'Cosmos IBC',
    status: 'active',
    uptime: 99.4,
    avgTransactionTime: '6.8 min',
    currentFee: '0.0035%',
    gasEstimate: '$3.20',
    lastTransactionTime: '3.1 min',
    throughput: '540 tx/h',
    liquidity: '$892M',
    securityLevel: 'high',
    lastUpdate: Date.now(),
  },
  interledger: {
    id: 'interledger',
    name: 'Interledger (ILPv4)',
    status: 'active',
    uptime: 97.8,
    avgTransactionTime: '15.2 min',
    currentFee: '0.012%',
    gasEstimate: '$2.10',
    lastTransactionTime: '8.7 min',
    throughput: '120 tx/h',
    liquidity: '$67M',
    securityLevel: 'medium',
    lastUpdate: Date.now(),
  },
  'polkadot-xcmp': {
    id: 'polkadot-xcmp',
    name: 'Polkadot XCMP',
    status: 'active',
    uptime: 99.2,
    avgTransactionTime: '5.9 min',
    currentFee: '0.0028%',
    gasEstimate: '$7.30',
    lastTransactionTime: '2.9 min',
    throughput: '620 tx/h',
    liquidity: '$1.4B',
    securityLevel: 'high',
    lastUpdate: Date.now(),
  },
};

// Return static status with a refreshed timestamp.
// Previously this added random variance — removed as part of mock-data cleanup (#339).
// Real-time metrics will come from a core4 bridge-status proxy once that endpoint exists.
function addVariance(status) {
  return {
    ...status,
    lastUpdate: Date.now(),
    isRealTime: false,
  };
}

// Get all bridge statuses
router.get('/status', (req, res) => {
  try {
    const updatedStatuses = {};
    Object.keys(bridgeStatuses).forEach(key => {
      updatedStatuses[key] = addVariance(bridgeStatuses[key]);
    });

    res.json({
      type: 'all_bridges',
      bridges: Object.values(updatedStatuses),
      timestamp: Date.now(),
    });
  } catch (error) {
    crosschainLogger.error('Error fetching bridge statuses', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({ error: 'Failed to fetch bridge statuses' });
  }
});

// Get specific bridge status
router.get('/status/:bridgeId', (req, res) => {
  try {
    const { bridgeId } = req.params;
    const status = bridgeStatuses[bridgeId];

    if (!status) {
      return res.status(404).json({ error: 'Bridge not found' });
    }

    const updatedStatus = addVariance(status);

    res.json({
      type: 'bridge_status',
      bridgeId,
      status: updatedStatus,
      timestamp: Date.now(),
    });
  } catch (error) {
    crosschainLogger.error('Error fetching bridge status', { error: { message: error.message, stack: error.stack }, bridgeId: req.params.bridgeId });
    res.status(500).json({ error: 'Failed to fetch bridge status' });
  }
});

// Valid bridge IDs
const VALID_BRIDGE_IDS = Object.keys(bridgeStatuses);

// Real-time fee estimation with real gas queries
// SECURITY: Requires authentication - fee estimation may involve user-specific data
router.post('/fee-estimate', requireAuth, validatePostBody, async (req, res) => {
  try {
    const { bridgeId, amount, sourceChain, destChain } = req.body;

    // Validate required parameters
    if (!bridgeId || amount === undefined || !sourceChain || !destChain) {
      return res.status(400).json({ error: 'Missing required parameters: bridgeId, amount, sourceChain, destChain' });
    }

    // Validate bridgeId format
    if (typeof bridgeId !== 'string') {
      return res.status(400).json({ error: 'bridgeId must be a string' });
    }

    // Validate bridgeId is alphanumeric with hyphens/underscores
    if (!/^[a-zA-Z0-9\-_]+$/.test(bridgeId)) {
      return res.status(400).json({ error: 'bridgeId contains invalid characters' });
    }

    // Validate bridgeId exists
    if (!VALID_BRIDGE_IDS.includes(bridgeId)) {
      return res.status(404).json({ error: 'Bridge not found' });
    }

    // Validate amount is a positive number
    const numericAmount = validateNumericRange(amount, 0, Number.MAX_SAFE_INTEGER);
    if (numericAmount === null || numericAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    // Validate sourceChain
    if (typeof sourceChain !== 'string') {
      return res.status(400).json({ error: 'sourceChain must be a string' });
    }

    if (!validateChainId(sourceChain)) {
      return res.status(400).json({ error: 'sourceChain contains invalid characters' });
    }

    // Validate destChain
    if (typeof destChain !== 'string') {
      return res.status(400).json({ error: 'destChain must be a string' });
    }

    if (!validateChainId(destChain)) {
      return res.status(400).json({ error: 'destChain contains invalid characters' });
    }

    // Sanitize inputs
    const sanitizedBridgeId = sanitizeObject(bridgeId);
    const sanitizedSourceChain = sanitizeObject(sourceChain);
    const sanitizedDestChain = sanitizeObject(destChain);

    const status = bridgeStatuses[sanitizedBridgeId];
    if (!status) {
      return res.status(404).json({ error: 'Bridge not found' });
    }

    // Calculate dynamic fees based on current network conditions
    const baseFeeRate = parseFloat(status.currentFee.replace('%', '')) / 100;
    const bridgeFeeRate = baseFeeRate;
    const bridgeFee = numericAmount * bridgeFeeRate;

    // Real gas estimation from blockchain RPC
    let gasFee = 0;
    let gasSource = 'fallback';
    let gasDetails = null;

    if (gasEstimationService) {
      try {
        // Get real gas estimates for source and destination chains
        const [sourceGas, destGas] = await Promise.all([
          gasEstimationService.estimateGas(sanitizedSourceChain, 'deposit'),
          gasEstimationService.estimateGas(sanitizedDestChain, 'claim'),
        ]);

        // Total gas is sum of source chain deposit + destination chain claim
        const sourceGasCost = parseFloat(sourceGas.estimatedCostUSD.replace('$', ''));
        const destGasCost = parseFloat(destGas.estimatedCostUSD.replace('$', ''));
        gasFee = sourceGasCost + destGasCost;
        gasSource = sourceGas.source === 'rpc' && destGas.source === 'rpc' ? 'blockchain' : 'cached';
        gasDetails = {
          sourceChain: {
            gasPrice: sourceGas.gasPriceGwei,
            estimatedCost: sourceGas.estimatedCostUSD,
            lastUpdated: sourceGas.lastUpdated,
          },
          destChain: {
            gasPrice: destGas.gasPriceGwei,
            estimatedCost: destGas.estimatedCostUSD,
            lastUpdated: destGas.lastUpdated,
          },
        };
      } catch (gasError) {
        crosschainLogger.warn('Real gas estimation failed, using fallback', { service: 'bridge-status', error: { message: gasError.message } });
        // Fallback to status-based estimation
        gasFee = parseFloat(status.gasEstimate.replace('$', ''));
      }
    } else {
      // Fallback when service not available
      gasFee = parseFloat(status.gasEstimate.replace('$', ''));
    }

    const totalFee = bridgeFee + gasFee;

    // Estimated time based on chain finality times
    const baseTimeMinutes = parseFloat(status.avgTransactionTime.split(' ')[0]);
    const estimatedMinutes = baseTimeMinutes;

    res.json({
      bridgeId: sanitizedBridgeId,
      amount: numericAmount,
      sourceChain: sanitizedSourceChain,
      destChain: sanitizedDestChain,
      bridgeFee: bridgeFee.toFixed(6),
      bridgeFeeRate: `${(bridgeFeeRate * 100).toFixed(4)}%`,
      gasFee: `$${gasFee.toFixed(2)}`,
      gasSource: gasSource,
      gasDetails: gasDetails,
      totalFee: `$${totalFee.toFixed(2)}`,
      estimatedTime: `${estimatedMinutes.toFixed(1)} min`,
      timestamp: Date.now(),
    });
  } catch (error) {
    crosschainLogger.error('Error calculating fee estimate', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({ error: 'Failed to calculate fee estimate' });
  }
});

// Bridge health check
router.get('/health', (req, res) => {
  try {
    const healthStatus = Object.entries(bridgeStatuses).map(([id, status]) => ({
      bridgeId: id,
      name: status.name,
      status: status.status,
      uptime: status.uptime,
      healthy: status.uptime > 95 && status.status === 'active',
    }));

    const totalBridges = healthStatus.length;
    const healthyBridges = healthStatus.filter(b => b.healthy).length;
    const overallHealth = (healthyBridges / totalBridges) * 100;

    res.json({
      overallHealth: overallHealth.toFixed(1),
      totalBridges,
      healthyBridges,
      unhealthyBridges: totalBridges - healthyBridges,
      bridges: healthStatus,
      timestamp: Date.now(),
    });
  } catch (error) {
    crosschainLogger.error('Error getting bridge health', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({ error: 'Failed to get bridge health status' });
  }
});

// Optimal route recommendation
// SECURITY: Requires authentication - route optimization may involve user-specific preferences
router.post('/optimal-route', requireAuth, validatePostBody, (req, res) => {
  try {
    const { amount, sourceChain, destChain, priorities = {} } = req.body;

    // Validate required parameters
    if (amount === undefined || !sourceChain || !destChain) {
      return res.status(400).json({ error: 'Missing required parameters: amount, sourceChain, destChain' });
    }

    // Validate amount
    const numericAmount = validateNumericRange(amount, 0, Number.MAX_SAFE_INTEGER);
    if (numericAmount === null || numericAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    // Validate sourceChain
    if (typeof sourceChain !== 'string') {
      return res.status(400).json({ error: 'sourceChain must be a string' });
    }

    if (!validateChainId(sourceChain)) {
      return res.status(400).json({ error: 'sourceChain contains invalid characters' });
    }

    // Validate destChain
    if (typeof destChain !== 'string') {
      return res.status(400).json({ error: 'destChain must be a string' });
    }

    if (!validateChainId(destChain)) {
      return res.status(400).json({ error: 'destChain contains invalid characters' });
    }

    // Validate priorities if provided
    if (priorities !== undefined && (typeof priorities !== 'object' || Array.isArray(priorities))) {
      return res.status(400).json({ error: 'priorities must be an object' });
    }

    // Validate priority values if provided
    if (priorities) {
      const priorityFields = ['speed', 'cost', 'reliability'];
      for (const field of priorityFields) {
        if (priorities[field] !== undefined) {
          const val = validateNumericRange(priorities[field], 0, 1);
          if (val === null) {
            return res.status(400).json({ error: `priorities.${field} must be a number between 0 and 1` });
          }
        }
      }
    }

    // Sanitize inputs
    const sanitizedSourceChain = sanitizeObject(sourceChain);
    const sanitizedDestChain = sanitizeObject(destChain);
    const sanitizedPriorities = sanitizeObject(priorities);

    // Define which bridges support which chains
    const chainSupport = {
      ethereum: [
        'axelar',
        'layerzero',
        'wormhole',
        'chainlink-ccip',
        'optimism',
        'base',
      ],
      polygon: ['axelar', 'layerzero', 'wormhole', 'celer-cbridge'],
      avalanche: ['axelar', 'layerzero', 'chainflip'],
      arbitrum: ['axelar', 'layerzero', 'optimism'],
      optimism: ['axelar', 'layerzero', 'optimism'],
      base: ['axelar', 'layerzero', 'base'],
      polkadot: ['polkadot-xcmp', 'chainlink-ccip'],
      cosmos: ['cosmos-ibc', 'axelar'],
      near: ['near-rainbow', 'axelar'],
    };

    const supportedBridges = chainSupport[sanitizedDestChain] || [];

    // Calculate scores for each supported bridge
    const routes = supportedBridges
      .map(bridgeId => {
        const status = bridgeStatuses[bridgeId];
        if (!status) return null;

        const speedWeight = sanitizedPriorities.speed || 0.3;
        const costWeight = sanitizedPriorities.cost || 0.4;
        const reliabilityWeight = sanitizedPriorities.reliability || 0.3;

        // Calculate scores (0-100)
        const speedScore = Math.max(
          0,
          100 - parseFloat(status.avgTransactionTime.split(' ')[0]) * 10
        );
        const costScore = Math.max(
          0,
          100 - parseFloat(status.currentFee.replace('%', '')) * 1000
        );
        const reliabilityScore = status.uptime;

        const totalScore =
          speedScore * speedWeight +
          costScore * costWeight +
          reliabilityScore * reliabilityWeight;

        return {
          bridgeId,
          name: status.name,
          score: totalScore,
          speedScore,
          costScore,
          reliabilityScore,
          estimatedTime: status.avgTransactionTime,
          fee: status.currentFee,
          uptime: status.uptime,
          securityLevel: status.securityLevel,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    res.json({
      sourceChain: sanitizedSourceChain,
      destChain: sanitizedDestChain,
      amount: numericAmount,
      recommendedRoute: routes[0],
      allRoutes: routes,
      priorities: sanitizedPriorities,
      timestamp: Date.now(),
    });
  } catch (error) {
    crosschainLogger.error('Error calculating optimal route', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({ error: 'Failed to calculate optimal route' });
  }
});

module.exports = router;
