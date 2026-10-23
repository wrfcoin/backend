import crypto from 'crypto';
import { ethers } from 'ethers';

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export interface InboundTransferRequest {
  emitterChain: number;
  emitterAddress: string;
  sequence: string | number;
  sourceTxHash?: string;
  sourceChain?: string;
  targetChain?: string;
  token?: string;
  amount?: string;
  recipient: string;
}

export interface OutboundTransferRequest {
  sender: string;
  recipient: string;
  amount: string;
  token?: string;
  sourceChain?: string;
  targetChain?: string;
  burnTxHash?: string;
}

type WormholeTransferRecord = {
  transferId: string;
  direction: 'inbound' | 'outbound';
  status: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
};

const transferStore = new Map<string, WormholeTransferRecord>();
export const MAX_IN_MEMORY_TRANSFERS = 5000;

function rememberTransfer(transferId: string, record: WormholeTransferRecord) {
  transferStore.set(transferId, record);
  // Map iterates in insertion order, so the first key is the oldest entry.
  while (transferStore.size > MAX_IN_MEMORY_TRANSFERS) {
    const oldest = transferStore.keys().next().value;
    if (oldest === undefined) break;
    transferStore.delete(oldest);
  }
}

/** Raw-handler Wormhole routes stay off unless an upstream operator API is configured. */
export function isWormholeBridgeEnabled(): boolean {
  return (process.env.WORMHOLE_OPERATOR_API_URL || '').trim().length > 0;
}

export function __wormholeTransferStoreSize(): number {
  return transferStore.size;
}
const processedVaas = new Map<string, string>();

function defaultDb(): DbExecutor {
  const { executeQuery } = require('../../database/db');
  return { execute: (sql: string, params?: unknown[]) => executeQuery(sql, params) };
}

function isMockMode(): boolean {
  return (process.env.WORMHOLE_TEST_MODE || '').toLowerCase() === 'mock';
}

function buildVaaReplayKey(req: InboundTransferRequest): string {
  return `${req.emitterChain}:${req.emitterAddress.toLowerCase()}:${String(req.sequence)}`;
}

async function verifyVaaAvailability(req: InboundTransferRequest): Promise<boolean> {
  if (isMockMode()) {
    return true;
  }

  const guardianRpc = process.env.WORMHOLE_GUARDIAN_RPC;
  if (!guardianRpc) {
    throw new Error('WORMHOLE_GUARDIAN_RPC is required when not in mock mode');
  }

  const normalizedEmitter = req.emitterAddress.replace(/^0x/, '').padStart(64, '0');
  const url = `${guardianRpc.replace(/\/$/, '')}/v1/signed_vaa/${req.emitterChain}/${normalizedEmitter}/${req.sequence}`;
  const response = await fetch(url);
  return response.ok;
}

async function persistInboundBestEffort(
  db: DbExecutor,
  transferId: string,
  req: InboundTransferRequest,
  status: string
) {
  try {
    await db.execute(
      `INSERT INTO wormhole_transfers
        (transfer_id, source_chain, target_chain, token, amount, sender, recipient, status, created_at, source_tx_hash, emitter_chain, emitter_address, sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12)
       ON CONFLICT (emitter_chain, emitter_address, sequence)
       DO UPDATE SET
        transfer_id = EXCLUDED.transfer_id,
        source_chain = EXCLUDED.source_chain,
        target_chain = EXCLUDED.target_chain,
        token = EXCLUDED.token,
        amount = EXCLUDED.amount,
        sender = EXCLUDED.sender,
        recipient = EXCLUDED.recipient,
        status = EXCLUDED.status,
        source_tx_hash = EXCLUDED.source_tx_hash`,
      [
        transferId,
        req.sourceChain || 'sepolia',
        req.targetChain || 'wrfcoin-testnet',
        req.token || 'WRF',
        req.amount || '0',
        req.emitterAddress,
        req.recipient,
        status,
        req.sourceTxHash || null,
        req.emitterChain,
        req.emitterAddress.toLowerCase(),
        String(req.sequence),
      ]
    );
  } catch {
    // Best effort only for local testnet/dev mode
  }
}

async function reserveInboundReplayInDb(
  db: DbExecutor,
  transferId: string,
  req: InboundTransferRequest
): Promise<boolean> {
  try {
    const result = await db.execute(
      `INSERT INTO wormhole_transfers
        (transfer_id, source_chain, target_chain, token, amount, sender, recipient, status, created_at, source_tx_hash, emitter_chain, emitter_address, sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12)
       ON CONFLICT (emitter_chain, emitter_address, sequence) DO NOTHING
       RETURNING transfer_id`,
      [
        transferId,
        req.sourceChain || 'sepolia',
        req.targetChain || 'wrfcoin-testnet',
        req.token || 'WRF',
        req.amount || '0',
        req.emitterAddress,
        req.recipient,
        'vaa_received',
        req.sourceTxHash || null,
        req.emitterChain,
        req.emitterAddress.toLowerCase(),
        String(req.sequence),
      ]
    );
    if (result.rows.length > 0) {
      return true;
    }

    // Conflicts can return zero rows; confirm whether replay already exists.
    const existing = await db.execute(
      `SELECT 1
       FROM wormhole_transfers
       WHERE emitter_chain = $1
         AND emitter_address = $2
         AND sequence = $3
       LIMIT 1`,
      [req.emitterChain, req.emitterAddress.toLowerCase(), String(req.sequence)]
    );
    return existing.rows.length === 0;
  } catch {
    // Fallback for environments where table/index may not be migrated yet.
    try {
      const existing = await db.execute(
        `SELECT 1
         FROM wormhole_transfers
         WHERE emitter_chain = $1
           AND emitter_address = $2
           AND sequence = $3
         LIMIT 1`,
        [req.emitterChain, req.emitterAddress.toLowerCase(), String(req.sequence)]
      );
      return existing.rows.length === 0;
    } catch {
      return true;
    }
  }
}

async function persistOutboundBestEffort(db: DbExecutor, transferId: string, req: OutboundTransferRequest) {
  try {
    const outboundReplayAddress = `outbound:${transferId}`;
    await db.execute(
      `INSERT INTO wormhole_transfers
        (transfer_id, source_chain, target_chain, token, amount, sender, recipient, status, created_at, source_tx_hash, emitter_chain, emitter_address, sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12)`,
      [
        transferId,
        req.sourceChain || 'wrfcoin-testnet',
        req.targetChain || 'sepolia',
        req.token || 'WRF',
        req.amount,
        req.sender,
        req.recipient,
        'attested',
        req.burnTxHash || null,
        -1,
        outboundReplayAddress,
        0,
      ]
    );
  } catch {
    // Best effort only for local testnet/dev mode
  }
}

function createOperatorUnlockIntent(req: InboundTransferRequest) {
  return {
    type: 'BridgeUnlock',
    sourceChain: req.sourceChain || 'sepolia',
    targetChain: req.targetChain || 'wrfcoin-testnet',
    recipient: req.recipient,
    amount: req.amount || '0',
    token: req.token || 'WRF',
    sourceTxHash: req.sourceTxHash || null,
    sequence: String(req.sequence),
  };
}

async function submitOperatorUnlockIntent(intent: Record<string, unknown>) {
  const endpoint = process.env.WORMHOLE_OPERATOR_API_URL;
  if (!endpoint || isMockMode()) {
    return {
      submitted: true,
      transport: 'mock',
      reference: `mock-unlock-${Date.now()}`,
    };
  }

  const token = process.env.WRFCOIN_OPERATOR_TOKEN;
  if (!token) {
    throw new Error(
      'WRFCOIN_OPERATOR_TOKEN is not set — refusing to submit unauthenticated unlock intent to core4'
    );
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(intent),
  });
  const body = await response.text();
  return {
    submitted: response.ok,
    transport: 'http',
    statusCode: response.status,
    body,
  };
}

function buildOutboundAttestation(req: OutboundTransferRequest) {
  const payload = {
    sourceChain: req.sourceChain || 'wrfcoin-testnet',
    targetChain: req.targetChain || 'sepolia',
    sender: req.sender,
    recipient: req.recipient,
    amount: req.amount,
    token: req.token || 'WRF',
    burnTxHash: req.burnTxHash || null,
    issuedAt: Math.floor(Date.now() / 1000),
  };

  const digest = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)));
  const privateKey = process.env.BRIDGE_ATTESTATION_PRIVATE_KEY || process.env.SPONSOR_PRIVATE_KEY;

  let signature = `0x${crypto.randomBytes(65).toString('hex')}`;
  let signerAddress: string | null = null;
  if (privateKey) {
    const signer = new ethers.Wallet(privateKey);
    signerAddress = signer.address;
    signature = signer.signingKey.sign(digest).serialized;
  }

  return {
    payload,
    digest,
    signature,
    signer: signerAddress,
  };
}

export async function processInboundTransfer(
  req: InboundTransferRequest,
  db?: DbExecutor
): Promise<WormholeTransferRecord> {
  const executor = db ?? defaultDb();
  const transferId = `wormhole-in-${crypto.randomUUID()}`;
  const reserved = await reserveInboundReplayInDb(executor, transferId, req);
  if (!reserved) {
    throw new Error(
      `VAA replay detected for key=${req.emitterChain}:${req.emitterAddress.toLowerCase()}:${String(req.sequence)}`
    );
  }

  const replayKey = buildVaaReplayKey(req);
  if (processedVaas.has(replayKey)) {
    throw new Error(`VAA replay detected for key=${replayKey}`);
  }

  const vaaAvailable = await verifyVaaAvailability(req);
  if (!vaaAvailable) {
    throw new Error('VAA not available yet');
  }

  const intent = createOperatorUnlockIntent(req);
  const operatorResult = await submitOperatorUnlockIntent(intent);

  const now = new Date().toISOString();
  const record: WormholeTransferRecord = {
    transferId,
    direction: 'inbound',
    status: operatorResult.submitted ? 'mint_submitted' : 'mint_submission_failed',
    createdAt: now,
    updatedAt: now,
    data: {
      replayKey,
      operatorResult,
      intent,
      request: req,
    },
  };

  rememberTransfer(transferId, record);
  processedVaas.set(replayKey, transferId);
  await persistInboundBestEffort(executor, transferId, req, record.status);
  return record;
}

export async function initiateOutboundTransfer(
  req: OutboundTransferRequest,
  db?: DbExecutor
): Promise<WormholeTransferRecord> {
  const executor = db ?? defaultDb();
  const attestation = buildOutboundAttestation(req);
  const transferId = `wormhole-out-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const record: WormholeTransferRecord = {
    transferId,
    direction: 'outbound',
    status: 'attested',
    createdAt: now,
    updatedAt: now,
    data: {
      request: req,
      attestation,
    },
  };

  rememberTransfer(transferId, record);
  await persistOutboundBestEffort(executor, transferId, req);
  return record;
}

export async function getWormholeTransfer(
  transferId: string,
  db?: DbExecutor
): Promise<WormholeTransferRecord | null> {
  if (transferStore.has(transferId)) {
    return transferStore.get(transferId)!;
  }

  const executor = db ?? defaultDb();
  try {
    const result = await executor.execute(
      `SELECT transfer_id, source_chain, target_chain, token, amount, sender, recipient, status, created_at
       FROM wormhole_transfers WHERE transfer_id = $1 LIMIT 1`,
      [transferId]
    );
    if (!result.rows.length) {
      return null;
    }
    const row = result.rows[0];
    return {
      transferId: String(row.transfer_id),
      direction: String(row.source_chain || '').toLowerCase().includes('wrfcoin')
        ? 'outbound'
        : 'inbound',
      status: String(row.status || 'unknown'),
      createdAt: String(row.created_at || new Date().toISOString()),
      updatedAt: String(row.created_at || new Date().toISOString()),
      data: {
        sourceChain: row.source_chain,
        targetChain: row.target_chain,
        token: row.token,
        amount: row.amount,
        sender: row.sender,
        recipient: row.recipient,
      },
    };
  } catch {
    return null;
  }
}

export function __resetWormholeTransferTestState() {
  transferStore.clear();
  processedVaas.clear();
}
