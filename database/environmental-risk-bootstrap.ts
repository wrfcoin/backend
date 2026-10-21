import { appLogger } from '../server/utils/logger.js';

// Custom error class for graceful bootstrap skipping
class BootstrapSkippedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapSkippedError';
  }
}

// Check if error is PG 42P01 (undefined table)
function isUndefinedTableError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const pgError = error as Record<string, unknown>;
    // Drizzle/pg library typically exposes code property for PostgreSQL errors
    return pgError.code === '42P01' ||
           pgError.sqlState === '42P01' ||
           (typeof pgError.message === 'string' && pgError.message.includes('does not exist'));
  }
  return false;
}

type QueryExecutor = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: Record<string, unknown>[] }>;

type BootstrapLogger = Pick<typeof appLogger, 'info' | 'warn' | 'error'>;

export interface EnvironmentalRiskBootstrapResult {
  carbonCreditsSeeded: boolean;
  carbonFootprintsSeeded: boolean;
  weatherDataQualitySeeded: boolean;
  seededAny: boolean;
  status: 'seeded' | 'already-populated' | 'failed';
}

interface EnsureEnvironmentalRiskBaselineOptions {
  executeQuery?: QueryExecutor;
  logger?: BootstrapLogger;
}

const BASELINE_ISSUED_AT = '2026-03-11T00:00:00.000Z';
const BASELINE_METADATA = JSON.stringify({
  seededBy: 'environmental-risk-bootstrap',
  issue: 178,
  purpose: 'fresh-launch-risk-baseline',
});

let inFlightBootstrap: Promise<EnvironmentalRiskBootstrapResult> | null = null;

export async function ensureEnvironmentalRiskBaseline(
  options: EnsureEnvironmentalRiskBaselineOptions = {}
): Promise<EnvironmentalRiskBootstrapResult> {
  const resolvedExecuteQuery = options.executeQuery || await resolveExecuteQuery();
  const resolvedLogger = options.logger || appLogger;

  if (!resolvedExecuteQuery) {
    resolvedLogger.warn('Environmental risk bootstrap unavailable', {
      reason: 'database executeQuery unavailable',
    });
    return {
      carbonCreditsSeeded: false,
      carbonFootprintsSeeded: false,
      weatherDataQualitySeeded: false,
      seededAny: false,
      status: 'failed',
    };
  }

  if (inFlightBootstrap) {
    return inFlightBootstrap;
  }

  inFlightBootstrap = runEnvironmentalRiskBootstrap(
    resolvedExecuteQuery,
    resolvedLogger
  ).finally(() => {
    inFlightBootstrap = null;
  });

  return inFlightBootstrap;
}

export function resetEnvironmentalRiskBootstrapStateForTests(): void {
  inFlightBootstrap = null;
}

async function runEnvironmentalRiskBootstrap(
  executeQuery: QueryExecutor,
  logger: BootstrapLogger
): Promise<EnvironmentalRiskBootstrapResult> {
  const result: EnvironmentalRiskBootstrapResult = {
    carbonCreditsSeeded: false,
    carbonFootprintsSeeded: false,
    weatherDataQualitySeeded: false,
    seededAny: false,
    status: 'already-populated',
  };

  try {
    const [hasCarbonCredits, hasCarbonFootprints, hasWeatherDataQuality] =
      await Promise.all([
        tableHasRows(executeQuery, 'carbon_credits'),
        tableHasRows(executeQuery, 'carbon_footprints'),
        tableHasRows(executeQuery, 'weather_data_quality'),
      ]).catch((error) => {
        // Check if tables don't exist (PG error 42P01)
        if (isUndefinedTableError(error)) {
          logger.info('Environmental risk baseline skipped — tables missing, run db:bootstrap', {
            reason: 'environmental_risk_baseline tables not yet created by migrations',
          });
          // Return empty status without blocking startup
          throw new BootstrapSkippedError('Tables not yet created');
        }
        // Re-throw real errors
        throw error;
      });

    if (!hasCarbonCredits) {
      await executeQuery(
        `
          INSERT INTO "carbon_credits" (
            "token_id",
            "owner",
            "carbon_offset",
            "project_type",
            "verification_standard",
            "issuance_date",
            "issuer",
            "certification_hash",
            "for_sale",
            "metadata"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9::jsonb)
          ON CONFLICT ("token_id") DO NOTHING
        `,
        [
          'bootstrap-credit-001',
          'bootstrap-risk-wallet',
          '12.00000000',
          'weather_monitoring',
          'Gold Standard',
          BASELINE_ISSUED_AT,
          'WRF bootstrap issuer',
          'ipfs://wrf/bootstrap-credit-001',
          BASELINE_METADATA,
        ]
      );
      result.carbonCreditsSeeded = true;
    }

    if (!hasCarbonFootprints) {
      await executeQuery(
        `
          INSERT INTO "carbon_footprints" (
            "user_id",
            "total_emissions",
            "total_offsets",
            "net_emissions",
            "calculation_date",
            "methodology",
            "confidence",
            "metadata"
          )
          SELECT
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM "carbon_footprints"
          )
        `,
        [
          'bootstrap-risk-profile',
          '10.00000000',
          '12.00000000',
          '-2.00000000',
          BASELINE_ISSUED_AT,
          'bootstrap_v1',
          0.95,
          BASELINE_METADATA,
        ]
      );
      result.carbonFootprintsSeeded = true;
    }

    if (!hasWeatherDataQuality) {
      await executeQuery(
        `
          INSERT INTO "weather_data_quality" (
            "station_id",
            "submission_id",
            "quality_score",
            "confidence",
            "anomaly_detected",
            "validation_status",
            "validated_by",
            "metadata"
          )
          SELECT
            $1,
            $2,
            $3,
            $4,
            false,
            $5,
            $6,
            $7::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM "weather_data_quality"
          )
        `,
        [
          'bootstrap-station-001',
          'bootstrap-quality-001',
          96,
          0.95,
          'validated',
          'system-bootstrap',
          BASELINE_METADATA,
        ]
      );
      result.weatherDataQualitySeeded = true;
    }

    result.seededAny =
      result.carbonCreditsSeeded ||
      result.carbonFootprintsSeeded ||
      result.weatherDataQualitySeeded;
    result.status = result.seededAny ? 'seeded' : 'already-populated';

    logger.info('Environmental risk bootstrap completed', {
      status: result.status,
      carbonCreditsSeeded: result.carbonCreditsSeeded,
      carbonFootprintsSeeded: result.carbonFootprintsSeeded,
      weatherDataQualitySeeded: result.weatherDataQualitySeeded,
    });
  } catch (error) {
    // If bootstrap was skipped due to missing tables, that's OK (not a failure)
    if (error instanceof BootstrapSkippedError) {
      result.status = 'already-populated'; // Treat as no-op, not failure
      return result;
    }

    result.status = 'failed';
    logger.error('Environmental risk bootstrap failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

async function tableHasRows(
  executeQuery: QueryExecutor,
  tableName: 'carbon_credits' | 'carbon_footprints' | 'weather_data_quality'
): Promise<boolean> {
  const query = `SELECT EXISTS (SELECT 1 FROM "${tableName}") AS has_rows`;
  const response = await executeQuery(query);
  return coerceBoolean(response.rows[0]?.has_rows);
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return false;
}

async function resolveExecuteQuery(): Promise<QueryExecutor | null> {
  try {
    const { executeQuery } = await import('./connection.js');
    return executeQuery as QueryExecutor;
  } catch {
    return null;
  }
}
