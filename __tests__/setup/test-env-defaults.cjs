/**
 * Test-environment defaults (backend#992).
 *
 * Some modules validate configuration at **import time** — not in a constructor
 * a test could avoid calling, but in a module-scope or static-initializer
 * expression that runs the moment the file is required. `server/services/
 * sms-service.ts` is the clearest example:
 *
 *   class EncryptionUtil {
 *     private static readonly KEY = (() => {
 *       const encryptionKey = process.env.MFA_ENCRYPTION_KEY;
 *       if (!encryptionKey || encryptionKey.length < 32) throw new Error(...);
 *       return crypto.scryptSync(...);
 *     })();
 *
 * A suite cannot mock its way past that: the throw happens while the hoisted
 * `import` is being resolved, before any test body or `beforeEach` runs. Setting
 * the variable inside the test file is also too late, for the same reason. The
 * only place early enough is `setupFiles`, which Jest runs **before** the test
 * framework and before the module registry is touched.
 *
 * This is why the fix is shared rather than per-suite: one missing variable
 * blocks every suite that imports the module, and each of those suites would
 * otherwise need its own workaround for a cause it does not own.
 *
 * Rules for this file:
 *
 *   1. **Never overwrite a value that is already set.** A developer or CI job
 *      that exports a real value must win; these are defaults, not overrides.
 *   2. **Values must be obviously non-production.** Every one is prefixed so it
 *      can never be mistaken for a real secret if it leaks into a log or a
 *      snapshot, and so `grep` finds them instantly.
 *   3. **This file does not stub behaviour** — no mocks, no globals, no
 *      network. It supplies configuration only. Anything that changes what code
 *      *does* belongs in a suite, where it is visible to that suite's reviewer.
 */

/** Set `name` only if it is absent or empty. Returns true if this file set it. */
function defaultEnv(name, value) {
  const current = process.env[name];
  if (current !== undefined && current !== '') return false;
  process.env[name] = value;
  return true;
}

// `MFA_ENCRYPTION_KEY` must be >= 32 chars — it is fed to crypto.scryptSync at
// import time by server/services/sms-service.ts (and the MFA service it was
// copied from). 48 chars here, comfortably clear of the boundary so a future
// tightening to 40 does not silently re-break the suites.
defaultEnv(
  'MFA_ENCRYPTION_KEY',
  'test-only-not-a-real-key-mfa-encryption-000000000'
);

// `JWT_SECRET` is required at import time by
// shared/websocket/ws-auth-middleware.ts.
defaultEnv('JWT_SECRET', 'test-only-not-a-real-key-jwt-secret-000000000000');

// NOTE: deliberately NOT set here — DATABASE_URL, REDIS_URL and friends.
// Supplying a fake connection string would turn "this suite needs a database"
// into a confusing connection failure deep inside a driver, instead of the
// clear absence it is today. Reachability is a different problem from
// configuration, and conflating them is how a suite ends up passing in
// isolation and failing under the full gate (backend#872 / #992).

// `WRFCOIN_ROUTE_STORE_PATH` redirects the route durable store off the file that
// is CHECKED INTO GIT. `shared/route-durable-store.ts:29-31` defaults to
// `<cwd>/backend/data/route-durable-store.json`, which is tracked, so running
// `npm test` leaves the working tree dirty:
//
//     $ npm test && git status --porcelain
//      M backend/data/route-durable-store.json
//
// That is not cosmetic. `git status --porcelain` is part of the merge gate, so a
// gate that dirties the tree makes its own cleanliness check unreliable for
// everyone — and the footgun has already fired: PR #244, a type-unification
// change, committed 27 insertions / 27 deletions to that file consisting purely
// of shifted `createdAt` / `updatedAt` timestamps. Three commits in its history
// carry that signature.
//
// The path must stay inside `<cwd>/backend/data`: `safePath()` (line 38 of the
// store) rejects anything that resolves outside it, so a tmpdir is not an
// option. A sibling filename is, and it is gitignored.
//
// Semantics are unchanged — one shared file for the run, exactly as before, just
// an untracked one. A missing file is not an error: `ensureLoaded()` catches and
// seeds from `DEFAULT_STATE`.
defaultEnv(
  'WRFCOIN_ROUTE_STORE_PATH',
  require('path').join(process.cwd(), 'backend', 'data', 'route-durable-store.test.json')
);
