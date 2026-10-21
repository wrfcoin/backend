import { describe, expect, it, jest } from '@jest/globals';
import { SecureTimeSync } from '../../../shared/time-sync-security.js';

jest.mock('../../utils/logger.js', () => ({
  securityLogger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

type MutableSource = {
  id: string;
  url: string;
  publicKey?: string;
  priority: number;
  lastSync: Date | null;
  lastOffset: number;
  reliability: number;
  consecutiveFailures: number;
};

function buildSource(id: string, authenticated: boolean): MutableSource {
  return {
    id,
    url: `${id}.example.test`,
    publicKey: authenticated
      ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      : undefined,
    priority: 10,
    lastSync: null,
    lastOffset: 0,
    reliability: 1,
    consecutiveFailures: 0,
  };
}

describe('SecureTimeSync NTS authentication', () => {
  it('authenticates NTS evidence and rejects replayed packets', async () => {
    const sync = new SecureTimeSync() as any;
    sync.stop();
    sync.timeSources = new Map([[ 'auth-1', buildSource('auth-1', true) ]]);
    sync.MIN_SOURCES = 1;
    sync.minAuthenticatedSources = 1;
    sync.requireAuthenticatedTime = true;

    const source = sync.timeSources.get('auth-1');
    const queryResult = await sync.performNTPQuery(source);

    await expect(sync.verifyNTSAuthentication(source, queryResult)).resolves.toBe(
      true
    );
    await expect(sync.verifyNTSAuthentication(source, queryResult)).resolves.toBe(
      false
    );
  });

  it('rejects tampered authenticated payloads (MITM simulation)', async () => {
    const sync = new SecureTimeSync() as any;
    sync.stop();
    sync.timeSources = new Map([[ 'auth-2', buildSource('auth-2', true) ]]);
    sync.MIN_SOURCES = 1;
    sync.minAuthenticatedSources = 1;
    sync.requireAuthenticatedTime = true;

    const source = sync.timeSources.get('auth-2');
    const queryResult = await sync.performNTPQuery(source);
    queryResult.ntsEvidence.ciphertext[queryResult.ntsEvidence.ciphertext.length - 1] ^= 0x01;

    await expect(sync.verifyNTSAuthentication(source, queryResult)).resolves.toBe(
      false
    );
  });

  it('fails closed when authenticated sources are unavailable', async () => {
    const sync = new SecureTimeSync() as any;
    sync.stop();
    sync.timeSources = new Map([[ 'plain-1', buildSource('plain-1', false) ]]);
    sync.MIN_SOURCES = 1;
    sync.minAuthenticatedSources = 1;
    sync.requireAuthenticatedTime = true;
    sync.allowBoundedDegradedMode = false;

    await expect(sync.syncTime()).rejects.toThrow(
      /Authenticated sources below threshold/
    );
  });

  it('supports bounded degraded mode after recent authenticated sync', async () => {
    const sync = new SecureTimeSync() as any;
    sync.stop();
    sync.MIN_SOURCES = 1;
    sync.minAuthenticatedSources = 1;
    sync.requireAuthenticatedTime = true;
    sync.allowBoundedDegradedMode = true;
    sync.maxDegradedDurationMs = 60000;

    sync.timeSources = new Map([[ 'auth-3', buildSource('auth-3', true) ]]);
    const authenticatedSync = await sync.syncTime();
    expect(authenticatedSync.isAuthenticated).toBe(true);

    sync.timeSources = new Map([[ 'plain-2', buildSource('plain-2', false) ]]);
    const degradedSync = await sync.syncTime();
    expect(degradedSync.isAuthenticated).toBe(false);
    expect(degradedSync.degradedMode).toBe(true);
  });
});
