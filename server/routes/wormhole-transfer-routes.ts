import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import {
  getWormholeTransfer,
  initiateOutboundTransfer,
  processInboundTransfer,
} from '../services/wormhole-transfer-service.js';

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function defaultDb(): DbExecutor {
  // Lazy dynamic import — avoids "require is not defined" in ESM bundles (#268)
  let cachedExecuteQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null = null;
  return {
    execute: async (sql: string, params?: unknown[]) => {
      if (!cachedExecuteQuery) {
        const mod = await import('../../database/index.js');
        cachedExecuteQuery = mod.executeQuery;
      }
      return cachedExecuteQuery!(sql, params);
    },
  };
}

function isValidAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}



export function createWormholeTransferRouter(db?: DbExecutor): express.Router {
  const router = express.Router();

  const { transferLimiter } = require('../../middleware/rateLimiting');

  // All Wormhole bridge operations require authentication (#231)
  router.use(authenticateJWT);
  // All Wormhole operations are financial — tight rate limit (#237)
  router.use(transferLimiter);

  router.post('/inbound/process', async (req, res) => {
    const body = req.body ?? {};
    if (
      !Number.isInteger(body?.emitterChain) ||
      !body?.emitterAddress ||
      body?.sequence === undefined ||
      !isValidAddress(body?.recipient)
    ) {
      return res.status(400).json({
        error: 'emitterChain, emitterAddress, sequence, and recipient (0x...) are required',
      });
    }

    try {
      const transfer = await processInboundTransfer(
        {
          emitterChain: Number(body.emitterChain),
          emitterAddress: String(body.emitterAddress),
          sequence: String(body.sequence),
          sourceTxHash: body.sourceTxHash ? String(body.sourceTxHash) : undefined,
          sourceChain: body.sourceChain ? String(body.sourceChain) : undefined,
          targetChain: body.targetChain ? String(body.targetChain) : undefined,
          token: body.token ? String(body.token) : undefined,
          amount: body.amount ? String(body.amount) : undefined,
          recipient: String(body.recipient),
        },
        db ?? defaultDb()
      );
      return res.status(200).json(transfer);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to process inbound transfer' });
    }
  });

  router.post('/outbound/initiate', async (req, res) => {
    const body = req.body ?? {};
    if (!isValidAddress(body?.sender) || !isValidAddress(body?.recipient) || !body?.amount) {
      return res.status(400).json({ error: 'sender, recipient (0x...), and amount are required' });
    }

    try {
      const transfer = await initiateOutboundTransfer(
        {
          sender: String(body.sender),
          recipient: String(body.recipient),
          amount: String(body.amount),
          token: body.token ? String(body.token) : undefined,
          sourceChain: body.sourceChain ? String(body.sourceChain) : undefined,
          targetChain: body.targetChain ? String(body.targetChain) : undefined,
          burnTxHash: body.burnTxHash ? String(body.burnTxHash) : undefined,
        },
        db ?? defaultDb()
      );
      return res.status(200).json(transfer);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to initiate outbound transfer' });
    }
  });

  router.get('/transfers/:transferId', async (req, res) => {
    const transferId = req.params.transferId;
    if (!transferId) {
      return res.status(400).json({ error: 'transferId is required' });
    }

    const transfer = await getWormholeTransfer(transferId, db ?? defaultDb());
    if (!transfer) {
      return res.status(404).json({ error: 'Transfer not found' });
    }
    return res.status(200).json(transfer);
  });

  return router;
}

export default createWormholeTransferRouter();
