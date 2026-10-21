/**
 * GraphQL Schema Type Definitions Export
 * Exports the schema from the GraphQL schema file
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the GraphQL schema file
export const typeDefs = readFileSync(
  join(__dirname, '..', 'schema.graphql'),
  'utf8'
);

// Export as default for compatibility
export default typeDefs;
