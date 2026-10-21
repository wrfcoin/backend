/**
 * Climate Data Transformer Tests
 *
 * Comprehensive test suite for the Climate Data Transformation service.
 * Tests coordinate transformations, unit conversions, temporal alignment,
 * spatial regridding, and WRFCoin format standardization.
 *
 * Test Categories:
 * - Unit conversions (temperature, pressure, wind, etc.)
 * - Coordinate system transformations
 * - Temporal data processing and alignment
 * - Spatial interpolation and regridding
 * - WRFCoin schema application and validation
 * - Data quality assessment and metrics
 */

const {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} = require('@jest/globals');
const fs = require('fs').promises;
const path = require('path');

// Import transformer components
const {
  ClimateDataTransformer,
  CoordinateTransformer,
  UnitConverter,
  TemporalProcessor,
  SpatialProcessor,
} = require('../services/climate-data-transformer');

// Mock data generators
const createMockClimateData = () => ({
  metadata: {
    source: 'test-model',
    created: new Date().toISOString(),
    format: 'raw',
  },
  coordinates: {
    longitude: [-120.0, -119.5, -119.0, -118.5, -118.0],
    latitude: [30.0, 30.5, 31.0, 31.5, 32.0],
    crs: 'WGS84',
  },
  time: [
    '2023-10-27T00:00:00Z',
    '2023-10-27T06:00:00Z',
    '2023-10-27T12:00:00Z',
    '2023-10-27T18:00:00Z',
  ],
  variables: {
    temperature: {
      data: [
        [15.0, 16.0, 17.0, 18.0, 19.0],
        [20.0, 21.0, 22.0, 23.0, 24.0],
        [25.0, 26.0, 27.0, 28.0, 29.0],
        [22.0, 23.0, 24.0, 25.0, 26.0],
      ],
      units: 'kelvin',
      dimensions: ['time', 'lat', 'lon'],
    },
    pressure: {
      data: [
        [101325, 101320, 101315, 101310, 101305],
        [101330, 101325, 101320, 101315, 101310],
        [101335, 101330, 101325, 101320, 101315],
        [101328, 101323, 101318, 101313, 101308],
      ],
      units: 'Pa',
      dimensions: ['time', 'lat', 'lon'],
    },
  },
});

const createMockTransformationSpec = () => ({
  coordinateTransformation: {
    fromCRS: 'WGS84',
    toCRS: 'WGS84',
    options: {},
  },
  unitNormalization: true,
  temporalAlignment: {
    targetGrid: {
      start: '2023-10-27T00:00:00Z',
      end: '2023-10-27T18:00:00Z',
      interval: 6,
    },
  },
  spatialRegridding: null,
});

// ============================================================================
// UNIT CONVERTER TESTS
// ============================================================================

describe('UnitConverter', () => {
  let unitConverter;

  beforeEach(() => {
    unitConverter = new UnitConverter();
  });

  describe('Temperature Conversions', () => {
    test('should convert Celsius to Kelvin correctly', () => {
      const celsius = 25.0;
      const kelvin = unitConverter.convert(
        celsius,
        'celsius',
        'kelvin',
        'temperature'
      );
      expect(kelvin).toBeCloseTo(298.15, 2);
    });

    test('should convert Kelvin to Celsius correctly', () => {
      const kelvin = 298.15;
      const celsius = unitConverter.convert(
        kelvin,
        'kelvin',
        'celsius',
        'temperature'
      );
      expect(celsius).toBeCloseTo(25.0, 2);
    });

    test('should convert Fahrenheit to Celsius correctly', () => {
      const fahrenheit = 77.0;
      const celsius = unitConverter.convert(
        fahrenheit,
        'fahrenheit',
        'celsius',
        'temperature'
      );
      expect(celsius).toBeCloseTo(25.0, 2);
    });

    test('should handle array of temperature values', () => {
      const fahrenheitArray = [32, 68, 86, 104];
      const celsiusArray = unitConverter.convert(
        fahrenheitArray,
        'fahrenheit',
        'celsius',
        'temperature'
      );
      expect(celsiusArray).toEqual(
        expect.arrayContaining([
          expect.closeTo(0, 1),
          expect.closeTo(20, 1),
          expect.closeTo(30, 1),
          expect.closeTo(40, 1),
        ])
      );
    });
  });

  describe('Pressure Conversions', () => {
    test('should convert Pascal to hectoPascal correctly', () => {
      const pascal = 101325;
      const hpa = unitConverter.convert(pascal, 'pa', 'hpa', 'pressure');
      expect(hpa).toBeCloseTo(1013.25, 2);
    });

    test('should convert atmospheric pressure correctly', () => {
      const atm = 1.0;
      const pascal = unitConverter.convert(atm, 'atm', 'pa', 'pressure');
      expect(pascal).toBeCloseTo(101325, 0);
    });

    test('should convert millimeters of mercury to Pascal', () => {
      const mmhg = 760;
      const pascal = unitConverter.convert(mmhg, 'mmhg', 'pa', 'pressure');
      expect(pascal).toBeCloseTo(101325, 100);
    });
  });

  describe('Wind Speed Conversions', () => {
    test('should convert meters per second to kilometers per hour', () => {
      const ms = 10.0;
      const kmh = unitConverter.convert(ms, 'ms', 'kmh', 'wind');
      expect(kmh).toBeCloseTo(36.0, 1);
    });

    test('should convert meters per second to miles per hour', () => {
      const ms = 10.0;
      const mph = unitConverter.convert(ms, 'ms', 'mph', 'wind');
      expect(mph).toBeCloseTo(22.37, 1);
    });

    test('should convert knots to meters per second', () => {
      const knots = 10.0;
      const ms = unitConverter.convert(knots, 'kt', 'ms', 'wind');
      expect(ms).toBeCloseTo(5.144, 2);
    });
  });

  describe('Standard Unit Detection', () => {
    test('should detect standard units for common variables', () => {
      expect(unitConverter.getStandardUnit('temperature')).toBe('celsius');
      expect(unitConverter.getStandardUnit('pressure')).toBe('hpa');
      expect(unitConverter.getStandardUnit('wind_speed')).toBe('ms');
      expect(unitConverter.getStandardUnit('precipitation')).toBe('mm');
    });

    test('should handle partial variable name matches', () => {
      expect(unitConverter.getStandardUnit('air_temperature')).toBe('celsius');
      expect(unitConverter.getStandardUnit('sea_level_pressure')).toBe('hpa');
      expect(unitConverter.getStandardUnit('wind_u_component')).toBe('ms');
    });
  });

  describe('Data Normalization', () => {
    test('should normalize temperature data to standard units', () => {
      const data = {
        variables: {
          temperature: {
            data: [298.15, 299.15, 300.15],
            units: 'kelvin',
          },
        },
      };

      const normalized = unitConverter.normalizeToStandard(data);

      expect(normalized.variables.temperature.units).toBe('celsius');
      expect(normalized.variables.temperature.data[0]).toBeCloseTo(25.0, 1);
      expect(normalized.variables.temperature.originalUnit).toBe('kelvin');
    });

    test('should normalize pressure data to standard units', () => {
      const data = {
        variables: {
          pressure: {
            data: [101325, 101300, 101350],
            units: 'Pa',
          },
        },
      };

      const normalized = unitConverter.normalizeToStandard(data);

      expect(normalized.variables.pressure.units).toBe('hpa');
      expect(normalized.variables.pressure.data[0]).toBeCloseTo(1013.25, 2);
    });

    test('should preserve data when already in standard units', () => {
      const data = {
        variables: {
          temperature: {
            data: [25.0, 26.0, 27.0],
            units: 'celsius',
          },
        },
      };

      const normalized = unitConverter.normalizeToStandard(data);

      expect(normalized.variables.temperature.data).toEqual([25.0, 26.0, 27.0]);
      expect(normalized.variables.temperature.units).toBe('celsius');
    });
  });

  describe('Error Handling', () => {
    test('should throw error for unsupported unit category', () => {
      expect(() => {
        unitConverter.convert(100, 'unknown1', 'unknown2', 'invalid_category');
      }).toThrow('Unsupported unit category: invalid_category');
    });

    test('should throw error for unsupported conversion', () => {
      expect(() => {
        unitConverter.convert(100, 'celsius', 'invalid_unit', 'temperature');
      }).toThrow(
        'Conversion celsius -> invalid_unit not supported for category temperature'
      );
    });

    test('should return same value for identical units', () => {
      const value = 25.0;
      const result = unitConverter.convert(
        value,
        'celsius',
        'celsius',
        'temperature'
      );
      expect(result).toBe(value);
    });
  });
});

// ============================================================================
// COORDINATE TRANSFORMER TESTS
// ============================================================================

describe('CoordinateTransformer', () => {
  let coordinateTransformer;

  beforeEach(() => {
    coordinateTransformer = new CoordinateTransformer();
  });

  describe('WGS84 to Web Mercator', () => {
    test('should transform WGS84 coordinates to Web Mercator', () => {
      const wgs84Coords = [[-74.006, 40.7128]]; // New York City
      const webMercatorCoords = coordinateTransformer.transformCoordinates(
        wgs84Coords,
        'WGS84',
        'WebMercator'
      );

      expect(webMercatorCoords[0][0]).toBeCloseTo(-8238310.24, 0);
      expect(webMercatorCoords[0][1]).toBeCloseTo(4969803.37, 0);
    });

    test('should handle multiple coordinate pairs', () => {
      const wgs84Coords = [
        [-74.006, 40.7128], // NYC
        [-118.2437, 34.0522], // LA
        [-87.6298, 41.8781], // Chicago
      ];

      const webMercatorCoords = coordinateTransformer.transformCoordinates(
        wgs84Coords,
        'WGS84',
        'WebMercator'
      );

      expect(webMercatorCoords).toHaveLength(3);
      expect(webMercatorCoords[0]).toHaveLength(2);
      expect(webMercatorCoords[1]).toHaveLength(2);
      expect(webMercatorCoords[2]).toHaveLength(2);
    });
  });

  describe('Web Mercator to WGS84', () => {
    test('should transform Web Mercator coordinates back to WGS84', () => {
      const webMercatorCoords = [[-8238310.24, 4969803.37]]; // NYC in Web Mercator
      const wgs84Coords = coordinateTransformer.transformCoordinates(
        webMercatorCoords,
        'WebMercator',
        'WGS84'
      );

      expect(wgs84Coords[0][0]).toBeCloseTo(-74.006, 3);
      expect(wgs84Coords[0][1]).toBeCloseTo(40.7128, 3);
    });
  });

  describe('Regular Grid Creation', () => {
    test('should create regular grid from coordinate bounds', () => {
      const coordinates = [
        [-120, 30],
        [-119, 30],
        [-118, 30],
        [-120, 31],
        [-119, 31],
        [-118, 31],
      ];

      const gridSpec = {
        resolution: { lon: 0.5, lat: 0.5 },
        bounds: { north: 32, south: 30, east: -117, west: -120 },
      };

      const grid = coordinateTransformer.createRegularGrid(
        coordinates,
        gridSpec
      );

      expect(grid.longitude).toHaveLength(7); // (120-117)/0.5 + 1
      expect(grid.latitude).toHaveLength(5); // (32-30)/0.5 + 1
      expect(grid.longitude[0]).toBe(-120);
      expect(grid.latitude[0]).toBe(30);
      expect(grid.resolution.lon).toBe(0.5);
      expect(grid.resolution.lat).toBe(0.5);
    });

    test('should auto-detect bounds when not provided', () => {
      const coordinates = [
        [-120, 30],
        [-119, 31],
        [-118, 32],
      ];

      const gridSpec = {
        resolution: { lon: 1.0, lat: 1.0 },
      };

      const grid = coordinateTransformer.createRegularGrid(
        coordinates,
        gridSpec
      );

      expect(grid.bounds.west).toBe(-120);
      expect(grid.bounds.east).toBe(-118);
      expect(grid.bounds.south).toBe(30);
      expect(grid.bounds.north).toBe(32);
    });
  });

  describe('Coordinate System Support', () => {
    test('should support known coordinate reference systems', () => {
      expect(coordinateTransformer.supportedCRS).toHaveProperty('WGS84');
      expect(coordinateTransformer.supportedCRS).toHaveProperty('WebMercator');
      expect(coordinateTransformer.supportedCRS).toHaveProperty('UTM');
    });

    test('should return same coordinates for identical CRS', () => {
      const coords = [[-74.006, 40.7128]];
      const result = coordinateTransformer.transformCoordinates(
        coords,
        'WGS84',
        'WGS84'
      );
      expect(result).toEqual(coords);
    });
  });
});

// ============================================================================
// TEMPORAL PROCESSOR TESTS
// ============================================================================

describe('TemporalProcessor', () => {
  let temporalProcessor;

  beforeEach(() => {
    temporalProcessor = new TemporalProcessor();
  });

  describe('Time Sequence Generation', () => {
    test('should generate correct time sequence', () => {
      const start = '2023-10-27T00:00:00Z';
      const end = '2023-10-27T12:00:00Z';
      const intervalHours = 3;

      const sequence = temporalProcessor.generateTimeSequence(
        start,
        end,
        intervalHours
      );

      expect(sequence).toHaveLength(5); // 0, 3, 6, 9, 12 hours
      expect(sequence[0].toISOString()).toBe('2023-10-27T00:00:00.000Z');
      expect(sequence[1].toISOString()).toBe('2023-10-27T03:00:00.000Z');
      expect(sequence[4].toISOString()).toBe('2023-10-27T12:00:00.000Z');
    });

    test('should handle single time point', () => {
      const start = '2023-10-27T12:00:00Z';
      const end = '2023-10-27T12:00:00Z';
      const intervalHours = 1;

      const sequence = temporalProcessor.generateTimeSequence(
        start,
        end,
        intervalHours
      );

      expect(sequence).toHaveLength(1);
      expect(sequence[0].toISOString()).toBe('2023-10-27T12:00:00.000Z');
    });
  });

  describe('Dataset Time Alignment', () => {
    test('should align datasets to common time grid', () => {
      const dataset = {
        time: ['2023-10-27T00:00:00Z', '2023-10-27T12:00:00Z'],
        variables: {
          temperature: {
            data: [20.0, 25.0],
            units: 'celsius',
          },
        },
      };

      const timeGrid = {
        start: '2023-10-27T00:00:00Z',
        end: '2023-10-27T12:00:00Z',
        interval: 6,
      };

      const aligned = temporalProcessor.alignToTimeGrid([dataset], timeGrid);

      expect(aligned).toHaveLength(1);
      expect(aligned[0].time).toHaveLength(3); // 0, 6, 12 hours
      expect(aligned[0].interpolated).toBe(true);
      expect(aligned[0].originalTimeCount).toBe(2);
      expect(aligned[0].interpolatedTimeCount).toBe(3);
    });

    test('should interpolate values correctly', () => {
      const dataset = {
        time: ['2023-10-27T00:00:00Z', '2023-10-27T12:00:00Z'],
        variables: {
          temperature: {
            data: [20.0, 30.0],
            units: 'celsius',
          },
        },
      };

      const timeGrid = {
        start: '2023-10-27T00:00:00Z',
        end: '2023-10-27T12:00:00Z',
        interval: 6,
      };

      const aligned = temporalProcessor.alignToTimeGrid([dataset], timeGrid);
      const tempData = aligned[0].variables.temperature.data;

      expect(tempData[0]).toBeCloseTo(20.0, 1); // t=0
      expect(tempData[1]).toBeCloseTo(25.0, 1); // t=6 (interpolated)
      expect(tempData[2]).toBeCloseTo(30.0, 1); // t=12
    });
  });

  describe('Multi-dimensional Interpolation', () => {
    test('should handle multi-dimensional time series data', () => {
      const originalTimes = ['2023-10-27T00:00:00Z', '2023-10-27T12:00:00Z'];
      const originalData = [
        [
          [20.0, 21.0],
          [22.0, 23.0],
        ], // t=0
        [
          [25.0, 26.0],
          [27.0, 28.0],
        ], // t=12
      ];
      const targetTimes = [
        new Date('2023-10-27T00:00:00Z'),
        new Date('2023-10-27T06:00:00Z'),
        new Date('2023-10-27T12:00:00Z'),
      ];

      const interpolated = temporalProcessor.interpolateMultiD(
        originalTimes,
        originalData,
        targetTimes
      );

      expect(interpolated).toHaveLength(3);
      expect(interpolated[0]).toEqual([
        [20.0, 21.0],
        [22.0, 23.0],
      ]); // t=0 (exact)
      expect(interpolated[2]).toEqual([
        [25.0, 26.0],
        [27.0, 28.0],
      ]); // t=12 (exact)
      // Middle value should be closest match (simplified implementation)
    });
  });

  describe('Error Handling', () => {
    test('should handle empty time arrays', () => {
      const dataset = { time: [], variables: {} };
      const timeGrid = {
        start: '2023-10-27T00:00:00Z',
        end: '2023-10-27T12:00:00Z',
        interval: 6,
      };

      const aligned = temporalProcessor.alignToTimeGrid([dataset], timeGrid);
      expect(aligned[0]).toEqual(dataset); // Should return unchanged
    });

    test('should handle missing time dimension', () => {
      const dataset = { variables: { temp: { data: [20.0] } } };
      const timeGrid = {
        start: '2023-10-27T00:00:00Z',
        end: '2023-10-27T12:00:00Z',
        interval: 6,
      };

      const aligned = temporalProcessor.alignToTimeGrid([dataset], timeGrid);
      expect(aligned[0]).toEqual(dataset); // Should return unchanged
    });
  });
});

// ============================================================================
// SPATIAL PROCESSOR TESTS
// ============================================================================

describe('SpatialProcessor', () => {
  let spatialProcessor;

  beforeEach(() => {
    spatialProcessor = new SpatialProcessor();
  });

  describe('Nearest Neighbor Interpolation', () => {
    test('should perform nearest neighbor interpolation correctly', () => {
      const sourceLon = [-120, -119, -118];
      const sourceLat = [30, 31, 32];
      const sourceData = [
        [10, 11, 12],
        [13, 14, 15],
        [16, 17, 18],
      ];
      const targetLon = [-119.5, -118.5];
      const targetLat = [30.5, 31.5];

      const interpolated = spatialProcessor.nearestNeighborInterpolation(
        sourceLon,
        sourceLat,
        sourceData,
        targetLon,
        targetLat
      );

      expect(interpolated).toHaveLength(2); // 2 target lat points
      expect(interpolated[0]).toHaveLength(2); // 2 target lon points
      // Values should be from nearest source points
      expect(interpolated[0][0]).toBe(11); // Nearest to [-119.5, 30.5]
      expect(interpolated[1][1]).toBe(15); // Nearest to [-118.5, 31.5]
    });

    test('should handle edge cases', () => {
      const sourceLon = [-120];
      const sourceLat = [30];
      const sourceData = [[25]];
      const targetLon = [-119, -121];
      const targetLat = [29, 31];

      const interpolated = spatialProcessor.nearestNeighborInterpolation(
        sourceLon,
        sourceLat,
        sourceData,
        targetLon,
        targetLat
      );

      // All target points should get the single source value
      expect(interpolated[0][0]).toBe(25);
      expect(interpolated[0][1]).toBe(25);
      expect(interpolated[1][0]).toBe(25);
      expect(interpolated[1][1]).toBe(25);
    });
  });

  describe('Data Regridding', () => {
    test('should regrid data to new grid', () => {
      const sourceData = {
        coordinates: {
          longitude: [-120, -119, -118],
          latitude: [30, 31, 32],
        },
        variables: {
          temperature: {
            data: [
              [20, 21, 22],
              [23, 24, 25],
              [26, 27, 28],
            ],
            units: 'celsius',
          },
        },
      };

      const targetGrid = {
        longitude: [-119.5, -118.5],
        latitude: [30.5, 31.5],
      };

      const regridded = spatialProcessor.regridData(
        sourceData,
        targetGrid,
        'nearest'
      );

      expect(regridded.coordinates.longitude).toEqual([-119.5, -118.5]);
      expect(regridded.coordinates.latitude).toEqual([30.5, 31.5]);
      expect(regridded.regridded).toBe(true);
      expect(regridded.interpolationMethod).toBe('nearest');
      expect(regridded.originalGrid.lonCount).toBe(3);
      expect(regridded.targetGrid.lonCount).toBe(2);
    });

    test('should preserve variable metadata during regridding', () => {
      const sourceData = {
        coordinates: {
          longitude: [-120, -119],
          latitude: [30, 31],
        },
        variables: {
          temperature: {
            data: [
              [20, 21],
              [22, 23],
            ],
            units: 'celsius',
            description: 'Air temperature',
          },
        },
      };

      const targetGrid = {
        longitude: [-119.5],
        latitude: [30.5],
      };

      const regridded = spatialProcessor.regridData(sourceData, targetGrid);

      expect(regridded.variables.temperature.units).toBe('celsius');
      expect(regridded.variables.temperature.description).toBe(
        'Air temperature'
      );
    });
  });

  describe('Grid Area Calculations', () => {
    test('should calculate grid cell areas correctly', () => {
      const longitude = [-120, -119, -118];
      const latitude = [30, 31, 32];

      const areas = spatialProcessor.calculateGridAreas(longitude, latitude);

      expect(areas).toHaveLength(2); // n-1 rows
      expect(areas[0]).toHaveLength(2); // n-1 columns

      // Areas should be positive
      expect(areas[0][0]).toBeGreaterThan(0);
      expect(areas[1][1]).toBeGreaterThan(0);

      // Areas should be reasonable for this coordinate range
      expect(areas[0][0]).toBeLessThan(1e12); // Less than 1,000,000 km²
    });

    test('should handle small coordinate ranges', () => {
      const longitude = [-120.0, -119.9];
      const latitude = [30.0, 30.1];

      const areas = spatialProcessor.calculateGridAreas(longitude, latitude);

      expect(areas).toHaveLength(1);
      expect(areas[0]).toHaveLength(1);
      expect(areas[0][0]).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    test('should throw error for missing coordinate information', () => {
      const sourceData = { variables: { temp: { data: [20] } } };
      const targetGrid = { longitude: [-119], latitude: [30] };

      expect(() => {
        spatialProcessor.regridData(sourceData, targetGrid);
      }).toThrow('Source data missing coordinate information');
    });

    test('should throw error for unsupported interpolation method', () => {
      const sourceData = {
        coordinates: { longitude: [-120], latitude: [30] },
        variables: { temp: { data: [[20]] } },
      };
      const targetGrid = { longitude: [-119], latitude: [30] };

      expect(() => {
        spatialProcessor.regridData(
          sourceData,
          targetGrid,
          'unsupported_method'
        );
      }).toThrow('Unsupported interpolation method: unsupported_method');
    });
  });
});

// ============================================================================
// CLIMATE DATA TRANSFORMER INTEGRATION TESTS
// ============================================================================

describe('ClimateDataTransformer Integration', () => {
  let transformer;

  beforeEach(() => {
    transformer = new ClimateDataTransformer();
  });

  describe('WRFCoin Format Transformation', () => {
    test('should transform complete climate data to WRFCoin format', async () => {
      const inputData = createMockClimateData();
      const transformationSpec = createMockTransformationSpec();

      const result = await transformer.transformToWRFCoinFormat(
        inputData,
        transformationSpec
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.validation).toBeDefined();
      expect(result.transformationTime).toBeGreaterThan(0);
    });

    test('should apply WRFCoin schema correctly', () => {
      const inputData = createMockClimateData();
      const transformationSpec = {};

      const wrfcoinData = transformer.applyWRFCoinSchema(
        inputData,
        transformationSpec
      );

      expect(wrfcoinData.metadata.format).toBe('wrfcoin-unified');
      expect(wrfcoinData.metadata.version).toBe('1.0');
      expect(wrfcoinData.coordinates.crs).toBe('WGS84');
      expect(wrfcoinData.time.units).toBe('ISO8601');
      expect(wrfcoinData.quality).toBeDefined();
      expect(wrfcoinData.processing).toBeDefined();
    });

    test('should standardize variable names', () => {
      const variables = {
        TMP: { data: [20], units: 'K' },
        UGRD: { data: [5], units: 'm/s' },
        PRMSL: { data: [1013], units: 'hPa' },
      };

      const standardized = transformer.standardizeVariableNames(variables);

      expect(standardized).toHaveProperty('temperature');
      expect(standardized).toHaveProperty('wind_u');
      expect(standardized).toHaveProperty('sea_level_pressure');

      expect(standardized.temperature.originalName).toBe('TMP');
      expect(standardized.wind_u.originalName).toBe('UGRD');
    });

    test('should calculate data quality metrics', () => {
      const data = {
        variables: {
          temperature: {
            data: [20, 21, null, 23, NaN, 25],
          },
          humidity: {
            data: [60, 65, 70, 75],
          },
        },
      };

      const completeness = transformer.calculateDataCompleteness(data);

      // 4 valid values out of 6 in temp + 4 valid values in humidity = 8/10 = 80%
      expect(completeness).toBeCloseTo(80, 1);
    });

    test('should calculate coordinate bounds', () => {
      const coordinates = {
        longitude: [-120, -119, -118],
        latitude: [30, 31, 32],
      };

      const bounds = transformer.calculateBounds(coordinates);

      expect(bounds).toEqual({
        north: 32,
        south: 30,
        east: -118,
        west: -120,
      });
    });
  });

  describe('Data Validation', () => {
    test('should validate transformed data correctly', async () => {
      const validData = {
        metadata: { format: 'wrfcoin-unified' },
        coordinates: {
          longitude: [-120, -119],
          latitude: [30, 31],
        },
        variables: {
          temperature: {
            data: [
              [20, 21],
              [22, 23],
            ],
          },
        },
        quality: { dataCompleteness: 95 },
      };

      const validation = await transformer.validateTransformedData(validData);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(validation.checks.dataCompleteness).toBe(95);
    });

    test('should detect validation errors', async () => {
      const invalidData = {
        // Missing required metadata
        coordinates: {
          longitude: [-200], // Invalid longitude
          latitude: [30],
        },
        variables: {},
        quality: { dataCompleteness: 50 },
      };

      const validation = await transformer.validateTransformedData(invalidData);

      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      expect(validation.warnings.length).toBeGreaterThan(0);
    });

    test('should validate coordinate ranges', async () => {
      const dataWithInvalidCoords = {
        metadata: { format: 'wrfcoin-unified' },
        coordinates: {
          longitude: [-200, 200], // Out of range
          latitude: [-100, 100], // Out of range
        },
        variables: { temp: { data: [[20, 21]] } },
      };

      const validation = await transformer.validateTransformedData(
        dataWithInvalidCoords
      );

      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes('Longitude'))).toBe(true);
      expect(validation.errors.some(e => e.includes('Latitude'))).toBe(true);
    });
  });

  describe('Metrics and Performance', () => {
    test('should track transformation metrics', async () => {
      const inputData = createMockClimateData();
      const transformationSpec = createMockTransformationSpec();

      const initialMetrics = transformer.getMetrics();

      await transformer.transformToWRFCoinFormat(inputData, transformationSpec);

      const updatedMetrics = transformer.getMetrics();

      expect(updatedMetrics.totalTransformations).toBe(
        initialMetrics.totalTransformations + 1
      );
      expect(updatedMetrics.successfulTransformations).toBe(
        initialMetrics.successfulTransformations + 1
      );
      expect(updatedMetrics.averageTransformationTime).toBeGreaterThan(0);
    });

    test('should calculate success rate correctly', () => {
      transformer.updateMetrics(true, 100);
      transformer.updateMetrics(true, 200);
      transformer.updateMetrics(false, 150);

      const metrics = transformer.getMetrics();

      expect(metrics.totalTransformations).toBe(3);
      expect(metrics.successfulTransformations).toBe(2);
      expect(metrics.failedTransformations).toBe(1);
      expect(metrics.successRate).toBeCloseTo(66.67, 1);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle missing coordinate data gracefully', async () => {
      const inputData = {
        metadata: { source: 'test' },
        variables: { temp: { data: [20] } },
        // Missing coordinates
      };

      const result = await transformer.transformToWRFCoinFormat(inputData, {});

      expect(result.success).toBe(true);
      expect(result.data.coordinates.bounds).toBeNull();
    });

    test('should handle empty variables object', async () => {
      const inputData = {
        metadata: { source: 'test' },
        coordinates: { longitude: [-120], latitude: [30] },
        variables: {},
      };

      const result = await transformer.transformToWRFCoinFormat(inputData, {});

      expect(result.success).toBe(true);
      expect(result.data.quality.dataCompleteness).toBe(0);
    });

    test('should track failed transformations', async () => {
      const invalidData = null; // This should cause an error

      try {
        await transformer.transformToWRFCoinFormat(invalidData, {});
      } catch (error) {
        // Expected error
      }

      const metrics = transformer.getMetrics();
      expect(metrics.failedTransformations).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// PERFORMANCE AND LOAD TESTS
// ============================================================================

describe('Performance Tests', () => {
  let transformer;

  beforeEach(() => {
    transformer = new ClimateDataTransformer();
  });

  test('should handle large datasets efficiently', async () => {
    const largeData = {
      metadata: { source: 'performance-test' },
      coordinates: {
        longitude: Array.from({ length: 100 }, (_, i) => -120 + i * 0.1),
        latitude: Array.from({ length: 100 }, (_, i) => 30 + i * 0.1),
      },
      time: Array.from({ length: 48 }, (_, i) =>
        new Date(Date.now() + i * 3600000).toISOString()
      ),
      variables: {
        temperature: {
          data: Array.from({ length: 48 }, () =>
            Array.from({ length: 100 }, () =>
              Array.from({ length: 100 }, () => Math.random() * 30 + 10)
            )
          ),
          units: 'celsius',
        },
      },
    };

    const startTime = Date.now();
    const result = await transformer.transformToWRFCoinFormat(largeData, {});
    const endTime = Date.now();

    expect(result.success).toBe(true);
    expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
  }, 10000); // 10 second timeout

  test('should handle concurrent transformations', async () => {
    const inputData = createMockClimateData();
    const transformationSpec = createMockTransformationSpec();

    const promises = Array.from({ length: 5 }, () =>
      transformer.transformToWRFCoinFormat(inputData, transformationSpec)
    );

    const results = await Promise.all(promises);

    expect(results).toHaveLength(5);
    expect(results.every(r => r.success)).toBe(true);
  });

  test('should maintain performance with repeated operations', async () => {
    const inputData = createMockClimateData();
    const transformationSpec = createMockTransformationSpec();
    const times = [];

    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await transformer.transformToWRFCoinFormat(inputData, transformationSpec);
      times.push(Date.now() - start);
    }

    const averageTime = times.reduce((a, b) => a + b, 0) / times.length;
    const maxTime = Math.max(...times);
    const minTime = Math.min(...times);

    // Performance should be consistent (max time shouldn't be more than 3x min time)
    expect(maxTime / minTime).toBeLessThan(3);
    expect(averageTime).toBeLessThan(1000); // Average under 1 second
  });
});
