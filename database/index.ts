/**
 * Canonical database exports.
 * postgres-js (`connection.ts`) is the primary abstraction.
 */

export {
  db,
  queryClient,
  executeQuery,
  poolConfig,
  checkDatabaseHealth,
  getDatabaseStats,
  closeDatabaseConnection,
} from './connection.js';

// Backward compatibility for modules still importing from database/db.
export {
  db as legacyDb,
  pool,
  executeQuery as legacyExecuteQuery,
  ping,
  setupConnectionManager,
  type Database,
} from './db.js';

export { default as connection } from './connection.js';
