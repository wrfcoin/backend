/**
 * Mining Routes
 *
 * This module proxies supported mining operations to the core4 launch API and
 * returns explicit 501s for legacy mock-only flows.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { logger } = require('../utils/logger');
const { generalLimiter, transferLimiter } = require('../../middleware/rateLimiting');
const { core4PublicReadHeaders } = require('../utils/core4-reader-credential');

const { core4OperatorHeaders, configuredAddress, requireEmptyAdminBody, auditedAdminWrite, sendAdminPolicyError } = require('../utils/core4-admin-policy');

let core4ClientPromise = null;

async function getCore4Client() {
  if (!core4ClientPromise) {
    core4ClientPromise = import('../../shared/core4-route-client.js');
  }

  return core4ClientPromise;
}

async function getMiningSnapshot(req) {
  const {
    extractCore4Data,
    fetchCore4Json,
  } = await getCore4Client();
  const headers = core4PublicReadHeaders(req.headers);
  const [miningResponse, syncResponse, resourceResponse, networkResponse] =
    await Promise.all([
      fetchCore4Json('/mining/stats', { headers }),
      fetchCore4Json('/node/sync/status', { headers }),
      fetchCore4Json('/node/resources', { headers }),
      fetchCore4Json('/network/info', { headers }),
    ]);

  return {
    responses: {
      miningResponse,
      syncResponse,
      resourceResponse,
      networkResponse,
    },
    data: {
      mining: miningResponse.ok ? extractCore4Data(miningResponse.payload) || {} : null,
      sync: syncResponse.ok ? extractCore4Data(syncResponse.payload) || {} : null,
      resources: resourceResponse.ok ? extractCore4Data(resourceResponse.payload) || {} : null,
      network: networkResponse.ok ? extractCore4Data(networkResponse.payload) || {} : null,
    },
  };
}

function logMiningRequest(req, _res, next) {
  logger.info(`Mining API Request: ${req.method} ${req.originalUrl}`, {
    ip: req.ip || req.connection?.remoteAddress,
    method: req.method,
    path: req.originalUrl,
  });
  next();
}

async function handleStartMining(req, res) {
  try {
    const {
      extractCore4Data,
      fetchCore4Json,
      sendCore4Error,
      sendCore4Unavailable,
      toNullable,
    } = await getCore4Client();
    requireEmptyAdminBody(req.body);
    const minerAddress = configuredAddress('WRFCOIN_MINING_REWARD_ADDRESS');
    const headers = core4OperatorHeaders(req.headers);
    const response = await auditedAdminWrite(req, 'mining.start', { source: 'config' }, () => fetchCore4Json('/blocks/mine', {
      method: 'POST',
      headers,
      body: {
        miner_address: minerAddress,
      },
    }));

    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to start mining');
    }

    const result = extractCore4Data(response.payload) || {};

    return res.status(201).json({
      success: true,
      message: 'Mining request submitted successfully',
      operation_id: null,
      hashrate: null,
      workers: null,
      pool: null,
      core4: {
        height: toNullable(result.height),
        hash: toNullable(result.hash),
        transactionCount: toNullable(result.transaction_count),
      },
    });
  } catch (error) {
    if (sendAdminPolicyError(res, error)) return;
    const { sendCore4Unavailable } = await getCore4Client();
    return sendCore4Unavailable(res, error, 'Failed to start mining');
  }
}

router.use(requireAuth);
router.use(generalLimiter);
router.use(logMiningRequest);

router.get('/setup/hardware', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Hardware discovery is not available from the core4 launch API.'
  );
});

router.post('/wallet/quick-setup', transferLimiter, async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Wallet quick setup is not available from the core4 launch API.'
  );
});

router.post('/setup/providers/configure', transferLimiter, async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Mining provider configuration is not available from the core4 launch API.'
  );
});

router.post('/setup/start', requireAdmin, transferLimiter, handleStartMining);

router.get('/node-stats', async (req, res, next) => {
  try {
    const {
      sendCore4Error,
      sendCore4Unavailable,
      toNullable,
    } = await getCore4Client();
    const snapshot = await getMiningSnapshot(req);
    const {
      miningResponse,
      syncResponse,
      resourceResponse,
      networkResponse,
    } = snapshot.responses;

    for (const [response, message] of [
      [miningResponse, 'Failed to fetch mining stats'],
      [syncResponse, 'Failed to fetch node sync status'],
      [resourceResponse, 'Failed to fetch node resources'],
      [networkResponse, 'Failed to fetch network info'],
    ]) {
      if (!response.ok) {
        return sendCore4Error(res, response, message);
      }
    }

    const { mining, sync, resources, network } = snapshot.data;

    return res.json({
      success: true,
      data: {
        node_id: toNullable(resources.node_id),
        status: toNullable(sync.sync_status),
        uptime: toNullable(resources.uptime_secs),
        hashrate: toNullable(mining.difficulty),
        connected_miners: toNullable(resources.pending_transactions),
        network_hashrate: null,
        difficulty: toNullable(mining.difficulty),
        block_height: toNullable(sync.chain_height ?? mining.chain_height),
        last_block_time: null,
        version: toNullable(network.node_version),
        sync_status: toNullable(sync.sync_status),
      },
      message: 'Node statistics retrieved successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error(`Error fetching mining node stats: ${error.message}`, { error });
    return sendCore4Unavailable(res, error, 'Failed to fetch mining node stats');
  }
});

router.get('/pool-info', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Mining pool information is not available from the core4 launch API.'
  );
});

router.post('/start', requireAdmin, transferLimiter, handleStartMining);

router.post('/stop', transferLimiter, async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Stopping an active mining operation is not available from the core4 launch API.'
  );
});

router.get('/hardware', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Hardware telemetry is not available from the core4 launch API.'
  );
});

router.get('/achievements', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Mining achievements are not available from the core4 launch API.'
  );
});

router.get('/achievements/:minerId', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Mining achievements are not available from the core4 launch API.'
  );
});

router.get('/cross-chain-rewards', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Cross-chain mining rewards are not available from the core4 launch API.'
  );
});

router.get('/cross-chain-rewards/:minerId', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Cross-chain mining rewards are not available from the core4 launch API.'
  );
});

router.get('/performance/system', async (req, res) => {
  try {
    const {
      sendCore4Error,
      sendCore4Unavailable,
      toNullable,
    } = await getCore4Client();
    const snapshot = await getMiningSnapshot(req);
    const { resourceResponse } = snapshot.responses;

    if (!resourceResponse.ok) {
      return sendCore4Error(
        res,
        resourceResponse,
        'Failed to fetch mining system performance'
      );
    }

    const resources = snapshot.data.resources;

    return res.json({
      success: true,
      data: {
        uptime_secs: toNullable(resources.uptime_secs),
        blocks_in_memory: toNullable(resources.blocks_in_memory),
        accounts: toNullable(resources.accounts),
        nfts: toNullable(resources.nfts),
        pending_transactions: toNullable(resources.pending_transactions),
      },
      message: 'System performance retrieved successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    return sendCore4Unavailable(
      res,
      error,
      'Failed to fetch mining system performance'
    );
  }
});

router.get('/performance/mining', async (req, res) => {
  try {
    const {
      sendCore4Error,
      sendCore4Unavailable,
      toNullable,
    } = await getCore4Client();
    const snapshot = await getMiningSnapshot(req);
    const { miningResponse, syncResponse } = snapshot.responses;

    if (!miningResponse.ok) {
      return sendCore4Error(
        res,
        miningResponse,
        'Failed to fetch mining performance stats'
      );
    }

    if (!syncResponse.ok) {
      return sendCore4Error(
        res,
        syncResponse,
        'Failed to fetch mining performance sync status'
      );
    }

    const mining = snapshot.data.mining;
    const sync = snapshot.data.sync;

    return res.json({
      success: true,
      data: {
        chain_height: toNullable(sync.chain_height ?? mining.chain_height),
        difficulty: toNullable(mining.difficulty),
        total_transactions: toNullable(mining.total_transactions),
        avg_block_time_secs: toNullable(mining.avg_block_time_secs),
        sync_status: toNullable(sync.sync_status),
      },
      message: 'Mining performance retrieved successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    return sendCore4Unavailable(
      res,
      error,
      'Failed to fetch mining performance stats'
    );
  }
});

router.get('/performance/alerts', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Mining performance alerts are not available from the core4 launch API.'
  );
});

router.put('/performance/thresholds', transferLimiter, async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Mining performance threshold updates are not available from the core4 launch API.'
  );
});

for (const action of ['pause', 'resume', 'restart', 'stop']) {
  router.post(`/operations/:operationId/${action}`, transferLimiter, async (_req, res) => {
    const { sendNotImplemented } = await getCore4Client();
    return sendNotImplemented(
      res,
      `Mining operation ${action} is not available from the core4 launch API.`
    );
  });
}

router.get('/stats', async (req, res) => {
  try {
    const {
      sendCore4Error,
      sendCore4Unavailable,
      toNullable,
    } = await getCore4Client();
    const snapshot = await getMiningSnapshot(req);
    const { miningResponse, syncResponse } = snapshot.responses;

    if (!miningResponse.ok) {
      return sendCore4Error(res, miningResponse, 'Failed to fetch mining stats');
    }

    if (!syncResponse.ok) {
      return sendCore4Error(
        res,
        syncResponse,
        'Failed to fetch mining sync status'
      );
    }

    const mining = snapshot.data.mining;
    const sync = snapshot.data.sync;

    return res.json({
      success: true,
      data: {
        chain_height: toNullable(sync.chain_height ?? mining.chain_height),
        difficulty: toNullable(mining.difficulty),
        total_transactions: toNullable(mining.total_transactions),
        avg_block_time_secs: toNullable(mining.avg_block_time_secs),
        sync_status: toNullable(sync.sync_status),
      },
      message: 'Mining stats retrieved successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    return sendCore4Unavailable(res, error, 'Failed to fetch mining stats');
  }
});

module.exports = router;
