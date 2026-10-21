const DEFAULT_DEV_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:4001',
  'http://localhost:5000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5000',
  'http://0.0.0.0:5000',
];
const LEGACY_CORS_ENV_VARS = [
  'ALLOWED_ORIGINS',
  'CORS_ALLOWED_ORIGINS',
  'CORS_ORIGINS',
];
const DISALLOWED_DEV_CORS_ORIGINS = new Set([
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://0.0.0.0:8080',
]);

const LOCALHOST_ORIGIN_PATTERN =
  /^http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+$/;
const warnedLegacyCorsEnvVars = new Set();
let warnedBlockedCorsOrigin = false;

function parseAllowedOrigins(...values) {
  return values
    .flatMap(value => (value || '').split(','))
    .map(origin => origin.trim())
    .filter(Boolean);
}

function emitLegacyCorsEnvWarning(envVarName) {
  if (warnedLegacyCorsEnvVars.has(envVarName)) {
    return;
  }

  warnedLegacyCorsEnvVars.add(envVarName);
  console.warn(
    `[DEPRECATION WARNING] ${envVarName} is deprecated for CORS origin configuration. Use CORS_ORIGIN instead.`
  );
}

function emitBlockedCorsOriginWarning(origin) {
  if (warnedBlockedCorsOrigin) {
    return;
  }

  warnedBlockedCorsOrigin = true;
  console.warn(
    `[SECURITY WARNING] Ignoring blocked browser CORS origin: ${origin}`
  );
}

function isExplicitlyDisallowedOrigin(origin) {
  return DISALLOWED_DEV_CORS_ORIGINS.has(origin);
}

function resolveConfiguredOrigins(options = {}) {
  const configuredOriginSources = [
    {
      envVarName: 'CORS_ORIGIN',
      value: options.corsOriginEnv ?? process.env.CORS_ORIGIN,
    },
    {
      envVarName: 'ALLOWED_ORIGINS',
      value: options.allowedOriginsEnv ?? process.env.ALLOWED_ORIGINS,
    },
    {
      envVarName: 'CORS_ALLOWED_ORIGINS',
      value:
        options.corsAllowedOriginsEnv ?? process.env.CORS_ALLOWED_ORIGINS,
    },
    {
      envVarName: 'CORS_ORIGINS',
      value: options.corsOriginsEnv ?? process.env.CORS_ORIGINS,
    },
  ];

  for (const source of configuredOriginSources) {
    const origins = parseAllowedOrigins(source.value).filter(origin => {
      if (isExplicitlyDisallowedOrigin(origin)) {
        emitBlockedCorsOriginWarning(origin);
        return false;
      }
      return true;
    });
    if (origins.length === 0) {
      continue;
    }

    if (source.envVarName !== 'CORS_ORIGIN') {
      emitLegacyCorsEnvWarning(source.envVarName);
    }

    return {
      origins,
      sourceEnvVar: source.envVarName,
      usingLegacyEnvVar: source.envVarName !== 'CORS_ORIGIN',
    };
  }

  return {
    origins: [],
    sourceEnvVar: null,
    usingLegacyEnvVar: false,
  };
}

// backend#1236: the production CORS origin policy. It is a line-for-line port
// of infra's testnet/scripts/cors_origin_policy.py (infra#1056 / PR#1060), so
// the backend refuses exactly what the infra env gate and release manifest
// refuse. Keep the two in step; __tests__/fixtures/cors-origin-policy-corpus.json
// pins this port against verdicts produced by the Python policy.
//
// An entry must be https://host[:port]: no userinfo, path, query, fragment or
// wildcard; port 1-65535; https only. The host must not be loopback,
// unspecified, localhost or *.localhost (a trailing dot is ignored). IP
// literals are normalised the way browsers do (WHATWG URL host parsing), so
// 127.1, 0x7f.0.0.1, 2130706433, [::1], [0:0:0:0:0:0:0:1] and
// [::ffff:127.0.0.1] (IPv4-mapped) are all loopback.
const CORS_POLICY_REASONS = {
  syntax: 'is not a scheme://host[:port] origin (no wildcard, no path)',
  loopback: 'is a loopback origin; no real browser is served from it',
  unspecified: 'is an unspecified-address origin; no real browser is served from it',
  scheme: 'is not an https origin',
};

const ORIGIN_PATTERN =
  /^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/(?<host>\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::(?<port>[0-9]{1,5}))?$/;
const IPV4_PART = /^(0[xX][0-9A-Fa-f]*|0[0-7]*|[1-9][0-9]*)$/;

// The IPv4 address (as a 32-bit number) a browser would parse `host` as,
// null if it is a domain, or false if it ends in a number but is not valid.
function whatwgIpv4(host) {
  let parts = host.split('.');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts = parts.slice(0, -1);
  const last = parts[parts.length - 1];
  if (parts.length === 0 || (!IPV4_PART.test(last) && !/^[0-9]+$/.test(last))) return null;
  if (parts.length > 4) return false;
  const numbers = [];
  for (const part of parts) {
    if (!IPV4_PART.test(part)) return false;
    if (/^0[xX]/.test(part)) numbers.push(parseInt(part.slice(2) || '0', 16));
    else if (part.length > 1 && part[0] === '0') numbers.push(parseInt(part, 8));
    else numbers.push(Number(part));
  }
  const lastNumber = numbers[numbers.length - 1];
  if (numbers.slice(0, -1).some(n => n > 255) || lastNumber >= 256 ** (5 - numbers.length)) {
    return false;
  }
  let value = lastNumber;
  numbers.slice(0, -1).forEach((n, i) => {
    value += n * 256 ** (3 - i);
  });
  return value;
}

// 8 x 16-bit groups for an IPv6 literal (embedded dotted IPv4 allowed), or null.
function parseIpv6(text) {
  if (!/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  let head = text;
  let tailV4 = null;
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    const v4 = text.slice(lastColon + 1).split('.');
    if (v4.length !== 4 || v4.some(o => !/^(0|[1-9][0-9]{0,2})$/.test(o) || Number(o) > 255)) return null;
    tailV4 = [(Number(v4[0]) << 8) | Number(v4[1]), (Number(v4[2]) << 8) | Number(v4[3])];
    head = text.slice(0, lastColon + 1);
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const toGroups = half => (half === '' ? [] : half.split(':'));
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];
  if ([...left, ...right].some(g => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
  const tail = tailV4 || [];
  const explicit = left.length + right.length + tail.length;
  if (halves.length === 1 && explicit !== 8) return null;
  if (halves.length === 2 && explicit > 7) return null;
  const fill = new Array(8 - explicit).fill(0);
  return [...left, ...(halves.length === 2 ? fill : []), ...right].map(g => (typeof g === 'number' ? g : parseInt(g, 16))).concat(tail);
}

function classifyIpv4(value) {
  if (value >>> 24 === 127) return 'loopback';
  if (value >>> 24 === 0) return 'unspecified'; // 0.0.0.0/8, like the Python policy
  return null;
}

function classifyIpv6(groups) {
  const mapped = groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff;
  if (mapped) return classifyIpv4(((groups[6] << 16) | groups[7]) >>> 0);
  if (groups.slice(0, 7).every(g => g === 0)) {
    if (groups[7] === 1) return 'loopback';
    if (groups[7] === 0) return 'unspecified';
  }
  return null;
}

/** null when `entry` is an acceptable production origin, else a reason key. */
function corsOriginEntryProblem(entry) {
  const match = ORIGIN_PATTERN.exec(entry);
  if (!match) return 'syntax';
  const host = match.groups.host.toLowerCase();
  const { port } = match.groups;
  if (port !== undefined && !(Number(port) >= 1 && Number(port) <= 65535)) return 'syntax';
  let verdict;
  if (host.startsWith('[')) {
    const groups = parseIpv6(host.slice(1, -1));
    if (!groups) return 'syntax';
    verdict = classifyIpv6(groups);
  } else {
    const ipv4 = whatwgIpv4(host);
    if (ipv4 === false) return 'syntax';
    if (ipv4 !== null) {
      verdict = classifyIpv4(ipv4);
    } else {
      const name = host.replace(/\.+$/, '');
      if (!name || name.split('.').some(label => !label)) return 'syntax';
      verdict = name === 'localhost' || name.endsWith('.localhost') ? 'loopback' : null;
    }
  }
  if (verdict) return verdict;
  if (match.groups.scheme.toLowerCase() !== 'https') return 'scheme';
  return null;
}

// Kept for callers that only need the loopback question.
function isLoopbackOrigin(origin) {
  const problem = corsOriginEntryProblem(String(origin || '').trim());
  return problem === 'loopback' || problem === 'unspecified';
}

class CorsConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorsConfigurationError';
  }
}

// A refused CORS configuration must be a failed start. The shared winston
// logger claims uncaughtException with exitOnError:false, so without help an
// uncaught startup throw is logged and the process exits 0 (or idles).
// uncaughtExceptionMonitor observes WITHOUT consuming: Node's default crash
// (and any other handler) is untouched for every other error; for a
// CorsConfigurationError it forces exit code 1 even when winston swallows it.
const CORS_FATAL_HOOK = Symbol.for('wrfcoin.strictCorsConfig.fatalMonitor');
if (!process[CORS_FATAL_HOOK]) {
  process[CORS_FATAL_HOOK] = true;
  process.on('uncaughtExceptionMonitor', error => {
    if (error && error.name === 'CorsConfigurationError') {
      console.error(`FATAL ${error.message}`);
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 1000).unref();
    }
  });
}

/**
 * backend#1236: in production the allowlist must come from explicit
 * configuration (CORS_ORIGIN, or a legacy alias), be non-empty, and every
 * entry must pass corsOriginEntryProblem (the infra#1060 policy). Throws
 * CorsConfigurationError otherwise, so a server that resolves its allowlist at
 * startup refuses to start. Non-production is unchanged.
 */
function assertProductionCorsOrigins(configuredOrigins, rawValues = []) {
  const candidates = [...new Set([...rawValues, ...configuredOrigins])];
  const problems = [];
  if (configuredOrigins.length === 0) {
    problems.push('CORS_ORIGIN is empty');
  }
  for (const entry of candidates) {
    const key = corsOriginEntryProblem(entry);
    if (key) problems.push(`entry '${entry}' ${CORS_POLICY_REASONS[key]}`);
  }

  if (problems.length > 0) {
    throw new CorsConfigurationError(
      `[CORS] Refusing to start with NODE_ENV=production: ${problems.join('; ')}. ` +
        'Set CORS_ORIGIN to the comma-separated public https origin(s), e.g. ' +
        'CORS_ORIGIN=https://wrfcoin-testnet.taila1c049.ts.net (backend#1236).'
    );
  }
}

// The unfiltered value of the env var that supplied the allowlist (CORS_ORIGIN
// when nothing did), so a loopback entry that the 8080 filter silently dropped
// is still reported instead of passing.
function rawConfiguredValues(options, sourceEnvVar) {
  const sources = {
    CORS_ORIGIN: options.corsOriginEnv ?? process.env.CORS_ORIGIN,
    ALLOWED_ORIGINS: options.allowedOriginsEnv ?? process.env.ALLOWED_ORIGINS,
    CORS_ALLOWED_ORIGINS: options.corsAllowedOriginsEnv ?? process.env.CORS_ALLOWED_ORIGINS,
    CORS_ORIGINS: options.corsOriginsEnv ?? process.env.CORS_ORIGINS,
  };
  return parseAllowedOrigins(sources[sourceEnvVar || 'CORS_ORIGIN']);
}

function resolveAllowedOriginsConfig(options = {}) {
  const configuredOrigins = resolveConfiguredOrigins(options);
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV || 'development';

  // backend#1236: production never falls back to built-in defaults and fails
  // closed on empty, wildcard or loopback configuration.
  if (nodeEnv === 'production') {
    assertProductionCorsOrigins(
      configuredOrigins.origins,
      rawConfiguredValues(options, configuredOrigins.sourceEnvVar)
    );
    return configuredOrigins;
  }

  if (configuredOrigins.origins.length > 0) {
    return configuredOrigins;
  }

  return {
    ...configuredOrigins,
    origins: options.developmentDefaults || DEFAULT_DEV_CORS_ORIGINS,
  };
}

function resolveAllowedOrigins(options = {}) {
  return resolveAllowedOriginsConfig(options).origins;
}

/**
 * For services that take their own origin list (FRONTEND_URL, a constructor
 * option): an explicit non-empty list wins and, in production, must pass the
 * same policy; otherwise fall back to resolveAllowedOrigins(options), which
 * enforces CORS_ORIGIN in production and returns developmentDefaults outside
 * it (backend#1236).
 */
function resolveServiceCorsOrigins(explicitOrigins, options = {}) {
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV || 'development';
  const list = Array.isArray(explicitOrigins)
    ? explicitOrigins.map(origin => String(origin).trim()).filter(Boolean)
    : parseAllowedOrigins(explicitOrigins);
  if (list.length > 0) {
    if (nodeEnv === 'production') {
      assertProductionCorsOrigins(list, list);
    }
    return list;
  }
  return resolveAllowedOrigins(options);
}

function assertNoWildcardOrigins(origins, options = {}) {
  const credentials = options.credentials !== false;
  if (credentials && origins.includes('*')) {
    throw new Error(
      'Wildcard CORS origins cannot be used when credentials are enabled'
    );
  }
}

function isOriginAllowed(origin, allowedOrigins, options = {}) {
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV || 'development';

  if (!origin) {
    return true;
  }

  if (isExplicitlyDisallowedOrigin(origin)) {
    return false;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  return nodeEnv !== 'production' && LOCALHOST_ORIGIN_PATTERN.test(origin);
}

function createCorsOriginDelegate(allowedOrigins, options = {}) {
  return (origin, callback) => {
    if (isOriginAllowed(origin, allowedOrigins, options)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS policy'));
  };
}

module.exports = {
  CorsConfigurationError,
  DEFAULT_DEV_CORS_ORIGINS,
  LEGACY_CORS_ENV_VARS,
  DISALLOWED_DEV_CORS_ORIGINS,
  LOCALHOST_ORIGIN_PATTERN,
  parseAllowedOrigins,
  resolveAllowedOriginsConfig,
  resolveAllowedOrigins,
  resolveServiceCorsOrigins,
  assertNoWildcardOrigins,
  assertProductionCorsOrigins,
  corsOriginEntryProblem,
  isExplicitlyDisallowedOrigin,
  isLoopbackOrigin,
  isOriginAllowed,
  createCorsOriginDelegate,
};
