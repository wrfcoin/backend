/**
 * CrossChainQueueService - BullMQ-backed queue for cross-chain message processing.
 *
 * Replaces the in-memory Map<string, QueueEntry[]> with durable Redis-backed queues.
 * Each protocol gets its own BullMQ queue (e.g. "crosschain:wormhole").
 */

import { Queue } from 'bullmq';
import type { CrossChainJobData, CrossChainJobResult, JobStatus } from './types.js';

// Allowed cross-chain protocols — reject unknown protocols to prevent queue pollution
const ALLOWED_PROTOCOLS = new Set([
  'wormhole', 'axelar', 'layerzero', 'stargate', 'synapse',
  'hop', 'ibc', 'xcmp', 'across', 'celer', 'connext', 'debridge', 'multichain',
]);

/** Parse REDIS_URL into { host, port } for BullMQ connection opts. */
function parseRedisConnection(host?: string, port?: number): { host: string; port: number } {
  if (host) return { host, port: port ?? 6379 };

  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, port: Number(parsed.port) || 6379 };
    } catch { /* fall through */ }
  }
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
  };
}

export class CrossChainQueueService {
  private queues: Map<string, Queue<CrossChainJobData, CrossChainJobResult>> = new Map();
  private readonly connectionOpts: { host: string; port: number };

  constructor(host?: string, port?: number) {
    this.connectionOpts = parseRedisConnection(host, port);
  }

  /**
   * Validate that a protocol name is in the allowed set.
   */
  private validateProtocol(protocol: string): string {
    const key = protocol.toLowerCase();
    if (!ALLOWED_PROTOCOLS.has(key)) {
      throw new Error(`Unknown cross-chain protocol: "${protocol}". Allowed: ${[...ALLOWED_PROTOCOLS].join(', ')}`);
    }
    return key;
  }

  /**
   * Get or lazily create a BullMQ Queue for a given protocol.
   */
  getQueue(protocol: string): Queue<CrossChainJobData, CrossChainJobResult> {
    const key = this.validateProtocol(protocol);
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new Queue<CrossChainJobData, CrossChainJobResult>(`crosschain:${key}`, {
        connection: this.connectionOpts,
      });
      this.queues.set(key, queue);
    }
    return queue;
  }

  /**
   * Add a cross-chain job to the protocol's queue.
   * Returns the BullMQ job ID.
   */
  async addJob(protocol: string, data: CrossChainJobData): Promise<string> {
    const queue = this.getQueue(protocol);
    const job = await queue.add('cross-chain-message', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    });
    return job.id!;
  }

  /**
   * Retrieve a job's current status and result/error from BullMQ.
   */
  async getJobStatus(
    jobId: string,
    protocol: string
  ): Promise<{ status: JobStatus; result?: CrossChainJobResult; error?: string }> {
    const queue = this.getQueue(protocol);
    const job = await queue.getJob(jobId);

    if (!job) {
      return { status: 'failed', error: 'Job not found' };
    }

    const state = await job.getState();

    switch (state) {
      case 'completed':
        return { status: 'completed', result: job.returnvalue };
      case 'failed':
        return { status: 'failed', error: job.failedReason ?? 'Unknown error' };
      case 'active':
        return { status: 'relaying' };
      case 'waiting':
      case 'delayed':
      case 'prioritized':
      case 'waiting-children':
      default:
        return { status: 'pending' };
    }
  }

  /**
   * Close all managed queues gracefully.
   */
  async close(): Promise<void> {
    const closing = Array.from(this.queues.values()).map((q) => q.close());
    await Promise.all(closing);
    this.queues.clear();
  }
}

// Singleton instance
export const crossChainQueueService = new CrossChainQueueService();
