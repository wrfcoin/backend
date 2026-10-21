import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  VALID_VARIABLES,
  VARIABLE_TO_GRIB_TOKEN,
} from './grib-netcdf-constants.js';
import type {
  Variable,
  ForecastGrid,
  GridPoint,
  LambertConformalConfig,
} from './grib-netcdf-types.js';

const execFileAsync = promisify(execFile);

export interface GribNetcdfParserOptions {
  allowCommandExecution?: boolean;
  allowFixtureJson?: boolean;
  maxFixtureBytes?: number;
}

export class GribNetcdfParser {
  private allowCommandExecution: boolean;
  private allowFixtureJson: boolean;
  private maxFixtureBytes: number;

  constructor(options: GribNetcdfParserOptions = {}) {
    this.allowCommandExecution = options.allowCommandExecution !== false;
    this.allowFixtureJson = options.allowFixtureJson !== false;
    this.maxFixtureBytes = options.maxFixtureBytes || 5 * 1024 * 1024;
  }

  async parseGrib2(filePath: string, variable: Variable): Promise<ForecastGrid> {
    assertValidVariable(variable);

    if (this.allowFixtureJson) {
      const payload = await this.loadStructuredFixture(filePath);
      if (payload) {
        return this.extractGrid(payload, 'grib2', variable);
      }
    }

    if (!this.allowCommandExecution) {
      throw new Error(
        'GRIB2 command execution is disabled and file is not structured fixture JSON.'
      );
    }

    const jsonOutput = await this.runWgrib2Json(filePath);
    return this.extractGrid(jsonOutput, 'grib2', variable);
  }

  async parseNetcdf4(filePath: string, variable: Variable): Promise<ForecastGrid> {
    assertValidVariable(variable);

    if (this.allowFixtureJson) {
      const payload = await this.loadStructuredFixture(filePath);
      if (payload) {
        return this.extractGrid(payload, 'netcdf4', variable);
      }
    }

    if (!this.allowCommandExecution) {
      throw new Error(
        'NetCDF command execution is disabled and file is not structured fixture JSON.'
      );
    }

    const jsonOutput = await this.runNcdumpJson(filePath);
    return this.extractGrid(jsonOutput, 'netcdf4', variable);
  }

  async extractVariableToJson(
    filePath: string,
    variable: Variable,
    sourceFormat: 'grib2' | 'netcdf4'
  ): Promise<Record<string, unknown>> {
    let grid: ForecastGrid;
    switch (sourceFormat) {
      case 'grib2':
        grid = await this.parseGrib2(filePath, variable);
        break;
      case 'netcdf4':
        grid = await this.parseNetcdf4(filePath, variable);
        break;
      default:
        throw new Error(`Unsupported sourceFormat: ${sourceFormat}`);
    }

    return {
      sourceFormat: grid.sourceFormat,
      variable: grid.variable,
      units: grid.units,
      projection: grid.projection,
      dimensions: {
        width: grid.width,
        height: grid.height,
      },
      metadata: grid.metadata,
      values: grid.values,
    };
  }

  toGridPoints(grid: ForecastGrid): GridPoint[] {
    const points: GridPoint[] = [];
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const lat = grid.latitudes ? grid.latitudes[y] : y;
        const lon = grid.longitudes ? grid.longitudes[x] : x;
        points.push({
          lat,
          lon,
          variables: {
            [grid.variable]: grid.values[y][x],
          },
        });
      }
    }
    return points;
  }

  gridIndexToLatLon(
    x: number,
    y: number,
    projection: 'latlon' | 'lambert_conformal',
    options: { latitudes?: number[]; longitudes?: number[]; lambert?: LambertConformalConfig }
  ): { lat: number; lon: number } {
    if (projection === 'latlon') {
      if (!options.latitudes || !options.longitudes) {
        throw new Error(
          'latitudes and longitudes are required for latlon projection.'
        );
      }
      if (
        y < 0 ||
        y >= options.latitudes.length ||
        x < 0 ||
        x >= options.longitudes.length
      ) {
        throw new Error('Grid index out of range for provided coordinates.');
      }

      return {
        lat: options.latitudes[y],
        lon: options.longitudes[x],
      };
    }

    if (!options.lambert) {
      throw new Error(
        'lambert configuration is required for lambert_conformal projection.'
      );
    }

    return lambertGridIndexToLatLon(x, y, options.lambert);
  }

  private async loadStructuredFixture(filePath: string): Promise<Record<string, any> | null> {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error('Input path is not a file.');
    }
    if (stats.size > this.maxFixtureBytes) {
      return null;
    }

    const raw = await fs.readFile(filePath, 'utf8');
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        return data;
      }
      return null;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  private async runWgrib2Json(filePath: string): Promise<Record<string, any>> {
    const { stdout } = await execFileAsync('wgrib2', [filePath, '-json', '-']);
    const parsed = JSON.parse(stdout);
    return normalizeWgrib2Output(parsed);
  }

  private async runNcdumpJson(filePath: string): Promise<Record<string, any>> {
    const { stdout } = await execFileAsync('ncdump', ['-j', filePath]);
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Unexpected ncdump JSON output.');
    }
    return parsed;
  }

  private extractGrid(
    payload: Record<string, any>,
    sourceFormat: 'grib2' | 'netcdf4',
    variable: Variable
  ): ForecastGrid {
    const variables = toObject(payload.variables);
    if (!variables) {
      throw new Error(`No variables found in ${sourceFormat} payload.`);
    }

    const rawVariable = toObject(variables[variable]);
    if (!rawVariable) {
      throw new Error(`Variable "${variable}" not found in ${sourceFormat} payload.`);
    }

    const values = toMatrix(rawVariable.values);
    if (!values || values.length === 0 || values[0].length === 0) {
      throw new Error(`Variable "${variable}" has no usable grid values.`);
    }

    const height = values.length;
    const width = values[0].length;
    const latitudes = toNumberArray(rawVariable.latitudes);
    const longitudes = toNumberArray(rawVariable.longitudes);

    return {
      sourceFormat,
      variable,
      units: typeof rawVariable.units === 'string' ? rawVariable.units : 'unknown',
      width,
      height,
      projection:
        rawVariable.projection === 'lambert_conformal'
          ? 'lambert_conformal'
          : 'latlon',
      values,
      latitudes: latitudes && latitudes.length === height ? latitudes : undefined,
      longitudes: longitudes && longitudes.length === width ? longitudes : undefined,
      metadata: toObject(payload.metadata) || {},
    };
  }
}

export function lambertGridIndexToLatLon(
  x: number,
  y: number,
  cfg: LambertConformalConfig
): { lat: number; lon: number } {
  const degToRad = (deg: number) => (deg * Math.PI) / 180;
  const radToDeg = (rad: number) => (rad * 180) / Math.PI;
  const earthRadiusMeters = 6370000;

  const phi1 = degToRad(cfg.standardParallel1);
  const phi2 = degToRad(cfg.standardParallel2);
  const phi0 = degToRad(cfg.lat0);
  const lambda0 = degToRad(cfg.lon0);

  const n =
    Math.abs(cfg.standardParallel1 - cfg.standardParallel2) < 1e-6
      ? Math.sin(phi1)
      : Math.log(Math.cos(phi1) / Math.cos(phi2)) /
        Math.log(
          Math.tan(Math.PI / 4 + phi2 / 2) /
            Math.tan(Math.PI / 4 + phi1 / 2)
        );

  const f =
    (Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n)) / n;
  const rho0 =
    (earthRadiusMeters * f) / Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n);

  const xMeters = (x - (cfg.nx - 1) / 2) * cfg.dxMeters;
  const yMeters = ((cfg.ny - 1) / 2 - y) * cfg.dyMeters;
  const rho =
    Math.sign(n) *
    Math.sqrt(xMeters * xMeters + (rho0 - yMeters) * (rho0 - yMeters));
  const theta = Math.atan2(xMeters, rho0 - yMeters);

  const lat = 2 * Math.atan(Math.pow((earthRadiusMeters * f) / rho, 1 / n)) - Math.PI / 2;
  const lon = lambda0 + theta / n;

  return {
    lat: radToDeg(lat),
    lon: radToDeg(lon),
  };
}

export function detectSourceFormatFromExtension(filePath: string): 'grib2' | 'netcdf4' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.grib2' || ext === '.grb2' || ext === '.grib') {
    return 'grib2';
  }
  if (ext === '.nc' || ext === '.netcdf') {
    return 'netcdf4';
  }
  throw new Error(`Unable to detect source format from extension: ${ext}`);
}

function toObject(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, any>;
}

function toNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const converted = value.map((item: unknown) =>
    typeof item === 'number' ? item : Number(item)
  );
  if (converted.some((item: number) => Number.isNaN(item))) {
    return null;
  }
  return converted;
}

function toMatrix(value: unknown): number[][] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const matrix: number[][] = [];
  let expectedWidth: number | null = null;
  for (const row of value) {
    if (!Array.isArray(row)) {
      return null;
    }
    const convertedRow = row.map((item: unknown) =>
      typeof item === 'number' ? item : Number(item)
    );
    if (convertedRow.some((item: number) => Number.isNaN(item))) {
      return null;
    }
    if (expectedWidth === null) {
      expectedWidth = convertedRow.length;
    } else if (expectedWidth !== convertedRow.length) {
      return null;
    }
    matrix.push(convertedRow);
  }
  return matrix;
}

function normalizeWgrib2Output(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as any).variables) {
    return raw as Record<string, any>;
  }

  if (!Array.isArray(raw)) {
    throw new Error('Unexpected wgrib2 JSON output shape.');
  }

  const payload: { metadata: Record<string, any>; variables: Record<string, any> } = {
    metadata: {
      source: 'wgrib2',
      records: raw.length,
    },
    variables: {},
  };

  for (const variable of VALID_VARIABLES) {
    const token = VARIABLE_TO_GRIB_TOKEN[variable];
    const entry = raw.find(
      (row: any) =>
        row &&
        typeof row === 'object' &&
        typeof row.name === 'string' &&
        row.name.toUpperCase().includes(token)
    );

    if (!entry || !Array.isArray(entry.data)) {
      continue;
    }

    const nx = Number(entry.Nx || entry.nx || 0);
    const ny = Number(entry.Ny || entry.ny || 0);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx <= 0 || ny <= 0) {
      continue;
    }

    const values: number[][] = [];
    for (let j = 0; j < ny; j++) {
      values.push(entry.data.slice(j * nx, (j + 1) * nx));
    }

    payload.variables[variable] = {
      units: entry.units || 'unknown',
      projection: 'latlon',
      values,
    };
  }

  return payload;
}

function assertValidVariable(variable: string): asserts variable is Variable {
  if (!(VALID_VARIABLES as readonly string[]).includes(variable)) {
    throw new Error(`Unsupported variable: ${variable}`);
  }
}
