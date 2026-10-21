import {
  ComputeTaskApiService,
} from '../../server/services/forecast/compute-task-api-service.js';

describe('ComputeTaskApiService', () => {
  it('runs full register -> available -> claim -> heartbeat -> complete lifecycle', async () => {
    let now = new Date('2026-03-05T10:00:00Z').getTime();
    const commitHook = jest.fn(async () => ({
      queued: true,
      receiptRef: 'tx_abc123',
    }));

    const service = new ComputeTaskApiService({
      now: () => now,
      onForecastCommit: commitHook,
    });

    const session = service.registerNode('wrfaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      gpu: true,
      memoryGb: 32,
      regions: ['us-west', 'us-central'],
    });

    const available = service.listAvailableTasks(session);
    expect(available.length).toBeGreaterThan(0);

    const claimed = service.claimTask(session, available[0].id);
    expect(claimed.status).toBe('claimed');
    expect(claimed.leaseId).toBeDefined();

    now += 30 * 1000;
    const heartbeat = service.heartbeatTask(
      session,
      claimed.id,
      claimed.leaseId!,
      55
    );
    expect(heartbeat.progress).toBe(55);

    const completion = await service.completeTask(
      session,
      claimed.id,
      claimed.leaseId!,
      'bafytestcid',
      'bafyverification'
    );
    expect(completion.ok).toBe(true);
    expect(completion.forecastCommitQueued).toBe(true);
    expect(completion.receiptRef).toBe('tx_abc123');
    expect(commitHook).toHaveBeenCalledTimes(1);
  });

  it('requeues stalled claims after heartbeat timeout', () => {
    let now = new Date('2026-03-05T10:00:00Z').getTime();
    const service = new ComputeTaskApiService({
      now: () => now,
      heartbeatTimeoutMs: 5 * 60 * 1000,
    });

    const session = service.registerNode('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      gpu: true,
      memoryGb: 32,
      regions: ['us-west', 'us-central'],
    });

    const task = service.listAvailableTasks(session)[0];
    const claimed = service.claimTask(session, task.id);
    expect(claimed.status).toBe('claimed');

    now += 6 * 60 * 1000;
    const availableAfterTimeout = service.listAvailableTasks(session);
    expect(availableAfterTimeout.some(item => item.id === task.id)).toBe(true);
  });

  it('enforces anti-hoarding active-claim limits', () => {
    const service = new ComputeTaskApiService({
      maxActiveClaimsPerNode: 1,
    });

    const session = service.registerNode('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      gpu: true,
      memoryGb: 32,
      regions: ['us-west', 'us-central'],
    });

    const tasks = service.listAvailableTasks(session);
    expect(tasks.length).toBeGreaterThan(1);

    service.claimTask(session, tasks[0].id);
    expect(() => service.claimTask(session, tasks[1].id)).toThrow(
      'Active claim limit reached for this node'
    );
  });

  it('returns deterministic completion result when commit hook throws', async () => {
    const service = new ComputeTaskApiService({
      onForecastCommit: async () => {
        throw new Error('core4 unreachable');
      },
    });

    const session = service.registerNode(
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      {
        gpu: true,
        memoryGb: 32,
        regions: ['us-west', 'us-central'],
      }
    );

    const task = service.listAvailableTasks(session)[0];
    const claimed = service.claimTask(session, task.id);
    const result = await service.completeTask(
      session,
      task.id,
      claimed.leaseId!,
      'bafyfailedcommit'
    );

    expect(result.ok).toBe(true);
    expect(result.forecastCommitQueued).toBe(false);
  });
});
