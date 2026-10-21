/**
 * backend S10 / #1232: with no station_reward_cycles row (nothing writes that table),
 * reward-progress answers from the chain: the station's newest commits joined to core4's
 * per-commit reward evidence, so a paid station is REWARDED and an unreadable chain is
 * UNKNOWN, never AWAITING_OBSERVATION. Evidence bodies follow core4 RewardEvidenceResponse.
 */
jest.mock('../database/index.js', () => ({ executeQuery: jest.fn() }), { virtual: true });
import { getStationRewardProgress } from '../server/services/station-reward-progress.js';
import { createStationChainEvidenceReader } from '../server/services/station-chain-reward-evidence.js';
import { createChainTailReader } from '../server/services/chain-station-tail.js';
import { fakeCore4Chain } from './fixtures/fake-core4-chain.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const OWNER = '0xowner';
const STATION = { station_id: 'mob-abc', owner_address: OWNER, created_at: '2026-09-30T10:00:00.000Z' };
const H = (n: number) => n.toString(16).padStart(64, '0');

function pool(cycle: Record<string, unknown> | null) {
  return { query: jest.fn(async (sql: string) => ({ rows: /station_reward_cycles/.test(sql) ? (cycle ? [cycle] : []) : [STATION] })) };
}
const rewardedBody = (n: number, amount = '150000000') => ({
  commit_id: H(n),
  reward: { address: OWNER, amount, reason: 'contribution', station_id: 'mob-abc', reward_eligible: true, finalized: true },
  block: { height: 900 + n, hash: 'cd'.repeat(32), timestamp: 1_790_000_000, finalized: true },
  rewarded: true, rewarded_blocker: null,
});
const pendingBody = (n: number, blocker = 'no_reward_record') => ({ commit_id: H(n), reward: null, block: null, account: null, rewarded: false, rewarded_blocker: blocker });

function reader(opts: { commits: number[]; evidence: Record<string, any>; token?: string | null; tail?: 'ok' | 'unavailable'; window?: { complete: boolean; fromHeight: number | null } }) {
  const fetchCore4Json = jest.fn(async (path: string) => {
    const m = /\/contributions\/([0-9a-f]{64})\/reward-evidence$/.exec(path);
    const e = m ? opts.evidence[m[1]] : undefined;
    if (e === 'down' || e === undefined) return { ok: false, status: 503, payload: null };
    return { ok: true, status: 200, payload: { ok: true, data: e } };
  });
  const chainTail = {
    latest: jest.fn(async () => opts.tail === 'unavailable'
      ? ({ kind: 'unavailable', reason: 'X' } as any)
      : ({ kind: 'ok', items: opts.commits.map((n) => ({ commit_id: H(n), height: 100 + n, observed_at: 1_790_000_000 + n })), chainHeight: 200, fromHeight: opts.window ? opts.window.fromHeight : 1, toHeight: 200, complete: opts.window ? opts.window.complete : true } as any)),
    lastSeenMs: jest.fn(async () => null),
  };
  const read = createStationChainEvidenceReader({
    fetchCore4Json: fetchCore4Json as any,
    readerToken: () => (opts.token === undefined ? 'reader' : opts.token ?? undefined),
    chainTail: chainTail as any,
  });
  return { read, fetchCore4Json, chainTail };
}
const progress = (r: ReturnType<typeof reader>, cycle: Record<string, unknown> | null = null) =>
  getStationRewardProgress(pool(cycle) as any, STATION.station_id, OWNER, NOW, { chainEvidence: r.read });

describe('reward-progress from chain evidence when no cycle row exists', () => {
  it('no commits on chain -> AWAITING_OBSERVATION (unchanged)', async () => {
    const p = await progress(reader({ commits: [], evidence: {} }));
    expect(p.state).toBe('AWAITING_OBSERVATION');
    expect((p as any).source).toBeUndefined();
  });

  it.each([
    ['an incomplete scan (budget/cursor) is transient trouble', { complete: false, fromHeight: 1 }, 'CORE_UNAVAILABLE', true],
    ['an incomplete scan with no lower bound', { complete: false, fromHeight: null }, 'CORE_UNAVAILABLE', true],
    ['a complete window that does not reach the chain start cannot prove absence', { complete: true, fromHeight: 745 }, 'HISTORY_WINDOW_LIMIT', false],
    ['a complete scan with no known lower bound cannot prove absence', { complete: true, fromHeight: null }, 'HISTORY_WINDOW_LIMIT', false],
  ])('empty tail: %s -> UNKNOWN, never AWAITING_OBSERVATION', async (_l, window, code, retrySafe) => {
    const p: any = await progress(reader({ commits: [], evidence: {}, window }));
    expect(p.state).toBe('UNKNOWN');
    expect(p.diagnostic).toMatchObject({ code, retrySafe });
  });

  it('empty tail is AWAITING_OBSERVATION only when a complete scan reached the chain start', async () => {
    expect((await progress(reader({ commits: [], evidence: {}, window: { complete: true, fromHeight: 1 } }))).state).toBe('AWAITING_OBSERVATION');
    expect((await progress(reader({ commits: [], evidence: {}, window: { complete: true, fromHeight: 0 } }))).state).toBe('AWAITING_OBSERVATION');
  });

  describe('with the REAL chain-tail reader over core4-shaped windows', () => {
    const NOW_S = 1_790_000_000;
    function real(chainHeight: number, reveals: Array<{ station: string; height: number }>) {
      const base = fakeCore4Chain(chainHeight, reveals.map((r) => ({ ...r, observedAt: NOW_S })));
      // The fixture's commit ids are short; give them 64-hex ids and answer reward evidence.
      const core4 = jest.fn(async (path: string, options?: any) => {
        const ev = /\/contributions\/([0-9a-f]{64})\/reward-evidence$/.exec(path);
        if (ev) return { ok: true, status: 200, payload: { ok: true, data: pendingBody(0, 'no_reward_record') } };
        const r: any = await (base as any)(path, options);
        for (const it of r.payload?.data?.items ?? []) it.commit_id = H(it.height);
        return r;
      });
      const tail = createChainTailReader({ fetchCore4Json: core4 as any, readerToken: () => 'reader', now: () => NOW_S * 1000 } as any);
      const evidence = createStationChainEvidenceReader({ fetchCore4Json: core4 as any, readerToken: () => 'reader', chainTail: tail });
      return (station: string) => evidence(station);
    }
    it('a small chain with no reveal for the station: absence IS established -> none', async () => {
      expect(await real(100, [{ station: 'other', height: 50 }])('mob-abc')).toEqual({ kind: 'none' });
    });
    it('a long chain whose only station commit is older than the window -> history_limited, not none', async () => {
      expect(await real(1000, [{ station: 'mob-abc', height: 10 }])('mob-abc')).toEqual({ kind: 'history_limited' });
    });
    it('a long chain with no commit anywhere in the window -> history_limited', async () => {
      expect(await real(1000, [{ station: 'other', height: 990 }])('mob-abc')).toEqual({ kind: 'history_limited' });
    });
    it('a commit inside the window is still found (positive control)', async () => {
      const r: any = await real(1000, [{ station: 'mob-abc', height: 990 }])('mob-abc');
      expect(r.kind).toBe('observed');
      expect(r.commitId).toBe(H(990));
    });
  });

  it('a proven reward -> REWARDED with core4\'s amount and block, marked chain-derived', async () => {
    const p: any = await progress(reader({ commits: [3], evidence: { [H(3)]: rewardedBody(3) } }));
    expect(p.state).toBe('REWARDED');
    expect(p.source).toBe('chain-evidence');
    expect(p.reward).toMatchObject({ amountBaseUnits: '150000000', reason: 'contribution', blockHeight: 903, blockHash: 'cd'.repeat(32) });
    expect(p.contribution.commitId).toBe(H(3));
  });

  it('the newest commit unpaid but an older one paid -> REWARDED (rewards lag), using the paid commit', async () => {
    const p: any = await progress(reader({ commits: [5, 4, 3], evidence: { [H(5)]: pendingBody(5), [H(4)]: rewardedBody(4, '7'), [H(3)]: rewardedBody(3) } }));
    expect(p.state).toBe('REWARDED');
    expect(p.contribution.commitId).toBe(H(4));
    expect(p.reward.amountBaseUnits).toBe('7');
  });

  it('observed but nothing proven paid -> OBSERVATION_RECEIVED with the blocker, never REWARDED', async () => {
    const p: any = await progress(reader({ commits: [2], evidence: { [H(2)]: pendingBody(2, 'reward_not_finalized') } }));
    expect(p.state).toBe('OBSERVATION_RECEIVED');
    expect(p.reward).toBeNull();
    expect(p.diagnostic).toMatchObject({ code: 'REWARD_NOT_FINALIZED', retrySafe: true });
  });

  it('rewarded:true with a zero or malformed amount is not REWARDED', async () => {
    for (const amount of ['0', '-1', '1.5', 'x']) {
      const p: any = await progress(reader({ commits: [2], evidence: { [H(2)]: rewardedBody(2, amount) } }));
      expect(p.state).toBe('OBSERVATION_RECEIVED');
    }
  });

  it('rewarded:false is never REWARDED even with a reward amount present', async () => {
    const body: any = rewardedBody(2); body.rewarded = false; body.rewarded_blocker = 'reward_not_finalized';
    expect((await progress(reader({ commits: [2], evidence: { [H(2)]: body } })) as any).state).toBe('OBSERVATION_RECEIVED');
  });

  it.each([
    ['every evidence read fails', { commits: [2, 1], evidence: { [H(2)]: 'down', [H(1)]: 'down' } }],
    ['the tail is unavailable', { commits: [2], evidence: {}, tail: 'unavailable' as const }],
    ['no reader credential', { commits: [2], evidence: { [H(2)]: pendingBody(2) }, token: null }],
  ])('%s -> UNKNOWN CORE_UNAVAILABLE, not AWAITING_OBSERVATION', async (_l, opts) => {
    const p: any = await progress(reader(opts as any));
    expect(p.state).toBe('UNKNOWN');
    expect(p.evidenceFresh).toBe(false);
    expect(p.diagnostic).toMatchObject({ code: 'CORE_UNAVAILABLE', retrySafe: true });
  });

  it('a cycle row wins: the chain is not consulted', async () => {
    const r = reader({ commits: [2], evidence: { [H(2)]: rewardedBody(2) } });
    const cycle = {
      cycle_id: 'c1', station_id: STATION.station_id, owner_address: OWNER, observation_id: '1', observation_digest: 'a'.repeat(64),
      observation_observed_at: '2026-09-30T11:55:00.000Z', observation_accepted_at: '2026-09-30T11:55:01.000Z',
      lifecycle_state: 'OBSERVATION_RECEIVED', failure_code: null, stalled_since: null, evidence_refreshed_at: '2026-09-30T11:59:00.000Z',
    };
    const p: any = await progress(r, cycle);
    expect(p.state).toBe('OBSERVATION_RECEIVED');
    expect(r.chainTail.latest).not.toHaveBeenCalled();
    expect(r.fetchCore4Json).not.toHaveBeenCalled();
  });

  it('costs at most 5 evidence reads per request and caches on repeat', async () => {
    const commits = [1, 2, 3, 4, 5, 6, 7, 8];
    const ev = Object.fromEntries(commits.map((n) => [H(n), pendingBody(n)]));
    const r = reader({ commits, evidence: ev });
    await progress(r); await progress(r);
    expect(r.fetchCore4Json).toHaveBeenCalledTimes(5);
  });

  it('the reader never throws', async () => {
    const read = createStationChainEvidenceReader({
      fetchCore4Json: (async () => { throw new Error('boom'); }) as any,
      readerToken: () => 'r',
      chainTail: { latest: async () => { throw new Error('boom'); }, lastSeenMs: async () => null } as any,
    });
    await expect(read('s')).resolves.toEqual({ kind: 'unavailable' });
  });
});
