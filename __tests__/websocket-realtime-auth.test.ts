/**
 * Auth on the websocket server the API entrypoint actually mounts
 * (server/enhanced_unified_api_optimized.ts -> server/websocket/index.ts).
 *
 * Real HTTP server, real ws client, real jsonwebtoken: nothing about the auth
 * decision is mocked. The sibling suites websocket-auth and
 * websocket-security-hardening cover shared/websocket and the standalone
 * cross-chain and secure-messaging servers, none of which that entrypoint loads.
 */
import { createServer, type Server } from 'http';
import { once } from 'events';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import {
  initializeRealtimeWebSocketServer,
  type RealtimeWebSocketHub,
} from '../server/websocket/index.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../server/auth/jwt-constants.js';

const SECRET = 'realtime-ws-auth-test-secret-0123456789';
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

type Msg = Record<string, any>;

function token(
  claims: Record<string, unknown> = { address: OWNER },
  options: jwt.SignOptions = {},
  secret = SECRET
): string {
  return jwt.sign(claims, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: 300,
    ...options,
  });
}

function unsignedToken(): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    address: OWNER,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 300,
  })}.`;
}

class Client {
  readonly inbox: Msg[] = [];
  private waiters: Array<() => void> = [];
  readonly closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', raw => {
      this.inbox.push(JSON.parse(raw.toString()));
      this.waiters.splice(0).forEach(wake => wake());
    });
    this.closed = new Promise(resolve => ws.on('close', code => resolve(code)));
  }

  async next(event: string, timeoutMs = 2_000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex(message => message.event === event);
      if (index !== -1) {
        return this.inbox.splice(index, 1)[0];
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${event}: ${JSON.stringify(this.inbox)}`);
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async trySubscribe(channel: string): Promise<'subscribed' | 'subscription_denied'> {
    this.ws.send(JSON.stringify({ action: 'subscribe', channel }));
    const deadline = Date.now() + 2_000;
    for (;;) {
      const message = this.inbox.find(
        m =>
          (m.event === 'subscribed' || m.event === 'subscription_denied') &&
          m.payload?.channel === channel
      );
      if (message) {
        this.inbox.splice(this.inbox.indexOf(message), 1);
        return message.event;
      }
      if (Date.now() > deadline) {
        throw new Error(`no subscribe answer for ${channel}`);
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

describe('realtime websocket auth on the mounted server', () => {
  const originalEnv = { ...process.env };
  let server: Server;
  let hub: RealtimeWebSocketHub;
  let port: number;
  const open: WebSocket[] = [];

  async function connect(options: ConstructorParameters<typeof WebSocket>[2] = {}, protocols?: string[], path = '/ws') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, options);
    ws.on('error', () => undefined);
    open.push(ws);
    return new Client(ws);
  }

  function bearer(value: string) {
    return { headers: { authorization: `Bearer ${value}` } };
  }

  async function start(env: Record<string, string | undefined> = {}) {
    process.env = { ...originalEnv, JWT_SECRET: SECRET, ...env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
    }
    server = createServer();
    hub = initializeRealtimeWebSocketServer(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as { port: number }).port;
  }

  afterEach(async () => {
    for (const ws of open.splice(0)) {
      ws.terminate();
    }
    await hub.close();
    await new Promise(resolve => server.close(resolve));
    process.env = { ...originalEnv };
  });

  describe('anonymous connection', () => {
    beforeEach(() => start());

    it('connects unauthenticated, reads public channels, and cannot read a wallet', async () => {
      const client = await connect();
      const hello = await client.next('connected');
      expect(hello.payload.authenticated).toBe(false);

      await expect(client.trySubscribe('blocks')).resolves.toBe('subscribed');
      await expect(client.trySubscribe(`wallet:${OWNER}`)).resolves.toBe('subscription_denied');
    });

    it('denies channels outside the allowlist', async () => {
      const client = await connect();
      await client.next('connected');
      for (const channel of ['admin', 'mining', 'wallet:', 'WALLET:' + OWNER, '__proto__']) {
        await expect(client.trySubscribe(channel)).resolves.toBe('subscription_denied');
      }
    });

    it('does not authenticate from a query-string token', async () => {
      const client = await connect({}, undefined, `/ws?token=${token()}`);
      const hello = await client.next('connected');
      expect(hello.payload.authenticated).toBe(false);
      await expect(client.trySubscribe(`wallet:${OWNER}`)).resolves.toBe('subscription_denied');
    });

    it('refuses an upgrade on any path other than /ws', async () => {
      for (const path of ['/ws/', '/api/ws', '//ws', '/WS']) {
        const client = await connect({}, undefined, path);
        const [error] = (await once(client.ws, 'error')) as [Error];
        expect(error.message).toMatch(/Unexpected server response: 400/);
      }
    });
  });

  describe('bearer token', () => {
    beforeEach(() => start());

    it('authenticates from the Authorization header and scopes the wallet channel to the owner', async () => {
      const client = await connect(bearer(token()));
      const hello = await client.next('connected');
      expect(hello.payload.authenticated).toBe(true);

      await expect(client.trySubscribe(`wallet:${OWNER}`)).resolves.toBe('subscribed');
      await expect(client.trySubscribe(`wallet:${OTHER}`)).resolves.toBe('subscription_denied');
    });

    it('authenticates from both Sec-WebSocket-Protocol forms', async () => {
      const value = token();
      for (const protocols of [['bearer', value], [`bearer.${value}`]]) {
        const client = await connect({}, protocols);
        const hello = await client.next('connected');
        expect(hello.payload.authenticated).toBe(true);
        await expect(client.trySubscribe(`wallet:${OWNER}`)).resolves.toBe('subscribed');
      }
    });

    it('matches the owner regardless of address case', async () => {
      const mixed = '0xAbCdEf0000000000000000000000000000000000';
      const client = await connect(bearer(token({ address: mixed })));
      await client.next('connected');
      await expect(client.trySubscribe(`wallet:${mixed.toLowerCase()}`)).resolves.toBe('subscribed');
    });

    it('delivers a wallet broadcast to the owner only', async () => {
      const owner = await connect(bearer(token()));
      const stranger = await connect(bearer(token({ address: OTHER })));
      const anonymous = await connect();
      await Promise.all([owner.next('connected'), stranger.next('connected'), anonymous.next('connected')]);
      await expect(owner.trySubscribe(`wallet:${OWNER}`)).resolves.toBe('subscribed');

      hub.broadcast(`wallet:${OWNER}`, 'tx_confirmed', { marker: 1 });
      const delivered = await owner.next('tx_confirmed');
      expect(delivered.payload).toEqual({ marker: 1 });

      // A later broadcast on a channel both others do hold marks the end of what they received.
      await stranger.trySubscribe('blocks');
      await anonymous.trySubscribe('blocks');
      hub.broadcast('blocks', 'new_block', { height: 1 });
      await Promise.all([stranger.next('new_block'), anonymous.next('new_block')]);
      expect(stranger.inbox.concat(anonymous.inbox).map(m => m.event)).not.toContain('tx_confirmed');
    });

    it.each([
      ['wrong signature', () => token({ address: OWNER }, {}, 'some-other-secret-0123456789')],
      ['wrong issuer', () => token({ address: OWNER }, { issuer: 'someone-else' })],
      ['wrong audience', () => token({ address: OWNER }, { audience: 'someone-else' })],
      ['expired', () => token({ address: OWNER }, { expiresIn: -10 })],
      ['unsigned alg=none', unsignedToken],
      ['not a jwt', () => 'not-a-jwt'],
      ['no identity claims', () => token({ scope: 'x' })],
    ])('closes the connection with 1008 and grants nothing: %s', async (_name, makeToken) => {
      const client = await connect(bearer(makeToken()));
      await expect(client.closed).resolves.toBe(1008);
      expect(client.inbox).toEqual([]);
      expect(hub.getStats().connections).toBe(0);
    });
  });

  it('fails closed on a presented token when JWT_SECRET is unset', async () => {
    await start({ JWT_SECRET: undefined });
    const client = await connect(bearer(token()));
    await expect(client.closed).resolves.toBe(1008);
    expect(client.inbox).toEqual([]);
  });

  it('enforces the subscription limit', async () => {
    await start({ WS_MAX_SUBSCRIPTIONS: '1' });
    const client = await connect();
    await client.next('connected');
    await expect(client.trySubscribe('blocks')).resolves.toBe('subscribed');
    await expect(client.trySubscribe('governance')).resolves.toBe('subscription_denied');
  });

  it('enforces the connection limit', async () => {
    await start({ WS_MAX_CONNECTIONS: '1' });
    const first = await connect();
    await first.next('connected');
    const second = await connect();
    await expect(second.closed).resolves.toBe(1013);
    expect(second.inbox).toEqual([]);
  });
});
