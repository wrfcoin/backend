import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('CORS hardening helpers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  // backend#1236: production refuses (throws) rather than returning an empty
  // or built-in allowlist.
  const PROD_EMPTY = {
    nodeEnv: 'production',
    allowedOriginsEnv: '',
    corsOriginEnv: '',
    corsAllowedOriginsEnv: '',
    corsOriginsEnv: '',
  };

  it('fails closed in production when no origins are configured', () => {
    const {
      resolveAllowedOrigins,
      CorsConfigurationError,
    } = require('../server/utils/strict-cors-config');

    expect(() => resolveAllowedOrigins({ ...PROD_EMPTY, requireExplicitOriginsInProduction: true }))
      .toThrow(CorsConfigurationError);
    // Built-in defaults are never a production fallback.
    expect(() => resolveAllowedOrigins({ ...PROD_EMPTY, developmentDefaults: ['https://wrfcoin.app'] }))
      .toThrow(/CORS_ORIGIN is empty/);
  });

  it.each([
    'http://localhost:5000',
    'https://app.localhost',
    'http://127.0.0.1:3000',
    'http://127.1.2.3:80',
    'http://0.0.0.0:5000',
    'http://[::1]:3000',
    '*',
    'https://ok.example,http://localhost:8080',
    'https://ok.example/path',
  ])('refuses production CORS_ORIGIN=%s', value => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { resolveAllowedOrigins } = require('../server/utils/strict-cors-config');

    expect(() => resolveAllowedOrigins({ ...PROD_EMPTY, corsOriginEnv: value }))
      .toThrow(/Refusing to start with NODE_ENV=production/);
  });

  // backend#1236 (codex round 9): the production policy is a port of infra
  // PR#1060's testnet/scripts/cors_origin_policy.py. Every corpus verdict was
  // produced by the Python policy; the backend must agree entry for entry,
  // through the real resolveAllowedOrigins path.
  describe('matches the infra#1060 origin policy (Python-generated corpus)', () => {
    const corpus = require('./fixtures/cors-origin-policy-corpus.json');
    it.each(corpus.cases.map((c: { entry: string; problem: string | null }) => [c.entry, c.problem]))(
      'CORS_ORIGIN=%j → %s',
      (entry, problem) => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { resolveAllowedOrigins, corsOriginEntryProblem } = require('../server/utils/strict-cors-config');
        expect(corsOriginEntryProblem(entry)).toBe(problem);
        const resolve = () => resolveAllowedOrigins({ ...PROD_EMPTY, corsOriginEnv: entry });
        if (problem) {
          expect(resolve).toThrow(/Refusing to start with NODE_ENV=production/);
        } else {
          expect(resolve()).toEqual([entry]);
        }
      },
    );

    it('covers the bypasses codex found', () => {
      const cases = corpus.cases.map((c: { entry: string }) => c.entry);
      for (const bypass of [
        'http://localhost.:5000',
        'https://foo.localhost.',
        'http://[::ffff:7f00:1]:5000',
        'https://*.example.org',
      ]) {
        expect(cases).toContain(bypass);
      }
    });
  });

  it('resolveServiceCorsOrigins: an explicit list wins and is policy-checked in production', () => {
    const { resolveServiceCorsOrigins } = require('../server/utils/strict-cors-config');
    expect(resolveServiceCorsOrigins('https://app.example.org', { ...PROD_EMPTY }))
      .toEqual(['https://app.example.org']);
    expect(() => resolveServiceCorsOrigins('http://localhost:5000', { ...PROD_EMPTY })).toThrow(/loopback/);
    expect(() => resolveServiceCorsOrigins(['*'], { ...PROD_EMPTY })).toThrow(/Refusing to start/);
    // No explicit list → CORS_ORIGIN, which is required in production.
    expect(() => resolveServiceCorsOrigins(undefined, { ...PROD_EMPTY })).toThrow(/CORS_ORIGIN is empty/);
    expect(resolveServiceCorsOrigins(undefined, { ...PROD_EMPTY, corsOriginEnv: 'https://a.example.org' }))
      .toEqual(['https://a.example.org']);
    // Outside production: explicit list or developmentDefaults, unchecked.
    expect(resolveServiceCorsOrigins('http://localhost:5000', { ...PROD_EMPTY, nodeEnv: 'development' }))
      .toEqual(['http://localhost:5000']);
    expect(resolveServiceCorsOrigins(undefined, { ...PROD_EMPTY, nodeEnv: 'development', developmentDefaults: ['*'] }))
      .toEqual(['*']);
  });

  it('allows an explicit public production origin list', () => {
    const { resolveAllowedOrigins } = require('../server/utils/strict-cors-config');

    expect(resolveAllowedOrigins({
      ...PROD_EMPTY,
      corsOriginEnv: 'https://wrfcoin-testnet.taila1c049.ts.net, https://wrfcoin.app',
    })).toEqual(['https://wrfcoin-testnet.taila1c049.ts.net', 'https://wrfcoin.app']);
  });

  it('a loopback legacy alias does not block a valid CORS_ORIGIN', () => {
    const { resolveAllowedOrigins } = require('../server/utils/strict-cors-config');

    expect(resolveAllowedOrigins({
      ...PROD_EMPTY,
      corsOriginEnv: 'https://wrfcoin.app',
      allowedOriginsEnv: 'http://localhost:3000',
    })).toEqual(['https://wrfcoin.app']);
  });

  it('development is unchanged: built-in defaults when unset', () => {
    const {
      resolveAllowedOrigins,
      DEFAULT_DEV_CORS_ORIGINS,
    } = require('../server/utils/strict-cors-config');

    expect(resolveAllowedOrigins({ ...PROD_EMPTY, nodeEnv: 'development' })).toEqual(DEFAULT_DEV_CORS_ORIGINS);
    expect(resolveAllowedOrigins({ ...PROD_EMPTY, nodeEnv: 'development', developmentDefaults: ['http://localhost:9'] }))
      .toEqual(['http://localhost:9']);
    expect(resolveAllowedOrigins({ ...PROD_EMPTY, nodeEnv: 'test', corsOriginEnv: 'http://localhost:5000' }))
      .toEqual(['http://localhost:5000']);
  });

  it('rejects wildcard origins when credentials are enabled', () => {
    const {
      assertNoWildcardOrigins,
    } = require('../server/utils/strict-cors-config');

    expect(() => assertNoWildcardOrigins(['*'])).toThrow(
      /Wildcard CORS origins cannot be used/
    );
  });

  it('accepts configured explicit origins and localhost only outside production', () => {
    const {
      resolveAllowedOrigins,
      isOriginAllowed,
    } = require('../server/utils/strict-cors-config');

    const origins = resolveAllowedOrigins({
      nodeEnv: 'development',
      corsOriginEnv: 'https://app.wrfcoin.com',
    });

    expect(isOriginAllowed('https://app.wrfcoin.com', origins, { nodeEnv: 'development' })).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', origins, { nodeEnv: 'development' })).toBe(true);
    expect(isOriginAllowed('http://localhost:8080', origins, { nodeEnv: 'development' })).toBe(false);
    expect(isOriginAllowed('https://evil.example', origins, { nodeEnv: 'development' })).toBe(false);
  });

  it('drops localhost:8080 even when it is explicitly configured', () => {
    const {
      resolveAllowedOrigins,
      isOriginAllowed,
    } = require('../server/utils/strict-cors-config');

    const origins = resolveAllowedOrigins({
      nodeEnv: 'development',
      corsOriginEnv: 'http://localhost:8080,https://app.wrfcoin.com',
    });

    expect(origins).toEqual(['https://app.wrfcoin.com']);
    expect(isOriginAllowed('http://localhost:8080', origins, { nodeEnv: 'development' })).toBe(false);
  });

  it('prefers CORS_ORIGIN over legacy env vars', () => {
    const {
      resolveAllowedOriginsConfig,
    } = require('../server/utils/strict-cors-config');

    const config = resolveAllowedOriginsConfig({
      nodeEnv: 'development',
      corsOriginEnv: 'https://app.wrfcoin.com, https://dashboard.wrfcoin.com',
      allowedOriginsEnv: 'https://legacy.example',
      corsAllowedOriginsEnv: 'https://legacy-2.example',
      corsOriginsEnv: 'https://legacy-3.example',
    });

    expect(config.origins).toEqual([
      'https://app.wrfcoin.com',
      'https://dashboard.wrfcoin.com',
    ]);
    expect(config.sourceEnvVar).toBe('CORS_ORIGIN');
    expect(config.usingLegacyEnvVar).toBe(false);
  });

  it.each([
    ['ALLOWED_ORIGINS', 'allowedOriginsEnv'],
    ['CORS_ALLOWED_ORIGINS', 'corsAllowedOriginsEnv'],
    ['CORS_ORIGINS', 'corsOriginsEnv'],
  ])(
    'falls back to %s and warns once',
    (envVarName, optionKey) => {
      const warnSpy = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      const {
        resolveAllowedOriginsConfig,
      } = require('../server/utils/strict-cors-config');

      const options: Record<string, string> = {
        nodeEnv: 'development',
        corsOriginEnv: '',
        allowedOriginsEnv: '',
        corsAllowedOriginsEnv: '',
        corsOriginsEnv: '',
      };
      options[optionKey] = 'https://legacy.example, https://legacy-2.example';

      const firstConfig = resolveAllowedOriginsConfig(options);
      const secondConfig = resolveAllowedOriginsConfig(options);

      expect(firstConfig.origins).toEqual([
        'https://legacy.example',
        'https://legacy-2.example',
      ]);
      expect(secondConfig.origins).toEqual(firstConfig.origins);
      expect(firstConfig.sourceEnvVar).toBe(envVarName);
      expect(firstConfig.usingLegacyEnvVar).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(envVarName)
      );
    }
  );
});
