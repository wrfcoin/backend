import { createServer, type Server } from 'http';
import { once } from 'events';
import { WebSocket } from 'ws';
import {
  initializeRealtimeWebSocketServer,
  type RealtimeWebSocketHub,
} from '../server/websocket/index.js';

function waitForEvent(
  ws: WebSocket,
  event: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for ${event}`)),
      2_000
    );
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.event !== event) {
        return;
      }
      clearTimeout(timeout);
      ws.off('message', listener);
      resolve(message);
    };
    ws.on('message', listener);
  });
}

async function openClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const connected = waitForEvent(ws, 'connected');
  await once(ws, 'open');
  await connected;
  return ws;
}

async function subscribe(ws: WebSocket, channel: string): Promise<void> {
  const subscribed = waitForEvent(ws, 'subscribed');
  ws.send(JSON.stringify({ action: 'subscribe', channel }));
  await subscribed;
}

async function startHub(): Promise<{
  server: Server;
  hub: RealtimeWebSocketHub;
  port: number;
}> {
  const server = createServer();
  const hub = initializeRealtimeWebSocketServer(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port');
  }
  return { server, hub, port: address.port };
}

/**
 * The hub learns of a peer's close from ITS OWN socket's 'close' event, which lands one or more event-loop
 * turns after the client's 'close' event. A single setImmediate (#959) was a race: it usually sufficed with
 * ws 8.21.0 and never does with 8.21.3 / 8.22.0 (#1469), where the hub drops the client one turn later.
 * Poll the hub's own stats, bounded, instead of guessing the number of turns.
 */
async function waitForStats(
  hub: RealtimeWebSocketHub,
  ready: (stats: ReturnType<RealtimeWebSocketHub['getStats']>) => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready(hub.getStats())) {
    if (Date.now() > deadline) {
      throw new Error(`hub stats did not settle within ${timeoutMs} ms: ${JSON.stringify(hub.getStats())}`);
    }
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function stopHub(
  server: Server,
  hub: RealtimeWebSocketHub
): Promise<void> {
  await hub.close();
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

describe('realtime WebSocket subscription index', () => {
  const originalMaxBufferedBytes = process.env.WS_MAX_BUFFERED_BYTES;

  afterEach(() => {
    if (originalMaxBufferedBytes === undefined) {
      delete process.env.WS_MAX_BUFFERED_BYTES;
    } else {
      process.env.WS_MAX_BUFFERED_BYTES = originalMaxBufferedBytes;
    }
  });

  it('tracks subscribe, duplicate subscribe, unsubscribe, and close lifecycle', async () => {
    const { server, hub, port } = await startHub();
    const first = await openClient(port);
    const second = await openClient(port);
    const unrelated = await openClient(port);

    try {
      await subscribe(first, 'weather:station-1');
      await subscribe(second, 'weather:station-1');
      await subscribe(unrelated, 'weather:station-2');
      await subscribe(first, 'weather:station-1');

      hub.broadcast('weather:station-1', 'reading', { temperature: 18 });
      expect(hub.getStats()).toMatchObject({
        connections: 3,
        indexedChannels: 2,
        subscriptions: 3,
        lastBroadcastCandidates: 2,
      });

      const unsubscribed = waitForEvent(first, 'unsubscribed');
      first.send(
        JSON.stringify({
          action: 'unsubscribe',
          channel: 'weather:station-1',
        })
      );
      await unsubscribed;

      hub.broadcast('weather:station-1', 'reading', { temperature: 19 });
      expect(hub.getStats()).toMatchObject({
        subscriptions: 2,
        lastBroadcastCandidates: 1,
      });

      second.close();
      await once(second, 'close');
      await waitForStats(hub, stats => stats.connections === 2);
      hub.broadcast('weather:station-1', 'reading', { temperature: 20 });
      expect(hub.getStats()).toMatchObject({
        connections: 2,
        indexedChannels: 1,
        subscriptions: 1,
        lastBroadcastCandidates: 0,
      });
    } finally {
      first.terminate();
      second.terminate();
      unrelated.terminate();
      await stopHub(server, hub);
    }
  });

  it('disconnects a slow subscriber and removes it from the index', async () => {
    process.env.WS_MAX_BUFFERED_BYTES = '1';
    const { server, hub, port } = await startHub();
    const slowClient = await openClient(port);

    try {
      await subscribe(slowClient, 'weather:slow-station');
      const socket = (
        slowClient as WebSocket & {
          _socket: { pause: () => void; resume: () => void };
        }
      )._socket;
      socket.pause();

      const largePayload = { reading: 'x'.repeat(4 * 1024 * 1024) };
      hub.broadcast('weather:slow-station', 'reading', largePayload);
      await new Promise(resolve => setImmediate(resolve));
      hub.broadcast('weather:slow-station', 'reading', largePayload);

      expect(hub.getStats()).toMatchObject({
        connections: 0,
        indexedChannels: 0,
        subscriptions: 0,
        backpressureDisconnects: 1,
      });
      const closed = once(slowClient, 'close');
      socket.resume();
      await closed;
    } finally {
      (
        slowClient as WebSocket & {
          _socket?: { resume: () => void };
        }
      )._socket?.resume();
      slowClient.terminate();
      await stopHub(server, hub);
    }
  });
});
