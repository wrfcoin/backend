/**
 * backend#1247 — the console log format read `meta.error` as an Error, so the
 * common `{ error: err.message }` (a string) printed "Unknown:No message".
 */
// eslint-disable-next-line no-restricted-imports -- this IS the unified logger under test; the pattern targets the deprecated utils/logger.js
import { formatErrorDetails } from '../server/utils/logger.js';

describe('formatErrorDetails (backend#1247)', () => {
  it('prints a string error as itself', () => {
    expect(formatErrorDetails('Cannot read properties of undefined (reading \'query\')'))
      .toBe(' [Error: Cannot read properties of undefined (reading \'query\')]');
  });

  it('keeps the existing Error / record rendering', () => {
    expect(formatErrorDetails(new TypeError('boom'))).toBe(' [Error: TypeError:boom]');
    expect(formatErrorDetails({ name: 'DbError', message: 'down', code: 'ECONNREFUSED', category: 'db', severity: 'high' }))
      .toBe(' [Error: DbError:down:ECONNREFUSED:db:high]');
  });

  it('renders nothing for an absent error and stringifies other scalars', () => {
    expect(formatErrorDetails(undefined)).toBe('');
    expect(formatErrorDetails(null)).toBe('');
    expect(formatErrorDetails('')).toBe('');
    expect(formatErrorDetails(503)).toBe(' [Error: 503]');
  });
});
