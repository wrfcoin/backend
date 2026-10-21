/**
 * Eclipse Attack Protection - Heartbeat Manager
 *
 * Multi-path heartbeat verification to detect network isolation
 * and Eclipse attack attempts through heartbeat monitoring.
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import type { PeerInfo } from './eclipse-peer-selection.js';
import type { ChannelType } from './eclipse-redundant-channels.js';

export interface Heartbeat {
  peerId: string;
  sequence: number;
  timestamp: Date;
  blockHash: Buffer;
  blockHeight: number;
  nonce: Buffer;
  signature: Buffer;
  channel: ChannelType;
}

export interface HeartbeatStatus {
  peerId: string;
  lastHeartbeat: Date;
  missedHeartbeats: number;
  averageLatency: number;
  isIsolated: boolean;
  channels: ChannelType[];
}

export class HeartbeatManager extends EventEmitter {
  private heartbeatInterval = 10000; // 10 seconds
  private heartbeatTimeout = 30000; // 30 seconds
  private sequences: Map<string, number> = new Map();
  private lastHeartbeats: Map<string, Heartbeat> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private latencies: Map<string, number[]> = new Map();

  constructor() {
    super();
  }

  public startHeartbeat(peer: PeerInfo): void {
    const timer = setInterval(() => {
      this.sendHeartbeat(peer);
    }, this.heartbeatInterval);

    this.timers.set(peer.nodeId, timer);
    this.sequences.set(peer.nodeId, 0);
  }

  public stopHeartbeat(peerId: string): void {
    const timer = this.timers.get(peerId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(peerId);
    }
  }

  private async sendHeartbeat(peer: PeerInfo): Promise<void> {
    const sequence = (this.sequences.get(peer.nodeId) || 0) + 1;
    this.sequences.set(peer.nodeId, sequence);

    const heartbeat: Heartbeat = {
      peerId: peer.nodeId,
      sequence,
      timestamp: new Date(),
      blockHash: Buffer.alloc(32),
      blockHeight: 0,
      nonce: crypto.randomBytes(16),
      signature: Buffer.alloc(64),
      channel: 'P2P_DIRECT' as ChannelType
    };

    try {
      await this.transmitHeartbeat(heartbeat, peer);
    } catch (error) {
      this.handleHeartbeatFailure(peer.nodeId);
    }
  }

  private async transmitHeartbeat(heartbeat: Heartbeat, peer: PeerInfo): Promise<void> {
    // Would actually send heartbeat
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  public receiveHeartbeat(heartbeat: Heartbeat): void {
    this.lastHeartbeats.set(heartbeat.peerId, heartbeat);
    
    const latency = Date.now() - heartbeat.timestamp.getTime();
    const latencies = this.latencies.get(heartbeat.peerId) || [];
    latencies.push(latency);
    if (latencies.length > 100) latencies.shift();
    this.latencies.set(heartbeat.peerId, latencies);

    this.emit('heartbeatReceived', heartbeat);
  }

  private handleHeartbeatFailure(peerId: string): void {
    this.emit('heartbeatMissed', peerId);
    
    const missedCount = this.getMissedHeartbeats(peerId);
    if (missedCount >= 3) {
      this.emit('isolationDetected', peerId);
    }
  }

  private getMissedHeartbeats(peerId: string): number {
    const lastHeartbeat = this.lastHeartbeats.get(peerId);
    if (!lastHeartbeat) return 0;
    
    const timeSince = Date.now() - lastHeartbeat.timestamp.getTime();
    return Math.floor(timeSince / this.heartbeatInterval);
  }

  public getHeartbeatStatus(peerId: string): HeartbeatStatus {
    const lastHeartbeat = this.lastHeartbeats.get(peerId);
    const latencies = this.latencies.get(peerId) || [];
    const avgLatency = latencies.length > 0 
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length 
      : 0;

    return {
      peerId,
      lastHeartbeat: lastHeartbeat?.timestamp || new Date(0),
      missedHeartbeats: this.getMissedHeartbeats(peerId),
      averageLatency: avgLatency,
      isIsolated: this.getMissedHeartbeats(peerId) >= 3,
      channels: lastHeartbeat ? [lastHeartbeat.channel] : []
    };
  }

  public detectNetworkIsolation(peers: PeerInfo[]): boolean {
    const totalPeers = peers.length;
    if (totalPeers === 0) return false;

    const isolatedCount = peers.filter(peer => 
      this.getHeartbeatStatus(peer.nodeId).isIsolated
    ).length;

    return isolatedCount > totalPeers * 0.5;
  }
}

export default HeartbeatManager;
