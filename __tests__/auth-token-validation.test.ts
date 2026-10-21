/**
 * Tests for WRFCOIN_OPERATOR_TOKEN validation (PR #499 review follow-up).
 *
 * Blocker 1: fetchCore4Json (server/websocket/index.ts) must throw when
 *            WRFCOIN_OPERATOR_TOKEN is not set.
 * Blocker 2: validateSecrets (src/config/secrets.ts) must throw at startup
 *            when WRFCOIN_OPERATOR_TOKEN is missing or blank.
 *
 * Warning:   requiredEnvVars is intentionally separate from requiredSecrets
 *            because WRFCOIN_OPERATOR_TOKEN is a process.env variable, not a
 *            Vault-managed secret in the AppSecrets interface.
 */

import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };

// ---------------------------------------------------------------------------
// Mocks — declared before any subject imports
// ---------------------------------------------------------------------------

// Silence logger side-effects (file transports, etc.)
jest.mock('../server/utils/logger.js', () => ({
  appLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock node-vault to prevent real Vault connections
jest.mock('node-vault', () => {
  return jest.fn().mockReturnValue({
    read: jest.fn().mockRejectedValue(new Error('vault not available in test')),
  });
}, { virtual: true });

// Mock config/environment.js — requireEnv
jest.mock('../config/environment.js', () => ({
  requireEnv: (key: string) => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required environment variable: ${key}`);
    return val;
  },
}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Blocker 1 — fetchCore4Json throws when WRFCOIN_OPERATOR_TOKEN is unset
// ---------------------------------------------------------------------------

describe('fetchCore4Json — WRFCOIN_OPERATOR_TOKEN guard (#499)', () => {
  beforeEach(() => {
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
  });

  it('throws when WRFCOIN_OPERATOR_TOKEN is not set', async () => {
    const { fetchCore4Json } = await import('../server/websocket/index.js');

    await expect(fetchCore4Json('/blockchain')).rejects.toThrow(
      'WRFCOIN_OPERATOR_TOKEN is not set'
    );
  });

  it('throws when WRFCOIN_OPERATOR_TOKEN is an empty string', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = '';
    const { fetchCore4Json } = await import('../server/websocket/index.js');

    // Empty string is falsy — the guard `if (!token)` catches it
    await expect(fetchCore4Json('/blockchain')).rejects.toThrow(
      'WRFCOIN_OPERATOR_TOKEN is not set'
    );
  });
});

// ---------------------------------------------------------------------------
// Blocker 2 — validateSecrets throws when WRFCOIN_OPERATOR_TOKEN is missing
// ---------------------------------------------------------------------------

describe('validateSecrets — WRFCOIN_OPERATOR_TOKEN guard (#499)', () => {
  // validateSecrets checks both appSecrets (nested fields from Vault) and
  // process.env (WRFCOIN_OPERATOR_TOKEN). In the dev fallback path,
  // initializeSecrets -> loadFromEnvironment -> validateSecrets.

  function setMinimalSecretEnv(overrides: Record<string, string | undefined> = {}) {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://localhost:5432/wrfcoin_test';
    process.env.DB_PASSWORD = 'test-db-password';
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-sixteen-chars';
    process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-at-least-sixteen';
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-characters!!!';
    Object.assign(process.env, overrides);
  }

  it('throws when WRFCOIN_OPERATOR_TOKEN is not set during startup', async () => {
    setMinimalSecretEnv();
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    // No VAULT_TOKEN either — forces dev fallback to loadFromEnvironment
    delete process.env.VAULT_TOKEN;

    const { initializeSecrets } = await import('../src/config/secrets.js');

    await expect(initializeSecrets()).rejects.toThrow(
      'Required environment variable missing: WRFCOIN_OPERATOR_TOKEN'
    );
  });

  it('throws when WRFCOIN_OPERATOR_TOKEN is blank during startup', async () => {
    setMinimalSecretEnv({ WRFCOIN_OPERATOR_TOKEN: '   ' });
    delete process.env.VAULT_TOKEN;

    const { initializeSecrets } = await import('../src/config/secrets.js');

    await expect(initializeSecrets()).rejects.toThrow(
      'Required environment variable missing: WRFCOIN_OPERATOR_TOKEN'
    );
  });

  it('passes validation when WRFCOIN_OPERATOR_TOKEN is set', async () => {
    setMinimalSecretEnv({ WRFCOIN_OPERATOR_TOKEN: 'test-operator-token' });
    delete process.env.VAULT_TOKEN;

    const { initializeSecrets } = await import('../src/config/secrets.js');

    // Dev fallback should succeed with all env vars present
    await expect(initializeSecrets()).resolves.toBeUndefined();
  });

  it('checkSecretsHealth reports unhealthy after token is removed', async () => {
    setMinimalSecretEnv({ WRFCOIN_OPERATOR_TOKEN: 'temp-token' });
    delete process.env.VAULT_TOKEN;

    const { initializeSecrets, checkSecretsHealth } = await import(
      '../src/config/secrets.js'
    );

    // Populate appSecrets successfully
    await initializeSecrets();

    // Now remove the token and verify health check catches it
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    const health = checkSecretsHealth();

    expect(health.healthy).toBe(false);
    expect(health.message).toContain('WRFCOIN_OPERATOR_TOKEN');
  });

  it('throws when ENCRYPTION_KEY is not set during startup', async () => {
    setMinimalSecretEnv({ WRFCOIN_OPERATOR_TOKEN: 'test-operator-token' });
    delete process.env.ENCRYPTION_KEY;
    delete process.env.VAULT_TOKEN;

    const { initializeSecrets } = await import('../src/config/secrets.js');

    await expect(initializeSecrets()).rejects.toThrow(
      'ENCRYPTION_KEY environment variable is required. Refusing to use a development fallback.'
    );
  });
});

// ---------------------------------------------------------------------------
// Warning assessment — requiredEnvVars vs requiredSecrets separation
// ---------------------------------------------------------------------------

describe('requiredEnvVars separation rationale', () => {
  it('WRFCOIN_OPERATOR_TOKEN is validated through the env-var path, not the Vault secrets path', async () => {
    // requiredSecrets validates nested AppSecrets fields (database.url,
    // jwt.secret, etc.) which originate from Vault or env fallback.
    //
    // requiredEnvVars validates raw process.env values that are not part
    // of the AppSecrets interface (e.g., WRFCOIN_OPERATOR_TOKEN).
    //
    // Consolidation would require either:
    //   (a) Adding WRFCOIN_OPERATOR_TOKEN to AppSecrets — wrong, it's not
    //       a Vault-managed secret
    //   (b) Mixing env-var checks into the nested-path validation loop —
    //       confusing and fragile
    //
    // The current separation is intentional: Vault secrets in requiredSecrets,
    // plain env vars in requiredEnvVars.

    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://localhost:5432/wrfcoin_test';
    process.env.DB_PASSWORD = 'test-db-password';
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-sixteen-chars';
    process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-at-least-sixteen';
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-characters!!!';
    process.env.WRFCOIN_OPERATOR_TOKEN = '';
    delete process.env.VAULT_TOKEN;

    const { initializeSecrets } = await import('../src/config/secrets.js');

    await expect(initializeSecrets()).rejects.toThrow(
      'Required environment variable missing: WRFCOIN_OPERATOR_TOKEN'
    );
  });
});
