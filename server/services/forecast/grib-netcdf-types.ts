export type Variable =
  | 'temperature'
  | 'wind_u'
  | 'wind_v'
  | 'pressure'
  | 'relative_humidity'
  | 'precipitation';

export interface GridPoint {
  lat: number;
  lon: number;
  variables: Partial<Record<Variable, number>>;
}

export interface ForecastGrid {
  sourceFormat: 'grib2' | 'netcdf4';
  variable: Variable;
  units: string;
  width: number;
  height: number;
  projection: 'latlon' | 'lambert_conformal';
  values: number[][];
  latitudes?: number[];
  longitudes?: number[];
  metadata: Record<string, unknown>;
}

export interface LambertConformalConfig {
  standardParallel1: number;
  standardParallel2: number;
  lat0: number;
  lon0: number;
  dxMeters: number;
  dyMeters: number;
  nx: number;
  ny: number;
}

