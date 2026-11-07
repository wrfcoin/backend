/**
 * Website forecast reveal worker (design 2026-11-05 §3, step 3).
 *
 * A reveal must land within 3 blocks of its commit on chain 888 (~77 s blocks, so about 4 minutes). Every
 * WEBSITE_FORECAST_POLL_MS (default 20 s, at least 10 s) the worker reads each open forecast's commit status
 * from the node with the Reader bearer (never unauthenticated: those polls get 429) and moves it on:
 *
 *   committing  the commit POST timed out: wait for the node to show it, or fail after 10 min
 *   committed   once the node has the commit in a block, relay the reveal (it lands in the next block)
 *   revealing   once the node shows it revealed, mark it revealed
 *   revealed    file the forecast verification record, so /forecast-check scores it with no hand-in
 *
 * OFF unless WEBSITE_FORECAST_ENABLED=true. Logs carry counts only, never addresses, stations or values.
 */
import { chainStatusFields, parseForecastRecord } from '../forecast-commit-record.js';
import { insertVerificationRecord, type Query } from '../forecast-verification/observed-verification.js';
import type { NodeForecastClient } from './node-forecast-client.js';
import { listOpen, markRecordFiled, setStatus, touchChecked, type OpenRow } from './website-forecast-store.js';
import { websiteForecastEnabled } from './website-forecast.js';

/** A commit the node has not shown within this long after we sent it is treated as dropped. */
export const COMMIT_NOT_SEEN_S = 10 * 60;
/** A forecast not revealed this long after its commit was first seen has missed the 3-block window. */
export const REVEAL_DEADLINE_S = 8 * 60;
const MAX_REVEAL_SENDS = 3;
const BATCH = 25;

type Logger = { info: (m: string, meta?: object) => void; warn: (m: string, meta?: object) => void };

export interface RevealWorkerDeps {
  query: Query;
  node: NodeForecastClient;
  now: () => number;
  logger?: Logger;
  minIntervalS?: number;
}

const seconds = (v: Date | string | null) => (v === null ? null : Math.floor(new Date(v).getTime() / 1000));
const height = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

export interface TickCounts { checked: number; revealSent: number; revealed: number; filed: number; failed: number; errors: number }

async function fileRecord(deps: RevealWorkerDeps, row: OpenRow, nowSec: number, counts: TickCounts) {
  const parsed = parseForecastRecord({ commitId: row.commit_id, nonce: row.nonce, timestamp: Number(row.commit_timestamp), data: row.data });
  if (parsed.ok === false) { await markRecordFiled(deps.query, nowSec, row.commit_id); return; }
  await insertVerificationRecord(deps.query, parsed.record, nowSec);
  await markRecordFiled(deps.query, nowSec, row.commit_id);
  counts.filed += 1;
}

async function step(deps: RevealWorkerDeps, row: OpenRow, nowSec: number, counts: TickCounts) {
  if (row.status === 'revealed') return fileRecord(deps, row, nowSec, counts);

  const read = await deps.node.readStatus(row.commit_id);
  counts.checked += 1;
  const status = read && read.status === 'not_found' ? null : read;
  const createdAt = seconds(row.created_at) ?? nowSec;
  if (status === null) {
    // Not in a block yet (or dropped from the mempool).
    if (nowSec - createdAt > COMMIT_NOT_SEEN_S) {
      if (await setStatus(deps.query, nowSec, row.commit_id, [row.status], 'failed', { failure: 'commit_not_seen' })) counts.failed += 1;
    } else {
      await touchChecked(deps.query, nowSec, row.commit_id);
    }
    return;
  }
  if (status.contribution_type !== undefined && status.contribution_type !== 'forecast') {
    await setStatus(deps.query, nowSec, row.commit_id, [row.status], 'failed', { failure: 'not_a_forecast' });
    counts.failed += 1;
    return;
  }
  const chain = chainStatusFields(status);
  const committedAtHeight = height(status.committed_at);
  if (chain.revealed) {
    if (await setStatus(deps.query, nowSec, row.commit_id, [row.status], 'revealed', {
      commitSeen: true, committedAtHeight, revealedAtHeight: chain.revealedAtHeight,
    })) {
      counts.revealed += 1;
      try { await fileRecord(deps, { ...row, status: 'revealed' }, nowSec, counts); } catch { counts.errors += 1; }
    }
    return;
  }
  const seenAt = seconds(row.commit_seen_at) ?? nowSec;
  if (row.status === 'committing') {
    await setStatus(deps.query, nowSec, row.commit_id, ['committing'], 'committed', { commitSeen: true, committedAtHeight });
    row = { ...row, status: 'committed' };
  }
  if (nowSec - seenAt > REVEAL_DEADLINE_S) {
    if (await setStatus(deps.query, nowSec, row.commit_id, [row.status], 'failed', { failure: 'reveal_window_missed' })) counts.failed += 1;
    return;
  }
  if (row.status === 'revealing') {
    await touchChecked(deps.query, nowSec, row.commit_id);
    return;
  }
  // committed and in a block: relay the reveal now, so it lands in the next block.
  if (row.reveal_attempts >= MAX_REVEAL_SENDS) {
    if (await setStatus(deps.query, nowSec, row.commit_id, ['committed'], 'failed', { failure: 'reveal_not_accepted' })) counts.failed += 1;
    return;
  }
  const manifest = typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest;
  const result = await deps.node.submitReveal({
    forecaster: row.forecaster,
    station_id: row.station_id,
    payload: JSON.parse(row.data),
    nonce: row.nonce,
    commit_hash: row.commit_id,
    timestamp: Number(row.commit_timestamp),
    manifest,
    auth_pubkey: row.auth_pubkey,
    auth_signature: row.auth_signature,
  });
  if (result.kind === 'accepted') {
    await setStatus(deps.query, nowSec, row.commit_id, ['committed'], 'revealing', {
      revealSent: true, commitSeen: true, committedAtHeight, revealTxHash: result.txHash,
    });
    counts.revealSent += 1;
  } else if (result.kind === 'refused') {
    await setStatus(deps.query, nowSec, row.commit_id, ['committed'], 'failed', { failure: `reveal_refused${result.code ? `:${result.code}` : ''}` });
    counts.failed += 1;
  } else {
    await setStatus(deps.query, nowSec, row.commit_id, ['committed'], 'committed', { commitSeen: true, committedAtHeight });
    await touchChecked(deps.query, nowSec, row.commit_id, { revealAttempt: true });
  }
}

export async function runRevealTick(deps: RevealWorkerDeps): Promise<TickCounts> {
  const nowSec = Math.floor(deps.now() / 1000);
  const counts: TickCounts = { checked: 0, revealSent: 0, revealed: 0, filed: 0, failed: 0, errors: 0 };
  const rows = await listOpen(deps.query, nowSec, deps.minIntervalS ?? 15, BATCH);
  for (const row of rows) {
    try {
      await step(deps, row, nowSec, counts);
    } catch {
      counts.errors += 1;
      try { await touchChecked(deps.query, nowSec, row.commit_id); } catch { /* next tick */ }
    }
  }
  return counts;
}

const DEFAULT_INTERVAL_MS = 20_000;

export async function startWebsiteForecastWorker(deps: Partial<RevealWorkerDeps> = {}): Promise<boolean> {
  if (!websiteForecastEnabled()) return false;
  const raw = Number(process.env.WEBSITE_FORECAST_POLL_MS);
  const intervalMs = Number.isFinite(raw) && raw >= 10_000 ? raw : DEFAULT_INTERVAL_MS;
  const query = deps.query ?? await (await import('../forecast-verification/observed-verification-job.js')).defaultQuery();
  const node = deps.node ?? await (await import('./node-forecast-client.js')).defaultNodeForecastClient();
  const now = deps.now ?? Date.now;
  let running = false;
  const timer = setInterval(() => {
    if (running || !websiteForecastEnabled()) return;
    running = true;
    runRevealTick({ query, node, now, logger: deps.logger, minIntervalS: Math.floor(intervalMs / 1000) - 2 })
      .then((c) => { if (c.revealSent || c.revealed || c.failed || c.errors) deps.logger?.info('website forecast: reveal tick', c); })
      .catch(() => deps.logger?.warn('website forecast: reveal tick failed'))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  deps.logger?.info('website forecast: reveal worker started', { intervalMs });
  return true;
}
