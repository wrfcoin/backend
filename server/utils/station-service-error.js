/**
 * #1042: single failure funnel for the lazily-imported ESM station services.
 *
 * The station routes live in a CJS router that loads
 * `../services/station-registration-service.js` via dynamic `import()`. When
 * the compiled `.js` is missing from the running image (deploy drift: dist
 * carries the route but not the tsc emit), that import rejects with
 * ERR_MODULE_NOT_FOUND — and the route catches used to swallow it into a
 * generic 500 that logged only `error.message`. The real cause never reached
 * the log and cost a six-step live investigation.
 *
 * Every station-service catch routes through here so that:
 *  - `error.code` and `error.stack` always reach the log, and
 *  - a missing-module failure is distinguishable at the API surface (503
 *    naming the broken build) from an ordinary handler failure (generic 500).
 */

const STATION_SERVICE_SPECIFIER = '../services/station-registration-service.js';

/**
 * Classify a station-route failure, log it with code+stack, and return the
 * HTTP response the route should send.
 *
 * @param {string} action human-readable action, e.g. 'register weather station'
 * @param {unknown} error the caught error
 * @param {{ error: (msg: string, meta: object) => void }} log logger
 * @returns {{ status: number, code: string, publicMessage: string }}
 */
function stationServiceFailureResponse(action, error, log) {
  const err = error instanceof Error ? error : new Error(String(error));
  const details = {
    action,
    code: /** @type {NodeJS.ErrnoException} */ (err).code,
    message: err.message,
    stack: err.stack,
  };

  // ERR_MODULE_NOT_FOUND: the emitted .js is absent (the original #1042 shape).
  // ERR_UNKNOWN_FILE_EXTENSION: the image shipped an un-emitted .ts where the
  // route expected the compiled module — the same deploy drift, different tell.
  if (
    details.code === 'ERR_MODULE_NOT_FOUND' ||
    details.code === 'ERR_UNKNOWN_FILE_EXTENSION'
  ) {
    log.error(
      `station service module failed to load — this build is missing a compiled ` +
        `service the router imports (see ${STATION_SERVICE_SPECIFIER}; #1042). ` +
        `The image likely shipped a route without its tsc-emitted counterpart.`,
      details
    );
    return {
      status: 503,
      code: 'STATION_BUILD_ARTIFACT_MISSING',
      publicMessage:
        'Station service is unavailable: the server build is missing a required module',
    };
  }

  // A SyntaxError from the dynamic import means the artifact exists but is
  // malformed (truncated emit, merge damage, wrong encoding). Same operator
  // action as a missing artifact — rebuild/redeploy — so it gets the same
  // diagnosable 503 instead of vanishing into the generic 500.
  if (err instanceof SyntaxError) {
    log.error(
      `station service module failed to parse — the compiled service the router ` +
        `imports is present but malformed (see ${STATION_SERVICE_SPECIFIER}; #1042).`,
      details
    );
    return {
      status: 503,
      code: 'STATION_BUILD_ARTIFACT_INVALID',
      publicMessage:
        'Station service is unavailable: a server build artifact is malformed',
    };
  }

  log.error(`Failed to ${action}`, details);
  return {
    status: 500,
    code: 'WEATHER_ERROR',
    publicMessage: `Failed to ${action}`,
  };
}

module.exports = { stationServiceFailureResponse, STATION_SERVICE_SPECIFIER };
