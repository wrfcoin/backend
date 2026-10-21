/**
 * Operator-facing data quality feedback API.
 *
 * Surfaces quality scores, rejection reasons, and improvement suggestions
 * for weather observations submitted by a specific station operator.
 *
 * Closes backend#287.
 */

import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { walletMayOnlyQueryOwnAddress } from '../middleware/wallet-ownership.js';

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/** Maximum number of recent rejection events to return. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function defaultDb(): DbExecutor {
  let cachedExecuteQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null =
    null;
  return {
    execute: async (sql: string, params?: unknown[]) => {
      if (!cachedExecuteQuery) {
        const mod = await import('../../database/index.js');
        cachedExecuteQuery = mod.executeQuery;
      }
      return cachedExecuteQuery!(sql, params);
    },
  };
}

/**
 * Translate a raw `physics_violations` JSON array (as persisted by sensor-ingest-routes)
 * into a human-readable rejection reason string.
 */
function formatRejectionReason(violation: Record<string, unknown>): string {
  const type = violation.type as string | undefined;
  switch (type) {
    case 'TemperatureOutOfRange':
      return `Temperature ${violation.valueC}°C is outside valid range [${violation.min}°C, ${violation.max}°C]`;
    case 'PressureOutOfRange':
      return `Pressure ${violation.valueHpa} hPa is outside valid range [${violation.min}, ${violation.max}] hPa`;
    case 'HumidityOutOfRange':
      return `Humidity ${violation.valuePct}% is outside valid range [${violation.min}%, ${violation.max}%]`;
    case 'WindSpeedExceedsMaximum':
      return `Wind speed ${violation.valueMs} m/s exceeds maximum ${violation.max} m/s`;
    case 'TemperatureRateExceeded':
      return `Temperature changed ${String(violation.deltaC)}°C between readings, exceeding the ${String(violation.limit)}°C/interval limit`;
    case 'CrossParameterInconsistency':
      return String(violation.detail ?? 'Cross-parameter inconsistency detected');
    default:
      return `Physics validation failure: ${JSON.stringify(violation)}`;
  }
}

/**
 * Derive an actionable improvement suggestion from a violation type.
 */
function improvementSuggestion(violation: Record<string, unknown>): string {
  const type = violation.type as string | undefined;
  switch (type) {
    case 'TemperatureOutOfRange':
      return 'Check sensor placement (avoid direct sunlight / heat sources). Verify calibration date.';
    case 'PressureOutOfRange':
      return 'Confirm your sensor altitude setting. Barometer sensors require altitude compensation.';
    case 'HumidityOutOfRange':
      return 'Clean or replace the humidity sensor element — humidity sensors degrade over time.';
    case 'WindSpeedExceedsMaximum':
      return 'Inspect anemometer for mechanical damage or debris obstruction.';
    case 'TemperatureRateExceeded':
      return 'Large temperature jumps indicate sensor reset or connectivity issue. Check power supply stability.';
    case 'CrossParameterInconsistency':
      return 'Multiple sensor readings are mutually inconsistent. Run a full calibration check on all sensors.';
    default:
      return 'Review your station setup guide or contact support for assistance.';
  }
}

/**
 * Map a numeric quality_score (0–100 integer, as stored in weather_submissions) to a band string.
 * Bands mirror the meteo-types DataQualityBand thresholds scaled to 0–100.
 */
function scoreToBand(score: number): string {
  if (score >= 85) return 'high';
  if (score >= 70) return 'borderline';
  if (score >= 50) return 'warning';
  return 'low';
}

export function createOperatorQualityRouter(db?: DbExecutor): express.Router {
  const router = express.Router();

  // All operator quality endpoints require authentication.
  router.use(authenticateJWT);

  /**
   * GET /my-events
   *
   * Returns recent quality events (rejections) for a specific wallet address,
   * plus a 24-hour quality summary.
   *
   * Query params:
   *   address  — wallet address (required)
   *   limit    — max rejection events to return (default 50, max 200)
   *   hours    — look-back window in hours for summary (default 24, max 168)
   */
  router.get('/my-events', walletMayOnlyQueryOwnAddress('address'), async (req, res) => {
    const executor = db ?? defaultDb();
    const { address, limit: limitStr, hours: hoursStr } = req.query as Record<string, string | undefined>;

    if (!address || !WALLET_RE.test(address)) {
      return res.status(400).json({ error: 'address must be a valid 0x wallet address' });
    }

    const limit = Math.min(Number(limitStr ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
    const hours = Math.min(Number(hoursStr ?? 24) || 24, 168);

    try {
      // Recent submissions with physics violations (rejections have violations JSON).
      const rejectionsRes = await executor.execute(
        `SELECT
           submitted_at,
           device_id,
           temperature,
           humidity,
           pressure,
           wind_speed,
           quality_score,
           physics_violations
         FROM weather_submissions
         WHERE wallet_address = $1
           AND physics_violations IS NOT NULL
           AND physics_violations != '[]'::jsonb
         ORDER BY submitted_at DESC
         LIMIT $2`,
        [address, limit],
      );

      const recent_rejections = rejectionsRes.rows.flatMap((row) => {
        let violations: Record<string, unknown>[] = [];
        try {
          const raw = row.physics_violations;
          violations = Array.isArray(raw) ? raw : JSON.parse(String(raw));
        } catch {
          return [];
        }

        return violations.map((v) => ({
          timestamp: row.submitted_at,
          station: row.device_id ?? 'unknown',
          reason: formatRejectionReason(v),
          suggestion: improvementSuggestion(v),
          violation_type: v.type ?? 'unknown',
          quality_score: row.quality_score,
        }));
      });

      // 24-hour (or custom window) summary.
      const summaryRes = await executor.execute(
        `SELECT
           COUNT(*) FILTER (WHERE physics_violations IS NULL OR physics_violations = '[]'::jsonb) AS accepted,
           COUNT(*) FILTER (WHERE physics_violations IS NOT NULL AND physics_violations != '[]'::jsonb) AS rejected,
           AVG(quality_score) AS avg_score
         FROM weather_submissions
         WHERE wallet_address = $1
           AND submitted_at >= NOW() - ($2 || ' hours')::interval`,
        [address, hours],
      );

      const summaryRow = summaryRes.rows[0] ?? {};
      const accepted = Number(summaryRow.accepted ?? 0);
      const rejected = Number(summaryRow.rejected ?? 0);
      const avgScore = summaryRow.avg_score != null ? Number(summaryRow.avg_score) : null;
      const qualityRatio = accepted + rejected > 0 ? accepted / (accepted + rejected) : null;

      return res.status(200).json({
        recent_rejections,
        quality_summary: {
          [`last_${hours}h_accepted`]: accepted,
          [`last_${hours}h_rejected`]: rejected,
          quality_score: qualityRatio !== null ? Math.round(qualityRatio * 1000) / 1000 : null,
          quality_band: avgScore !== null ? scoreToBand(avgScore) : null,
          avg_physics_score: avgScore !== null ? Math.round(avgScore * 10) / 10 : null,
        },
      });
    } catch (_err) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /station-summary/:deviceId
   *
   * Returns a quality summary for a specific station device within a look-back window.
   *
   * Query params:
   *   address — wallet address (required, must own the device)
   *   hours   — look-back window in hours (default 24, max 168)
   */
  router.get('/station-summary/:deviceId', walletMayOnlyQueryOwnAddress('address'), async (req, res) => {
    const executor = db ?? defaultDb();
    const { deviceId } = req.params;
    const { address, hours: hoursStr } = req.query as Record<string, string | undefined>;

    if (!address || !WALLET_RE.test(address)) {
      return res.status(400).json({ error: 'address must be a valid 0x wallet address' });
    }
    if (!deviceId || deviceId.length > 128) {
      return res.status(400).json({ error: 'deviceId is required (max 128 chars)' });
    }

    const hours = Math.min(Number(hoursStr ?? 24) || 24, 168);

    try {
      const res2 = await executor.execute(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE physics_violations IS NULL OR physics_violations = '[]'::jsonb) AS accepted,
           COUNT(*) FILTER (WHERE physics_violations IS NOT NULL AND physics_violations != '[]'::jsonb) AS rejected,
           AVG(quality_score) AS avg_score,
           MIN(submitted_at) AS first_submission,
           MAX(submitted_at) AS last_submission
         FROM weather_submissions
         WHERE wallet_address = $1
           AND device_id = $2
           AND submitted_at >= NOW() - ($3 || ' hours')::interval`,
        [address, deviceId, hours],
      );

      const row = res2.rows[0] ?? {};
      const total = Number(row.total ?? 0);
      const accepted = Number(row.accepted ?? 0);
      const rejected = Number(row.rejected ?? 0);
      const avgScore = row.avg_score != null ? Number(row.avg_score) : null;

      return res.status(200).json({
        station: deviceId,
        window_hours: hours,
        total_submissions: total,
        accepted,
        rejected,
        acceptance_rate: total > 0 ? Math.round((accepted / total) * 1000) / 1000 : null,
        quality_band: avgScore !== null ? scoreToBand(avgScore) : null,
        avg_physics_score: avgScore !== null ? Math.round(avgScore * 10) / 10 : null,
        first_submission: row.first_submission ?? null,
        last_submission: row.last_submission ?? null,
      });
    } catch (_err) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default createOperatorQualityRouter();
