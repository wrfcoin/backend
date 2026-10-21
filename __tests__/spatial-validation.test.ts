const mockAppLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../server/utils/logger.js', () => ({
  appLogger: mockAppLogger,
}));

function createSpatialSchema() {
  return {
    weatherData: {
      __tableName: 'weatherData',
      latitude: 'weatherData.latitude',
      longitude: 'weatherData.longitude',
      elevation: 'weatherData.elevation',
      stationId: 'weatherData.stationId',
    },
  };
}

function createMockDb(dataByTable: Record<string, unknown[]>) {
  const resolveRows = (table: { __tableName?: string }) => dataByTable[table?.__tableName || ''] || [];

  return {
    select() {
      const state: { table?: { __tableName?: string } } = {};

      const builder = {
        from(table: { __tableName?: string }) {
          state.table = table;
          return builder;
        },
        limit() {
          return Promise.resolve(resolveRows(state.table || {}));
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(resolveRows(state.table || {})).then(resolve, reject);
        },
      };

      return builder;
    },
  };
}

describe('spatial validation live-data calculations', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('estimates elevation from nearby persisted spatial observations', async () => {
    const schema = createSpatialSchema();
    jest.doMock('../database/connection', () => ({
      db: createMockDb({
        weatherData: [
          {
            latitude: '40.0000',
            longitude: '-75.0000',
            elevation: 100,
            stationId: 'A',
          },
          {
            latitude: '40.0007',
            longitude: '-75.0002',
            elevation: 110,
            stationId: 'B',
          },
          {
            latitude: '39.9998',
            longitude: '-75.0004',
            elevation: 90,
            stationId: 'C',
          },
        ],
      }),
    }));
    jest.doMock('../shared/schema', () => schema);

    const { SpatialValidationSystem } = require('../middleware/spatial-validation.js');
    const validator = new SpatialValidationSystem();

    const result = await validator.validateElevation({
      latitude: 40.0005,
      longitude: -75.0003,
      elevation: 104,
    });

    expect(result.valid).toBe(true);
    expect(result.estimated).toBeGreaterThanOrEqual(95);
    expect(result.estimated).toBeLessThanOrEqual(105);
    expect(result.warnings).toEqual([]);
  });

  it('flags true spatial outliers from persisted coordinate clusters', async () => {
    const schema = createSpatialSchema();
    jest.doMock('../database/connection', () => ({
      db: createMockDb({
        weatherData: [
          { latitude: '40.0000', longitude: '-75.0000', elevation: 100, stationId: 'A' },
          { latitude: '40.0004', longitude: '-75.0002', elevation: 102, stationId: 'B' },
          { latitude: '39.9999', longitude: '-75.0003', elevation: 98, stationId: 'C' },
          { latitude: '40.0002', longitude: '-75.0001', elevation: 101, stationId: 'D' },
          { latitude: '40.0003', longitude: '-75.0004', elevation: 99, stationId: 'E' },
          { latitude: '40.0001', longitude: '-75.0005', elevation: 97, stationId: 'F' },
        ],
      }),
    }));
    jest.doMock('../shared/schema', () => schema);

    const { SpatialValidationSystem } = require('../middleware/spatial-validation.js');
    const validator = new SpatialValidationSystem();

    await expect(
      validator.detectSpatialOutlier({ latitude: 40.0002, longitude: -75.0002 })
    ).resolves.toBe(false);
    await expect(
      validator.detectSpatialOutlier({ latitude: 41.5, longitude: -79.5 })
    ).resolves.toBe(true);
  });

  it('falls back to a deterministic terrain baseline when no spatial dataset is available', async () => {
    const schema = createSpatialSchema();
    jest.doMock('../database/connection', () => ({
      db: createMockDb({ weatherData: [] }),
    }));
    jest.doMock('../shared/schema', () => schema);

    const { SpatialValidationSystem } = require('../middleware/spatial-validation.js');
    const validator = new SpatialValidationSystem();
    const coordinates = { latitude: 12.3456, longitude: 78.9 };

    const first = await validator.estimateElevationFromDEM(coordinates);
    const second = await validator.estimateElevationFromDEM(coordinates);

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
  });
});
