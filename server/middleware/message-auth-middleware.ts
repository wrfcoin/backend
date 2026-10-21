/**
 * Message Authentication Middleware
 * Express middleware for automatic message authentication
 *
 * SECURITY: Transparent message authentication for all protocols:
 * - Express middleware for HTTP message authentication
 * - WebSocket message authentication wrapper
 * - Automatic message signing/verification
 * - Performance monitoring and metrics
 */

import { Request, Response, NextFunction } from 'express';
import { MessageAuthenticator } from '../../shared/message-authentication.js';
import { MessageSigningService } from '../../shared/message-signing.js';
import { ReplayPreventionService } from '../../shared/replay-prevention.js';
import { MessageOriginVerifier } from '../../shared/message-origin.js';
import { MessageValidator } from '../../shared/message-validation.js';

export interface AuthenticatedRequest extends Request {
  messageAuth?: {
    verified: boolean;
    peerId: string;
    trustLevel: string;
    reputationScore: number;
  };
}

export class MessageAuthMiddleware {
  constructor(
    private authenticator: MessageAuthenticator,
    private signer: MessageSigningService,
    private replayPrevention: ReplayPreventionService,
    private originVerifier: MessageOriginVerifier,
    private validator: MessageValidator
  ) {}

  /**
   * Express middleware for message authentication
   */
  authenticate() {
    return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ) => {
      try {
        const messageId = req.headers['x-message-id'] as string;
        const signature = req.headers['x-message-signature'] as string;
        const peerId = req.headers['x-peer-id'] as string;
        const sequence = parseInt(req.headers['x-message-sequence'] as string, 10);
        const timestamp = parseInt(
          req.headers['x-message-timestamp'] as string, 10
        );

        if (!messageId || !signature || !peerId) {
          return res
            .status(401)
            .json({ error: 'Missing authentication headers' });
        }

        // Validate replay protection
        const replayCheck = this.replayPrevention.validateMessage({
          messageId,
          sequence,
          timestamp,
          senderId: peerId,
          messageHash: messageId,
        });

        if (!replayCheck.valid) {
          return res.status(403).json({ error: replayCheck.reason });
        }

        // Verify origin
        const messageBody = JSON.stringify(req.body);
        const originResult = await this.originVerifier.verifyOrigin(
          peerId,
          Buffer.from(signature, 'hex'),
          Buffer.from(messageBody)
        );

        if (!originResult.verified) {
          return res.status(403).json({ error: originResult.reason });
        }

        req.messageAuth = {
          verified: true,
          peerId: originResult.peerId,
          trustLevel: originResult.trustLevel,
          reputationScore: originResult.reputationScore,
        };

        next();
      } catch (error) {
        res.status(500).json({ error: 'Authentication failed' });
      }
    };
  }

  /**
   * WebSocket authentication wrapper
   */
  authenticateWebSocket() {
    return async (ws: any, req: any, next: Function) => {
      try {
        const query = new URLSearchParams(req.url.split('?')[1]);
        const peerId = query.get('peerId');
        const signature = query.get('signature');

        if (!peerId || !signature) {
          ws.close(1008, 'Missing authentication parameters');
          return;
        }

        const handshakeMessage = Buffer.from(`${peerId}:${Date.now()}`);
        const originResult = await this.originVerifier.verifyOrigin(
          peerId,
          Buffer.from(signature, 'hex'),
          handshakeMessage
        );

        if (!originResult.verified) {
          ws.close(1008, 'Authentication failed');
          return;
        }

        (ws as any).auth = {
          peerId: originResult.peerId,
          trustLevel: originResult.trustLevel,
        };

        next();
      } catch (error) {
        ws.close(1011, 'Internal error');
      }
    };
  }

  /**
   * Rate limiting based on reputation
   */
  rateLimit() {
    const requestCounts = new Map<
      string,
      { count: number; resetTime: number }
    >();

    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (!req.messageAuth) {
        return next();
      }

      const peerId = req.messageAuth.peerId;
      const now = Date.now();
      const windowMs = 60000; // 1 minute

      // Base rate limit adjusted by reputation
      const baseLimit = 100;
      const reputationMultiplier = req.messageAuth.reputationScore / 100;
      const limit = Math.floor(baseLimit * (1 + reputationMultiplier));

      let record = requestCounts.get(peerId);
      if (!record || now > record.resetTime) {
        record = { count: 0, resetTime: now + windowMs };
        requestCounts.set(peerId, record);
      }

      record.count++;

      if (record.count > limit) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }

      next();
    };
  }
}

export function createMessageAuthMiddleware(
  authenticator: MessageAuthenticator,
  signer: MessageSigningService,
  replayPrevention: ReplayPreventionService,
  originVerifier: MessageOriginVerifier,
  validator: MessageValidator
): MessageAuthMiddleware {
  return new MessageAuthMiddleware(
    authenticator,
    signer,
    replayPrevention,
    originVerifier,
    validator
  );
}
