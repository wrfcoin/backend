import { nodeHttpFetch } from '../../../shared/core4-node-http.js';
import { losslessJson, parseRewardBlock, RewardIndexError, type RewardBlock } from './parser.js';
import { parseForecastBlock } from './forecast-parser.js';
import { withRewardStore, type IndexStore, type Pool } from './store.js';

import { MAX_BLOCK_READS, READ_PACE_MS, RUN_INTERVAL_MS, errorBackoffMs } from './scheduling.js';
export { MAX_BLOCK_READS, MAX_READS_PER_MINUTE, READ_PACE_MS, RUN_INTERVAL_MS, CATCHUP_THRESHOLD } from './scheduling.js';
export type BlockRead = (height: number) => Promise<{ status: number; raw: string }>;

export function createTipReader(nodeUrl: string, token: string, fetchImpl = nodeHttpFetch): () => Promise<number> {
  // Reuse URL validation without making a request.
  createBlockReader(nodeUrl, token, fetchImpl);
  return async () => {
    try {
      const response = await fetchImpl(new URL('/blockchain', nodeUrl), {
        method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) throw new RewardIndexError(response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM');
      const height = losslessJson(await response.text())?.data?.height;
      if (typeof height !== 'bigint' || height < 1n || height > BigInt(Number.MAX_SAFE_INTEGER)) throw new RewardIndexError('UPSTREAM');
      return Number(height);
    } catch (e) { throw e instanceof RewardIndexError ? e : new RewardIndexError('UPSTREAM'); }
  };
}

export function createBlockReader(nodeUrl: string, token: string, fetchImpl = nodeHttpFetch): BlockRead {
  const base = new URL(nodeUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new RewardIndexError('INVALID_CONFIG');
  return async height => {
    try {
      const response = await fetchImpl(new URL(`/chain/block/${height}`, base), {
        method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, raw: response.status === 200 ? await response.text() : '' };
    } catch { throw new RewardIndexError('UPSTREAM'); }
  };
}

/** Counts EVERY block attempt, including genesis, cursor checks and reorg search.
 * Failures stop the pass: no retries, no skip-over, no public request fan-out.
 */
export async function runRewardIndexOnce(options: {
  store: IndexStore; read: BlockRead; genesis: string; tip: () => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ reads: number; appended: number; status: string; nextDelayMs: number }> {
  const { store, read, genesis } = options;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let reads = 0, appended = 0;
  const initial = await store.state();
  if (!initial.ready) return { reads, appended, status: 'cooldown', nextDelayMs: initial.nextDelayMs ?? RUN_INTERVAL_MS };
  await store.beginPass();
  await store.status('running');
  const get = async (h: number): Promise<RewardBlock> => {
    if (reads >= MAX_BLOCK_READS) throw new RewardIndexError('BUDGET');
    if (reads > 0) await sleep(READ_PACE_MS);
    await store.reserveRead(); reads++;
    const result = await read(h);
    if (result.status !== 200) throw new RewardIndexError(result.status === 404 ? 'MISSING_ARCHIVE' : result.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM');
    const block = parseRewardBlock(result.raw, h);
    // Forecast track record (core4#3604 A4) from the same read; tolerant, so it cannot fail this pass.
    block.forecast = parseForecastBlock(result.raw, h);
    return block;
  };
  let status = 'ok', lag: number | null = null;
  try {
    // Tip request also counts, so ALL node GETs stay within 30, not only block reads.
    await store.reserveRead(); reads++;
    const tip = await options.tip();
    if (!Number.isSafeInteger(tip) || tip < 1) throw new RewardIndexError('UPSTREAM');
    lag = tip - initial.height;
    const first = await get(1);
    if (first.hash !== genesis) throw new RewardIndexError('INVALID_BLOCK');
    let cursor = Math.min(initial.height, tip, initial.probe ?? initial.height), cursorHash = initial.hash;
    // Revalidate cursor on every restart/pass and find a common ancestor if replaced.
    while (cursor > 0) {
      const upstream = cursor === 1 ? first : await get(cursor);
      const local = await store.block(cursor);
      if (!local) throw new RewardIndexError('DB_ERROR');
      if (upstream.hash === local.hash) { cursorHash = local.hash; break; }
      cursor--; cursorHash = null;
      await store.probe(Math.max(1, cursor));
    }
    if (cursor !== initial.height) await store.rewind(cursor, cursorHash);
    else if (initial.probe !== null) await store.probe(null);
    if (cursor === 0) { await store.append(first); appended++; cursor = 1; cursorHash = first.hash; }
    while (cursor < tip && reads < MAX_BLOCK_READS) {
      const block = await get(cursor + 1);
      if (block.prevHash !== cursorHash) throw new RewardIndexError('INVALID_BLOCK');
      await store.append(block); appended++; cursor = block.height; cursorHash = block.hash;
    }
    lag = tip - cursor;
    status = cursor < tip ? 'budget' : 'ok';
  } catch (error) {
    const code = error instanceof RewardIndexError ? error.code : 'UPSTREAM';
    status = ({ MISSING_ARCHIVE: 'missing_archive', RATE_LIMITED: 'rate_limited', UPSTREAM: 'upstream', BUDGET: 'budget', DB_ERROR: 'db_error' } as Record<string,string>)[code] ?? 'invalid';
  }
  const nextDelayMs = await store.finishPass(status, lag);
  return { reads, appended, status, nextDelayMs };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let active = false;
let pending: Promise<unknown> | null = null;
export async function startChainRewardIndex(options: {
  env?: Record<string,string | undefined>; pool?: Pool;
  logger?: { info(message: string, meta?: any): void; warn(message: string, meta?: any): void };
  read?: BlockRead; tip?: () => Promise<number>; setTimeoutImpl?: typeof setTimeout;
} = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (env.CHAIN_REWARD_INDEX_ENABLED !== 'true') return false;
  if (active) return true;
  const url = env.CORE4_API_URL || env.BLOCKCHAIN_NODE_URL;
  const token = env.WRFCOIN_READER_TOKEN;
  const chainId = env.CHAIN_REWARD_INDEX_CHAIN_ID, genesis = env.CHAIN_REWARD_INDEX_GENESIS_HASH;
  if (!url || !token || !chainId || !/^[0-9]{1,20}$/.test(chainId) || !genesis || !/^[0-9a-f]{64}$/.test(genesis)) {
    options.logger?.warn('Chain reward index not started: configuration unavailable'); return false;
  }
  try {
    const read = options.read ?? createBlockReader(url, token);
    const tip = options.tip ?? createTipReader(url, token);
    const pool = options.pool ?? (await import('../../../database/db.js')).pool;
    let failures = 0;
    const schedule = (delay: number) => {
      if (!active) return;
      timer = (options.setTimeoutImpl ?? setTimeout)(tick, delay);
      timer.unref?.();
    };
    const tick = () => {
      if (!active || pending) return pending;
      let delay = RUN_INTERVAL_MS;
      pending = withRewardStore(pool, chainId, genesis, store => runRewardIndexOnce({ store, read, genesis, tip }))
        .then(summary => {
          failures = 0;
          if (summary) { delay = summary.nextDelayMs; options.logger?.info('Chain reward index pass', summary); }
        })
        .catch(() => { delay = errorBackoffMs(++failures); options.logger?.warn('Chain reward index pass failed'); })
        .finally(() => { pending = null; schedule(delay); });
      return pending;
    };
    active = true; void tick(); return true;
  } catch { options.logger?.warn('Chain reward index not started: configuration unavailable'); return false; }
}
export async function stopChainRewardIndex(): Promise<void> {
  active = false;
  if (timer) clearTimeout(timer); timer = null;
  if (pending) await pending;
}
