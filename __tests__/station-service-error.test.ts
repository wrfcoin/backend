/**
 * #1042 — the station-route failure funnel must put error.code and
 * error.stack in the log, and must distinguish a missing compiled module
 * (broken build → 503 naming the cause) from an ordinary handler error
 * (generic 500).
 *
 * Before this fix, the catches in weather-routes.js logged only
 * `error.message`, so the ERR_MODULE_NOT_FOUND from the lazy service import
 * surfaced as `Failed to register weather station` / `Failed to list station
 * credentials` with no code and no stack — the real cause never reached the
 * log. This tests the REAL helper the routes now call (required as CJS, the
 * same way weather-routes.js requires it).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  stationServiceFailureResponse,
} = require('../server/utils/station-service-error');

type LoggedEntry = { msg: string; meta: Record<string, unknown> };

function makeLogger() {
  const entries: LoggedEntry[] = [];
  return {
    entries,
    error: (msg: string, meta: Record<string, unknown>) => {
      entries.push({ msg, meta });
    },
  };
}

function moduleNotFoundError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    "Cannot find module '/app/dist/server/services/station-registration-service.js' " +
      'imported from /app/dist/server/routes/weather-routes.cjs'
  );
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

describe('stationServiceFailureResponse (#1042)', () => {
  it('logs error.code and error.stack — the two fields whose absence cost the live investigation', () => {
    const log = makeLogger();
    const err = moduleNotFoundError();

    stationServiceFailureResponse('list station credentials', err, log);

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].meta.code).toBe('ERR_MODULE_NOT_FOUND');
    expect(typeof log.entries[0].meta.stack).toBe('string');
    expect(log.entries[0].meta.stack as string).toContain('station-service-error.test');
    expect(log.entries[0].meta.message as string).toContain('station-registration-service.js');
  });

  it('maps ERR_MODULE_NOT_FOUND to a 503 that names a broken build, not a generic 500', () => {
    const log = makeLogger();

    const failure = stationServiceFailureResponse(
      'register weather station',
      moduleNotFoundError(),
      log
    );

    expect(failure.status).toBe(503);
    expect(failure.code).toBe('STATION_BUILD_ARTIFACT_MISSING');
    expect(failure.publicMessage).toContain('missing a required module');
    expect(log.entries[0].msg).toContain('#1042');
  });

  it('maps ERR_UNKNOWN_FILE_EXTENSION to the same diagnosable 503 — an un-emitted .ts in the image is the original #1042 shape', () => {
    const log = makeLogger();
    const tsErr: NodeJS.ErrnoException = new Error(
      'Unknown file extension ".ts" for /app/dist/server/services/station-registration-service.ts'
    );
    tsErr.code = 'ERR_UNKNOWN_FILE_EXTENSION';

    const failure = stationServiceFailureResponse('register weather station', tsErr, log);

    expect(failure.status).toBe(503);
    expect(failure.code).toBe('STATION_BUILD_ARTIFACT_MISSING');
    expect(log.entries[0].meta.code).toBe('ERR_UNKNOWN_FILE_EXTENSION');
    expect(typeof log.entries[0].meta.stack).toBe('string');
  });

  it('maps a SyntaxError from a malformed artifact to a diagnosable 503, not the generic 500', () => {
    const log = makeLogger();
    const parseErr = new SyntaxError('Unexpected end of input');

    const failure = stationServiceFailureResponse('register weather station', parseErr, log);

    expect(failure.status).toBe(503);
    expect(failure.code).toBe('STATION_BUILD_ARTIFACT_INVALID');
    expect(failure.publicMessage).toContain('malformed');
    expect(typeof log.entries[0].meta.stack).toBe('string');
    expect(log.entries[0].msg).toContain('#1042');
  });

  it('maps ordinary handler errors to the pre-existing generic 500 contract, still with code+stack logged', () => {
    const log = makeLogger();
    const dbErr: NodeJS.ErrnoException = new Error('connection refused');
    dbErr.code = 'ECONNREFUSED';

    const failure = stationServiceFailureResponse('register weather station', dbErr, log);

    expect(failure.status).toBe(500);
    expect(failure.code).toBe('WEATHER_ERROR');
    expect(failure.publicMessage).toBe('Failed to register weather station');
    expect(log.entries[0].meta.code).toBe('ECONNREFUSED');
    expect(typeof log.entries[0].meta.stack).toBe('string');
  });

  it('survives non-Error throwables without losing the log entry', () => {
    const log = makeLogger();

    const failure = stationServiceFailureResponse('verify provider key', 'boom', log);

    expect(failure.status).toBe(500);
    expect(log.entries[0].meta.message).toBe('boom');
  });

  it('the real routes actually call the funnel (wiring pin — a mirror test cannot catch a revert)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path');
    const source = readFileSync(
      path.resolve(__dirname, '..', 'server', 'routes', 'weather-routes.js'),
      'utf8'
    );

    const calls = source.match(/stationServiceFailureResponse\(/g) ?? [];
    // boot preload + register + verify-key + credentials
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain("require('../utils/station-service-error')");
    // The old swallow pattern must be gone from the station catches.
    expect(source).not.toContain("logger.error('Error registering weather station'");
    expect(source).not.toContain("logger.error('Error listing station credentials'");
  });
});
