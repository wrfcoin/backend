/**
 * Smoke tests for server/routes/computational.js
 * Issue #358 — computational routes have zero tests
 * These are synchronous in-memory responses — simple unit tests without mocking
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('express', () => {
  function createRouter() {
    return {
      stack: [] as any[],
      use(...args: any[]) { return this; },
      get(path: string, ...handlers: any[]) {
        this.stack.push({ route: { path, methods: { get: true }, stack: handlers.map((h: any) => ({ handle: h })) } });
        return this;
      },
      post(path: string, ...handlers: any[]) {
        this.stack.push({ route: { path, methods: { post: true }, stack: handlers.map((h: any) => ({ handle: h })) } });
        return this;
      },
    };
  }
  const express: any = () => ({});
  express.Router = createRouter;
  express.json = () => (_req: any, _res: any, next: any) => next();
  return express;
}, { virtual: true });

function getHandler(router: any, method: string, path: string): (...args: any[]) => any {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${path}`);
}

function mockReq(params: any = {}, body: any = {}, query: any = {}): any {
  return { params, body, query };
}
function mockRes(): any {
  const res: any = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (d: any) => { res.body = d; return res; };
  return res;
}

const router = require('../../server/routes/computational');

describe('GET /nfts', () => {
  it('returns 200 with a list of computational NFTs', () => {
    const handler = getHandler(router, 'GET', '/nfts');
    const res = mockRes();
    handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.nfts)).toBe(true);
    expect(res.body.nfts.length).toBeGreaterThan(0);
  });

  it('each NFT has required fields', () => {
    const handler = getHandler(router, 'GET', '/nfts');
    const res = mockRes();
    handler(mockReq(), res);
    for (const nft of res.body.nfts) {
      expect(nft).toHaveProperty('id');
      expect(nft).toHaveProperty('name');
      expect(nft).toHaveProperty('status');
      expect(nft).toHaveProperty('baseReward');
    }
  });

  it('all NFTs have status ready_for_compute', () => {
    const handler = getHandler(router, 'GET', '/nfts');
    const res = mockRes();
    handler(mockReq(), res);
    for (const nft of res.body.nfts) {
      expect(nft.status).toBe('ready_for_compute');
    }
  });
});

describe('GET /types', () => {
  it('returns 200 with compute type definitions', () => {
    const handler = getHandler(router, 'GET', '/types');
    const res = mockRes();
    handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.types)).toBe(true);
    expect(res.body.types.length).toBeGreaterThan(0);
  });

  it('each type has id, name, and description', () => {
    const handler = getHandler(router, 'GET', '/types');
    const res = mockRes();
    handler(mockReq(), res);
    expect(Array.isArray(res.body.types)).toBe(true);
    for (const type of res.body.types) {
      expect(type).toHaveProperty('id');
      expect(type).toHaveProperty('name');
    }
  });
});

describe('GET /environments', () => {
  it('returns 200 with compute environments', () => {
    const handler = getHandler(router, 'GET', '/environments');
    const res = mockRes();
    handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.environments)).toBe(true);
    expect(res.body.environments.length).toBeGreaterThan(0);
  });

  it('each environment has id and name fields', () => {
    const handler = getHandler(router, 'GET', '/environments');
    const res = mockRes();
    handler(mockReq(), res);
    for (const env of res.body.environments) {
      expect(env).toHaveProperty('id');
      expect(env).toHaveProperty('name');
    }
  });
});
