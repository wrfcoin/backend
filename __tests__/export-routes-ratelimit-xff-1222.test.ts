/**
 * backend#1222: the export endpoints' per-IP rate limit was keyed on the
 * LEFTMOST X-Forwarded-For entry, which the client writes. Rotating that header
 * gave every request a fresh bucket. The key now comes from the shared resolver
 * (trusted proxies only, walked right to left).
 */
import { EventEmitter } from 'node:events';
import { handleWeatherExportRequest, resetWeatherExportRateLimiter } from '../server/routes/export-routes.js';

function fakeCall(peer: string, xff: string | undefined) {
  const req: any = Object.assign(new EventEmitter(), {
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: peer },
    method: 'GET',
  });
  let status = 0;
  const res: any = { writeHead: (s: number) => { status = s; }, setHeader: () => {}, end: () => {}, write: () => true, on: () => res, once: () => res };
  return handleWeatherExportRequest({
    path: '/api/v1/export/stations/station-x/observations',
    method: 'GET',
    query: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T23:59:59.000Z', format: 'json' },
    req,
    res,
    executeQuery: async () => ({ rows: [] }),
  }).then(() => status);
}

describe('export rate-limit key is not client-controlled (backend#1222)', () => {
  beforeEach(() => resetWeatherExportRateLimiter());

  it('an untrusted public peer cannot rotate X-Forwarded-For to get fresh buckets', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push(await fakeCall('203.0.113.9', `198.51.100.${i + 1}`));
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('behind a trusted proxy the client is the rightmost untrusted hop; a spoofed leftmost entry does not rotate the key', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push(await fakeCall('127.0.0.1', `10.9.9.${i + 1}, 198.51.100.7`));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('two genuinely different clients behind the trusted proxy keep separate buckets', async () => {
    for (let i = 0; i < 10; i += 1) expect(await fakeCall('127.0.0.1', '198.51.100.7')).toBe(200);
    expect(await fakeCall('127.0.0.1', '198.51.100.7')).toBe(429);
    expect(await fakeCall('127.0.0.1', '198.51.100.8')).toBe(200);
  });
});
