// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

/**
 * Cross-Chain Protocol Server
 * Port 3000 - Specialized for cross-chain messaging and bridging
 * Designed for: Axelar, LayerZero, Wormhole, IBC, XCMP, ILPv4, NEAR Rainbow, Optimism, THORChain, ChainFlip, Base, Celer, Hyperlane
 *
 * HONEST-GAP STATUS (backend#1118): this service has NO bridge SDK wired
 * (no @axelar-network/*, @layerzerolabs/*, @wormhole-foundation/* dependency)
 * and no relayer. The protocol table below is a design catalog. Every route
 * that used to fabricate live data (message send/track, metrics, bridge
 * status, block height, rewards, balances) now returns an explicit 501
 * NOT_IMPLEMENTED via server/utils/honest-gap.js. Wire a real SDK before
 * turning any of them back into a 200. Same pattern family as backend#1024,
 * #1041, #1006, #1016; fix pattern from wrfsentinel#34.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const ProductionCORSCleanup =
  require('../middleware/production-cors-cleanup').default;
const { transferValidation } = require('../middleware/input-validation');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
const {
  trustKnownProxy,
  getTrustedClientIp,
  getIpRateLimitKey,
} = require('./utils/trustedProxyConfig.js');

// backend#1118: the former "metrics service" (services/CrossChainMetricsService)
// is an in-memory Map, not a bridge. It is no longer consulted here.
const { sendNotWired, integrationNotice } = require('./utils/honest-gap.js');
const CROSSCHAIN_SEE = 'wrfcoin/backend#1118';

const app = express();
// CROSS_CHAIN_PORT lets tests bind an ephemeral port; production keeps 3000.
const PORT = Number(process.env.CROSS_CHAIN_PORT || 3000);
const probeState = { draining: false };

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'cross-chain-protocols' },
  transports: [
    new winston.transports.File({
      filename: 'logs/cross-chain-error.log',
      level: 'error',
    }),
    new winston.transports.File({ filename: 'logs/cross-chain-combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Middleware
// Only trust forwarded headers from explicitly allowlisted upstream proxies.
app.set('trust proxy', trustKnownProxy);
app.use(helmet());
// Enhanced security middleware with production CORS cleanup
ProductionCORSCleanup.autoConfigureCORS(app);
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Rate limiting for cross-chain operations with trusted-proxy-aware IP keys.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: req => getIpRateLimitKey(req),
});
app.use(limiter);

// Cross-Chain Protocol Integrations - design catalog of the 13 protocols this
// service is meant to front. `status: 'not_wired'` on every entry is deliberate
// (backend#1118): none has an SDK behind it. Fabricated live fields
// (daily_volume, success_rate) were removed.
const crossChainProtocols = {
  axelar: {
    name: 'Axelar Network',
    type: 'general_message_passing',
    status: 'not_wired',
    supported_chains: 55,
    validators: 75,
    specialization: 'secure_cross_chain_communication',
    message_fee: '0.1 AXL',
    avg_finality_time: '60s',
  },
  layerzero: {
    name: 'LayerZero',
    type: 'omnichain_interoperability',
    status: 'not_wired',
    supported_chains: 50,
    relayers: 15,
    specialization: 'ultra_light_node_verification',
    message_fee: '0.001 ETH',
    avg_finality_time: '5-20min',
  },
  wormhole: {
    name: 'Wormhole',
    type: 'generic_message_passing',
    status: 'not_wired',
    supported_chains: 30,
    guardians: 19,
    specialization: 'cross_chain_asset_transfer',
    message_fee: '0.002 ETH',
    avg_finality_time: '15s',
  },
  ibc: {
    name: 'Inter-Blockchain Communication',
    type: 'cosmos_ecosystem',
    status: 'not_wired',
    supported_chains: 100,
    validators: 'variable',
    specialization: 'cosmos_interchain',
    message_fee: '0.001 ATOM',
    avg_finality_time: '6s',
  },
  xcmp: {
    name: 'Cross-Chain Message Passing (XCMP)',
    type: 'polkadot_ecosystem',
    status: 'not_wired',
    supported_chains: 50,
    validators: 297,
    specialization: 'polkadot_parachains',
    message_fee: '0.01 DOT',
    avg_finality_time: '12s',
  },
  ilpv4: {
    name: 'Interledger Protocol v4 (ILPv4)',
    type: 'payment_protocol',
    status: 'not_wired',
    supported_networks: 'unlimited',
    connectors: 'distributed',
    specialization: 'payment_routing',
    message_fee: 'variable',
    avg_finality_time: '<1s',
  },
  near_rainbow: {
    name: 'NEAR Rainbow Bridge',
    type: 'trustless_bridge',
    status: 'not_wired',
    supported_chains: 3,
    validators: 100,
    specialization: 'ethereum_near_bridge',
    message_fee: '0.005 ETH',
    avg_finality_time: '4min',
  },
  optimism: {
    name: 'Optimism Bridge',
    type: 'layer2_bridge',
    status: 'not_wired',
    supported_chains: 2,
    validators: 'sequencer',
    specialization: 'ethereum_l2_scaling',
    message_fee: '0.0001 ETH',
    avg_finality_time: '7 days*',
  },
  thorchain: {
    name: 'THORChain',
    type: 'cross_chain_dex',
    status: 'not_wired',
    supported_chains: 8,
    validators: 120,
    specialization: 'decentralized_exchange',
    message_fee: '0.02 RUNE',
    avg_finality_time: '3min',
  },
  chainflip: {
    name: 'ChainFlip',
    type: 'cross_chain_amm',
    status: 'not_wired',
    supported_chains: 6,
    validators: 150,
    specialization: 'automated_market_maker',
    message_fee: '0.3%',
    avg_finality_time: '2-5min',
  },
  base: {
    name: 'Base Bridge',
    type: 'layer2_bridge',
    status: 'not_wired',
    supported_chains: 2,
    validators: 'sequencer',
    specialization: 'coinbase_l2_bridge',
    message_fee: '0.0002 ETH',
    avg_finality_time: '7 days*',
  },
  celer: {
    name: 'Celer Network',
    type: 'layer2_scaling',
    status: 'not_wired',
    supported_chains: 35,
    validators: 'state_guardian_network',
    specialization: 'state_channel_network',
    message_fee: '0.1%',
    avg_finality_time: '10-20s',
  },
  hyperlane: {
    name: 'Hyperlane',
    type: 'interchain_security',
    status: 'not_wired',
    supported_chains: 25,
    validators: 'modular',
    specialization: 'permissionless_interoperability',
    message_fee: '0.001 ETH',
    avg_finality_time: '30s',
  },
};


// Logging middleware
app.use((req, res, next) => {
  logger.info('Cross-Chain API Request', {
    ip: getTrustedClientIp(req),
    method: req.method,
    path: req.path,
  });
  next();
});

const operationalProbes = createHealthMiddleware(
  'cross-chain-protocols',
  {},
  { state: probeState }
);
app.use(operationalProbes.router);

// Get all cross-chain protocols — design catalog, explicitly marked not wired.
app.get('/api/crosschain/protocols', (req, res) => {
  try {
    const totalChains = Object.values(crossChainProtocols).reduce(
      (sum, protocol) => {
        const chains =
          typeof protocol.supported_chains === 'number'
            ? protocol.supported_chains
            : 50; // Default for variable chains
        return sum + chains;
      },
      0
    );

    res.json({
      success: true,
      integration: integrationNotice('Cross-chain protocols', CROSSCHAIN_SEE),
      protocols: crossChainProtocols,
      total_supported_chains: totalChains,
      active_protocols: 0,
      message_types: [
        'token_transfer',
        'contract_call',
        'data_relay',
        'governance',
      ],
    });
  } catch (error) {
    logger.error('Error fetching cross-chain protocols', {
      error: error.message,
    });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get specific protocol — catalog entry; live metrics are not available.
app.get('/api/crosschain/protocols/:protocol', (req, res) => {
  try {
    const { protocol } = req.params;
    const protocolInfo = crossChainProtocols[protocol.toLowerCase()];

    if (!protocolInfo) {
      return res
        .status(404)
        .json({ success: false, error: 'Protocol not found' });
    }

    res.json({
      success: true,
      integration: integrationNotice('Cross-chain protocols', CROSSCHAIN_SEE),
      protocol: protocolInfo,
      metrics: {
        unavailable: true,
        reason: `No ${protocolInfo.name} SDK is wired; uptime/success/volume cannot be reported.`,
      },
    });
  } catch (error) {
    logger.error('Error fetching protocol', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Send cross-chain message — input validation kept, dispatch honestly absent.
app.post('/api/crosschain/send', (req, res) => {
  try {
    const {
      protocol,
      source_chain,
      destination_chain,
      message_type,
      payload,
    } = req.body;

    if (
      !protocol ||
      !source_chain ||
      !destination_chain ||
      !message_type ||
      !payload
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Protocol, source_chain, destination_chain, message_type, and payload are required',
      });
    }

    const selectedProtocol = crossChainProtocols[protocol.toLowerCase()];
    if (!selectedProtocol) {
      return res
        .status(404)
        .json({ success: false, error: 'Protocol not found' });
    }

    return sendNotWired(res, {
      capability: 'crosschain.send',
      message: `${selectedProtocol.name} integration not yet wired; message was NOT sent.`,
      details:
        'Needs a real bridge SDK/relayer behind this route. The previous implementation only stored the message in memory and marked it "completed" on a timer with a random confirmation hash.',
      see: CROSSCHAIN_SEE,
    });
  } catch (error) {
    logger.error('Error sending cross-chain message', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Get message status — there is no message store behind a real bridge.
app.get('/api/crosschain/messages/:messageId', (req, res) => {
  return sendNotWired(res, {
    capability: 'crosschain.message_status',
    message: 'Cross-chain message tracking not yet wired.',
    details: 'No bridge SDK is integrated, so no message can have been sent or tracked.',
    see: CROSSCHAIN_SEE,
  });
});

// Get supported chains for a protocol — previously an invented example list.
app.get('/api/crosschain/protocols/:protocol/chains', (req, res) => {
  const protocolInfo = crossChainProtocols[req.params.protocol.toLowerCase()];
  if (!protocolInfo) {
    return res.status(404).json({ success: false, error: 'Protocol not found' });
  }
  return sendNotWired(res, {
    capability: 'crosschain.supported_chains',
    message: `${protocolInfo.name} chain list not yet wired.`,
    details: 'The previous response was a hard-coded example list, not data from the protocol.',
    see: CROSSCHAIN_SEE,
  });
});

// Get all active messages
app.get('/api/crosschain/messages', (req, res) => {
  return sendNotWired(res, {
    capability: 'crosschain.messages',
    message: 'Cross-chain message tracking not yet wired.',
    see: CROSSCHAIN_SEE,
  });
});

// Cross-chain metrics endpoint
app.get('/api/crosschain/metrics', (req, res) => {
  return sendNotWired(res, {
    capability: 'crosschain.metrics',
    message: 'Cross-chain metrics not yet wired.',
    details:
      'Previous values (TVL "$2.4B", 370 chains, 556 validators, 99.5% success) were constants, not measurements.',
    see: CROSSCHAIN_SEE,
  });
});

// Bridge status endpoint
app.get('/api/crosschain/bridge-status', (req, res) => {
  return sendNotWired(res, {
    capability: 'crosschain.bridge_status',
    message: 'Bridge status not yet wired.',
    details: 'No bridge is connected; the previous "operational / 99.9% uptime" answer was static.',
    see: CROSSCHAIN_SEE,
  });
});

// Legacy convenience endpoints this server also exposed — all were constants.
app.get('/api/blockchain/status', (req, res) => {
  return sendNotWired(res, {
    capability: 'blockchain.status',
    message: 'Chain status is not served by the cross-chain service.',
    details: 'The previous height was a counter incremented every 12s from 1000, not a chain read.',
    see: 'core4 node API (/api/status on the launch API) or backend /api/blockchain routes',
  });
});

app.get('/api/mining/cross-chain-rewards', (req, res) => {
  return sendNotWired(res, {
    capability: 'mining.cross_chain_rewards',
    message: 'Cross-chain mining rewards not yet wired.',
    see: CROSSCHAIN_SEE,
  });
});

app.get('/api/wallet/balance', (req, res) => {
  return sendNotWired(res, {
    capability: 'wallet.balance',
    message: 'Wallet balance is not served by the cross-chain service.',
    see: 'GET /api/wallet/:address on main-api (server/routes/wallet-routes.js)',
  });
});

app.get('/api/layer2/performance', (req, res) => {
  return sendNotWired(res, {
    capability: 'layer2.performance',
    message: 'Layer-2 performance metrics not yet wired.',
    see: CROSSCHAIN_SEE,
  });
});

app.get('/api/privacy/features', (req, res) => {
  return sendNotWired(res, {
    capability: 'privacy.features',
    message: 'Privacy feature counters not yet wired.',
    details: 'Previous counts (1247 private txs, 2891 zk proofs) were constants.',
    see: CROSSCHAIN_SEE,
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// 404 handler (must be last)
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info('Cross-Chain Protocol Server started', { port: PORT, url: `http://0.0.0.0:${PORT}` });
});

registerGracefulShutdown({
  serviceName: 'cross-chain-protocols',
  server,
  logger,
  state: probeState,
});

module.exports = { app, server };
