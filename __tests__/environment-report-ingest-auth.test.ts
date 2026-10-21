/**
 * #846 — the environment-report ingest endpoints must not accept unauthenticated
 * writes.
 *
 * This asserts the behaviour, not the source text. The previous incarnation of
 * this test read `enhanced_unified_api_optimized.ts` and regex-matched for the
 * guard, which proves a string is present and cannot observe whether a request
 * is actually refused.
 *
 * `requireAuthenticatedRequest` treats "authenticateJWT called next()" as
 * authorized, so the whole guarantee rests on authenticateJWT never calling
 * next() for an unauthenticated caller. That is what is pinned here.
 */
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'test-only-jwt-secret-at-least-32-characters-long';

import { describe, expect, it } from '@jest/globals';
import { authenticateJWT } from '../server/middleware/auth.js';

function makeReq(headers: Record<string, string> = {}) {
  const req: any = {
    headers,
    method: 'POST',
    url: '/api/environment/reports/soil/ingest',
  };
  req.get = (name: string) => headers[name.toLowerCase()];
  return req;
}

function makeRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: any) => { res.body = payload; return res; };
  res.setHeader = () => res;
  res.end = () => res;
  return res;
}

async function admits(headers: Record<string, string>): Promise<boolean> {
  let nextCalled = false;
  await authenticateJWT(makeReq(headers) as any, makeRes() as any, () => {
    nextCalled = true;
  });
  return nextCalled;
}

describe('#846 environment report ingest auth', () => {
  it('refuses a request with no Authorization header', async () => {
    await expect(admits({})).resolves.toBe(false);
  });

  it('refuses a syntactically present but unverifiable bearer token', async () => {
    await expect(admits({ authorization: 'Bearer not-a-real-jwt' })).resolves.toBe(false);
  });

  it('refuses an empty bearer token', async () => {
    await expect(admits({ authorization: 'Bearer ' })).resolves.toBe(false);
  });
});
