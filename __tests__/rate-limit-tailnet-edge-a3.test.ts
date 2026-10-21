/**
 * Per-IP rate limits behind the shared tailnet edge (lane be-station, A-3).
 *
 * Invitees reach the backend through `tailscale serve` -> docker-proxy (10.251.0.1) -> frontend
 * nginx (10.251.0.10) -> backend (infra docker-compose.testnet.yml TRUSTED_PROXIES). tailscaled
 * SETS X-Forwarded-For to the device's tailnet address, nginx appends its peer. Two problems this
 * suite pins:
 *  1. A device that connects over IPv6 has a Tailscale 4To6 address; express-rate-limit's IPv6 /56
 *     collapse (backend#1228) put EVERY such device into one bucket. They are now one bucket each.
 *  2. middleware/rateLimiting.js keyed on the LEFTMOST X-Forwarded-For entry (client-supplied when a
 *     hop appends), so a caller could pick its own key. It now uses the right-to-left walk.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

const PROXIES = '127.0.0.1,::1,10.251.0.1,10.251.0.10,10.251.0.11,10.251.0.12';
const ORIGINAL_ENV = { ...process.env };
process.env.TRUSTED_PROXIES = PROXIES;
process.env.NODE_ENV = 'test';
process.env.SILENT_LOGS = 'true';
process.env.DISABLE_FILE_LOG_TRANSPORTS = 'true';
delete process.env.REDIS_URL;

const mockCaptured: Array<Record<string, any>> = [];
jest.mock('express-rate-limit', () => {
  const actual = jest.requireActual('express-rate-limit') as any;
  const wrapped: any = (options: Record<string, any>) => { mockCaptured.push(options); return actual(options); };
  Object.assign(wrapped, actual);
  wrapped.default = wrapped; wrapped.rateLimit = wrapped; wrapped.__esModule = true;
  return wrapped;
});
jest.mock('redis', () => {
  const client = () => ({ on: jest.fn(), connect: jest.fn(() => Promise.reject(new Error('off'))), quit: jest.fn(async () => undefined), disconnect: jest.fn(async () => undefined), sendCommand: jest.fn(), isOpen: false });
  return { createClient: jest.fn(client), default: { createClient: jest.fn(client) } };
});

/* eslint-disable @typescript-eslint/no-var-requires */
const rateLimit = require('express-rate-limit');
const { tailnetIpv4 } = require('../server/utils/rateLimitEnhanced');
const { trustKnownProxy, normalizeTailnetClientIp } = require('../server/utils/trustedProxyConfig');

// Tailscale 4To6: fd7a:115c:a1e0:ab12:4843:cd96:62<b><c><d> <-> 100.<b>.<c>.<d>
const v6 = (b: number, c: number, d: number) =>
  `fd7a:115c:a1e0:ab12:4843:cd96:62${b.toString(16).padStart(2, '0')}:${c.toString(16).padStart(2, '0')}${d.toString(16).padStart(2, '0')}`;
const DEVICES = [v6(101, 25, 164), v6(101, 25, 165), v6(70, 3, 9), v6(88, 200, 1), v6(64, 0, 7)];

afterAll(() => { process.env = { ...ORIGINAL_ENV }; });

describe('tailnetIpv4 (Tailscale 4To6 -> the device IPv4)', () => {
  it('maps a 4To6 address back to 100.b.c.d, including compressed spellings', () => {
    expect(tailnetIpv4(v6(101, 25, 164))).toBe('100.101.25.164');
    expect(tailnetIpv4('fd7a:115c:a1e0:ab12:4843:cd96:6200:0001')).toBe('100.0.0.1');
    expect(tailnetIpv4('FD7A:115C:A1E0:AB12:4843:CD96:6265:19A4')).toBe('100.101.25.164');
    expect(tailnetIpv4('fd7a:115c:a1e0:ab12:4843:cd96:6200:1')).toBe('100.0.0.1');
  });
  it('leaves everything else unchanged', () => {
    for (const ip of ['198.51.100.7', '100.101.25.164', '2001:db8:1:2::1', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12:4843:cd96:6300:0001', '::1', 'not-an-ip', '', undefined as any, null as any]) {
      expect(tailnetIpv4(ip)).toBe(ip);
    }
  });
});

/** An app whose socket peer is set per request (x-test-peer) so the trusted-hop walk is exercised. */
function app(opts: { normalize: boolean; max: number }) {
  const a = express();
  a.set('trust proxy', trustKnownProxy);
  a.use((req, _res, next) => {
    const peer = req.headers['x-test-peer'];
    if (typeof peer === 'string') Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true });
    next();
  });
  if (opts.normalize) a.use(normalizeTailnetClientIp);
  // Default key generator, exactly like weatherPostLimiter / oracleSubmitLimiter.
  a.use(rateLimit({ windowMs: 60_000, max: opts.max, standardHeaders: true, legacyHeaders: false }));
  a.get('/ping', (req, res) => res.json({ ip: req.ip }));
  return a;
}
const via = (a: express.Express, xff: string, peer = '10.251.0.10') =>
  request(a).get('/ping').set('x-test-peer', peer).set('x-forwarded-for', xff);
// The edge chain as it reaches the backend: tailscaled set the device, nginx appended docker-proxy.
const edge = (device: string) => `${device}, 10.251.0.1`;

describe('many invitees behind one edge (default express-rate-limit key)', () => {
  it('each tailnet IPv6 device gets its own bucket', async () => {
    const a = app({ normalize: true, max: 2 });
    for (const device of DEVICES) {
      expect((await via(a, edge(device))).status).toBe(200);
      expect((await via(a, edge(device))).status).toBe(200);
    }
    // ...and a third request from one device is limited without touching the others.
    expect((await via(a, edge(DEVICES[0]))).status).toBe(429);
    expect((await via(a, edge(v6(100, 1, 1)))).status).toBe(200);
  });

  it('CONTROL: without the normalizer the same devices collapse into one bucket', async () => {
    const a = app({ normalize: false, max: 2 });
    const statuses = [];
    for (const device of DEVICES) statuses.push((await via(a, edge(device))).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('IPv4 tailnet devices and non-tailnet global IPv6 behave as before', async () => {
    const a = app({ normalize: true, max: 2 });
    for (const ip of ['100.101.25.164', '100.101.25.165', '100.70.3.9']) {
      expect((await via(a, edge(ip))).status).toBe(200);
      expect((await via(a, edge(ip))).status).toBe(200);
    }
    // A global IPv6 /56 is still one bucket (rotation inside an allocation cannot mint buckets).
    expect((await via(a, edge('2001:db8:1:2::1'))).status).toBe(200);
    expect((await via(a, edge('2001:db8:1:2:ffff::9'))).status).toBe(200);
    expect((await via(a, edge('2001:db8:1:2:aaaa::3'))).status).toBe(429);
  });

  it('req.ip is the device IPv4 after the normalizer', async () => {
    const res = await via(app({ normalize: true, max: 50 }), edge(v6(101, 25, 164)));
    expect(res.body.ip).toBe('100.101.25.164');
  });
});

describe('X-Forwarded-For cannot be spoofed past the edge (default key)', () => {
  it('client-prepended entries never choose the key: same real device, different forged leftmost -> one bucket', async () => {
    const a = app({ normalize: true, max: 2 });
    const real = v6(101, 25, 164);
    expect((await via(a, `1.1.1.1, ${edge(real)}`)).status).toBe(200);
    expect((await via(a, `2.2.2.2, ${edge(real)}`)).status).toBe(200);
    expect((await via(a, `3.3.3.3, ${edge(real)}`)).status).toBe(429);
    // and a forged entry naming ANOTHER device does not consume that device's bucket
    expect((await via(a, `${v6(64, 0, 7)}, ${edge(real)}`)).status).toBe(429);
    expect((await via(a, edge(v6(64, 0, 7)))).status).toBe(200);
  });

  it('a peer that is NOT a trusted hop has its X-Forwarded-For ignored', async () => {
    const a = app({ normalize: true, max: 2 });
    for (let i = 0; i < 2; i += 1) expect((await via(a, `${v6(1, 2, 3 + i)}`, '198.51.100.9')).status).toBe(200);
    expect((await via(a, `${v6(9, 9, 9)}`, '198.51.100.9')).status).toBe(429);
  });
});

describe('middleware/rateLimiting.js keys on the right-to-left client, not the leftmost XFF', () => {
  function limiterKeys() {
    mockCaptured.length = 0;
    jest.isolateModules(() => { require('../middleware/rateLimiting.js'); });
    return mockCaptured.filter((o) => typeof o.keyGenerator === 'function' && o.keyGenerator.name === 'secureKeyGenerator').map((o) => o.keyGenerator);
  }
  const req = (xff: string, peer = '10.251.0.10'): any => ({
    ip: peer, headers: { 'x-forwarded-for': xff }, body: {}, socket: { remoteAddress: peer }, connection: { remoteAddress: peer },
    get: (h: string) => (h.toLowerCase() === 'x-forwarded-for' ? xff : undefined),
  });

  it('a forged leftmost entry does not choose the key (spoof attempt)', () => {
    const keys = limiterKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key(req(`9.9.9.9, ${edge('100.101.25.164')}`))).toBe('100.101.25.164');
      expect(key(req(`8.8.8.8, ${edge('100.101.25.164')}`))).toBe('100.101.25.164');
    }
  });

  it('many invitees behind one edge get distinct keys, IPv4 and IPv6 alike', () => {
    for (const key of limiterKeys()) {
      const seen = new Set(DEVICES.map((d) => key(req(edge(d)))));
      expect(seen.size).toBe(DEVICES.length);
      expect(key(req(edge(v6(101, 25, 164))))).toBe('100.101.25.164');
    }
  });

  it('an untrusted peer is keyed on its own address whatever it sends', () => {
    for (const key of limiterKeys()) {
      expect(key(req('7.7.7.7', '198.51.100.9'))).toBe('198.51.100.9');
    }
  });
});

describe('the live entrypoint mounts the normalizer before any limiter', () => {
  it('enhanced_unified_api_optimized.ts: trust proxy, then normalizeTailnetClientIp, then the first rate limit', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(process.cwd(), 'server/enhanced_unified_api_optimized.ts'), 'utf8');
    const trust = src.indexOf("app.set('trust proxy', trustKnownProxy)");
    const norm = src.indexOf('app.use(normalizeTailnetClientIp)');
    const limit = src.indexOf('app.use(enhancedApiRateLimit)');
    expect(trust).toBeGreaterThan(-1);
    expect(norm).toBeGreaterThan(trust);
    expect(limit).toBeGreaterThan(norm);
  });
});
