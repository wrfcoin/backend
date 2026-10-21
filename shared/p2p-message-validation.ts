/**
 * P2P Message Validation System
 * Integrates with existing message authentication and replay prevention
 *
 * SECURITY: Task 100.10 - Message validation for P2P networks
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { MessageAuthenticator, AuthenticatedMessage } from './message-authentication.js';
import { ReplayPreventionService, MessageMetadata } from './replay-prevention.js';
import { MessageOriginVerifier, OriginVerificationResult } from './message-origin.js';

export interface P2PMessage {
  messageId: string;
  senderId: string;
  payload: Buffer;
  signature: Buffer;
  sequence: number;
  timestamp: number;
  nonce: string;
  hmac?: string;
  messageType: 'data' | 'control' | 'routing' | 'gossip';
}

export interface ValidationResult {
  valid: boolean;
  checks: {
    signature: boolean;
    origin: boolean;
    replay: boolean;
    schema: boolean;
    hmac: boolean;
  };
  reason?: string;
  metadata?: any;
}

export class P2PMessageValidator extends EventEmitter {
  constructor(
    private messageAuth: MessageAuthenticator,
    private replayPrevention: ReplayPreventionService,
    private originVerifier: MessageOriginVerifier
  ) {
    super();
  }

  async validateMessage(message: P2PMessage): Promise<ValidationResult> {
    const checks = {
      signature: false,
      origin: false,
      replay: false,
      schema: false,
      hmac: false,
    };

    // Schema validation
    checks.schema = this.validateSchema(message);
    if (!checks.schema) {
      return { valid: false, checks, reason: 'Invalid message schema' };
    }

    // Origin verification
    const originResult = await this.originVerifier.verifyOrigin(
      message.senderId,
      message.signature,
      message.payload
    );
    checks.origin = originResult.verified;
    if (!checks.origin) {
      return { valid: false, checks, reason: 'Origin verification failed' };
    }

    // Replay prevention
    const metadata: MessageMetadata = {
      messageId: message.messageId,
      sequence: message.sequence,
      timestamp: message.timestamp,
      senderId: message.senderId,
      messageHash: crypto.createHash('sha256').update(message.payload).digest('hex'),
    };
    const replayCheck = this.replayPrevention.validateMessage(metadata);
    checks.replay = replayCheck.valid;
    if (!checks.replay) {
      return { valid: false, checks, reason: replayCheck.reason };
    }

    // HMAC verification if present
    if (message.hmac) {
      const messageData = Buffer.concat([
        message.payload,
        Buffer.from(message.messageId),
        Buffer.from(message.timestamp.toString()),
        Buffer.from(message.nonce),
      ]);
      checks.hmac = this.messageAuth.verifyHMAC(messageData, message.hmac, message.senderId);
      if (!checks.hmac) {
        return { valid: false, checks, reason: 'HMAC verification failed' };
      }
    } else {
      checks.hmac = true;
    }

    checks.signature = true;

    this.emit('messageValidated', { messageId: message.messageId, senderId: message.senderId });

    return {
      valid: true,
      checks,
      metadata: originResult,
    };
  }

  private validateSchema(message: P2PMessage): boolean {
    return !!(
      message.messageId &&
      message.senderId &&
      message.payload &&
      message.signature &&
      typeof message.sequence === 'number' &&
      typeof message.timestamp === 'number' &&
      message.nonce &&
      message.messageType
    );
  }

  shutdown(): void {
    this.emit('shutdown');
  }
}
