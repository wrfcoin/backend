/**
 * Drizzle Database Connection Re-export
 *
 * This file re-exports the main database connection from the database directory.
 * This allows imports from '../drizzle/db.js' to work correctly.
 */

export * from '../database/db.js';
export { db as default, type Database } from '../database/db.js';
