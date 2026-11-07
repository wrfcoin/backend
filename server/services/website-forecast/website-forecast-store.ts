/**
 * Storage for website forecasts (migration 0043_website_forecasts). One row per relayed commit; the row
 * holds the reveal package until the reveal lands. Read by the reveal worker and the "my forecasts" list.
 */
import type { Query } from '../forecast-verification/observed-verification.js';
import type { CheckedSubmission } from './website-forecast.js';

export type ForecastStatus = 'committing' | 'committed' | 'revealing' | 'revealed' | 'failed';

/** Registered station by public alias (fails closed on an alias collision). */
export async function resolveRegisteredStation(query: Query, alias: string): Promise<string | null> {
  const mod: any = await import('../../utils/station-alias.js');
  const resolve = (mod.resolveStationAlias ?? mod.default?.resolveStationAlias) as
    (q: (sql: string, params: unknown[]) => Promise<any[]>, alias: string) => Promise<{ status: string; stationId?: string }>;
  const result = await resolve(async (sql, params) => (await query(sql, params)).rows, alias);
  return result.status === 'found' && typeof result.stationId === 'string' ? result.stationId : null;
}

/** The wallet's live forecast for this station, lead and UTC day, if any (failed ones do not count). */
export async function findForecastForDay(query: Query, forecaster: string, stationId: string, leadHours: number, day: string): Promise<string | null> {
  const row = (await query(`SELECT commit_id FROM website_forecasts
    WHERE forecaster = $1 AND station_id = $2 AND horizon_hours = $3 AND forecast_day = $4::date AND status <> 'failed' LIMIT 1`,
  [forecaster, stationId, leadHours, day])).rows[0];
  return row ? String(row.commit_id) : null;
}

/**
 * Claim the (wallet, station, lead, day) slot and store the reveal package. Returns false when the slot is
 * taken (the partial unique index decides, so two racing submissions cannot both win).
 */
export async function insertCommitting(query: Query, s: CheckedSubmission, nowSec: number): Promise<boolean> {
  // A commit the node refused earlier may be sent again unchanged; its failed row gives way.
  await query('DELETE FROM website_forecasts WHERE commit_id = $1 AND status = \'failed\'', [s.record.commitId]);
  const rows = (await query(`INSERT INTO website_forecasts
      (commit_id, forecaster, station_id, station_alias, variable, value, horizon_hours, issued_at, valid_at, forecast_day,
       data, nonce, commit_timestamp, manifest, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), to_timestamp($9), $10::date, $11, $12, $13, $14, 'committing',
       to_timestamp($15), to_timestamp($15))
    ON CONFLICT DO NOTHING RETURNING commit_id`,
  [s.record.commitId, s.forecaster, s.record.stationId, s.record.stationAlias, s.variable, s.value, s.leadHours,
    s.record.issuedAt, s.record.validAt, s.forecastDay, s.data, s.nonce, s.timestamp, JSON.stringify(s.manifest), nowSec])).rows;
  return rows.length === 1;
}

export async function setStatus(query: Query, nowSec: number, commitId: string, from: ForecastStatus[], to: ForecastStatus,
  fields: { failure?: string | null; commitTxHash?: string | null; revealTxHash?: string | null; committedAtHeight?: number | null;
    revealedAtHeight?: number | null; revealSent?: boolean; commitSeen?: boolean } = {}): Promise<boolean> {
  const rows = (await query(`UPDATE website_forecasts SET status = $3,
      failure = CASE WHEN $3 = 'failed' THEN $4 ELSE NULL END,
      commit_tx_hash = COALESCE($5, commit_tx_hash),
      reveal_tx_hash = COALESCE($6, reveal_tx_hash),
      committed_at_height = COALESCE($7, committed_at_height),
      revealed_at_height = COALESCE($8, revealed_at_height),
      reveal_sent_at = CASE WHEN $9 THEN to_timestamp($11) ELSE reveal_sent_at END,
      reveal_attempts = reveal_attempts + CASE WHEN $9 THEN 1 ELSE 0 END,
      commit_seen_at = CASE WHEN $10 AND commit_seen_at IS NULL THEN to_timestamp($11) ELSE commit_seen_at END,
      last_checked_at = to_timestamp($11), updated_at = to_timestamp($11)
    WHERE commit_id = $1 AND status = ANY($2::text[]) RETURNING commit_id`,
  [commitId, from, to, fields.failure ?? null, fields.commitTxHash ?? null, fields.revealTxHash ?? null,
    fields.committedAtHeight ?? null, fields.revealedAtHeight ?? null, fields.revealSent === true, fields.commitSeen === true, nowSec])).rows;
  return rows.length === 1;
}

export async function touchChecked(query: Query, nowSec: number, commitId: string, fields: { revealAttempt?: boolean } = {}): Promise<void> {
  await query(`UPDATE website_forecasts SET last_checked_at = to_timestamp($3),
      reveal_attempts = reveal_attempts + CASE WHEN $2 THEN 1 ELSE 0 END WHERE commit_id = $1`,
  [commitId, fields.revealAttempt === true, nowSec]);
}

export async function markRecordFiled(query: Query, nowSec: number, commitId: string): Promise<void> {
  await query('UPDATE website_forecasts SET record_filed = true, updated_at = to_timestamp($2) WHERE commit_id = $1', [commitId, nowSec]);
}

export interface OpenRow {
  commit_id: string; forecaster: string; station_id: string; station_alias: string; variable: string; value: number;
  horizon_hours: number; data: string; nonce: string; commit_timestamp: string | number; manifest: any; status: ForecastStatus;
  record_filed: boolean; reveal_attempts: number; created_at: Date | string; commit_seen_at: Date | string | null;
  reveal_sent_at: Date | string | null; issued_at: Date | string; valid_at: Date | string;
}

/** Rows the worker still has to move, oldest first, each at most once per `minIntervalS`. */
export async function listOpen(query: Query, nowSec: number, minIntervalS: number, limit: number): Promise<OpenRow[]> {
  return (await query(`SELECT commit_id, forecaster, station_id, station_alias, variable, value, horizon_hours, data, nonce,
      commit_timestamp, manifest, status, record_filed, reveal_attempts, created_at, commit_seen_at, reveal_sent_at, issued_at, valid_at
    FROM website_forecasts
    WHERE (status IN ('committing', 'committed', 'revealing') OR (status = 'revealed' AND NOT record_filed))
      AND (last_checked_at IS NULL OR last_checked_at <= to_timestamp($1) - make_interval(secs => $2))
    ORDER BY created_at ASC LIMIT $3`, [nowSec, minIntervalS, limit])).rows as OpenRow[];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : null);
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** The wallet's own forecasts, newest first, with the practice score once the scorer has it. */
export async function listMine(query: Query, forecaster: string, limit = 50) {
  const rows = (await query(`SELECT w.commit_id, w.station_alias, w.variable, w.value, w.horizon_hours, w.issued_at, w.valid_at,
      w.status, w.failure, w.commit_tx_hash, w.reveal_tx_hash, w.committed_at_height, w.revealed_at_height,
      r.status AS score_status, r.scores AS scores
    FROM website_forecasts w LEFT JOIN forecast_verification_records r ON r.commit_id = w.commit_id
    WHERE w.forecaster = $1 ORDER BY w.created_at DESC LIMIT $2`, [forecaster, limit])).rows;
  return rows.map((row: any) => {
    const scores = json(row.scores) ?? {};
    const s = scores[row.variable];
    return {
      commitId: row.commit_id,
      stationAlias: row.station_alias,
      variable: row.variable,
      value: Number(row.value),
      leadHours: Number(row.horizon_hours),
      issuedAt: iso(row.issued_at),
      validAt: iso(row.valid_at),
      status: row.status,
      failure: row.failure ?? null,
      commitTxHash: row.commit_tx_hash ?? null,
      revealTxHash: row.reveal_tx_hash ?? null,
      committedAtHeight: num(row.committed_at_height),
      revealedAtHeight: num(row.revealed_at_height),
      score: row.score_status
        ? {
          status: row.score_status,
          forecast: typeof s?.forecast === 'number' ? s.forecast : null,
          truth: typeof s?.truth === 'number' ? s.truth : null,
          error: typeof s?.error === 'number' ? s.error : null,
        }
        : null,
    };
  });
}
