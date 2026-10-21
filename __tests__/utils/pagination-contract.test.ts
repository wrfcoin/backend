/**
 * Contract tests for parseListPagination / paginatedResponse (#903, #909).
 *
 * These helpers had **zero tests** while 13 list endpoints across four route
 * files were rewritten to depend on them. They decide what every paginated
 * endpoint returns, so a silent change here is a silent change to the whole
 * public list API.
 *
 * `parseListPagination` is duplicated — `server/utils/api-error.js` (CJS, used
 * by the `.js` route files) and `server/utils/api-error.ts` (ESM, used by
 * `governance-routes.ts`). Two copies of a contract drift, so the last block
 * asserts they agree on identical input rather than trusting that whoever edits
 * one remembers the other.
 */

import { describe, it, expect } from '@jest/globals';
import path from 'path';

/**
 * Load each copy by ABSOLUTE path.
 *
 * A relative `require('../../server/utils/api-error')` does **not** reach the
 * `.js` file: `moduleFileExtensions` lists `ts` before `js`, and
 * `moduleNameMapper` rewrites `'^(\.{1,2}/.*)\.js$' -> '$1'`, so even an
 * explicit `.js` suffix is stripped and resolves to `api-error.ts`. Requiring
 * "both" copies relatively therefore loads the SAME module twice and any parity
 * assertion passes vacuously — caught here by a RED control that failed to go
 * red when `?page=` support was deleted from the `.js` copy.
 *
 * An absolute path does not match the mapper's `^\.{1,2}/` anchor, so it is the
 * only way this suite can see the CommonJS file at all. That matters: plain
 * Node (which is what actually serves `oracle-routes.js` and `iotex.js` in
 * production) resolves `require('../utils/api-error')` to the `.js` copy, so
 * without this the file running in production would be untested.
 */
const UTILS_DIR = path.resolve(__dirname, '../../server/utils');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cjs = require(path.join(UTILS_DIR, 'api-error.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const esm = require(path.join(UTILS_DIR, 'api-error.ts'));

const { parseListPagination, paginatedResponse } = cjs;

describe('parseListPagination — defaults and bounds', () => {
  it('defaults to limit 50, offset 0, page 1', () => {
    expect(parseListPagination({})).toEqual({ limit: 50, offset: 0, page: 1 });
  });

  it('honours a caller-supplied defaultLimit', () => {
    expect(parseListPagination({}, { defaultLimit: 25 })).toMatchObject({ limit: 25 });
  });

  it('caps limit at maxLimit so a client cannot request an unbounded scan', () => {
    expect(parseListPagination({ limit: '10000' }, { maxLimit: 200 }).limit).toBe(200);
  });

  it('clamps a zero or negative limit up to 1 rather than emitting limit 0', () => {
    // limit 0 would make totalPages divide by zero and return every row.
    expect(parseListPagination({ limit: '0' }).limit).toBe(1);
    expect(parseListPagination({ limit: '-5' }).limit).toBe(1);
  });

  it('clamps a negative offset to 0', () => {
    expect(parseListPagination({ offset: '-10' }).offset).toBe(0);
  });

  it('falls back to defaults for non-numeric input rather than emitting NaN', () => {
    // NaN would reach SQL LIMIT/OFFSET and throw at the driver.
    const parsed = parseListPagination({ limit: 'abc', offset: 'xyz' });
    expect(parsed).toEqual({ limit: 50, offset: 0, page: 1 });
    expect(Number.isNaN(parsed.limit)).toBe(false);
    expect(Number.isNaN(parsed.offset)).toBe(false);
  });

  it('floors fractional input', () => {
    expect(parseListPagination({ limit: 10.9, offset: 20.9 })).toMatchObject({
      limit: 10,
      offset: 20,
    });
  });

  it('accepts numbers as well as strings', () => {
    expect(parseListPagination({ limit: 10, offset: 30 })).toEqual({
      limit: 10,
      offset: 30,
      page: 4,
    });
  });
});

describe('parseListPagination — ?page= support (#909)', () => {
  // Before this, paginatedResponse advertised `page`/`hasNext`/`hasPrev` but no
  // endpoint read `?page=`, so a client following `page: 2` re-fetched page 1.
  it('translates ?page= into an offset', () => {
    expect(parseListPagination({ page: '2', limit: '10' })).toEqual({
      limit: 10,
      offset: 10,
      page: 2,
    });
  });

  it('round-trips: the page it reports is the page that was asked for', () => {
    for (const requested of [1, 2, 3, 7, 50]) {
      const parsed = parseListPagination({ page: String(requested), limit: '20' });
      expect(parsed.page).toBe(requested);
    }
  });

  it('lets an explicit offset win over page, preserving the older contract', () => {
    expect(parseListPagination({ page: '5', offset: '0', limit: '10' })).toMatchObject({
      offset: 0,
      page: 1,
    });
  });

  it('ignores page values below 1 instead of producing a negative offset', () => {
    // (0 - 1) * limit would be a negative OFFSET — a SQL error.
    for (const bad of ['0', '-3', 'abc']) {
      expect(parseListPagination({ page: bad, limit: '10' }).offset).toBe(0);
    }
  });
});

describe('paginatedResponse', () => {
  it('wraps the page in the canonical envelope', () => {
    expect(paginatedResponse([{ id: 1 }], 1, 1, 50)).toEqual({
      success: true,
      data: [{ id: 1 }],
      pagination: {
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    });
  });

  it('computes hasNext/hasPrev consistently with totalPages', () => {
    const middle = paginatedResponse([], 25, 2, 10).pagination;
    expect(middle).toMatchObject({ totalPages: 3, hasNext: true, hasPrev: true });

    const last = paginatedResponse([], 25, 3, 10).pagination;
    expect(last).toMatchObject({ hasNext: false, hasPrev: true });
  });

  it('reports a single page and no next when there are no rows', () => {
    // total 0 must not advertise hasNext, or a client paginates forever.
    expect(paginatedResponse([], 0, 1, 50).pagination).toMatchObject({
      totalPages: 0,
      hasNext: false,
      hasPrev: false,
    });
  });

  it('composes with parseListPagination so the reported page is the parsed page', () => {
    const { limit, page } = parseListPagination({ page: '3', limit: '10' });
    expect(paginatedResponse([], 100, page, limit).pagination).toMatchObject({
      page: 3,
      hasPrev: true,
      hasNext: true,
    });
  });
});

describe('CJS and ESM copies agree (they are duplicated implementations)', () => {
  const CASES: Array<Record<string, unknown>> = [
    {},
    { limit: '10' },
    { limit: '10', offset: '30' },
    { limit: '10000' },
    { limit: '0' },
    { offset: '-10' },
    { limit: 'abc', offset: 'xyz' },
    { page: '2', limit: '10' },
    { page: '0', limit: '10' },
    { page: '5', offset: '0', limit: '10' },
    { limit: 10.9, offset: 20.9 },
  ];

  it.each(CASES)('parseListPagination(%j) matches across both copies', (query) => {
    expect(esm.parseListPagination(query as Record<string, unknown>)).toEqual(
      parseListPagination(query),
    );
  });
});
