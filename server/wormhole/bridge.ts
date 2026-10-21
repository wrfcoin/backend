/**
 * Wrfcoin Wormhole Bridge Module
 *
 * Orchestrates cross-chain token transfers, NFT transfers, and message passing
 * via the Wormhole protocol. Integrates with BullMQ for async job processing
 * and real EVM/Solana adapters for on-chain interactions.
 */

import { v4 as uuidv4 } from 'uuid';
import { EvmAdapter } from './evm-adapter.js';
import { SolanaAdapter } from './solana-adapter.js';
import { VAAVerifier, type ParsedVAA } from './vaa-verifier.js';
import { crossChainQueueService } from '../../services/queue/CrossChainQueueService.js';
import type { CrossChainJobData } from '../../services/queue/types.js';

// Try to import logger and db — graceful fallback for logger
let logger: any;
try {
  logger = (await import('../utils/logger.js')).default;
} catch {
  logger = console;
}

let pool: any;
try {
  const db = await import('../db.js');
  pool = (db as any).pool ?? (db as any).default?.pool;
} catch (error) {
  throw new Error(
    'Database connection required for Wormhole bridge. Ensure DATABASE_URL is configured.'
  );
}

// Load config (stays as CommonJS)
const config = (await import('./config.js')).default ?? (await import('./config.js'));

// Adapter instances keyed by network
const evmAdapters: Map<string, EvmAdapter> = new Map();
const solanaAdapters: Map<string, SolanaAdapter> = new Map();
let vaaVerifier: VAAVerifier | null = null;

/**
 * Get or create an EVM adapter for the given chain and network.
 */
function getEvmAdapter(chainName: string, network: string = 'testnet'): EvmAdapter {
  const key = `${chainName}:${network}`;
  if (evmAdapters.has(key)) {
    return evmAdapters.get(key)!;
  }

  const chainConfig = config.getChain(chainName);
  if (!chainConfig) {
    throw new Error(`Unsupported chain: ${chainName}`);
  }

  const rpcUrl = chainConfig.rpc[network];
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for ${chainName} ${network}`);
  }

  const contracts = chainConfig.contracts?.[network];
  if (!contracts) {
    throw new Error(`No contracts configured for ${chainName} ${network}`);
  }

  const adapter = new EvmAdapter(rpcUrl, contracts.coreBridge, contracts.tokenBridge);
  evmAdapters.set(key, adapter);
  return adapter;
}

/**
 * Get or create a Solana adapter for the given network.
 */
function getSolanaAdapter(network: string = 'testnet'): SolanaAdapter {
  const key = `solana:${network}`;
  if (solanaAdapters.has(key)) {
    return solanaAdapters.get(key)!;
  }

  const chainConfig = config.getChain('solana');
  if (!chainConfig) {
    throw new Error('Solana chain not configured');
  }

  const rpcUrl = chainConfig.rpc[network];
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for Solana ${network}`);
  }

  const contracts = chainConfig.contracts?.[network];
  if (!contracts) {
    throw new Error(`No contracts configured for Solana ${network}`);
  }

  const adapter = new SolanaAdapter(rpcUrl, contracts.coreBridge, contracts.tokenBridge);
  solanaAdapters.set(key, adapter);
  return adapter;
}

/**
 * Get or create the VAA verifier.
 */
function getVAAVerifier(): VAAVerifier {
  if (vaaVerifier) {
    return vaaVerifier;
  }

  const guardianRpc = process.env.WORMHOLE_GUARDIAN_RPC;
  if (!guardianRpc) {
    throw new Error(
      'WORMHOLE_GUARDIAN_RPC environment variable required for VAA verification'
    );
  }

  vaaVerifier = new VAAVerifier(guardianRpc);
  return vaaVerifier;
}

/**
 * Get the health status of the Wormhole bridge integration.
 */
export function getHealthStatus() {
  const requiredVars = config.REQUIRED_ENV_VARS || [
    'WORMHOLE_EVM_RPC_URL',
    'WORMHOLE_SOLANA_RPC_URL',
    'WORMHOLE_GUARDIAN_RPC',
  ];

  const configuredVars = Object.fromEntries(
    requiredVars.map((v: string) => [v, !!process.env[v]])
  );

  const allConfigured = Object.values(configuredVars).every(Boolean);

  return {
    status: allConfigured ? 'configured' : 'partially_configured',
    message: allConfigured
      ? 'Wormhole bridge is configured and ready'
      : 'Some required environment variables are missing',
    requiredEnvVars: requiredVars,
    configuredVars,
    activeAdapters: {
      evm: evmAdapters.size,
      solana: solanaAdapters.size,
    },
  };
}

/**
 * Initialize the Wormhole bridge service.
 * Creates database tables and validates configuration.
 */
export async function initialize(): Promise<boolean> {
  try {
    logger.info('Initializing Wormhole bridge service');
    await createTables();
    logger.info('Wormhole bridge initialized successfully');
    return true;
  } catch (error) {
    logger.error('Error initializing Wormhole bridge service:', error);
    return false;
  }
}

/**
 * Initialize connection to a Wormhole network.
 * Creates adapter instances for the specified network environment.
 */
export async function initializeConnection(network: string) {
  config.validateEnvVars();

  // Initialize EVM adapter for ethereum
  const evmAdapter = getEvmAdapter('ethereum', network);

  // Initialize Solana adapter
  const solanaAdapter = getSolanaAdapter(network);

  // Initialize VAA verifier
  const verifier = getVAAVerifier();

  logger.info(`Wormhole connection initialized for ${network}`);

  return {
    network,
    evmAdapter,
    solanaAdapter,
    vaaVerifier: verifier,
    status: 'connected',
  };
}

/**
 * Transfer tokens across chains via Wormhole.
 * Submits the transfer as a BullMQ job for async processing.
 */
export async function transferTokens(params: {
  sourceChain: string;
  targetChain: string;
  token: string;
  amount: string;
  sender: string;
  recipient: string;
  network?: string;
}): Promise<{ transferId: string; jobId: string; status: string }> {
  const transferId = uuidv4();
  const network = params.network || 'testnet';

  // Record transfer in DB
  await pool.query(
    `INSERT INTO wormhole_transfers
     (transfer_id, source_chain, target_chain, token, amount, sender, recipient, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      transferId,
      params.sourceChain,
      params.targetChain,
      params.token,
      params.amount,
      params.sender,
      params.recipient,
      'queued',
      new Date(),
    ]
  );

  // Submit to BullMQ queue
  const jobData: CrossChainJobData = {
    protocol: 'wormhole',
    sourceChain: params.sourceChain,
    destinationChain: params.targetChain,
    messageType: 'token_transfer',
    payload: JSON.stringify({
      transferId,
      token: params.token,
      amount: params.amount,
      sender: params.sender,
      recipient: params.recipient,
      network,
    }),
    senderAddress: params.sender,
    recipient: params.recipient,
  };

  const jobId = await crossChainQueueService.addJob('wormhole', jobData);

  logger.info(`Wormhole token transfer queued: ${transferId} (job: ${jobId})`);

  return { transferId, jobId, status: 'queued' };
}

/**
 * Send a message across chains via Wormhole.
 * Submits the message as a BullMQ job for async processing.
 */
export async function sendMessage(params: {
  sourceChain: string;
  targetChain: string;
  sender: string;
  recipient: string;
  payload: any;
  network?: string;
}): Promise<{ messageId: string; jobId: string; status: string }> {
  const messageId = uuidv4();

  await pool.query(
    `INSERT INTO wormhole_messages
     (message_id, source_chain, target_chain, sender, recipient, payload, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      messageId,
      params.sourceChain,
      params.targetChain,
      params.sender,
      params.recipient,
      JSON.stringify(params.payload),
      'queued',
      new Date(),
    ]
  );

  const jobData: CrossChainJobData = {
    protocol: 'wormhole',
    sourceChain: params.sourceChain,
    destinationChain: params.targetChain,
    messageType: 'message',
    payload: JSON.stringify({ messageId, ...params }),
    senderAddress: params.sender,
    recipient: params.recipient,
  };

  const jobId = await crossChainQueueService.addJob('wormhole', jobData);

  logger.info(`Wormhole message queued: ${messageId} (job: ${jobId})`);

  return { messageId, jobId, status: 'queued' };
}

/**
 * Transfer an NFT across chains via Wormhole.
 * Submits the transfer as a BullMQ job for async processing.
 */
export async function transferNFT(params: {
  sourceChain: string;
  targetChain: string;
  tokenId: string;
  tokenAddress: string;
  uri?: string;
  sender: string;
  recipient: string;
  network?: string;
}): Promise<{ transferId: string; jobId: string; status: string }> {
  const transferId = uuidv4();

  await pool.query(
    `INSERT INTO wormhole_nft_transfers
     (transfer_id, source_chain, target_chain, token_id, token_address, uri, sender, recipient, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      transferId,
      params.sourceChain,
      params.targetChain,
      params.tokenId,
      params.tokenAddress,
      params.uri || '',
      params.sender,
      params.recipient,
      'queued',
      new Date(),
    ]
  );

  const jobData: CrossChainJobData = {
    protocol: 'wormhole',
    sourceChain: params.sourceChain,
    destinationChain: params.targetChain,
    messageType: 'nft_transfer',
    payload: JSON.stringify({ transferId, ...params }),
    senderAddress: params.sender,
    recipient: params.recipient,
  };

  const jobId = await crossChainQueueService.addJob('wormhole', jobData);

  logger.info(`Wormhole NFT transfer queued: ${transferId} (job: ${jobId})`);

  return { transferId, jobId, status: 'queued' };
}

/**
 * Get the status of a VAA from the Guardian network.
 */
export async function getVAAStatus(params: {
  emitterChain: number;
  emitterAddress: string;
  sequence: bigint;
}): Promise<{ available: boolean; vaa?: ParsedVAA }> {
  const verifier = getVAAVerifier();

  try {
    const vaaBytes = await verifier.fetchVAA(
      params.emitterChain,
      params.emitterAddress,
      params.sequence,
      5000 // 5s timeout for status check
    );

    const parsed = verifier.parseVAA(vaaBytes);
    return { available: true, vaa: parsed };
  } catch {
    return { available: false };
  }
}

/**
 * Fetch and process a VAA from the Guardian network.
 */
export async function processVAA(params: {
  emitterChain: number;
  emitterAddress: string;
  sequence: bigint;
  timeoutMs?: number;
}): Promise<{ vaa: ParsedVAA; raw: Uint8Array; verified: boolean }> {
  const verifier = getVAAVerifier();

  // Replay protection: check if this VAA has already been processed
  const existing = await pool.query(
    `SELECT id FROM wormhole_vaas
     WHERE emitter_chain = $1 AND emitter_address = $2 AND sequence = $3`,
    [params.emitterChain, params.emitterAddress, params.sequence.toString()]
  );
  if (existing.rows.length > 0) {
    throw new Error(
      `VAA already processed: chain=${params.emitterChain} emitter=${params.emitterAddress} seq=${params.sequence}`
    );
  }

  const vaaBytes = await verifier.fetchVAA(
    params.emitterChain,
    params.emitterAddress,
    params.sequence,
    params.timeoutMs || 120_000
  );

  const vaa = verifier.parseVAA(vaaBytes);
  const verified = verifier.verifySignatures(vaa);

  // Record in DB (unique constraint on emitter_chain + emitter_address + sequence
  // provides additional protection against concurrent processing)
  await pool.query(
    `INSERT INTO wormhole_vaas
     (vaa_id, status, emitter_chain, emitter_address, sequence, timestamp, guardian_signatures, quorum_reached, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      uuidv4(),
      verified ? 'verified' : 'unverified',
      vaa.emitterChain,
      vaa.emitterAddress,
      vaa.sequence.toString(),
      new Date(vaa.timestamp * 1000),
      vaa.signatures.length,
      verified,
      Buffer.from(vaa.payload).toString('hex'),
    ]
  );

  return { vaa, raw: vaaBytes, verified };
}

/**
 * Estimate the fee for a cross-chain operation.
 */
export async function estimateFee(params: {
  sourceChain: string;
  targetChain: string;
  operationType: string;
  token?: string;
  amount?: string;
}) {
  const { sourceChain, targetChain, operationType, token, amount } = params;

  if (!sourceChain || !targetChain || !operationType) {
    throw new Error('Missing required parameters for fee estimation');
  }

  const feeConfig = config.getFee(operationType);
  if (!feeConfig) {
    throw new Error(`Unsupported operation type: ${operationType}`);
  }

  const sourceChainConfig = config.getChain(sourceChain);
  if (!sourceChainConfig) {
    throw new Error(`Unsupported source chain: ${sourceChain}`);
  }

  let totalFee: number;
  if (operationType === 'TOKEN_TRANSFER' && token && amount) {
    const baseFee = feeConfig.base;
    const percentageFee = parseFloat(amount) * feeConfig.percentage;
    totalFee = Math.max(feeConfig.minFee, Math.min(feeConfig.maxFee, baseFee + percentageFee));
  } else if (operationType === 'NFT_TRANSFER') {
    totalFee = feeConfig.base;
  } else if (operationType === 'MESSAGE') {
    totalFee = feeConfig.base;
  } else {
    throw new Error(`Invalid operation type or missing parameters: ${operationType}`);
  }

  return {
    sourceChain,
    targetChain,
    operationType,
    baseFee: feeConfig.base,
    percentageFee: operationType === 'TOKEN_TRANSFER' ? feeConfig.percentage : 0,
    totalFee: totalFee.toFixed(6),
    nativeCurrency: sourceChainConfig.nativeCurrency,
  };
}

/**
 * List recent transfers across all chains.
 */
export async function listTransfers(params: {
  limit?: number;
  offset?: number;
  status?: string;
  sourceChain?: string;
  targetChain?: string;
} = {}) {
  const { limit = 10, offset = 0, status, sourceChain, targetChain } = params;

  const conditions = ['1=1'];
  const queryParams: any[] = [];

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

  queryParams.push(limit);
  queryParams.push(offset);

  const result = await pool.query(
    `SELECT * FROM wormhole_transfers
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${queryParams.length - 1}
     OFFSET $${queryParams.length}`,
    queryParams
  );

  return result.rows.map((row: any) => ({
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
}

/**
 * Create the necessary database tables for Wormhole integration.
 */
async function createTables() {
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
      parsed JSONB,
      UNIQUE (emitter_chain, emitter_address, sequence)
    )
  `);
}

// Default export for backward compatibility
export default {
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
