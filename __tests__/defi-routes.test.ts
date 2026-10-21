import express from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import defiRouter from '../server/routes/defi-routes';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/defi', defiRouter);
  return instance;
}

function response(payload: unknown, status = 200) {
  return new globalThis.Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('defi-node fail-closed proxy', () => {
  afterEach(() => {
    delete process.env.DEFI_NODE_URL;
    jest.restoreAllMocks();
  });

  it('returns the honest 501 envelope on every route when unconfigured', async () => {
    for (const probe of [
      request(app()).get('/api/defi/pools'),
      request(app()).post('/api/defi/pools/1/quote').send({ amount_in: '1', direction: 'a_to_b' }),
      request(app()).get('/api/defi/portfolio'),
      request(app()).get('/api/defi/portfolio/0xabc'),
    ]) {
      const result = await probe;
      expect(result.status).toBe(501);
      expect(result.body).toMatchObject({
        success: false,
        unavailable: true,
        error: { code: 'NOT_IMPLEMENTED' },
      });
    }
  });

  it('passes through a labelled simulated pool response', async () => {
    process.env.DEFI_NODE_URL = 'http://defi-node:7100/';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      response({ simulated: true, custodial: false, settlement: 'none', pools: [] }),
    );

    const result = await request(app()).get('/api/defi/pools');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ simulated: true, custodial: false, pools: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://defi-node:7100/api/defi/pools',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('refuses a 2xx upstream body without simulated:true', async () => {
    process.env.DEFI_NODE_URL = 'http://defi-node:7100';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(response({ pools: [] }));

    const result = await request(app()).get('/api/defi/pools');
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('UPSTREAM_CONTRACT_VIOLATION');
    expect(result.body).not.toHaveProperty('pools');
  });

  it('reports upstream failure without returning mock DeFi data', async () => {
    process.env.DEFI_NODE_URL = 'http://defi-node:7100';
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('connection refused'));

    const result = await request(app()).post('/api/defi/pools/1/quote').send({
      amount_in: '100',
      direction: 'a_to_b',
    });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      simulated: true,
      unavailable: true,
      error: { code: 'DEFI_NODE_UNAVAILABLE' },
    });
    expect(result.body).not.toHaveProperty('amount_out');
  });

  it('keeps portfolio an honest 501 even when the simulator is configured', async () => {
    process.env.DEFI_NODE_URL = 'http://defi-node:7100';
    const fetchMock = jest.spyOn(global, 'fetch');

    const result = await request(app()).get('/api/defi/portfolio/0xabc');
    expect(result.status).toBe(501);
    expect(result.body.error.capability).toBe('defi.portfolio');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mounts the real route, registers port 7100, and reports capability from the env', async () => {
    const repoRoot = path.resolve(__dirname, '..');
    const entrypoint = fs.readFileSync(
      path.join(repoRoot, 'server/enhanced_unified_api_optimized.ts'),
      'utf8',
    );
    const ports = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/port-registry.json'), 'utf8'));

    expect(entrypoint).toContain('safeMount(\'/api/defi\',                    \'./routes/defi-routes\');');
    expect(ports.services['DeFi Simulator Node'].port).toBe(7100);

    jest.resetModules();
    delete process.env.DEFI_NODE_URL;
    const unsetModule = await import('../server/routes/capabilities-routes');
    const unsetResult = await request(express().use('/api', unsetModule.default)).get('/api/capabilities');
    expect(unsetResult.body.features.defi.status).toBe('unavailable');

    jest.resetModules();
    process.env.DEFI_NODE_URL = 'http://defi-node:7100';
    const configuredModule = await import('../server/routes/capabilities-routes');
    const configuredResult = await request(express().use('/api', configuredModule.default)).get('/api/capabilities');
    expect(configuredResult.body.features.defi.status).toBe('simulated');
  });
});
