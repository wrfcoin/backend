/**
 * Tests for BullMQ-backed cross-chain queue services.
 *
 * Uses jest mocks to avoid requiring a real Redis connection.
 */

// ---------------------------------------------------------------------------
// Mock BullMQ before any imports that reference it
// ---------------------------------------------------------------------------

const mockAdd = jest.fn();
const mockGetJob = jest.fn();
const mockGetJobCounts = jest.fn();
const mockQueueClose = jest.fn();
const mockWorkerClose = jest.fn();
const mockRedisSetex = jest.fn().mockResolvedValue('OK');
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisHset = jest.fn().mockResolvedValue(1);
const mockRedisHgetall = jest.fn().mockResolvedValue({});
const mockRedisExpire = jest.fn().mockResolvedValue(1);
const mockRedisQuit = jest.fn().mockResolvedValue('OK');

jest.mock('bullmq', () => {
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: mockAdd,
      getJob: mockGetJob,
      getJobCounts: mockGetJobCounts,
      close: mockQueueClose,
    })),
    Worker: jest.fn().mockImplementation((_name, processor, _opts) => {
      return { close: mockWorkerClose };
    }),
  };
});

// Also mock ioredis so CrossChainMetricsService constructor doesn't open a real connection
jest.mock('ioredis', () => {
  return {
    Redis: jest.fn().mockImplementation(() => ({
      setex: mockRedisSetex,
      get: mockRedisGet,
      hset: mockRedisHset,
      hgetall: mockRedisHgetall,
      expire: mockRedisExpire,
      quit: mockRedisQuit,
    })),
    // Support both default and named imports
    default: jest.fn().mockImplementation(() => ({
      setex: mockRedisSetex,
      get: mockRedisGet,
      hset: mockRedisHset,
      hgetall: mockRedisHgetall,
      expire: mockRedisExpire,
      quit: mockRedisQuit,
    })),
  };
});

// Mock the logger to silence output during tests
jest.mock('../server/utils/logger', () => ({
  blockchainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { Queue, Worker } from 'bullmq';
import { CrossChainQueueService } from '../services/queue/CrossChainQueueService.js';
import { CrossChainWorkerManager } from '../services/queue/CrossChainWorker.js';
import { CrossChainMetricsService } from '../services/CrossChainMetricsService.js';
import { CrossChainJobData, CrossChainJobResult } from '../services/queue/types.js';

// ---------------------------------------------------------------------------
// CrossChainQueueService tests
// ---------------------------------------------------------------------------

describe('CrossChainQueueService', () => {
  let queueService: CrossChainQueueService;

  beforeEach(() => {
    jest.clearAllMocks();
    queueService = new CrossChainQueueService('localhost', 6379);
  });

  afterEach(async () => {
    await queueService.close();
  });

  const sampleJob: CrossChainJobData = {
    protocol: 'wormhole',
    sourceChain: 'ethereum',
    destinationChain: 'solana',
    messageType: 'token_transfer',
    payload: '0xdeadbeef',
  };

  // ---- Test: job submission returns valid jobId ----

  it('should submit a job and return a valid jobId', async () => {
    mockAdd.mockResolvedValueOnce({ id: 'job-123' });

    const jobId = await queueService.addJob('wormhole', sampleJob);

    expect(jobId).toBe('job-123');
    expect(mockAdd).toHaveBeenCalledWith(
      'cross-chain-message',
      sampleJob,
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }),
    );
  });

  // ---- Test: getQueue lazily creates named queues ----

  it('should create a queue named crosschain:<protocol>', () => {
    queueService.getQueue('wormhole');
    expect(Queue).toHaveBeenCalledWith(
      'crosschain:wormhole',
      expect.objectContaining({ connection: { host: 'localhost', port: 6379 } }),
    );
  });

  it('should reuse the same queue for the same protocol', () => {
    const q1 = queueService.getQueue('wormhole');
    const q2 = queueService.getQueue('wormhole');
    expect(q1).toBe(q2);
    // Queue constructor should only be called once for the same protocol
    expect(Queue).toHaveBeenCalledTimes(1);
  });

  // ---- Test: job status lifecycle pending -> active -> completed ----

  it('should report pending status for waiting jobs', async () => {
    mockGetJob.mockResolvedValueOnce({
      getState: jest.fn().mockResolvedValue('waiting'),
      returnvalue: null,
      failedReason: null,
    });

    const result = await queueService.getJobStatus('job-1', 'wormhole');
    expect(result.status).toBe('pending');
  });

  it('should report relaying status for active jobs', async () => {
    mockGetJob.mockResolvedValueOnce({
      getState: jest.fn().mockResolvedValue('active'),
      returnvalue: null,
      failedReason: null,
    });

    const result = await queueService.getJobStatus('job-1', 'wormhole');
    expect(result.status).toBe('relaying');
  });

  it('should report completed status with result', async () => {
    const jobResult: CrossChainJobResult = {
      confirmationHash: '0xabc123',
      gasFee: '0.002',
      completedAt: new Date().toISOString(),
    };

    mockGetJob.mockResolvedValueOnce({
      getState: jest.fn().mockResolvedValue('completed'),
      returnvalue: jobResult,
      failedReason: null,
    });

    const result = await queueService.getJobStatus('job-1', 'wormhole');
    expect(result.status).toBe('completed');
    expect(result.result).toEqual(jobResult);
  });

  // ---- Test: failed job with error message ----

  it('should report failed status with error message', async () => {
    mockGetJob.mockResolvedValueOnce({
      getState: jest.fn().mockResolvedValue('failed'),
      returnvalue: null,
      failedReason: 'Relay timeout after 30s',
    });

    const result = await queueService.getJobStatus('job-1', 'wormhole');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Relay timeout after 30s');
  });

  it('should report failed for a non-existent job', async () => {
    mockGetJob.mockResolvedValueOnce(null);

    const result = await queueService.getJobStatus('no-such-job', 'wormhole');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Job not found');
  });

  // ---- Test: queue depth reporting ----

  it('should report queue depth from BullMQ job counts', async () => {
    mockGetJobCounts.mockResolvedValueOnce({ waiting: 5, active: 2, delayed: 1 });

    // getQueue returns the mock, which has getJobCounts
    const queue = queueService.getQueue('wormhole');
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
    const depth = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);

    expect(depth).toBe(8);
  });

  // ---- Test: close shuts down all queues ----

  it('should close all queues on close()', async () => {
    queueService.getQueue('wormhole');
    queueService.getQueue('layerzero');

    await queueService.close();

    expect(mockQueueClose).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// CrossChainWorkerManager tests
// ---------------------------------------------------------------------------

describe('CrossChainWorkerManager', () => {
  let workerManager: CrossChainWorkerManager;

  beforeEach(() => {
    jest.clearAllMocks();
    workerManager = new CrossChainWorkerManager('localhost', 6379);
  });

  afterEach(async () => {
    await workerManager.stopAll();
  });

  it('should create a Worker for the given protocol', () => {
    const processor = jest.fn();
    workerManager.startWorker('wormhole', processor);

    expect(Worker).toHaveBeenCalledWith(
      'crosschain:wormhole',
      expect.any(Function),
      expect.objectContaining({
        connection: { host: 'localhost', port: 6379 },
        concurrency: 5,
      }),
    );
  });

  it('should stop all workers on stopAll()', async () => {
    workerManager.startWorker('wormhole', jest.fn());
    workerManager.startWorker('layerzero', jest.fn());

    await workerManager.stopAll();

    expect(mockWorkerClose).toHaveBeenCalledTimes(2);
  });

  it('should replace an existing worker for the same protocol', () => {
    workerManager.startWorker('wormhole', jest.fn());
    workerManager.startWorker('wormhole', jest.fn());

    // First worker should have been closed before creating the new one
    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
    // Worker constructor called twice
    expect(Worker).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Protocol whitelist tests
// ---------------------------------------------------------------------------

describe('CrossChainQueueService protocol whitelist', () => {
  let queueService: CrossChainQueueService;

  beforeEach(() => {
    jest.clearAllMocks();
    queueService = new CrossChainQueueService('localhost', 6379);
  });

  afterEach(async () => {
    await queueService.close();
  });

  it('should accept known protocols (case-insensitive)', () => {
    expect(() => queueService.getQueue('Wormhole')).not.toThrow();
    expect(() => queueService.getQueue('AXELAR')).not.toThrow();
    expect(() => queueService.getQueue('layerzero')).not.toThrow();
  });

  it('should reject unknown protocols', () => {
    expect(() => queueService.getQueue('unknown_bridge')).toThrow(/Unknown cross-chain protocol/);
    expect(() => queueService.getQueue('')).toThrow(/Unknown cross-chain protocol/);
  });

  it('should reject unknown protocols in addJob', async () => {
    await expect(
      queueService.addJob('fakeBridge', {
        protocol: 'fakeBridge',
        sourceChain: 'ethereum',
        destinationChain: 'solana',
        messageType: 'token_transfer',
        payload: '0x00',
      }),
    ).rejects.toThrow(/Unknown cross-chain protocol/);
  });
});

// ---------------------------------------------------------------------------
// CrossChainMetricsService tests
// ---------------------------------------------------------------------------

describe('CrossChainMetricsService', () => {
  let metricsService: CrossChainMetricsService;
  let queueService: CrossChainQueueService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAdd.mockResolvedValue({ id: 'job-1' });
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, delayed: 0 });
    queueService = new CrossChainQueueService('localhost', 6379);
    // Pass undefined for redisUrl to skip real Redis, and inject mock queue service
    metricsService = new CrossChainMetricsService(undefined, queueService);
  });

  afterEach(async () => {
    await queueService.close();
  });

  it('should track protocol metrics after message creation', async () => {
    await metricsService.createMessage({
      protocol: 'wormhole',
      sourceChain: 'ethereum',
      destinationChain: 'solana',
      messageType: 'token_transfer',
      payload: '0xdeadbeef',
    });

    const metrics = await metricsService.getProtocolMetrics('wormhole');
    expect(metrics.totalMessages).toBe(1);
    expect(metrics.pendingMessages).toBe(1);
    expect(metrics.completedMessages).toBe(0);
    expect(metrics.dailyVolume).toBe(1);
  });

  it('should increment daily volume on each submission', async () => {
    for (let i = 0; i < 3; i++) {
      await metricsService.createMessage({
        protocol: 'wormhole',
        sourceChain: 'ethereum',
        destinationChain: 'solana',
        messageType: 'token_transfer',
        payload: `0x${i}`,
      });
    }

    const metrics = await metricsService.getProtocolMetrics('wormhole');
    expect(metrics.totalMessages).toBe(3);
    expect(metrics.dailyVolume).toBe(3);
  });

  it('should update metrics on status transitions', async () => {
    const msg = await metricsService.createMessage({
      protocol: 'axelar',
      sourceChain: 'ethereum',
      destinationChain: 'polygon',
      messageType: 'message',
      payload: '0x01',
    });

    await metricsService.updateMessageStatus(msg.id, 'relaying');
    await metricsService.updateMessageStatus(msg.id, 'completed');

    const metrics = await metricsService.getProtocolMetrics('axelar');
    expect(metrics.completedMessages).toBe(1);
    expect(metrics.pendingMessages).toBe(0);
    expect(metrics.successRate).toBe(100);
  });

  it('should calculate success rate with failures', async () => {
    const msg1 = await metricsService.createMessage({
      protocol: 'layerzero',
      sourceChain: 'ethereum',
      destinationChain: 'avalanche',
      messageType: 'token_transfer',
      payload: '0x01',
    });
    const msg2 = await metricsService.createMessage({
      protocol: 'layerzero',
      sourceChain: 'ethereum',
      destinationChain: 'avalanche',
      messageType: 'token_transfer',
      payload: '0x02',
    });

    await metricsService.updateMessageStatus(msg1.id, 'completed');
    await metricsService.updateMessageStatus(msg2.id, 'failed', { errorMessage: 'timeout' });

    const metrics = await metricsService.getProtocolMetrics('layerzero');
    expect(metrics.completedMessages).toBe(1);
    expect(metrics.failedMessages).toBe(1);
    expect(metrics.successRate).toBe(50);
  });

  it('should report queue depth from BullMQ', async () => {
    mockGetJobCounts.mockResolvedValueOnce({ waiting: 3, active: 1, delayed: 0 });

    const depth = await metricsService.getQueueLength('wormhole');
    expect(depth).toBe(4);
  });

  it('should generate unique message IDs', () => {
    const id1 = metricsService.generateMessageId('wormhole');
    const id2 = metricsService.generateMessageId('wormhole');
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^wrfcoin_wormhole_/);
  });

  it('should return aggregate metrics across protocols', async () => {
    await metricsService.createMessage({
      protocol: 'wormhole',
      sourceChain: 'ethereum',
      destinationChain: 'solana',
      messageType: 'token_transfer',
      payload: '0x01',
    });
    await metricsService.createMessage({
      protocol: 'axelar',
      sourceChain: 'ethereum',
      destinationChain: 'polygon',
      messageType: 'message',
      payload: '0x02',
    });

    const aggregate = await metricsService.getAggregateMetrics(['wormhole', 'axelar']);
    expect(aggregate.totalProtocols).toBe(2);
    expect(aggregate.totalMessagesProcessed).toBe(2);
  });

  it('should persist status transitions as Redis hash deltas', async () => {
    (metricsService as any).redis = {
      setex: mockRedisSetex,
      get: mockRedisGet,
      hset: mockRedisHset,
      hgetall: mockRedisHgetall,
      expire: mockRedisExpire,
      quit: mockRedisQuit,
    };

    const msg = await metricsService.createMessage({
      protocol: 'wormhole',
      sourceChain: 'ethereum',
      destinationChain: 'solana',
      messageType: 'token_transfer',
      payload: '0x01',
    });

    expect(mockRedisSetex).toHaveBeenCalledTimes(1);
    mockRedisHset.mockClear();
    mockRedisExpire.mockClear();

    await metricsService.updateMessageStatus(msg.id, 'relaying');
    await metricsService.updateMessageStatus(msg.id, 'completed');

    expect(mockRedisHset).toHaveBeenCalledTimes(2);
    expect(mockRedisHset).toHaveBeenCalledWith(
      `crosschain:msg:${msg.id}:state`,
      expect.objectContaining({ status: 'relaying' }),
    );
    expect(mockRedisHset).toHaveBeenCalledWith(
      `crosschain:msg:${msg.id}:state`,
      expect.objectContaining({ status: 'completed' }),
    );
    expect(mockRedisExpire).toHaveBeenCalledWith(`crosschain:msg:${msg.id}:state`, 86400);
    expect(mockRedisSetex).toHaveBeenCalledTimes(1);
  });

  it('should apply Redis status hash over cached base message payload', async () => {
    (metricsService as any).redis = {
      setex: mockRedisSetex,
      get: mockRedisGet,
      hset: mockRedisHset,
      hgetall: mockRedisHgetall,
      expire: mockRedisExpire,
      quit: mockRedisQuit,
    };
    const messageId = 'wrfcoin_wormhole_test_1';

    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify({
        id: messageId,
        protocol: 'wormhole',
        sourceChain: 'ethereum',
        destinationChain: 'solana',
        messageType: 'token_transfer',
        payload: '0x01',
        status: 'pending',
        submittedAt: '2026-05-20T00:00:00.000Z',
      }),
    );
    mockRedisHgetall.mockResolvedValueOnce({
      status: 'completed',
      completedAt: '2026-05-20T00:01:00.000Z',
      confirmationHash: '0xabc123',
    });

    const message = await metricsService.getMessage(messageId);

    expect(message).not.toBeNull();
    expect(message?.status).toBe('completed');
    expect(message?.completedAt).toBeInstanceOf(Date);
    expect(message?.confirmationHash).toBe('0xabc123');
    expect(mockRedisGet).toHaveBeenCalledWith(`crosschain:msg:${messageId}`);
    expect(mockRedisHgetall).toHaveBeenCalledWith(`crosschain:msg:${messageId}:state`);
  });
});
