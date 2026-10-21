// Re-export database connection and utilities from the actual database module.
//
// backend#1247: list every export by name — never `export *`. server/ has its
// own package.json with no "type", so under tsx (the live entrypoint) this file
// is compiled to CommonJS, and Node cannot see the names behind a CJS star
// re-export: `await import('../db.js')` then yielded only `default`, and
// `dbModule.pool` / `dbModule.db` were undefined. Explicit names let Node's
// CJS lexer expose them. Keep this list equal to database/db.ts's exports
// (__tests__/db-module-interop-1247.test.ts enforces it).
export { db, pool, executeQuery, ping, setupConnectionManager } from '../database/db.js';
export type { Database } from '../database/db.js';
export { db as default } from '../database/db.js';
