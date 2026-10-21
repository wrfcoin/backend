/**
 * P2P Routing Security System
 * Prevents routing attacks and ensures path validation
 *
 * SECURITY: Task 100.10 - Routing security for P2P networks
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

export interface RoutingEntry {
  destination: string;
  nextHop: string;
  metric: number;
  timestamp: Date;
  signature?: Buffer;
}

export interface DHTEntry {
  key: string;
  value: any;
  publisher: string;
  timestamp: Date;
  ttl: number;
  signature: Buffer;
}

export class P2PRoutingSecurityService extends EventEmitter {
  private routingTable: Map<string, RoutingEntry> = new Map();
  private dhtStore: Map<string, DHTEntry> = new Map();
  private trustedPeers: Set<string> = new Set();

  async validateRoutingUpdate(entry: RoutingEntry, publicKey: Buffer): Promise<boolean> {
    if (!entry.signature) return false;

    const data = Buffer.concat([
      Buffer.from(entry.destination),
      Buffer.from(entry.nextHop),
      Buffer.from(entry.metric.toString()),
      Buffer.from(entry.timestamp.toISOString()),
    ]);

    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    verify.end();

    const publicKeyObject = crypto.createPublicKey({
      key: publicKey,
      format: 'der',
      type: 'spki',
    });

    const isValid = verify.verify(publicKeyObject, entry.signature);

    if (isValid) {
      this.routingTable.set(entry.destination, entry);
      this.emit('routingUpdated', { destination: entry.destination });
    }

    return isValid;
  }

  async validateDHTEntry(entry: DHTEntry, publicKey: Buffer): Promise<boolean> {
    const data = Buffer.concat([
      Buffer.from(entry.key),
      Buffer.from(JSON.stringify(entry.value)),
      Buffer.from(entry.publisher),
      Buffer.from(entry.timestamp.toISOString()),
      Buffer.from(entry.ttl.toString()),
    ]);

    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    verify.end();

    const publicKeyObject = crypto.createPublicKey({
      key: publicKey,
      format: 'der',
      type: 'spki',
    });

    const isValid = verify.verify(publicKeyObject, entry.signature);

    if (isValid && this.isEntryFresh(entry)) {
      this.dhtStore.set(entry.key, entry);
      this.emit('dhtUpdated', { key: entry.key });
    }

    return isValid;
  }

  private isEntryFresh(entry: DHTEntry): boolean {
    const now = Date.now();
    const entryTime = entry.timestamp.getTime();
    return now - entryTime < entry.ttl;
  }

  detectEclipseAttack(peerId: string, connections: string[]): boolean {
    const uniqueASNs = new Set(connections.map(c => this.getASN(c)));
    return uniqueASNs.size < 2; // Suspicious if all from same ASN
  }

  private getASN(peerId: string): string {
    // Simplified - in production, would lookup actual ASN
    return peerId.substring(0, 8);
  }

  cleanup(maxAge: number = 3600000): void {
    const now = Date.now();
    for (const [key, entry] of this.dhtStore.entries()) {
      if (now - entry.timestamp.getTime() > entry.ttl) {
        this.dhtStore.delete(key);
      }
    }
  }

  shutdown(): void {
    this.routingTable.clear();
    this.dhtStore.clear();
    this.emit('shutdown');
  }
}
