/**
 * Free-play forecast duels (backend#228, #1424; owner demo queue 2026-11-01, item 10).
 *
 * "Two forecasters pick the same station and hour. After the reveal, the chain's own scorer names the
 * winner in the app."
 *
 * FREE-PLAY ONLY: no stake, no escrow, no payout, nothing promised. Funded duels are a separate consensus
 * feature (`forecast_duels_v1`, owner rulings 2026-10-02 / 2026-10-03: testnet-only funding, mainnet
 * free-to-play) and are NOT built here. The 2026-04 service (forecast-duel-service.ts) that accepted a
 * `stakeAmount` nothing could ever settle is removed.
 *
 * How a duel runs:
 *   1. A wallet opens a duel on a station (public alias) and a target hour (the forecasts' valid_at),
 *      optionally naming the opponent wallet. Forecasts must be linked before the lock, LOCK_HOURS before
 *      the target (the forecast kit's 6-hour horizon).
 *   2. A second wallet accepts.
 *   3. Each player links its own forecast commit before the lock. The node must report a forecast commit
 *      for that station at the moment of linking; since linking happens before the lock, the commit was
 *      on chain before the lock.
 *   4. After revealing, each player (or anyone) hands in the commit record (forecast-commit-record.ts):
 *      its hash must equal the linked commit id, and its valid_at must be the duel's target hour.
 *   5. The judge is the chain: core4 pays a revealed forecast at the skill score of its oracle receipt
 *      (or the 0.1 baseline without one). The resolver reads each commit's FINALIZED forecast reward from
 *      the node (reward-evidence, Reader); the higher amount wins and equal amounts draw. The backend
 *      never computes a skill of its own for the verdict. The reward must have been credited to the
 *      player's own wallet, else the entry is invalid.
 *   6. An entry with no linked commit at the lock, or no valid record / finalized reward by
 *      RESOLVE_DEADLINE_HOURS after the target, forfeits; if both do, the duel is void.
 */
import { randomUUID } from 'node:crypto';
import {
  COMMIT_ID_RE,
  chainStatusFields,
  parseForecastRecord,
  readCommitStatus,
  type Core4Get,
  type ForecastRecordInput,
} from './forecast-commit-record.js';
import {
  STATION_ALIAS_SQL as STATION_ALIAS_SQL_IMPL,
  isStationAlias as isStationAliasImpl,
  stationAlias as stationAliasImpl,
} from '../utils/station-alias.js';

const stationAlias = stationAliasImpl as (id: string) => string;
const isStationAlias = isStationAliasImpl as (v: unknown) => boolean;
const STATION_ALIAS_SQL = STATION_ALIAS_SQL_IMPL as string;

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
export type { Core4Get };

export const duelsEnabled = () => process.env.FORECAST_DUELS_ENABLED === 'true';

export const LOCK_HOURS = 6;
export const MIN_LEAD_HOURS = LOCK_HOURS + 1;
export const MAX_LEAD_DAYS = 7;
export const RESOLVE_DEADLINE_HOURS = 48;
export const MAX_OPEN_PER_WALLET = 5;
const HOUR_MS = 3_600_000;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class DuelError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export const normalizeAddress = (v: unknown) => {
  if (typeof v !== 'string') return null;
  const lower = v.trim().toLowerCase();
  return ADDRESS_RE.test(lower) ? lower : null;
};
export const isDuelId = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export interface CreateInput { stationAlias: string; targetAt: number; opponent: string | null }

export function parseCreate(body: any, nowMs: number): CreateInput {
  if (!isStationAlias(body?.stationAlias)) throw new DuelError(400, 'INVALID_STATION', 'stationAlias must be a public station alias (st_ + 12 hex)');
  const targetAt = typeof body?.targetAt === 'string' ? Date.parse(body.targetAt) : NaN;
  if (!Number.isFinite(targetAt) || targetAt % HOUR_MS !== 0) throw new DuelError(400, 'INVALID_TARGET', 'targetAt must be an ISO time on the hour (UTC)');
  if (targetAt < nowMs + MIN_LEAD_HOURS * HOUR_MS || targetAt > nowMs + MAX_LEAD_DAYS * 24 * HOUR_MS) {
    throw new DuelError(400, 'INVALID_TARGET', `targetAt must be between ${MIN_LEAD_HOURS} hours and ${MAX_LEAD_DAYS} days from now, so both players can commit before the lock`);
  }
  let opponent: string | null = null;
  if (body?.opponent !== undefined && body?.opponent !== null && body?.opponent !== '') {
    opponent = normalizeAddress(body.opponent);
    if (!opponent) throw new DuelError(400, 'INVALID_OPPONENT', 'opponent must be a 0x wallet address');
  }
  return { stationAlias: body.stationAlias, targetAt, opponent };
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : null);
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

const DUEL_COLUMNS = `id, station_alias, target_at, lock_at, creator_address, opponent_address, status, outcome, outcome_reason,
  winner_address, created_at, matched_at, resolved_at`;
const ENTRY_COLUMNS = `duel_id, address, commit_id, linked_at, record_ok, model_id, forecast_values, reward_amount, reward_finalized,
  entry_status, invalid_reason`;

export const OUTCOME_NOTES: Record<string, string> = {
  higher_chain_reward: 'The chain paid this forecast more: its oracle receipt scored higher.',
  equal_chain_reward: 'The chain paid both forecasts the same amount. Without an oracle receipt every forecast earns the 0.1 baseline, so this is a draw.',
  forfeit: 'The other player had no valid entry by the deadline.',
  no_opponent: 'Nobody accepted the duel before the lock.',
  no_valid_entries: 'Neither player had a valid entry by the deadline.',
};

export function duelView(d: any, entries: any[], nowMs: number) {
  const lockMs = new Date(d.lock_at).getTime();
  const targetMs = new Date(d.target_at).getTime();
  const phase = d.status === 'resolved' || d.status === 'void' ? d.status
    : d.status === 'open' ? (nowMs >= lockMs ? 'expired' : 'open')
      : nowMs < lockMs ? 'committing' : nowMs < targetMs ? 'waiting_for_target' : 'judging';
  const entry = (address: string | null) => {
    if (!address) return null;
    const e = entries.find((x) => x.address === address);
    return {
      address,
      commitId: e?.commit_id ?? null,
      linkedAt: iso(e?.linked_at),
      recordVerified: e?.record_ok === true,
      modelId: e?.model_id ?? null,
      // The forecast values are shown only once the record is verified, which needs the on-chain reveal.
      forecast: e?.record_ok ? json(e.forecast_values) : null,
      chainReward: e?.reward_amount ?? null,
      chainRewardFinalized: e?.reward_finalized === true,
      status: e?.entry_status ?? 'no_entry',
      invalidReason: e?.invalid_reason ?? null,
    };
  };
  return {
    id: d.id,
    stationAlias: d.station_alias,
    targetAt: iso(d.target_at),
    lockAt: iso(d.lock_at),
    resolveBy: new Date(targetMs + RESOLVE_DEADLINE_HOURS * HOUR_MS).toISOString(),
    status: d.status,
    phase,
    mode: 'free_play',
    stakes: null,
    creator: entry(d.creator_address),
    opponent: d.status === 'open' ? null : entry(d.opponent_address),
    invitedOpponent: d.status === 'open' ? d.opponent_address ?? null : null,
    outcome: d.outcome ? { result: d.outcome, winner: d.winner_address ?? null, reason: d.outcome_reason, note: OUTCOME_NOTES[d.outcome_reason] ?? null } : null,
    judge: 'The chain: each forecast\'s finalized forecast reward on chain (oracle receipt skill, else the 0.1 baseline). Free play, no stakes.',
    createdAt: iso(d.created_at),
    matchedAt: iso(d.matched_at),
    resolvedAt: iso(d.resolved_at),
  };
}

async function views(query: Query, duels: any[], nowMs: number) {
  if (duels.length === 0) return [];
  const entries = (await query(`SELECT ${ENTRY_COLUMNS} FROM forecast_duel_entries WHERE duel_id = ANY($1::text[])`, [duels.map((d) => d.id)])).rows;
  return duels.map((d) => duelView(d, entries.filter((e) => e.duel_id === d.id), nowMs));
}

export async function readDuel(query: Query, id: string, nowMs: number) {
  const d = (await query(`SELECT ${DUEL_COLUMNS} FROM forecast_duels WHERE id = $1`, [id])).rows[0];
  return d ? (await views(query, [d], nowMs))[0] : null;
}

/** Open duels anyone can accept, and the last 20 that finished. */
export async function listBoard(query: Query, nowMs: number) {
  const open = (await query(`SELECT ${DUEL_COLUMNS} FROM forecast_duels WHERE status = 'open' AND lock_at > to_timestamp($1)
    ORDER BY target_at ASC LIMIT 50`, [nowMs / 1000])).rows;
  const live = (await query(`SELECT ${DUEL_COLUMNS} FROM forecast_duels WHERE status = 'matched'
    ORDER BY target_at ASC LIMIT 50`)).rows;
  const finished = (await query(`SELECT ${DUEL_COLUMNS} FROM forecast_duels WHERE status IN ('resolved', 'void')
    ORDER BY resolved_at DESC LIMIT 20`)).rows;
  return { open: await views(query, open, nowMs), live: await views(query, live, nowMs), finished: await views(query, finished, nowMs) };
}

export async function listMine(query: Query, address: string, nowMs: number) {
  const rows = (await query(`SELECT ${DUEL_COLUMNS} FROM forecast_duels WHERE creator_address = $1 OR opponent_address = $1
    ORDER BY target_at DESC LIMIT 50`, [address])).rows;
  return views(query, rows, nowMs);
}

/** The station must be one the backend knows (weather_stations), so a duel names a real station. */
export async function stationKnown(query: Query, alias: string): Promise<boolean> {
  const rows = (await query(`SELECT station_id FROM weather_stations WHERE ${STATION_ALIAS_SQL} = $1 LIMIT 2`, [alias])).rows;
  return rows.length === 1 && stationAlias(rows[0].station_id) === alias;
}

export async function createDuel(query: Query, address: string, input: CreateInput, nowMs: number) {
  if (input.opponent === address) throw new DuelError(400, 'INVALID_OPPONENT', 'You cannot duel yourself');
  if (!(await stationKnown(query, input.stationAlias))) throw new DuelError(404, 'UNKNOWN_STATION', 'No station has that alias');
  const open = (await query('SELECT count(*)::int AS n FROM forecast_duels WHERE creator_address = $1 AND status IN (\'open\', \'matched\')', [address])).rows[0];
  if (Number(open?.n ?? 0) >= MAX_OPEN_PER_WALLET) throw new DuelError(409, 'TOO_MANY_OPEN', `A wallet can have at most ${MAX_OPEN_PER_WALLET} unresolved duels`);
  const id = randomUUID();
  await query(`INSERT INTO forecast_duels (id, station_alias, target_at, lock_at, creator_address, opponent_address, status)
    VALUES ($1, $2, to_timestamp($3), to_timestamp($4), $5, $6, 'open')`,
  [id, input.stationAlias, input.targetAt / 1000, (input.targetAt - LOCK_HOURS * HOUR_MS) / 1000, address, input.opponent]);
  return readDuel(query, id, nowMs);
}

export async function acceptDuel(query: Query, address: string, id: string, nowMs: number) {
  const d = (await query(`SELECT ${DUEL_COLUMNS} FROM forecast_duels WHERE id = $1`, [id])).rows[0];
  if (!d) throw new DuelError(404, 'NO_SUCH_DUEL', 'No duel with that id');
  if (d.creator_address === address) throw new DuelError(409, 'OWN_DUEL', 'You opened this duel; another wallet must accept it');
  if (d.status !== 'open') throw new DuelError(409, 'NOT_OPEN', 'This duel already has two players');
  if (new Date(d.lock_at).getTime() <= nowMs) throw new DuelError(409, 'LOCKED', 'This duel is past its lock time');
  if (d.opponent_address && d.opponent_address !== address) throw new DuelError(403, 'NOT_INVITED', 'This duel is for another wallet');
  const updated = (await query(`UPDATE forecast_duels SET opponent_address = $2, status = 'matched', matched_at = to_timestamp($3)
    WHERE id = $1 AND status = 'open' AND (opponent_address IS NULL OR opponent_address = $2) RETURNING id`, [id, address, nowMs / 1000])).rows;
  if (updated.length === 0) throw new DuelError(409, 'NOT_OPEN', 'This duel already has two players');
  return readDuel(query, id, nowMs);
}

/** Link the caller's own forecast commit, before the lock. */
export async function linkCommit(query: Query, get: Core4Get, address: string, id: string, rawCommitId: unknown, nowMs: number) {
  const commitId = typeof rawCommitId === 'string' ? rawCommitId.trim().toLowerCase() : '';
  if (!COMMIT_ID_RE.test(commitId)) throw new DuelError(400, 'INVALID_COMMIT_ID', 'commitId must be 64 hex characters');
  const d = (await query(`SELECT ${DUEL_COLUMNS} FROM forecast_duels WHERE id = $1`, [id])).rows[0];
  if (!d) throw new DuelError(404, 'NO_SUCH_DUEL', 'No duel with that id');
  if (d.creator_address !== address && !(d.status === 'matched' && d.opponent_address === address)) {
    throw new DuelError(403, 'NOT_A_PLAYER', 'Only the two players can link forecasts');
  }
  if (d.status !== 'open' && d.status !== 'matched') throw new DuelError(409, 'NOT_ACTIVE', 'This duel is over');
  if (new Date(d.lock_at).getTime() <= nowMs) throw new DuelError(409, 'LOCKED', 'Forecasts had to be linked before the lock');
  const existing = (await query('SELECT commit_id FROM forecast_duel_entries WHERE duel_id = $1 AND address = $2', [id, address])).rows[0];
  if (existing) throw new DuelError(409, 'ALREADY_LINKED', 'You already linked a forecast to this duel');
  const read = await readCommitStatus(get, commitId);
  if (read.kind === 'not_found') throw new DuelError(404, 'NOT_ON_CHAIN', 'The node has no commit with this id; commit your forecast first');
  if (read.kind === 'upstream') throw new DuelError(502, 'UPSTREAM_ERROR', 'The chain node could not answer');
  if (read.status.contribution_type !== 'forecast') throw new DuelError(409, 'NOT_A_FORECAST', 'This commit is not a forecast');
  if (typeof read.status.station_id !== 'string' || stationAlias(read.status.station_id) !== d.station_alias) {
    throw new DuelError(409, 'STATION_MISMATCH', 'This forecast is for a different station');
  }
  const inserted = (await query(`INSERT INTO forecast_duel_entries (duel_id, address, commit_id, linked_at, entry_status)
    VALUES ($1, $2, $3, to_timestamp($4), 'linked') ON CONFLICT DO NOTHING RETURNING commit_id`, [id, address, commitId, nowMs / 1000])).rows;
  if (inserted.length === 0) throw new DuelError(409, 'ALREADY_LINKED', 'This forecast or player is already linked');
  return readDuel(query, id, nowMs);
}

/** Hand in a linked commit's record after the reveal (no login needed: the record proves itself). */
export async function submitRecord(query: Query, get: Core4Get, id: string, body: ForecastRecordInput, nowMs: number) {
  const parsed = parseForecastRecord(body ?? {});
  if (parsed.ok === false) throw new DuelError(400, parsed.code, parsed.message);
  const record = parsed.record;
  const d = (await query(`SELECT ${DUEL_COLUMNS} FROM forecast_duels WHERE id = $1`, [id])).rows[0];
  if (!d) throw new DuelError(404, 'NO_SUCH_DUEL', 'No duel with that id');
  const entry = (await query('SELECT address, record_ok FROM forecast_duel_entries WHERE duel_id = $1 AND commit_id = $2', [id, record.commitId])).rows[0];
  if (!entry) throw new DuelError(404, 'NOT_LINKED', 'This commit is not linked to this duel');
  if (entry.record_ok) return readDuel(query, id, nowMs);
  if (record.stationAlias !== d.station_alias) throw new DuelError(409, 'STATION_MISMATCH', 'This forecast is for a different station');
  if (record.validAt * 1000 !== new Date(d.target_at).getTime()) throw new DuelError(409, 'TARGET_MISMATCH', 'This forecast is for a different hour than the duel');
  const read = await readCommitStatus(get, record.commitId);
  if (read.kind === 'not_found') throw new DuelError(404, 'NOT_ON_CHAIN', 'The node has no commit with this id');
  if (read.kind === 'upstream') throw new DuelError(502, 'UPSTREAM_ERROR', 'The chain node could not answer');
  if (!chainStatusFields(read.status).revealed) throw new DuelError(409, 'NOT_REVEALED', 'Reveal the forecast on chain first');
  await query('UPDATE forecast_duel_entries SET record_ok = true, model_id = $3, forecast_values = $4 WHERE duel_id = $1 AND commit_id = $2',
    [id, record.commitId, record.modelId, JSON.stringify(record.values)]);
  return readDuel(query, id, nowMs);
}

// ---------------------------------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------------------------------

function unwrap(payload: any): Record<string, any> | null {
  const data = payload && typeof payload === 'object' && payload.ok === true && 'data' in payload ? payload.data : payload;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

/** core4 reward-evidence: the forecast's reward record (amount, finalized, credited address). */
export async function chainReward(get: Core4Get, commitId: string): Promise<{ amount: string; finalized: boolean; address: string } | null | 'upstream'> {
  let reply;
  try { reply = await get(`/transactions/contributions/${commitId}/reward-evidence`); } catch { return 'upstream'; }
  if (reply.status === 404) return null;
  const body = reply.ok ? unwrap(reply.payload) : null;
  if (!body || body.commit_id !== commitId) return 'upstream';
  const r = body.reward;
  if (!r || typeof r !== 'object') return null;
  const amount = typeof r.amount === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(r.amount) ? r.amount
    : typeof r.amount === 'number' && Number.isSafeInteger(r.amount) && r.amount >= 0 ? String(r.amount) : null;
  const address = normalizeAddress(r.address);
  if (amount === null || !address || r.reason !== `forecast:${commitId}`) return 'upstream';
  return { amount, finalized: r.finalized === true, address };
}

async function settle(query: Query, id: string, outcome: 'creator' | 'opponent' | 'draw' | 'void', reason: string, winner: string | null, nowMs: number) {
  await query(`UPDATE forecast_duels SET status = $2, outcome = $3, outcome_reason = $4, winner_address = $5, resolved_at = to_timestamp($6)
    WHERE id = $1 AND status IN ('open', 'matched')`, [id, outcome === 'void' ? 'void' : 'resolved', outcome, reason, winner, nowMs / 1000]);
}

export async function resolvePass({ query, get, nowMs }: { query: Query; get: Core4Get; nowMs: number }) {
  const nowSec = nowMs / 1000;
  const result = { voided: 0, resolved: 0, waiting: 0, failed: 0 };
  // Open duels nobody accepted before the lock.
  result.voided += (await query(`UPDATE forecast_duels SET status = 'void', outcome = 'void', outcome_reason = 'no_opponent', resolved_at = to_timestamp($1)
    WHERE status = 'open' AND lock_at <= to_timestamp($1) RETURNING id`, [nowSec])).rows.length;

  const duels = (await query(`SELECT ${DUEL_COLUMNS} FROM forecast_duels WHERE status = 'matched' AND target_at <= to_timestamp($1)
    ORDER BY target_at ASC LIMIT 25`, [nowSec])).rows;
  for (const d of duels) {
    const entries = (await query(`SELECT ${ENTRY_COLUMNS} FROM forecast_duel_entries WHERE duel_id = $1`, [d.id])).rows;
    const pastDeadline = nowMs >= new Date(d.target_at).getTime() + RESOLVE_DEADLINE_HOURS * HOUR_MS;
    const sides: Array<{ address: string; valid: boolean | null; amount: bigint | null }> = [];
    let failed = false;
    for (const address of [d.creator_address, d.opponent_address] as string[]) {
      const e = entries.find((x) => x.address === address);
      // No commit linked before the lock, or already ruled invalid.
      if (!e || e.entry_status === 'invalid') { sides.push({ address, valid: false, amount: null }); continue; }
      const reward = await chainReward(get, e.commit_id);
      if (reward === 'upstream') { failed = true; break; }
      if (reward && reward.address !== address) {
        await query('UPDATE forecast_duel_entries SET entry_status = \'invalid\', invalid_reason = \'reward_credited_to_another_wallet\' WHERE duel_id = $1 AND address = $2', [d.id, address]);
        sides.push({ address, valid: false, amount: null });
        continue;
      }
      if (reward) {
        await query('UPDATE forecast_duel_entries SET reward_amount = $3, reward_finalized = $4 WHERE duel_id = $1 AND address = $2', [d.id, address, reward.amount, reward.finalized]);
      }
      const ready = e.record_ok === true && reward !== null && reward.finalized;
      sides.push({ address, valid: ready ? true : null, amount: ready && reward ? BigInt(reward.amount) : null });
    }
    if (failed) { result.failed += 1; continue; }
    const [c, o] = sides;
    if (c.valid === true && o.valid === true) {
      const ca = c.amount as bigint;
      const oa = o.amount as bigint;
      if (ca === oa) await settle(query, d.id, 'draw', 'equal_chain_reward', null, nowMs);
      else if (ca > oa) await settle(query, d.id, 'creator', 'higher_chain_reward', c.address, nowMs);
      else await settle(query, d.id, 'opponent', 'higher_chain_reward', o.address, nowMs);
      result.resolved += 1;
      continue;
    }
    const cOut = c.valid === false || (c.valid === null && pastDeadline);
    const oOut = o.valid === false || (o.valid === null && pastDeadline);
    if (cOut && oOut) { await settle(query, d.id, 'void', 'no_valid_entries', null, nowMs); result.voided += 1; continue; }
    if (cOut && o.valid === true) { await settle(query, d.id, 'opponent', 'forfeit', o.address, nowMs); result.resolved += 1; continue; }
    if (oOut && c.valid === true) { await settle(query, d.id, 'creator', 'forfeit', c.address, nowMs); result.resolved += 1; continue; }
    result.waiting += 1;
  }
  return result;
}
