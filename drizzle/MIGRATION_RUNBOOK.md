# Migration Runbook

## Overview

The backend uses Drizzle ORM with PostgreSQL. All migrations live in `drizzle/migrations/`.
The schema was consolidated from 947 incremental migrations into a single baseline on 2026-03-07.

Archived migrations are preserved in `drizzle/archive/` for audit purposes.

## Fresh Deploy

```bash
# 1. Ensure DATABASE_URL is set
export DATABASE_URL=postgresql://user:pass@localhost:5432/wrfcoin

# 2. Run the baseline migration
npm run db:migrate

# This executes drizzle/migrations/0000_baseline_schema.sql which creates all tables.
# All CREATE TABLE statements use IF NOT EXISTS for safety.
```

## Adding a New Migration

```bash
# 1. Modify the schema in shared/schema.ts (or related schema files)
# 2. Generate a migration
npx drizzle-kit generate:pg

# 3. Review the generated SQL in drizzle/migrations/
# 4. Test locally: npm run db:migrate
# 5. Commit the migration file with your schema change
```

## Rollback Procedures

Drizzle ORM does not have built-in rollback. Use these manual procedures:

### Rollback a Column Addition
```sql
ALTER TABLE "table_name" DROP COLUMN IF EXISTS "column_name";
```

### Rollback a Table Creation
```sql
DROP TABLE IF EXISTS "table_name" CASCADE;
```

### Rollback an Index
```sql
DROP INDEX IF EXISTS "index_name";
```

### Full Database Reset (Development Only)
```bash
# Drop and recreate the database
dropdb wrfcoin && createdb wrfcoin
npm run db:migrate
```

## Testing Strategy

1. **Local**: Run `npm run db:migrate` against a fresh local database
2. **CI**: Migration count lint warns if active migrations exceed 50
3. **Staging**: Always test migrations on staging before production
4. **Backup**: Take a database snapshot before running migrations in production

## Archived Migrations

Previous migrations (947 files from May 2024 - March 2026) are preserved in `drizzle/archive/`.
These are not executed on fresh deploys but kept for audit trail and history.

## Schema Files

| File | Contents |
|------|----------|
| `shared/schema.ts` | Core tables (users, transactions, blocks, wallets, weather, etc.) |
| `shared/governance-schema.ts` | Governance proposals, votes, delegations |
| `shared/mfa-schema.ts` | MFA settings, sessions, WebAuthn credentials |
| `shared/file-schema.ts` | File management, permissions, audit logs |
| `shared/schema-lineage.ts` | Data lineage records |
| `shared/schema-api-keys.js` | API key management |
