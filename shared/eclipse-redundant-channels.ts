/**
 * Eclipse Attack Protection - Redundant Communication Channels
 *
 * Multi-channel communication system to prevent Eclipse attacks through
 * network censorship and single-point-of-failure vulnerabilities.
 */

import { EventEmitter } from 'events';
import type { PeerInfo } from './eclipse-peer-selection.js';

export enum ChannelType {
  P2P_DIRECT = 'P2P_DIRECT',
  GOSSIP_NETWORK = 'GOSSIP_NETWORK',
  DHT_NETWORK = 'DHT_NETWORK',
  WEBSOCKET_RELAY = 'WEBSOCKET_RELAY',
  BRIDGE_NODE = 'BRIDGE_NODE',
  TOR_NETWORK = 'TOR_NETWORK',
  I2P_NETWORK = 'I2P_NETWORK'
}

export interface Channel {
  type: ChannelType;
  isActive: boolean;
  latency: number;
  reliability: number;
  bandwidth: number;
  lastUsed: Date;
  messagesSent: number;
  messagesReceived: number;
  failureCount: number;
}

export interface Message {
  id: string;
  payload: Buffer;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  timestamp: Date;
  ttl: number;
  nonce: Buffer;
}

export interface ChannelHealth {
  channelType: ChannelType;
  isHealthy: boolean;
  metrics: Channel;
  lastCheck: Date;
}

export class RedundantChannelManager extends EventEmitter {
  private channels: Map<ChannelType, Channel> = new Map();
  private messageRoutes: Map<string, Set<ChannelType>> = new Map();
  private failoverPriority: ChannelType[] = [
    ChannelType.P2P_DIRECT,
    ChannelType.GOSSIP_NETWORK,
    ChannelType.DHT_NETWORK,
    ChannelType.WEBSOCKET_RELAY,
    ChannelType.BRIDGE_NODE,
    ChannelType.TOR_NETWORK,
    ChannelType.I2P_NETWORK
  ];

  constructor() {
    super();
    this.initializeChannels();
  }

  private initializeChannels(): void {
    for (const type of Object.values(ChannelType)) {
      this.channels.set(type, {
        type,
        isActive: false,
        latency: 0,
        reliability: 100,
        bandwidth: 0,
        lastUsed: new Date(),
        messagesSent: 0,
        messagesReceived: 0,
        failureCount: 0
      });
    }
  }

  public activateChannel(type: ChannelType): void {
    const channel = this.channels.get(type);
    if (channel) {
      channel.isActive = true;
      this.emit('channelActivated', type);
    }
  }

  public deactivateChannel(type: ChannelType): void {
    const channel = this.channels.get(type);
    if (channel) {
      channel.isActive = false;
      this.emit('channelDeactivated', type);
    }
  }

  public async sendMessage(message: Message, peer: PeerInfo): Promise<void> {
    const activeChannels = this.getActiveChannels();
    
    if (activeChannels.length === 0) {
      throw new Error('No active channels available');
    }

    const channels = message.priority === 'CRITICAL' 
      ? activeChannels 
      : activeChannels.slice(0, 2);

    const results = await Promise.allSettled(
      channels.map(channel => this.sendViaChannel(message, peer, channel.type))
    );

    const successful = results.filter(r => r.status === 'fulfilled').length;
    
    if (successful === 0) {
      this.emit('messageFailure', { message, peer });
      throw new Error('Failed to send message on any channel');
    }

    this.messageRoutes.set(message.id, new Set(
      results
        .map((r, i) => r.status === 'fulfilled' ? channels[i].type : null)
        .filter((t): t is ChannelType => t !== null)
    ));
  }

  private async sendViaChannel(
    message: Message,
    peer: PeerInfo,
    channelType: ChannelType
  ): Promise<void> {
    const channel = this.channels.get(channelType);
    if (!channel || !channel.isActive) {
      throw new Error(`Channel ${channelType} not active`);
    }

    try {
      await this.transmit(channelType, message, peer);
      channel.messagesSent++;
      channel.lastUsed = new Date();
      this.emit('messageSent', { channelType, messageId: message.id });
    } catch (error) {
      channel.failureCount++;
      if (channel.failureCount > 5) {
        channel.reliability = Math.max(0, channel.reliability - 10);
      }
      throw error;
    }
  }

  private async transmit(
    channelType: ChannelType,
    message: Message,
    peer: PeerInfo
  ): Promise<void> {
    // Actual transmission logic would go here
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  private getActiveChannels(): Channel[] {
    return this.failoverPriority
      .map(type => this.channels.get(type)!)
      .filter(channel => channel.isActive)
      .sort((a, b) => b.reliability - a.reliability);
  }

  public getChannelHealth(): ChannelHealth[] {
    return Array.from(this.channels.values()).map(channel => ({
      channelType: channel.type,
      isHealthy: channel.isActive && channel.reliability > 70,
      metrics: channel,
      lastCheck: new Date()
    }));
  }

  public async performFailover(failedChannel: ChannelType): Promise<void> {
    this.deactivateChannel(failedChannel);
    
    const backupChannels = this.getActiveChannels();
    if (backupChannels.length === 0) {
      this.emit('allChannelsFailed');
      throw new Error('No backup channels available');
    }

    this.emit('failoverComplete', {
      from: failedChannel,
      to: backupChannels[0].type
    });
  }
}

export default RedundantChannelManager;
