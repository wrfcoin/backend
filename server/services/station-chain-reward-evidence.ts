/**
 * Chain-derived reward evidence for one station (backend#1232 / S10).
 *
 * `station_reward_cycles` has no writer, so reward-progress can never leave
 * AWAITING_OBSERVATION from that table. The chain itself can answer: the station's
 * newest commits come from the chain tail (backend#1280) and each is joined to core4's
 * per-commit reward evidence (GET /transactions/contributions/{id}/reward-evidence,
 * core4#2456), whose `rewarded` flag is the node's own fail-closed verdict.
 *
 * Never throws; core4 trouble is reported as `unavailable`, never as "nothing yet".
 */
import { getDefaultChainTailReader, type ChainTailReader } from './chain-station-tail.js';

type Row = Record<string, any>;
export type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; payload: any }>;

export type StationChainEvidence =
  | { kind: 'none' }
  | { kind: 'unavailable' }
  /** The scan finished but did not reach the start of the chain: absence is not established. */
  | { kind: 'history_limited' }
  | { kind: 'observed'; commitId: string; observedAt: string | null; height: number | null; blocker: string | null }
  | {
      kind: 'rewarded';
      commitId: string;
      observedAt: string | null;
      amountBaseUnits: string;
      address: string | null;
      reason: string | null;
      blockHeight: number | null;
      blockHash: string | null;
      blockTime: string | null;
      finalized: boolean;
    };

const HASH_RE = /^(0x)?[0-9a-fA-F]{64}$/;
/** Newest commits examined: rewards lag, so the newest one may be pending while an older one paid. */
export const RECENT_COMMITS = 5;

function isoSeconds(value: unknown): string | null {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function createStationChainEvidenceReader(deps: {
  fetchCore4Json: Core4Fetch;
  readerToken: () => string | undefined;
  chainTail?: ChainTailReader;
  now?: () => number;
}) {
  const chainTail = deps.chainTail ?? getDefaultChainTailReader();
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; value: Promise<Row | null> }>();

  function evidenceFor(commitId: string, token: string): Promise<Row | null> {
    const hit = cache.get(commitId);
    if (hit && hit.expiresAt > now()) return hit.value;
    cache.delete(commitId);
    const entry = { expiresAt: Infinity, value: Promise.resolve<Row | null>(null) };
    entry.value = Promise.resolve().then(async () => {
      let evidence: Row | null = null;
      try {
        const upstream = await deps.fetchCore4Json(
          `/transactions/contributions/${encodeURIComponent(commitId)}/reward-evidence`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const body = upstream.ok ? upstream.payload?.data ?? upstream.payload : null;
        if (body && typeof body === 'object' && typeof body.rewarded === 'boolean') evidence = body;
      } catch {
        evidence = null;
      }
      entry.expiresAt = now() + (evidence?.rewarded === true ? 600_000 : evidence ? 20_000 : 5_000);
      return evidence;
    });
    cache.set(commitId, entry);
    while (cache.size > 1024) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return entry.value;
  }

  return async function read(stationId: string): Promise<StationChainEvidence> {
    try {
      const token = deps.readerToken();
      if (!token) return { kind: 'unavailable' };
      const tail = await chainTail.latest(stationId);
      if (tail.kind !== 'ok') return { kind: 'unavailable' };
      const commits: Array<{ id: string; observedAt: string | null; height: number | null }> = [];
      for (const item of tail.items) {
        const id = typeof item.commit_id === 'string' && HASH_RE.test(item.commit_id) ? item.commit_id : null;
        if (id && !commits.some((c) => c.id === id)) {
          commits.push({ id, observedAt: isoSeconds(item.observed_at), height: Number.isFinite(Number(item.height)) ? Number(item.height) : null });
        }
        if (commits.length >= RECENT_COMMITS) break;
      }
      if (commits.length === 0) {
        // Absence is a claim about the station's WHOLE history. It is established only by a
        // complete scan that reached the start of the chain; an incomplete scan is transient
        // trouble, and a complete-but-bounded window may simply have aged the station's
        // contributions out (the tail reader looks back a fixed number of blocks).
        if (!tail.complete) return { kind: 'unavailable' };
        if (tail.fromHeight === null || tail.fromHeight > 1) return { kind: 'history_limited' };
        return { kind: 'none' };
      }
      const evidence = await Promise.all(commits.map((c) => evidenceFor(c.id, token)));
      for (let i = 0; i < commits.length; i += 1) {
        const e = evidence[i];
        const reward = e?.reward && typeof e.reward === 'object' ? (e.reward as Row) : null;
        const block = e?.block && typeof e.block === 'object' ? (e.block as Row) : null;
        if (e?.rewarded === true && reward && typeof reward.amount === 'string' && /^[1-9][0-9]{0,38}$/.test(reward.amount)) {
          return {
            kind: 'rewarded',
            commitId: commits[i].id,
            observedAt: commits[i].observedAt,
            amountBaseUnits: reward.amount,
            address: typeof reward.address === 'string' ? reward.address : null,
            reason: typeof reward.reason === 'string' ? reward.reason.slice(0, 64) : null,
            blockHeight: block && Number.isSafeInteger(block.height) ? block.height : null,
            blockHash: block && typeof block.hash === 'string' && HASH_RE.test(block.hash) ? block.hash : null,
            blockTime: block ? isoSeconds(block.timestamp) : null,
            finalized: block?.finalized === true,
          };
        }
      }
      // Nothing proven paid. If every evidence read failed, that is unknown, not "observed".
      if (evidence.every((e) => e === null)) return { kind: 'unavailable' };
      const first = commits[0];
      const e0 = evidence[0];
      const blocker = typeof e0?.rewarded_blocker === 'string' && /^[a-z_]{1,64}$/.test(e0.rewarded_blocker) ? e0.rewarded_blocker : null;
      return { kind: 'observed', commitId: first.id, observedAt: first.observedAt, height: first.height, blocker };
    } catch {
      return { kind: 'unavailable' };
    }
  };
}
