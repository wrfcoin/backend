/**
 * Test-run network egress guard (backend#1017).
 *
 * ## Why
 *
 * `bridge-real-api-clients` intermittently fails to bind its `jest.doMock('axios')`.
 * When that happens the client binds the REAL axios and falls back to its own
 * default base URL, so the canonical gate reaches for live third-party mainnet
 * APIs. Measured by forcing the non-binding condition — 12 outbound requests:
 *
 *   https://api.axelarscan.io/gmp/searchGMP?txHash=…            (x6)
 *   https://api-mainnet.layerzero-scan.com/tx/…                 (x6)
 *
 * The tests that counted calls failed loudly and caught it. The tests that
 * assert `expect(mockGet).not.toHaveBeenCalled()` did NOT: when the mock is
 * unbound that assertion is checking an object wired to nothing, so it is
 * trivially true no matter what the client did. A negative assertion against an
 * unbound mock cannot fail. That is the #967 family — the assertion does not
 * become wrong, it becomes unable to be wrong.
 *
 * This guard fixes the CLASS, not that file. Any suite whose HTTP mock silently
 * stops intercepting now fails immediately, by name, with the URL it tried to
 * reach — instead of quietly talking to a third party and possibly passing.
 *
 * ## The allowance is DERIVED, not a list
 *
 * Loopback is allowed; everything else is denied. There is deliberately no
 * per-file or per-host allowlist: backend#1009 is the worked example of an
 * allowlist that went stale and had to be retired, and a list of "suites that
 * may use the network" would rot the same way. A derived rule cannot.
 *
 * Node defaults `options.host` to `localhost` when it is omitted, so an
 * unspecified host is genuinely loopback and is allowed on that basis — this is
 * Node's semantics, not a weakening of the rule. `socketPath` (unix socket) is
 * not network egress and is allowed.
 *
 * ## Escape hatch
 *
 * The originals are exposed on `globalThis.__realNetwork` for teardown code or
 * a suite that must genuinely reach the network. Restoring them is deliberate
 * and shows up in a diff, which is the point — the alternative (an allowlist
 * this file carries) is the thing #1009 warns about.
 *
 * Loaded via jest `setupFiles` — before the test framework and before any
 * module under test is imported, so nothing can capture an unguarded reference
 * first.
 */

const http = require('http');
const https = require('https');

const attempts = [];

function normaliseHost(raw) {
  if (raw === undefined || raw === null) return '';
  let h = String(raw).trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    // [::1]:8080 -> ::1
    const end = h.indexOf(']');
    return end === -1 ? h.slice(1) : h.slice(1, end);
  }
  // host:port -> host (a bare IPv6 literal has >1 colon and no port form here)
  if (h.split(':').length === 2) h = h.split(':')[0];
  return h;
}

function isLoopback(host) {
  if (!host) return false;
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    host === '::ffff:127.0.0.1' ||
    host.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Pull a hostname out of any of node's accepted request signatures. */
function extractHost(arg) {
  if (!arg) return undefined;
  if (typeof arg === 'string') {
    try {
      return new URL(arg).hostname;
    } catch {
      return undefined;
    }
  }
  if (typeof URL !== 'undefined' && arg instanceof URL) return arg.hostname;
  if (typeof arg === 'object') {
    if (arg.socketPath) return 'localhost'; // unix socket: not network egress
    return arg.hostname || arg.host || undefined;
  }
  return undefined;
}

function describeTarget(args) {
  const a = args[0];
  if (typeof a === 'string') return a;
  if (typeof URL !== 'undefined' && a instanceof URL) return a.href;
  const o = a && typeof a === 'object' ? a : args[1] || {};
  const host = o.hostname || o.host || 'localhost';
  const proto = o.protocol || '';
  return `${proto}//${host}${o.path || ''}`;
}

function check(args, api) {
  const host = normaliseHost(extractHost(args[0]) ?? extractHost(args[1]));
  // Node defaults to localhost when no host is given.
  const effective = host || 'localhost';
  if (isLoopback(effective)) return;

  const target = describeTarget(args);
  attempts.push(target);
  // Logged as well as thrown: a caller with a broad try/catch can swallow the
  // throw and fall back silently, which is the failure mode this exists to
  // surface. The log survives that.
  // eslint-disable-next-line no-console
  console.error(
    `[guard-network-egress] BLOCKED ${api} -> ${target} (host "${effective}")`,
  );
  const err = new Error(
    `Network egress blocked: ${api} tried to reach ${target}. Tests must not ` +
      `call external hosts — this usually means an HTTP mock failed to bind ` +
      `(backend#1017), so the real client was used. Mock the client, or point ` +
      `it at loopback. Only loopback is permitted.`,
  );
  err.code = 'TEST_EGRESS_BLOCKED';
  throw err;
}

globalThis.__realNetwork = {
  httpRequest: http.request,
  httpGet: http.get,
  httpsRequest: https.request,
  httpsGet: https.get,
  fetch: globalThis.fetch,
  attempts,
};

// `http.get` does NOT route through `http.request` — it closes over the
// module-local `request`, so patching only `request` would leave `get` open.
for (const [mod, name] of [
  [http, 'http'],
  [https, 'https'],
]) {
  const realRequest = mod.request;
  const realGet = mod.get;
  mod.request = function guardedRequest(...args) {
    check(args, `${name}.request`);
    return realRequest.apply(this, args);
  };
  mod.get = function guardedGet(...args) {
    check(args, `${name}.get`);
    return realGet.apply(this, args);
  };
}

// Node's global fetch is undici and does NOT go through http.request, so it
// needs its own guard or it is a hole straight through this file.
if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object' && 'url' in input
          ? input.url
          : String(input);
    check([url], 'fetch');
    return realFetch.call(this, input, init);
  };
}
