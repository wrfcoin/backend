/**
 * Wrfcoin Wormhole Bridge Module
 *
 * This module defines the interface for Wormhole cross-chain integration.
 * All transfer/message functions are stubs that throw until a real Wormhole
 * adapter is configured (see issue #119).
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// Load the configuration and adapters
const config = require('./config');
const evmAdapter = require('./evm-adapter');
const solanaAdapter = require('./solana-adapter');

// Import the database connection — throws if unavailable
const db = require('../db');
const pool = db.pool;

/**
 * Get the health status of the Wormhole bridge integration.
 * Reports which required environment variables are configured.
 * @returns {Object} Health status
 */
function getHealthStatus() {
  return {
    status: 'not_configured',
    message: 'Wormhole bridge requires real adapter configuration',
    requiredEnvVars: config.REQUIRED_ENV_VARS,
    configuredVars: Object.fromEntries(
      config.REQUIRED_ENV_VARS.map((v) => [v, !!process.env[v]])
    ),
  };
}

/**
 * Initialize the connection to a Wormhole network.
 * Stub — throws until real adapter is configured.
 * @param {string} network - Network to connect to (mainnet, testnet, devnet)
 * @returns {Promise<never>}
 * @throws {Error} Always — real adapter not yet configured
 */
async function initializeConnection(network) {
  throw new Error(
    `Cannot initialize Wormhole connection to "${network}": real bridge adapter not yet configured. ` +
      'See issue #119 for implementation tracking.'
  );
}

/**
 * Initialize the Wormhole bridge service.
 * Creates database tables but does not establish bridge connections.
 * @returns {Promise<boolean>} Success status
 */
async function initialize() {
  try {
    logger.info('Initializing Wormhole bridge service');

    // Create necessary database tables
    await createTables();

    logger.info(
      'Wormhole bridge database tables created. Bridge connections require real adapter (issue #119).'
    );
    return true;
  } catch (error) {
    logger.error('Error initializing Wormhole bridge service:', error);
    return false;
  }
}

/**
 * Create the necessary database tables for Wormhole integration
 */
async function createTables() {
  try {
    // Create table for token transfers
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wormhole_transfers (
        id SERIAL PRIMARY KEY,
        transfer_id TEXT NOT NULL,
        source_chain TEXT NOT NULL,
        target_chain TEXT NOT NULL,
        token TEXT NOT NULL,
        amount TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL,
        completed_at TIMESTAMP,
        source_tx_hash TEXT,
        target_tx_hash TEXT,
        vaa_id TEXT,
        fee TEXT,
        error_message TEXT
      )
    `);

    // Create table for message passing
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wormhole_messages (
        id SERIAL PRIMARY KEY,
        message_id TEXT NOT NULL,
        source_chain TEXT NOT NULL,
        target_chain TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL,
        delivered_at TIMESTAMP,
        source_tx_hash TEXT,
        target_tx_hash TEXT,
        vaa_id TEXT,
        fee TEXT,
        error_message TEXT
      )
    `);

    // Create table for NFT transfers
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wormhole_nft_transfers (
        id SERIAL PRIMARY KEY,
        transfer_id TEXT NOT NULL,
        source_chain TEXT NOT NULL,
        target_chain TEXT NOT NULL,
        token_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        uri TEXT,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL,
        completed_at TIMESTAMP,
        source_tx_hash TEXT,
        target_tx_hash TEXT,
        vaa_id TEXT,
        fee TEXT,
        error_message TEXT
      )
    `);

    // Create table for VAAs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wormhole_vaas (
        id SERIAL PRIMARY KEY,
        vaa_id TEXT NOT NULL,
        status TEXT NOT NULL,
        emitter_chain INTEGER NOT NULL,
        emitter_address TEXT NOT NULL,
        sequence BIGINT NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        guardian_signatures INTEGER,
        quorum_reached BOOLEAN,
        payload TEXT,
        parsed JSONB
      )
    `);
  } catch (error) {
    logger.error('Error creating Wormhole database tables:', error);
    throw error;
  }
}

/**
 * Get the appropriate adapter for a chain
 * @param {string} chainName - Name of the chain
 * @returns {Object} Chain adapter
 */
function getChainAdapter(chainName) {
  const chainConfig = config.getChain(chainName);
  if (!chainConfig) {
    throw new Error(`Unsupported chain: ${chainName}`);
  }

  if (chainName === 'solana') {
    return solanaAdapter;
  }

  // Default to EVM adapter for all other chains
  return evmAdapter;
}

/**
 * Transfer tokens across chains via Wormhole.
 * Records the transfer in the database and returns a pending transfer record.
 * Without a live Wormhole adapter, the transfer remains in 'pending' status
 * until an external relay or cron job processes it.
 * @param {Object} params - Transfer parameters
 * @param {string} params.sourceChain - Source chain name
 * @param {string} params.targetChain - Target chain name
 * @param {string} params.token - Token identifier
 * @param {string} params.amount - Transfer amount
 * @param {string} params.sender - Sender address
 * @param {string} params.recipient - Recipient address
 * @returns {Promise<Object>} Transfer record with transferId and status
 */
async function transferTokens(params) {
  const { sourceChain, targetChain, token, amount, sender, recipient } = params || {};

  if (!sourceChain || !targetChain || !token || !amount || !sender || !recipient) {
    throw new Error('Missing required parameters: sourceChain, targetChain, token, amount, sender, recipient');
  }

  const transferId = uuidv4();
  const now = new Date();

  // Estimate fee for the transfer
  let fee = '0';
  try {
    const feeEstimate = await estimateFee({
      sourceChain,
      targetChain,
      operationType: 'TOKEN_TRANSFER',
      token,
      amount,
    });
    fee = feeEstimate.totalFee;
  } catch (err) {
    logger.warn('Fee estimation failed, defaulting to 0', { error: err.message });
  }

  await pool.query(
    `INSERT INTO wormhole_transfers
     (transfer_id, source_chain, target_chain, token, amount, sender, recipient, status, created_at, fee)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [transferId, sourceChain, targetChain, token, amount, sender, recipient, 'pending', now, fee]
  );

  logger.info(`Wormhole token transfer recorded: ${transferId} (pending — no live adapter)`);

  return {
    transferId,
    sourceChain,
    targetChain,
    token,
    amount,
    sender,
    recipient,
    status: 'pending',
    fee,
    createdAt: now.toISOString(),
    message: 'Transfer recorded. Processing requires a live Wormhole adapter.',
  };
}

/**
 * Send a message across chains via Wormhole.
 * Records the message in the database and returns a pending message record.
 * Without a live Wormhole adapter, the message remains in 'pending' status.
 * @param {Object} params - Message parameters
 * @param {string} params.sourceChain - Source chain name
 * @param {string} params.targetChain - Target chain name
 * @param {string} params.sender - Sender address
 * @param {string} params.recipient - Recipient address
 * @param {Object} params.payload - Message payload
 * @returns {Promise<Object>} Message record with messageId and status
 */
async function sendMessage(params) {
  const { sourceChain, targetChain, sender, recipient, payload } = params || {};

  if (!sourceChain || !targetChain || !sender || !recipient || payload === undefined) {
    throw new Error('Missing required parameters: sourceChain, targetChain, sender, recipient, payload');
  }

  const messageId = uuidv4();
  const now = new Date();

  let fee = '0';
  try {
    const feeEstimate = await estimateFee({
      sourceChain,
      targetChain,
      operationType: 'MESSAGE',
    });
    fee = feeEstimate.totalFee;
  } catch (err) {
    logger.warn('Fee estimation failed, defaulting to 0', { error: err.message });
  }

  await pool.query(
    `INSERT INTO wormhole_messages
     (message_id, source_chain, target_chain, sender, recipient, payload, status, created_at, fee)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [messageId, sourceChain, targetChain, sender, recipient, JSON.stringify(payload), 'pending', now, fee]
  );

  logger.info(`Wormhole message recorded: ${messageId} (pending — no live adapter)`);

  return {
    messageId,
    sourceChain,
    targetChain,
    sender,
    recipient,
    status: 'pending',
    fee,
    createdAt: now.toISOString(),
    message: 'Message recorded. Delivery requires a live Wormhole adapter.',
  };
}

/**
 * Transfer an NFT across chains via Wormhole.
 * Records the NFT transfer in the database and returns a pending transfer record.
 * Without a live Wormhole adapter, the transfer remains in 'pending' status.
 * @param {Object} params - NFT transfer parameters
 * @param {string} params.sourceChain - Source chain name
 * @param {string} params.targetChain - Target chain name
 * @param {string} params.tokenId - NFT token ID
 * @param {string} params.tokenAddress - NFT contract address
 * @param {string} [params.uri] - Token URI
 * @param {string} params.sender - Sender address
 * @param {string} params.recipient - Recipient address
 * @returns {Promise<Object>} Transfer record with transferId and status
 */
async function transferNFT(params) {
  const { sourceChain, targetChain, tokenId, tokenAddress, uri, sender, recipient } = params || {};

  if (!sourceChain || !targetChain || !tokenId || !tokenAddress || !sender || !recipient) {
    throw new Error('Missing required parameters: sourceChain, targetChain, tokenId, tokenAddress, sender, recipient');
  }

  const transferId = uuidv4();
  const now = new Date();

  let fee = '0';
  try {
    const feeEstimate = await estimateFee({
      sourceChain,
      targetChain,
      operationType: 'NFT_TRANSFER',
    });
    fee = feeEstimate.totalFee;
  } catch (err) {
    logger.warn('Fee estimation failed, defaulting to 0', { error: err.message });
  }

  await pool.query(
    `INSERT INTO wormhole_nft_transfers
     (transfer_id, source_chain, target_chain, token_id, token_address, uri, sender, recipient, status, created_at, fee)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [transferId, sourceChain, targetChain, tokenId, tokenAddress, uri || '', sender, recipient, 'pending', now, fee]
  );

  logger.info(`Wormhole NFT transfer recorded: ${transferId} (pending — no live adapter)`);

  return {
    transferId,
    sourceChain,
    targetChain,
    tokenId,
    tokenAddress,
    uri: uri || null,
    sender,
    recipient,
    status: 'pending',
    fee,
    createdAt: now.toISOString(),
    message: 'NFT transfer recorded. Processing requires a live Wormhole adapter.',
  };
}

/**
 * Estimate the fee for a cross-chain operation
 * @param {Object} params - Fee estimation parameters
 * @returns {Promise<Object>} Estimated fee
 */
async function estimateFee(params) {
  try {
    const { sourceChain, targetChain, operationType, token, amount } = params;

    // Validate parameters
    if (!sourceChain || !targetChain || !operationType) {
      throw new Error('Missing required parameters for fee estimation');
    }

    // Get fee configuration for the operation type
    const feeConfig = config.getFee(operationType);
    if (!feeConfig) {
      throw new Error(`Unsupported operation type: ${operationType}`);
    }

    // Get chain configurations
    const sourceChainConfig = config.getChain(sourceChain);
    if (!sourceChainConfig) {
      throw new Error(`Unsupported source chain: ${sourceChain}`);
    }

    // Calculate the fee based on operation type
    let totalFee;
    if (operationType === 'TOKEN_TRANSFER' && token && amount) {
      // For token transfers, apply percentage fee
      const baseFee = feeConfig.base;
      const percentageFee = parseFloat(amount) * feeConfig.percentage;
      totalFee = baseFee + percentageFee;

      // Apply min/max constraints
      totalFee = Math.max(
        feeConfig.minFee,
        Math.min(feeConfig.maxFee, totalFee)
      );
    } else if (operationType === 'NFT_TRANSFER') {
      // For NFT transfers, use the base fee
      totalFee = feeConfig.base;
    } else if (operationType === 'MESSAGE') {
      // For messages, use the base fee
      totalFee = feeConfig.base;
    } else {
      throw new Error(
        `Invalid operation type or missing parameters: ${operationType}`
      );
    }

    return {
      sourceChain,
      targetChain,
      operationType,
      baseFee: feeConfig.base,
      percentageFee:
        operationType === 'TOKEN_TRANSFER' ? feeConfig.percentage : 0,
      totalFee: totalFee.toFixed(6),
      nativeCurrency: sourceChainConfig.nativeCurrency,
    };
  } catch (error) {
    logger.error('Error estimating Wormhole fee:', error);
    throw error;
  }
}

/**
 * Get the status of a VAA (Verifiable Action Approval).
 * Looks up the VAA in the local database by vaa_id.
 * @param {string} vaaId - ID of the VAA
 * @returns {Promise<Object>} VAA status record, or not-found indicator
 */
async function getVAAStatus(vaaId) {
  if (!vaaId) {
    throw new Error('Missing required parameter: vaaId');
  }

  const result = await pool.query(
    `SELECT * FROM wormhole_vaas WHERE vaa_id = $1 LIMIT 1`,
    [vaaId]
  );

  if (result.rows.length === 0) {
    return {
      available: false,
      vaaId,
      message: 'VAA not found in local database. It may not have been processed yet.',
    };
  }

  const row = result.rows[0];
  return {
    available: true,
    vaaId: row.vaa_id,
    status: row.status,
    emitterChain: row.emitter_chain,
    emitterAddress: row.emitter_address,
    sequence: row.sequence,
    timestamp: row.timestamp,
    guardianSignatures: row.guardian_signatures,
    quorumReached: row.quorum_reached,
    payload: row.payload,
    parsed: row.parsed,
  };
}

/**
 * Process a received VAA from the Wormhole network.
 * Records the VAA in the local database for tracking. Without a live
 * Guardian RPC, this accepts pre-parsed VAA data and stores it.
 * @param {Object} params - VAA processing parameters
 * @param {number} params.emitterChain - Chain ID of the emitter
 * @param {string} params.emitterAddress - Address of the emitter
 * @param {string|number} params.sequence - VAA sequence number
 * @param {string} [params.payload] - Hex-encoded payload
 * @param {number} [params.guardianSignatures] - Number of guardian signatures
 * @returns {Promise<Object>} Processed VAA record
 */
async function processVAA(params) {
  const { emitterChain, emitterAddress, sequence, payload, guardianSignatures } = params || {};

  if (emitterChain === undefined || !emitterAddress || sequence === undefined) {
    throw new Error('Missing required parameters: emitterChain, emitterAddress, sequence');
  }

  // Check for replay — prevent duplicate processing
  const existing = await pool.query(
    `SELECT id FROM wormhole_vaas WHERE emitter_chain = $1 AND emitter_address = $2 AND sequence = $3`,
    [emitterChain, emitterAddress, String(sequence)]
  );

  if (existing.rows.length > 0) {
    throw new Error(
      `VAA already processed: chain=${emitterChain} emitter=${emitterAddress} seq=${sequence}`
    );
  }

  const vaaId = uuidv4();
  const now = new Date();
  const sigCount = guardianSignatures || 0;
  const quorumReached = sigCount >= 13; // 2/3+1 of 19 guardians

  await pool.query(
    `INSERT INTO wormhole_vaas
     (vaa_id, status, emitter_chain, emitter_address, sequence, timestamp, guardian_signatures, quorum_reached, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      vaaId,
      quorumReached ? 'verified' : 'unverified',
      emitterChain,
      emitterAddress,
      String(sequence),
      now,
      sigCount,
      quorumReached,
      payload || null,
    ]
  );

  logger.info(`VAA processed: ${vaaId} (${quorumReached ? 'verified' : 'unverified'})`);

  return {
    vaaId,
    status: quorumReached ? 'verified' : 'unverified',
    emitterChain,
    emitterAddress,
    sequence: String(sequence),
    guardianSignatures: sigCount,
    quorumReached,
    timestamp: now.toISOString(),
  };
}

/**
 * List recent transfers across all chains
 * @param {Object} params - Query parameters
 * @returns {Promise<Array>} List of transfers
 */
async function listTransfers(params = {}) {
  try {
    const { limit = 10, offset = 0, status, sourceChain, targetChain } = params;

    // Build the query conditions
    const conditions = ['1=1'];
    const queryParams = [];

    if (status) {
      conditions.push(`status = $${queryParams.length + 1}`);
      queryParams.push(status);
    }

    if (sourceChain) {
      conditions.push(`source_chain = $${queryParams.length + 1}`);
      queryParams.push(sourceChain);
    }

    if (targetChain) {
      conditions.push(`target_chain = $${queryParams.length + 1}`);
      queryParams.push(targetChain);
    }

    // Add limit and offset
    queryParams.push(limit);
    queryParams.push(offset);

    // Execute the query
    const result = await pool.query(
      `
      SELECT * FROM wormhole_transfers
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${queryParams.length - 1}
      OFFSET $${queryParams.length}
    `,
      queryParams
    );

    // Format the results
    return result.rows.map((row) => ({
      transferId: row.transfer_id,
      sourceChain: row.source_chain,
      targetChain: row.target_chain,
      token: row.token,
      amount: row.amount,
      sender: row.sender,
      recipient: row.recipient,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      sourceTxHash: row.source_tx_hash,
      targetTxHash: row.target_tx_hash,
      vaaId: row.vaa_id,
      fee: row.fee,
      errorMessage: row.error_message,
    }));
  } catch (error) {
    logger.error('Error listing Wormhole transfers:', error);
    throw error;
  }
}

module.exports = {
  initialize,
  initializeConnection,
  transferTokens,
  sendMessage,
  transferNFT,
  estimateFee,
  getVAAStatus,
  processVAA,
  listTransfers,
  getHealthStatus,
};
