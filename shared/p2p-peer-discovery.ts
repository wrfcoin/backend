/**
 * P2P Peer Discovery System
 * Secure peer discovery with verified introductions
 *
 * SECURITY: Task 100.10 - Secure peer discovery
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

export interface PeerInfo {
  peerId: string;
  addresses: string[];
  publicKey: Buffer;
  capabilities: string[];
  version: string;
  introducedBy?: string;
  firstSeen: Date;
  lastSeen: Date;
}

export interface PeerIntroduction {
  introducerPeerId: string;
  newPeerId: string;
  newPeerInfo: PeerInfo;
  timestamp: Date;
  signature: Buffer;
}

export class P2PeerDiscoveryService extends EventEmitter {
  private knownPeers: Map<string, PeerInfo> = new Map();
  private bootstrapNodes: Map<string, PeerInfo> = new Map();
  private introducers: Map<string, Set<string>> = new Map(); // introducer -> introduced peers

  registerBootstrapNode(peer: PeerInfo): void {
    this.bootstrapNodes.set(peer.peerId, peer);
    this.emit('bootstrapNodeRegistered', { peerId: peer.peerId });
  }

  async verifyPeerIntroduction(
    introduction: PeerIntroduction,
    introducerPublicKey: Buffer
  ): Promise<boolean> {
    const data = Buffer.concat([
      Buffer.from(introduction.introducerPeerId),
      Buffer.from(introduction.newPeerId),
      Buffer.from(JSON.stringify(introduction.newPeerInfo)),
      Buffer.from(introduction.timestamp.toISOString()),
    ]);

    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    verify.end();

    const publicKeyObject = crypto.createPublicKey({
      key: introducerPublicKey,
      format: 'der',
      type: 'spki',
    });

    const isValid = verify.verify(publicKeyObject, introduction.signature);

    if (isValid) {
      this.knownPeers.set(introduction.newPeerId, introduction.newPeerInfo);

      const introduced = this.introducers.get(introduction.introducerPeerId) || new Set();
      introduced.add(introduction.newPeerId);
      this.introducers.set(introduction.introducerPeerId, introduced);

      this.emit('peerDiscovered', { peerId: introduction.newPeerId });
    }

    return isValid;
  }

  async performHandshake(
    peerId: string,
    localCapabilities: string[]
  ): Promise<{
    success: boolean;
    sharedCapabilities: string[];
  }> {
    const peer = this.knownPeers.get(peerId);
    if (!peer) {
      return { success: false, sharedCapabilities: [] };
    }

    const sharedCapabilities = localCapabilities.filter(cap =>
      peer.capabilities.includes(cap)
    );

    if (sharedCapabilities.length === 0) {
      return { success: false, sharedCapabilities: [] };
    }

    peer.lastSeen = new Date();
    this.knownPeers.set(peerId, peer);

    this.emit('handshakeCompleted', { peerId, sharedCapabilities });

    return { success: true, sharedCapabilities };
  }

  detectSybilAttack(peerId: string): boolean {
    const introducer = this.getIntroducer(peerId);
    if (!introducer) return false;

    const introducedPeers = this.introducers.get(introducer) || new Set();
    return introducedPeers.size > 100; // Suspicious if one peer introduced > 100 peers
  }

  private getIntroducer(peerId: string): string | null {
    const peer = this.knownPeers.get(peerId);
    return peer?.introducedBy || null;
  }

  getKnownPeers(limit: number = 20): PeerInfo[] {
    return Array.from(this.knownPeers.values())
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
      .slice(0, limit);
  }

  shutdown(): void {
    this.knownPeers.clear();
    this.bootstrapNodes.clear();
    this.introducers.clear();
    this.emit('shutdown');
  }
}
