/**
 * Block-page review 2026-11-08: the anonymous block metadata projection is an ALLOWLIST.
 * Shapes are those of live r4 core4 /chain/block/<h> metadata (key names and value types only).
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockFetchCore4Json = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../shared/core4-route-client.js', () => ({
  extractCore4Data: (payload: unknown) => payload,
  fetchCore4Json: (...args: unknown[]) => mockFetchCore4Json(...args),
  sendCore4Error: (res: any, _r: unknown, msg: string) => res.status(502).json({ error: msg }),
  sendCore4Unavailable: (res: any, _e: unknown, msg: string) => res.status(503).json({ error: msg }),
  toNullable: (value: unknown) => value ?? null,
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { projectAnonymousBlockMetadata, ANONYMOUS_BLOCK_METADATA_SCALARS } = require('../server/utils/anonymous-projection');
/* eslint-enable @typescript-eslint/no-var-requires */

const PRODUCER = '0x' + 'a1'.repeat(20);
const OWNER_A = '0x' + 'b2'.repeat(20);
const OWNER_B = '0x' + 'c3'.repeat(20);
const ATTESTER = 'd4'.repeat(32);
const COMMIT = 'e5'.repeat(32);

// A reward block as core4 r4 writes it (JSON-encoded string values).
const r4Metadata = {
  rewards_minted_total: '400000000',
  rewards_minted_count: '3',
  role_collector_count: '3',
  reward_total: '400000000',
  quality_enforcement_active: 'true',
  quality_challenge_count: '1',
  rewards_trust_weights: 'verified=1.0,unverified=0.5,trusted_provider=1.0',
  producer_settlement: JSON.stringify({ amount: 50000000, height: 19044, payout_address: PRODUCER }),
  attester_settlements: JSON.stringify([
    { decision_id: 'dec-1', finalization_height: 19040, allocations: [{ attester_id: ATTESTER, amount: 1000 }, { attester_id: ATTESTER, amount: 2000 }] },
    { decision_id: 'dec-2', finalization_height: 19041, allocations: [{ attester_id: ATTESTER, amount: 500 }] },
  ]),
  low_quality_streak_entries: JSON.stringify([[OWNER_A, null], [OWNER_B, null]]),
  reward_entries: JSON.stringify([
    { address: OWNER_A, amount: 100, provenance_class: 'real', reason: 'contribution', station_id: 'FAMILY-STATION-1' },
    { address: OWNER_B, amount: 200, provenance_class: 'real', reason: 'contribution', station_id: 'FAMILY-STATION-2' },
  ]),
  quality_challenge_commit_ids: JSON.stringify([COMMIT]),
  oracle_reward_late_quorum_commit_ids: JSON.stringify([COMMIT]),
};

describe('projectAnonymousBlockMetadata', () => {
  it('keeps reviewed scalars and turns per-identity lists into counts and totals', () => {
    expect(projectAnonymousBlockMetadata(r4Metadata)).toEqual({
      rewards_minted_total: '400000000',
      rewards_minted_count: '3',
      role_collector_count: '3',
      reward_total: '400000000',
      quality_enforcement_active: 'true',
      quality_challenge_count: '1',
      rewards_trust_weights: 'verified=1.0,unverified=0.5,trusted_provider=1.0',
      producer_settlement: { amount: '50000000', height: 19044 },
      attester_settlements_summary: { count: 3, total_amount: '3500' },
      low_quality_streak_summary: { count: 2 },
      reward_entries_summary: { count: 2, total_amount: '300' },
    });
  });

  it('never returns an address, attester id, station id or commit-id list', () => {
    const text = JSON.stringify(projectAnonymousBlockMetadata(r4Metadata));
    for (const secret of [PRODUCER, OWNER_A, OWNER_B, ATTESTER, COMMIT, 'FAMILY-STATION', 'payout_address', 'attester_id', 'decision_id']) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/0x[0-9a-f]{40}/i);
  });

  it('drops a new, unreviewed core4 key', () => {
    const out = projectAnonymousBlockMetadata({ rewards_minted_count: '1', some_future_per_station_map: '{"st":1}', future_scalar: '7' });
    expect(out).toEqual({ rewards_minted_count: '1' });
  });

  it('drops a reviewed key whose value is a structure, not a scalar', () => {
    expect(projectAnonymousBlockMetadata({
      rewards_minted_count: JSON.stringify([{ address: OWNER_A }]),
      reward_total: { address: OWNER_A },
      role_keeper_count: 'x'.repeat(600),
      publishing_score: Number.NaN,
      task_assigner_enabled: true,
      oracle_quorum: 2,
    })).toEqual({ task_assigner_enabled: true, oracle_quorum: 2 });
  });

  it('handles unreadable aggregates honestly', () => {
    expect(projectAnonymousBlockMetadata({
      attester_settlements: 'not json',
      low_quality_streak_entries: '{"a":1}',
      reward_entries: JSON.stringify([{ amount: 'lots' }]),
      producer_settlement: JSON.stringify({ amount: -1, height: 'x', payout_address: PRODUCER }),
    })).toEqual({
      attester_settlements_summary: { count: null, total_amount: null },
      low_quality_streak_summary: { count: null },
      reward_entries_summary: { count: 1, total_amount: null },
      producer_settlement: { amount: null, height: null },
    });
    expect(projectAnonymousBlockMetadata(null)).toBeNull();
    expect(projectAnonymousBlockMetadata('x')).toBeNull();
    expect(projectAnonymousBlockMetadata([1])).toBeNull();
  });

  it('allowlists no per-identity key by name', () => {
    // faucet_address is the one public address: genesis chain config, printed on the join page.
    for (const key of [...ANONYMOUS_BLOCK_METADATA_SCALARS].filter((k: string) => k !== 'faucet_address')) {
      expect(key).not.toMatch(/entries$|settlements$|^producer_settlement$|address$|_ids$|allocations/);
    }
  });
});

describe('GET /api/blockchain/blocks/:height uses the allowlist', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const blockchainRoutes = require('../server/routes/blockchain-routes');
  const app = express();
  app.use('/api/blockchain', blockchainRoutes.default ?? blockchainRoutes);
  beforeEach(() => {
    mockFetchCore4Json.mockResolvedValue({ ok: true, status: 200, payload: { height: 19044, hash: 'h', metadata: r4Metadata, transactions: [] } });
  });

  it('anonymous body carries no address or attester id', async () => {
    const res = await request(app).get('/api/blockchain/blocks/19044').expect(200);
    expect(res.body.metadata.producer_settlement).toEqual({ amount: '50000000', height: 19044 });
    expect(JSON.stringify(res.body)).not.toMatch(/0x[0-9a-f]{40}|FAMILY-STATION|d4d4d4d4/i);
  });

  it('a block with no metadata answers metadata: null', async () => {
    mockFetchCore4Json.mockResolvedValue({ ok: true, status: 200, payload: { height: 1, hash: 'h' } });
    const res = await request(app).get('/api/blockchain/blocks/1').expect(200);
    expect(res.body.metadata).toBeNull();
  });
});
