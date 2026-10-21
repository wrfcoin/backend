import path from 'path';
import fs from 'fs/promises';
import {
  detectSourceFormatFromExtension,
  GribNetcdfParser,
} from '../../server/services/forecast/grib-netcdf-parser.js';

const fixturesDir = path.resolve(__dirname, '../fixtures/forecast');

describe('GribNetcdfParser', () => {
  const parser = new GribNetcdfParser({ allowCommandExecution: false });

  it('parses GRIB2 fixture and extracts temperature grid', async () => {
    const fixturePath = path.join(fixturesDir, 'sample_gfs.json');
    const grid = await parser.parseGrib2(fixturePath, 'temperature');

    expect(grid.sourceFormat).toBe('grib2');
    expect(grid.variable).toBe('temperature');
    expect(grid.units).toBe('K');
    expect(grid.width).toBe(3);
    expect(grid.height).toBe(2);
    expect(grid.values[0][0]).toBeCloseTo(289.1);
  });

  it('parses NetCDF fixture and extracts precipitation grid', async () => {
    const fixturePath = path.join(fixturesDir, 'sample_wrfout.json');
    const grid = await parser.parseNetcdf4(fixturePath, 'precipitation');

    expect(grid.sourceFormat).toBe('netcdf4');
    expect(grid.variable).toBe('precipitation');
    expect(grid.projection).toBe('lambert_conformal');
    expect(grid.width).toBe(2);
    expect(grid.height).toBe(2);
    expect(grid.values[1][0]).toBeCloseTo(0.1);
  });

  it('converts grid into JSON payload for CLI usage', async () => {
    const fixturePath = path.join(fixturesDir, 'sample_gfs.json');
    const json = await parser.extractVariableToJson(
      fixturePath,
      'wind_u',
      'grib2'
    );

    expect(json).toMatchObject({
      sourceFormat: 'grib2',
      variable: 'wind_u',
      units: 'm/s',
    });
  });

  it('maps lat/lon indices for latlon projection', async () => {
    const fixturePath = path.join(fixturesDir, 'sample_gfs.json');
    const grid = await parser.parseGrib2(fixturePath, 'pressure');
    const point = parser.gridIndexToLatLon(1, 0, 'latlon', {
      latitudes: grid.latitudes,
      longitudes: grid.longitudes,
    });

    expect(point.lat).toBeCloseTo(40);
    expect(point.lon).toBeCloseTo(-104.5);
  });

  it('maps lambert conformal grid indices into lat/lon values', () => {
    const point = parser.gridIndexToLatLon(5, 4, 'lambert_conformal', {
      lambert: {
        standardParallel1: 30,
        standardParallel2: 60,
        lat0: 38,
        lon0: -97,
        dxMeters: 12000,
        dyMeters: 12000,
        nx: 100,
        ny: 80,
      },
    });

    expect(Number.isFinite(point.lat)).toBe(true);
    expect(Number.isFinite(point.lon)).toBe(true);
    expect(point.lat).toBeGreaterThan(15);
    expect(point.lat).toBeLessThan(70);
    expect(point.lon).toBeGreaterThan(-140);
    expect(point.lon).toBeLessThan(-50);
  });

  it('detects source format by extension', () => {
    expect(detectSourceFormatFromExtension('/tmp/a.grib2')).toBe('grib2');
    expect(detectSourceFormatFromExtension('/tmp/a.nc')).toBe('netcdf4');
  });

  it('rejects unsupported source format in extraction helper', async () => {
    const fixturePath = path.join(fixturesDir, 'sample_gfs.json');
    await expect(
      parser.extractVariableToJson(fixturePath, 'temperature', 'bad')
    ).rejects.toThrow('Unsupported sourceFormat');
  });

  it('rejects ragged matrix values', async () => {
    const badFixturePath = path.join(fixturesDir, 'ragged.grib2');
    await fs.writeFile(
      badFixturePath,
      JSON.stringify({
        variables: {
          temperature: {
            units: 'K',
            projection: 'latlon',
            values: [[1, 2], [3]],
          },
        },
      })
    );

    await expect(
      parser.parseGrib2(badFixturePath, 'temperature')
    ).rejects.toThrow('has no usable grid values');

    await fs.unlink(badFixturePath);
  });
});
