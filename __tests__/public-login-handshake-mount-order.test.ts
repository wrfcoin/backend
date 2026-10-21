/**
 * Public login-handshake mount-order regression test.
 *
 * Root cause this pins down:
 *   server/routes/wrfsentinel-crosspost-routes.ts registered its auth chain as
 *   an UNSCOPED `router.use(authenticate, requireCrossPostWrite)`, and
 *   server/enhanced_unified_api_optimized.ts mounts that router with NO path
 *   (`app.use(createWrfsentinelCrossPostRouter({...}))`, i.e. mount path '/').
 *   Router-level middleware with no path runs for EVERY request entering the
 *   router, so every route registered after that mount — the whole safeMount
 *   table and the inline catch-all dispatcher — was gated behind
 *   authenticateToken and answered 401 "Bearer Token Required".
 *
 *   That silently broke the public login handshake: a brand-new user could not
 *   fetch a nonce, so they could not sign in at all.
 *
 * Why the existing suites missed it:
 *   - The wallet-auth unit tests call generateNonce()/walletLogin() on the
 *     service directly, never through Express.
 *   - launch-path-smoke.test.ts mocks authenticateToken to a pass-through, so
 *     an over-broad auth gate is invisible to it.
 *   - __tests__/wrfsentinel-crosspost-routes.test.ts mounts the router into a
 *     bare app that has no other routes, so an unscoped `.use` looks correct.
 *
 * This test therefore boots the REAL entrypoint as a child process and drives
 * real HTTP requests through the genuine middleware stack.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const entrypoint = path.join(repoRoot, 'server/enhanced_unified_api_optimized.ts');
const preload = path.join(__dirname, 'fixtures/public-login-handshake-preload.cjs');
const jwtSecret = 'login-handshake-test-secret-with-at-least-32-characters';

// A syntactically valid EVM address — generateNonce rejects anything else.
const TEST_ADDRESS = '0x1111111111111111111111111111111111111111';

type Runtime = { child: ChildProcess; port: number; output: string };

let runtime: Runtime;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('could not allocate test port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.once('error', reject);
  });
}

async function waitForPort(rt: Runtime, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (rt.child.exitCode !== null || rt.child.signalCode !== null) {
      throw new Error(`server exited before listening\n${rt.output}`);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: rt.port });
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`server did not listen on ${rt.port} within ${timeoutMs}ms\n${rt.output}`);
}

async function startRuntime(): Promise<Runtime> {
  const port = await getFreePort();
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`]
    .filter(Boolean)
    .join(' ');
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      PORT: String(port),
      NODE_ENV: 'test',
      JWT_SECRET: jwtSecret,
      WRFCOIN_OPERATOR_TOKEN: 'login-handshake-test-operator-token',
      ENCRYPTION_KEY: 'login-handshake-test-encryption-key-32-chars',
      DATABASE_URL: 'postgresql://127.0.0.1:59999/login-handshake-test',
      REDIS_URL: 'redis://127.0.0.1:59999',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rt: Runtime = { child, port, output: '' };
  child.stdout?.on('data', (chunk: Buffer) => {
    rt.output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    rt.output += chunk.toString();
  });
  await waitForPort(rt);
  return rt;
}

async function call(
  method: string,
  urlPath: string,
  body?: unknown
): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

/** The exact 401 envelope emitted by authenticateToken (auth-middleware.ts). */
function isBearerTokenRequiredEnvelope(body: any): boolean {
  return body?.error === 'Bearer Token Required';
}

beforeAll(async () => {
  runtime = await startRuntime();
}, 90_000);

afterAll(async () => {
  if (!runtime?.child) return;
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill('SIGTERM');
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8_000);
    runtime.child.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
});

describe('public login handshake is reachable through the real middleware stack', () => {
  it('serves /api/live (harness sanity control)', async () => {
    const res = await call('GET', '/api/live');
    expect(res.status).toBe(200);
  });

  it('returns an honest 501 for the unwired smart-contract graph', async () => {
    const res = await call('GET', '/api/smart-contracts/graph');

    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      unavailable: true,
      error: {
        code: 'NOT_IMPLEMENTED',
        capability: 'smart-contracts.graph',
        see: 'wrfcoin/smart-contracts#238',
      },
    });
  });

  it('GET /api/auth/nonce/:address is PUBLIC and returns a nonce', async () => {
    const res = await call('GET', `/api/auth/nonce/${TEST_ADDRESS}`);

    // The precise regression: an over-broad auth gate answers 401
    // "Bearer Token Required" here, which breaks new-user onboarding.
    expect(isBearerTokenRequiredEnvelope(res.body)).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(typeof res.body?.data?.nonce).toBe('string');
    expect(res.body.data.nonce.length).toBeGreaterThan(0);
  });

  it('POST /api/auth/wallet-login is PUBLIC (reaches the handler, not the auth gate)', async () => {
    // An empty body legitimately fails wallet login, but it must fail from the
    // HANDLER, never from a Bearer-token gate in front of it.
    const res = await call('POST', '/api/auth/wallet-login', {});

    expect(isBearerTokenRequiredEnvelope(res.body)).toBe(false);
    expect(res.body?.message).not.toBe(
      'Please provide a Bearer token in the Authorization header'
    );
  });

  it('ed25519 login over real HTTP: vector key gets sub = vector address; wrong address and replay are 401', async () => {
    const vector = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'contract-fixtures/wallet-key-scheme-vector.json'), 'utf8'),
    );
    const seed = crypto.pbkdf2Sync(vector.mnemonic, 'mnemonic', 2048, 64, 'sha512');
    const secret = crypto.createHmac('sha512', 'ed25519 seed').update(seed).digest().subarray(0, 32);
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret]),
      format: 'der',
      type: 'pkcs8',
    });
    const pubkey = Buffer.from(vector.public_key_bytes).toString('hex');
    const sign = (message: string) =>
      crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');

    const nonceRes = await call('GET', `/api/auth/nonce/${vector.address}?scheme=ed25519`);
    expect(nonceRes.status).toBe(200);
    const challenge = nonceRes.body.data;
    expect(challenge.scheme).toBe('ed25519');
    expect(challenge.message.split('\n')[0]).toBe('wrfcoin_wallet_login_ed25519_v1');

    const body = {
      scheme: 'ed25519',
      address: vector.address,
      pubkey,
      signature: sign(challenge.message),
      nonce: challenge.nonce,
    };
    const wrongAddress = await call('POST', '/api/auth/wallet-login', {
      ...body,
      address: TEST_ADDRESS,
    });
    expect(wrongAddress.status).toBe(401);

    const login = await call('POST', '/api/auth/wallet-login', body);
    expect(login.status).toBe(200);
    const claims = JSON.parse(
      Buffer.from(login.body.data.jwt.split('.')[1], 'base64url').toString('utf8'),
    );
    expect(claims.sub).toBe(vector.address);
    expect(claims.wallet_scheme).toBe('ed25519');

    const replay = await call('POST', '/api/auth/wallet-login', body);
    expect(replay.status).toBe(401);
  });

  describe('auth is NOT weakened elsewhere', () => {
    it('still rejects an unauthenticated protected route on the same dispatcher', async () => {
      // Same inline catch-all dispatcher as the nonce route above, but this one
      // calls requireAuthenticatedRequest — so it must STILL be 401.
      const res = await call('POST', '/api/resilience/participation/audit-events', {
        source: 'test',
        ruleId: 'test',
        action: 'test',
      });
      expect(res.status).toBe(401);
    });

    it('still rejects unauthenticated wrfsentinel cross-post writes', async () => {
      for (const crossPostPath of [
        '/v1/social-feed',
        '/v1/reports',
        '/api/social/feed',
        '/api/environment/reports',
      ]) {
        const res = await call('POST', crossPostPath, {
          content: 'Flood warning',
          location: { lat: 47.6, lng: -122.3 },
        });
        expect({ crossPostPath, status: res.status }).toEqual({
          crossPostPath,
          status: 401,
        });
      }
    });
  });
});
