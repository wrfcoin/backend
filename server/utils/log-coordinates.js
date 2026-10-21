/**
 * Log-safe coordinates (backend#1290).
 *
 * A caller's position must never reach a log line at more than 0.1 degree
 * (~11 km) precision: owner ruling 2026-09-28. The anonymous-read projection
 * (anonymous-projection.js) uses the same 0.1 degree since 2026-10-01.
 */

const LOG_COORDINATE_DECIMALS = 1;
const FACTOR = 10 ** LOG_COORDINATE_DECIMALS;

function coarsenLogCoordinate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(numeric * FACTOR) / FACTOR;
}

/** { latitude, longitude } at 0.1 degree, or null when there is no position. */
function logLocation(latitude, longitude) {
  const lat = coarsenLogCoordinate(latitude);
  const lon = coarsenLogCoordinate(longitude);
  if (lat === null || lon === null) {
    return null;
  }
  return { latitude: lat, longitude: lon };
}

// A decimal with two or more fractional digits, e.g. 44.98765, -93.2654,
// -.98765, or with a percent-encoded dot (44%2E98765).
const FINE_DECIMAL = /-?\d*(?:\.|%2E)\d{2,}/gi;

// A complete scientific-notation number, mantissa (\d+, \d+.\d*, .\d+) plus exponent with an optional
// sign (literal or percent-encoded): 4498765e-5, 449876.5e-4, 4498.765e-2, .4498765e2, 4.498765E1.
// parseFloat reads each of these as 44.98765 although the text has no fine decimal (backend#1295).
// The whole token is parsed and rounded, so no mantissa prefix survives. The lookbehind keeps
// identifiers such as ab12e4 or 1.2.3e4 out of it.
const SCIENTIFIC_NUMBER = /(?<![A-Za-z0-9_.%])-?(?:\d+(?:\.\d*)?|\.\d+)[eE](?:[-+]|%2[dDbB])?\d+/g;

// An NWS gridpoint, /gridpoints/<WFO>/<x>,<y>: integers on the ~2.5 km NDFD
// grid, so finer than 0.1 degree even though no decimal appears. The WFO
// (forecast office) is a region and stays.
const GRIDPOINT = /(\/gridpoints\/[A-Za-z0-9]+\/)\d+\s*(?:,|%2C)\s*\d+/gi;

// An NWS observation station, /stations/<id>/...: the nearest station can place
// a caller finer than 0.1 degree in a dense area (backend#1304 P1).
const STATION_PATH = /(\/stations\/)[A-Za-z0-9_.-]+/gi;

// Bare station values in a JSON body: "station":"KMSP", "stationIdentifier":"KMSP".
const STATION_FIELD = /("station(?:Identifier)?"\s*:\s*")[^"]*(")/gi;

/**
 * Coarsen every fine decimal in free text (an upstream URL, an upstream error
 * body) to 0.1, and drop NWS gridpoint x,y and /stations/<id> path segments. Upstream text echoes the requested
 * point, so it cannot be logged verbatim; any other number it rounds is
 * harmless in a log line.
 */
function redactCoordinateText(value) {
  if (value === null || value === undefined) {
    return value;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) {
    return undefined;
  }
  // Percent-encoding can hide a number (digits, sign, dot, exponent marker) AND its boundaries
  // (%2F, %2C) from the detectors, and the upstream decodes all of it. So: decode a SCRATCH copy
  // (repeat until stable, bounded, never throwing), run the detectors on that copy, and if
  // anything finer than 0.1 degree is found in an encoded string, drop the WHOLE original value.
  // Decoded text is never spliced back in. Strings with no escapes keep the in-place coarsening;
  // strings with no coordinates keep their bytes.
  const scratch = decodeScratch(text);
  if (scratch !== text) {
    // Still holding a well-formed escape after the pass limit means the nesting is deeper than we
    // can classify: drop the whole value (fails safe, whatever the detectors would say).
    if (hasEscape(scratch) || redactPlain(scratch) !== scratch) {
      return ENCODED_COORDINATE_REDACTION;
    }
  }
  return redactPlain(text);
}

const ENCODED_COORDINATE_REDACTION = '[REDACTED: encoded coordinate text]';
const MAX_DECODE_PASSES = 5;

// Decodes every well-formed ASCII percent escape, up to MAX_DECODE_PASSES times or until stable.
// Malformed escapes (%zz, a lone %) and non-ASCII bytes are left as they are; nothing here throws.
function hasEscape(text) {
  return /%[0-7][0-9a-fA-F]/.test(text);
}

function decodeScratch(text) {
  let current = text;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next = current.replace(/%([0-7][0-9a-fA-F])/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) break;
    current = next;
  }
  return current;
}

function redactPlain(text) {
  return text
    .replace(GRIDPOINT, '$1*')
    .replace(STATION_PATH, '$1*')
    .replace(STATION_FIELD, '$1*$2')
    .replace(SCIENTIFIC_NUMBER, (match) => {
      const numeric = Number(match.replace(/%2D/i, '-').replace(/%2B/i, '+'));
      return Number.isFinite(numeric)
        ? (Math.round(numeric * FACTOR) / FACTOR).toFixed(LOG_COORDINATE_DECIMALS)
        : '*';
    })
    .replace(FINE_DECIMAL, (match) => {
      const numeric = Number(match.replace(/%2E/i, '.'));
      return (Math.round(numeric * FACTOR) / FACTOR).toFixed(LOG_COORDINATE_DECIMALS);
    });
}

module.exports = {
  LOG_COORDINATE_DECIMALS,
  coarsenLogCoordinate,
  logLocation,
  redactCoordinateText,
};
