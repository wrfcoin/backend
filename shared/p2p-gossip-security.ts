/**
 * P2P Gossip Protocol Security
 * Secure gossip with message origin verification
 *
 * SECURITY: Task 100.10 - Secure gossip protocol
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

export interface GossipMessage {
  messageId: string;
  originator: string;
  payload: any;
  hopCount: number;
  timestamp: Date;
  signature: Buffer;
  path: string[]; // Peer IDs in propagation path
}

export interface GossipConfig {
  maxHops: number;
  fanout: number;
  gossipInterval: number;
  maxMessageAge: number;
}

export class P2PGossipSecurityService extends EventEmitter {
  private seenMessages: Map<string, Date> = new Map();
  private messageOriginators: Map<string, Set<string>> = new Map();
  private readonly config: GossipConfig;

  private static readonly DEFAULT_CONFIG: GossipConfig = {
    maxHops: 5,
    fanout: 3,
    gossipInterval: 1000,
    maxMessageAge: 300000, // 5 minutes
  };

  constructor(config?: Partial<GossipConfig>) {
    super();
    this.config = { ...P2PGossipSecurityService.DEFAULT_CONFIG, ...config };
  }

  async validateGossipMessage(
    message: GossipMessage,
    originatorPublicKey: Buffer
  ): Promise<boolean> {
    // Check if message already seen
    if (this.seenMessages.has(message.messageId)) {
      this.emit('duplicateMessage', { messageId: message.messageId });
      return false;
    }

    // Check message age
    const age = Date.now() - message.timestamp.getTime();
    if (age > this.config.maxMessageAge) {
      this.emit('expiredMessage', { messageId: message.messageId, age });
      return false;
    }

    // Check hop count
    if (message.hopCount > this.config.maxHops) {
      this.emit('maxHopsExceeded', { messageId: message.messageId, hops: message.hopCount });
      return false;
    }

    // Verify signature
    const data = Buffer.concat([
      Buffer.from(message.messageId),
      Buffer.from(message.originator),
      Buffer.from(JSON.stringify(message.payload)),
      Buffer.from(message.timestamp.toISOString()),
    ]);

    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    verify.end();

    const publicKeyObject = crypto.createPublicKey({
      key: originatorPublicKey,
      format: 'der',
      type: 'spki',
    });

    const isValid = verify.verify(publicKeyObject, message.signature);

    if (isValid) {
      this.seenMessages.set(message.messageId, new Date());

      const originators = this.messageOriginators.get(message.originator) || new Set();
      originators.add(message.messageId);
      this.messageOriginators.set(message.originator, originators);

      this.emit('messageValidated', { messageId: message.messageId });
    }

    return isValid;
  }

  selectGossipTargets(
    allPeers: string[],
    excludePeers: string[]
  ): string[] {
    const available = allPeers.filter(p => !excludePeers.includes(p));
    // Fisher-Yates shuffle with CSPRNG to prevent gossip routing bias (issue #478)
    const shuffled = [...available];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, this.config.fanout);
  }

  detectGossipAmplificationAttack(originator: string): boolean {
    const messages = this.messageOriginators.get(originator) || new Set();
    const recentMessages = Array.from(messages).filter(msgId => {
      const seenTime = this.seenMessages.get(msgId);
      return seenTime && Date.now() - seenTime.getTime() < 60000; // Last minute
    });

    return recentMessages.length > 100; // Suspicious if > 100 messages per minute
  }

  cleanup(): void {
    const now = Date.now();
    for (const [messageId, seenTime] of this.seenMessages.entries()) {
      if (now - seenTime.getTime() > this.config.maxMessageAge) {
        this.seenMessages.delete(messageId);
      }
    }
  }

  shutdown(): void {
    this.seenMessages.clear();
    this.messageOriginators.clear();
    this.emit('shutdown');
  }
}
