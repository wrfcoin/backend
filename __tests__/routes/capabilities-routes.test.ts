import express from 'express';
import request from 'supertest';
import {
  createCapabilitiesRouter,
  type CapabilitiesResponse,
  type BuildStampResponse,
  type CapabilityObservation,
  type FeatureStatus,
} from '../../server/routes/capabilities-routes.js';

const EXPECTED_FEATURE_KEYS = [
  'earningsRead', 'networkNodesRead', 'forecastersRead', 'calibrationCertificates',
  'wallet', 'wallet.history', 'explorer', 'pop', 'mining', 'weather', 'governance', 'nfts',
  'settings', 'resources', 'crossChain', 'carbon', 'aiIntegration', 'privacy',
  'defi', 'staking', 'sharding', 'iot', 'messaging', 'storage', 'cortex',
  'standards', 'developer', 'analytics', 'integrations', 'infrastructure',
  'smartContracts', 'mobile', 'gamification', 'incentives', 'system',
  'oracle', 'partners', 'achievements', 'identity', 'feeMarket',
  'liquidStaking', 'fleet', 'forecast', 'explorerMap', 'pipelines',
  'aiMarketplace', 'carbonReporting', 'collaboration', 'computeMarketplace',
  'community', 'forecastStudio', 'notifications', 'leaderboard',
  'governanceAdvanced', 'realTime', 'pwa', 'validatorOps', 'networkInsights',
  'stationAnalytics', 'weatherIntelligence', 'bridgeAdvanced', 'fieldTools',
  'advancedOnboarding', 'zkVerification', 'executionDebugger',
  'accessibilityHub', 'i18n', 'exportManager', 'weatherGlobe', 'referrals',
  'impact', 'leaderboardRegions',
  // backend#1178: deferred growth-cluster records (not features.ts keys).
  'duels', 'challenges', 'competitions', 'proofCards', 'marketplace',
  'academic', 'subscription', 'webhooks', 'telemetry', 'contributorSummary',
  // Owner demo queue 2026-11-01 item 7: forecasts checked against station readings.
  'forecastVerification',
];

const VALID_STATUSES: FeatureStatus[] = [
  'configured',
  'reachable',
  'degraded',
  'operational',
  'simulated',
  'unavailable',
];
const NOW = new Date('2026-09-17T20:00:00.000Z');

describe('GET /api/build', () => {
  const originalRevision = process.env.WRFCOIN_BUILD_REVISION;
  const originalCreated = process.env.WRFCOIN_BUILD_CREATED;

  afterEach(() => {
    if (originalRevision === undefined) delete process.env.WRFCOIN_BUILD_REVISION;
    else process.env.WRFCOIN_BUILD_REVISION = originalRevision;
    if (originalCreated === undefined) delete process.env.WRFCOIN_BUILD_CREATED;
    else process.env.WRFCOIN_BUILD_CREATED = originalCreated;
  });

  it('returns the immutable build revision and creation timestamp', async () => {
    process.env.WRFCOIN_BUILD_REVISION = '0123456789abcdef0123456789abcdef01234567';
    process.env.WRFCOIN_BUILD_CREATED = '2026-09-20T18:30:00Z';
    const app = express();
    app.use('/api', createCapabilitiesRouter());

    const response = await request(app).get('/api/build').expect(200);
    expect(response.body as BuildStampResponse).toEqual({
      available: true,
      revision: '0123456789abcdef0123456789abcdef01234567',
      created: '2026-09-20T18:30:00.000Z',
      source: 'oci-build-args',
    });
  });

  it('fails closed when build metadata is missing or malformed', async () => {
    delete process.env.WRFCOIN_BUILD_REVISION;
    process.env.WRFCOIN_BUILD_CREATED = 'not-a-timestamp';
    const app = express();
    app.use('/api', createCapabilitiesRouter());

    const response = await request(app).get('/api/build').expect(503);
    expect(response.body).toMatchObject({
      available: false,
      error: { code: 'BUILD_METADATA_UNAVAILABLE' },
    });
  });
});

function observation(
  capabilityId: string,
  overrides: Partial<CapabilityObservation> = {},
): CapabilityObservation {
  return {
    capabilityId,
    evidenceClass: 'operational',
    observedAt: '2026-09-17T19:59:30.000Z',
    source: 'bounded-functional-fixture',
    detail: 'Semantic dependency response matched the production contract',
    functional: true,
    proof: {
      kind: 'semantic',
      assertion: 'dependency state is healthy and payload contract matched',
    },
    ...overrides,
  };
}

async function getCapabilities(
  evidence: Record<string, CapabilityObservation> = {},
  maxEvidenceAgeMs = 60_000,
): Promise<CapabilitiesResponse> {
  const app = express();
  app.use('/api', createCapabilitiesRouter({
    evidenceProvider: async () => evidence,
    maxEvidenceAgeMs,
    clock: () => NOW,
  }));
  const response = await request(app).get('/api/capabilities').expect(200);
  return response.body as CapabilitiesResponse;
}

describe('GET /api/capabilities', () => {
  it('returns the complete contract without inventing fresh observations', async () => {
    const body = await getCapabilities();

    expect(body).not.toHaveProperty('version');
    expect(body).not.toHaveProperty('buildProfile');
    expect(body.timestamp).toBe(NOW.toISOString());
    expect(Object.keys(body.features).sort()).toEqual(
      [...EXPECTED_FEATURE_KEYS].sort(),
    );
    expect(body.publicReleaseReadiness).toMatchObject({
      pass: false,
      classification: 'NON_RELEASE',
    });

    for (const entry of Object.values(body.features)) {
      expect(VALID_STATUSES).toContain(entry.status);
      expect(['unverified', 'not_wired', 'simulated']).toContain(entry.reasonCode);
      expect(entry.status).not.toBe('operational');
    }
  });

  it('accepts only fresh semantic functional proof as operational', async () => {
    const body = await getCapabilities({ wallet: observation('wallet') });

    expect(body.features.wallet).toEqual({ status: 'operational', reasonCode: 'ok' });
  });

  it('does not promote a mounted or HTTP-200-only route', async () => {
    const body = await getCapabilities({
      governance: observation('governance', {
        evidenceClass: 'reachable',
        detail: 'HTTP 200 received; database semantics were not checked',
        functional: false,
        proof: undefined,
      }),
    });

    expect(body.features.governance).toEqual({ status: 'reachable', reasonCode: 'reachable' });
    expect(body.publicReleaseReadiness.pass).toBe(false);
  });

  it('rejects an operational label without semantic functional proof', async () => {
    const body = await getCapabilities({
      weather: observation('weather', {
        functional: false,
        proof: undefined,
        detail: 'Route was present',
      }),
    });

    expect(body.features.weather).toEqual({ status: 'degraded', reasonCode: 'proof_missing' });
  });

  it('fails closed when a dependency is down despite route presence', async () => {
    const body = await getCapabilities({
      governance: observation('governance', {
        evidenceClass: 'unavailable',
        detail: 'Route answered but governance database dependency was down',
        functional: false,
        proof: undefined,
      }),
    });

    expect(body.features.governance).toEqual({ status: 'unavailable', reasonCode: 'unavailable' });
    expect(body.publicReleaseReadiness.failures).toContainEqual({
      capabilityId: 'governance',
      reasonCode: 'unavailable',
    });
  });

  it('makes stale operational evidence unavailable and release-failing', async () => {
    const body = await getCapabilities({
      explorer: observation('explorer', {
        observedAt: '2026-09-17T19:50:00.000Z',
      }),
    });

    expect(body.features.explorer).toEqual({ status: 'unavailable', reasonCode: 'evidence_stale' });
    expect(body.publicReleaseReadiness.pass).toBe(false);
  });

  it('preserves explicit simulated classification without release promotion', async () => {
    const body = await getCapabilities({
      mining: observation('mining', {
        evidenceClass: 'simulated',
        detail: 'Explicit developer fixture produced the response',
        functional: false,
        proof: undefined,
      }),
    });

    expect(body.features.mining).toEqual({ status: 'simulated', reasonCode: 'simulated' });
    expect(body.publicReleaseReadiness.pass).toBe(false);
  });

  it('reports wallet.history unavailable without evidence and never release-required (backend#1167)', async () => {
    const body = await getCapabilities();

    expect(body.features['wallet.history']).toEqual({ status: 'unavailable', reasonCode: 'not_wired' });
    expect(body.publicReleaseReadiness.requiredCapabilities).not.toContain('wallet.history');
  });

  it('reports wallet.history as degraded (partial, window-limited) when core4 is observed serving it', async () => {
    const body = await getCapabilities({
      'wallet.history': observation('wallet.history', {
        evidenceClass: 'degraded',
        detail: 'core4 /addresses/{address}/transactions answered; history is window-limited',
        functional: true,
        proof: undefined,
      }),
    });

    expect(body.features['wallet.history']).toEqual({ status: 'degraded', reasonCode: 'degraded' });
  });

  it('bounds a stalled evidence provider and fails closed', async () => {
    const app = express();
    app.use('/api', createCapabilitiesRouter({
      evidenceProvider: () => new Promise(() => {}),
      probeTimeoutMs: 5,
      clock: () => NOW,
    }));

    const response = await request(app).get('/api/capabilities').expect(200);
    const body = response.body as CapabilitiesResponse;
    expect(body.features.wallet).toEqual({ status: 'configured', reasonCode: 'provider_failed' });
    expect(body.publicReleaseReadiness.pass).toBe(false);
  });

  it('reuses the shared readiness shape without static operational claims', async () => {
    const body = await getCapabilities({ pop: observation('pop') });

    expect(body.readiness.pop).toMatchObject({
      capabilityId: 'pop',
      mode: 'production-verified',
      reason: 'ok',
      reasonCode: 'ok',
      updatedAt: NOW.toISOString(),
      signals: {},
    });
    expect(body.readiness['bridge.transfer']).toBeUndefined();
    expect(body.readiness['bridge.verification']).toBeUndefined();
  });
});

/**
 * Public disclosure boundary (infra#1046 owner decision, 2026-09-26).
 *
 * /api/capabilities is served to anonymous internet clients through the public
 * edge. Every string it returns must come from a fixed vocabulary: feature ids,
 * the status enum, the reason-code allowlist, the readiness-mode enum, the
 * release classification, or an ISO timestamp. No file names, route prefixes,
 * env var names, env values, topology hints, or provider error text.
 */
describe('GET /api/capabilities public disclosure boundary', () => {
  const PUBLIC_REASON_CODES = [
    'ok',
    'not_wired',
    'unverified',
    'simulated',
    'reachable',
    'degraded',
    'unavailable',
    'proof_missing',
    'evidence_stale',
    'evidence_invalid',
    'provider_failed',
  ];
  const READINESS_MODES = ['unavailable', 'simulated', 'local-manager', 'production-verified', 'degraded'];
  const CLASSIFICATIONS = ['PUBLIC_RELEASE', 'NON_RELEASE'];
  const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const ALLOWED_STRINGS = new Set<string>([
    ...EXPECTED_FEATURE_KEYS,
    ...VALID_STATUSES,
    ...PUBLIC_REASON_CODES,
    ...READINESS_MODES,
    ...CLASSIFICATIONS,
  ]);

  // Internal detail a wired evidence provider could plausibly carry.
  const INTERNAL_URL = 'http://10.0.3.17:4003/internal/health';
  const leakyEvidence: Record<string, CapabilityObservation> = {
    wallet: observation('wallet', {
      source: 'wallet-routes.js probe via WRFCOIN_READER_TOKEN',
      detail: `GET ${INTERNAL_URL} answered from /api/node-control`,
    }),
    governance: observation('governance', {
      evidenceClass: 'unavailable',
      source: 'governance-routes.ts',
      detail: 'connect ECONNREFUSED 10.0.3.17:5432',
      functional: false,
      proof: undefined,
    }),
    // Provider-controlled class that is not in the enum must not be echoed.
    mining: observation('mining', {
      evidenceClass: 'Operational: see /api/mining (mining-routes.js)' as never,
    }),
  };

  function collectStrings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        out.push(key);
        collectStrings(item, out);
      }
    }
    return out;
  }

  const FORBIDDEN = [
    /\.(?:[cm]?[jt]sx?)\b/i, // file names (wallet-routes.js, CapabilitiesContext.tsx)
    /\/api\//, // mounted route prefixes (/api/node-os, /api/node-control, /api/chain)
    /\b(?:WRFCOIN|DEFI|NODE|DATABASE|REDIS|JWT)_[A-Z0-9_]+\b/, // env var names
    /ECONNREFUSED|\b10\.\d+\.\d+\.\d+|https?:\/\//, // provider error text / internal URLs
    /unmounted|not mounted|infra's|profile|microservice/i, // unmounted-route inventory, topology hints
    /backend#|core4#|infra#|mobile#/, // cross-repo issue references
  ];

  function assertMinimal(body: unknown) {
    const serialized = JSON.stringify(body);
    for (const pattern of FORBIDDEN) {
      expect({ pattern: String(pattern), match: serialized.match(pattern)?.[0] ?? null })
        .toEqual({ pattern: String(pattern), match: null });
    }
    const response = body as Record<string, unknown>;
    const structuralKeys = new Set([
      'features', 'readiness', 'publicReleaseReadiness', 'timestamp',
      'status', 'reasonCode', 'capabilityId', 'mode', 'reason', 'updatedAt', 'signals',
      'pass', 'classification', 'requiredCapabilities', 'failures',
    ]);
    const unexpected = collectStrings(response).filter(
      (text) => !ALLOWED_STRINGS.has(text) && !structuralKeys.has(text) && !ISO_TIMESTAMP.test(text),
    );
    expect(unexpected).toEqual([]);
  }

  async function publicBody(
    evidenceProvider: () => Promise<Record<string, CapabilityObservation>>,
  ): Promise<Record<string, any>> {
    const app = express();
    app.use('/api', createCapabilitiesRouter({ evidenceProvider, clock: () => NOW }));
    const response = await request(app).get('/api/capabilities').expect(200);
    return response.body;
  }

  it('returns only feature id, status enum and allowlisted reason code per feature', async () => {
    const body = await publicBody(async () => ({}));

    expect(Object.keys(body).sort()).toEqual(
      ['features', 'publicReleaseReadiness', 'readiness', 'timestamp'],
    );
    expect(Object.keys(body.features).sort()).toEqual([...EXPECTED_FEATURE_KEYS].sort());
    for (const entry of Object.values(body.features) as Array<Record<string, unknown>>) {
      expect(Object.keys(entry).sort()).toEqual(['reasonCode', 'status']);
      expect(VALID_STATUSES).toContain(entry.status);
      expect(PUBLIC_REASON_CODES).toContain(entry.reasonCode);
    }
    assertMinimal(body);
  });

  it('never echoes provider observation text, sources or unknown classes', async () => {
    const body = await publicBody(async () => leakyEvidence);

    expect(body.features.wallet).toEqual({ status: 'operational', reasonCode: 'ok' });
    expect(body.features.governance).toEqual({ status: 'unavailable', reasonCode: 'unavailable' });
    expect(body.features.mining).toEqual({ status: 'unavailable', reasonCode: 'evidence_invalid' });
    assertMinimal(body);
  });

  it('maps provider failures to a fixed code, never the error text', async () => {
    const body = await publicBody(async () => {
      throw new Error(`fetch failed: connect ECONNREFUSED ${INTERNAL_URL} (WRFCOIN_READER_TOKEN)`);
    });

    expect(body.features.wallet).toEqual({ status: 'configured', reasonCode: 'provider_failed' });
    expect(body.features.carbon).toEqual({ status: 'unavailable', reasonCode: 'provider_failed' });
    assertMinimal(body);
  });

  it('does not disclose env var names or values from the mounted default router', async () => {
    const originalDefi = process.env.DEFI_NODE_URL;
    const originalProfile = process.env.WRFCOIN_BUILD_PROFILE;
    try {
      for (const defi of [undefined, 'http://defi-node:7100']) {
        jest.resetModules();
        if (defi === undefined) delete process.env.DEFI_NODE_URL;
        else process.env.DEFI_NODE_URL = defi;
        process.env.WRFCOIN_BUILD_PROFILE = 'internal-profile-marker';
        const mod = await import('../../server/routes/capabilities-routes.js');
        const response = await request(express().use('/api', mod.default))
          .get('/api/capabilities')
          .expect(200);
        expect(JSON.stringify(response.body)).not.toContain('internal-profile-marker');
        expect(response.body.version).toBeUndefined();
        expect(response.body.buildProfile).toBeUndefined();
        assertMinimal(response.body);
      }
    } finally {
      if (originalDefi === undefined) delete process.env.DEFI_NODE_URL;
      else process.env.DEFI_NODE_URL = originalDefi;
      if (originalProfile === undefined) delete process.env.WRFCOIN_BUILD_PROFILE;
      else process.env.WRFCOIN_BUILD_PROFILE = originalProfile;
    }
  });
});

/**
 * Handler robustness (backend#1225 follow-up). Express 4 does not catch a
 * rejected async handler: the request hangs and the unhandled rejection can
 * crash Node. Malformed provider output must degrade to fixed codes, and any
 * other failure must return a fixed 500 body without error text.
 */
describe('GET /api/capabilities malformed provider output', () => {
  function appWith(options: Parameters<typeof createCapabilitiesRouter>[0]) {
    const app = express();
    app.use('/api', createCapabilitiesRouter({ clock: () => NOW, ...options }));
    return app;
  }

  it('treats a provider resolving null as provider_failed', async () => {
    const response = await request(appWith({ evidenceProvider: async () => null as never }))
      .get('/api/capabilities')
      .timeout(2_000)
      .expect(200);
    expect(response.body.features.wallet).toEqual({ status: 'configured', reasonCode: 'provider_failed' });
    expect(response.body.features.carbon).toEqual({ status: 'unavailable', reasonCode: 'provider_failed' });
  });

  it('treats a provider resolving a non-object as provider_failed', async () => {
    const response = await request(appWith({ evidenceProvider: async () => 'oops' as never }))
      .get('/api/capabilities')
      .timeout(2_000)
      .expect(200);
    expect(response.body.features.wallet).toEqual({ status: 'configured', reasonCode: 'provider_failed' });
  });

  it('classifies observations with non-string fields as evidence_invalid', async () => {
    const response = await request(appWith({
      evidenceProvider: async () => ({
        wallet: observation('wallet', { source: 42 as never }),
        governance: observation('governance', { detail: null as never }),
        weather: observation('weather', { proof: { kind: 'semantic', assertion: {} as never } }),
        explorer: observation('explorer', { observedAt: 7 as never }),
        mining: null as never,
      }),
    }))
      .get('/api/capabilities')
      .timeout(2_000)
      .expect(200);
    const invalid = { status: 'unavailable', reasonCode: 'evidence_invalid' };
    expect(response.body.features.wallet).toEqual(invalid);
    expect(response.body.features.governance).toEqual(invalid);
    expect(response.body.features.weather).toEqual(invalid);
    expect(response.body.features.explorer).toEqual(invalid);
    // A null entry is no observation at all, not a crash.
    expect(response.body.features.mining).toEqual({ status: 'configured', reasonCode: 'unverified' });
  });

  it('returns a fixed 500 body, never error text, when evaluation throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(appWith({
        clock: () => {
          throw new Error('boom at http://10.0.3.17:4003 (capabilities-routes.ts)');
        },
      }))
        .get('/api/capabilities')
        .timeout(2_000)
        .expect(500);
      expect(response.body).toEqual({
        error: { code: 'CAPABILITIES_UNAVAILABLE', reasonCode: 'provider_failed' },
      });
      expect(JSON.stringify(response.body)).not.toMatch(/boom|10\.0\.3\.17|\.ts/);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
