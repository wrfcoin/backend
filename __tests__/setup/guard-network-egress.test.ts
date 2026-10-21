/**
 * backend#1017 — the egress guard must block external hosts and permit loopback.
 *
 * Anti-vacuity matters more than usual here. A guard that blocks *everything*
 * would pass a "does it block?" test while breaking every suite that talks to a
 * local server, and a guard that blocks *nothing* would pass a "does loopback
 * work?" test while leaving the hole wide open. So both directions are asserted,
 * and the permit side uses a real local server rather than a mock — if the guard
 * were accidentally total, that server round-trip is what fails.
 *
 * RED control (guard removed from `setupFiles`, nothing else changed):
 * **6 of 8 fail** — the five deny-side tests, because the calls are then
 * attempted for real, plus the escape-hatch test, because `__realNetwork` only
 * exists when the guard installed it.
 *
 * The two loopback tests pass in BOTH directions by design: loopback works with
 * or without the guard. They are here to stop the guard from being "fixed" into
 * a total block, not as evidence that it blocks — and they are called out as
 * such rather than left to look like part of the RED signal.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import http from 'http';
import type { AddressInfo } from 'net';

describe('guard-network-egress (#1017)', () => {
  describe('denies external hosts', () => {
    it('blocks https.request to a live third-party API', () => {
      const https = require('https');
      expect(() =>
        https.request('https://api.axelarscan.io/gmp/searchGMP?txHash=0xdeadbeef'),
      ).toThrow(/Network egress blocked/);
    });

    it('blocks https.get — which does NOT route through https.request', () => {
      // Node's `get` closes over the module-local `request`, so a guard that
      // patched only `request` would leave this path open. That is the bug this
      // test exists for, not a duplicate of the one above.
      const https = require('https');
      expect(() => https.get('https://api-mainnet.layerzero-scan.com/tx/0xabc')).toThrow(
        /Network egress blocked/,
      );
    });

    it('blocks an options-object request (no URL string)', () => {
      const https = require('https');
      expect(() =>
        https.request({ hostname: 'api.axelarscan.io', path: '/gmp/getFees', protocol: 'https:' }),
      ).toThrow(/Network egress blocked/);
    });

    it('blocks global fetch — undici does not go through http.request', () => {
      expect(() => fetch('https://api.axelarscan.io/gmp/searchGMP')).toThrow(
        /Network egress blocked/,
      );
    });

    it('names the host it blocked, so the failure is diagnosable', () => {
      const https = require('https');
      expect(() => https.request('https://api.axelarscan.io/x')).toThrow(
        /api\.axelarscan\.io/,
      );
    });
  });

  describe('permits loopback — the guard must not be total', () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('allows a real round-trip to 127.0.0.1', async () => {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/`, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve(data));
          })
          .on('error', reject);
      });

      expect(body).toBe('ok');
    });

    it('allows an omitted host — node defaults it to localhost', () => {
      const req = http.request({ port, path: '/' });
      req.on('error', () => {});
      expect(() => req.destroy()).not.toThrow();
    });
  });

  it('exposes the unguarded originals as a deliberate escape hatch', () => {
    const real = (globalThis as unknown as { __realNetwork?: Record<string, unknown> })
      .__realNetwork;

    expect(real).toBeDefined();
    expect(typeof real!.httpsRequest).toBe('function');
    expect(typeof real!.httpsGet).toBe('function');
    expect(Array.isArray(real!.attempts)).toBe(true);
  });
});
