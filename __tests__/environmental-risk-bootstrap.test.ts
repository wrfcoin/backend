const mockAppLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../server/utils/logger.js', () => ({
  appLogger: mockAppLogger,
}));

describe('environmental risk bootstrap', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('seeds all baseline datasets when environmental tables are empty', async () => {
    const tableState = {
      carbon_credits: false,
      carbon_footprints: false,
      weather_data_quality: false,
    };
    const statements: string[] = [];

    const executeQuery = jest.fn(async (sql: string) => {
      statements.push(normalizeSql(sql));

      if (sql.includes('SELECT EXISTS') && sql.includes('"carbon_credits"')) {
        return { rows: [{ has_rows: tableState.carbon_credits }] };
      }
      if (sql.includes('SELECT EXISTS') && sql.includes('"carbon_footprints"')) {
        return { rows: [{ has_rows: tableState.carbon_footprints }] };
      }
      if (
        sql.includes('SELECT EXISTS') &&
        sql.includes('"weather_data_quality"')
      ) {
        return { rows: [{ has_rows: tableState.weather_data_quality }] };
      }
      if (sql.includes('INSERT INTO "carbon_credits"')) {
        tableState.carbon_credits = true;
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO "carbon_footprints"')) {
        tableState.carbon_footprints = true;
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO "weather_data_quality"')) {
        tableState.weather_data_quality = true;
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const {
      ensureEnvironmentalRiskBaseline,
      resetEnvironmentalRiskBootstrapStateForTests,
    } = await import('../database/environmental-risk-bootstrap.js');

    resetEnvironmentalRiskBootstrapStateForTests();

    await expect(
      ensureEnvironmentalRiskBaseline({ executeQuery, logger: mockAppLogger })
    ).resolves.toEqual({
      carbonCreditsSeeded: true,
      carbonFootprintsSeeded: true,
      weatherDataQualitySeeded: true,
      seededAny: true,
      status: 'seeded',
    });

    expect(statements).toContain(
      'INSERT INTO "carbon_credits" ( "token_id", "owner", "carbon_offset", "project_type", "verification_standard", "issuance_date", "issuer", "certification_hash", "for_sale", "metadata" ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9::jsonb) ON CONFLICT ("token_id") DO NOTHING'
    );
    expect(statements).toContain(
      'INSERT INTO "carbon_footprints" ( "user_id", "total_emissions", "total_offsets", "net_emissions", "calculation_date", "methodology", "confidence", "metadata" ) SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb WHERE NOT EXISTS ( SELECT 1 FROM "carbon_footprints" )'
    );
    expect(statements).toContain(
      'INSERT INTO "weather_data_quality" ( "station_id", "submission_id", "quality_score", "confidence", "anomaly_detected", "validation_status", "validated_by", "metadata" ) SELECT $1, $2, $3, $4, false, $5, $6, $7::jsonb WHERE NOT EXISTS ( SELECT 1 FROM "weather_data_quality" )'
    );
    expect(mockAppLogger.info).toHaveBeenCalledWith(
      'Environmental risk bootstrap completed',
      expect.objectContaining({ status: 'seeded' })
    );
  });

  it('seeds only the missing datasets on a partially populated database', async () => {
    const tableState = {
      carbon_credits: true,
      carbon_footprints: false,
      weather_data_quality: true,
    };

    const executeQuery = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT EXISTS') && sql.includes('"carbon_credits"')) {
        return { rows: [{ has_rows: tableState.carbon_credits }] };
      }
      if (sql.includes('SELECT EXISTS') && sql.includes('"carbon_footprints"')) {
        return { rows: [{ has_rows: tableState.carbon_footprints }] };
      }
      if (
        sql.includes('SELECT EXISTS') &&
        sql.includes('"weather_data_quality"')
      ) {
        return { rows: [{ has_rows: tableState.weather_data_quality }] };
      }
      if (sql.includes('INSERT INTO "carbon_footprints"')) {
        tableState.carbon_footprints = true;
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const {
      ensureEnvironmentalRiskBaseline,
      resetEnvironmentalRiskBootstrapStateForTests,
    } = await import('../database/environmental-risk-bootstrap.js');

    resetEnvironmentalRiskBootstrapStateForTests();

    await expect(
      ensureEnvironmentalRiskBaseline({ executeQuery, logger: mockAppLogger })
    ).resolves.toEqual({
      carbonCreditsSeeded: false,
      carbonFootprintsSeeded: true,
      weatherDataQualitySeeded: false,
      seededAny: true,
      status: 'seeded',
    });

    expect(executeQuery).toHaveBeenCalledTimes(4);
  });

  it('does not duplicate baseline inserts when run repeatedly', async () => {
    const tableState = {
      carbon_credits: false,
      carbon_footprints: false,
      weather_data_quality: false,
    };
    let insertCount = 0;

    const executeQuery = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT EXISTS') && sql.includes('"carbon_credits"')) {
        return { rows: [{ has_rows: tableState.carbon_credits }] };
      }
      if (sql.includes('SELECT EXISTS') && sql.includes('"carbon_footprints"')) {
        return { rows: [{ has_rows: tableState.carbon_footprints }] };
      }
      if (
        sql.includes('SELECT EXISTS') &&
        sql.includes('"weather_data_quality"')
      ) {
        return { rows: [{ has_rows: tableState.weather_data_quality }] };
      }
      if (sql.includes('INSERT INTO "carbon_credits"')) {
        insertCount += 1;
        tableState.carbon_credits = true;
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO "carbon_footprints"')) {
        insertCount += 1;
        tableState.carbon_footprints = true;
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO "weather_data_quality"')) {
        insertCount += 1;
        tableState.weather_data_quality = true;
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const {
      ensureEnvironmentalRiskBaseline,
      resetEnvironmentalRiskBootstrapStateForTests,
    } = await import('../database/environmental-risk-bootstrap.js');

    resetEnvironmentalRiskBootstrapStateForTests();

    await ensureEnvironmentalRiskBaseline({ executeQuery, logger: mockAppLogger });
    await ensureEnvironmentalRiskBaseline({ executeQuery, logger: mockAppLogger });

    expect(insertCount).toBe(3);
    expect(mockAppLogger.info).toHaveBeenLastCalledWith(
      'Environmental risk bootstrap completed',
      expect.objectContaining({ status: 'already-populated' })
    );
  });

  it('logs a failure without throwing when bootstrap queries fail', async () => {
    const executeQuery = jest
      .fn()
      .mockRejectedValue(new Error('database offline'));

    const {
      ensureEnvironmentalRiskBaseline,
      resetEnvironmentalRiskBootstrapStateForTests,
    } = await import('../database/environmental-risk-bootstrap.js');

    resetEnvironmentalRiskBootstrapStateForTests();

    await expect(
      ensureEnvironmentalRiskBaseline({ executeQuery, logger: mockAppLogger })
    ).resolves.toEqual({
      carbonCreditsSeeded: false,
      carbonFootprintsSeeded: false,
      weatherDataQualitySeeded: false,
      seededAny: false,
      status: 'failed',
    });

    expect(mockAppLogger.error).toHaveBeenCalledWith(
      'Environmental risk bootstrap failed',
      expect.objectContaining({ error: 'database offline' })
    );
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
