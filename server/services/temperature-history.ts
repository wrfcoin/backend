/**
 * Daily air-temperature history for one 0.1 degree cell (Refs wrfcoin/mobile#299).
 *
 * Source: weather_submissions (temperature numeric(6,2), latitude/longitude
 * numeric(9,6), submitted_at), written by persistWeatherSubmission. Stored
 * coordinates are fine-grained, so the cell is matched INSIDE the query and
 * neither the caller nor the response ever carries a coordinate finer than the
 * cell's integer tenths. The cell convention is the registration one: centre
 * latE1/10, half-width 0.05 degrees (half-open, lower edge included).
 *
 * RELEASE POLICY (reviewed in backend#1382; the aim is to stop a caller
 * recovering one observation by differencing, not to claim anonymity against
 * arbitrary auxiliary knowledge):
 *   - DAILY values only, for COMPLETED UTC days only. There is no partial today
 *     and no hourly series, so the values of an exposed day do not depend on the
 *     query window (days=1 vs days=2 returns the same day identically).
 *   - A day is exposed only when it has at least MIN_DAY_CONTRIBUTORS (5)
 *     DISTINCT contributors; otherwise its values are null. A row with no
 *     station/device/wallet identifier cannot be counted as a distinct
 *     contributor, so it is not used at all.
 *   - min, max and mean are rounded to 0.5 C; exact sample counts are not
 *     returned (each day carries a count rounded DOWN to a multiple of 10, and
 *     sampleCount is the sum of the published days' buckets).
 *   - IMMUTABLE RELEASE, two layers:
 *     1. submitted_at is the CLIENT's reading time, so it cannot decide what a
 *        published day contains. received_at (migration 0027) is the server's own
 *        clock at INSERT (no writer sets it; the default applies). A UTC day D is
 *        published only after D_end + PUBLISH_GRACE_SECONDS (2 h), and counts ONLY
 *        rows with submitted_at inside D AND received_at <= D_end + grace.
 *     2. received_at defaults to now() = TRANSACTION START, so a qualifying write
 *        can still be uncommitted at first publication and appear later. So the
 *        FIRST aggregate of each (cell, day) is stored in
 *        weather_temperature_daily_release (INSERT ... ON CONFLICT DO NOTHING) and
 *        the endpoint serves ONLY from that table: a released day never changes and
 *        every window reads the same row; a suppressed day is stored as NULLs and
 *        stays suppressed; days with no eligible row are not stored. Layer 1
 *        minimises what the first release misses.
 *     Legacy rows were backfilled received_at = LEAST(submitted_at, now()) by
 *     owner ruling (pre-launch rows came only from the operator's own devices).
 *     Residual limits: stable, not anonymous against arbitrary auxiliary
 *     knowledge; it assumes source rows are not updated or deleted after insert;
 *     a write that commits after the first release of its day is never counted.
 *     Write amplification: an authenticated, rate-limited read may insert up to
 *     `days` (<= 14) release rows, only for days that have eligible readings.
 * Honest nulls: a day without enough data (or not yet published) carries null
 * values; an empty cell is an empty result with sampleCount 0. Nothing is
 * interpolated.
 *
 * Work bound: inside ONE transaction with a DATABASE-SIDE statement_timeout
 * (set_config(..., true) = SET LOCAL) two statements run in order, the release
 * insert then the serve select, each cancelled by the database at the deadline;
 * a cancelled statement aborts the transaction so nothing later is started. The
 * bound is the timeout, not a row count.
 */

export interface Queryable {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

/** Runs the callback inside one database transaction. */
export type TransactionRunner = <T>(callback: (tx: Queryable) => Promise<T>) => Promise<T>;

export const MAX_DAYS = 14;
export const DEFAULT_DAYS = 14;
export const STATEMENT_TIMEOUT_MS = 5000;
/** A completed UTC day is published this long after it ends; later-received rows never count toward it. */
export const PUBLISH_GRACE_SECONDS = 7200;
export const MIN_DAY_CONTRIBUTORS = 5;
export const MIN_TEMPERATURE_C = -90;
export const MAX_TEMPERATURE_C = 60;
export const MIN_QUALITY_SCORE = 50;

export interface DailyTemperature {
  date: string;
  minC: number | null;
  maxC: number | null;
  meanC: number | null;
}

export interface TemperatureHistory {
  cell: { latE1: number; lonE1: number };
  days: number;
  /** Published UTC days covered, inclusive (a day is published 2 h after it ends). */
  window: { from: string; to: string };
  daily: DailyTemperature[];
  /** Readings in the exposed days, rounded DOWN to a multiple of 10. */
  sampleCount: number;
}

/** Integer hundredths of a degree -> exact decimal string (no float drift). */
function hundredthsToDecimal(hundredths: number): string {
  const sign = hundredths < 0 ? '-' : '';
  const abs = Math.abs(hundredths);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function cellBounds(e1: number): { lower: string; upper: string } {
  return { lower: hundredthsToDecimal(e1 * 10 - 5), upper: hundredthsToDecimal(e1 * 10 + 5) };
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Releases the FIRST aggregate of every published day that has eligible rows and
 * is not released yet. ON CONFLICT DO NOTHING: an existing release is never
 * touched, and two concurrent first reads produce one row. A suppressed day
 * (fewer than MIN_DAY_CONTRIBUTORS distinct contributors) is stored with NULLs
 * so it stays suppressed. Values are rounded to 0.5 C and the count to a
 * multiple of 10 HERE, so what is stored is exactly what is ever served.
 */
export const RELEASE_SQL = `
  WITH eligible AS (
    SELECT temperature,
           (submitted_at AT TIME ZONE 'UTC')::date AS day,
           COALESCE(station_id, device_id, wallet_address) AS contributor
    FROM weather_submissions
    WHERE temperature IS NOT NULL
      AND temperature BETWEEN $1 AND $2
      AND quality_score >= $3
      AND physics_violations = '[]'::jsonb
      AND COALESCE(station_id, device_id, wallet_address) IS NOT NULL
      AND latitude >= $4::numeric AND latitude < $5::numeric
      AND longitude >= $6::numeric AND longitude < $7::numeric
      AND submitted_at >= $8::timestamptz AND submitted_at < $9::timestamptz
      AND received_at <= ((submitted_at AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC'
                         + make_interval(secs => $11::int)
      AND NOT EXISTS (
        SELECT 1 FROM weather_temperature_daily_release r
        WHERE r.lat_e1 = $12::int AND r.lon_e1 = $13::int
          AND r.day = (submitted_at AT TIME ZONE 'UTC')::date
      )
  )
  INSERT INTO weather_temperature_daily_release (lat_e1, lon_e1, day, min_c, max_c, mean_c, count_bucket)
  SELECT $12::int, $13::int, day,
         CASE WHEN COUNT(DISTINCT contributor) >= $10 THEN ROUND(MIN(temperature) * 2) / 2 END,
         CASE WHEN COUNT(DISTINCT contributor) >= $10 THEN ROUND(MAX(temperature) * 2) / 2 END,
         CASE WHEN COUNT(DISTINCT contributor) >= $10 THEN ROUND(AVG(temperature) * 2) / 2 END,
         CASE WHEN COUNT(DISTINCT contributor) >= $10 THEN (COUNT(*) / 10) * 10 END
  FROM eligible
  GROUP BY day
  ON CONFLICT (lat_e1, lon_e1, day) DO NOTHING`;

/** Serves ONLY from the release table. */
export const SERVE_SQL = `
  SELECT to_char(day, 'YYYY-MM-DD') AS day,
         min_c::float8 AS min_c,
         max_c::float8 AS max_c,
         mean_c::float8 AS mean_c,
         count_bucket
  FROM weather_temperature_daily_release
  WHERE lat_e1 = $1 AND lon_e1 = $2 AND day >= $3::date AND day < $4::date
  ORDER BY day`;

export async function getTemperatureHistory(
  run: TransactionRunner,
  input: { latE1: number; lonE1: number; days: number },
  now: Date = new Date(),
): Promise<TemperatureHistory> {
  const { latE1, lonE1, days } = input;
  const lat = cellBounds(latE1);
  const lon = cellBounds(lonE1);
  // Published UTC days only: day D is published once D_end + grace has passed, so
  // the window is [today' - days, today') where today' is the UTC day of
  // (now - grace). The current day, and the days still inside the grace period,
  // are never included.
  const visibleUntil = new Date(now.getTime() - PUBLISH_GRACE_SECONDS * 1000);
  const today = new Date(
    Date.UTC(visibleUntil.getUTCFullYear(), visibleUntil.getUTCMonth(), visibleUntil.getUTCDate()),
  );
  const from = new Date(today.getTime() - days * 86400000);
  const releaseParams = [
    MIN_TEMPERATURE_C, MAX_TEMPERATURE_C, MIN_QUALITY_SCORE,
    lat.lower, lat.upper, lon.lower, lon.upper,
    from.toISOString(), today.toISOString(),
    MIN_DAY_CONTRIBUTORS,
    PUBLISH_GRACE_SECONDS,
    latE1, lonE1,
  ];

  const served = await run(async (tx) => {
    // SET LOCAL: the database cancels each statement at the deadline; a cancelled
    // statement aborts the transaction, so nothing later is started.
    await tx.execute('SELECT set_config(\'statement_timeout\', $1, true)', [String(STATEMENT_TIMEOUT_MS)]);
    await tx.execute(RELEASE_SQL, releaseParams);
    return tx.execute(SERVE_SQL, [latE1, lonE1, utcDay(from), utcDay(today)]);
  });

  const byDay = new Map<string, DailyTemperature>();
  const counts = new Map<string, number>();
  let samples = 0;
  for (const row of served.rows) {
    const date = String(row.day);
    const minC = row.min_c === null ? null : Number(row.min_c);
    const maxC = row.max_c === null ? null : Number(row.max_c);
    const meanC = row.mean_c === null ? null : Number(row.mean_c);
    const bucket = row.count_bucket === null ? 0 : Number(row.count_bucket);
    const values = [minC, maxC, meanC];
    if (values.some((v) => v !== null && !Number.isFinite(v)) || !Number.isFinite(bucket)) continue;
    byDay.set(date, { date, minC, maxC, meanC });
    counts.set(date, bucket);
  }

  // Only the published days of the window are ever emitted or counted.
  const daily: DailyTemperature[] = [];
  for (let t = from.getTime(); t < today.getTime(); t += 86400000) {
    const date = utcDay(new Date(t));
    daily.push(byDay.get(date) ?? { date, minC: null, maxC: null, meanC: null });
    samples += counts.get(date) ?? 0;
  }

  return {
    cell: { latE1, lonE1 },
    days,
    window: { from: utcDay(from), to: utcDay(new Date(today.getTime() - 86400000)) },
    daily,
    sampleCount: samples,
  };
}
