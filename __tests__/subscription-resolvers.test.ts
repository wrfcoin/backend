import { matchesBridgeLockFilter } from '../graphql/resolvers/subscription-resolvers.js';

describe('matchesBridgeLockFilter', () => {
  it('returns false instead of throwing when the payload has no bridge field', () => {
    expect(
      matchesBridgeLockFilter({ bridgeLockDetected: { txId: 'tx-1' } }, { bridge: '0xabc' }),
    ).toBe(false);
  });

  it('matches case-insensitively when a bridge address is present', () => {
    expect(
      matchesBridgeLockFilter(
        { bridgeLockDetected: { bridge: '0xABCDEFabcdef' } },
        { bridge: '0xabcdefABCDEF' },
      ),
    ).toBe(true);
  });
});
