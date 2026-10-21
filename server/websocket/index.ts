import type { IncomingMessage, Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../auth/jwt-constants.js';
import { WebSocketServer, WebSocket } from 'ws';
import { appLogger } from '../utils/logger.js';
import { getCore4ApiUrl } from '../../src/config/core4.js';
// ws-channels.js is CJS; import the .cjs shim so require() isn't needed at ESM runtime.
import _wsChannelsMod from '../utils/ws-channels.js';
const { CHANNELS } = _wsChannelsMod as { CHANNELS: Record<string, string> };

type Channel = string;

interface AuthContext {
  userId: string;
  address?: string;
}

interface ClientState {
  id: string;
  auth: AuthContext | null;
  subscriptions: Set<Channel>;
  missedPongs: number;
}

interface BlockEvent {
  height: number;
  hash?: string;
  tx_count?: number;
  timestamp?: string;
  raw?: unknown;
}

interface PollState {
  latestHeight: number;
}

export interface RealtimeWebSocketHub {
  broadcast: (channel: string, event: string, payload: unknown) => void;
  getStats: () => RealtimeWebSocketHubStats;
  close: () => Promise<void>;
}

export interface RealtimeWebSocketHubStats {
  connections: number;
  indexedChannels: number;
  subscriptions: number;
  lastBroadcastCandidates: number;
  backpressureDisconnects: number;
}

const PUBLIC_CHANNELS = new Set([CHANNELS.BLOCKCHAIN, CHANNELS.BLOCKS, CHANNELS.GOVERNANCE]);

function makeClientId(): string {
  return `ws_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function extractTokenFromProtocolHeader(
  headerValue: string | string[] | undefined
): string | null {
  const rawValues = Array.isArray(headerValue)
    ? headerValue
    : typeof headerValue === 'string'
      ? [headerValue]
      : [];

  const candidates = rawValues
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);

  const bearerIndex = candidates.findIndex(
    value => value.toLowerCase() === 'bearer'
  );
  if (bearerIndex !== -1 && candidates[bearerIndex + 1]) {
    return candidates[bearerIndex + 1];
  }

  const prefixedToken = candidates.find(value =>
    value.toLowerCase().startsWith('bearer.')
  );
  if (prefixedToken) {
    return prefixedToken.slice('bearer.'.length);
  }

  return null;
}

function parseToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }

  return extractTokenFromProtocolHeader(
    req.headers['sec-websocket-protocol']
  );
}

function decodeToken(token: string): AuthContext | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as jwt.JwtPayload;

    const address =
      typeof decoded.address === 'string'
        ? decoded.address
        : typeof decoded.sub === 'string'
          ? decoded.sub
          : undefined;

    const userId =
      typeof decoded.userId === 'string'
        ? decoded.userId
        : typeof decoded.sub === 'string'
          ? decoded.sub
          : address;

    if (!userId) {
      return null;
    }

    return { userId, address };
  } catch {
    return null;
  }
}

function canSubscribe(state: ClientState, channel: string): boolean {
  if (PUBLIC_CHANNELS.has(channel)) {
    return true;
  }

  if (channel.startsWith('wallet:')) {
    const requested = channel.replace('wallet:', '').toLowerCase();
    const owned = (state.auth?.address || '').toLowerCase();
    return requested.length > 0 && owned.length > 0 && requested === owned;
  }

  if (channel.startsWith('weather:')) {
    return true;
  }

  return false;
}

export async function fetchCore4Json(path: string): Promise<unknown> {
  const baseUrl = getCore4ApiUrl();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const token = process.env.WRFCOIN_OPERATOR_TOKEN;
  if (!token) {
    throw new Error(
      'WRFCOIN_OPERATOR_TOKEN is not set — cannot make authenticated calls to core4'
    );
  }
  headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${baseUrl}${path}`, { method: 'GET', headers });
  if (!response.ok) {
    throw new Error(`core4 ${path} status ${response.status}`);
  }
  return response.json();
}

function extractHeight(data: unknown): number | null {
  if (typeof data === 'number' && Number.isFinite(data)) {
    return data;
  }

  if (!data || typeof data !== 'object') {
    return null;
  }

  const record = data as Record<string, unknown>;
  const candidates = [
    record.height,
    record.blockHeight,
    record.currentHeight,
    (record.data as Record<string, unknown> | undefined)?.height,
    (record.data as Record<string, unknown> | undefined)?.blockHeight,
  ];

  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

async function fetchLatestHeight(): Promise<number> {
  const endpoints = [
    '/api/blockchain/height',
    '/blockchain',
    '/api/blockchain/status',
    '/status',
  ];

  for (const endpoint of endpoints) {
    try {
      const data = await fetchCore4Json(endpoint);
      const height = extractHeight(data);
      if (height !== null) {
        return height;
      }
    } catch {
      // try next endpoint
    }
  }

  throw new Error('Unable to resolve block height from core4');
}

async function fetchBlock(height: number): Promise<BlockEvent> {
  const endpoints = [
    `/blocks/${height}`,
    `/api/blockchain/blocks/${height}`,
    `/api/blockchain/block/${height}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const data = await fetchCore4Json(endpoint);
      const block = data as Record<string, unknown>;
      const txs = Array.isArray(block.transactions)
        ? (block.transactions as unknown[])
        : Array.isArray((block.data as Record<string, unknown> | undefined)?.transactions)
          ? (((block.data as Record<string, unknown>).transactions || []) as unknown[])
          : [];

      const hashValue =
        typeof block.hash === 'string'
          ? block.hash
          : typeof (block.data as Record<string, unknown> | undefined)?.hash === 'string'
            ? ((block.data as Record<string, unknown>).hash as string)
            : undefined;

      const timestampValue =
        typeof block.timestamp === 'string'
          ? block.timestamp
          : typeof (block.data as Record<string, unknown> | undefined)?.timestamp === 'string'
            ? ((block.data as Record<string, unknown>).timestamp as string)
            : new Date().toISOString();

      return {
        height,
        hash: hashValue,
        tx_count: txs.length,
        timestamp: timestampValue,
        raw: data,
      };
    } catch {
      // try next endpoint
    }
  }

  try {
    const chainState = (await fetchCore4Json('/blockchain')) as Record<string, unknown>;
    const chainHeight = extractHeight(chainState);
    const chainHash =
      typeof chainState.tip === 'string'
        ? chainState.tip
        : typeof (chainState.data as Record<string, unknown> | undefined)?.tip === 'string'
          ? ((chainState.data as Record<string, unknown>).tip as string)
          : typeof chainState.hash === 'string'
            ? chainState.hash
            : typeof (chainState.data as Record<string, unknown> | undefined)?.hash === 'string'
              ? ((chainState.data as Record<string, unknown>).hash as string)
              : undefined;

    if (chainHeight === height && chainHash) {
      return {
        height,
        hash: chainHash,
        tx_count: 0,
        timestamp: new Date().toISOString(),
        raw: chainState,
      };
    }
  } catch {
    // fall through to minimal payload
  }

  return {
    height,
    tx_count: 0,
    timestamp: new Date().toISOString(),
  };
}

export function initializeRealtimeWebSocketServer(server: HttpServer): RealtimeWebSocketHub {
  const maxConnections = Number(process.env.WS_MAX_CONNECTIONS || '1000');
  const maxSubscriptions = Number(process.env.WS_MAX_SUBSCRIPTIONS || '10');
  const maxBufferedBytes = Number(
    process.env.WS_MAX_BUFFERED_BYTES || String(1024 * 1024)
  );

  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Map<WebSocket, ClientState>();
  const subscribersByChannel = new Map<Channel, Set<WebSocket>>();
  const pollState: PollState = { latestHeight: -1 };
  let lastBroadcastCandidates = 0;
  let backpressureDisconnects = 0;

  function removeSubscription(ws: WebSocket, channel: Channel): void {
    const subscribers = subscribersByChannel.get(channel);
    if (!subscribers) {
      return;
    }

    subscribers.delete(ws);
    if (subscribers.size === 0) {
      subscribersByChannel.delete(channel);
    }
  }

  function removeClient(ws: WebSocket): void {
    const state = clients.get(ws);
    if (state) {
      for (const channel of state.subscriptions) {
        removeSubscription(ws, channel);
      }
    }
    clients.delete(ws);
  }

  function addSubscription(
    ws: WebSocket,
    state: ClientState,
    channel: Channel
  ): void {
    if (state.subscriptions.has(channel)) {
      return;
    }

    state.subscriptions.add(channel);
    const subscribers = subscribersByChannel.get(channel) || new Set<WebSocket>();
    subscribers.add(ws);
    subscribersByChannel.set(channel, subscribers);
  }

  function send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (ws.bufferedAmount > maxBufferedBytes) {
      backpressureDisconnects += 1;
      removeClient(ws);
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function broadcast(channel: string, event: string, payload: unknown): void {
    const message = {
      channel,
      event,
      payload,
      timestamp: new Date().toISOString(),
    };

    const subscribers = subscribersByChannel.get(channel);
    lastBroadcastCandidates = subscribers?.size || 0;
    if (!subscribers) {
      return;
    }

    for (const ws of subscribers) {
      send(ws, message);
    }
  }

  function processWalletAndWeatherEvents(block: BlockEvent): void {
    const raw = block.raw as Record<string, unknown> | undefined;
    const txs = Array.isArray(raw?.transactions)
      ? (raw?.transactions as unknown[])
      : Array.isArray((raw?.data as Record<string, unknown> | undefined)?.transactions)
        ? (((raw?.data as Record<string, unknown>).transactions || []) as unknown[])
        : [];

    for (const tx of txs) {
      if (!tx || typeof tx !== 'object') {
        continue;
      }

      const txRecord = tx as Record<string, unknown>;
      const fromAddress = typeof txRecord.from === 'string'
        ? txRecord.from
        : typeof txRecord.from_address === 'string'
          ? txRecord.from_address
          : undefined;
      const toAddress = typeof txRecord.to === 'string'
        ? txRecord.to
        : typeof txRecord.to_address === 'string'
          ? txRecord.to_address
          : undefined;

      if (fromAddress) {
        broadcast(`wallet:${fromAddress.toLowerCase()}`, 'tx_confirmed', {
          direction: 'outgoing',
          tx: txRecord,
          blockHeight: block.height,
        });
      }

      if (toAddress) {
        broadcast(`wallet:${toAddress.toLowerCase()}`, 'tx_confirmed', {
          direction: 'incoming',
          tx: txRecord,
          blockHeight: block.height,
        });
      }

      const stationId =
        typeof txRecord.station_id === 'string'
          ? txRecord.station_id
          : typeof txRecord.stationId === 'string'
            ? txRecord.stationId
            : undefined;

      if (stationId) {
        broadcast(`weather:${stationId}`, 'reading_submitted', {
          stationId,
          tx: txRecord,
          blockHeight: block.height,
        });
      }

      const txType = typeof txRecord.type === 'string' ? txRecord.type.toLowerCase() : '';
      if (txType.includes('govern') || txType.includes('proposal') || txType.includes('vote')) {
        broadcast('governance', 'governance_event', {
          tx: txRecord,
          blockHeight: block.height,
        });
      }
    }
  }

  async function pollBlocks(): Promise<void> {
    let latestHeight: number;
    try {
      latestHeight = await fetchLatestHeight();
    } catch (error) {
      appLogger.debug('WebSocket poll skipped: cannot fetch latest height', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (pollState.latestHeight < 0) {
      pollState.latestHeight = latestHeight;
      return;
    }

    if (latestHeight <= pollState.latestHeight) {
      return;
    }

    for (let h = pollState.latestHeight + 1; h <= latestHeight; h += 1) {
      const block = await fetchBlock(h);
      broadcast(CHANNELS.BLOCKS, 'new_block', {
        height: block.height,
        hash: block.hash,
        tx_count: block.tx_count,
        timestamp: block.timestamp,
      });
      processWalletAndWeatherEvents(block);
    }

    pollState.latestHeight = latestHeight;
  }

  const blockPollTimer = setInterval(() => {
    pollBlocks().catch(error => {
      appLogger.warn('WebSocket block polling error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 5_000);

  const heartbeatTimer = setInterval(() => {
    for (const [ws, state] of clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (state.missedPongs >= 3) {
        ws.terminate();
        removeClient(ws);
        continue;
      }

      state.missedPongs += 1;
      ws.ping();
    }
  }, 30_000);

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    if (clients.size >= maxConnections) {
      ws.close(1013, 'Connection limit reached');
      return;
    }

    const token = parseToken(req);
    const auth = token ? decodeToken(token) : null;
    if (token && !auth) {
      ws.close(1008, 'Invalid authentication token');
      return;
    }

    const state: ClientState = {
      id: makeClientId(),
      auth,
      subscriptions: new Set<Channel>(),
      missedPongs: 0,
    };

    clients.set(ws, state);

    send(ws, {
      event: 'connected',
      payload: {
        connectionId: state.id,
        authenticated: Boolean(auth),
        maxSubscriptions,
        availableChannels: [CHANNELS.BLOCKS, CHANNELS.GOVERNANCE, 'wallet:{address}', 'weather:{stationId}'],
      },
    });

    ws.on('pong', () => {
      state.missedPongs = 0;
    });

    ws.on('message', raw => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        send(ws, { event: 'error', payload: { message: 'Invalid JSON payload' } });
        return;
      }

      const action = typeof msg.action === 'string' ? msg.action : '';
      const channelInput = msg.channel;
      const channels = Array.isArray(msg.channels)
        ? (msg.channels as unknown[]).filter((c): c is string => typeof c === 'string')
        : typeof channelInput === 'string'
          ? [channelInput]
          : [];

      if (!action || channels.length === 0) {
        send(ws, {
          event: 'error',
          payload: { message: 'action and channel/channels are required' },
        });
        return;
      }

      if (action === 'subscribe') {
        for (const channel of channels) {
          if (!canSubscribe(state, channel)) {
            send(ws, {
              event: 'subscription_denied',
              payload: { channel, reason: 'not authorized for channel' },
            });
            continue;
          }

          if (!state.subscriptions.has(channel) && state.subscriptions.size >= maxSubscriptions) {
            send(ws, {
              event: 'subscription_denied',
              payload: { channel, reason: 'subscription limit reached' },
            });
            continue;
          }

          addSubscription(ws, state, channel);
          send(ws, { event: 'subscribed', payload: { channel } });
        }
        return;
      }

      if (action === 'unsubscribe') {
        for (const channel of channels) {
          state.subscriptions.delete(channel);
          removeSubscription(ws, channel);
          send(ws, { event: 'unsubscribed', payload: { channel } });
        }
        return;
      }

      send(ws, { event: 'error', payload: { message: `Unknown action: ${action}` } });
    });

    ws.on('close', () => {
      removeClient(ws);
    });

    ws.on('error', error => {
      appLogger.warn('WebSocket client error', {
        connectionId: state.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  appLogger.info('Realtime WebSocket server initialized', {
    path: '/ws',
    maxConnections,
    maxSubscriptions,
  });

  return {
    broadcast,
    getStats() {
      let subscriptions = 0;
      for (const subscribers of subscribersByChannel.values()) {
        subscriptions += subscribers.size;
      }
      return {
        connections: clients.size,
        indexedChannels: subscribersByChannel.size,
        subscriptions,
        lastBroadcastCandidates,
        backpressureDisconnects,
      };
    },
    async close() {
      clearInterval(blockPollTimer);
      clearInterval(heartbeatTimer);

      for (const ws of clients.keys()) {
        try {
          ws.close(1001, 'Server shutting down');
        } catch {
          // ignore close errors
        }
      }

      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
