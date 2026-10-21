/**
 * Types for the emitted `middleware/rateLimiting.cjs` shim.
 *
 * `middleware/rateLimiting.js` is CommonJS (`module.exports = {...}`) inside a
 * `"type": "module"` package. `scripts/copy-build-assets.mjs` copies it to
 * `dist/` unchanged AND emits a `.cjs` peer, because Node classifies the
 * emitted `.js` as ESM — so an ESM `import { generalLimiter } from
 * '.../rateLimiting.js'` throws at load:
 *
 *   SyntaxError: The requested module '../../middleware/rateLimiting.js'
 *   does not provide an export named 'generalLimiter'
 *
 * TypeScript callers must therefore import the `.cjs` path to get a specifier
 * that actually resolves in the built artifact. That path exists only after a
 * build, so under `moduleResolution: "Bundler"` this `.d.cts` is what makes it
 * type-check from source. Jest maps the `.cjs` specifier back to the `.js`
 * source (see the moduleNameMapper in jest.config.cjs), so unit tests load the
 * real CommonJS module either way.
 *
 * Only the members actually imported are declared. This is deliberately narrow
 * rather than a full typing of the module: a broad hand-written surface would
 * drift from `rateLimiting.js` silently. The systemic fix for this interop
 * pattern across all ~46 safeMounted routers is tracked in backend#937.
 */
import type { RequestHandler } from 'express';

/** Shared public-read limiter: 15 min window, 100 requests per IP. */
export declare const generalLimiter: RequestHandler;
