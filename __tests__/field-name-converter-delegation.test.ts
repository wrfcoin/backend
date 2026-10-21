/**
 * backend#992 — `fieldNameConverter` must actually convert, not just export.
 *
 * The defect this pins: `utils/fieldNameConverter.ts` delegated to
 * `fieldConverter.snakeToCamel` / `.camelToSnake`, which `./fieldConverter.js`
 * does not export (it exports `dbToApp` / `appToDb`). Both wrapper functions
 * threw `TypeError: ... is not a function` on **every** call.
 *
 * Why this went unnoticed, and what that means for the shape of this test:
 * the wrapper's exports were present, correctly named and correctly typed, so
 * `tsc` passed and any "is snakeToCamel exported?" assertion passed too. The
 * module was only broken when *called*. So asserting on the module's surface
 * proves nothing here — these tests call it and assert on the returned value.
 *
 * 12 modules import this converter, including five suites quarantined under
 * #873/#992 (`audit-service`, `audit-monitoring-service`, `file-integrity-
 * service`, `file-permission-service`, `integrity-monitoring-service`).
 *
 * RED control (delegation reverted, nothing else changed): **4 of the 5 tests
 * below fail, and all four fail with `TypeError: ... is not a function`** —
 * not with an assertion mismatch, which is the point: the module did not
 * compute a wrong answer, it could not be called at all.
 *
 * The fifth (`preserves the documented null passthrough`) passes in both
 * directions by design: the `if (!dbObject) return null` guard short-circuits
 * before the delegation, so it cannot detect this defect. It is here to keep
 * the guard from being dropped by a future refactor, not as evidence.
 *
 * What this does NOT pin:
 *   - the *content* of the field mapping in `fieldConverter.js` (the special-
 *     case table). It pins that the delegation resolves and round-trips, which
 *     is the defect that occurred.
 *   - the sibling `utils/fieldNameConverter.js`, a different module whose
 *     `snakeToCamel` takes a string. Nothing here should be read as a claim
 *     about it; the duplicate-basename drift is called out in #992.
 */
import { describe, expect, it } from '@jest/globals';
import fieldNameConverter, { camelToSnake, snakeToCamel } from '../utils/fieldNameConverter.js';

describe('fieldNameConverter delegation (#992)', () => {
  it('snakeToCamel converts a db row instead of throwing', () => {
    const converted = snakeToCamel({ file_id: 'abc', user_id: 7 }) as Record<string, unknown>;

    expect(converted).toBeTruthy();
    expect(converted.fileId).toBe('abc');
    expect(converted.userId).toBe(7);
  });

  it('camelToSnake converts an app object instead of throwing', () => {
    const converted = camelToSnake({ fileId: 'abc', userId: 7 }) as Record<string, unknown>;

    expect(converted).toBeTruthy();
    expect(converted.file_id).toBe('abc');
    expect(converted.user_id).toBe(7);
  });

  it('round-trips a db row back to the same db shape', () => {
    const original = { file_id: 'abc', user_id: 7 };
    const roundTripped = camelToSnake(snakeToCamel(original)) as Record<string, unknown>;

    expect(roundTripped.file_id).toBe('abc');
    expect(roundTripped.user_id).toBe(7);
  });

  it('the default export is callable, not merely present', () => {
    // The pre-fix module passed a `typeof === "function"` check and still threw
    // on call, so presence is asserted by *calling* it.
    expect(typeof fieldNameConverter.snakeToCamel).toBe('function');
    expect(() => fieldNameConverter.snakeToCamel({ file_id: 'abc' })).not.toThrow();
  });

  it('preserves the documented null passthrough', () => {
    expect(snakeToCamel(null as never)).toBeNull();
    expect(camelToSnake(null as never)).toBeNull();
  });
});
