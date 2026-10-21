/**
 * backend#1395: backend -> core4 admin-method calls must carry no Sec-Fetch-*
 * header (Node's global fetch always sends sec-fetch-mode: cors, which core4's
 * Origin guard reads as a browser and refuses with 403 ORIGIN_REQUIRED).
 *
 * Runs against a REAL local HTTP server, not an injected fetchImpl.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchChainStationList } from '../server/services/chain-station-sync.js';
import { nodeRegistrationFetcher } from '../server/services/chain-station-backfill.js';
import { nodeHttpFetch } from '../shared/core4-node-http.js';
import { fetchCore4Json } from '../shared/core4-route-client.js';

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
}

let server: http.Server;
let base: string;
let seen: Seen[] = [];
let status = 200;
let handler: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (handler && handler(req, res)) return;
    // Model the core4 guard: any Sec-Fetch-* header without an Origin is refused.
    const browserish = Object.keys(req.headers).some((h) => h.startsWith('sec-fetch-'));
    if (browserish && !req.headers.origin) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'ORIGIN_REQUIRED' } }));
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stations: [], has_more: false }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen = [];
  status = 200;
  handler = null;
});

const secFetch = (h: http.IncomingHttpHeaders) => Object.keys(h).filter((k) => k.startsWith('sec-fetch-'));

describe('backend -> core4 admin calls carry no Sec-Fetch-* (#1395)', () => {
  it('fetchChainStationList default transport: no sec-fetch-*, Bearer + Accept arrive', async () => {
    await expect(fetchChainStationList(base, 'op-token')).resolves.toEqual([]);
    expect(seen).toHaveLength(1);
    expect(secFetch(seen[0].headers)).toEqual([]);
    expect(seen[0].headers.authorization).toBe('Bearer op-token');
    expect(seen[0].headers.accept).toBe('application/json');
    expect(seen[0].url).toMatch(/^\/transactions\/station\/registrations\?limit=/);
  });

  it('non-2xx maps to the same SafeDiagnosticError text as before', async () => {
    status = 503;
    await expect(fetchChainStationList(base, 'op-token')).rejects.toThrow('node station list answered HTTP 503');
  });

  it('nodeRegistrationFetcher default transport: no sec-fetch-*, 404 -> null', async () => {
    status = 404;
    await expect(nodeRegistrationFetcher(base, 'op-token')('s1')).resolves.toBeNull();
    expect(secFetch(seen[0].headers)).toEqual([]);
  });

  it('fetchCore4Json sends admin routes without sec-fetch-* and keeps its result shape', async () => {
    process.env.CORE4_API_URL = base;
    try {
      const res = await fetchCore4Json('/rewards/payout', {
        method: 'POST',
        headers: { authorization: 'Bearer op-token' },
        body: { a: 1 },
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(secFetch(seen[0].headers)).toEqual([]);
      expect(seen[0].headers['content-type']).toBe('application/json');
    } finally {
      delete process.env.CORE4_API_URL;
    }
  });

  it('every fetchCore4Json route, any verb, leaves without sec-fetch-* (no classifier)', async () => {
    process.env.CORE4_API_URL = base;
    try {
      const routes: Array<[string, string]> = [
        ['POST', 'layer2/submit-batch'],
        ['POST', '/transactions/oracle/registrations'],
        ['PUT', '/transactions/oracle/config'],
        ['POST', '/operator/mempool/purge'],
        ['POST', '/bridge/safety/halt'],
        ['GET', '/network/peers/reputation'],
        ['GET', '/blockchain'],
        ['GET', '/a/../transactions/station/registrations#frag'],
      ];
      for (const [method, path] of routes) {
        const res = await fetchCore4Json(path, { method, headers: { authorization: 'Bearer t' } });
        expect(res.ok).toBe(true);
      }
      expect(seen).toHaveLength(routes.length);
      for (const r of seen) expect(secFetch(r.headers)).toEqual([]);
    } finally {
      delete process.env.CORE4_API_URL;
    }
  });

  it('normalizes tuple-array and Headers inputs, dropping caller sec-fetch-*', async () => {
    await nodeHttpFetch(`${base}/x`, {
      headers: [['Authorization', 'Bearer tup'], ['Accept', 'application/json'], ['Sec-Fetch-Mode', 'cors']],
    });
    await nodeHttpFetch(`${base}/x`, { headers: new Headers({ Authorization: 'Bearer hd', 'Sec-Fetch-Site': 'x' }) });
    expect(seen[0].headers.authorization).toBe('Bearer tup');
    expect(seen[0].headers.accept).toBe('application/json');
    expect(seen[1].headers.authorization).toBe('Bearer hd');
    for (const r of seen) expect(secFetch(r.headers)).toEqual([]);
  });

  it('follows redirects: 307 keeps method+body+auth; 303 becomes GET without body', async () => {
    handler = (req, res) => {
      if (req.url === '/r307') { res.writeHead(307, { location: '/final' }); res.end(); return true; }
      if (req.url === '/r303') { res.writeHead(303, { location: '/final' }); res.end(); return true; }
      return false;
    };
    const a = await nodeHttpFetch(`${base}/r307`, { method: 'POST', body: '{"a":1}', headers: { authorization: 'Bearer t', 'content-type': 'application/json' } });
    expect(a.status).toBe(200);
    const hop = seen[1];
    expect(hop.method).toBe('POST');
    expect(hop.headers.authorization).toBe('Bearer t');
    const b = await nodeHttpFetch(`${base}/r303`, { method: 'POST', body: '{"a":1}', headers: { authorization: 'Bearer t' } });
    expect(b.status).toBe(200);
    expect(seen[3].method).toBe('GET');
    expect(seen[3].headers['content-length']).toBeUndefined();
    for (const r of seen) expect(secFetch(r.headers)).toEqual([]);
  });

  it('strips Authorization on a cross-origin redirect and bounds the hop count', async () => {
    const other = http.createServer((req, res) => {
      seen.push({ method: req.method, url: `other${req.url}`, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      handler = (req, res) => {
        if (req.url === '/x') { res.writeHead(302, { location: `${otherBase}/landed` }); res.end(); return true; }
        if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return true; }
        return false;
      };
      await nodeHttpFetch(`${base}/x`, { headers: { authorization: 'Bearer t' } });
      const landed = seen.find((r) => r.url === 'other/landed')!;
      expect(landed.headers.authorization).toBeUndefined();
      expect(secFetch(landed.headers)).toEqual([]);
      await expect(nodeHttpFetch(`${base}/loop`)).rejects.toThrow('redirect limit');
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it('requests identity encoding and refuses an encoded response with a fixed error', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
      res.end(Buffer.from([0x1f, 0x8b, 0x08]));
      return true;
    };
    const res = await nodeHttpFetch(`${base}/x`);
    expect(seen[0].headers['accept-encoding']).toBe('identity');
    await expect(res.json()).rejects.toThrow('node response has an unsupported content-encoding');
    await expect(res.text()).rejects.toThrow('unsupported content-encoding');
  });
});
