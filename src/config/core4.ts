/**
 * Central resolver for the core4 node REST API URL.
 *
 * Canonical var: CORE4_API_URL (default http://localhost:8556)
 * Legacy vars emit a one-time warn on first read, then are accepted silently.
 */

const DEFAULT_CORE4_API_URL = 'http://localhost:8556';

const LEGACY_VARS = [
  'BLOCKCHAIN_NODE_URL',
  'BLOCKCHAIN_SERVICE_URL',
  'RUST_BLOCKCHAIN_URL',
] as const;

let _warned = false;

export function getCore4ApiUrl(): string {
  if (process.env.CORE4_API_URL) {
    return process.env.CORE4_API_URL;
  }
  for (const name of LEGACY_VARS) {
    if (process.env[name]) {
      if (!_warned) {
        console.warn(
          `[core4] env var ${name} is deprecated — set CORE4_API_URL instead (default: ${DEFAULT_CORE4_API_URL})`
        );
        _warned = true;
      }
      return process.env[name]!;
    }
  }
  return DEFAULT_CORE4_API_URL;
}

/** Returns true when any recognized core4 URL env var is explicitly set. */
export function isCore4ApiConfigured(): boolean {
  return !!(
    process.env.CORE4_API_URL ||
    LEGACY_VARS.some(name => process.env[name])
  );
}
