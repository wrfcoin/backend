// Load .env for local dev only; container already has DATABASE_URL injected by compose.
if (!process.env.DATABASE_URL) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config();
}
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './shared/schema.ts',
    './shared/oracle-work-schema.ts',
    './shared/schema-refresh-tokens.ts',
    './shared/oracle-schema.js',
    './shared/schema-governance-consolidated.ts',
    './shared/schema-iotex.ts',
  ],
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/wrfcoin',
  },
  strict: true,
  verbose: true,
});
