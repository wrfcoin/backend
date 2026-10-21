import { describe, expect, it } from '@jest/globals';

import { generateRaspRequestId } from '../src/middleware/rasp';

describe('generateRaspRequestId', () => {
  it('uses a cryptographically strong UUID-based identifier', () => {
    const requestId = generateRaspRequestId();

    expect(requestId).toMatch(
      /^rasp_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('returns unique identifiers across calls', () => {
    const ids = new Set(
      Array.from({ length: 32 }, () => generateRaspRequestId())
    );

    expect(ids.size).toBe(32);
  });
});
