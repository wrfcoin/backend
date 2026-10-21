/**
 * Regression tests for the /api/nfts/creator/:address route (#603).
 *
 * Verifies that:
 *  - The controller reads req.params.address (not req.params.owner)
 *  - The controller calls storage.getNFTsByCreator (not getNFTsByOwner)
 *  - Creator and owner are treated as distinct fields — the fix for the
 *    bug flagged in the #608 merge review
 *  - Invalid addresses are rejected with 400
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Application } from 'express';

const request = require('supertest');
const express = require('express');

// ── Minimal in-process NFT fixture ───────────────────────────────────────────

const CREATOR_ADDRESS = '0xaA00000000000000000000000000000000000001';
const OWNER_ADDRESS  = '0xbB00000000000000000000000000000000000002';

const NFT_CREATED_BY_CREATOR = {
  id: 1,
  nftId: 'nft-creator-1',
  title: 'Creator NFT',
  creator: CREATOR_ADDRESS,
  owner: OWNER_ADDRESS,
  nftType: 'standard',
};

const NFT_OWNED_BY_CREATOR = {
  id: 2,
  nftId: 'nft-owner-1',
  title: 'Owned But Not Created',
  creator: OWNER_ADDRESS,
  owner: CREATOR_ADDRESS,
  nftType: 'standard',
};

// ── Mock storage ──────────────────────────────────────────────────────────────

const ALL_NFTS = [NFT_CREATED_BY_CREATOR, NFT_OWNED_BY_CREATOR];

const mockGetNFTsByCreator = jest.fn(async (creator: string) =>
  ALL_NFTS.filter(n => n.creator === creator)
);
const mockGetNFTsByOwner = jest.fn(async (owner: string) =>
  ALL_NFTS.filter(n => n.owner === owner)
);

const mockStorage = {
  getAllNFTs: jest.fn(async () => ALL_NFTS),
  getNFTById: jest.fn(async () => null),
  getNFTsByCreator: mockGetNFTsByCreator,
  getNFTsByOwner: mockGetNFTsByOwner,
  createNFT: jest.fn(),
  updateNFT: jest.fn(),
};

// ── App factory ───────────────────────────────────────────────────────────────

async function createApp(): Promise<Application> {
  const { getNFTsByCreator } = await import('../../server/controllers/nftController.js');

  const app = express();
  app.use(express.json());

  // Inject mock storage the same way api.js does — via req.storage.
  app.use((req: any, _res: any, next: any) => {
    req.storage = mockStorage;
    next();
  });

  app.get('/api/nfts/creator/:address', getNFTsByCreator);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/nfts/creator/:address (#603)', () => {
  let app: Application;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await createApp();
  });

  it('returns NFTs where creator matches the address param', async () => {
    const res = await request(app)
      .get(`/api/nfts/creator/${CREATOR_ADDRESS}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].nftId).toBe('nft-creator-1');
    expect(res.body.data[0].creator).toBe(CREATOR_ADDRESS);
  });

  it('calls storage.getNFTsByCreator with the address param', async () => {
    await request(app).get(`/api/nfts/creator/${CREATOR_ADDRESS}`);

    expect(mockGetNFTsByCreator).toHaveBeenCalledWith(CREATOR_ADDRESS);
  });

  it('does NOT call storage.getNFTsByOwner for the creator route', async () => {
    await request(app).get(`/api/nfts/creator/${CREATOR_ADDRESS}`);

    expect(mockGetNFTsByOwner).not.toHaveBeenCalled();
  });

  it('creator and owner routes return different result sets', async () => {
    const creatorRes = await request(app)
      .get(`/api/nfts/creator/${CREATOR_ADDRESS}`)
      .expect(200);

    // The creator has created 1 NFT but owns a different one.
    // Verify creator results only include NFTs where creator === CREATOR_ADDRESS.
    for (const nft of creatorRes.body.data) {
      expect(nft.creator).toBe(CREATOR_ADDRESS);
    }
    expect(creatorRes.body.data.every((n: any) => n.owner === CREATOR_ADDRESS)).toBe(false);
  });

  it('returns empty array when no NFTs were created by the address', async () => {
    const unknown = '0xcc00000000000000000000000000000000000099';
    const res = await request(app)
      .get(`/api/nfts/creator/${unknown}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it('rejects a non-Ethereum address with 400', async () => {
    const res = await request(app)
      .get('/api/nfts/creator/not-an-address')
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/invalid creator address/i);
  });

  it('includes pagination metadata in the response', async () => {
    const res = await request(app)
      .get(`/api/nfts/creator/${CREATOR_ADDRESS}`)
      .expect(200);

    expect(res.body.pagination).toMatchObject({
      page: 1,
      total: 1,
      hasNext: false,
      hasPrev: false,
    });
  });
});
