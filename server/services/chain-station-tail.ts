/**
 * Newest chain observations per station (backend#1280).
 *
 * core4's `GET /transactions/contributions/{station_id}/observations`
 * (native-chain launch_api routes/transactions.rs `get_station_observations`)
 * scans ASCENDING from `after` (default 0) and stops after 64 heights per call,
 * so an uncursored read serves the genesis window, never the tail. The backend
 * has no other source: nothing on testnet writes `weather_data` (the collectors
 * submit commit/reveal transactions to the node), so the station list derived
 * every status as `registered` and the public popup showed no readings.
 *
 * This reader learns the chain height, then reads windows back from the tip,
 * newest window first, and stops at the first window that holds a reveal for
 * the station. Everything is bounded:
 *
 *  - WINDOW_HEIGHTS = 64: core4's own per-call height cap, so one window is one
 *    call unless core4's 1000-transaction scan cap truncates it.
 *  - MAX_WINDOWS = 4 (256 blocks). core4 documents the live testnet cadence as
 *    collector-driven at ~60 s per block (shared-protocol consensus
 *    proof_of_publishing.rs, STATION_OWNERSHIP_BINDING_ACTIVATION_HEIGHT notes:
 *    "the measured cadence is 60 s"; TARGET_BLOCK_TIME_SECONDS = 15 and
 *    BLOCK_TIME_PROGRESSION are inert on testnet). The fastest measured cadence
 *    gives one window = 64 min, four times the 15-minute live window, so a live
 *    station is found in the first window; four windows reach back >= 4.2 h,
 *    which separates `stale` from `registered`. The collectors submit every
 *    ~300 s (infra testnet compose `sleep 300`), several reveals per window.
 *  - MAX_CALLS = 7 per read (1 height probe + 4 windows + 2 continuation pages
 *    for a window truncated by the transaction scan cap), each with a short
 *    timeout, under an overall deadline.
 *
 * Results are cached per station with a short TTL and concurrent reads share
 * one in-flight promise (the #1262 pattern), so public polling cannot multiply
 * core4 calls. Any core4 unavailability degrades to `unavailable` and never
 * throws; callers then fall back to today's database behavior.
 */

import { fetchCore4Json as defaultFetchCore4Json } from '../../shared/core4-route-client.js';

type Row = Record<string, unknown>;
type Core4Result = { ok: boolean; status: number; payload: any };
export type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<Core4Result>;

export const TAIL_WINDOW_HEIGHTS = 64;
export const TAIL_MAX_WINDOWS = 4;
export const TAIL_MAX_CALLS = 7;
/** core4 clamps `limit` to 100. */
const CORE4_MAX_ITEMS = 100;
const CALL_TIMEOUT_MS = 2_500;
const READ_DEADLINE_MS = 6_000;
const OK_TTL_MS = 30_000;
const UNAVAILABLE_TTL_MS = 5_000;
const HEIGHT_TTL_MS = 15_000;

export type TailRead =
  | {
      kind: 'ok';
      /** Newest first: height descending, then transaction order descending. */
      items: Row[];
      /** Null only when core4 omitted chain_height (then the one window it returned is served). */
      chainHeight: number | null;
      /** Lowest and highest heights scanned; null when core4 reported no height. */
      fromHeight: number | null;
      toHeight: number | null;
      /** False when the call cap or deadline stopped the walk early. */
      complete: boolean;
    }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'mismatch' }
  | { kind: 'rejected'; status: number; payload: any };

/** core4 unavailability that justifies a database fallback (same rule as station-detail-routes). */
export function isCore4Unavailable(status: number): boolean {
  return status >= 500 || status === 401 || status === 403 || status === 404 || status === 405;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type Window = { items: Row[]; nextAfter: number | null; nextOffset: number | null; chainHeight: number | null };

// Same contract test as station-detail-routes core4Window: {ok, data.items[]}.
// Cursor fields are required only to keep walking; see readTail.
function parseWindow(payload: any): Window | null {
  const data = payload?.ok === true ? payload.data : null;
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
  return {
    items: data.items as Row[],
    nextAfter: finiteNumber(data.next_after),
    nextOffset: finiteNumber(data.next_offset),
    chainHeight: finiteNumber(data.chain_height),
  };
}

function newestFirst(items: Row[]): Row[] {
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => (finiteNumber(b.item.height) ?? 0) - (finiteNumber(a.item.height) ?? 0) || b.order - a.order)
    .map((entry) => entry.item);
}

class StopRead {
  constructor(readonly result: TailRead) {}
}

export interface ChainTailReader {
  /** Newest observations for a station, newest first. Never throws. */
  latest(stationId: string): Promise<TailRead>;
  /**
   * Epoch ms of the station's newest chain observation, or null when unknown.
   * With `fetch: false` only cached knowledge is used (no core4 call).
   * Never throws.
   */
  lastSeenMs(stationId: string, options?: { fetch?: boolean }): Promise<number | null>;
}

export function createChainTailReader(deps: {
  fetchCore4Json?: Core4Fetch;
  readerToken?: () => string | undefined;
  now?: () => number;
  maxEntries?: number;
} = {}): ChainTailReader {
  const fetchCore4Json = deps.fetchCore4Json ?? (defaultFetchCore4Json as Core4Fetch);
  const readerToken = deps.readerToken ?? (() => process.env.WRFCOIN_READER_TOKEN?.trim() || undefined);
  const now = deps.now ?? Date.now;
  const maxEntries = Math.max(1, Math.min(4096, Math.floor(deps.maxEntries ?? 2048)));

  const reads = new Map<string, { expiresAt: number; value: Promise<TailRead> }>();
  // Highest observation time ever seen per station, kept past the read TTL so a
  // station seen earlier stays `stale` after it drops out of the tail windows.
  const seen = new Map<string, number>();
  let height: { expiresAt: number; value: number } | null = null;

  function remember<K, V>(map: Map<K, V>, key: K, value: V) {
    map.delete(key);
    map.set(key, value);
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  async function readTail(stationId: string, token: string): Promise<TailRead> {
    const deadline = now() + READ_DEADLINE_MS;
    let calls = 0;
    const path = `/transactions/contributions/${encodeURIComponent(stationId)}/observations`;

    async function call(after: number, offset: number, limit: number): Promise<Window> {
      if (calls >= TAIL_MAX_CALLS || now() >= deadline) throw new StopRead({ kind: 'unavailable', reason: 'BUDGET' });
      calls += 1;
      let upstream: Core4Result;
      try {
        upstream = await fetchCore4Json(path, {
          query: { limit, after, offset },
          headers: { authorization: `Bearer ${token}` },
          timeoutMs: CALL_TIMEOUT_MS,
        });
      } catch {
        throw new StopRead({ kind: 'unavailable', reason: 'CORE4_UNREACHABLE' });
      }
      if (!upstream.ok) {
        if (isCore4Unavailable(upstream.status)) {
          throw new StopRead({ kind: 'unavailable', reason: `CORE4_HTTP_${upstream.status}` });
        }
        throw new StopRead({ kind: 'rejected', status: upstream.status, payload: upstream.payload });
      }
      const window = parseWindow(upstream.payload);
      if (!window) throw new StopRead({ kind: 'mismatch' });
      return window;
    }

    try {
      // Height probe. Resuming from the last known height makes it scan at
      // most the few blocks mined since, instead of the genesis window.
      let tip: number;
      if (height && height.expiresAt > now()) {
        tip = height.value;
      } else {
        const probe = await call(height?.value ?? 0, 0, 1);
        if (probe.chainHeight === null) {
          // No height to walk back from (not the real core4 shape): serve the
          // one window core4 returned, newest first, marked incomplete.
          return { kind: 'ok', items: newestFirst(probe.items), chainHeight: null, fromHeight: null, toHeight: null, complete: false };
        }
        tip = probe.chainHeight;
        height = { expiresAt: now() + HEIGHT_TTL_MS, value: tip };
      }

      let toHeight = tip;
      let fromHeight = tip + 1;
      for (let w = 0; w < TAIL_MAX_WINDOWS && toHeight > 0; w += 1) {
        const start = Math.max(0, toHeight - TAIL_WINDOW_HEIGHTS);
        const found: Row[] = [];
        let after = start;
        let offset = 0;
        let complete = true;
        while (after < toHeight) {
          let window: Window;
          try {
            window = await call(after, offset, CORE4_MAX_ITEMS);
          } catch (error) {
            // Out of budget mid-walk: report what was found, marked incomplete.
            if (error instanceof StopRead && error.result.kind === 'unavailable' && error.result.reason === 'BUDGET') {
              complete = false;
              break;
            }
            throw error;
          }
          // A cursor that does not advance would loop and repeat items: stop
          // the window there without trusting that page.
          if (window.nextAfter === null || window.nextOffset === null
            || window.nextAfter < after || (window.nextAfter === after && window.nextOffset <= offset)) {
            complete = false;
            break;
          }
          for (const item of window.items) {
            const h = finiteNumber(item.height);
            if (h !== null && h > start && h <= toHeight) found.push(item);
          }
          after = window.nextAfter;
          offset = window.nextOffset;
        }
        fromHeight = start + 1;
        if (found.length > 0 || !complete) {
          return { kind: 'ok', items: newestFirst(found), chainHeight: tip, fromHeight, toHeight: tip, complete };
        }
        toHeight = start;
      }
      return { kind: 'ok', items: [], chainHeight: tip, fromHeight, toHeight: tip, complete: true };
    } catch (error) {
      if (error instanceof StopRead) return error.result;
      return { kind: 'unavailable', reason: 'CORE4_UNREACHABLE' };
    }
  }

  function noteSeen(stationId: string, read: TailRead) {
    if (read.kind !== 'ok') return;
    const at = now();
    for (const item of read.items) {
      const observed = finiteNumber(item.observed_at);
      if (observed === null) continue;
      const ms = observed * 1000;
      // A reading stamped in the future is not evidence of liveness.
      if (ms > at) continue;
      if (ms > (seen.get(stationId) ?? -Infinity)) remember(seen, stationId, ms);
    }
  }

  function latest(stationId: string): Promise<TailRead> {
    const cached = reads.get(stationId);
    if (cached && cached.expiresAt > now()) {
      remember(reads, stationId, cached);
      return cached.value;
    }
    const token = readerToken();
    if (!token) return Promise.resolve({ kind: 'unavailable', reason: 'CORE4_READER_CREDENTIAL_UNCONFIGURED' });
    // Install the promise before calling core4 so concurrent reads coalesce.
    const entry = { expiresAt: Infinity, value: Promise.resolve<TailRead>({ kind: 'unavailable', reason: 'PENDING' }) };
    entry.value = Promise.resolve().then(async () => {
      const read = await readTail(stationId, token);
      noteSeen(stationId, read);
      entry.expiresAt = now() + (read.kind === 'ok' ? OK_TTL_MS : UNAVAILABLE_TTL_MS);
      return read;
    });
    remember(reads, stationId, entry);
    return entry.value;
  }

  async function lastSeenMs(stationId: string, options: { fetch?: boolean } = {}): Promise<number | null> {
    try {
      if (options.fetch !== false) await latest(stationId);
    } catch {
      // latest() never rejects; guard anyway so a list never fails on chain reads.
    }
    return seen.get(stationId) ?? null;
  }

  return { latest, lastSeenMs };
}

let defaultReader: ChainTailReader | null = null;

/** Process-wide reader shared by the station list and the station detail routes. */
export function getDefaultChainTailReader(): ChainTailReader {
  if (!defaultReader) defaultReader = createChainTailReader();
  return defaultReader;
}
