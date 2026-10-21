/**
 * CrossChainWorkerManager - Manages BullMQ workers for cross-chain protocol queues.
 *
 * Each protocol gets a dedicated worker that processes jobs from its queue.
 * Workers support 3 retry attempts with exponential backoff.
 */

import { Worker, Job } from 'bullmq';
import type { CrossChainJobData, CrossChainJobResult } from './types.js';

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

export class CrossChainWorkerManager {
  private workers: Map<string, Worker<CrossChainJobData, CrossChainJobResult>> = new Map();
  private readonly connectionOpts: { host: string; port: number };

  constructor(host?: string, port?: number) {
    this.connectionOpts = parseRedisConnection(host, port);
  }

  /**
   * Start a BullMQ worker for the given protocol queue.
   *
   * @param protocol - Protocol name (e.g. "wormhole")
   * @param processor - Async function that processes a job and returns a result
   */
  startWorker(
    protocol: string,
    processor: (job: Job<CrossChainJobData, CrossChainJobResult>) => Promise<CrossChainJobResult>
  ): Worker<CrossChainJobData, CrossChainJobResult> {
    const key = protocol.toLowerCase();

    // Close existing worker for this protocol if any
    const existing = this.workers.get(key);
    if (existing) {
      existing.close();
    }

    const worker = new Worker<CrossChainJobData, CrossChainJobResult>(
      `crosschain:${key}`,
      async (job) => {
        await job.updateProgress(10);
        const result = await processor(job);
        await job.updateProgress(100);
        return result;
      },
      {
        connection: this.connectionOpts,
        concurrency: 5,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      }
    );

    this.workers.set(key, worker);
    return worker;
  }

  /**
   * Stop all running workers gracefully.
   */
  async stopAll(): Promise<void> {
    const stopping = Array.from(this.workers.values()).map((w) => w.close());
    await Promise.all(stopping);
    this.workers.clear();
  }
}

// Singleton instance
export const crossChainWorkerManager = new CrossChainWorkerManager();
