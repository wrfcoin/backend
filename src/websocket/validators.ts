import { z } from 'zod';

// Base message schema
const baseMessageSchema = z.object({
  type: z.string().min(1, 'Message type is required'),
  payload: z.any().optional(),
});

// Subscription message schema
const subscriptionSchema = z.object({
  type: z.literal('subscribe'),
  payload: z.object({
    channel: z.enum([
      'price_updates',
      'transaction_updates',
      'wallet_updates',
      'bridge_updates',
    ]),
    filters: z
      .object({
        walletAddress: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/)
          .optional(),
        tokenAddress: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/)
          .optional(),
        chainId: z.number().positive().optional(),
      })
      .optional(),
  }),
});

// Unsubscription message schema
const unsubscriptionSchema = z.object({
  type: z.literal('unsubscribe'),
  payload: z.object({
    channel: z.enum([
      'price_updates',
      'transaction_updates',
      'wallet_updates',
      'bridge_updates',
    ]),
  }),
});

// Wallet update message schema
const walletUpdateSchema = z.object({
  type: z.literal('wallet_update'),
  payload: z.object({
    address: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid wallet address format'),
    action: z.enum(['balance_check', 'transaction_history', 'token_balances']),
    parameters: z
      .object({
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
        tokenAddresses: z
          .array(z.string().regex(/^0x[a-fA-F0-9]{40}$/))
          .optional(),
      })
      .optional(),
  }),
});

// Transaction status message schema
const transactionStatusSchema = z.object({
  type: z.literal('transaction_status'),
  payload: z.object({
    transactionId: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transaction hash format'),
    chainId: z.number().positive().optional(),
  }),
});

// Bridge operation message schema
const bridgeOperationSchema = z.object({
  type: z.literal('bridge_operation'),
  payload: z.object({
    operation: z.enum(['transfer_status', 'estimate_fees', 'check_liquidity']),
    sourceChain: z.number().positive(),
    targetChain: z.number().positive(),
    tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    amount: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid amount format'),
    recipientAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  }),
});

// Mining operation message schema
const miningOperationSchema = z.object({
  type: z.literal('mining_operation'),
  payload: z.object({
    action: z.enum(['start', 'stop', 'status', 'stats']),
    minerAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
    poolAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  }),
});

// Governance message schema
const governanceSchema = z.object({
  type: z.literal('governance'),
  payload: z.object({
    action: z.enum(['proposal_status', 'vote', 'delegate']),
    proposalId: z.string().regex(/^\d+$/).optional(),
    vote: z.enum(['for', 'against', 'abstain']).optional(),
    delegateAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  }),
});

// Ping message schema
const pingSchema = z.object({
  type: z.literal('ping'),
  payload: z
    .object({
      timestamp: z.string().datetime().optional(),
    })
    .optional(),
});

// Combined message schema using discriminated union
const messageSchema = z.discriminatedUnion('type', [
  subscriptionSchema,
  unsubscriptionSchema,
  walletUpdateSchema,
  transactionStatusSchema,
  bridgeOperationSchema,
  miningOperationSchema,
  governanceSchema,
  pingSchema,
]);

export function parseWebSocketMessage(raw: Buffer | string) {
  try {
    return {
      success: true,
      error: null,
      data: JSON.parse(raw.toString()),
    };
  } catch {
    return {
      success: false,
      error: new Error('Invalid JSON format'),
      data: null,
    };
  }
}

export function validateMessage(data: any) {
  try {
    // First validate basic structure
    const baseResult = baseMessageSchema.safeParse(data);
    if (!baseResult.success) {
      return {
        success: false,
        error: baseResult.error,
        data: null,
      };
    }

    // Then validate specific message type
    const result = messageSchema.safeParse(data);
    return {
      success: result.success,
      error: result.success ? null : result.error,
      data: result.success ? result.data : null,
    };
  } catch (error) {
    return {
      success: false,
      error: new Error('Invalid JSON format'),
      data: null,
    };
  }
}

// Additional validation helpers
export function validateWalletAddress(address: string): boolean {
  const addressRegex = /^0x[a-fA-F0-9]{40}$/;
  return addressRegex.test(address);
}

export function validateTransactionHash(hash: string): boolean {
  const hashRegex = /^0x[a-fA-F0-9]{64}$/;
  return hashRegex.test(hash);
}

export function validateAmount(amount: string): boolean {
  const amountRegex = /^\d+(\.\d+)?$/;
  return amountRegex.test(amount) && parseFloat(amount) > 0;
}

export function validateChainId(chainId: number): boolean {
  const validChainIds = [1, 3, 4, 5, 42, 56, 97, 137, 80001, 250, 4002]; // Add your supported chain IDs
  return validChainIds.includes(chainId);
}

// Rate limiting validation
export function validateRateLimitingParams(type: string): {
  maxMessages: number;
  windowMs: number;
} {
  const rateLimits = {
    subscribe: { maxMessages: 10, windowMs: 60000 }, // 10 per minute
    unsubscribe: { maxMessages: 10, windowMs: 60000 }, // 10 per minute
    wallet_update: { maxMessages: 30, windowMs: 60000 }, // 30 per minute
    transaction_status: { maxMessages: 50, windowMs: 60000 }, // 50 per minute
    bridge_operation: { maxMessages: 10, windowMs: 60000 }, // 10 per minute (resource intensive)
    mining_operation: { maxMessages: 20, windowMs: 60000 }, // 20 per minute
    governance: { maxMessages: 5, windowMs: 60000 }, // 5 per minute (careful with voting)
    ping: { maxMessages: 60, windowMs: 60000 }, // 60 per minute
    default: { maxMessages: 20, windowMs: 60000 }, // Default rate limit
  };

  return rateLimits[type as keyof typeof rateLimits] || rateLimits.default;
}

// Content sanitization for sensitive operations
export function sanitizePayload(payload: any): any {
  if (typeof payload !== 'object' || payload === null) {
    return payload;
  }

  const sanitized = { ...payload };

  // Remove potentially dangerous fields
  delete sanitized.__proto__;
  delete sanitized.constructor;
  delete sanitized.prototype;

  // SECURITY: Sanitize string values using proper HTML entity encoding.
  // Previous regex-based approach was bypassable (e.g., nested tags, unicode
  // escapes, attribute injection). Now we encode all HTML-significant characters.
  Object.keys(sanitized).forEach(key => {
    if (typeof sanitized[key] === 'string') {
      // Encode HTML entities to prevent XSS - covers &, <, >, ", ', `, /
      sanitized[key] = sanitized[key]
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/`/g, '&#x60;')
        .replace(/\//g, '&#x2F;')
        .trim();
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizePayload(sanitized[key]);
    }
  });

  return sanitized;
}
