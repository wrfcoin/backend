/**
 * The blanket anonymous-coordinate rule (owner ruling 2026-10-01, backend#1222):
 * no response body sent to an anonymous caller carries a horizontal position
 * finer than 0.1 degree.
 *
 * Field-aware, never textual (backend#1397 review): only known horizontal
 * coordinate fields are rounded, i.e. `latitude`/`longitude`/`lat`/`lon`/`lng`
 * (also as `_lat`-style and camelCase `…Lat` suffixes), and axes 0 and 1 of
 * GeoJSON positions (`coordinates`) and of `center`/`bbox`. Every string,
 * every id and every other axis (a 3D point's altitude) is left exactly as it
 * is: this guard never rewrites text. Owner-entered station NAMES are coarsened
 * by the station projections that serialise them (coarsenCoordinatesInName in
 * utils/anonymous-projection.js), never here, so third-party text such as an
 * NWS forecast period label passes through unchanged (backend#1397 r5).
 * Echoes of the caller's own input that are not such fields (a location name)
 * are the route's job: build them from the parsed, rounded coordinates.
 *
 * Routes still coarsen their own projections (anonymous-projection.js); this
 * guard is the last line at the response boundary, so a route that forgets a
 * coordinate field is still covered. Only the RESPONSE is rounded: handlers
 * keep the caller's input (an upstream NOAA lookup may use it). Authorized
 * views keep exact values: an operator bearer token, or a request an auth
 * middleware has attached a user to.
 */
const { coarsenCoordinate } = require('../utils/anonymous-projection');
const { hasOperatorToken } = require('./operator-token-auth');

const HORIZONTAL_KEY = /^(lat|latitude|lng|lon|longitude)$/i;
const HORIZONTAL_SUFFIX = /_(lat|latitude|lng|lon|longitude)$/i;
const HORIZONTAL_CAMEL_SUFFIX = /[a-z0-9](Lat|Latitude|Lng|Lon|Longitude)$/;
// A JSON number written as a string: sign, plus sign, decimals, exponent.
const NUMBER_LIKE = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;
function isCoordinateKey(key) {
  return HORIZONTAL_KEY.test(key) || HORIZONTAL_SUFFIX.test(key) || HORIZONTAL_CAMEL_SUFFIX.test(key);
}

/** One horizontal coordinate value at one decimal, keeping its JSON type. */
function coarsenValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? coarsenCoordinate(value) : value;
  }
  if (typeof value === 'string' && NUMBER_LIKE.test(value)) {
    const coarse = coarsenCoordinate(Number(value));
    return coarse === null ? value : String(coarse);
  }
  return value;
}

/** A GeoJSON position: axes 0 (lon) and 1 (lat) only; altitude and the rest untouched. */
function coarsenPosition(position) {
  return position.map((axis, index) => (index < 2 ? coarsenValue(axis) : axis));
}

/** `coordinates`: a position, or nested arrays of positions (LineString, Polygon, ...). */
function coarsenCoordinatesArray(value) {
  if (!Array.isArray(value)) return value;
  if (value.length > 0 && value.every((axis) => !Array.isArray(axis))) {
    return coarsenPosition(value);
  }
  return value.map(coarsenCoordinatesArray);
}

/** GeoJSON bbox: [w, s, e, n] or, in 3D, [w, s, zmin, e, n, zmax]. */
function coarsenBbox(value) {
  const horizontal = value.length === 6 ? new Set([0, 1, 3, 4]) : new Set([0, 1, 2, 3]);
  return value.map((axis, index) => (horizontal.has(index) ? coarsenValue(axis) : axis));
}

/**
 * A copy of `value` with every horizontal coordinate field at one decimal.
 * Non-plain objects (Dates, Buffers) serialize as they are.
 */
function coarsenCoordinatesDeep(value, depth = 0) {
  if (depth > 64) return value;
  if (Array.isArray(value)) return value.map((item) => coarsenCoordinatesDeep(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    if (typeof value.toJSON === 'function') {
      return coarsenCoordinatesDeep(value.toJSON(), depth + 1);
    }
    return value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isCoordinateKey(key) && (typeof child === 'number' || typeof child === 'string')) {
      out[key] = coarsenValue(child);
    } else if (key === 'coordinates' && Array.isArray(child)) {
      out[key] = coarsenCoordinatesArray(child);
    } else if (key === 'bbox' && Array.isArray(child)) {
      out[key] = coarsenBbox(child);
    } else if (key === 'center' && Array.isArray(child)) {
      out[key] = coarsenPosition(child);
    } else {
      out[key] = coarsenCoordinatesDeep(child, depth + 1);
    }
  }
  return out;
}

// The only namespace whose router may authorize exact rows itself (the IoT
// router, for its gateway admin token, backend#1220). Matched on the canonical
// request path with a segment boundary, case-insensitively like Express
// routing: /api/iotex and /api/iotex/... only, never /api/iotex-other.
const ROUTE_AUTHORIZED_NAMESPACE = /^\/api\/iotex(?:\/|$)/i;

function canonicalPath(req) {
  const raw = typeof req.originalUrl === 'string' ? req.originalUrl : req.url || '';
  return raw.split('?')[0];
}

function isAuthorizedForExactCoordinates(req) {
  return (
    hasOperatorToken(req) ||
    Boolean(req.user) ||
    req.operatorAuthenticated === true ||
    // backend#1397 r8: a route-set flag counts only inside its namespace.
    (req.exactCoordinatesAuthorized === true && ROUTE_AUTHORIZED_NAMESPACE.test(canonicalPath(req)))
  );
}

function isJsonContentType(res) {
  const type = res.getHeader('Content-Type');
  return typeof type === 'string' && /\bjson\b/i.test(type);
}

/**
 * Express middleware. Wraps `res.json` (Express routes) and `res.end` with a
 * JSON string body (the inline handler's `res.end(JSON.stringify(data))`).
 * The decision is made when the body is sent, after any route-level auth ran.
 */
function anonymousCoordinateGuard(req, res, next) {
  const json = res.json.bind(res);
  const end = res.end.bind(res);
  let viaJson = false;

  res.json = (body) => {
    viaJson = true;
    return json(isAuthorizedForExactCoordinates(req) ? body : coarsenCoordinatesDeep(body));
  };

  res.end = (chunk, ...rest) => {
    if (
      !viaJson &&
      (typeof chunk === 'string' || Buffer.isBuffer(chunk)) &&
      isJsonContentType(res) &&
      !isAuthorizedForExactCoordinates(req)
    ) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        const coarse = JSON.stringify(coarsenCoordinatesDeep(parsed));
        if (coarse !== text) {
          if (!res.headersSent && res.getHeader('Content-Length') !== undefined) {
            res.setHeader('Content-Length', Buffer.byteLength(coarse));
          }
          return end(coarse, ...rest);
        }
      }
    }
    return end(chunk, ...rest);
  };

  next();
}

module.exports = {
  anonymousCoordinateGuard,
  coarsenCoordinatesDeep,
  isAuthorizedForExactCoordinates,
  isCoordinateKey,
};
