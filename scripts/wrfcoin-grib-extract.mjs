#!/usr/bin/env node

import { GribNetcdfParser, detectSourceFormatFromExtension } from '../server/services/forecast/grib-netcdf-parser.ts';
import { VALID_VARIABLES } from '../server/services/forecast/grib-netcdf-constants.ts';

const args = process.argv.slice(2);
const formatIdx = args.indexOf('--format');
let formatOverride = null;
if (formatIdx !== -1) {
  formatOverride = args[formatIdx + 1];
  args.splice(formatIdx, 2);
}
const [filePath, variableArg] = args;

if (!filePath || !variableArg) {
  console.error('Usage: npx wrfcoin-grib-extract <file> <variable> [--format grib2|netcdf4]');
  process.exit(1);
}

const validVariables = new Set(VALID_VARIABLES);

if (!validVariables.has(variableArg)) {
  console.error(
    `Invalid variable "${variableArg}". Expected one of: ${Array.from(validVariables).join(', ')}`
  );
  process.exit(1);
}

const parser = new GribNetcdfParser();

try {
  const sourceFormat = formatOverride || detectSourceFormatFromExtension(filePath);
  const output = await parser.extractVariableToJson(filePath, variableArg, sourceFormat);
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Unknown extraction error.'
  );
  process.exit(1);
}
