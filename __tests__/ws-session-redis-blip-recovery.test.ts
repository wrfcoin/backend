/**
 * #929 review blocker 1 — a transient Redis blip must NOT permanently kill
 * WebSocket sessions.
 *
 * The defect: `retryStrategy` returned `null` after 5 attempts, which tells
 * ioredis to stop reconnecting *forever*. Availability was only restored by a
 * later connection event, and no reconnect would ever be attempted again, so
 * the flag stayed false and every session operation threw until redeploy. A
 * 30-second hiccup took WS sessions down permanently.
 *
 * These are RED-control tests: each one fails if the corresponding half of the
 * recovery path is removed. See the PR comment for the recorded RED run.
 */

import Redis from 'ioredis';
import { jest } from '@jest/globals';
import {
  WebSocketSessionManager,
  WS_REDIS_MAX_RECONNECT_DELAY_MS,
} from '../shared/websocket/ws-session-manager.js';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('../server/utils/logger.js', () => ({
  __esModule: true,
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Handler = (...args: unknown[]) => void;

interface FakeRedis {
  options: any;
  handlers: Map<string, Handler[]>;
  on: jest.Mock;
  get: jest.Mock;
  emit: (event: string, ...args: unknown[]) => void;
}

const RedisMock = Redis as unknown as jest.MockedFunction<typeof Redis>;

function buildManager() {
  let fake!: FakeRedis;

  RedisMock.mockReset();
  RedisMock.mockImplementation((primary: unknown, secondary?: unknown) => {
    const options = typeof primary === 'string' ? secondary : primary;
    const handlers = new Map<string, Handler[]>();
    fake = {
      options,
      handlers,
      on: jest.fn((event: string, fn: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        return fake;
      }) as unknown as jest.Mock,
      get: jest.fn(async () => null),
      emit: (event: string, ...args: unknown[]) => {
        for (const fn of handlers.get(event) ?? []) fn(...args);
      },
    };
    return fake as any;
  });

  const manager = new WebSocketSessionManager();
  return { manager, redis: fake };
}

/** Reproduce a transient outage exactly as ioredis reports one. */
function simulateBlip(redis: FakeRedis) {
  redis.emit('error', new Error('ECONNREFUSED'));
  redis.emit('close');
}

describe('#929 — WS sessions survive a transient Redis blip', () => {
  it('never abandons reconnection: retryStrategy returns a capped delay, never null', () => {
    const { redis } = buildManager();
    const retryStrategy = redis.options.retryStrategy as (times: number) => number | null;

    expect(typeof retryStrategy).toBe('function');

    // The old code returned null from attempt 6 onward. Anything past the
    // threshold must still be a finite, bounded delay.
    for (const attempt of [1, 5, 6, 7, 50, 5000]) {
      const delay = retryStrategy(attempt);
      expect(delay).not.toBeNull();
      expect(typeof delay).toBe('number');
      expect(delay as number).toBeGreaterThan(0);
      expect(delay as number).toBeLessThanOrEqual(WS_REDIS_MAX_RECONNECT_DELAY_MS);
    }

    // Bounded, not unbounded: it must plateau rather than grow forever.
    expect(retryStrategy(10_000)).toBe(WS_REDIS_MAX_RECONNECT_DELAY_MS);
  });

  it('degrades during the blip and RECOVERS when Redis returns', async () => {
    const { manager, redis } = buildManager();

    // Healthy before.
    await expect(manager.getSession('conn-1')).resolves.toBeNull();

    // Blip: operations must refuse (fail closed), not hang or serve stale data.
    simulateBlip(redis);
    await expect(manager.getSession('conn-1')).rejects.toThrow(
      'WebSocket session store unavailable',
    );

    // Redis comes back. ioredis emits 'connect' then 'ready'.
    redis.emit('connect');
    redis.emit('ready');

    // The session store is usable again WITHOUT a redeploy. This is the
    // assertion the old code could never satisfy.
    await expect(manager.getSession('conn-1')).resolves.toBeNull();
  });

  it('recovers on a later blip too — the recovery path is not one-shot', async () => {
    const { manager, redis } = buildManager();

    for (let round = 0; round < 3; round++) {
      simulateBlip(redis);
      await expect(manager.getSession('conn-1')).rejects.toThrow(
        'WebSocket session store unavailable',
      );
      redis.emit('ready');
      await expect(manager.getSession('conn-1')).resolves.toBeNull();
    }
  });

  it('does not mark itself available on socket connect alone', async () => {
    const { manager, redis } = buildManager();

    simulateBlip(redis);
    // 'connect' means the socket is up; with enableReadyCheck the client still
    // cannot serve commands. Flipping availability here would expose a window
    // where session reads are issued against a not-yet-ready client.
    redis.emit('connect');
    await expect(manager.getSession('conn-1')).rejects.toThrow(
      'WebSocket session store unavailable',
    );

    redis.emit('ready');
    await expect(manager.getSession('conn-1')).resolves.toBeNull();
  });

  it('still fails commands fast during the outage (no unbounded queueing)', () => {
    const { redis } = buildManager();
    // The PR's fail-fast intent must be preserved: this fix changes
    // reconnection, not per-command retry behaviour.
    expect(redis.options.maxRetriesPerRequest).toBe(3);
  });
});
