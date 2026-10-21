import type { Variable } from './grib-netcdf-types.js';

export const VALID_VARIABLES: readonly Variable[] = Object.freeze([
  'temperature',
  'wind_u',
  'wind_v',
  'pressure',
  'relative_humidity',
  'precipitation',
] as const);

export const VARIABLE_TO_GRIB_TOKEN: Readonly<Record<Variable, string>> = Object.freeze({
  temperature: 'TMP',
  wind_u: 'UGRD',
  wind_v: 'VGRD',
  pressure: 'PRES',
  relative_humidity: 'RH',
  precipitation: 'APCP',
});
